/**
 * npm run eval [-- path/to/questions.json]
 *
 * Retrieval check (no API calls): for each answerable question, is a chunk from an expected
 * section among the top 8? Reported for keyword-only, semantic-only, and hybrid search, so the
 * value of combining them is measured rather than assumed.
 */
import { readFile } from "node:fs/promises";
import { embed } from "../src/lib/search/embed";
import { reciprocalRankFusion } from "../src/lib/search/fuse";
import { keywordRanking, loadIndex, semanticRanking, TOP_K, type HandbookIndex } from "../src/lib/search/search";

/** "people/time-off" matches contents/handbook/people/time-off.md. */
type Expectation = string[] | "not-covered";

export interface EvalQuestion {
  id: string;
  question: string;
  expect: Expectation;
  /** A follow-up asked right after `question`; checked by the answer eval (needs rewriting). */
  followUp?: { question: string; expect: Expectation };
}

const METHODS = ["keyword", "semantic", "hybrid"] as const;
type Method = (typeof METHODS)[number];

function matchesSection(sectionPath: string, expected: string): boolean {
  const e = expected.replace(/^contents\/handbook\//, "").replace(/\.md$/, "");
  return sectionPath === `contents/handbook/${e}.md`;
}

/** 1-based rank of the first chunk from an expected section within the top K, or null. */
function firstHit(index: HandbookIndex, ranking: string[], expected: string[]): number | null {
  const position = ranking
    .slice(0, TOP_K)
    .findIndex((id) => expected.some((e) => matchesSection(index.byId.get(id)!.sectionPath, e)));
  return position === -1 ? null : position + 1;
}

async function main() {
  const file = process.argv[2] ?? "eval/questions.json";
  const questions = JSON.parse(await readFile(file, "utf8")) as EvalQuestion[];
  const index = await loadIndex();

  // Fail fast on typos: every expected section must exist in the index.
  const known = new Set(index.chunks.map((c) => c.sectionPath));
  for (const q of questions) {
    for (const e of [q.expect, q.followUp?.expect ?? []].flatMap((x) => (x === "not-covered" ? [] : x))) {
      if (![...known].some((path) => matchesSection(path, e))) throw new Error(`${q.id}: unknown section "${e}"`);
    }
  }

  const answerable = questions.filter((q) => q.expect !== "not-covered");
  console.log(`Retrieval eval — ${answerable.length} answerable questions, hit@${TOP_K}\n`);
  console.log(`${"question".padEnd(28)} ${METHODS.map((m) => m.padStart(9)).join(" ")}`);

  const hits: Record<Method, number> = { keyword: 0, semantic: 0, hybrid: 0 };
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
    const cells = METHODS.map((m) => (ranks[m] === null ? "miss" : `#${ranks[m]}`).padStart(9));
    console.log(`${q.id.slice(0, 28).padEnd(28)} ${cells.join(" ")}`);
  }

  const pct = (n: number) => `${n}/${answerable.length}`.padStart(9);
  console.log(`${"hit rate".padEnd(28)} ${METHODS.map((m) => pct(hits[m])).join(" ")}`);
  console.log(`\n#N = rank of the first chunk from an expected section; miss = not in the top ${TOP_K}.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
