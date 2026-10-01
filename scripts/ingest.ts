/**
 * npm run ingest — PDF → sections → chunks → data/index/chunks.json
 *
 * Also writes human-readable previews to .cache/ (git-ignored) for eyeballing the results.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { bodyText, chunkSection, renderBlock, type Chunk } from "../src/lib/chunk";
import { readSections } from "../src/lib/ingest/extract";
import type { Section } from "../src/lib/ingest/types";

const PDF_PATH = "public/handbook.pdf";
const INDEX_DIR = "data/index";
const PREVIEW_DIR = ".cache";

export interface ChunkIndex {
  version: 1;
  source: { file: string; sha256: string; pageCount: number };
  chunks: Chunk[];
}

async function main() {
  const started = Date.now();
  const sha256 = createHash("sha256").update(await readFile(PDF_PATH)).digest("hex");

  const { sections, pageCount } = await readSections(PDF_PATH);
  console.log(`Parsed ${pageCount} pages into ${sections.length} sections (${Date.now() - started} ms)`);
  await writePreview("sections-preview.md", sections.map(formatSection).join("\n\n"));

  let chunks: Chunk[];
  try {
    chunks = sections.flatMap((s) => chunkSection(s));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("TODO")) {
      console.log(`\nStopping here: ${error.message}`);
      console.log(`Look at ${PREVIEW_DIR}/sections-preview.md to see the blocks your chunker will receive.`);
      return;
    }
    throw error;
  }

  const index: ChunkIndex = { version: 1, source: { file: PDF_PATH, sha256, pageCount }, chunks };
  await mkdir(INDEX_DIR, { recursive: true });
  await writeFile(path.join(INDEX_DIR, "chunks.json"), JSON.stringify(index));
  await writePreview("chunks-preview.md", chunks.map(formatChunk).join("\n\n"));

  printChunkStats(chunks, sections.length);
  console.log(`\nWrote ${INDEX_DIR}/chunks.json (${Date.now() - started} ms)`);
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
