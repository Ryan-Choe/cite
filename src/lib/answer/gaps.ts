/**
 * Gaps: parts of a question that the passages Claude saw don't answer.
 *
 * Claude sees only the top search results, never the whole handbook, so "the handbook doesn't say X"
 * is a claim it can't check. In the eval it was sometimes false: the handbook did say X, but search
 * had missed that passage. So the prompt asks Claude to list each gap on its own "GAP: …" line instead
 * of writing about it, and an uncited absence claim that slips through is taken out of the answer
 * and listed as a gap too. The pipeline searches each gap once more, and the UI shows what's left as
 * "not found in the passages searched", never as a fact about the handbook.
 */

export const GAP_PREFIX = "GAP:";

// A whole "GAP: …" line, including its line break. Tolerates the list marker, bold or lower case
// Claude might add ("- GAP: …", "**Gap:** …"), but not "GAP:" in the middle of a sentence.
const GAP_LINE = /^[ \t]*(?:[-*•][ \t]+|\d+[.)][ \t]+)?(?:\*\*)?GAP(?:\*\*)?[ \t]*:(?:\*\*)?[ \t]*(.*?)[ \t]*(?:\r?\n|$)/gim;

/** Remove the "GAP: …" lines from text. Returns the remaining text and the gaps, in order. */
export function extractGapLines(text: string): { text: string; gaps: string[] } {
  const gaps: string[] = [];
  const rest = text.replace(GAP_LINE, (_line, gap: string) => {
    const cleaned = gap.replace(/^["'“*]+|["'”*]+$/g, "").trim();
    if (cleaned) gaps.push(cleaned);
    return "";
  });
  return { text: rest, gaps };
}

// "The handbook doesn't say…", "The passages I have don't mention…": a statement about what the
// source lacks. The subject comes first, so "The handbook says you don't need to…" doesn't match.
const SOURCE = String.raw`\b(?:handbook|passages?|excerpts?)\b`;
const BETWEEN = String.raw`(?:\s+(?!(?:says|states|notes|explains|adds|recommends)\b)[\w'’-]+){0,3}?`;
const NOT = String.raw`(?:does\s+not|do\s+not|is\s+not|are\s+not|cannot|can\s+not|doesn['’]t|don['’]t|isn['’]t|aren['’]t|can['’]t|never)`;
const VERB = String.raw`(?:say|state|mention|name|cover|describe|specify|address|list|give|include|explain|detail|discuss|provide|clarify|define|indicate|show|confirm|outline)s?`;
const ABSENCE = String.raw`${SOURCE}${BETWEEN}\s+${NOT}(?:\s+[\w'’-]+){0,2}?\s+${VERB}\b`;
// Other phrasings, each tied to the source or to Claude itself, so that handbook facts such as
// "you don't need approval" never match.
const ABSENCE_OTHER = [
  String.raw`\b(?:nothing|no\s+mention)\b[^.!?\n]{0,30}\b(?:in|from)\s+(?:the|these|my)\s+(?:handbook|passages?|excerpts?)\b`,
  String.raw`${SOURCE}[^.!?\n]{0,20}\b(?:is|are)\s+silent\b`,
  String.raw`${SOURCE}[^.!?\n]{0,20}\bmakes?\s+no\s+mention\b`,
  String.raw`\bnot\s+in\s+the\s+(?:passages?|excerpts?)\b`,
  String.raw`\bI\s+(?:couldn['’]t|could\s+not|can['’]t|cannot)\s+find\b`,
];
const ABSENCE_ANY = new RegExp([ABSENCE, ...ABSENCE_OTHER].join("|"), "i");

// A sentence end ("." "!" "?", with any [n] markers after it) or a line break, captured so that
// split() keeps it: sentence, break, sentence, break, …
const SENTENCE_BREAK = /((?<=[.!?](?:\[\d+\])*)\s+|\n+)/;

/** Sentences that claim the handbook (or the passages) doesn't say something. */
export function findAbsenceClaims(text: string): string[] {
  return text
    .split(SENTENCE_BREAK)
    .filter((_, i) => i % 2 === 0)
    .map((sentence) => sentence.trim())
    .filter((sentence) => ABSENCE_ANY.test(sentence));
}

// Remarks about the passages themselves ("The passages only partly cover this.", "None of these
// excerpts mention a cliff."): they describe what Claude was shown, not the handbook, and the gap
// lines already say what's missing. The subject must be the passages, so handbook framing such as
// "The handbook lists three steps:" stays.
const PASSAGES = String.raw`(?:handbook\s+)?(?:provided\s+|available\s+)?(?:passages?|excerpts?)\b`;
const SOURCE_REMARK = new RegExp(
  String.raw`^(?:(?:the|these|those|my)\s+${PASSAGES}|(?:none|neither)\s+of\s+(?:the|these|those)\s+${PASSAGES}|nothing\s+(?:here|in\s+(?:the|these)\s+${PASSAGES})|there(?:['’]s|\s+is)\s+no\s+mention\b)`,
  "i",
);
// A sentence that leans on one just removed ("They only describe how the comparison works.",
// "What they do say is that …").
const DANGLING = /^(?:(?:what|here['’]s\s+what)\s+)?(?:they|it|these|those)\b/i;
// What an unfinished lead-in into the next (cited) run becomes when it has to go: the cited text
// continues the sentence, so deleting the lead-in would leave it starting mid-sentence.
const ATTRIBUTION = "The handbook says ";

/**
 * Take the absence claims, and remarks about the passages, out of a run of answer text. A sentence
 * starting with a pronoun right after a removed one goes too, since it would make no sense alone.
 * Each removed sentence goes with the break after it, but any space before it stays, so the text
 * around it doesn't run together. When the text runs on into a cited run (`leadsIntoCitation`), an
 * unfinished last piece ("It says ", "What they do say is that ") is the start of the cited sentence,
 * so instead of going it becomes "The handbook says ". Only claims carry a topic worth searching
 * for; remarks are dropped.
 */
export function removeAbsenceClaims(
  text: string,
  leadsIntoCitation = false,
): { text: string; claims: string[]; remarks: string[] } {
  const pieces = text.split(SENTENCE_BREAK);
  const claims: string[] = [];
  const remarks: string[] = [];
  let rest = "";
  let removedPrevious = false;
  for (let i = 0; i < pieces.length; i += 2) {
    const sentence = pieces[i];
    const trimmed = sentence.trim();
    const claim = trimmed !== "" && ABSENCE_ANY.test(sentence);
    const remark = !claim && trimmed !== "" && (SOURCE_REMARK.test(trimmed) || (removedPrevious && DANGLING.test(trimmed)));
    if (claim) claims.push(trimmed);
    if (remark) remarks.push(trimmed);
    const unfinished = leadsIntoCitation && i === pieces.length - 1 && trimmed !== "" && !/[.!?:]$/.test(trimmed);
    if ((claim || remark) && unfinished) {
      rest += sentence.match(/^\s*/)![0] + ATTRIBUTION;
    } else if (claim || remark) {
      rest += sentence.match(/^\s*/)![0];
      removedPrevious = true;
    } else {
      rest += sentence + (pieces[i + 1] ?? "");
      if (trimmed !== "") removedPrevious = false;
    }
  }
  return { text: rest, claims, remarks };
}

/**
 * The topic of an absence claim, as a search phrase: "The handbook doesn't say whether you need
 * approval for a side gig, so…" → "you need approval for a side gig". Searching the negated sentence
 * as a whole finds the missing passage less often than searching just its topic.
 */
export function absenceTopic(sentence: string): string {
  const lead = new RegExp(`${ABSENCE}\\s*(?:(?:anything|any|whether|that|if|about)\\s+)*`, "i");
  const match = lead.exec(sentence);
  const topic = match ? sentence.slice(match.index + match[0].length) : sentence;
  return topic
    .replace(/(?:[,;]\s+|\s+)so\s+(?:I|you|it|they|there|this|that|we|one|no|nothing)\b.*$/i, "") // drop the conclusion drawn from the gap
    .replace(/,?\s+but\s+(?:they|it|these|this|the\s+(?:handbook|passages?|excerpts?))\b.*$/i, "") // and what the source does say
    .replace(/[.!?]+$/, "")
    .trim();
}

// Words that say nothing about a topic on their own.
const VAGUE_WORDS = new Set(
  ("a an the this that these those it its them they their he she him her here there what which who how when where why " +
    "whether if any anything about beyond than of to in on for and or with by from at as is are be was were do does " +
    "includes include included more other else such").split(" "),
);

/** The words in a phrase that say something about its topic, lower-cased. */
export function meaningfulWords(phrase: string): string[] {
  return (phrase.toLowerCase().match(/[\p{L}\p{N}$]+/gu) ?? []).filter((word) => !VAGUE_WORDS.has(word));
}

/** Whether a phrase says enough to search for on its own: at least two meaningful words. */
export function isSearchable(phrase: string): boolean {
  return meaningfulWords(phrase).length >= 2;
}

/**
 * The gaps to show, without repeats: a gap is dropped when all its meaningful words are in an
 * earlier one, or an earlier one's are all in it ("vesting schedule" after "the vesting schedule
 * for share options"). Gaps that differ in a meaningful word ("sick leave days" and "parental leave
 * days") are both kept. The first wording is kept. For display only: every gap is searched.
 */
export function dedupeGaps(gaps: string[]): string[] {
  const kept: { gap: string; words: Set<string> }[] = [];
  const within = (a: Set<string>, b: Set<string>) => [...a].every((w) => b.has(w));
  for (const gap of gaps) {
    const words = new Set(meaningfulWords(gap));
    if (!kept.some((k) => within(words, k.words) || within(k.words, words))) kept.push({ gap, words });
  }
  return kept.map((k) => k.gap);
}
