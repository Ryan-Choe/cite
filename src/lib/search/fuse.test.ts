import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./fuse";

describe("reciprocalRankFusion", () => {
  it("scores each item by 1 / (k + rank), summed over the rankings it appears in", () => {
    const fused = reciprocalRankFusion([["a", "b"], ["b"]], 60);
    expect(fused).toEqual([
      { id: "b", score: 1 / 62 + 1 / 61 },
      { id: "a", score: 1 / 61 },
    ]);
  });

  it("ranks an item found by both retrievers above one ranked first by only one", () => {
    const keyword = ["exact-term-match", "both", "x", "y"];
    const semantic = ["paraphrase", "both", "z", "w"];
    const [top] = reciprocalRankFusion([keyword, semantic]);
    expect(top.id).toBe("both");
  });

  it("breaks ties deterministically by id", () => {
    const fused = reciprocalRankFusion([["b"], ["a"]]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("handles empty rankings", () => {
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });
});
