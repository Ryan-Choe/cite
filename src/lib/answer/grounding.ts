import type Anthropic from "@anthropic-ai/sdk";
import type { Chunk } from "../chunk";
import { dedupeGaps, extractGapLines, meaningfulWords } from "./gaps";
import { NOT_COVERED, type DocumentSource } from "./prompt";
import type { AnswerPart, AskResult, Citation, SectionLink } from "./types";

export interface GateOutcome {
  result: AskResult;
  /** Citations that pointed outside the documents or whose quote didn't match our text. */
  droppedCitations: number;
  /** Characters of answer text with no citation attached (whitespace and punctuation excluded). */
  uncitedChars: number;
  /** The gaps to show: Claude's "GAP: …" lines, near-duplicates merged. */
  gaps: string[];
  /** Every "GAP: …" line Claude wrote, before near-duplicates are merged for display: all of them are searched. */
  gapLines: string[];
  /** The chunks the valid citations point into. */
  citedChunks: string[];
  /** Uncited sentences dropped because the cited sentence right after them says the same thing. */
  restatements: number;
  /** Uncited sentences about "the passages" dropped from the reply (see dropPassageRemarks). */
  passageRemarks: number;
  /** Why the answer was withheld, if it was. */
  notCoveredReason?: "model-said-not-covered" | "only-gaps" | "no-citations";
}

const CLOSEST_SECTIONS = 3;

// "The passages" is Claude's word for what it was given, which the employee never sees.
const ABOUT_PASSAGES = /^(?:the|these|those)\s+(?:passages?|excerpts?)\b/i;
const REFERS_BACK = /^(?:they|these|those)\b/i;
// A sentence end ("." "!" "?") or a line break, captured so that split() keeps it: sentence, break, sentence, …
const SENTENCE_BREAK = /((?<=[.!?])\s+|\n+)/;

/**
 * Drop the sentences of an uncited run that are about "the passages" ("The passages don't give a
 * street address."), and one right after that refers back to them ("They only describe how the survey
 * works."). They're about what Cite showed Claude, not the handbook, and in the eval they were where
 * a false "the handbook doesn't say" turned up; the gaps box already says what wasn't found. Only
 * finished sentences: an unfinished lead-in into cited text ("The passages say ") stays.
 */
function dropPassageRemarks(text: string): { text: string; dropped: number } {
  const pieces = text.split(SENTENCE_BREAK);
  let rest = "";
  let dropped = 0;
  let droppedPrevious = false;
  for (let i = 0; i < pieces.length; i += 2) {
    const sentence = pieces[i];
    const trimmed = sentence.trim();
    if (/[.!?]$/.test(trimmed) && (ABOUT_PASSAGES.test(trimmed) || (droppedPrevious && REFERS_BACK.test(trimmed)))) {
      rest += sentence.match(/^\s*/)![0]; // the sentence goes with the break after it
      dropped++;
      droppedPrevious = true;
    } else {
      rest += sentence + (pieces[i + 1] ?? "");
      if (trimmed !== "") droppedPrevious = false;
    }
  }
  return { text: rest, dropped };
}

/**
 * The grounding gate. Turns Claude's reply into what the user sees, enforcing one rule:
 * an answer with no valid citations is never shown as an answer — it becomes "not covered",
 * with the closest sections search found. Gaps Claude lists ("GAP: …") are moved out of the
 * answer text, to be searched again and shown separately: Claude can't know what the rest of the
 * handbook says. Uncited remarks about "the passages" are dropped (see dropPassageRemarks).
 *
 * Every citation is checked, not trusted: it must point at real blocks we sent, and its
 * cited_text must match those blocks' text.
 */
