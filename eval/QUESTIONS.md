# How the eval questions were written

`eval/questions.json` has 13 questions: 10 that the handbook answers (3 of them have a follow-up question) and 3 that it does not. The aim was to ask what a new PostHog employee would actually ask, not what the app's search happens to handle well.

## Choosing sections

- `eval/sample-sections.mjs` shuffles every handbook section with a seeded PRNG (mulberry32, seed `20261002`). The output is saved in `.cache/eval-sample.json`.
- It writes two lists. **policy** has `people/*`, `company/*` and the top-level handbook pages. **other** has everything else (sales, engineering, support, marketing and so on).
- We went through each list in order and took the first 5 *usable* sections from each. A section is usable if it states at least one concrete fact someone at PostHog might need to look up, such as a rule, process, number, owner, timeline or definition. A section could only be skipped for having no fact like that, never because a question about it would be hard.
- **No sections were skipped.** The first five sections in each list all qualified:
  - policy: `people/side-gigs`, `story`, `how-we-make-money`, `people/hogpatch`, `company/post-mortems/2026-02-20-posthog-us-logs-data-loss`
  - other: `growth/growth-engineering/product-intents`, `growth/sales/customer-onsites`, `marketing/events`, `cs-and-onboarding/new-hire-onboarding-exercise`, `support/troubleshooting-tips`
  - One close call: `cs-and-onboarding/new-hire-onboarding-exercise` is mostly a list of practice questions. It does include one concrete procedure, the SQL query for pulling the org IDs of the accounts you own, so it counts as usable.

## Writing the questions

- Each section gets one question, written the way someone would type it into a chat box: short, casual and in their own words. Questions don't name the section title.
- **Paraphrasing:** questions avoid the passage's distinctive wording. For example, the handbook says "side gig" and the question says "paid freelance work outside my job". The handbook says "budgetary support" and the question says "how much do we usually chip in?". Three of the ten use a name an employee would already know: *Hogpatch*, *Logs* and *Salesforce*.
- Each question targets a fact someone would plausibly need, not trivia.
- **Follow-ups:** three questions have a second question that only makes sense after the first one ("did we get any of it back?"). Each follow-up has a `standalone` version that spells out the missing context, and its answer is confirmed to be in the handbook.

## Finding the right answers

- The only source used was the section text in `.cache/sections-preview.md`, the parsed handbook PDF with one line per paragraph and page tags. **The app's search was never run or read** while writing the questions. That means no `pnpm run search`, no `pnpm eval`, no `src/lib/search/`, no vectors and no chunk preview.
- After writing each question, we grepped the whole section file with several keywords and synonyms to find *other* sections that also answer it. A section went into `expect` only if it actually contains the answer, not if it merely mentions the topic. Each `evidence` quote was checked to appear word for word on the cited page of the first expected section.
- Places where we had to make a judgement call:
  - `hogpatch-founder-access`: `brand/startups` lists "Access to HogPatch for the duration of their time in the batch" as a perk of the YC deal. That conflicts with `people/hogpatch` ("invite-only, … you can't apply"), so it was left out of `expect`. `people/hogpatch-operations` ("a handpicked group of YC founders") is included.
  - `onsite-visit-threshold`: the handbook gives two different thresholds. `customer-onsites` says $50k+/yr and `expansion-and-retention` says regularly see $100k+ accounts. Both are expected. `growth/sales/customer-training` also says to pitch a half-day onsite *training* to $80k+ in-office customers. It was left out because that is a training tip, not guidance on which accounts to visit.
  - `who-founded-posthog`: `content/newsletter` has "When Tim and I first started PostHog in 2020", but only as an example of a writing hook, and "I" isn't named. It was left out.

## Out-of-scope questions

Each of these is close to something the handbook does cover, but asks for a detail it never gives. To confirm that, we grepped the section file for these terms:

