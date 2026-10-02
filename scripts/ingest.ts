/**
 * npm run ingest — PDF → sections → chunks → embeddings → data/index/
 *
 * Also writes human-readable previews to .cache/ (git-ignored) for eyeballing the results.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bodyText, chunkSection, renderBlock, searchText, type Chunk } from "../src/lib/chunk";
import { readSections } from "../src/lib/ingest/extract";
import type { Section } from "../src/lib/ingest/types";
import { EMBEDDING_DIM, EMBEDDING_MODEL, embed } from "../src/lib/search/embed";
import { INDEX_DIR, writeIndex } from "../src/lib/search/index-file";

const PDF_PATH = "public/handbook.pdf";
const PREVIEW_DIR = ".cache";

async function main() {
  const started = Date.now();
  const sha256 = createHash("sha256").update(await readFile(PDF_PATH)).digest("hex");

  const { sections, pageCount } = await readSections(PDF_PATH);
  console.log(`Parsed ${pageCount} pages into ${sections.length} sections (${Date.now() - started} ms)`);
  await writePreview("sections-preview.md", sections.map(formatSection).join("\n\n"));

  const chunks = sections.flatMap((s) => chunkSection(s));
  await writePreview("chunks-preview.md", chunks.map(formatChunk).join("\n\n"));
  printChunkStats(chunks, sections.length);

  // One at a time: batching pads short chunks to the longest one, which was slower in testing.
  console.log(`\nEmbedding ${chunks.length} chunks with ${EMBEDDING_MODEL}…`);
  const embedStarted = Date.now();
  const vectors: Float32Array[] = [];
  for (const chunk of chunks) {
    vectors.push(await embed(searchText(chunk)));
    if (vectors.length % 500 === 0) console.log(`  ${vectors.length}/${chunks.length}`);
  }
  console.log(`Embedded in ${((Date.now() - embedStarted) / 1000).toFixed(1)} s`);

  await writeIndex(
    { version: 1, source: { file: PDF_PATH, sha256, pageCount }, embedding: { model: EMBEDDING_MODEL, dim: EMBEDDING_DIM } },
    chunks,
    vectors,
  );
  console.log(`\nWrote ${path.relative(process.cwd(), INDEX_DIR)}/ (${((Date.now() - started) / 1000).toFixed(1)} s total)`);
}

function formatSection(section: Section): string {
  const lines = section.blocks.map((b) => {
    const text = b.kind === "heading" ? `${"#".repeat(b.level ?? 2)} ${b.text}` : renderBlock(b);
    return `[p${b.page}${b.continued ? " cont." : ""}] ${text}`;
  });
  return `# ${section.title} — ${section.path} (pp. ${section.startPage}–${section.endPage})\n${lines.join("\n")}`;
}

function formatChunk(chunk: Chunk): string {
  const pages = chunk.pages.map((p) => p.page).join(", ");
  return `=== ${chunk.id} · pp. ${pages} · ${bodyText(chunk).length} chars\n${chunk.title}\n\n${bodyText(chunk)}`;
}

function printChunkStats(chunks: Chunk[], sectionCount: number) {
  const lengths = chunks.map((c) => bodyText(c).length).sort((a, b) => a - b);
  const pct = (q: number) => lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * q))];
  const multiPage = chunks.filter((c) => c.pages.length > 1).length;
  console.log(`\n${chunks.length} chunks from ${sectionCount} sections`);
  console.log(`body length: min ${lengths[0]}, median ${pct(0.5)}, p90 ${pct(0.9)}, max ${lengths.at(-1)}`);
  console.log(`chunks spanning 2+ pages: ${multiPage}`);
}

async function writePreview(name: string, content: string) {
  await mkdir(PREVIEW_DIR, { recursive: true });
  await writeFile(path.join(PREVIEW_DIR, name), content + "\n");
  console.log(`Preview: ${PREVIEW_DIR}/${name}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
