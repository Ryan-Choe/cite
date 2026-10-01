import type { PdfLine, Section } from "./types";

/**
 * Layout constants measured from this PDF (see docs/DESIGN.md). Font sizes:
 * 22 = section title, 15 = h2, 12.5 = h3, 11 = body, 10–10.1 = tables / inline code,
 * 8.5 = source path, 8 = print header/footer. Line gaps: ~16 = wrapped line, ~27 = new paragraph.
 */
const TITLE_MIN_SIZE = 20;
const HEADING_MIN_SIZE = 12;
const H2_MIN_SIZE = 14;
const PARAGRAPH_GAP = 20; // a bigger vertical gap than this starts a new paragraph
const SAME_LINE_TOLERANCE = 3; // items whose baselines differ by less than this share a line
const CELL_GAP = 12; // a horizontal gap wider than this separates table cells
const BODY_LEFT = 50; // x of an unindented body line
const LIST_INDENT = 30; // x step per list nesting level
const MARGIN_TOLERANCE = 20; // callout boxes have padding, so their usable width is a bit narrower

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
export function wrapsOnto(prev: PdfLine, next: PdfLine, rightMargin: number): boolean {
  const firstWord = next.text.split(" ")[0];
  const charWidth = (next.right - next.x) / Math.max(next.text.length, 1);
  const needed = charWidth * (firstWord.length + 1); // +1 for the space
  return prev.right + needed > rightMargin - MARGIN_TOLERANCE;
}

/** Join a wrapped line onto the text before it. A trailing "word-" joins without a space. */
export function joinWrapped(before: string, after: string): string {
  return /[A-Za-z0-9]-$/.test(before) ? before + after : `${before} ${after}`;
}

export function listLevelOf(line: PdfLine): number {
  if (line.x >= BODY_LEFT + LIST_INDENT * 0.8) return Math.round((line.x - BODY_LEFT) / LIST_INDENT);
  return NUMBERED_RE.test(line.text) ? 1 : 0;
}

/**
 * Turn the lines of the whole PDF into sections of headings and paragraphs.
 * Lines before the first section (e.g. the document title) are dropped.
 */
export function parseSections(lines: PdfLine[]): Section[] {
  const content = lines.filter((line) => !isPageChrome(line));
  const rightMargin = Math.max(...content.filter((l) => l.size < HEADING_MIN_SIZE).map((l) => l.right));

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
        const wrapsParagraph =
          last?.kind === "paragraph" &&
          blockStart !== null &&
          prev !== null &&
          prev.size < HEADING_MIN_SIZE &&
          !NUMBERED_RE.test(line.text) &&
          wrapsOnto(prev, line, rightMargin) &&
          line.x >= blockStart.x - 3 &&
          // Across a page break there's no gap to measure, so also require an unfinished sentence.
          (gap === null ? !/[.!?:]["')]?$/.test(prev.text) : gap < PARAGRAPH_GAP);

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
