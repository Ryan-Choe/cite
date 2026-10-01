import { describe, expect, it } from "vitest";
import { isPageChrome, itemsToLines, joinWrapped, parseSections, wrapsOnto, type TextItem } from "./layout";
import type { PdfLine } from "./types";

const item = (str: string, x: number, y: number, size = 11, width = str.length * 5.5): TextItem => ({
  str,
  transform: [size, 0, 0, size, x, y],
  width,
});

// A body line, by default as wide as a full line of this PDF (right edge 560).
const line = (text: string, y: number, opts: Partial<PdfLine> = {}): PdfLine => ({
  page: 1,
  y,
  x: 50,
  right: 560,
  size: 11,
  text,
  ...opts,
});

describe("itemsToLines", () => {
  it("groups items by baseline and orders lines top to bottom, left to right", () => {
    const lines = itemsToLines([item("world", 80, 700), item("Second", 50, 680), item("Hello", 50, 701)], 3);
    expect(lines.map((l) => l.text)).toEqual(["Hello world", "Second"]);
    expect(lines[0].page).toBe(3);
  });

  it("separates far-apart items (table cells) with a pipe", () => {
    const [row] = itemsToLines([item("Credit", 58, 500, 10, 30), item("$50,000", 175, 500, 10, 35)], 1);
    expect(row.text).toBe("Credit | $50,000");
  });

  it("normalizes ligatures and whitespace", () => {
    const [l] = itemsToLines([item("time  oﬀ", 50, 500)], 1);
    expect(l.text).toBe("time off");
  });
});

describe("isPageChrome", () => {
  it("recognizes the print header and footer, even with cell separators", () => {
    expect(isPageChrome(line("4/20/26, 4:49 PM | PostHog handbook", 770))).toBe(true);
    expect(isPageChrome(line("file:///tmp/handbook-pdf-build/handbook.html | 980/1076", 17))).toBe(true);
    expect(isPageChrome(line("We offer our team unlimited time off", 600))).toBe(false);
  });
});

describe("joinWrapped", () => {
  it("joins with a space, except after a word-hyphen", () => {
    expect(joinWrapped("take at least", "25 days")).toBe("take at least 25 days");
    expect(joinWrapped("live in .github/workflows/ (art-", "board.yml)")).toBe("live in .github/workflows/ (art-board.yml)");
    expect(joinWrapped("off -", "this means")).toBe("off - this means");
  });
});

describe("wrapsOnto", () => {
  it("is true when the next line's first word could not have fit", () => {
    const prev = line("Instead, we expect everyone to", 400, { right: 495 });
    const next = line("coordinate with their team to make sure", 384, { right: 260 });
    expect(wrapsOnto(prev, next, 562)).toBe(true);
  });

  it("is false when the next line's first word would have fit (a deliberate break)", () => {
    const prev = line("Custom visuals for paid ad campaigns", 519, { x: 80, right: 260 });
    const next = line("Blog and social media artwork", 503, { x: 80, right: 230 });
    expect(wrapsOnto(prev, next, 562)).toBe(false);
  });
});

describe("parseSections", () => {
  const pageOne: PdfLine[] = [
    line("PostHog handbook", 724, { size: 22 }), // document title: no path follows, so it's dropped
    line("Time off", 678, { size: 22 }),
    line("contents/handbook/people/time-off.md", 645, { size: 8.5, right: 200 }),
    line("We offer our team unlimited time off, but with an expectation that you take at least 25 days", 616),
    line("off a year.", 600, { right: 110 }),
    line("Permissionless time off", 560, { size: 15, right: 200 }),
    line("You should avoid things like:", 530, { right: 200 }),
    line("Having an entire Small Team off", 503, { x: 80, right: 250 }),
    line("Having the only X people who can do some totally critical task at PostHog off - if this is", 488, { x: 80 }),
    line("unavoidable, try to check in", 472, { x: 80, right: 230 }),
    line("1. Open the PTO app and book the days you want, making sure your manager can see them in the", 445, { x: 70 }),
    line("4/20/26, 4:49 PM PostHog handbook", 770, { size: 8 }),
    line("file:///tmp/handbook-pdf-build/handbook.html 1/2", 17, { size: 8 }),
  ];
  const pageTwo: PdfLine[] = [
    line("team calendar", 734, { page: 2, x: 80, right: 150 }),
    line("A new paragraph on page two.", 700, { page: 2, right: 200 }),
  ];
  const [section] = parseSections([...pageOne, ...pageTwo]);

  it("finds the section title, path and page range", () => {
    expect(section).toMatchObject({ title: "Time off", path: "contents/handbook/people/time-off.md", startPage: 1, endPage: 2 });
  });

  it("rebuilds paragraphs, headings and list items", () => {
    expect(section.blocks.map((b) => [b.kind, b.listLevel, b.text])).toEqual([
      ["paragraph", 0, "We offer our team unlimited time off, but with an expectation that you take at least 25 days off a year."],
      ["heading", 0, "Permissionless time off"],
      ["paragraph", 0, "You should avoid things like:"],
      ["paragraph", 1, "Having an entire Small Team off"],
      ["paragraph", 1, "Having the only X people who can do some totally critical task at PostHog off - if this is unavoidable, try to check in"],
      ["paragraph", 1, "1. Open the PTO app and book the days you want, making sure your manager can see them in the"],
      ["paragraph", 1, "team calendar"],
      ["paragraph", 0, "A new paragraph on page two."],
    ]);
    expect(section.blocks[1].level).toBe(2);
  });

  it("splits a paragraph that crosses a page break into one block per page", () => {
    const [onPageOne, onPageTwo] = section.blocks.slice(5, 7);
    expect(onPageOne.page).toBe(1);
    expect(onPageTwo).toMatchObject({ page: 2, continued: true });
  });
});
