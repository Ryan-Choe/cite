import { ask } from "@/lib/answer/pipeline";
import {
  askError,
  MAX_HISTORY,
  MAX_QUESTION_CHARS,
  type AskError,
  type AskErrorCode,
  type AskRequest,
  type AskResponse,
} from "@/lib/answer/types";

const HTTP_STATUS: Record<AskErrorCode, number> = {
  invalid_question: 400,
  forbidden: 403,
  payload_too_large: 413,
  unsupported_media_type: 415,
  missing_api_key: 503,
  invalid_api_key: 502,
  rate_limited: 429,
  overloaded: 503,
  refused: 422,
  index_unavailable: 500,
  search_unavailable: 503,
  unavailable: 502,
  internal_error: 500,
};

// A question (≤500 chars) plus up to 3 earlier exchanges is a few KB of JSON; anything far bigger
// didn't come from the chat page.
const MAX_BODY_CHARS = 16_000;
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function POST(request: Request) {
  try {
    const rejected = checkCaller(request) ?? checkBodyType(request);
    if (rejected) return reply(rejected);

    if (Number(request.headers.get("content-length")) > MAX_BODY_CHARS) return reply(tooLarge());
    const body = await request.text();
    if (body.length > MAX_BODY_CHARS) return reply(tooLarge());

    const parsed = parseRequest(parseJson(body));
    if ("status" in parsed) return reply(parsed);

    const { response, trace } = await ask(parsed);
    console.log(`[ask] ${JSON.stringify(trace)}`);
    return reply(response);
  } catch (error) {
    // ask() doesn't throw, so this is a bug in the route itself; still answer in the AskResponse shape.
    console.error("[ask] request failed:", error);
    return reply(askError("internal_error", "Something went wrong on the server. The details are in the server log."));
  }
}

function reply(response: AskResponse): Response {
  return Response.json(response, { status: response.status === "error" ? HTTP_STATUS[response.code] : 200 });
}

/**
 * Each question spends the owner's API credit, so only the chat page on this machine may ask.
 * `npm run dev` listens on 127.0.0.1 only; checking Host also stops DNS rebinding (an attacker's
 * domain pointed at 127.0.0.1), and checking that Origin is this same origin stops other websites,
 * including other local servers, from posting here.
 */
function checkCaller(request: Request): AskError | null {
  const host = (request.headers.get("host") ?? new URL(request.url).host).toLowerCase();
  const origin = request.headers.get("origin");
  const sameOrigin = origin === null || hostOf(origin) === host;
  if (LOCAL_HOSTNAMES.has(hostOf(`http://${host}`, "hostname")) && sameOrigin) return null;
  return askError("forbidden", "Cite only answers questions from its own page on this computer: open it at http://localhost:3000.");
}

/** The host ("localhost:3000") or hostname ("localhost") of a URL, or "" if it isn't one (e.g. Origin "null"). */
function hostOf(url: string, part: "host" | "hostname" = "host"): string {
  try {
    return new URL(url)[part];
  } catch {
    return "";
  }
}

/** Require a JSON body. Cross-site pages can only send JSON after a CORS preflight, which this route doesn't allow. */
function checkBodyType(request: Request): AskError | null {
  const type = request.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  if (type === "application/json") return null;
  return askError("unsupported_media_type", "Send the question as JSON (Content-Type: application/json).");
}

function tooLarge(): AskError {
  return askError("payload_too_large", "This request is too large to be a question.");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

function parseRequest(body: unknown): AskRequest | AskError {
  const invalid = (message: string) => askError("invalid_question", message);
  if (typeof body !== "object" || body === null) return invalid("Send a JSON body with a question.");

  const { question, history } = body as Record<string, unknown>;
  if (typeof question !== "string" || question.trim() === "") return invalid("Type a question first.");
  if (question.length > MAX_QUESTION_CHARS) return invalid(`Questions are limited to ${MAX_QUESTION_CHARS} characters.`);

  const validHistory = Array.isArray(history)
    ? history.filter(
        (h): h is { question: string; searchedFor: string } =>
          typeof h?.question === "string" && typeof h?.searchedFor === "string",
      )
    : [];
  // Every earlier question goes to the rewrite model, so bound them like the question itself.
  if (validHistory.some((h) => h.question.length > MAX_QUESTION_CHARS || h.searchedFor.length > MAX_QUESTION_CHARS)) {
    return invalid(`Earlier questions are limited to ${MAX_QUESTION_CHARS} characters.`);
  }
  return { question, history: validHistory.slice(-MAX_HISTORY) };
}
