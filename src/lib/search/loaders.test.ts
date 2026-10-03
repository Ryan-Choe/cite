import { pipeline } from "@huggingface/transformers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMBEDDING, embedQuery } from "./embed";
import { readIndex } from "./index-file";
import { getIndex } from "./search";

// Loading is mocked: these tests are about what happens after a load fails, not about loading.
vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline: vi.fn() }));
vi.mock("./index-file", () => ({ readIndex: vi.fn(), warnIfStale: vi.fn(async () => {}) }));

const cache = globalThis as unknown as { citeIndexByModel?: unknown; citeEmbedderByModel?: unknown };

beforeEach(() => {
  delete cache.citeIndexByModel;
  delete cache.citeEmbedderByModel;
  vi.resetAllMocks();
});

describe("getIndex", () => {
  const emptyIndex = {
    file: { version: 2 as const, source: { file: "x.pdf", sha256: "", pageCount: 1 }, embedding: EMBEDDING, vectorsSha256: "", chunks: [] },
    vectors: [],
  };

  it("tries again after a failed load, instead of failing until a restart", async () => {
    vi.mocked(readIndex).mockRejectedValueOnce(new Error("ENOENT")).mockResolvedValueOnce(emptyIndex);
    await expect(getIndex()).rejects.toThrow("ENOENT");
    await expect(getIndex()).resolves.toMatchObject({ chunks: [] });
  });

  it("loads once and shares the result", async () => {
    vi.mocked(readIndex).mockResolvedValue(emptyIndex);
    expect(getIndex()).toBe(getIndex());
    await getIndex();
    expect(readIndex).toHaveBeenCalledTimes(1);
  });

  it("checks the index against the model search uses", async () => {
    vi.mocked(readIndex).mockResolvedValue(emptyIndex);
    await getIndex();
    expect(readIndex).toHaveBeenCalledWith(EMBEDDING, undefined);
  });

  it("loads again after a hot reload switched models, instead of keeping the old index", async () => {
    vi.mocked(readIndex).mockResolvedValue(emptyIndex);
    cache.citeIndexByModel = { key: "Xenova/all-MiniLM-L6-v2@fp32", loading: Promise.resolve("old index") };
    await expect(getIndex()).resolves.toMatchObject({ chunks: [] });
  });
});

describe("embedQuery", () => {
  const embedder = async () => ({ data: new Float32Array([1, 0]) });

  it("tries loading the model again after a failed download", async () => {
    vi.mocked(pipeline)
      .mockReturnValueOnce(Promise.reject(new TypeError("fetch failed")) as never)
      .mockReturnValueOnce(Promise.resolve(embedder) as never);
    await expect(embedQuery("laptop")).rejects.toThrow("fetch failed");
    await expect(embedQuery("laptop")).resolves.toEqual(new Float32Array([1, 0]));
    await embedQuery("monitor");
    expect(pipeline).toHaveBeenCalledTimes(2); // the successful load is kept
  });

  it("loads the model the index was built with, and prefixes questions as it was trained", async () => {
    const calls: string[] = [];
    vi.mocked(pipeline).mockReturnValue(Promise.resolve(async (text: string) => (calls.push(text), { data: new Float32Array([1, 0]) })) as never);
    await embedQuery("parking at hogpatch?");
    expect(pipeline).toHaveBeenCalledWith("feature-extraction", EMBEDDING.model, { dtype: EMBEDDING.dtype });
    expect(calls).toEqual(["Represent this sentence for searching relevant passages: parking at hogpatch?"]);
  });
});
