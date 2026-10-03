/**
 * Gaps: parts of a question that the passages Claude saw don't answer.
 *
 * Claude sees only the top search results, never the whole handbook, so "the handbook doesn't say X"
 * is a claim it can't check. In the eval it was sometimes false: the handbook did say X, but search
 * had missed that passage. So the prompt asks Claude to list each gap on its own "GAP: …" line
 * instead of writing about it. The pipeline searches each gap once more, and the UI shows what's
 * left as "not found in the passages searched", never as a fact about the handbook. Anything Claude
 * still writes about what the handbook lacks is left as written: uncited, the UI shows it grey as
 * unsupported (one about "the passages" is dropped: see grounding.ts); inside a cited sentence, it
 * isn't marked.
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
