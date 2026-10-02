import { describe, expect, it } from "vitest";
import { buildRewritePrompt, cleanRewrite, rewriteFollowUp } from "./rewrite";

describe("buildRewritePrompt", () => {
  it("lists earlier standalone questions, oldest first, then the latest message", () => {
    const prompt = buildRewritePrompt("Is it paid?", [
      { question: "parental leave?", searchedFor: "What is the parental leave policy?" },
      { question: "how long?", searchedFor: "How long is parental leave?" },
    ]);
    expect(prompt).toBe(
      "Earlier questions, oldest first:\n1. What is the parental leave policy?\n2. How long is parental leave?\n\nLatest message: Is it paid?",
    );
  });
});

describe("cleanRewrite", () => {
  it("trims whitespace and surrounding quotes", () => {
    expect(cleanRewrite('  "Is parental leave paid?"\n', "Is it paid?")).toBe("Is parental leave paid?");
  });

  it("falls back to the original question if the reply is empty or suspiciously long", () => {
    expect(cleanRewrite("   ", "Is it paid?")).toBe("Is it paid?");
    expect(cleanRewrite("x".repeat(301), "Is it paid?")).toBe("Is it paid?");
  });
});

describe("rewriteFollowUp", () => {
  it("skips the model call for the first question in a conversation", async () => {
    await expect(rewriteFollowUp("How much time off do I get?", [])).resolves.toBe("How much time off do I get?");
  });
});
