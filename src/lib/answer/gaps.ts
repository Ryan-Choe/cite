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

// Wordings added after the eval runs of 2026-10-03, which let through "The handbook gives no single
// cutoff" and "The handbook doesn't set a hard deadline" (both false). Their verbs often report a rule
// instead ("The handbook makes clear you don't have to…", "PostHog doesn't offer…"), so they're held
// to more than the wordings above. The source must be the subject of the negation: only words that
// qualify it ("passages I've been given", "as excerpted here") may stand between them, and not the
// object of a preposition ("Changes to the handbook don't have to…"). Only an adverb may stand between
// the negation and the verb ("doesn't explicitly spell out", not "doesn't try to spell out").
const SUBJECT = String.raw`(?<!\b(?:to|of|in|into|from|for|on|about|with|by|per)\s+(?:(?:the|this|our)\s+)?)${SOURCE}`;
const QUALIFIER = String.raw`(?:passages?|excerpts?|sections?|(?:in|from|of)\s+the\s+handbook|I\s+(?:have|was|were|got|can\s+see)|I['’]ve|we\s+(?:have|were|got)|have|been|was|were|given|shown|shared(?:\s+with\s+me)?|provided|available|retrieved|as\s+excerpted|here|above|itself|also|still|actually|really|unfortunately)`;
const QUALIFIED = String.raw`${SUBJECT}(?:\s+${QUALIFIER}\b){0,3}?`;
const NOT_ADVERB = String.raw`${NOT}(?:\s+(?:explicitly|specifically|clearly|directly|really|actually|fully|exactly|even))?`;
// "Says nothing" alone isn't enough: "The handbook says nothing ships without sign-off" reports a rule.
const NOTHING = String.raw`nothing\s+(?:(?:to\s+say|specific)\s+)?(?:about|regarding|on(?!\s+top\b))\b`;
// Not "from the handbook": "If something is missing from the handbook, open a pull request" is the
// handbook's own advice.
const MISSING = String.raw`\b(?:is|are|was|were)\s+(?:missing|absent)\s+from\s+(?:the|these|those|my)\s+(?:passages?|excerpts?)\b`;
// "The handbook doesn't spell this out", "The passages say nothing about pay".
const SPELLED_OUT = String.raw`${QUALIFIED}\s+${NOT_ADVERB}\s+(?:spell|lay)s?(?:\s+(?:it|this|that|these|those|them))?\s+out\b`;
const SAYS_NOTHING = String.raw`${QUALIFIED}\s+(?:(?:say|state|mention|give|offer|provide|contain|include)s?|has|have)\s+${NOTHING}`;
const ABSENCE_ANY = new RegExp([ABSENCE, ...ABSENCE_OTHER, SPELLED_OUT, SAYS_NOTHING, MISSING].join("|"), "i");

// Added wordings that can also report a rule: "The handbook doesn't set a hard deadline" was false,
// but "The handbook sets no limit on time off" may paraphrase its unlimited time off. A citation tells
// them apart, so these count only in uncited text, which is unsupported either way. "Says no" is left
// out ("The handbook says no approval is needed"), and so are "doesn't have to", "no more than", "no
// one", "no objections", "no-meeting days" and "No Meeting Days".
const NO = String.raw`no\b(?![-'’])(?!\s+(?:more|less|fewer|later|earlier|longer|sooner|one|problems?|issues?|shortage|objections?|meetings?)\b)`;
const UNCITED_ONLY = [
  String.raw`${QUALIFIED}\s+${NOT_ADVERB}\s+(?:set|have(?!\s+to\b)|offer|put|contain)s?(?:\s+out)?\b`,
  String.raw`${QUALIFIED}\s+(?:(?:give|set|offer|provide|list|name|include|contain|mention|put|lay|spell)s?(?:\s+out)?|has|have|specif(?:y|ies))\s+${NO}`,
];
const ABSENCE_UNCITED = new RegExp([ABSENCE, ...ABSENCE_OTHER, SPELLED_OUT, SAYS_NOTHING, MISSING, ...UNCITED_ONLY].join("|"), "i");
// The wordings from before 2026-10-03. An unfinished lead-in into cited text is judged by these alone,
// as it was then: with an added wording, the cited text may be what the lead-in negates ("The handbook
// sets no " + "limit on time off."), and turning it into "The handbook says " would reverse it.
const EARLIER_ABSENCE = new RegExp([ABSENCE, ...ABSENCE_OTHER].join("|"), "i");

// A sentence end ("." "!" "?", with any [n] markers after it) or a line break, captured so that
// split() keeps it: sentence, break, sentence, break, …
const SENTENCE_BREAK = /((?<=[.!?](?:\[\d+\])*)\s+|\n+)/;

