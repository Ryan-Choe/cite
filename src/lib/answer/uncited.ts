import type { AnswerPart } from "./types";

// Uncited runs that make no claim: separators, list markers, joining words, attributions that run on
// into cited text ("The handbook says ", "It also adds that "), and lead-ins ending in ":".
const LIST_MARKER = /^[ \t]*(?:[-*•]|\d+[.)])[ \t]*/gm;
const CONNECTIVE = /^(?:and|or|but|also|so|then|plus|while|whereas)$/i;
const ATTRIBUTION = /^(?:the handbook|it|they)\s+(?:also\s+)?(?:says?|adds?|notes?|states?|explains?)(?:\s+that)?$/i;

/**
 * Whether a run of answer text says something with no citation behind it. Short runs count too:
 * an uncited "No." or "You don't need approval." is exactly the kind of conclusion to flag.
 */
export function isUncitedClaim(part: AnswerPart): boolean {
  if (part.citations.length > 0) return false;
  const text = part.text.replace(LIST_MARKER, "").trim();
  const words = text.replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
  if (words === "" || CONNECTIVE.test(words) || ATTRIBUTION.test(words)) return false;
  return !text.endsWith(":"); // "What the handbook does cover:" introduces cited text
}
