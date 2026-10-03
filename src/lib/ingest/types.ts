/** One visual line of text on a PDF page, rebuilt from pdf.js text items. */
export interface PdfLine {
  page: number; // 1-based page number
  y: number; // baseline, in PDF points from the bottom of the page
  x: number; // left edge
  right: number; // right edge
  size: number; // font size; for mixed lines, the smallest size used
  text: string;
}

export type BlockKind = "heading" | "paragraph";

/**
 * A structural unit inside a section: a sub-heading, a paragraph, or a list item.
 * A paragraph that runs across a page break is split into one block per page
 * (the second one has `continued: true`), so every block lives on exactly one page.
 */
export interface Block {
  kind: BlockKind;
  /** For headings: 1 (a title-size heading inside a section), 2 (h2) or 3 (h3). Omitted for paragraphs. */
  level?: 1 | 2 | 3;
  /** List nesting depth: 0 = normal paragraph, 1 = bullet, 2 = nested bullet. */
  listLevel: number;
  text: string;
  page: number;
  /** True if this block continues the previous block's paragraph from the prior page. */
  continued?: boolean;
}

/** A handbook section: one source markdown file, e.g. contents/handbook/people/time-off.md */
export interface Section {
  title: string;
  path: string;
  startPage: number;
  endPage: number;
  blocks: Block[];
}
