import Anthropic from "@anthropic-ai/sdk";
import { SYSTEM_PROMPT } from "./prompt";
import type { AskError } from "./types";

/** Overridable in .env.local. Designed for the Sonnet / Opus family (effort + fallbacks). */
export const ANSWER_MODEL = process.env.CITE_ANSWER_MODEL || "claude-sonnet-5-5";

// Answers are a few sentences; this caps cost per question while leaving room for thinking.
const ANSWER_MAX_TOKENS = 4096;

let client: Anthropic | undefined;
function getClient(): Anthropic {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY; retries 429/5xx twice on its own
  return client;
}

export function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * Ask Claude to answer `question` from the given handbook documents, with citations on.
 *
 * - effort "low": a handbook lookup is a short, chat-style task, and lower effort is faster.
 * - fallbacks "default": if a safety classifier declines the request, the API retries it on
 *   Anthropic's recommended fallback model instead of returning a refusal.
 */
export async function answerWithCitations(
  question: string,
  documents: Anthropic.Beta.BetaRequestDocumentBlock[],
): Promise<Anthropic.Beta.BetaMessage> {
  return getClient().beta.messages.create({
    model: ANSWER_MODEL,
    max_tokens: ANSWER_MAX_TOKENS,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [...documents, { type: "text", text: question }] }],
  });
}

/** Turn an API failure into a message the user can act on. Most specific error class first. */
export function toAskError(error: unknown): AskError {
  if (error instanceof Anthropic.AuthenticationError) {
    return fail("invalid_api_key", "The Anthropic API key was rejected. Check ANTHROPIC_API_KEY in .env.local.", false);
  }
  if (error instanceof Anthropic.PermissionDeniedError || error instanceof Anthropic.NotFoundError) {
    return fail("unavailable", `The model "${ANSWER_MODEL}" isn't available to this API key.`, false);
  }
  if (error instanceof Anthropic.RateLimitError) {
    return fail("rate_limited", "Too many questions at once — wait a moment and try again.", true);
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return fail("unavailable", "Couldn't reach the Anthropic API. Check your internet connection.", true);
  }
  if (error instanceof Anthropic.InternalServerError && error.status === 529) {
    return fail("overloaded", "Claude is overloaded right now — try again in a few seconds.", true);
  }
  if (error instanceof Anthropic.APIError && error.status !== undefined && error.status >= 500) {
    return fail("unavailable", "The Anthropic API had a problem — try again.", true);
  }
  return fail("unavailable", "Something went wrong while answering. The details are in the server log.", false);
}

function fail(code: AskError["code"], message: string, retryable: boolean): AskError {
  return { status: "error", code, message, retryable };
}
