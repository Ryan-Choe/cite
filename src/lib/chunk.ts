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
 * spaces per extra nesting level; numbered items keep their number instead of a bullet. The rest
 * of a list item continued from the previous page gets no bullet: it lines up with the item's text.
 */
export function renderBlock(block: Block): string {
  if (block.listLevel === 0) return block.text;
  const indent = "  ".repeat(block.listLevel - 1);
  if (block.continued) return `${indent}  ${block.text}`;
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
 * Split a section into chunks:
 *
 *   1. Walk the blocks in order, packing paragraphs into the current chunk.
 *   2. A heading always closes the current chunk; the next chunk sits under the updated headings.
 *      A level-1 heading replaces the heading trail; an h2 goes under the latest level-1 heading,
 *      and an h3 under the latest of both.
 *   3. Start a new chunk when adding the next paragraph would push bodyText past maxChars.
 *   4. A single paragraph longer than maxChars is first split into pieces (see splitLongText).
 *   5. Paragraphs on the same page are joined with "\n" inside that page's ChunkPage.
 *   6. Chunks with no body text are dropped.
 */
export function chunkSection(section: Section, maxChars: number = MAX_CHUNK_CHARS): Chunk[] {
  const chunks: Chunk[] = []; // finished chunks
  let headings: string[] = []; // heading trail the current chunk sits under
  let currentH1: string | undefined; // the latest level-1 heading, so an h2 knows what it sits under
  let currentH2: string | undefined; // the latest h2, so an h3 knows what it sits under
  let pages: ChunkPage[] = []; // the current chunk's body, still being filled

  // Close the current chunk: save it if it has any body text, then start an empty one.
  function flush() {
    if (pages.length > 0) {
      chunks.push({
        id: `${section.path}#${chunks.length}`,
        sectionTitle: section.title,
        sectionPath: section.path,
        headings,
        title: [section.title, ...headings].join(" › "),
        pages,
      });
    }
    pages = [];
  }

  // Add one piece of text (at most maxChars long), closing the current chunk first if it would overflow.
  function add(text: string, page: number) {
    const lengthIfAdded = pages.length === 0 ? text.length : bodyText({ pages }).length + 1 + text.length; // +1 for the "\n"
    if (lengthIfAdded > maxChars) flush();

    const last = pages.at(-1);
    if (last && last.page === page) last.text += "\n" + text;
    else pages.push({ page, text });
  }

  for (const block of section.blocks) {
    if (block.kind === "heading") {
      flush();
      // Replace the trail rather than editing it in place: chunks already saved keep their own array.
      if (block.level === 1) {
        currentH1 = block.text;
        currentH2 = undefined;
        headings = [block.text];
      } else if (block.level === 2) {
        currentH2 = block.text;
        headings = currentH1 ? [currentH1, block.text] : [block.text];
      } else {
        headings = [currentH1, currentH2, block.text].filter((h) => h !== undefined);
      }
    } else {
      for (const piece of splitLongText(renderBlock(block), maxChars)) add(piece, block.page);
    }
  }

  flush(); // the last chunk is still open when the loop ends
  return chunks;
}

/**
 * Split text into pieces of at most maxChars, cutting at the last sentence end that fits,
 * else the last space, else mid-word (e.g. a giant URL). The space at each cut is dropped.
 */
export function splitLongText(text: string, maxChars: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const cut = lastBreak(rest, maxChars);
    pieces.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) pieces.push(rest);
  return pieces;
}

/** Where to cut `text` so the first piece is at most maxChars long. */
function lastBreak(text: string, maxChars: number): number {
  const window = text.slice(0, maxChars + 1); // +1: a space exactly at the limit is still a valid cut
  const sentenceEnd = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (sentenceEnd > 0) return sentenceEnd + 1; // cut just after the punctuation
  const space = window.lastIndexOf(" ");
  if (space > 0) return space;
  return maxChars;
}
