/**
 * Reciprocal Rank Fusion: merge several rankings of the same items into one.
 *
 * Each item scores Σ weight / (k + rank) over the rankings it appears in (rank starts at 1).
 * Only positions matter, never the retrievers' raw scores — so BM25 scores (0 to ~30) and
 * cosine similarities (-1 to 1) can be combined without rescaling.
 * k = 60 is the value from the original RRF paper; it stops the very top ranks from
 * dominating, so an item ranked well by *both* retrievers beats one ranked #1 by only one.
 */
export const RRF_K = 60;

export interface Fused {
  id: string;
  score: number;
}

export interface Ranking {
  ids: string[];
  weight?: number; // default 1
}

export function reciprocalRankFusion(rankings: Ranking[], k: number = RRF_K): Fused[] {
  const scores = new Map<string, number>();
  for (const { ids, weight = 1 } of rankings) {
    ids.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + weight / (k + index + 1));
    });
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
