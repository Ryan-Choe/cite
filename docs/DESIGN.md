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
question ──► [rewrite follow-up] ──► search ──────────► Claude + citations ──► grounding gate ──► [gap re-search] ──► UI
             Haiku 4.5, only if      arctic-embed-s,   Sonnet 5.5, top 8      no citations ⇒      search each gap; if new
             there's history         keyword net       chunks as documents    "not found"         passages, answer again
```

1. **Rewrite (multi-turn).** A follow-up such as "is that paid?" can't be searched on its own. When there is earlier conversation, Haiku 4.5 rewrites the question into a standalone one using the last 3 exchanges. The UI shows it as "Searched for: …". The first question skips this call.
2. **Search** over ~3,200 chunks:
   - **Semantic search** ranks every chunk by cosine similarity to the question. Embeddings come from arctic-embed-s (int8, 384 dimensions), run locally with transformers.js; it is trained for retrieval, and questions get the query prefix it was trained with. It catches paraphrases like "vacation" ↔ "time off". The top 8 go to Claude.
   - **Keyword safety net.** Embeddings can miss a passage whose only link to the question is a rare exact string (`search_insights`, `security-internal@posthog.com`, "Hedgehouse"). If the question contains a word that appears in at most 3 chunks, keyword search (BM25 via MiniSearch) looks up those words, and its best match takes slot 8 unless semantic search already has it. Joined strings such as `search_insights` or `html.to.design` are indexed and looked up whole as well as split, because split up their parts are usually common words that match other passages. Joined words made only of filler ("if/when", "to-do") are ignored, and typos match no chunk, so neither triggers it.
3. **Answer with citations.** The top 8 chunks go to Sonnet 5.5 as document blocks with Anthropic's **citations** feature enabled, one block per paragraph. The API guarantees each `cited_text` is copied verbatim from a block, and the block tells us the exact page. The model sees only the standalone question and the chunks, never the raw chat history. Each citation's quote is checked verbatim against the text we sent; the sentence it supports is the model's own wording. Uncited text (framing, the odd summary) is shown grey and dotted, so it reads as unverified; only a closing lead-in ending in ":" that introduces cited text isn't.
4. **Grounding gate.** Code maps each citation to its section and page. **An answer with no citations is never presented as grounded.** It is shown as "Not found in the passages searched", with the closest sections listed and a note that the handbook may still cover it. An uncited summary sentence that the cited one after it repeats is dropped, and so is an uncited remark about "the passages" (Claude's word for its input, which the employee never sees); other uncited text is shown grey.
5. **Gaps, not absence claims.** The model sees 8 chunks, so "the handbook doesn't say X" is a claim it can't check, and in the eval it was sometimes false: search had missed the passage that says X. The prompt forbids such claims and conclusions drawn from silence; the model lists each unanswered part as a `GAP: <search phrase>` line instead (told that these lines are shown to the employee, so it shouldn't comment on what the passages cover), and near-duplicate gaps are merged. An absence claim that slips through is dropped if it's about "the passages" ("The passages don't give a street address."); otherwise it's left as written: uncited, it's shown grey as unsupported; a clause inside a cited sentence carries that sentence's citation and isn't marked; neither is searched again. An earlier version removed every wording with patterns, but recognising them took a pattern for every English wording: five rounds of adversarial checks each broke the patterns in a new way, and they caught a few sentences per eval run. Blind graders rated a run without them the same as one with them (21/30 correct, 2 false absences each, `eval/results/regrade-blind-simplify.json`); both false ones in the run without them began "The passages don't…", hence the one structural rule. A Haiku classifier did worse in a one-off check (not kept in the repo): of 74 sentences where it and the patterns disagreed, blind graders said it would have removed 59 that should stay, mostly list intros ("Once invited:"), where the patterns removed none. When the passages don't answer the question at all, the model replies `NOT_COVERED` with one to three gap lines worded the way the handbook would put it, so a full miss gets the same re-search as a partial one. The pipeline searches each gap and, if that finds chunks the model hasn't seen, asks again with up to 8 more. Remaining gaps are shown as "Not found in the passages searched", with a note that the handbook may still cover them.
6. **Display.** The UI shows progress steps, then the finished, already-gated answer. No streaming: the gate needs the complete response, and we never show an answer we haven't checked.

## Key decisions

| Decision | Chosen | Rejected, and why |
|---|---|---|
| Send the whole handbook vs. retrieve | Retrieve | ~500k tokens per question is slow and costly, and accuracy drops on details buried in that much text. |
| Generic vs. tailored ingest | Tailored to this PDF's section markers | Page- or size-based splitting works on any PDF but gives worse chunks and labels. "Any PDF" is a next step. |
| Quote verification | Anthropic's built-in citations | A custom JSON format plus our own fuzzy quote checker: more code and more failure modes. The two can't be combined; the API returns a 400 error. |
| Models | Sonnet 5.5 answers (~2¢/question), Haiku 4.5 rewrites (~0.1¢) | Haiku for both is weaker at careful reading and at saying "not covered". Opus is ~2× Sonnet's cost and slower. Both are set by env vars. |
| Embeddings | Local arctic-embed-s (int8, 384-dim, ~35 MB) | A hosted embedding API would make reviewers get a second API key. MiniLM (the first choice) is a general-purpose similarity model: alone it found the answer passage for 75 of 116 eval questions vs 91. The 768-dim models with 3–5× the parameters (arctic-embed-m, bge-base, gte-modernbert, nomic) gained at most 2–3 questions over arctic-embed-s, within noise, for a 3–18× bigger download (int8 or full precision). See `eval/SEARCH.md`. |
| Keyword search | A safety net for rare words only | Merging keyword and semantic rankings (RRF, first at equal weight, then keyword at 0.5) demoted chunks only semantic search found, and at half weight keyword-only chunks could never reach the top 8. Under the stricter answer-passage check, the half weight tuned on set A did worse than equal weight (77 vs 82 of 116, with MiniLM). With arctic-embed-s, merging at weights 0.1–1 gained at most one top-8 hit and always lost #1 hits. Cross-encoder rerankers (ms-marco-MiniLM, jina-turbo, mxbai-xsmall) gained at most one top-8 hit on top of arctic-embed-s and cost 2–4 s per question. |
| Vector store | Two committed files, searched exhaustively in memory | 3,211 vectors take 1–2 ms to scan. A vector database (Chroma, pgvector) adds a server to run and a setup step, and pays off only at ~100k+ vectors, with many documents, or with filtered queries. The index records its model and a checksum of its vectors, and loading refuses a mismatch. |
| Conversation | Multi-turn via query rewriting; history held in the browser only | Single-turn is simpler but breaks natural follow-ups. A database isn't needed. |
| Streaming | No; progress steps instead | Streaming would show text before the grounding gate has run. |
| Deployment | Local only | A public URL spends the owner's API credit, and onnxruntime may exceed Vercel's 250 MB function limit. |
| Built index | Committed, with the PDF's SHA-256 | Reviewers skip ingest, and the eval numbers match what they run. A stale index triggers a warning. |

## Chunking

- Split by section, then at headings and paragraph breaks, up to ~1,000 characters. That's a median of ~140 tokens with the title, within the embedding model's 512-token limit.
- Prefix each chunk with its section title so that a chunk saying "book it in Deel" still matches "vacation".
- Rejoin lines broken mid-sentence, judging each indentation against its own right margin (text in callout boxes wraps ~30pt before the page margin). Keep title-size headings inside a section as top-level headings. Apply NFKC normalization as a safety net for ligatures.
- Each chunk keeps: section title, source path, page range, and its text split per page (for exact-page citations).

## Product behavior

- **Not covered:** a distinct card, "Not found in the passages searched", with the closest sections (from the gap re-search first, if it ran) and what it also searched for, and a note that the handbook may still cover it. The app never falls back to general knowledge.
- **Gaps:** what the passages didn't answer is listed under the answer as "Not found in the passages searched", never stated as a fact about the handbook.
- **Citations:** numbered markers like [1] in the answer; cards showing section · page, an expandable exact quote, and **Open page ↗**, which opens `/handbook.pdf#page=N` in a new tab.
- **Missing API key:** the page still loads, with a setup banner. `.env.example` is committed.
- **API errors:** plain-English messages and a Retry button. The SDK also retries twice on its own. If the search index or the embedding model fails to load, the question gets an error message instead of a crash, and the next question tries loading again.
- **Limits:** the question and each of at most 3 earlier questions ≤ 500 characters, the request body ≤ 16,000 characters, `max_tokens` capped, and at most two answer calls per question, so cost per question is bounded.
- **Who can ask:** the server listens on 127.0.0.1, and `/api/ask` answers only JSON requests whose Host and Origin are local, so other machines, other websites and DNS rebinding can't spend the owner's API credit.
- **Logging:** each request logs the rewritten query, retrieved chunk IDs, per-step timings and token usage.

