import MiniSearch from "minisearch";
import { bodyText, type Chunk } from "../chunk";
import { dot, embed } from "./embed";
import { reciprocalRankFusion } from "./fuse";
import { readIndex, warnIfStale, type IndexFile } from "./index-file";

/** How many chunks the answer step gets, and how deep each retriever looks before fusing. */
export const TOP_K = 8;
const CANDIDATES = 50;

// Very common words carry no meaning for keyword search ("how", "do", "i", …). BM25 already
// down-weights them, but dropping them keeps a question's filler from matching everything.
const STOP_WORDS = new Set(
  ("a an and are as at be but by can could do does for from had has have how i if in into is it its " +
    "me my of on or our should so that the their them then there these they this to us was we were " +
    "what when where which who why will with would you your").split(" "),
);

export interface HandbookIndex {
  source: IndexFile["source"];
  chunks: Chunk[];
  byId: Map<string, Chunk>;
  vectors: Float32Array[];
  keyword: MiniSearch<{ id: string; title: string; body: string }>;
}

export interface SearchHit {
  chunk: Chunk;
  score: number; // fused RRF score
  keywordRank: number | null; // 1-based position in each retriever's list, if it found this chunk
  semanticRank: number | null;
}

export async function loadIndex(dir?: string): Promise<HandbookIndex> {
  const { file, vectors } = await readIndex(dir);
  void warnIfStale(file.source); // runs in the background; only logs
  const keyword = new MiniSearch<{ id: string; title: string; body: string }>({
    fields: ["title", "body"],
    processTerm: (term) => (STOP_WORDS.has(term.toLowerCase()) ? null : term.toLowerCase()),
    searchOptions: { boost: { title: 2 } }, // a match in "Time off › Booking" says more than one in the body
  });
  keyword.addAll(file.chunks.map((c) => ({ id: c.id, title: c.title, body: bodyText(c) })));
  return {
    source: file.source,
    chunks: file.chunks,
    byId: new Map(file.chunks.map((c) => [c.id, c])),
    vectors,
    keyword,
  };
}

// Load once per process (and survive Next.js dev hot reloads), like the embedding model.
const globalForIndex = globalThis as unknown as { citeIndex?: Promise<HandbookIndex> };
export function getIndex(): Promise<HandbookIndex> {
  globalForIndex.citeIndex ??= loadIndex();
  return globalForIndex.citeIndex;
}

/** Chunk ids ranked by BM25 keyword relevance. */
export function keywordRanking(index: HandbookIndex, query: string, limit = CANDIDATES): string[] {
  return index.keyword
    .search(query)
    .slice(0, limit)
    .map((r) => r.id as string);
}

/** Chunk ids ranked by cosine similarity to the query's embedding. */
export function semanticRanking(index: HandbookIndex, queryVector: Float32Array, limit = CANDIDATES): string[] {
  return index.chunks
    .map((chunk, i) => ({ id: chunk.id, similarity: dot(queryVector, index.vectors[i]) }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, limit)
    .map((r) => r.id);
}

/** Hybrid search: run both retrievers, fuse their rankings with RRF, return the top chunks. */
export async function search(index: HandbookIndex, query: string, limit = TOP_K): Promise<SearchHit[]> {
  const keyword = keywordRanking(index, query);
  const semantic = semanticRanking(index, await embed(query));
  const rankOf = (list: string[], id: string) => (list.includes(id) ? list.indexOf(id) + 1 : null);

  return reciprocalRankFusion([keyword, semantic])
    .slice(0, limit)
    .map(({ id, score }) => ({
      chunk: index.byId.get(id)!,
      score,
      keywordRank: rankOf(keyword, id),
      semanticRank: rankOf(semantic, id),
    }));
}
