/** The contract between the /api/ask route and the chat page. */

export const MAX_QUESTION_CHARS = 500;

export interface AskRequest {
  question: string;
  /** Earlier exchanges in this conversation, oldest first (used to rewrite follow-ups). */
  history?: { question: string; searchedFor: string }[];
}

/** One numbered citation card under an answer. */
export interface Citation {
  n: number; // the marker number, as in [1]
  sectionTitle: string;
  title: string; // full heading trail, e.g. "Time off › Permissionless time off"
  pages: number[];
  quote: string; // the exact handbook paragraph(s) Claude cited
}

/** A run of answer text, followed by the markers of the citations that support it. */
export interface AnswerPart {
  text: string;
  citations: number[];
}

export interface SectionLink {
  title: string;
  page: number;
}

export type AskResult =
  | { status: "answered"; parts: AnswerPart[]; citations: Citation[]; searchedFor: string }
  | { status: "not-covered"; closest: SectionLink[]; searchedFor: string };

export type AskErrorCode =
  | "invalid_question"
  | "missing_api_key"
  | "invalid_api_key"
  | "rate_limited"
  | "overloaded"
  | "refused"
  | "unavailable";

export interface AskError {
  status: "error";
  code: AskErrorCode;
  message: string; // shown to the user as-is
  retryable: boolean;
}

export type AskResponse = AskResult | AskError;
