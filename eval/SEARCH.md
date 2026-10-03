# Search sets and how the search method was chosen

Sets A and B (20 answerable questions) were too small to tell search methods apart, and their failures had already been read. So three more sets were written blind, and every option was compared on them. No API calls were involved: search runs locally.

## The question sets

| File | Questions | Sections (seeded shuffle, seed 20261002) | Used for |
|---|---|---|---|
| `search-dev.json` | 40 | positions 10–29 of both the `policy` and `other` lists | choosing the method |
| `search-holdout.json` | 24 | positions 30–41 of both lists | a final check on the finalists |
| `search-exact.json` | 32 | positions 42–57 of both lists | questions that hinge on a rare exact string |

Sets A and B used positions 0–9 (`node eval/sample-sections.mjs` prints the lists). No section was skipped. Unlike sets A and B, these sets weren't committed before their first run; they were written and checked before any search ran on them, and haven't changed since.

- **Written blind.** Six agents wrote the dev and held-out questions, about 11 sections each; four wrote the exact-string set, 8 sections each. Their only source was `.cache/sections-preview.md` (the parsed text). They never opened the search code, the index, eval results or the other question sets, and never ran search.
- **One question per section**, about a concrete fact (a rule, number, process step, owner, definition), phrased like an employee typing into a chat box. In the dev and held-out sets, about two-thirds are paraphrased (no distinctive phrase from the passage, never the section title; `style: "paraphrased"`) and one-third use a term an employee would know, like "Brex" or "incident.io" (`style: "known-term"`). In the exact-string set, each question contains a term that appears in few sections (`term`, `termKind`), such as `search_insights`, `/kudos`, `security-internal@posthog.com` or the error text "pool timed out while waiting for an open connection".
- **Ground truth by grep.** `expect` lists every section whose text contains the core fact, found by grepping keywords and synonyms; `evidence` is a verbatim quote of at most 20 words, with its page, from the first expected section.
- **Checked twice.** For each batch, a second agent re-checked every quote, answer and `expect` list, and rewrote ambiguous questions: 7 fixes in the dev/held-out sets, 3 in the exact-string set, no drops. Then every quote was checked by code to appear on its stated page, and every path against the index.

## What counts as a hit

The passage that holds the answer, i.e. the chunk containing the evidence quote, must be in the top 8. The older check, any chunk of an expected section, overstated recall: a section has a median of 10 chunks (13 on average), so it counted retrieving the wrong part of the right page as a hit. The strict check undercounts one case: a fact repeated in several sections counts only the chunk holding the quote (e.g. the ~$20k sales threshold, which appears on ten pages).

## What was compared

- **Embedding models:** all-MiniLM-L6-v2 (the original), bge-small-en-v1.5, snowflake-arctic-embed-s, mxbai-embed-xsmall-v1, e5-small-v2 (384-dim); snowflake-arctic-embed-m-v1.5, bge-base-en-v1.5, gte-modernbert-base, nomic-embed-text-v1.5 (768-dim); int8 versions of both arctic models. Each with its own pooling and query prefix.
- **Keyword search merged with semantic search** by Reciprocal Rank Fusion, at keyword weights 0.1, 0.25, 0.5 and 1, with and without Porter stemming.
- **Cross-encoder rerankers** (ms-marco-MiniLM-L-6-v2, jina-reranker-v1-turbo-en, mxbai-rerank-xsmall-v1) over semantic top 30 plus keyword top 10, alone or fused with the retrieval order.
- **Keyword safety nets** on top of semantic search: always give slot 8 to keyword search's best result; only when that result scores ≥1.5× or 2× the next; only when the question has a word found in at most 3, 10 or 25 chunks. Each either replacing slot 8 or appending a 9th passage, with plain, stemmed, or joined-string tokenizers.

## Results

