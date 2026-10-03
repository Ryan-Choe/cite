import type { Chunk } from "../chunk";
import { dot, EMBEDDING, embedQuery } from "./embed";
import { readIndex, warnIfStale, type IndexFile } from "./index-file";
import { buildKeywordIndex, rareWordMatch, withKeywordMatch, type KeywordIndex } from "./keyword";

/**
 * How many chunks the answer step gets. Across the 116 search-eval questions, the passage with the
 * answer is in the top 8 for 94, the top 12 for 97 and the top 16 for 99. The top 12 costs about a
 * quarter more input per answer than the top 8, for questions where the answer ranks just below
 * passages that share its words ("criteria to move up" ranks sales stage criteria first).
 */
export const TOP_K = 12;

export interface HandbookIndex {
  source: IndexFile["source"];
  chunks: Chunk[];
  byId: Map<string, Chunk>;
  vectors: Float32Array[];
  keyword: KeywordIndex;
}

export interface SearchHit {
  chunk: Chunk;
  /** Cosine similarity to the query, -1 to 1. */
  similarity: number;
  /** "keyword" if the keyword safety net put it in (the query shares a rare word with it). */
  via: "semantic" | "keyword";
}

export async function loadIndex(dir?: string): Promise<HandbookIndex> {
  const { file, vectors } = await readIndex(EMBEDDING, dir);
  void warnIfStale(file.source); // runs in the background; only logs
  return {
    source: file.source,
    chunks: file.chunks,
    byId: new Map(file.chunks.map((c) => [c.id, c])),
    vectors,
    keyword: buildKeywordIndex(file.chunks),
  };
}

// Load once per process (and survive Next.js dev hot reloads), like the embedding model, and keyed
// by model the same way. A failed load is forgotten, so the next question tries again instead of
// failing until a restart.
const INDEX_KEY = `${EMBEDDING.model}@${EMBEDDING.dtype}`;
const globalForIndex = globalThis as unknown as { citeIndexByModel?: { key: string; loading: Promise<HandbookIndex> } };
export function getIndex(): Promise<HandbookIndex> {
  const cached = globalForIndex.citeIndexByModel;
  if (cached?.key === INDEX_KEY) return cached.loading;
  const entry = { key: INDEX_KEY, loading: loadIndex() };
  globalForIndex.citeIndexByModel = entry;
  entry.loading.catch(() => {
    if (globalForIndex.citeIndexByModel === entry) globalForIndex.citeIndexByModel = undefined;
  });
  return entry.loading;
}

/** Every chunk, most similar to the query vector first. With ~3,200 chunks, comparing against all of them takes a millisecond or two. */
export function semanticRanking(index: HandbookIndex, queryVector: Float32Array): { id: string; similarity: number }[] {
  return index.chunks
    .map((chunk, i) => ({ id: chunk.id, similarity: dot(queryVector, index.vectors[i]) }))
    .sort((a, b) => b.similarity - a.similarity);
}

/**
 * Search: the `limit` chunks closest in meaning to the query, except that the keyword safety net
 * (see keyword.ts) can take the last slot when the query shares a rare word with a chunk that
 * semantic search didn't rank that high.
 */
export async function search(index: HandbookIndex, query: string, limit = TOP_K): Promise<SearchHit[]> {
  const ranked = semanticRanking(index, await embedQuery(query));
  const similarity = new Map(ranked.map((r) => [r.id, r.similarity]));
  const match = rareWordMatch(index.keyword, query);
  const semanticTop = new Set(ranked.slice(0, limit).map((r) => r.id));

  return withKeywordMatch(
    ranked.map((r) => r.id),
    match,
    limit,
  ).map((id) => ({
    chunk: index.byId.get(id)!,
    similarity: similarity.get(id)!,
    via: semanticTop.has(id) ? "semantic" : "keyword",
  }));
}
