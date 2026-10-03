import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ask } from "@/lib/answer/pipeline";
import type { AskResponse } from "@/lib/answer/types";
import { POST } from "./route";

vi.mock("@/lib/answer/pipeline", () => ({ ask: vi.fn() }));

const notCovered: AskResponse = { status: "not-covered", closest: [], searchedFor: "q" };

function post(body: unknown, headers: Record<string, string> = {}, url = "http://localhost:3000/api/ask") {
  return POST(
    new Request(url, {
      method: "POST",
      headers: { host: new URL(url).host, "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.mocked(ask).mockResolvedValue({ response: notCovered, trace: { question: "q", searchedFor: "q", retrieved: [], status: "not-covered", ms: { total: 1 } } });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.resetAllMocks());

describe("POST /api/ask: who may ask", () => {
  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])("answers the chat page at %s", async (origin) => {
    const res = await post({ question: "laptop?" }, { origin }, `${origin}/api/ask`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(notCovered);
  });

  it("answers a local request with no Origin (curl, the eval)", async () => {
    expect((await post({ question: "laptop?" })).status).toBe(200);
  });

  it.each([
    ["another website", { origin: "https://evil.example" }],
    ["another local server", { origin: "http://localhost:5173" }],
    ["a sandboxed page", { origin: "null" }],
    ["DNS rebinding (a foreign Host)", { host: "attacker.example:3000" }],
  ])("refuses %s without spending anything", async (_case, headers) => {
    const res = await post({ question: "laptop?" }, headers);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ status: "error", code: "forbidden" });
    expect(ask).not.toHaveBeenCalled();
  });
});

describe("POST /api/ask: what may be sent", () => {
  it("refuses a non-JSON body, which other sites could send without a CORS preflight", async () => {
    const res = await post('{"question":"laptop?"}', { "content-type": "text/plain;charset=UTF-8" });
    expect(res.status).toBe(415);
    expect(ask).not.toHaveBeenCalled();
  });

  it("accepts a JSON content type with parameters", async () => {
    expect((await post({ question: "laptop?" }, { "content-type": "application/json; charset=utf-8" })).status).toBe(200);
  });

  it("refuses an oversized body, whether or not it says so up front", async () => {
    expect((await post({ question: "x" }, { "content-length": "99999" })).status).toBe(413);
    expect((await post({ question: "x", padding: "y".repeat(20_000) })).status).toBe(413);
    expect(ask).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{bad"],
    ["a blank question", { question: "   " }],
    ["an over-long question", { question: "x".repeat(501) }],
    ["an over-long earlier question", { question: "q", history: [{ question: "q", searchedFor: "x".repeat(501) }] }],
  ])("rejects %s", async (_case, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "invalid_question" });
  });

  it("passes on only the last 3 earlier exchanges", async () => {
    const history = ["a", "b", "c", "d", "e"].map((q) => ({ question: q, searchedFor: q }));
    await post({ question: "and?", history });
    expect(vi.mocked(ask).mock.calls[0][0].history?.map((h) => h.question)).toEqual(["c", "d", "e"]);
  });
});

describe("POST /api/ask: errors", () => {
  it("still answers with an AskError if something throws", async () => {
    vi.mocked(ask).mockRejectedValue(new Error("bug"));
    const res = await post({ question: "laptop?" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ status: "error", code: "internal_error" });
  });
});
