import { describe, expect, it } from "vitest";
import { continuesAcrossPages, isPageChrome, itemsToLines, joinWrapped, parseSections, wrapMargins, wrapsOnto, type TextItem } from "./layout";
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

describe("wrapMargins", () => {
  // 30 full body lines at the page margin, and 30 full lines in a callout box, which wraps ~30pt earlier.
  const body = Array.from({ length: 30 }, (_, i) => line(`body ${i}`, 700 - i, { right: 561 }));
  const callout = Array.from({ length: 30 }, (_, i) => line(`callout ${i}`, 400 - i, { x: 64, right: 531 }));

  const at = (x: number, text = "Some text") => line(text, 100, { x });

  it("measures a narrower margin, with less slack, for an indentation that wraps well before the page margin", () => {
    const marginAt = wrapMargins([...body, ...callout]);
    expect(marginAt(at(50))).toEqual({ right: 561, tolerance: 20 });
    expect(marginAt(at(64.02))).toEqual({ right: 531, tolerance: 10 });
  });

  it("uses the page margin where there's too little text to tell, or the difference is small", () => {
    const few = callout.slice(0, 5);
    const nearlyFull = Array.from({ length: 30 }, (_, i) => line(`list ${i}`, 300 - i, { x: 80, right: 556 }));
    const marginAt = wrapMargins([...body, ...few, ...nearlyFull]);
    expect(marginAt(at(64)).right).toBe(561);
    expect(marginAt(at(80)).right).toBe(561);
  });

  it("ignores code and table text, which uses a smaller font", () => {
    const code = Array.from({ length: 30 }, (_, i) => line(`code ${i}`, 300 - i, { x: 61, right: 300, size: 10 }));
    expect(wrapMargins([...body, ...code])(at(61)).right).toBe(561);
  });

  it("uses the page margin for a numbered item, whose x depends on its number's width", () => {
    const marginAt = wrapMargins([...body, ...callout]);
    expect(marginAt(at(63.76, "12. To add to EU Cloud, open the admin panel")).right).toBe(561);
  });
});

describe("continuesAcrossPages", () => {
  const prev = line("Watch for memory and", 40, { x: 80 });

  const next = (text: string) => line(text, 740, { page: 2, x: 80 });

  it("never continues a finished sentence", () => {
    expect(continuesAcrossPages(line("Book it in Deel.", 40), line("then wait", 740, { page: 2 }), false)).toBe(false);
  });

  it("continues an unfinished paragraph or numbered item, whatever the next line starts with", () => {
    expect(continuesAcrossPages(line("handled by", 40), line("PostHog's team", 740, { page: 2 }), false)).toBe(true);
    expect(continuesAcrossPages(line("3. Watch for memory and", 40, { x: 80 }), next("CPU pressure), and slow queries"), false)).toBe(true);
  });

  it("continues a bulleted item only if the next line starts mid-sentence", () => {
    expect(continuesAcrossPages(prev, next("slow queries"), true)).toBe(true);
    // Bulleted items rarely end with a full stop: a capital, a URL or a code name starts a new item.
    expect(continuesAcrossPages(prev, next("Connection limiting: cap connections"), true)).toBe(false);
    expect(continuesAcrossPages(prev, next("https://posthog.com/blog/best-sentry-alternatives"), true)).toBe(false);
    expect(continuesAcrossPages(prev, next("product_name_forecasted_mrr added to the forecasted CTE"), true)).toBe(false);
  });
});

describe("parseSections: headings and callouts", () => {
  const callout = (text: string, y: number, right = 531) => line(text, y, { x: 64, right });
  const sections = parseSections([
    line("Historical import", 740, { size: 22 }),
    line("contents/handbook/cs/historical-import.md", 710, { size: 8.5, right: 300 }),
    line("Imports run nightly.", 690, { right: 200 }),
    line("Load testing", 650, { size: 22, right: 200 }), // a title-size heading with no path after it
    line("Ask before load testing.", 620, { right: 250 }),
    // A callout box: its text wraps at 531, not at the page margin (561).
    // The next word would have fit before the page margin (so the old rule saw a deliberate break), but not inside the box.
    callout("Small open source projects with less than $200k annual", 590, 460),
    callout("revenue can contact support.", 574, 300),
    ...Array.from({ length: 25 }, (_, i) => callout(`Callout line ${i} that fills the box.`, 540 - i * 27)),
    ...Array.from({ length: 25 }, (_, i) => line(`Body line ${i}.`, 520 - i * 27, { page: 2, right: 561 })),
  ]);

  it("drops a title-size heading that only repeats the section's title", () => {
    const [repeated] = parseSections([
      line("Automations", 740, { size: 22 }),
      line("contents/handbook/cs/automations.md", 710, { size: 8.5, right: 300 }),
      line("Automations", 680, { size: 22 }),
      line("We automate a lot.", 650, { right: 200 }),
    ]);
    expect(repeated.blocks.map((b) => b.text)).toEqual(["We automate a lot."]);
  });

  it("keeps a title-size heading inside a section as a level-1 heading", () => {
    expect(sections).toHaveLength(1);
    expect(sections[0].blocks.slice(0, 3).map((b) => [b.kind, b.level, b.text])).toEqual([
      ["paragraph", undefined, "Imports run nightly."],
      ["heading", 1, "Load testing"],
      ["paragraph", undefined, "Ask before load testing."],
    ]);
  });

  it("joins a line that wrapped inside a callout box, measured against the box's own margin", () => {
    expect(sections[0].blocks[3].text).toBe("Small open source projects with less than $200k annual revenue can contact support.");
  });

  it("keeps separate bullets in a callout box apart when the next one's first word would have fit", () => {
    const item = (text: string, y: number, right = 531) => line(text, y, { x: 94, right });
    const [inBox] = parseSections([
      line("New sales", 740, { size: 22 }),
      line("contents/handbook/growth/sales/new-sales.md", 710, { size: 8.5, right: 300 }),
      line("Body text runs to the page margin, which is 30pt wider than the box.", 700, { right: 561 }),
      ...Array.from({ length: 25 }, (_, i) => item(`Callout item ${i} that fills the box.`, 670 - i * 20)),
      // "What" would have fit before the box's margin (531) with ~15pt to spare: a deliberate break.
      item("Do you want to consolidate tools and have a single source of truth?", 150, 492),
      item("What does the rest of your stack look like?", 134.3, 300),
    ]);
    expect(inBox.blocks.slice(-2).map((b) => b.text)).toEqual([
      "Do you want to consolidate tools and have a single source of truth?",
      "What does the rest of your stack look like?",
    ]);
  });
});
