// Seeded random draw of handbook sections for the eval set, so the sections aren't hand-picked.
// node eval/sample-sections.mjs  →  prints two shuffled lists (policy areas, everything else)
import { readFileSync } from "node:fs";

const SEED = 20261002;
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (list, rand) => {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const { chunks } = JSON.parse(readFileSync("data/index/chunks.json", "utf8"));
const paths = [...new Set(chunks.map((c) => c.sectionPath))].sort();
const isPolicy = (p) => /^contents\/handbook\/(people|company)\//.test(p) || /^contents\/handbook\/[^/]+\.md$/.test(p);

const rand = mulberry32(SEED);
console.log(JSON.stringify({
  seed: SEED,
  policy: shuffle(paths.filter(isPolicy), rand),
  other: shuffle(paths.filter((p) => !isPolicy(p)), rand),
}, null, 1));