/**
 * Sentences that claim the handbook (or the passages) doesn't say something. Wordings that can also
 * report a rule ("The handbook sets no limit") aren't counted here: removeAbsenceClaims takes them
 * out of uncited text.
 */
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
const EARLIER_REMARK = new RegExp(
  String.raw`^(?:(?:the|these|those|my)\s+${PASSAGES}|(?:none|neither)\s+of\s+(?:the|these|those)\s+${PASSAGES}|nothing\s+(?:here|in\s+(?:the|these)\s+${PASSAGES})|there(?:['’]s|\s+is)\s+no\s+mention\b)`,
  "i",
);
// Added after the eval runs of 2026-10-03: "The handbook's passages suggest…", and with the handbook
// as subject only "The handbook only partly answers this" (not "The handbook partly covers the cost").
const ADDED_REMARK = /^(?:the\s+handbook['’]s\s+(?:provided\s+|available\s+)?(?:passages?|excerpts?)\b|the\s+handbook\s+(?:only\s+)?(?:partly|partially)\s+(?:answers|covers|addresses)\s+(?:this|that|it|your\s+question|the\s+question)\b)/i;
// A sentence that leans on one just removed ("They only describe how the comparison works.",
// "What they do say is that …"; since 2026-10-03 also "Here is what they do say:" and "Instead, it says").
const EARLIER_DANGLING = /^(?:(?:what|here['’]s\s+what)\s+)?(?:they|it|these|those)\b/i;
const DANGLING = /^(?:(?:instead|but|however|still|also|though|that\s+said),?\s+)?(?:(?:what|here(?:['’]s|\s+is)\s+what)\s+)?(?:they|it|these|those)\b/i;
// A pronoun lead-in into cited text ("It only describes ", "What they do say is that "), and what it
// refers to: with the sentence it leans on gone, it names its source instead. Not "It's" or "They are",
// which needn't refer back ("It's up to ").
const PRONOUN_LEAD_IN =
  /^(\s*(?:(?:instead|but|however|still|also|though|that\s+said),?\s+)?(?:(?:what|here(?:['’]s|\s+is)\s+what)\s+)?)(it|they|these|those)\b(?!['’]|\s+(?:is|are|was|were)\b)/i;
function nameSource(leadIn: string): string {
  return leadIn.replace(PRONOUN_LEAD_IN, (_, before: string, pronoun: string) => {
    const source = pronoun.toLowerCase() === "it" ? "the handbook" : "the passages";
    return before + (before.trim() === "" ? source[0].toUpperCase() + source.slice(1) : source);
  });
}
// What an unfinished lead-in into the next (cited) run becomes when it has to go: the cited text
// continues the sentence, so deleting the lead-in would leave it starting mid-sentence.
const ATTRIBUTION = "The handbook says ";

/**
 * Take the absence claims, and remarks about the passages, out of a run of uncited answer text,
 * including the wordings findAbsenceClaims leaves alone ("The handbook gives no cutoff"). A sentence
 * starting with a pronoun right after a removed one goes too, since it would make no sense alone.
 * Each removed sentence goes with the break after it, but any space before it stays, so the text
 * around it doesn't run together. When the text runs on into a cited run (`leadsIntoCitation`), an
 * unfinished last piece ("It says ", "What they do say is that ") is the start of the cited sentence,
 * so instead of going it becomes "The handbook says ". That last piece is judged only by the rules
 * from before 2026-10-03 (EARLIER_ABSENCE, EARLIER_REMARK, EARLIER_DANGLING), so lead-ins are handled
 * as they were, with one exception: a pronoun lead-in left without the sentence it leans on, which
 * the earlier rules would have kept, names its source instead ("It only describes " → "The handbook
 * only describes "), so the answer doesn't open on a pronoun that refers to nothing. Swapping the
 * whole lead-in for "The handbook says " would drop what follows the verb ("It says that if ").
 * Only claims carry a topic worth searching for; remarks are dropped.
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
  let removedPreviousEarlier = false; // what removedPrevious would be under the earlier rules alone
  for (let i = 0; i < pieces.length; i += 2) {
    const sentence = pieces[i];
    const trimmed = sentence.trim();
    const unfinished = leadsIntoCitation && i === pieces.length - 1 && trimmed !== "" && !/[.!?:]$/.test(trimmed);
    const earlierClaim = trimmed !== "" && EARLIER_ABSENCE.test(sentence);
    const earlierRemark =
      !earlierClaim && trimmed !== "" && (EARLIER_REMARK.test(trimmed) || (removedPreviousEarlier && EARLIER_DANGLING.test(trimmed)));
    const claim = unfinished ? earlierClaim : trimmed !== "" && ABSENCE_UNCITED.test(sentence);
    const remark = unfinished
      ? earlierRemark
      : !claim && trimmed !== "" && (EARLIER_REMARK.test(trimmed) || ADDED_REMARK.test(trimmed) || (removedPrevious && DANGLING.test(trimmed)));
    if (claim) claims.push(trimmed);
    if (remark) remarks.push(trimmed);
    if ((claim || remark) && unfinished) {
      rest += sentence.match(/^\s*/)![0] + ATTRIBUTION;
    } else if (claim || remark) {
      rest += sentence.match(/^\s*/)![0];
      removedPrevious = true;
    } else {
      rest += (unfinished && removedPrevious ? nameSource(sentence) : sentence) + (pieces[i + 1] ?? "");
      if (trimmed !== "") removedPrevious = false;
    }
    if (earlierClaim || earlierRemark) removedPreviousEarlier = true;
    else if (trimmed !== "") removedPreviousEarlier = false;
  }
  return { text: rest, claims, remarks };
}

/**
 * The topic of an absence claim, as a search phrase: "The handbook doesn't say whether you need
 * approval for a side gig, so…" → "you need approval for a side gig"; "The team names are missing from
 * the passage" → "The team names". Searching the negated sentence as a whole finds the missing passage
 * less often than searching just its topic.
 */
export function absenceTopic(sentence: string): string {
  // A sentence the earlier wordings catch gets the topic it always got; the added leads are for the rest.
  const earlier = EARLIER_ABSENCE.test(sentence);
  const wordings = earlier ? [ABSENCE] : [ABSENCE, SPELLED_OUT, SAYS_NOTHING, ...UNCITED_ONLY];
  const lead = new RegExp(`(?:${wordings.join("|")})\\s*(?:(?:anything|any|whether|that|if|about)\\s+)*`, "i");
  const match = lead.exec(sentence);
  const missing = earlier ? null : new RegExp(MISSING, "i").exec(sentence);
  const topic = match ? sentence.slice(match.index + match[0].length) : missing ? sentence.slice(0, missing.index) : sentence;
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
