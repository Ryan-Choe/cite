/**
 * npm run search -- "how much vacation can I take?"
 *
 * Debugging aid: shows the hybrid top results, and where the keyword (BM25) and semantic
 * (embedding) retrievers each ranked them.
 */
import { bodyText } from "../src/lib/chunk";
import { loadIndex, search } from "../src/lib/search/search";

async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('Usage: npm run search -- "your question"');
    process.exit(1);
  }

  const index = await loadIndex();
  const started = Date.now();
  const hits = await search(index, query);
  console.log(`"${query}" — ${Date.now() - started} ms (includes loading the model on first query)\n`);

  hits.forEach((hit, i) => {
    const ranks = `keyword #${hit.keywordRank ?? "–"}, semantic #${hit.semanticRank ?? "–"}`;
    const pages = hit.chunk.pages.map((p) => p.page).join(", ");
    console.log(`${i + 1}. ${hit.chunk.title}  (p. ${pages}; ${ranks})`);
    console.log(`   ${bodyText(hit.chunk).replace(/\s+/g, " ").slice(0, 150)}…\n`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
