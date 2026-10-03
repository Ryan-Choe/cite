import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Chunk } from "../chunk";
import { readIndex, writeIndex, type IndexMeta } from "./index-file";

const embedding = { model: "test/model", dtype: "q8", dim: 2 };
const meta: IndexMeta = { version: 2, source: { file: "handbook.pdf", sha256: "abc", pageCount: 1 }, embedding };
const chunks: Chunk[] = ["a", "b"].map((id) => ({ id, sectionTitle: "S", sectionPath: "s.md", headings: [], title: "S", pages: [{ page: 1, text: id }] }));
const vectors = [new Float32Array([1, 0]), new Float32Array([0, 1])];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "cite-index-"));
  await writeIndex(meta, chunks, vectors, dir);
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("readIndex", () => {
  it("reads back what writeIndex wrote", async () => {
    const { file, vectors: read } = await readIndex(embedding, dir);
    expect(file.chunks.map((c) => c.id)).toEqual(["a", "b"]);
    expect(read).toEqual(vectors);
  });

  it("refuses an index built with another embedding model, whose vectors would be noise to search", async () => {
    await expect(readIndex({ ...embedding, model: "other/model" }, dir)).rejects.toThrow(/built with test\/model.*npm run ingest/);
    await expect(readIndex({ ...embedding, dtype: "fp32" }, dir)).rejects.toThrow(/npm run ingest/);
  });

  it("refuses a vectors file that doesn't belong to its chunks", async () => {
    const other = new Float32Array([0, 1, 1, 0]); // same size, different vectors
    await writeFile(path.join(dir, "vectors.bin"), new Uint8Array(other.buffer));
    await expect(readIndex(embedding, dir)).rejects.toThrow(/doesn't match chunks.json/);
  });

  it("refuses an index from an older version of Cite", async () => {
    const file = JSON.parse(await readFile(path.join(dir, "chunks.json"), "utf8"));
    await writeFile(path.join(dir, "chunks.json"), JSON.stringify({ ...file, version: 1 }));
    await expect(readIndex(embedding, dir)).rejects.toThrow(/older version/);
  });
});
