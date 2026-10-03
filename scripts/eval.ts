/**
 * npm run eval [-- --answers | --regrade] [-- path/to/questions.json]
 *
 * Retrieval check (default, no API calls): for each answerable question, is the passage holding its
 * evidence quote among the top 12 (TOP_K)? Reported for semantic search alone and for the full search (with
 * the keyword safety net), so the net's value is measured rather than assumed. The older,
 * looser check (any chunk of an expected section in the top 12) is reported too.
 *
 * Answer check (--answers, calls Claude, ~1-2¢ per question): runs each question through the real
 * pipeline (rewrite → search → Claude → grounding gate → gap re-search). Answerable questions and
 * follow-ups pass if they cite an expected section and name no gaps. An answer that names a gap is
 * marked "review": search may have missed the passage that covers it, so the gap may be false, and
 * a person checks it against the reference answer (printed alongside). So is one with a sentence
 * that may say the handbook lacks something. Out-of-scope questions pass
 * if declined; a partial answer is also marked "review". Every answer is printed. Results are
 * written to eval/results/<mode>-<set>.json.
 *
 * Re-grade (--regrade, no API calls, writes nothing): grades the saved answers in
 * eval/results/answers-<set>.json again with the current rules.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ask, type AskTrace } from "../src/lib/answer/pipeline";
import type { AnswerPart, AskResponse } from "../src/lib/answer/types";
import { isUncitedClaim } from "../src/lib/answer/uncited";
import { searchText } from "../src/lib/chunk";
import { embedQuery } from "../src/lib/search/embed";
import { loadIndex, search, semanticRanking, TOP_K, type HandbookIndex } from "../src/lib/search/search";

/** "people/time-off" matches contents/handbook/people/time-off.md. */
type Expectation = string[] | "not-covered";

export interface EvalQuestion {
  id: string;
  question: string;
  expect: Expectation;
  /** The reference answer, printed next to answers that need a person to review them. */
  answer?: string;
  /** "p<page>: <verbatim quote>" from the first expected section; the retrieval check looks for the chunk holding it. */
  evidence?: string;
  /** A follow-up asked right after `question`, with it as conversation history. */
  followUp?: { question: string; expect: Expectation; answer?: string };
}

