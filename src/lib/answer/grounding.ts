import type Anthropic from "@anthropic-ai/sdk";
import { NOT_COVERED, type DocumentSource } from "./prompt";
import type { AnswerPart, AskResult, Citation, SectionLink } from "./types";

export interface GateOutcome {
  result: AskResult;
  /** Citations that pointed outside the documents or whose quote didn't match our text. */
  droppedCitations: number;
  /** Characters of answer text with no citation attached (whitespace and punctuation excluded). */
  uncitedChars: number;
  /** Why the answer was withheld, if it was. */
  notCoveredReason?: "model-said-not-covered" | "no-citations";
}

const CLOSEST_SECTIONS = 3;

/**
 * The grounding gate. Turns Claude's reply into what the user sees, enforcing one rule:
 * an answer with no valid citations is never shown as an answer — it becomes "not covered",
 * with the closest sections search found.
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
    parts.push({ text: block.text, citations: markers });
  }

  const text = parts.map((p) => p.text).join("").trim();
  const uncitedChars = parts
    .filter((p) => p.citations.length === 0)
    .reduce((sum, p) => sum + p.text.replace(/[^\p{L}\p{N}]/gu, "").length, 0);
  const notCovered = (reason: GateOutcome["notCoveredReason"]): GateOutcome => ({
    result: { status: "not-covered", closest: closestSections(sources), searchedFor },
    droppedCitations,
    uncitedChars,
    notCoveredReason: reason,
  });

  if (text === "" || text.startsWith(NOT_COVERED)) return notCovered("model-said-not-covered");
  if (citations.length === 0) return notCovered("no-citations");
  return { result: { status: "answered", parts, citations, searchedFor }, droppedCitations, uncitedChars };
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