| id | what the handbook does cover | terms checked |
|---|---|---|
| `oos-hogpatch-address` | Hogpatch is "off 3rd Street", about 100 yards from YC, and "the exact location is listed on your digital wallet pass" | address, street, 3rd Street, third street, location, Dogpatch, Hogpatch, zip, postcode, office |
| `oos-option-vesting` | Everyone gets options (`future`), there is a 10-year exercise window after leaving (`people/offboarding`), and a "standard PostHog equity schedule" is mentioned but never described (`strong-team`) | vesting, vested, vests, cliff, 4-year, four year, equity schedule, vesting schedule, share option, stock option, strike, 409A, exercise, equity, grant |
| `oos-oncall-pay` | How the on-call rotation works, including weekend shifts (`engineering/operations/on-call-rotation`), but nothing about pay or time off for doing it | on-call, on call, oncall, pager, paged, weekend, overtime, extra pay, additional pay, stipend, allowance, bonus, compensation, in lieu, TOIL, comp time, time back |

## Questions

| id | question | expected section(s) | evidence page |
|---|---|---|---|
| freelance-work-allowed | can I do some paid freelance work outside my job here? | people/side-gigs | p965 |
| ↳ follow-up | do I need to run it by anyone first? | people/side-gigs | p966 |
| who-founded-posthog | who started posthog and when? | story, brand/press | p1028 |
| contract-feature-deadline | a big prospect wants a feature promised by Q3 written into their contract - is that ok? | how-we-make-money, growth/sales/overview | p808 |
| hogpatch-founder-access | how does a YC founder get a desk at Hogpatch? | people/hogpatch, people/hogpatch-operations | p944 |
| logs-data-loss-cause | why did US customers lose their older Logs data in February? | company/post-mortems/2026-02-20-posthog-us-logs-data-loss | p137 |
| ↳ follow-up | did we get any of it back? | company/post-mortems/2026-02-20-posthog-us-logs-data-loss | p139 |
| product-intent-timing | we're launching a beta soon - when do we need to start tracking which users are interested in our product? | growth/growth-engineering/product-intents | p462 |
| onsite-visit-threshold | which of my accounts are big enough to be worth visiting in person? | growth/sales/customer-onsites, growth/sales/expansion-and-retention | p561 |
| meetup-sponsorship-amount | a customer is organizing a dev meetup and asked us for money - how much do we usually chip in? | marketing/events | p822 |
| salesforce-org-ids | how do I pull the posthog org IDs for all my accounts out of salesforce? | cs-and-onboarding/new-hire-onboarding-exercise, growth/sales/user-event-streams | p240 |
| customer-site-debug-mode | how can I see what posthog is doing on a customer's live site? | support/troubleshooting-tips, cs-and-onboarding/foundation-check | p1060 |
| ↳ follow-up | what about checking if they've set up a reverse proxy? | support/troubleshooting-tips, cs-and-onboarding/foundation-check, cs-and-onboarding/health-checks | p1060 |
| oos-hogpatch-address | what's the street address for Hogpatch? I'm in SF next week | not covered | n/a |
| oos-option-vesting | how does vesting work for my stock options - is there a one-year cliff? | not covered | n/a |
| oos-oncall-pay | do we get paid extra or get a day off for covering weekend on-call? | not covered | n/a |

## Scoring (decided before the first run)

- **Retrieval** (`pnpm eval`): an answerable question passes if a chunk from any expected section is among the top 8 search results. *(Later changed: the check now counts only the chunk holding the question's evidence quote, because a section has a median of 10 chunks (13 on average) and the looser rule overstated recall. See [SEARCH.md](SEARCH.md).)*
- **Answers** (`pnpm eval --answers`): answerable questions and follow-ups pass if Cite answers with at least one citation from an expected section. Follow-ups are asked with their first question as conversation history, so they go through the rewriting step.
- **Out-of-scope:** the question **passes** if Cite declines. If Cite gives a **partial answer** instead, the result is **review**. That is allowed by Cite's rules (cite what the handbook says, and state plainly what it doesn't), and all three out-of-scope questions sit right next to covered topics. A person reads each "review" answer to check it names the gap and doesn't invent the missing detail.
- To reproduce the section draw, run `node eval/sample-sections.mjs`. It writes the same shuffled lists every time.
