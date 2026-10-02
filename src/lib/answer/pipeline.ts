import { getIndex, search } from "../search/search";
import { answerWithCitations, ANSWER_MODEL, hasApiKey, toAskError } from "./claude";
import { applyGroundingGate } from "./grounding";
import { buildDocuments } from "./prompt";
import type { AskRequest, AskResponse } from "./types";

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
  model?: string;
  usage?: { input: number; output: number };
  ms: { search?: number; answer?: number; total: number };
}

/** Question → search → Claude with citations → grounding gate. Used by the API route and the eval. */
export async function ask(request: AskRequest): Promise<{ response: AskResponse; trace: AskTrace }> {
  const started = performance.now();
  const elapsed = (since: number) => Math.round(performance.now() - since);
  const question = request.question.trim();
  const searchedFor = question; // follow-up rewriting arrives in build step 6
  const trace: AskTrace = { question, searchedFor, retrieved: [], status: "error", ms: { total: 0 } };
  const finish = (response: AskResponse) => {
    trace.status = response.status;
    if (response.status === "error") trace.errorCode = response.code;
    trace.ms.total = elapsed(started);
    return { response, trace };
  };

  if (!hasApiKey()) {
    return finish({
      status: "error",
      code: "missing_api_key",
      message: "No Anthropic API key is set. Add ANTHROPIC_API_KEY to .env.local and restart the server.",
      retryable: false,
    });
  }

  const searchStarted = performance.now();
  const hits = await search(await getIndex(), searchedFor);
  trace.ms.search = elapsed(searchStarted);
  trace.retrieved = hits.map((h) => h.chunk.id);

  const { documents, sources } = buildDocuments(hits.map((h) => h.chunk));
  const answerStarted = performance.now();
  let message;
  try {
    message = await answerWithCitations(searchedFor, documents);
  } catch (error) {
    console.error("[ask] Claude request failed:", error);
    return finish(toAskError(error));
  } finally {
    trace.ms.answer = elapsed(answerStarted);
  }

  trace.model = message.model ?? ANSWER_MODEL;
  trace.usage = { input: message.usage.input_tokens, output: message.usage.output_tokens };
  if (message.stop_reason === "refusal") {
    return finish({
      status: "error",
      code: "refused",
      message: "Claude declined to answer this question. Try rephrasing it.",
      retryable: false,
    });
  }
  if (message.stop_reason === "max_tokens") console.warn("[ask] answer hit max_tokens and may be cut short");

  const gate = applyGroundingGate(message.content, sources, searchedFor);
  if (gate.result.status === "answered") trace.citations = gate.result.citations.length;
  trace.droppedCitations = gate.droppedCitations;
  trace.notCoveredReason = gate.notCoveredReason;
  return finish(gate.result);
}