**Embedding models**, sets A, B and dev (60 questions), answer passage in the top 8 (and at #1). Full precision unless marked int8:

| MiniLM + keyword merge (before) | MiniLM | bge-small | mxbai-xsmall | e5-small | arctic-embed-s | **arctic-embed-s, int8** | arctic-embed-m | bge-base | gte-modernbert | nomic |
|---|---|---|---|---|---|---|---|---|---|---|
| 37 (16) | 36 (20) | 37 (26) | 37 (21) | 36 (27) | 45 (27) | **44 (28)** | 48 (25) | 44 (28) | 46 (24) | 44 (28) |

Merging keyword search into full-precision arctic-embed-s cost #1 hits at every weight (27 → 15–25) and gained at most one top-8 hit; for the int8 model, weights 0.1 and 0.25 gave 43–44 top-8 hits against 44, and 23–27 #1 hits against 28. Rerankers on top of full-precision arctic-embed-s gave 38–46 top-8 hits against 45 without, at 2–4 s per question (measured with other jobs sharing the CPU).

For reference, the original MiniLM search, re-measured with the stricter check on all 116 questions, scores 75 alone, 77 with keyword search merged at half weight (as shipped), and 82 at equal weight, mostly from the exact-name set (27 vs 22). The half weight had been tuned on set A's 10 questions with the looser check, and didn't hold up.

**Finalists on the 64 blind questions** (dev + held-out):

| | #1 | top 3 | top 8 | MRR |
|---|---|---|---|---|
| MiniLM + keyword merge (before) | 20 | 39 | 46 | 0.480 |
| arctic-embed-s | 35 | 48 | 51 | 0.659 |
| **arctic-embed-s, int8** | **36** | 46 | **52** | 0.655 |
| arctic-embed-m | 36 | 47 | 54 | 0.663 |
| arctic-embed-m, int8 | 36 | 47 | 52 | 0.661 |

Question by question against the old search, int8 arctic-embed-s puts the answer at #1 for 18 more questions and 2 fewer (sign test p < 0.001), and in the top 8 for 7 more and 1 fewer (p ≈ 0.07). The held-out set was first run once on four finalists: the old search 18 of 24, arctic-embed-s 19, arctic-embed-m 18, arctic-embed-m int8 18. Int8 arctic-embed-s, chosen afterwards for its size, scores 20. On the held-out set, then, the top-8 gain is small; the clear gain is ranking.

**Safety nets**, all 116 questions, on int8 arctic-embed-s (91 without a net):

| Net | Top 8 | Used on | Added the answer | Pushed the answer out |
|---|---|---|---|---|
| Always give slot 8 to keyword search's best (plain tokenizer) | 91 | 52 | 2 | 2 |
| Only when its score is ≥1.5× the next | 92 | 6 | 1 | 0 |
| Rare word (≤3 chunks), plain tokenizer | 91 | 19 | 1 | 1 |
| **Rare word (≤3 chunks), joined strings kept whole** | **94** | 21 | 3 | **0** |

"Used on" counts every question where the net picked a passage outside semantic search's top 7. The shipped eval reports 20 for the chosen net, because it doesn't count a pick that was already semantic #8.

With the plain tokenizer, `html.to.design` split into "html" (in 3 chunks, so rare), "to" and "design" (common), and the lookup on "html" picked a different passage. Kept whole, `html.to.design` is in exactly one chunk, the answer. With joined strings kept whole, cutoffs of 3, 10 and 25 chunks all fixed the same 3 questions. Without stemming, the looser cutoffs (10 and 25) also pushed one answer out, so the cutoff is 3, where stemming changes nothing.

## Decision

Int8 arctic-embed-s for semantic search, plus the rare-word safety net (at most 3 chunks, joined strings kept whole, no stemming, replacing slot 8). Full-precision arctic-embed-m found 2 more of the 64 blind questions, which is within noise, for a 13× bigger download and slower ingest and queries; its int8 version (3× the download) found the same 52.

Current results, from `pnpm eval eval/<set>.json`:

| Set | Before | Now |
|---|---|---|
| A | 6/10 | 8/10 |
| B | 3/10 | 4/10 |
| search-dev | 28/40 | 32/40 |
| search-holdout | 18/24 | 20/24 |
| search-exact | 22/32 | 30/32 |

After an independent review, two fixes went into the net, with no change to any result above. The rare words are now looked up whole: MiniSearch tokenized the query again, so "week-to-week" was also searched as "week" and could pick a passage without the rare word (it did once, on a question whose answer was already #1). And joined words made only of filler ("if/when", "to-do") no longer count as rare.

## Caveats

- Everything except the held-out set's first run was chosen on these questions.
- This measures search only. Answers haven't been re-run with the new search (about 45¢ for sets A and B).
- The comparison harness (model sweep, rerankers, net variants) was throwaway code and isn't committed; the chosen setup is what `pnpm eval` measures.