export function applyGroundingGate(
  content: Anthropic.Beta.BetaContentBlock[],
  sources: DocumentSource[],
  searchedFor: string,
): GateOutcome {
  const citations: Citation[] = [];
  const markerFor = new Map<string, number>(); // same cited range → same [n]
  const parts: AnswerPart[] = [];
  const gapLines: string[] = [];
  const citedChunks = new Set<string>();
  let droppedCitations = 0;
  let passageRemarks = 0;

  const textBlocks = content.filter((block) => block.type === "text"); // skip thinking blocks and anything else
  textBlocks.forEach((block) => {
    const markers: number[] = [];
    for (const raw of block.citations ?? []) {
      const citation = resolveCitation(raw, sources);
      if (!citation) {
        droppedCitations++;
        continue;
      }
      citedChunks.add(citation.chunkId);
      let n = markerFor.get(citation.key);
      if (n === undefined) {
        n = citations.length + 1;
        markerFor.set(citation.key, n);
        citations.push({ n, ...citation.value });
      }
      if (!markers.includes(n)) markers.push(n);
    }
    // Gaps are shown apart from the answer, so take their lines out of its text, and uncited remarks
    // about the passages with them.
    const withoutGaps = extractGapLines(block.text);
    gapLines.push(...withoutGaps.gaps);
    const { text, dropped } = markers.length === 0 ? dropPassageRemarks(withoutGaps.text) : { text: withoutGaps.text, dropped: 0 };
    passageRemarks += dropped;
    const emptied = text.trim() === "" && block.text.trim() !== "" && markers.length === 0;
    // Keep a block that only separates two cited ones; if removal emptied it, keep its line break or space.
    if (!emptied) parts.push({ text, citations: markers });
    else if (/\s/.test(block.text)) parts.push({ text: /\n/.test(block.text) ? "\n\n" : " ", citations: [] });
  });
  const restatements = dropRestatements(parts);
  // The answer starts and ends with words, not with a separator left by a removed line.
  const isBlank = (part: AnswerPart | undefined) => part !== undefined && part.citations.length === 0 && part.text.trim() === "";
  while (isBlank(parts[0])) parts.shift();
  while (isBlank(parts.at(-1))) parts.pop();
  const last = parts.at(-1);
  if (last) last.text = last.text.trimEnd();

  const text = parts.map((p) => p.text).join("").trim();
  const uncitedChars = parts
    .filter((p) => p.citations.length === 0)
    .reduce((sum, p) => sum + p.text.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
  const gapList = dedupeGaps(gapLines);
  const removed = {
    droppedCitations,
    uncitedChars,
    gaps: gapList,
    gapLines: [...new Set(gapLines)],
    citedChunks: [...citedChunks],
    restatements,
    passageRemarks,
  };
  const notCovered = (reason: GateOutcome["notCoveredReason"]): GateOutcome => ({
    result: { status: "not-covered", closest: closestSections(sources.map((s) => s.chunk)), searchedFor, alsoSearchedFor: [] },
    ...removed,
    notCoveredReason: reason,
  });

  // Claude said so, even if it wrote a line before the marker (an answer with citations is still an answer).
  const saidNotCovered = text.startsWith(NOT_COVERED) || (citations.length === 0 && new RegExp(`^\\s*${NOT_COVERED}\\b`, "m").test(text));
  if (saidNotCovered) return notCovered("model-said-not-covered");
  if (text === "") return notCovered(gapList.length > 0 ? "only-gaps" : "model-said-not-covered");
  if (citations.length === 0) return notCovered("no-citations");
  return { result: { status: "answered", parts, citations, gaps: gapList, searchedFor }, ...removed };
}

/** Share of an uncited sentence's meaningful words that the next cited sentence must repeat for it to be dropped. */
const RESTATED = 0.75;
/** Text ending in an abbreviation, whose period doesn't end a sentence. */
const ABBREVIATION = /\b(?:e\.g|i\.e|etc|vs|approx|U\.S|U\.K)\.$/i;

/**
 * Drop an uncited sentence that the cited text right after it repeats, in the same paragraph:
 * "You should start X as soon as Y. As soon as Y you should start X.[1]". The cited sentence says
 * the same with a source; shown grey, the uncited copy would only flag the answer as unsupported.
 * Short sentences ("Yes.", "No, not by default.") are kept: they carry the verdict. Returns how
 * many were dropped.
 */
function dropRestatements(parts: AnswerPart[]): number {
  let dropped = 0;
  for (let i = 0; i + 1 < parts.length; i++) {
    const part = parts[i];
    if (part.citations.length > 0 || parts[i + 1].citations.length === 0) continue;
    const trailing = part.text.match(/\s*$/)![0];
    const body = part.text.slice(0, part.text.length - trailing.length);
    if (trailing.includes("\n") || !/[.!?]$/.test(body)) continue; // must end a sentence in the same paragraph
    let start = 0;
    for (const m of body.slice(0, -1).matchAll(/[.!?]\s+|\n+/g)) {
      if (!ABBREVIATION.test(body.slice(0, m.index + 1))) start = m.index + m[0].length;
    }
    // Keep what the sentence sits behind (a space, or a list marker that the cited text then fills).
    start += body.slice(start).match(/^\s*(?:[-*•][ \t]+|\d+[.)][ \t]+)?/)![0].length;
    const words = new Set(meaningfulWords(body.slice(start)));
    const repeated = new Set(meaningfulWords(parts[i + 1].text));
    if (words.size < 4 || [...words].filter((w) => repeated.has(w)).length / words.size < RESTATED) continue;
    part.text = body.slice(0, start);
    dropped++;
  }
  return dropped;
}

function resolveCitation(
  raw: Anthropic.Beta.BetaTextCitation,
  sources: DocumentSource[],
): { key: string; chunkId: string; value: Omit<Citation, "n"> } | null {
  if (raw.type !== "content_block_location") return null;
  const source = sources[raw.document_index];
  const { start_block_index: start, end_block_index: end } = raw;
  if (!source || start < 0 || end <= start || end > source.blocks.length) return null;

  const blocks = source.blocks.slice(start, end);
  if (squash(raw.cited_text) !== squash(blocks.map((b) => b.text).join(""))) return null;

  return {
    key: `${raw.document_index}:${start}:${end}`,
    chunkId: source.chunk.id,
    value: {
      sectionTitle: source.chunk.sectionTitle,
      sectionPath: source.chunk.sectionPath,
      title: source.chunk.title,
      pages: [...new Set(blocks.map((b) => b.page))],
      quote: blocks.map((b) => b.text).join("\n"),
    },
  };
}

/** Compare text ignoring whitespace differences. */
function squash(text: string): string {
  return text.replace(/\s+/g, "");
}

/** The top distinct sections among the given chunks, in the order given (search rank). */
export function closestSections(chunks: Chunk[]): SectionLink[] {
  const seen = new Set<string>();
  const links: SectionLink[] = [];
  for (const chunk of chunks) {
    if (seen.has(chunk.sectionPath)) continue;
    seen.add(chunk.sectionPath);
    links.push({ title: chunk.title, page: chunk.pages[0].page });
    if (links.length === CLOSEST_SECTIONS) break;
  }
  return links;
}
