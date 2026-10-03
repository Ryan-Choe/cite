import type Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Chunk } from "../chunk";
import { getIndex, search, type HandbookIndex } from "../search/search";
import { answerWithCitations, hasApiKey } from "./claude";
import { ask } from "./pipeline";

vi.mock("../search/search", () => ({ getIndex: vi.fn(), search: vi.fn() }));
vi.mock("./rewrite", () => ({ rewriteFollowUp: vi.fn(async (question: string) => question) }));
vi.mock("./claude", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./claude")>()), // the real toAskError
  hasApiKey: vi.fn(),
  answerWithCitations: vi.fn(),
}));

const chunk = (id: string, text: string): Chunk => ({
  id,
  sectionTitle: id,
  sectionPath: `contents/handbook/${id.split("#")[0]}.md`,
  headings: [],
  title: id,
  pages: [{ page: 1, text }],
});
const laptops = chunk("spending-money#0", "Laptops are provided.");
const monitors = chunk("spending-money#4", "Monitors are up to $500.");
const equipment = chunk("equipment#2", "Home office equipment is reimbursed up to $1,000.");

/** search() results by query; anything else finds only the laptops chunk. */
function searchFinds(results: Record<string, Chunk[]>) {
  vi.mocked(search).mockImplementation(async (_index, query) =>
    (results[query] ?? [laptops]).map((c) => ({ chunk: c, similarity: 1, via: "semantic" as const })),
  );
}

/** A Claude reply: text blocks, each optionally citing the first paragraph of document `cites`. */
function reply(blocks: { text: string; cites?: { doc: number; text: string } }[], stopReason = "end_turn") {
  return {
    model: "claude-test",
    stop_reason: stopReason,
    usage: { input_tokens: 100, output_tokens: 10 },
    content: blocks.map((b) => ({
      type: "text",
      text: b.text,
      citations: b.cites
        ? [{ type: "content_block_location", document_index: b.cites.doc, start_block_index: 0, end_block_index: 1, cited_text: b.cites.text, document_title: null }]
        : null,
    })),
  } as unknown as Anthropic.Beta.BetaMessage;
}

const partialAnswer = reply([{ text: "Laptops are provided.", cites: { doc: 0, text: "Laptops are provided." } }, { text: "\nGAP: monitor budget" }]);

