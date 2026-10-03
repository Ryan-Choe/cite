import path from "node:path";
import { env, pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/**
 * Local sentence embeddings with Snowflake's arctic-embed-s (384 dimensions, int8), run on CPU by
 * transformers.js. It is trained for retrieval, i.e. matching a question to the passage that
 * answers it, which the general-purpose MiniLM it replaced was not (see eval/SEARCH.md).
 * No API key needed: the model (~35 MB) downloads from Hugging Face on first use and is cached
 * in .cache/models (git-ignored).
 *
 * The index records which model made its vectors; changing this means running `npm run ingest`.
 */
export const EMBEDDING = {
  model: "Snowflake/snowflake-arctic-embed-s",
  dtype: "q8",
  dim: 384,
} as const;

// The model was trained with this prefix on questions and none on passages (see its model card).
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";

env.cacheDir = path.join(process.cwd(), ".cache", "models");

// Loading the model takes a few seconds, so do it once per process. Keeping the promise on
// globalThis also survives Next.js dev-mode hot reloads, which re-run this module; it is keyed by
// model, so a reload after switching models doesn't keep the old one. A failed load (e.g. the
// first-use download while offline) is forgotten, so the next question tries again.
const MODEL_KEY = `${EMBEDDING.model}@${EMBEDDING.dtype}`;
const globalForModel = globalThis as unknown as { citeEmbedderByModel?: { key: string; loading: Promise<FeatureExtractionPipeline> } };

function getEmbedder(): Promise<FeatureExtractionPipeline> {
  const cached = globalForModel.citeEmbedderByModel;
  if (cached?.key === MODEL_KEY) return cached.loading;
  const entry = { key: MODEL_KEY, loading: pipeline("feature-extraction", EMBEDDING.model, { dtype: EMBEDDING.dtype }) };
  globalForModel.citeEmbedderByModel = entry;
  entry.loading.catch(() => {
    if (globalForModel.citeEmbedderByModel === entry) globalForModel.citeEmbedderByModel = undefined;
  });
  return entry.loading;
}

/**
 * Embed a question for search, as a unit-length vector. Because vectors are normalized, the dot
 * product of a question and a passage vector is their cosine similarity (1 = same meaning).
 */
export function embedQuery(question: string): Promise<Float32Array> {
  return embedText(QUERY_PREFIX + question);
}

/** Embed a passage for the index (no prefix), as a unit-length vector. */
export function embedPassage(text: string): Promise<Float32Array> {
  return embedText(text);
}

async function embedText(text: string): Promise<Float32Array> {
  const embedder = await getEmbedder();
  const output = await embedder(text, { pooling: "cls", normalize: true }); // arctic-embed uses the [CLS] token
  return output.data as Float32Array;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}
