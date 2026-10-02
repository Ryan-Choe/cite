import { ask } from "@/lib/answer/pipeline";
import { MAX_QUESTION_CHARS, type AskError, type AskRequest } from "@/lib/answer/types";

const HTTP_STATUS: Record<AskError["code"], number> = {
  invalid_question: 400,
  missing_api_key: 503,
  invalid_api_key: 502,
  rate_limited: 429,
  overloaded: 503,
  refused: 422,
  unavailable: 502,
};

export async function POST(request: Request) {
  const parsed = parseRequest(await request.json().catch(() => null));
  if ("status" in parsed) return Response.json(parsed, { status: 400 });

  const { response, trace } = await ask(parsed);
  console.log(`[ask] ${JSON.stringify(trace)}`);
  return Response.json(response, { status: response.status === "error" ? HTTP_STATUS[response.code] : 200 });
}

function parseRequest(body: unknown): AskRequest | AskError {
  const invalid = (message: string): AskError => ({ status: "error", code: "invalid_question", message, retryable: false });
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
  return { question, history: validHistory };
}
