# Held-out eval set

`holdout.json` is the **held-out** question set. Run it once, at the end, to check that changes tuned on `questions.json` generalize. Don't tune against it. If you look at its failures and then change the app, it stops being held out.

## Where the questions come from

- Sections come from the same seeded shuffle as the first set (`.cache/eval-sample.json`, seed 20261002). The first set used positions 1–5 of the `policy` and `other` lists. This set starts at **position 6 (index 5)** of each list and takes sections strictly in order.
- **policy (indices 5–9):** `low-prices`, `people/feedback`, `company/adding-tools`, `company/post-mortems/2025-11-26-shai-hulud-attack`, `people/career-progression`
- **other (indices 5–9):** `onboarding/chrome-extension-billing-case-study-wildfire`, `support/support-smes`, `content/newsletter`, `growth/sales/accounts-overview`, `marketing/customer-case-studies`
- **Skipped sections: none.** All ten sections state at least one concrete fact (a rule, process, number, owner or definition), so none was skipped.
- The only handbook source was `.cache/sections-preview.md`. The app's search code, the index, chunk previews, eval results and the first question set were not opened, and no search or eval script was run.

## How questions were written

- One question per section, written the way a new employee would type it into a chat box: short and casual.
- **Paraphrasing rule:** a question doesn't reuse a distinctive phrase from its passage when a normal person would say it differently, and it never names the section title. Three of the ten use a term an employee would already know: `workflow-pr-review` (GitHub Actions), `newsletter-owner` (Product for Engineers, the newsletter's name) and `sales-lead-threshold` (self-serve). The other seven are paraphrased; for example, "word-of-mouth" became "people recommending us" and "progress/promoted" became "move up".
- Two questions have a context-dependent `followUp` (`team-survey-anonymity`, `case-study-customer-outreach`). Each follow-up has a `standalone` rewrite, and its answer was confirmed by grep.

## How ground truth was set

- For each question, `.cache/sections-preview.md` was grepped for several keywords and synonyms. Every hit was read in context.
- A section went into `expect` only if it contains the **core fact** of the answer. Being on the same topic wasn't enough. The app's search was never used to decide this.
- Every `expect` path was checked against a `# … — contents/handbook/<path>.md` header. Every `evidence` quote was checked to appear verbatim on its stated page in the first expected section. Quotes are ≤20 words and answers ≤25.

### Judgement calls (sections left out of `expect`)

- `customers-from-recommendations`: `how-we-get-users` and `marketing/index` talk about word-of-mouth in general terms but don't give the 70% share.
- `propose-company-wide-tool`: the Software section of `people/spending-money` discourages new collaborative software and says to ask Tara about company accounts. It doesn't give the proposal process (trial, then a PR/issue in Company Internal, then legal).
- `workflow-pr-review`: `engineering/security` says to take care with GitHub Actions and mentions Semgrep/CodeQL scanning. It doesn't say these PRs need a security-team review.
- `promotion-criteria`: `wide-company`, `company/culture` and `strong-team` discuss titles or a "clearer career ladder" elsewhere. None says whether promotion criteria exist.
- `browser-extension-billing`: `cs-and-onboarding/health-checks` covers calling identify too often in general, but not extension re-initialisation or the bootstrap fix.
- `support-ticket-split`: `growth/sales/product-enablement` describes GTM product SMEs who handle sales and CS training. They have nothing to do with support tickets. The SME names in `support-smes` are blank in the extracted text (`EU: , NA:`), so no question asks "who".
- `newsletter-owner`: `brand/email-comms` says the newsletter is "managed by the Content & Docs team". That names a team, not the owner (Andy), so it was left out.
- `sales-lead-threshold`: the ~$20k cut-off appears on many sales pages. All ten pages that tie sales involvement with new or potential customers to roughly $20k are included. Left out: `growth/sales/account-allocation` (existing customers who reach $20k get a TAM or CSM), `growth/sales/lead-scoring` (routing rules, not the size cut-off), and pages with unrelated $20k rules (`slack-channels`, `contract-rules`, `contracts`).
- `case-study-customer-outreach` follow-up: `growth/sales/contract-rules` says no discounts are given for case studies. That's related, but it doesn't contain the merch-credit answer.

## Out-of-scope questions

| id | type | terms grepped (no answering hit) |
|---|---|---|
| `oos-team-survey-score` | next to a covered topic: `people/feedback` describes the survey method and benchmark and links to the results, but gives no scores | survey results, latest survey, score, benchmark, Culture Amp, Pulse Surveys, eNPS, engagement score, great place to work |
| `oos-passport-renewal` | outside the handbook's scope: a government process. `company/offsites` covers visas and ESTA for travel but never mentions passports | passport, renew, renewal, travel document, identity document, embassy, consulate, ESTA, visa |

## Questions

| id | question | expected section(s) | evidence page |
|---|---|---|---|
| customers-from-recommendations | roughly what share of our customers come from people recommending us? | low-prices | p809 |
| team-survey-anonymity | if I fill out the company engagement survey, can anyone see what I said? | people/feedback | p906 |
| ↳ follow-up | how often does that go out? | people/feedback | p906 |
| propose-company-wide-tool | if I want the whole company to start using some new app, how do I get that approved? | company/adding-tools | p32 |
| workflow-pr-review | if my PR touches a github actions workflow, does it need a special reviewer? | company/post-mortems/2025-11-26-shai-hulud-attack | p128 |
| promotion-criteria | is there a rubric or list of criteria I need to hit to move up here? | people/career-progression | p903 |
| browser-extension-billing | a customer runs posthog inside their browser extension and their bill is way higher than it should be, how do they fix it? | onboarding/chrome-extension-billing-case-study-wildfire | p856 |
| support-ticket-split | how do tickets get divvied up on the support team? does everyone work every product? | support/support-smes | p1052 |
| newsletter-owner | who runs Product for Engineers these days? | content/newsletter | p177 |
| sales-lead-threshold | what's the cutoff for a new lead to get worked by sales instead of just going self-serve? | growth/sales/accounts-overview, growth/sales/new-sales, growth/sales/crm, growth/sales/running-trials, growth/sales/overview, growth/sales/how-to-do-discovery, growth/sales/product-led-sales, growth/sales/customer-onboarding, people/hiring-process/sales-cs-hiring, brand/partners | p493 |
| case-study-customer-outreach | I want to interview one of our customers for a story on the website, anyone I should check with before I email them? | marketing/customer-case-studies | p817 |
| ↳ follow-up | do we give them anything for doing it? | marketing/customer-case-studies, marketing/co-marketing | p819 |
| oos-team-survey-score | how did we score on the last staff survey compared to the benchmark? | not-covered | — |
| oos-passport-renewal | how do I renew my passport in time for the offsite? | not-covered | — |

## How it's used

This set is scored with the same rules as set A (see "Scoring" in `eval/QUESTIONS.md`). It was committed **after** all tuning on set A was done: the keyword weight in fusion, and the prompt change forbidding uncited advice. It was then run **once**, so its results show how well that tuning generalizes. No changes were made based on its results.
