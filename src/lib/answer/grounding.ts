import type Anthropic from "@anthropic-ai/sdk";
import { absenceTopic, extractGapLines, findAbsenceClaims, isSearchable, removeAbsenceClaims } from "./gaps";
import { NOT_COVERED, type DocumentSource } from "./prompt";
import type { AnswerPart, AskResult, Citation, SectionLink } from "./types";

export interface GateOutcome {
  result: AskResult;
  /** Citations that pointed outside the documents or whose quote didn't match our text. */
  droppedCitations: number;
  /** Characters of answer text with no citation attached (whitespace and punctuation excluded). */
  uncitedChars: number;
  /** The gaps: Claude's "GAP: …" lines, plus the topics of uncited absence claims. Both are removed from the answer text. */
  gaps: string[];
  /** Every sentence claiming the handbook doesn't say something (the prompt forbids them), removed or not. */
  absenceClaims: string[];
  /** Why the answer was withheld, if it was. */
  notCoveredReason?: "model-said-not-covered" | "only-gaps" | "no-citations";
}

const CLOSEST_SECTIONS = 3;

/**
 * The grounding gate. Turns Claude's reply into what the user sees, enforcing one rule:
 * an answer with no valid citations is never shown as an answer — it becomes "not covered",
 * with the closest sections search found. Gaps Claude lists ("GAP: …"), and uncited sentences
 * claiming the handbook doesn't say something, are moved out of the answer text, to be searched
 * again and shown separately: Claude can't know what the rest of the handbook says.
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
  const gaps = new Set<string>();
  const removedClaims: string[] = [];
  let droppedCitations = 0;

  for (const block of content) {
    if (block.type !== "text") continue; // skip thinking blocks and anything else
    const markers: number[] = [];
    for (const raw of block.citations ?? []) {
      const citation = resolveCitation(raw, sources);
      if (!citation) {
        droppedCitations++;
        continue;
      }
      let n = markerFor.get(citation.key);
      if (n === undefined) {
        n = citations.length + 1;
        markerFor.set(citation.key, n);
        citations.push({ n, ...citation.value });
      }
      if (!markers.includes(n)) markers.push(n);
    }
    // Gaps are shown apart from the answer, so take their lines out of its text. So are uncited
    // claims that the handbook doesn't say something: shown as text, they read as facts.
    const withoutGaps = extractGapLines(block.text);
    const withoutClaims = markers.length === 0 ? removeAbsenceClaims(withoutGaps.text) : { text: withoutGaps.text, claims: [] };
    withoutGaps.gaps.forEach((gap) => gaps.add(gap));
    for (const claim of withoutClaims.claims) {
      removedClaims.push(claim);
      const topic = absenceTopic(claim);
      if (isSearchable(topic)) gaps.add(topic);
    }

    const text = withoutClaims.text;
    const emptied = text.trim() === "" && block.text.trim() !== "" && markers.length === 0;
    // Keep a block that only separates two cited ones; if removal emptied it, keep its line break or space.
    if (!emptied) parts.push({ text, citations: markers });
    else if (/\s/.test(block.text)) parts.push({ text: /\n/.test(block.text) ? "\n\n" : " ", citations: [] });
  }
  // The answer starts and ends with words, not with a separator left by a removed line.
  const isBlank = (part: AnswerPart | undefined) => part !== undefined && part.citations.length === 0 && part.text.trim() === "";
  while (isBlank(parts[0])) parts.shift();
  while (isBlank(parts.at(-1))) parts.pop();
  const last = parts.at(-1);
  if (last) last.text = last.text.trimEnd();

  const text = parts.map((p) => p.text).join("").trim();
  const absenceClaims = [...removedClaims, ...findAbsenceClaims(text)];
  const uncitedChars = parts
    .filter((p) => p.citations.length === 0)
    .reduce((sum, p) => sum + p.text.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
  const gapList = [...gaps];
  const notCovered = (reason: GateOutcome["notCoveredReason"]): GateOutcome => ({
    result: { status: "not-covered", closest: closestSections(sources), searchedFor },
    droppedCitations,
    uncitedChars,
    gaps: gapList,
    absenceClaims,
    notCoveredReason: reason,
  });

  if (text.startsWith(NOT_COVERED)) return notCovered("model-said-not-covered");
  if (text === "") return notCovered(gapList.length > 0 ? "only-gaps" : "model-said-not-covered");
  if (citations.length === 0) return notCovered("no-citations");
  return {
    result: { status: "answered", parts, citations, gaps: gapList, searchedFor },
    droppedCitations,
    uncitedChars,
    gaps: gapList,
    absenceClaims,
  };
}

function resolveCitation(
  raw: Anthropic.Beta.BetaTextCitation,
  sources: DocumentSource[],
): { key: string; value: Omit<Citation, "n"> } | null {
  if (raw.type !== "content_block_location") return null;
  const source = sources[raw.document_index];
  const { start_block_index: start, end_block_index: end } = raw;
  if (!source || start < 0 || end <= start || end > source.blocks.length) return null;

  const blocks = source.blocks.slice(start, end);
  if (squash(raw.cited_text) !== squash(blocks.map((b) => b.text).join(""))) return null;

  return {
    key: `${raw.document_index}:${start}:${end}`,
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

/** The top distinct sections among the retrieved chunks, in search-rank order. */
function closestSections(sources: DocumentSource[]): SectionLink[] {
  const seen = new Set<string>();
  const links: SectionLink[] = [];
  for (const { chunk } of sources) {
    if (seen.has(chunk.sectionPath)) continue;
    seen.add(chunk.sectionPath);
    links.push({ title: chunk.title, page: chunk.pages[0].page });
    if (links.length === CLOSEST_SECTIONS) break;
  }
  return links;
}
