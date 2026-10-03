import type { Chunk } from "../chunk";
import { getIndex, search, type HandbookIndex, type SearchHit } from "../search/search";
import { answerWithCitations, ANSWER_MODEL, hasApiKey, toAskError } from "./claude";
import { absenceTopic, isSearchable } from "./gaps";
import { applyGroundingGate, type GateOutcome } from "./grounding";
import { buildDocuments } from "./prompt";
import { rewriteFollowUp } from "./rewrite";
import { askError, type AskError, type AskRequest, type AskResponse } from "./types";

/** Everything worth logging about one question (no API key, no full answer text). */
export interface AskTrace {
  question: string;
  searchedFor: string;
  retrieved: string[]; // chunk ids, in rank order
  status: AskResponse["status"];
  errorCode?: string;
  notCoveredReason?: string;
  citations?: number;
  droppedCitations?: number;
  uncitedChars?: number;
  /** Gaps in the final reply, shown as "not found in the passages searched". */
  gaps?: number;
  /** The gap re-search, if the first answer had gaps: what it searched for, the chunks it added, and how it ended. */
  research?: { queries: string[]; added: string[]; outcome: ResearchOutcome };
  model?: string; // the model that wrote the answer shown
  usage?: { input: number; output: number }; // summed over the answer calls
  ms: { rewrite?: number; search?: number; answer?: number; research?: number; reanswer?: number; total: number };
}

type ResearchOutcome = "failed" | "no-new-passages" | "second-call-failed" | "kept-first" | "used-second";

/** How long a question waits for search. The first search after a fresh clone downloads the ~35 MB model. */
const SEARCH_WAIT_MS = 45_000;
/** The gap re-search searches at most this many gaps, and adds at most this many passages in total. */
const MAX_GAP_QUERIES = 3;
const MAX_EXTRA_PASSAGES = 8;
/**
 * The second answer call is optional: the first answer is already done. So it gets no retries and a
 * short timeout, and a rate limit or outage costs the user seconds, not the SDK's minutes of retrying.
 */
const SECOND_CALL = { maxRetries: 0, timeout: 40_000 };

/**
 * Question → search → Claude with citations → grounding gate → gap re-search. Used by the API route
 * and the eval. Never throws: every failure becomes an AskError, so the caller always gets a trace.
 */
export async function ask(request: AskRequest): Promise<{ response: AskResponse; trace: AskTrace }> {
  const started = performance.now();
  const question = request.question.trim();
  const trace: AskTrace = { question, searchedFor: question, retrieved: [], status: "error", ms: { total: 0 } };

  let response: AskResponse;
  try {
    response = await answer(question, request.history ?? [], trace);
  } catch (error) {
    // Expected failures (API errors, search) are handled where they happen; this is the safety net for bugs.
    console.error("[ask] unexpected error:", error);
    response = askError("internal_error", "Something went wrong while answering. The details are in the server log.");
  }
  trace.status = response.status;
  if (response.status === "error") trace.errorCode = response.code;
  trace.ms.total = elapsed(started);
  return { response, trace };
}

async function answer(question: string, history: NonNullable<AskRequest["history"]>, trace: AskTrace): Promise<AskResponse> {
  if (!hasApiKey()) {
    return askError("missing_api_key", "No Anthropic API key is set. Add ANTHROPIC_API_KEY to .env.local and restart the server.");
  }

  // The standalone question is used for both search and answering; Claude never sees the raw history.
  const rewriteStarted = performance.now();
  const searchedFor = await rewriteFollowUp(question, history);
  trace.searchedFor = searchedFor;
  if (history.length) trace.ms.rewrite = elapsed(rewriteStarted);

  let index: HandbookIndex;
  try {
    index = await getIndex();
  } catch (error) {
    console.error("[ask] couldn't load the search index:", error);
    return askError("index_unavailable", "Couldn't load the search index in data/index/. The details are in the server log; `npm run ingest` rebuilds it.");
  }

  const searchStarted = performance.now();
  let hits: SearchHit[];
  try {
    hits = await withTimeout(search(index, searchedFor), SEARCH_WAIT_MS);
  } catch (error) {
    console.error("[ask] search failed:", error);
    return error instanceof TimeoutError
      ? askError("search_unavailable", "The search model is still loading (the first question downloads about 35 MB). Try again in a minute.", true)
      : askError(
          "search_unavailable",
          "Couldn't load the search model. The first question downloads it from Hugging Face (about 35 MB), so check your internet connection and try again. The details are in the server log.",
          true,
        );
  } finally {
    trace.ms.search = elapsed(searchStarted);
  }
  trace.retrieved = hits.map((h) => h.chunk.id);
  const chunks = hits.map((h) => h.chunk);

  const first = await answerFrom(searchedFor, chunks, trace, "answer");
  if ("error" in first) return first.error;
  const gate = (await answerGaps(index, searchedFor, chunks, first.gate, trace)) ?? first.gate;

  if (gate.result.status === "answered") trace.citations = gate.result.citations.length;
  trace.droppedCitations = gate.droppedCitations;
  trace.uncitedChars = gate.uncitedChars;
  trace.notCoveredReason = gate.notCoveredReason;
  trace.gaps = gate.gaps.length;
  trace.model = gate.model;
  return gate.result;
}

