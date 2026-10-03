/** The contract between the /api/ask route and the chat page. */

export const MAX_QUESTION_CHARS = 500;
/** Earlier exchanges sent along with a question, for rewriting follow-ups. The server keeps at most this many. */
export const MAX_HISTORY = 3;

export interface AskRequest {
  question: string;
  /** Earlier exchanges in this conversation, oldest first (used to rewrite follow-ups). */
  history?: { question: string; searchedFor: string }[];
}

/** One numbered citation card under an answer. */
export interface Citation {
  n: number; // the marker number, as in [1]
  sectionTitle: string;
  sectionPath: string; // e.g. contents/handbook/people/time-off.md
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
  | {
      status: "answered";
      parts: AnswerPart[];
      citations: Citation[];
      gaps: string[]; // parts of the question that the passages searched didn't answer, e.g. "approval needed for a side gig"
      searchedFor: string;
    }
  | {
      status: "not-covered";
      closest: SectionLink[];
      searchedFor: string;
      /** What the gap re-search also searched for (in the handbook's likely wording), if it ran. */
      alsoSearchedFor: string[];
    };

export type AskErrorCode =
  | "invalid_question"
  | "forbidden"
  | "payload_too_large"
  | "unsupported_media_type"
  | "missing_api_key"
  | "invalid_api_key"
  | "rate_limited"
  | "overloaded"
  | "refused"
  | "index_unavailable"
  | "search_unavailable"
  | "unavailable"
  | "internal_error";

export interface AskError {
  status: "error";
  code: AskErrorCode;
  message: string; // shown to the user as-is
  retryable: boolean;
}

export type AskResponse = AskResult | AskError;

export function askError(code: AskErrorCode, message: string, retryable = false): AskError {
  return { status: "error", code, message, retryable };
}
