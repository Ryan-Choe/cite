import { pipeline } from "@huggingface/transformers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chunk } from "../chunk";
import { buildKeywordIndex } from "./keyword";
import { search, type HandbookIndex } from "./search";

// Every question embeds to [1, 0], so a chunk's similarity is the first number of its vector.
vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline: vi.fn() }));

function chunk(id: string, text: string): Chunk {
  return { id, sectionTitle: "Handbook", sectionPath: `contents/handbook/${id}.md`, headings: [], title: "Handbook", pages: [{ page: 1, text }] };
}

// Most to least similar: a, b, c, d. Only d mentions the Hedgehouse.
const chunks = [
  chunk("a", "Book time off in Deel."),
  chunk("b", "Offsites happen once a year."),
  chunk("c", "Team leads plan onboarding."),
  chunk("d", "New starters can be onboarded at the Hedgehouse."),
];
const vectors = [[1, 0], [0.8, 0.6], [0.6, 0.8], [0, 1]].map((v) => new Float32Array(v));
const index: HandbookIndex = {
  source: { file: "handbook.pdf", sha256: "", pageCount: 1 },
  chunks,
  byId: new Map(chunks.map((c) => [c.id, c])),
  vectors,
  keyword: buildKeywordIndex(chunks),
};

beforeEach(() => {
  delete (globalThis as { citeEmbedderByModel?: unknown }).citeEmbedderByModel;
  vi.mocked(pipeline).mockReturnValue(Promise.resolve(async () => ({ data: new Float32Array([1, 0]) })) as never);
});

const ids = (hits: Awaited<ReturnType<typeof search>>) => hits.map((h) => `${h.chunk.id}:${h.via}`);

describe("search", () => {
  it("returns the chunks most similar in meaning, best first", async () => {
    const hits = await search(index, "how do I book a day off?", 3);
    expect(ids(hits)).toEqual(["a:semantic", "b:semantic", "c:semantic"]);
    expect(hits.map((h) => h.similarity)).toEqual([1, expect.closeTo(0.8), expect.closeTo(0.6)]);
  });

  it("gives the last slot to the passage sharing a rare word, with its own similarity", async () => {
    const hits = await search(index, "can a new starter go to the hedgehouse?", 3);
    expect(ids(hits)).toEqual(["a:semantic", "b:semantic", "d:keyword"]);
    expect(hits[2].similarity).toBe(0);
  });

  it("changes nothing when semantic search already found that passage", async () => {
    const hits = await search(index, "can a new starter go to the hedgehouse?", 4);
    expect(ids(hits)).toEqual(["a:semantic", "b:semantic", "c:semantic", "d:semantic"]);
  });
});
