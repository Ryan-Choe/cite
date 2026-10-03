import { describe, expect, it } from "vitest";
import { dedupeGaps, extractGapLines, isSearchable } from "./gaps";

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
