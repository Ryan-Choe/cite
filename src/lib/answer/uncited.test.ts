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

  it("never flags cited text", () => {
    expect(isUncitedClaim({ text: "No.", citations: [1] })).toBe(false);
  });
});
