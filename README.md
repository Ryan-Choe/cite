# Cite

Ask questions about the company handbook and get answers grounded in it. Every answer cites the exact handbook passages it came from, with page numbers that open the PDF at the right page. If the handbook doesn't cover a question, Cite says so instead of guessing.

The handbook is PostHog's public handbook (`public/handbook.pdf`, printed 2026-04-20; 1,076 pages, ~500k tokens).

| A follow-up, rewritten and answered with citations | A question the handbook doesn't answer |
|---|---|
| ![Follow-up answer with citation cards](docs/screenshots/follow-up-answer.jpg) | ![Not covered card with closest sections](docs/screenshots/not-covered.jpg) |

## Quick start

Requires Node.js 22+ and an [Anthropic API key](https://console.anthropic.com/).

```bash
npm install
cp .env.example .env.local   # then put your key after ANTHROPIC_API_KEY=
npm run dev                  # open http://localhost:3000
```

The search index is committed (`data/index/`), so there is no build step. The first question downloads a small embedding model (~90 MB, once, into `.cache/models/`), so it takes a few extra seconds.

## How it works

```
question → [rewrite follow-up] → hybrid search → Claude (citations on) → grounding gate → answer + citation cards
```

1. **Ingest (offline, `npm run ingest`).** The PDF is parsed using its layout, not just its text: font size identifies section titles and sub-headings, line spacing separates paragraphs, and indentation gives list nesting. The 254 sections are split into 3,205 chunks of up to 1,000 characters, never spanning two sub-headings. Each chunk is embedded with a local MiniLM model.
2. **Follow-ups.** In a conversation, Claude Haiku 4.5 rewrites a follow-up such as "Is it paid?" into a standalone question ("Is the parental leave policy paid?"), shown in the UI as "Searched for: …". If the rewrite fails, the original question is used.
3. **Hybrid search.** Keyword search (BM25) catches exact terms like "Deel" or "PTO". Semantic search (embeddings) catches paraphrases ("ill" → "sick"). The two rankings are merged with weighted Reciprocal Rank Fusion, with keyword search at half weight (see [Evaluation](#evaluation)), and the top 8 chunks go to Claude.
4. **Answer with citations.** Claude Sonnet 5.5 answers using only those chunks, via Anthropic's citations feature. Each paragraph is a separate citable block, so every quote is an exact handbook paragraph with a known page.
5. **Grounding gate.** Each citation is checked against the text we sent. An answer with no valid citations is never shown as an answer; it becomes "Not covered in the handbook", with the closest sections listed.

The full design, with the alternatives considered and why they were rejected, is in [docs/DESIGN.md](docs/DESIGN.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app at http://localhost:3000 |
| `npm run search -- "question"` | Show the top search results and where each retriever ranked them (no API key needed) |
| `npm run eval` | Retrieval eval (no API calls): hit@8 for keyword, semantic and hybrid search over `eval/questions.json` |
| `npm run eval -- --answers` | Answer eval through the full pipeline (~15¢ per run). Add `eval/holdout.json` to run the held-out set |
| `npm run ingest` | Rebuild `data/index/` from the PDF (~1 minute); previews go to `.cache/` |
| `npm test` | Unit tests (layout parsing, chunking, rank fusion, grounding gate, follow-up rewriting) |
| `npm run typecheck` / `npm run lint` | Static checks |

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `CITE_ANSWER_MODEL` | `claude-sonnet-5-5` | Model that writes answers (Sonnet/Opus family) |
| `CITE_REWRITE_MODEL` | `claude-haiku-4-5` | Model that rewrites follow-up questions |

## Evaluation

There are two blind question sets, each written by a separate agent that never saw the app's search or any results:
- **Set A** ([eval/questions.json](eval/questions.json)): 10 answerable questions, 3 follow-ups, 3 out-of-scope.
- **Set B** ([eval/holdout.json](eval/holdout.json)): 10 answerable questions, 2 follow-ups, 2 out-of-scope.

How the questions were made:
- **Sections drawn at random.** A seeded shuffle ([eval/sample-sections.mjs](eval/sample-sections.mjs)) picked the sections. Half come from the people/company policy pages, half from anywhere in the handbook.
- **Phrased like an employee.** Questions use an employee's own words, not the handbook's, which makes keyword matching harder.
- **Answer locations found by text search.** The ground truth comes from grep over the parsed text, not from the app.

Each set was committed before its first run. Set A was used for tuning. Set B was written after tuning and run **once**, so it's the honest number. Method notes: [eval/QUESTIONS.md](eval/QUESTIONS.md), [eval/HOLDOUT.md](eval/HOLDOUT.md).

**Retrieval** (is a chunk from the right section in the top 8?):

| | keyword | semantic | hybrid |
|---|---|---|---|
| Set A, equal-weight fusion (first run) | 6/10 | 9/10 | 7/10 |
| Set A, keyword at half weight (tuned) | 6/10 | 9/10 | 9/10 |
| **Set B, held out** (keyword at half weight) | 5/10 | 6/10 | **6/10** |
| Set B, equal-weight fusion (measured afterwards, for comparison) | 5/10 | 6/10 | 6/10 |

**Answers** (full pipeline):

| | Set A, first run | Set A, tuned | **Set B, held out** |
|---|---|---|---|
| Answerable: answered with a citation from the right section | 7/10 | 8/10 | **6/10** |
| Follow-ups: rewritten and answered correctly | 3/3 | 3/3 | **2/2** |
| Out-of-scope: declined | 1/3 | 2/3 | **1/2** |
| Out-of-scope: partial answer that names the gap | 2/3 | 1/3 | **1/2** |

**What the eval showed:**
- **Every failure was a safe failure.** When search didn't find the right passage, Cite said "not covered" rather than inventing an answer. In 30 questions and follow-ups across both sets, it never presented an answer it couldn't cite.
- **Search recall is the bottleneck.** On set B, four questions were missed by every retriever, in two ways:
  - **Vocabulary gaps:** three questions use different words from the handbook. "Share of customers from people recommending us" vs "word of mouth"; "rubric to move up" vs "career progression"; "get a company-wide app approved" vs "adding tools".
  - **No phrase matching:** "who runs Product for Engineers?" names the newsletter exactly, but every one of those words appears all over an engineering handbook, and BM25 scores words independently. Chunks about "product" and "engineers" outrank the one sentence that answers it.

  Set A's 9/10 overstated recall, which is why set B exists.
- **Equal-weight fusion hurt.** Keyword search ranks chunks that share only common words ("work", "posthog") highly, and at equal weight that pushed correct semantic results out of the top 8. Halving keyword search's weight fixed that on set A (7 → 9/10). On set B it made no difference (6/10 either way), so the gain is real but modest. With the new weighting, hybrid search was never worse than either retriever alone.
- **Retrieval hits are section-level.** A "hit" can be a different chunk of the right section. For example, "who started PostHog" retrieved the 2024 entry of the company timeline, not the founding entry, and Claude correctly declined. The answer eval is the stricter measure.
- **Partial answers to out-of-scope questions** state the gap plainly ("The handbook doesn't give a street address for Hogpatch") and cite what *is* there. An early version added uncited advice ("…is probably the place to ask"); the prompt now forbids it.
- **Cost and speed:** about 1¢ and 2–4 s per question (Sonnet 5.5). Follow-ups add about 1 s for the rewrite.

## Assumptions

- The PDF is the source of truth, not the live posthog.com handbook, which has changed since it was printed.
- Ingestion relies on this PDF's structure (each section starts with a title and a `contents/handbook/….md` path line). Other PDFs would need a generic fallback chunker.
- The handbook is trusted content. The prompt tells Claude to treat excerpt text as reference material, but there are no stronger prompt-injection defenses.
- Single user, running locally: no auth, no persistence. The conversation lives in the browser and clears on refresh.

## Limitations

- **Search misses questions worded differently from the handbook** ("chip in" vs "budgetary support"). It also misses names made of common words ("Product for Engineers"), because keyword search has no phrase matching. On the held-out set, 4/10 questions failed this way. Cite then says "not covered", which is safe but unhelpful.
- **Some answer text is uncited.** The gate requires at least one valid citation per answer, not one per sentence, so framing lines ("What the handbook does cover:") and the occasional summary sentence carry no marker. The server log reports uncited characters per answer.
- **Tables** whose cells wrap onto several lines come out jumbled in extraction. Single-line tables read correctly (cells are separated with `|`).
- **Names and other link text** are missing from the PDF's text layer ("requests are handled by , , and on the team"), so "who handles X" questions often can't be answered.
- **Bullets** that sit next to each other occasionally merge into one paragraph; the PDF doesn't contain the bullet glyphs.
- **No streaming.** An answer appears all at once, after the grounding gate has checked it.
- **The `#page=N` links** jump to the page in Chrome and Firefox. Safari may open the PDF at page 1.

## Next steps

1. **Improve search recall.** Rewrite *every* question (not just follow-ups) into handbook-style search terms before searching. Add phrase matching for quoted or capitalized names. Try a stronger embedding model or a reranker. Measure against a new held-out set C, since set B has now been seen.
2. **Grow the eval** to ~50 questions, so a one-question difference stops being 10 percentage points.
3. **Check grounding per sentence.** Flag or drop sentences that carry no citation, instead of only requiring one citation per answer.
4. **Hosting.** Deploy with auth and a spend cap. It was skipped because a public URL spends the owner's API credit, and the embedding runtime may exceed Vercel's function size limit.

## How I used AI

<!-- DRAFT written by Claude from the session history. Ryan: rewrite this in your own words before submitting. -->

I built Cite with Claude Code as a pair programmer.

- **Research before code.** Claude extracted and measured the PDF (1,076 pages, ~500k tokens), which ruled out sending the whole handbook per question. It also test-ran the TypeScript PDF and embedding libraries before I committed to a stack.
- **Design review.** Claude interviewed me through every design decision in rounds, each with a recommendation. I made the calls: for example, multi-turn conversation (against its initial recommendation), refuse-and-point for out-of-scope questions, and opening the PDF at the cited page. The result is [docs/DESIGN.md](docs/DESIGN.md).
- **Implementation.** Claude wrote the code and tests; I reviewed each piece through walkthroughs on real data. I initially planned to write the chunker, fusion function, prompt and grounding gate myself, then chose to learn them by reading and questioning working code, given the time budget.
- **Verification.** Claude ran the code against the real PDF at each step and fixed what that surfaced. Examples: page headers leaking into the text, wrapped lines being split, false page-break joins, and a React effect that crashed the page.
- **Evaluation without bias.** I asked for the eval questions to be written "unbiased". Claude had separate agents, which never saw the app's search, write them from randomly drawn sections, and kept a second set back until tuning was done. That held-out set caught that our first set overstated search quality.
