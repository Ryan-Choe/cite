import { describe, expect, it } from "vitest";
import { bodyText, chunkSection, renderBlock, searchText, splitLongText } from "./chunk";
import type { Block, Section } from "./ingest/types";

// --- helpers to build test sections ---------------------------------------------------
const para = (text: string, page = 1, listLevel = 0): Block => ({ kind: "paragraph", listLevel, text, page });
const h2 = (text: string, page = 1): Block => ({ kind: "heading", level: 2, listLevel: 0, text, page });
const h3 = (text: string, page = 1): Block => ({ kind: "heading", level: 3, listLevel: 0, text, page });
const section = (blocks: Block[]): Section => ({
  title: "Time off",
  path: "contents/handbook/people/time-off.md",
  startPage: blocks[0]?.page ?? 1,
  endPage: blocks.at(-1)?.page ?? 1,
  blocks,
});
const sentence = (n: number) => `This is sentence number ${n} of a long paragraph.`; // ~45 chars

// --- helpers already implemented (these pass today) -----------------------------------
describe("renderBlock", () => {
  it("renders list items as bullets, indented by nesting level", () => {
    expect(renderBlock(para("Plain paragraph"))).toBe("Plain paragraph");
    expect(renderBlock(para("Branded merch", 1, 1))).toBe("- Branded merch");
    expect(renderBlock(para("Out Sick", 1, 2))).toBe("  - Out Sick");
    expect(renderBlock(para("1. Open the Figma file", 1, 1))).toBe("1. Open the Figma file");
  });
});

describe("splitLongText", () => {
  it("leaves short text alone", () => {
    expect(splitLongText("Short.", 100)).toEqual(["Short."]);
  });

  it("cuts mid-word only when there is no space at all (e.g. a giant URL)", () => {
    expect(splitLongText("x".repeat(25), 10)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });
});

// --- chunkSection ----------------------------------------------------------------------
describe("chunkSection", () => {
  it("puts a short section into one chunk, titled with the section title", () => {
    const chunks = chunkSection(section([para("We offer unlimited time off."), para("Take at least 25 days.")]));

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toEqual({
      id: "contents/handbook/people/time-off.md#0",
      sectionTitle: "Time off",
      sectionPath: "contents/handbook/people/time-off.md",
      headings: [],
      title: "Time off",
      pages: [{ page: 1, text: "We offer unlimited time off.\nTake at least 25 days." }],
    });
    expect(searchText(chunks[0])).toBe("Time off\n\nWe offer unlimited time off.\nTake at least 25 days.");
  });

  it("renders list items with renderBlock", () => {
    const chunks = chunkSection(section([para("Avoid:"), para("Having an entire team off", 1, 1)]));
    expect(bodyText(chunks[0])).toBe("Avoid:\n- Having an entire team off");
  });

  it("starts a new chunk at every heading, and tracks the heading trail in the title", () => {
    const chunks = chunkSection(
      section([
        para("Intro."),
        h2("Permissionless time off"),
        para("No approval needed."),
        h3("How to book time off"),
        para("Use the PTO by Deel app."),
        h2("Sick leave"),
        para("Tell your manager."),
      ]),
    );

    expect(chunks.map((c) => c.title)).toEqual([
      "Time off",
      "Time off › Permissionless time off",
      "Time off › Permissionless time off › How to book time off",
      "Time off › Sick leave",
    ]);
    expect(chunks.map((c) => c.headings)).toEqual([
      [],
      ["Permissionless time off"],
      ["Permissionless time off", "How to book time off"],
      ["Sick leave"],
    ]);
    // Headings live in the title, not in the body.
    expect(bodyText(chunks[1])).toBe("No approval needed.");
  });

  it("numbers chunk ids from 0 within the section", () => {
    const chunks = chunkSection(section([para("A."), h2("B"), para("B."), h2("C"), para("C.")]));
    expect(chunks.map((c) => c.id.split("#")[1])).toEqual(["0", "1", "2"]);
  });

  it("packs paragraphs until the next one would exceed maxChars", () => {
    const blocks = Array.from({ length: 5 }, (_, i) => para("x".repeat(30) + i)); // 31 chars each
    const chunks = chunkSection(section(blocks), 100);

    // 31 + 1 + 31 + 1 + 31 = 95 fits; a 4th paragraph would make 127.
    expect(chunks.map((c) => bodyText(c).split("\n").length)).toEqual([3, 2]);
    for (const c of chunks) expect(bodyText(c).length).toBeLessThanOrEqual(100);
  });

  it("keeps the heading trail on every chunk of a long subsection", () => {
    const blocks = [h2("Booking"), ...Array.from({ length: 4 }, () => para("y".repeat(60)))];
    const chunks = chunkSection(section(blocks), 130);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.title).toBe("Time off › Booking");
  });

  it("splits a paragraph longer than maxChars at sentence ends", () => {
    const long = Array.from({ length: 10 }, (_, i) => sentence(i)).join(" ");
    const chunks = chunkSection(section([para(long)]), 200);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const body = bodyText(c);
      expect(body.length).toBeLessThanOrEqual(200);
      expect(body).toMatch(/\.$/); // every piece ends at a sentence boundary
    }
    // Nothing is lost or reordered.
    expect(chunks.map(bodyText).join(" ")).toBe(long);
  });

  it("splits a single over-long sentence at the last space before maxChars", () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "); // no sentence ends
    const chunks = chunkSection(section([para(words)]), 100);

    for (const c of chunks) expect(bodyText(c).length).toBeLessThanOrEqual(100);
    expect(chunks.map(bodyText).join(" ")).toBe(words);
  });

  it("groups body text by page, so citations can name the exact page", () => {
    const chunks = chunkSection(section([para("End of page 980.", 980), para("More on 980.", 980), para("Start of 981.", 981)]));

    expect(chunks).toHaveLength(1);
    expect(chunks[0].pages).toEqual([
      { page: 980, text: "End of page 980.\nMore on 980." },
      { page: 981, text: "Start of 981." },
    ]);
  });

  it("drops chunks with no body text", () => {
    expect(chunkSection(section([]))).toEqual([]);
    expect(chunkSection(section([h2("Only a heading")]))).toEqual([]);
    expect(chunkSection(section([h2("Empty"), h2("Has text"), para("Text.")])).map((c) => c.title)).toEqual([
      "Time off › Has text",
    ]);
  });
});
