import { describe, expect, it } from "vitest";
import { absenceTopic, dedupeGaps, extractGapLines, findAbsenceClaims, isSearchable, removeAbsenceClaims } from "./gaps";

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
  it("catches 'doesn't show' and 'doesn't confirm' too", () => {
    expect(findAbsenceClaims("The handbook doesn't show that the older data was recovered.")).toHaveLength(1);
    expect(findAbsenceClaims("These passages don't confirm the amount.")).toHaveLength(1);
  });

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
      remarks: [],
    });
  });

  it("removes remarks about the passages, with no gap topic, but keeps handbook framing", () => {
    const text =
      "The passages only partly cover this. Ask IT. None of these excerpts mention a cliff. There's no mention of monitors. " +
      "Nothing here covers parking. The handbook lists three steps:";
    expect(removeAbsenceClaims(text)).toEqual({
      text: "Ask IT. The handbook lists three steps:",
      claims: [],
      remarks: [
        "The passages only partly cover this.",
        "None of these excerpts mention a cliff.",
        "There's no mention of monitors.",
        "Nothing here covers parking.",
      ],
    });
  });

  it("removes a 'what they cover' lead-in left dangling, and 'the handbook passages' remarks", () => {
    expect(removeAbsenceClaims("The passages describe the schedule, but they don't say anything about pay.\n\nWhat they do cover:\n- ").text).toBe("- ");
    expect(removeAbsenceClaims("The handbook passages only partly cover this. Ask HR.").text).toBe("Ask HR.");
  });

  it("turns an unfinished lead-in into cited text into 'The handbook says ', instead of cutting the sentence", () => {
    expect(removeAbsenceClaims("The handbook doesn't give a street address. What they do say is that ", true).text).toBe("The handbook says ");
    expect(removeAbsenceClaims("The passages say ", true).text).toBe("The handbook says ");
    // Not followed by cited text: an unfinished remark just goes.
    expect(removeAbsenceClaims("Ask HR. The passages only partly cover this").text).toBe("Ask HR. ");
  });

  it("removes a pronoun sentence left dangling by a removed one, and only then", () => {
    const removed = removeAbsenceClaims("The passages don't give the scores. They only describe how the comparison works. Ask HR.");
    expect(removed.text).toBe("Ask HR.");
    expect(removed.remarks).toEqual(["They only describe how the comparison works."]);
    expect(removeAbsenceClaims("Ask HR. They reply within a day.").text).toBe("Ask HR. They reply within a day.");
  });
});

describe("absenceTopic: what the source does say is cut off", () => {
  it("drops a ', but they …' tail", () => {
    expect(absenceTopic("The passages don't say whether you get a day off for weekend on-call, but they do describe the schedule.")).toBe(
      "you get a day off for weekend on-call",
    );
  });
});

describe("dedupeGaps", () => {
  it("drops a gap whose meaningful words are all in an earlier one (or the reverse), keeping the first wording", () => {
    expect(dedupeGaps(["the vesting schedule for share options", "vesting schedule"])).toEqual(["the vesting schedule for share options"]);
    expect(dedupeGaps(["vesting schedule", "the vesting schedule for share options"])).toEqual(["vesting schedule"]);
  });

  it("keeps gaps that differ in a meaningful word, even when most words are shared", () => {
    expect(dedupeGaps(["maximum days of sick leave", "maximum days of parental leave"])).toHaveLength(2);
    expect(dedupeGaps(["the actual results of the last team survey", "team survey benchmark provider"])).toHaveLength(2);
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
