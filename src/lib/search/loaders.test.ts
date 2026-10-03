import { pipeline } from "@huggingface/transformers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { embed } from "./embed";
import { readIndex } from "./index-file";
import { getIndex } from "./search";

// Loading is mocked: these tests are about what happens after a load fails, not about loading.
vi.mock("@huggingface/transformers", () => ({ env: {}, pipeline: vi.fn() }));
vi.mock("./index-file", () => ({ readIndex: vi.fn(), warnIfStale: vi.fn(async () => {}) }));

const cache = globalThis as unknown as { citeIndex?: unknown; citeEmbedder?: unknown };

beforeEach(() => {
  delete cache.citeIndex;
  delete cache.citeEmbedder;
  vi.resetAllMocks();
});

describe("getIndex", () => {
  const emptyIndex = {
    file: { version: 1 as const, source: { file: "x.pdf", sha256: "", pageCount: 1 }, embedding: { model: "m", dim: 2 }, chunks: [] },
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
});

describe("embed", () => {
  const embedder = async () => ({ data: new Float32Array([1, 0]) });

  it("tries loading the model again after a failed download", async () => {
    vi.mocked(pipeline)
      .mockReturnValueOnce(Promise.reject(new TypeError("fetch failed")) as never)
      .mockReturnValueOnce(Promise.resolve(embedder) as never);
    await expect(embed("laptop")).rejects.toThrow("fetch failed");
    await expect(embed("laptop")).resolves.toEqual(new Float32Array([1, 0]));
    await embed("monitor");
    expect(pipeline).toHaveBeenCalledTimes(2); // the successful load is kept
  });
});
