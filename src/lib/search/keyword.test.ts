import { describe, expect, it } from "vitest";
import type { Chunk } from "../chunk";
import { buildKeywordIndex, RARE_MAX_PASSAGES, rareWordMatch, rareWords, tokenize, withKeywordMatch } from "./keyword";

function chunk(id: string, text: string, title = "Handbook"): Chunk {
  return { id, sectionTitle: title, sectionPath: `contents/handbook/${id}.md`, headings: [], title, pages: [{ page: 1, text }] };
}

// "posthog", "search" and "insights" are in more than RARE_MAX_PASSAGES passages; "search_insights" and "hedgehouse" in one each.
const index = buildKeywordIndex([
  chunk("ai", "PostHog AI used search_insights and search_docs; now one search tool takes kind=insights."),
  chunk("onboarding", "PostHog team leads can use the Hedgehouse for in-person onboarding."),
  chunk("search", "PostHog search helps you find insights in your product data."),
  chunk("overview-1", "PostHog search and insights overview, part 1."),
  chunk("overview-2", "PostHog search and insights overview, part 2."),
]);

describe("tokenize", () => {
  it("keeps joined strings whole as well as split, so identifiers stay distinctive", () => {
    expect(tokenize("ask security-internal@posthog.com about search_insights")).toEqual(
      expect.arrayContaining(["security", "internal", "posthog", "com", "search", "insights", "security-internal@posthog.com", "search_insights"]),
    );
  });
});

describe("rareWords", () => {
  it("finds words that appear in only a few passages", () => {
    expect(rareWords(index, "do we still have search_insights?")).toEqual(["search_insights"]);
    expect(rareWords(index, "can I take a new starter to the hedgehouse?")).toEqual(["hedgehouse"]);
  });

  it("ignores common words, stop words, and words in no passage (e.g. typos)", () => {
    expect(rareWords(index, "what does posthog search do?")).toEqual([]);
    expect(rareWords(index, "what is the hedgehuose?")).toEqual([]);
  });

  it("ignores joined words made only of stop words, which carry no meaning", () => {
    const withJoined = buildKeywordIndex([chunk("sick", "Tell your manager if/when you're off sick, and keep a to-do list.")]);
    expect(rareWords(withJoined, "should I tell someone if/when I'm off? what goes on my to-do list?")).not.toEqual(
      expect.arrayContaining(["if/when"]),
    );
    expect(rareWords(withJoined, "what about to-do?")).toEqual([]);
  });

  it(`counts a word in up to ${RARE_MAX_PASSAGES} passages as rare, but not one in more`, () => {
    const travel = (n: number) => Array.from({ length: n }, (_, i) => chunk(`travel-${i}`, `Travel budget for offsites, part ${i}.`));
    expect(rareWords(buildKeywordIndex(travel(RARE_MAX_PASSAGES)), "what's the travel budget?")).toEqual(["travel", "budget"]);
    expect(rareWords(buildKeywordIndex(travel(RARE_MAX_PASSAGES + 1)), "what's the travel budget?")).toEqual([]);
  });
});

describe("rareWordMatch", () => {
  it("returns the passage holding the rare word", () => {
    expect(rareWordMatch(index, "do we still have a search_insights tool in posthog ai?")).toBe("ai");
    expect(rareWordMatch(index, "can I take a new starter to the hedgehouse?")).toBe("onboarding");
  });

  it("returns nothing when the question has no rare word", () => {
    expect(rareWordMatch(index, "how do I search posthog?")).toBeUndefined();
  });

  it("looks a joined rare word up whole, not by its common parts", () => {
    // "week-to-week" is in one long passage; its part "week" is in a few short ones, and in their
    // titles. The other passages make "week" a meaningful (not universal) word, as in the handbook.
    const long = "Spend is reviewed by the team and compared against the plan for the quarter. ".repeat(20);
    const weeks = buildKeywordIndex([
      chunk("cost-alerts", `${long}Alert when total infra spend jumps week-to-week by more than 10%.`, "Cost alerts"),
      ...[1, 2, 3, 4].map((n) => chunk(`week-${n}`, `What to do this week, and next week, in week ${n}.`, `Onboarding › Week ${n}`)),
      ...Array.from({ length: 40 }, (_, n) => chunk(`other-${n}`, `Another handbook page about topic ${n}.`)),
    ]);
    expect(rareWords(weeks, "how big a week-to-week jump is too much?")).toEqual(["week-to-week"]);
    expect(rareWordMatch(weeks, "how big a week-to-week jump is too much?")).toBe("cost-alerts");
  });
});

describe("withKeywordMatch", () => {
  const semantic = ["a", "b", "c", "d"];

  it("puts the keyword match in the last slot when semantic search missed it", () => {
    expect(withKeywordMatch(semantic, "z", 3)).toEqual(["a", "b", "z"]);
  });

  it("changes nothing when semantic search already has it, or there is no match", () => {
    expect(withKeywordMatch(semantic, "b", 3)).toEqual(["a", "b", "c"]);
    expect(withKeywordMatch(semantic, "c", 3)).toEqual(["a", "b", "c"]);
    expect(withKeywordMatch(semantic, undefined, 3)).toEqual(["a", "b", "c"]);
  });

  it("returns nothing for a limit below 1", () => {
    expect(withKeywordMatch(semantic, "z", 0)).toEqual([]);
    expect(withKeywordMatch(semantic, undefined, -1)).toEqual([]);
  });
});
