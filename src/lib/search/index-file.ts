import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Chunk } from "../chunk";

/**
 * The search index on disk (committed to the repo, rebuilt by `npm run ingest`):
 *   data/index/chunks.json  — metadata + every chunk
 *   data/index/vectors.bin  — one embedding per chunk, same order, as raw little-endian float32
 */
export const INDEX_DIR = path.join(process.cwd(), "data", "index");

export interface IndexMeta {
  version: 1;
  source: { file: string; sha256: string; pageCount: number };
  embedding: { model: string; dim: number };
}

export interface IndexFile extends IndexMeta {
  chunks: Chunk[];
}

export async function writeIndex(meta: IndexMeta, chunks: Chunk[], vectors: Float32Array[], dir = INDEX_DIR) {
  await mkdir(dir, { recursive: true });
  const file: IndexFile = { ...meta, chunks };
  await writeFile(path.join(dir, "chunks.json"), JSON.stringify(file));

  const packed = new Float32Array(vectors.length * meta.embedding.dim);
  vectors.forEach((v, i) => packed.set(v, i * meta.embedding.dim));
  await writeFile(path.join(dir, "vectors.bin"), new Uint8Array(packed.buffer));
}

export async function readIndex(dir = INDEX_DIR): Promise<{ file: IndexFile; vectors: Float32Array[] }> {
  const file = JSON.parse(await readFile(path.join(dir, "chunks.json"), "utf8")) as IndexFile;
  const bytes = await readFile(path.join(dir, "vectors.bin"));
  // Copy into a fresh buffer: a Float32Array view needs a 4-byte-aligned offset.
  const packed = new Float32Array(new Uint8Array(bytes).buffer);
  const { dim } = file.embedding;

  if (packed.length !== file.chunks.length * dim) {
    throw new Error(`Index mismatch: ${file.chunks.length} chunks but ${packed.length / dim} vectors. Run \`npm run ingest\`.`);
  }
  const vectors = file.chunks.map((_, i) => packed.subarray(i * dim, (i + 1) * dim));
  return { file, vectors };
}
