/**
 * npm run eval [-- --answers] [-- path/to/questions.json]
 *
 * Retrieval check (default, no API calls): for each answerable question, is a chunk from an
 * expected section among the top 8? Reported for keyword-only, semantic-only, and hybrid search,
 * so the value of combining them is measured rather than assumed.
 *
 * Answer check (--answers, calls Claude, ~1-2¢ per question): runs each question through the real
 * pipeline (rewrite → search → Claude → grounding gate). Answerable questions and follow-ups must be
 * answered with a citation from an expected section; out-of-scope questions must come back
 * "not covered". Results are also written to eval/results/.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { ask, type AskTrace } from "../src/lib/answer/pipeline";
import type { AskResponse } from "../src/lib/answer/types";
import { embed } from "../src/lib/search/embed";
import { reciprocalRankFusion } from "../src/lib/search/fuse";
import { keywordRanking, loadIndex, semanticRanking, TOP_K, type HandbookIndex } from "../src/lib/search/search";

/** "people/time-off" matches contents/handbook/people/time-off.md. */
type Expectation = string[] | "not-covered";

export interface EvalQuestion {
  id: string;
  question: string;
  expect: Expectation;
  /** A follow-up asked right after `question`, with it as conversation history. */
  followUp?: { question: string; expect: Expectation };
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

  if (args.includes("--answers")) await answerEval(questions);
  else await retrievalEval(index, questions);
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

async function retrievalEval(index: HandbookIndex, questions: EvalQuestion[]) {
  const answerable = questions.filter((q) => q.expect !== "not-covered");
  console.log(`Retrieval eval — ${answerable.length} answerable questions, hit@${TOP_K}\n`);
  console.log(`${"question".padEnd(32)} ${METHODS.map((m) => m.padStart(9)).join(" ")}`);

  const hits: Record<Method, number> = { keyword: 0, semantic: 0, hybrid: 0 };
  const rows = [];
  for (const q of answerable) {
    const expected = q.expect as string[];
    const keyword = keywordRanking(index, q.question);
    const semantic = semanticRanking(index, await embed(q.question));
    const hybrid = reciprocalRankFusion([keyword, semantic]).map((f) => f.id);

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
  await saveResults("retrieval", { topK: TOP_K, total: answerable.length, hits, rows });
}

// --- Answer eval -------------------------------------------------------------------------

// Sonnet 5.5 list prices, $ per million tokens (answer calls only; the Haiku rewrite is ~0.1¢).
const PRICE = { input: 2, output: 10 };

interface Row {
  id: string;
  kind: "question" | "follow-up" | "out-of-scope";
  pass: boolean;
  status: AskResponse["status"];
  searchedFor: string;
  citedSections: string[];
  trace: AskTrace;
}

function grade(response: AskResponse, expect: Expectation): { pass: boolean; citedSections: string[] } {
  if (expect === "not-covered") return { pass: response.status === "not-covered", citedSections: [] };
  if (response.status !== "answered") return { pass: false, citedSections: [] };
  const citedSections = [...new Set(response.citations.map((c) => c.sectionPath.replace(/^contents\/handbook\/|\.md$/g, "")))];
  return { pass: citedSections.some((path) => expect.some((e) => matchesSection(`contents/handbook/${path}.md`, e))), citedSections };
}

async function answerEval(questions: EvalQuestion[]) {
  try {
    process.loadEnvFile(".env.local"); // tsx doesn't load Next.js env files
  } catch {
    // fall through: ask() reports a missing key
  }
  const rows: Row[] = [];
  const run = async (id: string, kind: Row["kind"], question: string, expect: Expectation, history: { question: string; searchedFor: string }[] = []) => {
    const { response, trace } = await ask({ question, history });
    const { pass, citedSections } = grade(response, expect);
    const row: Row = { id, kind, pass, status: response.status, searchedFor: trace.searchedFor, citedSections, trace };
    rows.push(row);
    const mark = pass ? "pass" : "FAIL";
    const uncited = response.status === "answered" ? `  uncited ${trace.uncitedChars ?? 0}` : "";
    console.log(`${mark}  ${id.slice(0, 34).padEnd(34)} ${kind.padEnd(12)} ${response.status.padEnd(11)} ${(trace.ms.total / 1000).toFixed(1)}s${uncited}`);
    if (!pass) console.log(`      searched for: ${trace.searchedFor}\n      cited: ${citedSections.join(", ") || "—"}${response.status === "error" ? `\n      error: ${response.message}` : ""}`);
    return trace;
  };

  console.log(`Answer eval — ${questions.length} questions + ${questions.filter((q) => q.followUp).length} follow-ups\n`);
  for (const q of questions) {
    const kind = q.expect === "not-covered" ? "out-of-scope" : "question";
    const trace = await run(q.id, kind, q.question, q.expect);
    if (q.followUp) {
      await run(`${q.id} → follow-up`, "follow-up", q.followUp.question, q.followUp.expect, [{ question: q.question, searchedFor: trace.searchedFor }]);
    }
  }

  const summary = (kind: Row["kind"]) => {
    const of = rows.filter((r) => r.kind === kind);
    return `${of.filter((r) => r.pass).length}/${of.length}`;
  };
  const answered = rows.filter((r) => r.status === "answered");
  const input = rows.reduce((s, r) => s + (r.trace.usage?.input ?? 0), 0);
  const output = rows.reduce((s, r) => s + (r.trace.usage?.output ?? 0), 0);
  const cost = (input * PRICE.input + output * PRICE.output) / 1e6;
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

  console.log(`
questions answered with an expected citation:  ${summary("question")}
follow-ups (rewritten) answered correctly:      ${summary("follow-up")}
out-of-scope questions declined:                ${summary("out-of-scope")}
answers with any uncited text:                  ${answered.filter((r) => (r.trace.uncitedChars ?? 0) > 0).length}/${answered.length}
median time per question:                       ${(median(rows.map((r) => r.trace.ms.total)) / 1000).toFixed(1)}s
answer-model cost for this run:                 $${cost.toFixed(3)} (${input} in / ${output} out tokens)`);
  await saveResults("answers", { summary: { questions: summary("question"), followUps: summary("follow-up"), outOfScope: summary("out-of-scope"), cost }, rows });
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