beforeEach(() => {
  vi.mocked(hasApiKey).mockReturnValue(true);
  vi.mocked(getIndex).mockResolvedValue({} as HandbookIndex);
  searchFinds({});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("ask: failures become AskErrors", () => {
  it("reports a missing API key without searching", async () => {
    vi.mocked(hasApiKey).mockReturnValue(false);
    const { response } = await ask({ question: "laptop?" });
    expect(response).toMatchObject({ status: "error", code: "missing_api_key" });
    expect(search).not.toHaveBeenCalled();
  });

  it("reports an index that won't load as not retryable", async () => {
    vi.mocked(getIndex).mockRejectedValue(new Error("ENOENT: data/index/chunks.json"));
    const { response, trace } = await ask({ question: "laptop?" });
    expect(response).toMatchObject({ status: "error", code: "index_unavailable", retryable: false });
    expect(trace.errorCode).toBe("index_unavailable");
  });

  it("reports a search failure (e.g. the model download failed) as retryable", async () => {
    vi.mocked(search).mockRejectedValue(new TypeError("fetch failed"));
    const { response } = await ask({ question: "laptop?" });
    expect(response).toMatchObject({ status: "error", code: "search_unavailable", retryable: true });
  });

  it("stops waiting for search after 45 s, e.g. while the model is still downloading", async () => {
    vi.useFakeTimers();
    vi.mocked(search).mockReturnValue(new Promise(() => {}));
    const asked = ask({ question: "laptop?" });
    await vi.advanceTimersByTimeAsync(45_000);
    const { response } = await asked;
    expect(response).toMatchObject({ status: "error", code: "search_unavailable", retryable: true });
    expect(response.status === "error" && response.message).toContain("still loading");
  });

  it("turns an unexpected bug into an internal_error instead of throwing", async () => {
    vi.mocked(answerWithCitations).mockResolvedValue({ ...partialAnswer, content: undefined } as unknown as Anthropic.Beta.BetaMessage);
    const { response, trace } = await ask({ question: "laptop?" });
    expect(response).toMatchObject({ status: "error", code: "internal_error" });
    expect(trace.status).toBe("error");
  });
});

describe("ask: gap re-search", () => {
  it("searches each gap and answers again with the passages it finds", async () => {
    searchFinds({ "monitor budget": [laptops, monitors] });
    vi.mocked(answerWithCitations)
      .mockResolvedValueOnce(partialAnswer)
      .mockResolvedValueOnce(reply([{ text: "Monitors are up to $500.", cites: { doc: 1, text: "Monitors are up to $500." } }]));

    const { response, trace } = await ask({ question: "laptop and monitor?" });

    const [firstCall, secondCall] = vi.mocked(answerWithCitations).mock.calls;
    expect(secondCall[1].map((d) => d.title)).toEqual(["spending-money#0", "spending-money#4"]);
    expect(firstCall[2]).toBeUndefined(); // the first call keeps the SDK's retries
    expect(secondCall[2]).toMatchObject({ maxRetries: 0 }); // the second is optional, so it doesn't retry
    expect(response).toMatchObject({ status: "answered", gaps: [], citations: [{ sectionTitle: "spending-money#4" }] });
    expect(trace.research).toEqual({ first: "answered", queries: ["monitor budget"], added: ["spending-money#4"], outcome: "used-second" });
    expect(trace.usage).toEqual({ input: 200, output: 20 }); // both calls
  });

  it("re-searches an absence claim that slips past the prompt, by its topic, and shows it as a gap", async () => {
    vi.mocked(answerWithCitations).mockResolvedValueOnce(
      reply([{ text: "Laptops are provided.", cites: { doc: 0, text: "Laptops are provided." } }, { text: " The handbook doesn't say who orders replacement laptops." }]),
    );
    const { response } = await ask({ question: "laptop?" });
    expect(search).toHaveBeenCalledWith(expect.anything(), "who orders replacement laptops");
    expect(response).toMatchObject({ status: "answered", gaps: ["who orders replacement laptops"], parts: [{ text: "Laptops are provided." }] });
  });

  it("keeps the first answer, gaps and all, when the re-search finds nothing new", async () => {
    vi.mocked(answerWithCitations).mockResolvedValueOnce(partialAnswer);
    const { response, trace } = await ask({ question: "laptop?" });
    expect(answerWithCitations).toHaveBeenCalledTimes(1);
    expect(response).toMatchObject({ status: "answered", gaps: ["monitor budget"] });
    expect(trace.research).toEqual({ first: "answered", queries: ["monitor budget"], added: [], outcome: "no-new-passages" });
  });

  it("keeps the first answer, and its model, when the second call fails", async () => {
    searchFinds({ "monitor budget": [monitors] });
    vi.mocked(answerWithCitations)
      .mockResolvedValueOnce(partialAnswer)
      .mockRejectedValueOnce(new Error("overloaded"));
    const { response, trace } = await ask({ question: "laptop?" });
    expect(response).toMatchObject({ status: "answered", gaps: ["monitor budget"] });
    expect(trace.research?.outcome).toBe("second-call-failed");
    expect(trace.model).toBe("claude-test");
  });

  it("keeps a partial first answer over a second-pass 'not covered'", async () => {
    searchFinds({ "monitor budget": [monitors] });
    vi.mocked(answerWithCitations).mockResolvedValueOnce(partialAnswer).mockResolvedValueOnce(reply([{ text: "NOT_COVERED" }]));
    const { response, trace } = await ask({ question: "laptop?" });
    expect(response).toMatchObject({ status: "answered", gaps: ["monitor budget"] });
    expect(trace.research?.outcome).toBe("kept-first");
  });

  it("searches the gaps a 'not covered' reply names, and answers from what that finds", async () => {
    searchFinds({ "home office equipment": [equipment] });
    vi.mocked(answerWithCitations)
      .mockResolvedValueOnce(reply([{ text: "NOT_COVERED\nGAP: home office equipment" }]))
      .mockResolvedValueOnce(reply([{ text: "It's reimbursed up to $1,000.", cites: { doc: 1, text: "Home office equipment is reimbursed up to $1,000." } }]));
    const { response, trace } = await ask({ question: "can I get money back for my chair?" });
    expect(answerWithCitations).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({ status: "answered", citations: [{ sectionTitle: "equipment#2" }] });
    expect(trace.research).toEqual({ first: "not-covered", queries: ["home office equipment"], added: ["equipment#2"], outcome: "used-second" });
  });

  it("keeps a 'not covered' verdict when the second answer cites only passages Claude already said don't answer it", async () => {
    vi.mocked(getIndex).mockResolvedValue({ byId: new Map([[equipment.id, equipment]]) } as HandbookIndex);
    searchFinds({ "home office equipment": [equipment] });
    vi.mocked(answerWithCitations)
      .mockResolvedValueOnce(reply([{ text: "NOT_COVERED\nGAP: home office equipment" }]))
      .mockResolvedValueOnce(reply([{ text: "Laptops are provided.", cites: { doc: 0, text: "Laptops are provided." } }]));
    const { response, trace } = await ask({ question: "can I get money back for my chair?" });
    expect(response).toMatchObject({ status: "not-covered", alsoSearchedFor: ["home office equipment"] });
    expect(trace.research?.outcome).toBe("kept-first");
  });

  it("searches every gap line, though near-duplicates are merged for display", async () => {
    vi.mocked(getIndex).mockResolvedValue({ byId: new Map() } as HandbookIndex);
    vi.mocked(answerWithCitations).mockResolvedValueOnce(
      reply([{ text: "NOT_COVERED\nGAP: maximum days of sick leave\nGAP: maximum days of parental leave\nGAP: sick leave" }]),
    );
    const { response } = await ask({ question: "how much leave?" });
    for (const query of ["maximum days of sick leave", "maximum days of parental leave", "sick leave"]) {
      expect(search).toHaveBeenCalledWith(expect.anything(), query);
    }
    expect(response).toMatchObject({ alsoSearchedFor: ["maximum days of sick leave", "maximum days of parental leave"] });
  });

  it("when both tries find nothing, lists the gap search's sections first and says what it searched for", async () => {
    vi.mocked(getIndex).mockResolvedValue({ byId: new Map([[equipment.id, equipment]]) } as HandbookIndex);
    searchFinds({ "home office equipment": [equipment] });
    vi.mocked(answerWithCitations)
      .mockResolvedValueOnce(reply([{ text: "NOT_COVERED\nGAP: home office equipment" }]))
      .mockResolvedValueOnce(reply([{ text: "NOT_COVERED" }]));
    const { response } = await ask({ question: "can I get money back for my chair?" });
    expect(response).toEqual({
      status: "not-covered",
      searchedFor: "can I get money back for my chair?",
      closest: [
        { title: "equipment#2", page: 1 },
        { title: "spending-money#0", page: 1 },
      ],
      alsoSearchedFor: ["home office equipment"],
    });
  });

  it("keeps the first answer when the gap search itself fails", async () => {
    vi.mocked(search).mockResolvedValueOnce([{ chunk: laptops, similarity: 1, via: "semantic" as const }]).mockRejectedValueOnce(new Error("boom"));
    vi.mocked(answerWithCitations).mockResolvedValueOnce(partialAnswer);
    const { response, trace } = await ask({ question: "laptop?" });
    expect(response).toMatchObject({ status: "answered", gaps: ["monitor budget"] });
    expect(answerWithCitations).toHaveBeenCalledTimes(1);
    expect(trace.research?.outcome).toBe("failed");
  });

  it("keeps the first answer when the gap search hangs", async () => {
    vi.useFakeTimers();
    vi.mocked(search).mockResolvedValueOnce([{ chunk: laptops, similarity: 1, via: "semantic" as const }]).mockReturnValueOnce(new Promise(() => {}));
    vi.mocked(answerWithCitations).mockResolvedValueOnce(partialAnswer);
    const asked = ask({ question: "laptop?" });
    await vi.advanceTimersByTimeAsync(45_000);
    expect((await asked).response).toMatchObject({ status: "answered", gaps: ["monitor budget"] });
  });

  it("doesn't re-search an answer with no gaps", async () => {
    vi.mocked(answerWithCitations).mockResolvedValueOnce(reply([{ text: "Yes.", cites: { doc: 0, text: "Laptops are provided." } }]));
    const { trace } = await ask({ question: "laptop?" });
    expect(search).toHaveBeenCalledTimes(1);
    expect(trace.research).toBeUndefined();
  });
});