function matchesSection(sectionPath: string, expected: string): boolean {
  const e = expected.replace(/^contents\/handbook\//, "").replace(/\.md$/, "");
  return sectionPath === `contents/handbook/${e}.md`;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--")) ?? "eval/questions.json";
  const questions = JSON.parse(await readFile(file, "utf8")) as EvalQuestion[];
  const index = await loadIndex();
  checkExpectations(index, questions);

  const set = path.basename(file, ".json"); // results are saved per question set, e.g. answers-holdout.json
  if (args.includes("--answers")) await answerEval(questions, set);
  else if (args.includes("--regrade")) await regrade(questions, set);
  else await retrievalEval(index, questions, set);
}

/** Fail fast on typos: every expected section must exist in the index. */
function checkExpectations(index: HandbookIndex, questions: EvalQuestion[]) {
  const known = [...new Set(index.chunks.map((c) => c.sectionPath))];
  for (const q of questions) {
    for (const e of [q.expect, q.followUp?.expect ?? []].flatMap((x) => (x === "not-covered" ? [] : x))) {
      if (!known.some((path) => matchesSection(path, e))) throw new Error(`${q.id}: unknown section "${e}"`);
    }
  }
}

// --- Retrieval eval ----------------------------------------------------------------------

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

interface RetrievalRow {
  id: string;
  /** Rank of the passage holding the answer among all chunks, by semantic search alone. */
  semanticRank: number | null;
  /** Its rank in the final search results (with the keyword safety net), or null if not in the top TOP_K. */
  searchRank: number | null;
  keywordNet: "added the answer" | "added another passage" | null;
  /** The older, looser check: any chunk of an expected section in the top TOP_K. */
  sectionHit: boolean;
}

/**
 * The chunks holding a question's evidence quote: the passage the answer has to come from. Any
 * chunk of the right section isn't enough (a section has a median of 10 chunks), so this is the
 * hit the retrieval check counts.
 */
function answerChunks(index: HandbookIndex, q: EvalQuestion): Set<string> {
  const quote = /^p\d+: (.+)$/.exec(q.evidence ?? "")?.[1];
  if (!quote) throw new Error(`${q.id}: needs an evidence quote ("p<page>: <quote>") for the retrieval check`);
  const expected = q.expect as string[];
  const found = index.chunks.filter(
    (c) => expected.some((e) => matchesSection(c.sectionPath, e)) && normalize(searchText(c)).includes(normalize(quote)),
  );
  if (found.length === 0) throw new Error(`${q.id}: no chunk of an expected section contains the evidence quote`);
  return new Set(found.map((c) => c.id));
}

async function retrievalEval(index: HandbookIndex, questions: EvalQuestion[], set: string) {
  const answerable = questions.filter((q) => q.expect !== "not-covered");
  const targets = new Map(answerable.map((q) => [q.id, answerChunks(index, q)])); // fail fast, before any embedding
  console.log(`Retrieval eval — ${answerable.length} answerable questions: is the passage holding the answer in the top ${TOP_K}?\n`);
  console.log(`${"question".padEnd(34)} ${"semantic".padStart(8)} ${"search".padStart(7)}  keyword safety net`);

  const rows: RetrievalRow[] = [];
  for (const q of answerable) {
    const target = targets.get(q.id)!;
    const rankIn = (ids: string[]) => {
      const i = ids.findIndex((id) => target.has(id));
      return i === -1 ? null : i + 1;
    };
    const semantic = semanticRanking(index, await embedQuery(q.question)).map((r) => r.id);
    const hits = await search(index, q.question);
    const added = hits.find((h) => h.via === "keyword")?.chunk.id;

    const row: RetrievalRow = {
      id: q.id,
      semanticRank: rankIn(semantic),
      searchRank: rankIn(hits.map((h) => h.chunk.id)),
      keywordNet: added === undefined ? null : target.has(added) ? "added the answer" : "added another passage",
      sectionHit: hits.some((h) => (q.expect as string[]).some((e) => matchesSection(h.chunk.sectionPath, e))),
    };
    rows.push(row);
    console.log(
      `${q.id.slice(0, 34).padEnd(34)} ${`#${row.semanticRank}`.padStart(8)} ${(row.searchRank ? `#${row.searchRank}` : "miss").padStart(7)}  ${row.keywordNet ?? ""}`,
    );
  }

  const count = (test: (row: RetrievalRow) => boolean) => rows.filter(test).length;
  const semanticHit = (r: RetrievalRow) => r.semanticRank !== null && r.semanticRank <= TOP_K;
  const summary = {
    topK: TOP_K,
    total: rows.length,
    hits: { semantic: count(semanticHit), search: count((r) => r.searchRank !== null), section: count((r) => r.sectionHit) },
    keywordNet: {
      used: count((r) => r.keywordNet !== null),
      addedAnswer: count((r) => r.keywordNet === "added the answer"),
      pushedOutAnswer: count((r) => semanticHit(r) && r.searchRank === null),
    },
  };
  const of = (n: number) => `${n}/${rows.length}`;
  console.log(`
answer passage in the top ${TOP_K}:  semantic search alone ${of(summary.hits.semantic)}, with the keyword safety net ${of(summary.hits.search)}
keyword safety net used on ${summary.keywordNet.used}: added the answer ${summary.keywordNet.addedAnswer}, pushed the answer out ${summary.keywordNet.pushedOutAnswer}
any chunk of an expected section in the top ${TOP_K} (the older, looser check): ${of(summary.hits.section)}

#N = rank of the passage holding the answer (semantic: among all chunks); miss = not in the top ${TOP_K}.`);
  await saveResults(`retrieval-${set}`, { ...summary, rows });
}

// --- Answer eval -------------------------------------------------------------------------

// Sonnet 5.5 list prices, $ per million tokens (answer calls only; the Haiku rewrite is ~0.1¢).
const PRICE = { input: 2, output: 10 };

type Outcome = "pass" | "review" | "fail";

interface Row {
  id: string;
  kind: "question" | "follow-up" | "out-of-scope";
  outcome: Outcome;
  status: AskResponse["status"];
  searchedFor: string;
  citedSections: string[];
  answer: string;
  /** The answer as shown: runs of text and their citations. Absent in results saved before it was recorded. */
  parts?: AnswerPart[];
  /** Gaps the answer named ("not found in the passages searched"). Absent in results saved before gaps existed. */
  gaps?: string[];
  trace: AskTrace;
}

/**
 * Pass, review or fail for one answer. An answerable question passes only if it cites an expected
 * section and names no gaps. A gap may be false (search can miss the passage that covers it), so an
 * answer that names one goes to a person, and so does one that may say the handbook lacks something.
 */
function grade(row: Pick<Row, "status" | "citedSections" | "answer" | "gaps">, expect: Expectation): Outcome {
  if (expect === "not-covered") return row.status === "not-covered" ? "pass" : row.status === "answered" ? "review" : "fail";
  const cited = row.citedSections.some((path) => expect.some((e) => matchesSection(`contents/handbook/${path}.md`, e)));
  if (!cited) return "fail";
  return (row.gaps ?? []).length > 0 || mayClaimAbsence(row.answer) ? "review" : "pass";
}

// A sentence naming the handbook or the passages, then a negation, unless it's reporting what the
// handbook says ("The handbook says you don't need…"). A rough flag for a person to check, not a verdict.
const MAY_CLAIM_ABSENCE = /\b(?:handbook|passages?|excerpts?)\b(?!['’]s)(?!\s+(?:says|states|notes|explains|adds)\b)[^.!?\n]{0,40}?(?:\b(?:not|no|never|nothing|none)\b|n['’]t\b)/i;

function mayClaimAbsence(answer: string): boolean {
  return answer
    .replace(/\[\d+\]/g, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .some((sentence) => MAY_CLAIM_ABSENCE.test(sentence));
}

function citedSectionsOf(response: AskResponse): string[] {
  if (response.status !== "answered") return [];
  return [...new Set(response.citations.map((c) => c.sectionPath.replace(/^contents\/handbook\/|\.md$/g, "")))];
}

function answerText(response: AskResponse): string {
  if (response.status !== "answered") return "";
  return response.parts.map((p) => p.text + p.citations.map((n) => `[${n}]`).join("")).join("");
}

/** One line per row, then the details a person needs: every answer, and the reference answer when it needs review. */
function printRow(row: Row, reference: string | undefined, previous?: Outcome) {
  const mark = { pass: "pass", review: "REVIEW", fail: "FAIL" }[row.outcome].padEnd(6);
  const was = previous && previous !== row.outcome ? `  (was ${previous})` : "";
  const uncited = row.status === "answered" ? `  uncited ${row.trace.uncitedChars ?? 0}` : "";
  console.log(`${mark}  ${row.id.slice(0, 34).padEnd(34)} ${row.kind.padEnd(12)} ${row.status.padEnd(11)} ${(row.trace.ms.total / 1000).toFixed(1)}s${uncited}${was}`);
  if (row.outcome !== "pass") console.log(`      searched for: ${row.searchedFor}\n      cited: ${row.citedSections.join(", ") || "—"}`);
  if (row.status === "answered") console.log(`      answer: ${row.answer.replace(/\n+/g, " ")}`);
  if (row.gaps?.length) console.log(`      gaps: ${row.gaps.join("; ")}`);
  if (row.outcome === "review" && reference) console.log(`      reference: ${reference}`);
}

/** The pass and review counts per kind, as printed and saved. */
function summarize(rows: Row[]) {
  const count = (kind: Row["kind"], outcome: Outcome) => {
    const of = rows.filter((r) => r.kind === kind);
    return `${of.filter((r) => r.outcome === outcome).length}/${of.length}`;
  };
  return {
    questions: count("question", "pass"),
    questionsReview: count("question", "review"),
    followUps: count("follow-up", "pass"),
    followUpsReview: count("follow-up", "review"),
    outOfScopeDeclined: count("out-of-scope", "pass"),
    outOfScopeReview: count("out-of-scope", "review"),
  };
}

/**
 * How the answers read, beyond what they cite: answers whose first sentence is an uncited claim
 * (shown grey, so the main answer looks unsupported), answers whose uncited text still talks about
 * "the passages", first replies that said "not found" but ended answered after the gap re-search,
 * and "not found" replies that got a second search. Needs saved parts; older runs have none.
 */
function readingChecks(rows: Row[]) {
  const answered = rows.filter((r) => r.status === "answered" && r.parts);
  const opensUncited = answered.filter((r) => {
    const first = r.parts!.find((p) => p.text.trim() !== "");
    if (!first || first.citations.length > 0) return false;
    // The first sentence ends inside this part (otherwise it runs on into cited text). A lead-in ending ":" isn't a claim.
    const end = /[.!?:](?=\s|$)|\n/.exec(first.text);
    return end !== null && isUncitedClaim({ text: first.text.slice(0, end.index + 1), citations: [] });
  }).length;
  const aboutPassages = answered.filter((r) =>
    r.parts!.some((p) => p.citations.length === 0 && /\b(?:passages?|excerpts?)\b/i.test(p.text)),
  ).length;
  const notCovered = rows.filter((r) => r.status === "not-covered");
  const researched = notCovered.filter((r) => r.trace.research && r.trace.research.outcome !== "failed").length;
  const firstNotFound = rows.filter((r) => r.trace.research?.first === "not-covered");
  const recovered = firstNotFound.filter((r) => r.status === "answered").length;
  return {
    opensUncited: answered.length ? `${opensUncited}/${answered.length}` : "n/a",
    aboutPassages: answered.length ? `${aboutPassages}/${answered.length}` : "n/a",
    notCoveredSearchedAgain: `${researched}/${notCovered.length}`,
    notFoundThenAnswered: `${recovered}/${firstNotFound.length}`,
  };
}

function printReadingChecks(checks: ReturnType<typeof readingChecks>) {
  console.log(`answers opening with an uncited claim:          ${checks.opensUncited}
answers with uncited text about the passages:   ${checks.aboutPassages}
first replies "not found", answered after re-search: ${checks.notFoundThenAnswered}
"not found" replies that searched their gaps:   ${checks.notCoveredSearchedAgain}`);
}

function printSummary(summary: ReturnType<typeof summarize>) {
  console.log(`
questions: expected section cited, no gaps:     ${summary.questions}
questions with gaps (review above):             ${summary.questionsReview}
follow-ups: expected section cited, no gaps:    ${summary.followUps}
follow-ups with gaps (review above):            ${summary.followUpsReview}
out-of-scope questions declined:                ${summary.outOfScopeDeclined}
out-of-scope answered partially (review above): ${summary.outOfScopeReview}`);
}

async function answerEval(questions: EvalQuestion[], set: string) {
  try {
    process.loadEnvFile(".env.local"); // tsx doesn't load Next.js env files
  } catch {
    // fall through: ask() reports a missing key
  }
  // Load the search model before any paid call: a failed download stops the run here, and a slow
  // one doesn't turn the first question into a "search unavailable" failure.
  await embedQuery("warm-up");
  const rows: Row[] = [];
  const run = async (id: string, kind: Row["kind"], question: string, expect: Expectation, reference?: string, history: { question: string; searchedFor: string }[] = []) => {
    const { response, trace } = await ask({ question, history });
    const answered = {
      status: response.status,
      citedSections: citedSectionsOf(response),
      answer: answerText(response),
      parts: response.status === "answered" ? response.parts : undefined,
      gaps: response.status === "answered" ? response.gaps : [],
    };
    const row: Row = { id, kind, outcome: grade(answered, expect), searchedFor: trace.searchedFor, ...answered, trace };
    rows.push(row);
    printRow(row, reference);
    if (response.status === "error") console.log(`      error: ${response.message}`);
    return trace;
  };

  console.log(`Answer eval — ${questions.length} questions + ${questions.filter((q) => q.followUp).length} follow-ups\n`);
  for (const q of questions) {
    const kind = q.expect === "not-covered" ? "out-of-scope" : "question";
    const trace = await run(q.id, kind, q.question, q.expect, q.answer);
    if (q.followUp) {
      await run(`${q.id} → follow-up`, "follow-up", q.followUp.question, q.followUp.expect, q.followUp.answer, [{ question: q.question, searchedFor: trace.searchedFor }]);
    }
  }

  const answered = rows.filter((r) => r.status === "answered");
  const input = rows.reduce((s, r) => s + (r.trace.usage?.input ?? 0), 0);
  const output = rows.reduce((s, r) => s + (r.trace.usage?.output ?? 0), 0);
  const cost = (input * PRICE.input + output * PRICE.output) / 1e6;
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

  const summary = summarize(rows);
  printSummary(summary);
  const checks = readingChecks(rows);
  printReadingChecks(checks);
  console.log(`answers with any uncited text:                  ${answered.filter((r) => (r.trace.uncitedChars ?? 0) > 0).length}/${answered.length}
gap re-search on answered questions: ran / asked Claude again / answer replaced: ${answered.filter((r) => r.trace.research).length} / ${answered.filter((r) => ["used-second", "kept-first", "second-call-failed"].includes(r.trace.research?.outcome ?? "")).length} / ${answered.filter((r) => r.trace.research?.outcome === "used-second").length} of ${answered.length}
median time per question:                       ${(median(rows.map((r) => r.trace.ms.total)) / 1000).toFixed(1)}s
answer-model cost for this run:                 $${cost.toFixed(3)} (${input} in / ${output} out tokens)`);
  // A run with errors (no key, rate limits, an outage) measures the setup, not the answers.
  const errors = rows.filter((r) => r.status === "error").length;
  if (errors > 0) {
    console.error(`\n${errors} question(s) ended in an error, so eval/results/answers-${set}.json was not overwritten.`);
    process.exitCode = 1;
    return;
  }
  await saveResults(`answers-${set}`, { summary: { ...summary, ...checks, cost }, rows });
}

/** Grade the saved answers for a set again with the current rules. No API calls; nothing is written. */
async function regrade(questions: EvalQuestion[], set: string) {
  const file = `eval/results/answers-${set}.json`;
  const saved = JSON.parse(await readFile(file, "utf8")) as { rows: Row[] };
  const byId = new Map<string, { expect: Expectation; reference?: string }>();
  for (const q of questions) {
    byId.set(q.id, { expect: q.expect, reference: q.answer });
    if (q.followUp) byId.set(`${q.id} → follow-up`, { expect: q.followUp.expect, reference: q.followUp.answer });
  }

  console.log(`Re-grading ${file} — ${saved.rows.length} saved answers\n`);
  const rows: Row[] = [];
  for (const row of saved.rows) {
    const question = byId.get(row.id);
    if (!question) throw new Error(`${row.id}: not in the question file`);
    const regraded = { ...row, outcome: grade(row, question.expect) };
    rows.push(regraded);
    printRow(regraded, question.reference, row.outcome);
  }
  printSummary(summarize(rows));
  printReadingChecks(readingChecks(rows));
}

async function saveResults(name: string, data: unknown) {
  await mkdir("eval/results", { recursive: true });
  await writeFile(`eval/results/${name}.json`, JSON.stringify(data, null, 2) + "\n");
  console.log(`\nSaved eval/results/${name}.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
