/**
 * pnpm run search "how much vacation can I take?"
 *
 * Debugging aid: shows the top results with their similarity to the question, the question's
 * rare words (if any), and which result the keyword safety net put in.
 */
import { bodyText } from "../src/lib/chunk";
import { rareWords } from "../src/lib/search/keyword";
import { loadIndex, search } from "../src/lib/search/search";

async function main() {
  const query = process.argv.slice(2).join(" ").trim();
  if (!query) {
    console.error('Usage: pnpm run search "your question"');
    process.exit(1);
  }

  const index = await loadIndex();
  const started = Date.now();
  const hits = await search(index, query);
  console.log(`"${query}" — ${Date.now() - started} ms (includes loading the model on first query)`);
  const rare = rareWords(index.keyword, query);
  console.log(`rare words (keyword safety net): ${rare.length ? rare.join(", ") : "none"}\n`);

  hits.forEach((hit, i) => {
    const pages = hit.chunk.pages.map((p) => p.page).join(", ");
    const via = hit.via === "keyword" ? "; added by the keyword safety net" : "";
    console.log(`${i + 1}. ${hit.chunk.title}  (p. ${pages}; similarity ${hit.similarity.toFixed(3)}${via})`);
    console.log(`   ${bodyText(hit.chunk).replace(/\s+/g, " ").slice(0, 150)}…\n`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
