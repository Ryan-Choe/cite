# Cite

Ask questions about the company handbook and get answers grounded in it. Every answer cites the exact handbook passages it came from, with page numbers that open the PDF at the right page. If the handbook doesn't cover a question, Cite says so instead of guessing.

The handbook is PostHog's public handbook (`public/handbook.pdf`, printed 2026-04-20; 1,076 pages, ~500k tokens).

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
question → hybrid search → Claude (citations on) → grounding gate → answer + citation cards
```

1. **Ingest (offline, `npm run ingest`).** The PDF is parsed using its layout, not just its text: font size identifies section titles and sub-headings, line spacing separates paragraphs, and indentation gives list nesting. The 254 sections are split into 3,205 chunks of up to 1,000 characters, never spanning two sub-headings. Each chunk is embedded with a local MiniLM model.
2. **Hybrid search.** Keyword search (BM25) catches exact terms like "Deel" or "PTO". Semantic search (embeddings) catches paraphrases ("ill" → "sick"). The two rankings are merged with Reciprocal Rank Fusion, and the top 8 chunks go to Claude.
3. **Answer with citations.** Claude Sonnet 5.5 answers using only those chunks, via Anthropic's citations feature. Each paragraph is a separate citable block, so every quote is an exact handbook paragraph with a known page.
4. **Grounding gate.** Each citation is checked against the text we sent. An answer with no valid citations is never shown as an answer; it becomes "Not covered in the handbook", with the closest sections listed.

The full design, with the alternatives considered and why they were rejected, is in [docs/DESIGN.md](docs/DESIGN.md).

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Run the app at http://localhost:3000 |
| `npm run search -- "question"` | Show the top search results and where each retriever ranked them (no API key needed) |
| `npm run eval` | Retrieval eval: hit@8 for keyword, semantic and hybrid search over `eval/questions.json` |
| `npm run ingest` | Rebuild `data/index/` from the PDF (~1 minute); previews go to `.cache/` |
| `npm test` | Unit tests (layout parsing, chunking, rank fusion, grounding gate) |
| `npm run typecheck` / `npm run lint` | Static checks |

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | Required |
| `CITE_ANSWER_MODEL` | `claude-sonnet-5-5` | Model that writes answers (Sonnet/Opus family) |

## Assumptions

- The PDF is the source of truth, not the live posthog.com handbook, which has changed since it was printed.
- Ingestion relies on this PDF's structure (each section starts with a title and a `contents/handbook/….md` path line). Other PDFs would need a generic fallback chunker.
- The handbook is trusted content. The prompt tells Claude to treat excerpt text as reference material, but there are no stronger prompt-injection defenses.
- Single user, running locally: no auth, no persistence. The conversation lives in the browser and clears on refresh.

## Limitations

- **Tables** whose cells wrap onto several lines come out jumbled in extraction. Single-line tables read correctly (cells are separated with `|`).
- **Names and other link text** are missing from the PDF's text layer ("requests are handled by , , and on the team"), so "who handles X" questions often can't be answered.
- **Bullets** that sit next to each other occasionally merge into one paragraph; the PDF doesn't contain the bullet glyphs.
- **No streaming.** An answer appears all at once, after the grounding gate has checked it.
- **The `#page=N` links** jump to the page in Chrome and Firefox. Safari may open the PDF at page 1.

## How I used AI

<!-- DRAFT written by Claude from the session history. Ryan: rewrite this in your own words before submitting. -->

I built Cite with Claude Code as a pair programmer.

- **Research before code.** Claude extracted and measured the PDF (1,076 pages, ~500k tokens), which ruled out sending the whole handbook per question. It also test-ran the TypeScript PDF and embedding libraries before I committed to a stack.
- **Design review.** Claude interviewed me through every design decision in rounds, each with a recommendation. I made the calls: for example, multi-turn conversation (against its initial recommendation), refuse-and-point for out-of-scope questions, and opening the PDF at the cited page. The result is [docs/DESIGN.md](docs/DESIGN.md).
- **Implementation.** Claude wrote the code and tests; I reviewed each piece through walkthroughs on real data. I initially planned to write the chunker, fusion function, prompt and grounding gate myself, then chose to learn them by reading and questioning working code, given the time budget.
- **Verification.** Claude ran the code against the real PDF at each step and fixed what that surfaced. Examples: page headers leaking into the text, wrapped lines being split, false page-break joins, and a React effect that crashed the page.
