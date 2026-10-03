/**
 * npm run eval [-- --answers | --regrade] [-- path/to/questions.json]
 *
 * Retrieval check (default, no API calls): for each answerable question, is a chunk from an
 * expected section among the top 8? Reported for keyword-only, semantic-only, and hybrid search,
 * so the value of combining them is measured rather than assumed.
 *
 * Answer check (--answers, calls Claude, ~1-2¢ per question): runs each question through the real
 * pipeline (rewrite → search → Claude → grounding gate → gap re-search). Answerable questions and
 * follow-ups pass if they cite an expected section and name no gaps. An answer that names a gap is
 * marked "review": search may have missed the passage that covers it, so the gap may be false, and
 * a person checks it against the reference answer (printed alongside). Out-of-scope questions pass
 * if declined; a partial answer is also marked "review". Every answer is printed. Results are
 * written to eval/results/<mode>-<set>.json.
 *
 * Re-grade (--regrade, no API calls, writes nothing): grades the saved answers in
 * eval/results/answers-<set>.json again with the current rules.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ask, type AskTrace } from "../src/lib/answer/pipeline";
import { findAbsenceClaims } from "../src/lib/answer/gaps";
import type { AskResponse } from "../src/lib/answer/types";
import { embed } from "../src/lib/search/embed";
import { hybridRanking, keywordRanking, loadIndex, semanticRanking, TOP_K, type HandbookIndex } from "../src/lib/search/search";

/** "people/time-off" matches contents/handbook/people/time-off.md. */
type Expectation = string[] | "not-covered";

export interface EvalQuestion {
  id: string;
  question: string;
  expect: Expectation;
  /** The reference answer, printed next to answers that need a person to review them. */
  answer?: string;
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

const METHODS = ["keyword", "semantic", "hybrid"] as const;
type Method = (typeof METHODS)[number];

/** 1-based rank of the first chunk from an expected section within the top K, or null. */
function firstHit(index: HandbookIndex, ranking: string[], expected: string[]): number | null {
  const position = ranking
    .slice(0, TOP_K)
    .findIndex((id) => expected.some((e) => matchesSection(index.byId.get(id)!.sectionPath, e)));
  return position === -1 ? null : position + 1;
}

async function retrievalEval(index: HandbookIndex, questions: EvalQuestion[], set: string) {
  const answerable = questions.filter((q) => q.expect !== "not-covered");
  console.log(`Retrieval eval — ${answerable.length} answerable questions, hit@${TOP_K}\n`);
  console.log(`${"question".padEnd(32)} ${METHODS.map((m) => m.padStart(9)).join(" ")}`);

  const hits: Record<Method, number> = { keyword: 0, semantic: 0, hybrid: 0 };
  const rows = [];
  for (const q of answerable) {
    const expected = q.expect as string[];
    const keyword = keywordRanking(index, q.question);
    const semantic = semanticRanking(index, await embed(q.question));
    const hybrid = hybridRanking(keyword, semantic).map((f) => f.id);

    const ranks: Record<Method, number | null> = {
      keyword: firstHit(index, keyword, expected),
      semantic: firstHit(index, semantic, expected),
      hybrid: firstHit(index, hybrid, expected),
    };
    for (const m of METHODS) if (ranks[m] !== null) hits[m]++;
    rows.push({ id: q.id, ...ranks });
    const cells = METHODS.map((m) => (ranks[m] === null ? "miss" : `#${ranks[m]}`).padStart(9));
    console.log(`${q.id.slice(0, 32).padEnd(32)} ${cells.join(" ")}`);
  }

  const pct = (n: number) => `${n}/${answerable.length}`.padStart(9);
  console.log(`${"hit rate".padEnd(32)} ${METHODS.map((m) => pct(hits[m])).join(" ")}`);
  console.log(`\n#N = rank of the first chunk from an expected section; miss = not in the top ${TOP_K}.`);
  await saveResults(`retrieval-${set}`, { topK: TOP_K, total: answerable.length, hits, rows });
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
  /** Gaps the answer named ("not found in the passages searched"). Absent in results saved before gaps existed. */
  gaps?: string[];
  trace: AskTrace;
}

/**
 * Pass, review or fail for one answer. An answerable question passes only if it cites an expected
 * section and names no gaps. A gap may be false (search can miss the passage that covers it), so an
 * answer that names one, or still claims the handbook doesn't say something, goes to a person.
 */
function grade(row: Pick<Row, "status" | "citedSections" | "answer" | "gaps">, expect: Expectation): Outcome {
  if (expect === "not-covered") return row.status === "not-covered" ? "pass" : row.status === "answered" ? "review" : "fail";
  const cited = row.citedSections.some((path) => expect.some((e) => matchesSection(`contents/handbook/${path}.md`, e)));
  if (!cited) return "fail";
  const claimsAbsence = findAbsenceClaims(row.answer.replace(/\[\d+\]/g, "")).length > 0;
  return (row.gaps ?? []).length > 0 || claimsAbsence ? "review" : "pass";
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
  await embed("warm-up");
  const rows: Row[] = [];
  const run = async (id: string, kind: Row["kind"], question: string, expect: Expectation, reference?: string, history: { question: string; searchedFor: string }[] = []) => {
    const { response, trace } = await ask({ question, history });
    const answered = {
      status: response.status,
      citedSections: citedSectionsOf(response),
      answer: answerText(response),
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
  console.log(`answers with any uncited text:                  ${answered.filter((r) => (r.trace.uncitedChars ?? 0) > 0).length}/${answered.length}
gap re-search: ran / asked Claude again / answer replaced: ${rows.filter((r) => r.trace.research).length} / ${rows.filter((r) => ["used-second", "kept-first", "second-call-failed"].includes(r.trace.research?.outcome ?? "")).length} / ${rows.filter((r) => r.trace.research?.outcome === "used-second").length} of ${answered.length} answered
median time per question:                       ${(median(rows.map((r) => r.trace.ms.total)) / 1000).toFixed(1)}s
answer-model cost for this run:                 $${cost.toFixed(3)} (${input} in / ${output} out tokens)`);
  // A run with errors (no key, rate limits, an outage) measures the setup, not the answers.
  const errors = rows.filter((r) => r.status === "error").length;
  if (errors > 0) {
    console.error(`\n${errors} question(s) ended in an error, so eval/results/answers-${set}.json was not overwritten.`);
    process.exitCode = 1;
    return;
  }
  await saveResults(`answers-${set}`, { summary: { ...summary, cost }, rows });
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
