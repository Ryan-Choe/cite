import { describe, expect, it } from "vitest";
import { isUncitedClaim } from "./uncited";

const uncited = (text: string) => isUncitedClaim({ text, citations: [] });

describe("isUncitedClaim", () => {
  it.each(["No.", "You don't need approval.", "Yes, ", "In practice it comes down to care with secrets."])("flags %j", (text) => {
    expect(uncited(text)).toBe(true);
  });

  it.each(["", " ", "\n\n- ", ", ", " and ", "; ", "What the handbook does cover:\n- ", "On intellectual property:\n  1. ", "The handbook says ", " It also adds that "])(
    "doesn't flag %j",
    (text) => {
      expect(uncited(text)).toBe(false);
    },
  );

  it("flags a claim before a closing lead-in, not just the lead-in", () => {
    // From an eval reply of 2026-10-03.
    expect(uncited("The handbook's passages suggest the older data was not recovered, though they don't say this outright. Here is what they do say:\n\n- ")).toBe(true);
    expect(uncited("Short answer: no.")).toBe(true);
    expect(uncited("Here is what they do say:\n\n- ")).toBe(false);
  });

  it("never flags cited text", () => {
    expect(isUncitedClaim({ text: "No.", citations: [1] })).toBe(false);
  });
});
