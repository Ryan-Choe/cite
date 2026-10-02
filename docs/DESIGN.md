# Cite — design

Cite answers natural-language questions about a company handbook. Every answer is grounded in the handbook and cites the exact pages it came from. This doc records what we decided and why, and which alternatives we rejected.

## The source document

`public/handbook.pdf` is PostHog's public handbook, printed from the web on 2026-04-20.

| Fact | Value | Consequence |
|---|---|---|
| Pages | 1,076 (text layer on every page; no OCR needed) | — |
| Size | ~323k words, **~500k tokens** | Too big to send with every question. We need retrieval. |
| Structure | 254 sections; each starts with a title line and a source path such as `contents/handbook/people/time-off.md` | Sections give natural chunk boundaries and good citation labels. |
| Noise | A print header (`4/20/26, 4:49 PM PostHog handbook`) and footer (`file:///…/handbook.html N/1076`) on every page | Strip both by regex. The footer gives a reliable page number. |
| Gaps | Linked text, such as people's names, is missing from the text layer ("handled by , , and on the team") | Some "who does X" questions can't be answered. This is a known limitation. |

## How a question is answered

```
question ──► [rewrite follow-up] ──► hybrid search ──► Claude + citations ──► grounding gate ──► UI
             Haiku 4.5, only if      BM25 + MiniLM,    Sonnet 5.5, top 8      no citations ⇒
             there's history         fused with RRF    chunks as documents    "not covered"
```

1. **Rewrite (multi-turn).** A follow-up such as "is that paid?" can't be searched on its own. When there is earlier conversation, Haiku 4.5 rewrites the question into a standalone one using the last 3 exchanges. The UI shows it as "Searched for: …". The first question skips this call.
2. **Hybrid search.** Two rankings run over ~2,200 chunks:
   - Keyword search (BM25 via MiniSearch) catches exact terms like "Deel" or "PTO".
   - Semantic search (the MiniLM embedding model, run locally with transformers.js) catches paraphrases like "vacation" ↔ "time off".
   - They are merged with **Reciprocal Rank Fusion**: `score = Σ 1/(60 + rank)`. RRF uses only rank positions, so the two incompatible score scales never need rescaling or a tuned weight.
3. **Answer with citations.** The top 8 chunks go to Sonnet 5.5 as document blocks with Anthropic's **citations** feature enabled, one block per page. The API guarantees each `cited_text` is copied verbatim from a block, and the block tells us the exact page. The model sees only the standalone question and the chunks, never the raw chat history, so everything it says traces back to the handbook.
4. **Grounding gate.** Code maps each citation to its section and page. **An answer with no citations is never presented as grounded.** It is shown as "Not covered in the handbook", with the closest sections listed.
5. **Display.** The UI shows progress steps, then the finished, already-gated answer. No streaming: the gate needs the complete response, and we never show an answer we haven't checked.

## Key decisions

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Send the whole handbook vs. retrieve | Retrieve | ~500k tokens per question is slow and costly, and accuracy drops on details buried in that much text. |
| Generic vs. tailored ingest | Tailored to this PDF's section markers | Page- or size-based splitting works on any PDF but gives worse chunks and labels. "Any PDF" is a next step. |
| Quote verification | Anthropic's built-in citations | A custom JSON format plus our own fuzzy quote checker: more code and more failure modes. The two can't be combined; the API returns a 400 error. |
| Models | Sonnet 5.5 answers (~2¢/question), Haiku 4.5 rewrites (~0.1¢) | Haiku for both is weaker at careful reading and at saying "not covered". Opus is ~2× Sonnet's cost and slower. Both are set by env vars. |
| Embeddings | Local MiniLM (fp32, 384-dim) | A hosted embedding API would make reviewers get a second API key. |
| Score fusion | RRF, k=60 | A weighted score mix means rescaling incompatible scales and guessing a weight. |
| Conversation | Multi-turn via query rewriting; history held in the browser only | Single-turn is simpler but breaks natural follow-ups. A database isn't needed. |
| Streaming | No; progress steps instead | Streaming would show text before the grounding gate has run. |
| Deployment | Local only | A public URL spends the owner's API credit, and onnxruntime may exceed Vercel's 250 MB function limit. |
| Built index | Committed, with the PDF's SHA-256 | Reviewers skip ingest, and the eval numbers match what they run. A stale index triggers a warning. |

## Chunking

- Split by section, then at headings and paragraph breaks, up to ~1,000 characters. MiniLM was trained on 256-token inputs and silently cuts off at 512.
- Prefix each chunk with its section title so that a chunk saying "book it in Deel" still matches "vacation".
- Rejoin lines broken mid-sentence. Apply NFKC normalization as a safety net for ligatures.
- Each chunk keeps: section title, source path, page range, and its text split per page (for exact-page citations).

## Product behavior

- **Not covered:** a distinct card with the closest sections. The app never falls back to general knowledge.
- **Citations:** numbered markers like [1] in the answer; cards showing section · page, an expandable exact quote, and **Open page ↗**, which opens `/handbook.pdf#page=N` in a new tab.
- **Missing API key:** the page still loads, with a setup banner. `.env.example` is committed.
- **API errors:** plain-English messages and a Retry button. The SDK also retries twice on its own.
- **Limits:** input ≤ ~500 characters, and `max_tokens` capped so cost is bounded.
- **Logging:** each request logs the rewritten query, retrieved chunk IDs, per-step timings and token usage.

## Evaluation

About 15 questions in `eval/questions.json`, written **before** looking at search results so they reflect real questions: ~10 answerable (each with its expected section), ~3 follow-up pairs, ~2 out of scope.

- **Retrieval check** (no API cost): is the expected section in the top 8? Reported as hit@8.
- **Answer check** (calls Claude): answerable questions must cite the expected section; out-of-scope questions must come back "not covered".
- No LLM judge. The checks are deterministic pass/fail, and a person reads the answers.

## Assumptions

- The handbook PDF is the source of truth, not the live posthog.com site, which has likely changed since the print date.
- Handbook content is trusted. There are no defenses against prompt-injection text inside the document.
- Single user, local machine. No auth and no persistence.

## Code layout (planned)

```
public/handbook.pdf            source document, served for "Open page" links
scripts/ingest.ts              PDF → cleaned pages → chunks → embeddings → data/index/
scripts/eval.ts                retrieval + answer checks over eval/questions.json
src/lib/ingest/                PDF extraction and page cleaning
src/lib/chunk.ts               section/paragraph chunker (rules agreed in design review; tests and code by Claude)
src/lib/search/fuse.ts         ★ Reciprocal Rank Fusion
src/lib/answer/prompt.ts       ★ system prompt and document blocks
src/lib/answer/grounding.ts    ★ citation → section/page mapping, the no-citation rule
src/app/api/ask/route.ts       rewrite → search → answer → gate
src/app/page.tsx               chat UI
```

★ = written by Ryan (with unit tests); everything else was pair-built with Claude Code. See the README's "How I used AI" section.

## Build order (and cut line)

Each step leaves a working app. If time runs short, cut from the bottom.

1. Scaffold (Next.js 16, TypeScript, Tailwind, Vitest)
2. Ingest → chunks you can inspect
3. Hybrid search + retrieval eval
4. Cited answers + grounding gate + basic chat UI + README ← **core, never cut**
5. Not-covered card with closest sections
6. Follow-up rewriting (otherwise single-turn, noted in the README)
7. Answer eval
8. Polish: progress steps, stale-index warning, screenshots/GIF
