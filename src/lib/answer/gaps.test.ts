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
    "The team names are missing from the passage, so I can't list which teams.", // from an eval run
    "The passages say nothing about extra pay.",
    "The handbook has nothing to say about relocation.",
    "The handbook doesn't spell out who approves it.",
    "The handbook doesn't lay out the steps.",
    "The handbook doesn't spell this out.",
    "The passages I've been given don't mention a relocation budget.",
    "The passages I can see don't mention whether contractors qualify.",
    "The handbook as excerpted here doesn't say whether contractors qualify.",
    "The passages in the handbook don't say who approves it.",
  ])("also finds %j", (sentence) => {
    expect(findAbsenceClaims(sentence)).toEqual([sentence]);
  });

  // Uncited claims that got past the checker in the eval runs of 2026-10-03 (the first two were false),
  // and wordings like them. They can also report a rule, so only uncited ones are taken out.
  it.each([
    "The handbook gives no single cutoff.",
    "The handbook doesn't set a hard deadline, but it recommends starting early, at the concept stage in the coming soon menu.",
    "The passages give no figure for it.",
    "The handbook has no section on relocation.",
    "The handbook sets out no process for this.",
    "The handbook passages don't have a figure for it.",
    "The handbook passages I have give no figure.",
    "The handbook sets no limit on time off.",
  ])("leaves %j to the citation check: removeAbsenceClaims takes it out of uncited text", (sentence) => {
    expect(findAbsenceClaims(sentence)).toEqual([]);
    expect(removeAbsenceClaims(sentence)).toEqual({ text: "", claims: [sentence], remarks: [] });
  });

  it.each([
    "The handbook says you don't need to give notice.",
    "You don't need approval, per the handbook.",
    "Book it in Deel.",
    "Nothing in your first week needs approval.",
    "It doesn't cover contractors.",
    "If the handbook is unclear, ask in #ask-max.",
    "The handbook says there is no formal checklist for progression.",
    "The handbook says no approval is needed.",
    "The handbook states no one needs sign-off.",
    "The handbook explains that the plan has no cap.",
    "Nothing is missing from your first-week checklist.",
    // Found by an adversarial check of the 2026-10-03 change: the negation belongs to a new subject
    // ("you", "PostHog"), or "no"/"nothing" is part of the rule, so each reports what the handbook says.
    "The handbook makes clear you don't have to ask permission to take time off.",
    "The handbook mentions you don't have to cram deals into the end of a quarter.",
    "The handbook confirms PostHog doesn't offer additional discounts in exchange for a case study.",
    "The handbook is clear PostHog doesn't offer discounts to customers paying monthly.",
    "The handbook makes clear managers don't set tasks for small teams.",
    "The handbook says nothing ships without your sign-off.",
    "The handbook says nothing else is required beyond a message in Slack.",
    "If something is missing from the handbook, open a pull request to add it.",
    "The handbook lists no-meeting days as Tuesdays and Thursdays.",
    "The handbook puts no more than six people on a small team.",
    "The handbook has notes on relocation.",
    "The handbook partially covers the cost of a coworking space.",
    "Changes to the handbook don't have to go through review.",
    "Anything you add to the handbook can't contain customer PII.",
    "The handbook never lays blame on individuals for outages.",
    "The handbook doesn't try to spell out which channel to use for every message.",
    "The handbook gives no one a veto over the roadmap.",
    "The handbook lists No Meeting Days as Tuesdays and Thursdays.",
    "Yes, the handbook has no objections to side gigs.",
  ])("ignores %j, even uncited", (sentence) => {
    expect(findAbsenceClaims(sentence)).toEqual([]);
    expect(removeAbsenceClaims(sentence).text).toBe(sentence);
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
    ["The handbook gives no single cutoff.", "single cutoff"],
    ["The passages say nothing about extra pay for on-call.", "extra pay for on-call"],
    ["The handbook doesn't set a hard deadline, but it recommends starting early.", "a hard deadline"],
    ["The handbook doesn't spell out who approves it.", "who approves it"],
    ["The handbook doesn't spell this out for new hires.", "for new hires"],
    ["The handbook has nothing to say about relocation.", "relocation"],
    ["The team names are missing from the passage, so I can't list which teams.", "The team names"],
    // Caught by an earlier wording ("I couldn't find"), so it keeps the topic it always had.
    ["I couldn't find a hard deadline, and the handbook doesn't set one.", "I couldn't find a hard deadline, and the handbook doesn't set one"],
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

  it("removes the eval's missed openers, with the sentences that lean on them", () => {
    // From the eval runs of 2026-10-03; each piece was followed by cited list items.
    expect(
      removeAbsenceClaims(
        "The handbook gives no single cutoff. It leaves the call to the rep, who weighs a few factors when deciding whether a lead stays hands-on or goes self-serve.\n\n- ",
      ),
    ).toEqual({
      text: "- ",
      claims: ["The handbook gives no single cutoff."],
      remarks: ["It leaves the call to the rep, who weighs a few factors when deciding whether a lead stays hands-on or goes self-serve."],
    });
    expect(
      removeAbsenceClaims("The handbook's passages suggest the older data was not recovered, though they don't say this outright. Here is what they do say:\n\n- ").text,
    ).toBe("- ");
    expect(removeAbsenceClaims("The handbook only partly answers this. Ask HR.").text).toBe("Ask HR.");
  });

  it("keeps a lead-in that reports a handbook rule, so the cited text after it keeps its meaning", () => {
    // Taken for a claim, this became "No. The handbook says " + "finish the review within a day…[1]".
    const leadIn = "No. The handbook makes clear you don't have to ";
    expect(removeAbsenceClaims(leadIn, true)).toEqual({ text: leadIn, claims: [], remarks: [] });
  });

  it("handles an unfinished lead-in into cited text as before the added wordings", () => {
    // "The handbook says " + "limit on how much time off you take.[1]" would reverse it.
    for (const leadIn of ["The handbook sets no ", "However, the handbook doesn't put ", "The handbook doesn't spell out "]) {
      expect(removeAbsenceClaims(leadIn, true)).toEqual({ text: leadIn, claims: [], remarks: [] });
    }
    for (const leadIn of ["The handbook doesn't give a street address, but it says ", "The handbook doesn't say how long leave lasts, just that "]) {
      expect(removeAbsenceClaims(leadIn, true)).toEqual({ text: "The handbook says ", claims: [leadIn.trim()], remarks: [] });
    }
  });

  it("names the source in a pronoun lead-in whose sentence went, keeping the rest as written", () => {
    // Kept as it was, "What it does say is that " would open the answer with nothing to refer to.
    const cases = [
      ["The handbook doesn't spell out the street address. What it does say is that ", "What the handbook does say is that "],
      ["The handbook only partly answers this. It says ", "The handbook says "],
      ["The handbook sets no fixed number. Instead, it says ", "Instead, the handbook says "],
      ["The handbook's passages suggest the older data was not recovered. It only describes ", "The handbook only describes "],
      ["The handbook gives no overall timeline. It does say that if the vendor is a subprocessor, ", "The handbook does say that if the vendor is a subprocessor, "],
      ["The handbook sets no maximum. It doesn't put ", "The handbook doesn't put "],
      ["The handbook has nothing on relocation. They only describe ", "The passages only describe "],
      // Needn't refer back, so it stays.
      ["The handbook sets no fixed rule for who decides. It's up to ", "It's up to "],
    ];
    for (const [leadIn, shown] of cases) expect(removeAbsenceClaims(leadIn, true).text).toBe(shown);
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
