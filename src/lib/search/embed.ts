import path from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/**
 * Local sentence embeddings with MiniLM (384 dimensions), run on CPU by transformers.js.
 * No API key needed: the ~90 MB model downloads from Hugging Face on first use and is
 * cached in .cache/models (git-ignored).
 */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIM = 384;

env.cacheDir = path.join(process.cwd(), ".cache", "models");

// Loading the model takes a few seconds, so do it once per process. Keeping the promise on
// globalThis also survives Next.js dev-mode hot reloads, which re-run this module.
const globalForModel = globalThis as unknown as { citeEmbedder?: Promise<FeatureExtractionPipeline> };

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  globalForModel.citeEmbedder ??= pipeline("feature-extraction", EMBEDDING_MODEL, { dtype: "fp32" });
  return globalForModel.citeEmbedder;
}

/**
 * Embed one text as a unit-length vector. Because vectors are normalized, the dot product of
 * two of them is their cosine similarity (1 = same meaning, ~0 = unrelated).
 */
export async function embed(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "mean", normalize: true });
  return output.data as Float32Array;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
