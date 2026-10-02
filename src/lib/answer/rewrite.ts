import { getClient } from "./claude";
import type { AskRequest } from "./types";

/** A small, fast model is plenty for rewriting one question. Overridable in .env.local. */
export const REWRITE_MODEL = process.env.CITE_REWRITE_MODEL || "claude-haiku-4-5";

const REWRITE_SYSTEM = `You rewrite follow-up questions so they can be searched on their own.

You get the earlier questions in a conversation about the PostHog company handbook, then the latest message. Rewrite the latest message as one standalone question that makes sense without the conversation: replace words like "it", "that" or "they" with what they refer to, and fill in anything implied by the earlier questions.

If the latest message is already standalone, or is about a new topic, return it unchanged. Don't answer it, and don't add details that weren't asked. Reply with the question only.`;

const MAX_REWRITE_CHARS = 300;

export function buildRewritePrompt(question: string, history: NonNullable<AskRequest["history"]>): string {
  const earlier = history.map((h, i) => `${i + 1}. ${h.searchedFor}`).join("\n");
  return `Earlier questions, oldest first:\n${earlier}\n\nLatest message: ${question}`;
}

/** Take the model's reply as the standalone question, or fall back to the original if it looks wrong. */
export function cleanRewrite(reply: string, original: string): string {
  const text = reply.trim().replace(/^["'“]|["'”]$/g, "").trim();
  return text && text.length <= MAX_REWRITE_CHARS ? text : original;
}

/**
 * Turn a follow-up ("is it paid?") into a standalone question ("Is parental leave paid?").
 * The first question in a conversation skips the call. If the call fails, the original
 * question is used: a literal search is a better outcome than an error.
 */
export async function rewriteFollowUp(question: string, history: AskRequest["history"] = []): Promise<string> {
  if (history.length === 0) return question;
  try {
    const message = await getClient().messages.create({
      model: REWRITE_MODEL,
      max_tokens: 200,
      system: REWRITE_SYSTEM,
      messages: [{ role: "user", content: buildRewritePrompt(question, history) }],
    });
    const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return cleanRewrite(text, question);
  } catch (error) {
    console.warn("[ask] follow-up rewrite failed; searching the original question:", error);
    return question;
  }
}
