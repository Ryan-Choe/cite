import { describe, expect, it } from "vitest";
import { reciprocalRankFusion } from "./fuse";

describe("reciprocalRankFusion", () => {
  it("scores each item by 1 / (k + rank), summed over the rankings it appears in", () => {
    const fused = reciprocalRankFusion([{ ids: ["a", "b"] }, { ids: ["b"] }], 60);
    expect(fused).toEqual([
      { id: "b", score: 1 / 62 + 1 / 61 },
      { id: "a", score: 1 / 61 },
    ]);
  });

  it("ranks an item found by both retrievers above one ranked first by only one", () => {
    const keyword = { ids: ["exact-term-match", "both", "x", "y"] };
    const semantic = { ids: ["paraphrase", "both", "z", "w"] };
    const [top] = reciprocalRankFusion([keyword, semantic]);
    expect(top.id).toBe("both");
  });

  it("scales each ranking's contribution by its weight", () => {
    const fused = reciprocalRankFusion([
      { ids: ["keyword-top"], weight: 0.5 },
      { ids: ["semantic-top"], weight: 1 },
    ]);
    expect(fused.map((f) => f.id)).toEqual(["semantic-top", "keyword-top"]);
    expect(fused[1].score).toBeCloseTo(0.5 / 61);
  });

  it("breaks ties deterministically by id", () => {
    const fused = reciprocalRankFusion([{ ids: ["b"] }, { ids: ["a"] }]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("handles empty rankings", () => {
    expect(reciprocalRankFusion([{ ids: [] }, { ids: [] }])).toEqual([]);
  });
});
