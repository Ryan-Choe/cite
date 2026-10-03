import { describe, expect, it } from "vitest";
import { absenceTopic, extractGapLines, findAbsenceClaims, isSearchable, removeAbsenceClaims } from "./gaps";

describe("extractGapLines", () => {
  it("removes GAP lines wherever they are and returns them in order, without quotes", () => {
    expect(extractGapLines('Answer.\nGAP: monitor budget\nMore.\n  GAP: "who approves it"  ')).toEqual({
      text: "Answer.\nMore.\n",
      gaps: ["monitor budget", "who approves it"],
    });
  });

  it("leaves 'GAP:' alone when it isn't at the start of a line, and skips empty gaps", () => {
    expect(extractGapLines("The GAP: a store.\nGAP:   \n")).toEqual({ text: "The GAP: a store.\n", gaps: [] });
  });

  it.each(["- GAP: monitor budget", "* GAP: monitor budget", "1. GAP: monitor budget", "Gap: monitor budget", "**GAP:** monitor budget", "GAP: **monitor budget**", "GAP:monitor budget\r"])(
    "also reads %j, the way Claude might format it",
    (line) => {
      expect(extractGapLines(`Answer.\n${line}\n`)).toEqual({ text: "Answer.\n", gaps: ["monitor budget"] });
    },
  );

  it("doesn't mistake other lines for gaps", () => {
    expect(extractGapLines("- Gaps between shifts are paid.\n").gaps).toEqual([]);
  });
});

describe("findAbsenceClaims", () => {
  // The four false "the handbook doesn't say" answers from the eval (eval/results/regrade-blind.json).
  it.each([
    "The handbook passages I have don't say whether you need approval or must disclose a side gig, so they don't count.",
    "The passages don't say that you need approval for paid side work in general.",
    "The handbook doesn't name a special reviewer for PRs that touch a GitHub Actions workflow, so I can't say one is required.",
    "The handbook passages don't say whether every support team member works every product in the long run.",
    "The handbook doesn’t explicitly mention a budget.",
  ])("finds %j", (sentence) => {
    expect(findAbsenceClaims(`Intro.[1] ${sentence} Outro.`)).toEqual([sentence]);
  });

  it.each([
    "There is nothing about relocation in the handbook passages.",
    "The passages are silent on parental leave for contractors.",
    "The handbook makes no mention of a budget for monitors.",
    "That detail is not in the passages I was given.",
    "I couldn't find who approves it.",
    "The handbook doesn't provide a deadline.",
  ])("also finds %j", (sentence) => {
    expect(findAbsenceClaims(sentence)).toEqual([sentence]);
  });

  it.each([
    "The handbook says you don't need to give notice.",
    "You don't need approval, per the handbook.",
    "Book it in Deel.",
    "Nothing in your first week needs approval.",
    "It doesn't cover contractors.",
    "If the handbook is unclear, ask in #ask-max.",
  ])("ignores %j", (sentence) => {
    expect(findAbsenceClaims(sentence)).toEqual([]);
  });
});

describe("absenceTopic", () => {
  it.each([
    [
      "The handbook passages I have don't say whether you need approval or must disclose a side gig, so they don't count.",
      "you need approval or must disclose a side gig",
    ],
    ["The passages don't say that you need approval for paid side work in general.", "you need approval for paid side work in general"],
    [
      "The handbook doesn't name a special reviewer for PRs that touch a GitHub Actions workflow, so I can't say one is required.",
      "a special reviewer for PRs that touch a GitHub Actions workflow",
    ],
    ["The handbook doesn't say anything about other incentives.", "other incentives"],
    ["The handbook doesn't say who orders them.", "who orders them"], // question words carry meaning
  ])("turns %j into a search phrase", (sentence, topic) => {
    expect(absenceTopic(sentence)).toBe(topic);
  });
});

describe("removeAbsenceClaims", () => {
  it("removes each claim with the break after it, and keeps everything else", () => {
    expect(removeAbsenceClaims(" Ask IT.[1] The handbook doesn't say who pays. Then wait.\nThe passages don't mention monitors.")).toEqual({
      text: " Ask IT.[1] Then wait.\n",
      claims: ["The handbook doesn't say who pays.", "The passages don't mention monitors."],
    });
  });
});

describe("isSearchable", () => {
  it.each(["monitor budget", "who orders replacement laptops", "a street address for Hogpatch"])("accepts %j", (phrase) => {
    expect(isSearchable(phrase)).toBe(true);
  });

  it.each(["", "this", "who orders them", "what that summary includes beyond that"])("rejects %j", (phrase) => {
    expect(isSearchable(phrase)).toBe(false);
  });
});