/** A gate outcome, and the model whose reply it came from. */
type Answer = GateOutcome & { model: string };

/** One Claude call over the given chunks, then the grounding gate. */
async function answerFrom(
  searchedFor: string,
  chunks: Chunk[],
  trace: AskTrace,
  step: "answer" | "reanswer",
): Promise<{ gate: Answer } | { error: AskError }> {
  const { documents, sources } = buildDocuments(chunks);
  const started = performance.now();
  let message;
  try {
    message = await answerWithCitations(searchedFor, documents, step === "reanswer" ? SECOND_CALL : undefined);
  } catch (error) {
    console.error("[ask] Claude request failed:", error);
    return { error: toAskError(error) };
  } finally {
    trace.ms[step] = elapsed(started);
  }

  trace.usage = {
    input: (trace.usage?.input ?? 0) + message.usage.input_tokens,
    output: (trace.usage?.output ?? 0) + message.usage.output_tokens,
  };
  if (message.stop_reason === "refusal") {
    return { error: askError("refused", "Claude declined to answer this question. Try rephrasing it.") };
  }
  if (message.stop_reason === "max_tokens") console.warn("[ask] answer hit max_tokens and may be cut short");
  return { gate: { ...applyGroundingGate(message.content, sources, searchedFor), model: message.model ?? ANSWER_MODEL } };
}

/**
 * The gap re-search. Claude sees only the top 8 search results, so a gap it names ("notice period when
 * resigning") may be answered by a passage that search ranked lower. Search each gap
 * on its own and, if that finds passages Claude hasn't seen, answer once more with them added.
 * Returns null to keep the first answer.
 */
async function answerGaps(
  index: HandbookIndex,
  searchedFor: string,
  chunks: Chunk[],
  first: Answer,
  trace: AskTrace,
): Promise<Answer | null> {
  // Absence claims left inside cited sentences get the same second look as the gaps.
  const queries = [...new Set([...first.gaps, ...first.absenceClaims.map(absenceTopic)])]
    .filter(isSearchable)
    .slice(0, MAX_GAP_QUERIES);
  if (queries.length === 0) return null;
  const research: NonNullable<AskTrace["research"]> = { queries, added: [], outcome: "failed" };
  trace.research = research;

  try {
    const started = performance.now();
    const added = await unseenPassages(index, queries, chunks).finally(() => (trace.ms.research = elapsed(started)));
    research.added = added.map((c) => c.id);
    if (added.length === 0) {
      research.outcome = "no-new-passages";
      return null;
    }

    const second = await answerFrom(searchedFor, [...chunks, ...added], trace, "reanswer");
    if ("error" in second) {
      console.warn(`[ask] second answer failed (${second.error.code}); keeping the first answer`);
      research.outcome = "second-call-failed";
      return null;
    }
    // Claude saw more the second time, but a partial answer still beats a second-pass "not covered".
    if (second.gate.result.status !== "answered" && first.result.status === "answered") {
      research.outcome = "kept-first";
      return null;
    }
    research.outcome = "used-second";
    return second.gate;
  } catch (error) {
    console.warn("[ask] gap re-search failed; keeping the first answer:", error);
    return null;
  }
}

/** The top search results for each query that aren't in `seen`, taken from each query in turn. */
async function unseenPassages(index: HandbookIndex, queries: string[], seen: Chunk[]): Promise<Chunk[]> {
  const sent = new Set(seen.map((c) => c.id));
  const perQuery: Chunk[][] = [];
  for (const query of queries) {
    const hits = await withTimeout(search(index, query), SEARCH_WAIT_MS);
    perQuery.push(hits.map((h) => h.chunk));
  }

  const added: Chunk[] = [];
  for (let rank = 0; perQuery.some((list) => rank < list.length); rank++) {
    for (const list of perQuery) {
      const chunk = list[rank];
      if (!chunk || sent.has(chunk.id)) continue;
      if (added.length === MAX_EXTRA_PASSAGES) return added;
      sent.add(chunk.id);
      added.push(chunk);
    }
  }
  return added;
}

class TimeoutError extends Error {}

/** Reject after `ms`. The promise keeps running; if it fails later, that's not an unhandled rejection. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function elapsed(since: number): number {
  return Math.round(performance.now() - since);
}
