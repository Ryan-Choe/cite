import { createHash } from "node:crypto";
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
  version: 2;
  source: { file: string; sha256: string; pageCount: number };
  /** The model that made the vectors. Questions must be embedded with the same one. */
  embedding: { model: string; dtype: string; dim: number };
}

export interface IndexFile extends IndexMeta {
  /** sha256 of vectors.bin, so a vectors file from a different or interrupted ingest is caught on load. */
  vectorsSha256: string;
  chunks: Chunk[];
}

export async function writeIndex(meta: IndexMeta, chunks: Chunk[], vectors: Float32Array[], dir = INDEX_DIR) {
  await mkdir(dir, { recursive: true });
  const packed = new Float32Array(vectors.length * meta.embedding.dim);
  vectors.forEach((v, i) => packed.set(v, i * meta.embedding.dim));
  const bytes = new Uint8Array(packed.buffer);

  const file: IndexFile = { ...meta, vectorsSha256: sha256(bytes), chunks };
  await writeFile(path.join(dir, "vectors.bin"), bytes);
  await writeFile(path.join(dir, "chunks.json"), JSON.stringify(file));
}

/**
 * Read the index, refusing one that search can't use correctly: built by an older version of Cite,
 * built with a different embedding model than `expected` (its vectors would be compared with
 * question vectors from another model, and every result would be noise), or with a vectors file
 * that doesn't belong to its chunks.
 */
export async function readIndex(expected: IndexMeta["embedding"], dir = INDEX_DIR): Promise<{ file: IndexFile; vectors: Float32Array[] }> {
  const rebuild = "Run `npm run ingest` to rebuild it.";
  const file = JSON.parse(await readFile(path.join(dir, "chunks.json"), "utf8")) as IndexFile;
  if (file.version !== 2) throw new Error(`The search index was built by an older version of Cite. ${rebuild}`);
  const { model, dtype, dim } = file.embedding;
  if (model !== expected.model || dtype !== expected.dtype || dim !== expected.dim) {
    throw new Error(`The search index was built with ${model} (${dtype}), but search uses ${expected.model} (${expected.dtype}). ${rebuild}`);
  }

  const bytes = await readFile(path.join(dir, "vectors.bin"));
  if (sha256(bytes) !== file.vectorsSha256) {
    throw new Error(`data/index/vectors.bin doesn't match chunks.json (it's from a different or interrupted ingest). ${rebuild}`);
  }
  // Copy into a fresh buffer: a Float32Array view needs a 4-byte-aligned offset.
  const packed = new Float32Array(new Uint8Array(bytes).buffer);
  if (packed.length !== file.chunks.length * dim) {
    throw new Error(`Index mismatch: ${file.chunks.length} chunks but ${packed.length / dim} vectors. ${rebuild}`);
  }
  const vectors = file.chunks.map((_, i) => packed.subarray(i * dim, (i + 1) * dim));
  return { file, vectors };
}

/**
 * Warn if the PDF has changed since the index was built (e.g. someone dropped in a new
 * handbook without running `npm run ingest`): answers would come from the old text.
 */
export async function warnIfStale(source: IndexMeta["source"]): Promise<void> {
  try {
    if (sha256(await readFile(path.join(process.cwd(), source.file))) !== source.sha256) {
      console.warn(`[index] ${source.file} has changed since the index was built. Run \`npm run ingest\` to rebuild it.`);
    }
  } catch {
    console.warn(`[index] Couldn't read ${source.file} to check the index is up to date.`);
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
