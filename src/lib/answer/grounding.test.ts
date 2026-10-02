import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import type { Chunk } from "../chunk";
import { applyGroundingGate } from "./grounding";
import { buildDocuments } from "./prompt";

const chunk = (id: string, title: string, pages: { page: number; text: string }[]): Chunk => ({
  id,
  sectionTitle: title.split(" › ")[0],
  sectionPath: `contents/handbook/${id.split("#")[0]}.md`,
  headings: title.split(" › ").slice(1),
  title,
  pages,
});

// Document 0 has three paragraph blocks (two on p.980, one on p.981); document 1 has one.
const { sources } = buildDocuments([
  chunk("people/time-off#0", "Time off", [
    { page: 980, text: "We offer unlimited time off.\nTake at least 25 days a year." },
    { page: 981, text: "Book it in PTO by Deel." },
  ]),
  chunk("people/spending-money#3", "Spending money › Equipment", [{ page: 972, text: "Laptops are provided." }]),
]);

const cite = (document_index: number, start: number, end: number, cited_text: string) => ({
  type: "content_block_location" as const,
  document_index,
  start_block_index: start,
  end_block_index: end,
  cited_text,
  document_title: null,
});

const reply = (...blocks: { text: string; citations?: ReturnType<typeof cite>[] }[]) =>
  blocks.map((b) => ({ type: "text", text: b.text, citations: b.citations ?? null })) as Anthropic.Beta.BetaContentBlock[];

describe("applyGroundingGate", () => {
  it("numbers citations in order of first use and maps each to its section, page and exact quote", () => {
    const { result } = applyGroundingGate(
      reply(
        { text: "You should take at least 25 days off a year.", citations: [cite(0, 1, 2, "Take at least 25 days a year.")] },
        { text: " Book it in PTO by Deel.", citations: [cite(0, 2, 3, "Book it in PTO by Deel.")] },
      ),
      sources,
      "how much vacation",
    );

    expect(result).toEqual({
      status: "answered",
      searchedFor: "how much vacation",
      parts: [
        { text: "You should take at least 25 days off a year.", citations: [1] },
        { text: " Book it in PTO by Deel.", citations: [2] },
      ],
      citations: [
        { n: 1, sectionTitle: "Time off", sectionPath: "contents/handbook/people/time-off.md", title: "Time off", pages: [980], quote: "Take at least 25 days a year." },
        { n: 2, sectionTitle: "Time off", sectionPath: "contents/handbook/people/time-off.md", title: "Time off", pages: [981], quote: "Book it in PTO by Deel." },
      ],
    });
  });

  it("reuses the same number when the same passage is cited twice", () => {
    const passage = cite(1, 0, 1, "Laptops are provided.");
    const { result } = applyGroundingGate(
      reply({ text: "Yes.", citations: [passage] }, { text: " Really.", citations: [passage] }),
      sources,
      "laptop",
    );
    expect(result.status === "answered" && result.parts.map((p) => p.citations)).toEqual([[1], [1]]);
  });

  it("reports every page of a citation that spans a page break", () => {
    const { result } = applyGroundingGate(
      reply({ text: "Take 25 days and book them.", citations: [cite(0, 1, 3, "Take at least 25 days a year.Book it in PTO by Deel.")] }),
      sources,
      "q",
    );
    expect(result.status === "answered" && result.citations[0].pages).toEqual([980, 981]);
  });

  it("treats an answer with no citations as not covered, and offers the closest sections", () => {
    const outcome = applyGroundingGate(reply({ text: "Probably 20 days." }), sources, "vacation");
    expect(outcome.notCoveredReason).toBe("no-citations");
    expect(outcome.result).toEqual({
      status: "not-covered",
      searchedFor: "vacation",
      closest: [
        { title: "Time off", page: 980 },
        { title: "Spending money › Equipment", page: 972 },
      ],
    });
  });

  it("treats Claude's NOT_COVERED reply as not covered", () => {
    const outcome = applyGroundingGate(reply({ text: "NOT_COVERED" }), sources, "stock price");
    expect(outcome.result.status).toBe("not-covered");
    expect(outcome.notCoveredReason).toBe("model-said-not-covered");
  });

  it("drops citations that point outside the documents or don't match our text", () => {
    const outcome = applyGroundingGate(
      reply({
        text: "Claim.",
        citations: [cite(7, 0, 1, "No such document."), cite(0, 0, 1, "We offer unlimited PAID time off.")],
      }),
      sources,
      "q",
    );
    expect(outcome.droppedCitations).toBe(2);
    expect(outcome.result.status).toBe("not-covered"); // nothing valid left to stand on
  });

  it("ignores whitespace differences when checking a quote", () => {
    const { result } = applyGroundingGate(
      reply({ text: "Yes.", citations: [cite(1, 0, 1, "Laptops  are\nprovided.")] }),
      sources,
      "q",
    );
    expect(result.status).toBe("answered");
  });

  it("skips non-text blocks such as thinking", () => {
    const content = [
      { type: "thinking", thinking: "", signature: "x" },
      ...reply({ text: "Yes.", citations: [cite(1, 0, 1, "Laptops are provided.")] }),
    ] as Anthropic.Beta.BetaContentBlock[];
    const { result } = applyGroundingGate(content, sources, "q");
    expect(result.status === "answered" && result.parts).toHaveLength(1);
  });
});

describe("uncitedChars", () => {
  it("counts letters and digits in answer text that carries no citation", () => {
    const { uncitedChars } = applyGroundingGate(
      reply(
        { text: "Take 25 days. " }, // uncited: "Take25days" = 10
        { text: "We offer unlimited time off.", citations: [cite(0, 0, 1, "We offer unlimited time off.")] },
        { text: "\n\n- " }, // punctuation only: 0
      ),
      sources,
      "q",
    );
    expect(uncitedChars).toBe(10);
  });
});
