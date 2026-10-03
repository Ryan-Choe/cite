import type { PdfLine, Section } from "./types";

/**
 * Layout constants measured from this PDF (see docs/DESIGN.md). Font sizes:
 * 22 = section title, 15 = h2, 12.5 = h3, 11 = body, 10–10.1 = tables / inline code,
 * 8.5 = source path, 8 = print header/footer. Line gaps: ~16 = wrapped line, ~27 = new paragraph.
 */
const TITLE_MIN_SIZE = 20;
const HEADING_MIN_SIZE = 12;
const H2_MIN_SIZE = 14;
const BODY_MIN_SIZE = 10.5; // smaller text is code or a table
const PARAGRAPH_GAP = 20; // a bigger vertical gap than this starts a new paragraph
const SAME_LINE_TOLERANCE = 3; // items whose baselines differ by less than this share a line
const CELL_GAP = 12; // a horizontal gap wider than this separates table cells
const BODY_LEFT = 50; // x of an unindented body line
const LIST_INDENT = 30; // x step per list nesting level
const MARGIN_TOLERANCE = 20; // a line counts as full if it ends within this of the page margin
// Callout boxes are padded, so text in them wraps ~30pt before the page margin (see wrapMargins).
const WRAP_MIN_LINES = 20; // body lines needed at an indentation to measure its margin
const WRAP_NARROWER_BY = 10; // how much narrower than the page an indentation must wrap to count
const MEASURED_TOLERANCE = 10; // a measured margin is the box's own edge, so it needs less slack

const HEADER_RE = /^\d{1,2}\/\d{1,2}\/\d{2}, \d{1,2}:\d{2} [AP]M PostHog handbook$/;
const FOOTER_RE = /^file:\/\/\/\S+ \d+\/\d+$/;
const PATH_RE = /^contents\/handbook\/\S+\.md$/;
const NUMBERED_RE = /^\d+[.)]\s/;

/** The subset of a pdf.js TextItem that we use. */
export interface TextItem {
  str: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY(=font size), x, y]
  width: number;
}

/** Group pdf.js text items into visual lines, top to bottom, left to right. */
export function itemsToLines(items: TextItem[], page: number): PdfLine[] {
  const visible = items
    .filter((it) => it.str.trim() !== "")
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], size: it.transform[3], width: it.width }))
    .sort((a, b) => b.y - a.y || a.x - b.x);

  const clusters: (typeof visible)[] = [];
  for (const item of visible) {
    const current = clusters.at(-1);
    if (current && Math.abs(current[0].y - item.y) <= SAME_LINE_TOLERANCE) current.push(item);
    else clusters.push([item]);
  }

  return clusters.map((cluster) => {
    cluster.sort((a, b) => a.x - b.x);
    let text = "";
    let prevRight: number | null = null;
    for (const item of cluster) {
      if (prevRight !== null) {
        const gap = item.x - prevRight;
        if (gap > CELL_GAP) text = text.trimEnd() + " | ";
        else if (gap > 1 && !/\s$/.test(text) && !/^\s/.test(item.str)) text += " ";
      }
      text += item.str;
      prevRight = item.x + item.width;
    }
    return {
      page,
      y: cluster[0].y,
      x: cluster[0].x,
      right: Math.max(...cluster.map((it) => it.x + it.width)),
      size: Math.min(...cluster.map((it) => it.size)),
      text: normalizeText(text),
    };
  });
}

