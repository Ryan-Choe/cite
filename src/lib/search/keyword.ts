import MiniSearch from "minisearch";
import { bodyText, type Chunk } from "../chunk";

/**
 * Keyword safety net for semantic search.
 *
 * Embeddings match meaning, so they handle paraphrase ("time off" ↔ "vacation") but can miss a
 * passage whose link to the question is one rare exact string: `search_insights`,
 * `security-internal@posthog.com`, "Hedgehouse" (in the eval, semantic search ranked those
 * answers #10 to #46). So when a question contains a word that appears in at most
 * RARE_MAX_PASSAGES passages, keyword search (BM25) looks up those words, and its best match
 * gets the last search slot (see withKeywordMatch). Questions without such a word, most of
 * them, get plain semantic results.
 *
 * Measured on 116 eval questions (eval/SEARCH.md): it fixed 3 of 32 questions built around a
 * rare name and pushed no correct passage out.
 */
export const RARE_MAX_PASSAGES = 3;

// Very common words carry no meaning for keyword search ("how", "do", "i", …).
const STOP_WORDS = new Set(
  ("a an and are as at be but by can could do does for from had has have how i if in into is it its " +
    "me my of on or our should so that the their them then there these they this to us was we were " +
    "what when where which who why will with would you your").split(" "),
);

// MiniSearch's tokenizer splits on spaces and punctuation, which breaks search_insights,
// html.to.design or privacy@posthog.com into parts that are usually common words, and that match
// other passages. Keep each such joined string whole as well as split.
const splitWords = MiniSearch.getDefault("tokenize") as (text: string) => string[];
const JOINED = /[\p{L}\p{N}]+(?:[_\-./@:][\p{L}\p{N}]+)+/gu;
const JOINER = /[_\-./@:]/;

export function tokenize(text: string): string[] {
  return [...splitWords(text), ...(text.match(JOINED) ?? [])];
}

/** Lowercase, and drop stop words, including joined ones made only of stop words ("if/when", "to-do"). */
function processTerm(word: string): string | null {
  const term = word.toLowerCase();
  return term.split(JOINER).every((part) => STOP_WORDS.has(part)) ? null : term;
}

export interface KeywordIndex {
  search: MiniSearch<{ id: string; title: string; body: string }>;
  /** How many passages each term appears in. */
  passageCount: Map<string, number>;
}

export function buildKeywordIndex(chunks: Chunk[]): KeywordIndex {
  const search = new MiniSearch<{ id: string; title: string; body: string }>({
    fields: ["title", "body"],
    tokenize,
    processTerm,
    searchOptions: { boost: { title: 2 } }, // a match in "Time off › Booking" says more than one in the body
  });
  search.addAll(chunks.map((c) => ({ id: c.id, title: c.title, body: bodyText(c) })));

  const passageCount = new Map<string, number>();
  for (const c of chunks) {
    const terms = new Set(tokenize(`${c.title} ${bodyText(c)}`).map(processTerm));
    for (const term of terms) if (term) passageCount.set(term, (passageCount.get(term) ?? 0) + 1);
  }
  return { search, passageCount };
}

/** The question's words that appear in 1 to RARE_MAX_PASSAGES passages. A misspelled word appears in none. */
export function rareWords(index: KeywordIndex, question: string): string[] {
  return tokenize(question).filter((word) => {
    const term = processTerm(word);
    const count = term ? (index.passageCount.get(term) ?? 0) : 0;
    return count > 0 && count <= RARE_MAX_PASSAGES;
  });
}

/** The id of the passage that best matches the question's rare words, if it has any. */
export function rareWordMatch(index: KeywordIndex, question: string): string | undefined {
  const words = [...new Set(rareWords(index, question).map((w) => w.toLowerCase()))];
  if (words.length === 0) return undefined;
  // Look the rare words up whole. MiniSearch would otherwise tokenize the query again, splitting
  // "week-to-week" back into "week", which matches passages that don't contain the rare word.
  return index.search.search(words.join(" "), { combineWith: "OR", tokenize: (query) => query.split(" ") })[0]?.id as
    | string
    | undefined;
}

/**
 * The final top `limit` ids: semantic search's ranking, with the keyword match in the last slot
 * if semantic search didn't already include it. Replacing the last slot keeps the number of
 * passages sent to Claude (and the cost) the same.
 */
export function withKeywordMatch(semantic: string[], match: string | undefined, limit: number): string[] {
  if (limit < 1) return [];
  const top = semantic.slice(0, limit);
  if (!match || top.includes(match)) return top;
  return [...top.slice(0, limit - 1), match];
}