## Evaluation

Blind sets, written by separate agents that never saw the app's search, from sections drawn by a seeded shuffle:
- **Set A** (`eval/questions.json`, 13 questions + 3 follow-ups): used for tuning.
- **Set B** (`eval/holdout.json`, 12 questions + 2 follow-ups): written after tuning and run once. The gap re-search was later designed after reading its failures, so its second run is not held out.
- **Search sets** (`eval/search-dev.json` 40, `eval/search-holdout.json` 24, `eval/search-exact.json` 32; retrieval only): written for choosing the search method. See `eval/SEARCH.md`.

Ground truth comes from grep over the parsed text. Results and findings are in the README's Evaluation section.

- **Retrieval check** (no API cost): is the chunk holding the question's evidence quote in the top 8, with and without the keyword safety net? The looser check (any chunk of an expected section) is reported too; it overstated recall, since sections have a median of 10 chunks (13 on average).
- **Answer check** (calls Claude): answerable questions and follow-ups must cite an expected section and name no gaps. An answer that names a gap is scored "review", because the gap may be false (so is one with a sentence that may say the handbook lacks something, a rough pattern flag); a person compares it with the reference answer, which is printed next to it. Out-of-scope questions pass if declined; a partial answer is scored "review", and a person checks that it names the gap and invents nothing.
- No LLM judge in the eval. The checks are deterministic, every answer is printed for a person to read, and `--regrade` applies the current rules to saved answers without API calls. Separately, the saved answers were re-graded once against the reference answers by two Claude agents working blind (`eval/results/regrade-blind.json`); that is how the false "the handbook doesn't say" answers were found.