export function normalizeText(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function isPageChrome(line: PdfLine): boolean {
  // itemsToLines may have inserted a " | " cell separator between the chrome's parts.
  const text = line.text.replace(/ \| /g, " ");
  return HEADER_RE.test(text) || FOOTER_RE.test(text);
}

/**
 * Did `prev` wrap onto `next`? The browser that printed this PDF moved a word to the next
 * line only when it didn't fit, so: if next's first word would have fit at the end of prev,
 * the line break was deliberate (e.g. a new list item) and next starts a new block.
 */
export function wrapsOnto(prev: PdfLine, next: PdfLine, rightMargin: number, tolerance = MARGIN_TOLERANCE): boolean {
  const firstWord = next.text.split(" ")[0];
  const charWidth = (next.right - next.x) / Math.max(next.text.length, 1);
  const needed = charWidth * (firstWord.length + 1); // +1 for the space
  return prev.right + needed > rightMargin - tolerance;
}

/** Join a wrapped line onto the text before it. A trailing "word-" joins without a space. */
export function joinWrapped(before: string, after: string): string {
  return /[A-Za-z0-9]-$/.test(before) ? before + after : `${before} ${after}`;
}

/**
 * Across a page break there's no gap to measure, so a line continues the paragraph above only if
 * that paragraph's sentence is unfinished. Bulleted items rarely end with a full stop, so for them
 * also require the line to start mid-sentence: a capital, a URL or a code name starts a new item.
 * (A numbered item's next sibling starts with its own number, which is checked separately.)
 */
export function continuesAcrossPages(prev: PdfLine, next: PdfLine, bulletItem: boolean): boolean {
  if (/[.!?:]["')]?$/.test(prev.text)) return false;
  return !bulletItem || !/^(?:\p{Lu}|https?:\/\/|\S*_)/u.test(next.text);
}

export function listLevelOf(line: PdfLine): number {
  if (line.x >= BODY_LEFT + LIST_INDENT * 0.8) return Math.round((line.x - BODY_LEFT) / LIST_INDENT);
  return NUMBERED_RE.test(line.text) ? 1 : 0;
}

/**
 * The right margin that text at each indentation wraps at. Most text wraps at the page margin, but
 * text in a callout box wraps ~30pt earlier, and measured against the page margin its wrapped lines
 * look like deliberate line breaks. So measure each indentation's margin (the 99th percentile of its
 * body lines' right edges), and use it where there's enough text to tell and it's clearly narrower.
 */
export function wrapMargins(lines: PdfLine[]): (line: PdfLine) => { right: number; tolerance: number } {
  const rightsByIndent = new Map<number, number[]>();
  let pageMargin = 0;
  for (const line of lines) {
    if (line.size >= HEADING_MIN_SIZE) continue;
    pageMargin = Math.max(pageMargin, line.right);
    // A numbered item's x depends on how wide its number is ("12." sits near a callout's x), not on a box.
    if (line.size < BODY_MIN_SIZE || NUMBERED_RE.test(line.text)) continue;
    const rights = rightsByIndent.get(Math.round(line.x)) ?? [];
    rights.push(line.right);
    rightsByIndent.set(Math.round(line.x), rights);
  }

  const narrower = new Map<number, number>();
  for (const [indent, rights] of rightsByIndent) {
    if (rights.length < WRAP_MIN_LINES) continue;
    rights.sort((a, b) => a - b);
    const margin = rights[Math.floor((rights.length - 1) * 0.99)];
    if (margin <= pageMargin - WRAP_NARROWER_BY) narrower.set(indent, margin);
  }
  const page = { right: pageMargin, tolerance: MARGIN_TOLERANCE };
  return (line) => {
    const measured = NUMBERED_RE.test(line.text) ? undefined : narrower.get(Math.round(line.x));
    return measured === undefined ? page : { right: measured, tolerance: MEASURED_TOLERANCE };
  };
}

/**
 * Turn the lines of the whole PDF into sections of headings and paragraphs.
 * Lines before the first section (e.g. the document title) are dropped.
 */
export function parseSections(lines: PdfLine[]): Section[] {
  const content = lines.filter((line) => !isPageChrome(line));
  const marginAt = wrapMargins(content);

  const sections: Section[] = [];
  let section: Section | null = null;
  let titleLines: PdfLine[] = [];
  let prev: PdfLine | null = null; // previous content line
  let blockStart: PdfLine | null = null; // first line of the open paragraph

  for (const line of content) {
    const gap = prev && prev.page === line.page ? prev.y - line.y : null;

    if (line.size >= TITLE_MIN_SIZE) {
      // Section titles can wrap; a large gap means an unrelated title (e.g. the document title).
      const continuesTitle = titleLines.length > 0 && gap !== null && gap < 35;
      titleLines = continuesTitle ? [...titleLines, line] : [line];
      blockStart = null;
    } else if (PATH_RE.test(line.text) && titleLines.length > 0) {
      section = {
        title: titleLines.map((l) => l.text).join(" "),
        path: line.text,
        startPage: titleLines[0].page,
        endPage: line.page,
        blocks: [],
      };
      sections.push(section);
      titleLines = [];
      blockStart = null;
    } else if (section) {
      if (titleLines.length > 0) {
        // Title-size text with no source path after it is a top-level heading inside this section,
        // unless it only repeats the section's title.
        const text = titleLines.map((l) => l.text).join(" ");
        if (text.toLowerCase() !== section.title.toLowerCase()) {
          section.blocks.push({ kind: "heading", level: 1, listLevel: 0, text, page: titleLines[0].page });
        }
        titleLines = [];
      }
      section.endPage = line.page;
      const last = section.blocks.at(-1);

      if (line.size >= HEADING_MIN_SIZE) {
        const level = line.size >= H2_MIN_SIZE ? 2 : 3;
        const wrapsHeading =
          last?.kind === "heading" && last.level === level && prev?.size === line.size && gap !== null && gap < 25;
        if (wrapsHeading) last.text = joinWrapped(last.text, line.text);
        else section.blocks.push({ kind: "heading", level, listLevel: 0, text: line.text, page: line.page });
        blockStart = null;
      } else {
        const margin = prev && marginAt(prev);
        const wrapsParagraph =
          last?.kind === "paragraph" &&
          blockStart !== null &&
          prev !== null &&
          prev.size < HEADING_MIN_SIZE &&
          !NUMBERED_RE.test(line.text) &&
          margin !== null &&
          wrapsOnto(prev, line, margin.right, margin.tolerance) &&
          line.x >= blockStart.x - 3 &&
          (gap === null ? continuesAcrossPages(prev, line, last.listLevel > 0 && !NUMBERED_RE.test(last.text)) : gap < PARAGRAPH_GAP);

        if (wrapsParagraph && gap !== null) {
          last.text = joinWrapped(last.text, line.text);
        } else if (wrapsParagraph) {
          // Same paragraph, but it crossed onto a new page: start a new block for this page.
          section.blocks.push({ ...last, text: line.text, page: line.page, continued: true });
        } else {
          section.blocks.push({ kind: "paragraph", listLevel: listLevelOf(line), text: line.text, page: line.page });
          blockStart = line;
        }
      }
    }
    prev = line;
  }
  return sections;
}
