import type { Block, Section } from "./ingest/types";

/** The part of a chunk's text that sits on one PDF page. */
export interface ChunkPage {
  page: number;
  text: string;
}

/**
 * A retrievable piece of a section: at most ~maxChars of body text, never spanning two
 * sub-headings. Body text is kept per page so a citation can point at the exact page.
 */
export interface Chunk {
  /** `${sectionPath}#${index}`, where index counts from 0 within the section. */
  id: string;
  sectionTitle: string;
  sectionPath: string;
  /** Sub-headings this chunk sits under, outermost first, e.g. ["Permissionless time off", "How to book time off"]. */
  headings: string[];
  /** [sectionTitle, ...headings] joined with " › " — prefixed to the text for search. */
  title: string;
  /** Body text grouped by page, in page order, one entry per page. Headings are not repeated here. */
  pages: ChunkPage[];
}

export const MAX_CHUNK_CHARS = 1000;

/**
 * Render one paragraph block as a line of text. List items get a "- " bullet, indented two
 * spaces per extra nesting level; numbered items keep their number instead of a bullet.
 */
export function renderBlock(block: Block): string {
  if (block.listLevel === 0) return block.text;
  const indent = "  ".repeat(block.listLevel - 1);
  return /^\d+[.)]\s/.test(block.text) ? indent + block.text : `${indent}- ${block.text}`;
}

/** A chunk's body text: its pages' text joined with newlines. Its length is what maxChars limits. */
export function bodyText(chunk: Pick<Chunk, "pages">): string {
  return chunk.pages.map((p) => p.text).join("\n");
}

/** The full text used for search: title line, blank line, body. */
export function searchText(chunk: Chunk): string {
  return `${chunk.title}\n\n${bodyText(chunk)}`;
}

/**
 * Split a section into chunks. ★ Ryan's to implement — the rules are the tests in chunk.test.ts.
 *
 *   1. Walk the blocks in order, packing paragraphs into the current chunk.
 *   2. A heading always closes the current chunk; the next chunk sits under the updated headings.
 *      An h2 replaces the heading trail; an h3 goes under the latest h2.
 *   3. Start a new chunk when adding the next paragraph would push bodyText past maxChars.
 *   4. A single paragraph longer than maxChars is split at sentence ends (or, failing that,
 *      at the last space) into pieces of at most maxChars.
 *   5. Paragraphs on the same page are joined with "\n" inside that page's ChunkPage.
 *   6. Chunks with no body text are dropped.
 */
export function chunkSection(section: Section, maxChars: number = MAX_CHUNK_CHARS): Chunk[] {
  void section;
  void maxChars;
  throw new Error("TODO(Ryan): implement chunkSection — see the rules above and chunk.test.ts");
}