## Assumptions

- The handbook PDF is the source of truth, not the live posthog.com site, which has likely changed since the print date.
- Handbook content is trusted. There are no defenses against prompt-injection text inside the document.
- Single user, local machine. No auth and no persistence; the server only listens on, and only answers, this machine.

## Code layout

```
public/handbook.pdf              source document, served for "Open page" links
data/index/                      built index (committed): chunks.json + vectors.bin
scripts/ingest.ts                PDF → sections → chunks → embeddings → data/index/
scripts/search.ts                debug: top results with similarity, and what the keyword safety net added
scripts/eval.ts                  retrieval + answer checks (set A: eval/questions.json, B: eval/holdout.json, search sets)
eval/                            blind question sets, method notes, seeded sampler, results
src/lib/ingest/                  PDF layout → sections of headings/paragraphs, per page
src/lib/chunk.ts                 section → chunks (≤1,000 chars, heading-aware, per-page text)
src/lib/search/embed.ts          local arctic-embed-s embeddings (questions get the query prefix)
src/lib/search/index-file.ts     index on disk; refuses a model mismatch or a vectors file from another ingest
src/lib/search/keyword.ts        keyword safety net: rare words → BM25 match for the last slot
src/lib/search/search.ts         semantic search + the safety net
src/lib/answer/prompt.ts         system prompt; chunks → citable documents (one block per paragraph)
src/lib/answer/claude.ts         Claude call (citations, effort, fallbacks), errors → plain English
src/lib/answer/rewrite.ts        follow-up → standalone question (Haiku)
src/lib/answer/gaps.ts           "GAP:" lines → search phrases; near-duplicates merged
src/lib/answer/grounding.ts      citation → section/page/quote, verified; no citations ⇒ not covered; gaps split out
src/lib/answer/pipeline.ts       rewrite → search → answer → gate → gap re-search (shared by the route and the eval)
src/app/api/ask/route.ts         HTTP: local callers only, validation, status codes, one log line per request
src/app/chat.tsx                 chat UI
```

Authorship: Ryan set the requirements and made every design decision in a structured design review (this doc). Claude Code wrote the code and tests and walked Ryan through each piece; Ryan chose to learn by reading and questioning working code rather than writing it line by line. See the README's "How I used AI" section.

## Build order (and cut line)

Each step leaves a working app. If time runs short, cut from the bottom.

1. Scaffold (Next.js 16, TypeScript, Tailwind, Vitest)
2. Ingest → chunks you can inspect
3. Search + retrieval eval (hybrid at first; now semantic search plus a keyword safety net)
4. Cited answers + grounding gate + basic chat UI + README ← **core, never cut**
5. Not-covered card with closest sections
6. Follow-up rewriting (otherwise single-turn, noted in the README)
7. Answer eval
8. Polish: progress steps, stale-index warning, screenshots/GIF

Status: steps 1–8 are done. Two exceptions: there is a single "Searching the handbook and writing an answer…" message instead of staged progress steps (the server doesn't report its progress, and fake timed steps would mislead), and screenshots instead of a GIF.
