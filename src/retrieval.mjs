// RRF and MMR adapted from ruvnet/ruflo smart-retrieval.ts, commit
// 39e0b0540c9b018174955fc8a21f355bbac26c6a. MIT, (c) 2024–2026 ruvnet.
// See third_party/README.md and ruflo-cost-LICENSE.txt for attribution.

export function termVariants(terms) {
  // No generated facts or extra LLM call: a second lexical query emphasizes
  // Chinese bigrams/identifiers instead of incidental individual characters.
  const precise = terms.filter(term => Array.from(term).length > 1);
  return precise.length && precise.length !== terms.length ? [terms, precise] : [terms];
}

export function fuseAndDiversify(rankedLists, tokenize, limit) {
  const fused = new Map();
  for (const list of rankedLists) {
    const seen = new Set();
    for (const [rank, candidate] of list.entries()) {
      if (seen.has(candidate.id)) continue;
      seen.add(candidate.id);
      const item = fused.get(candidate.id) ?? { candidate, score: 0 };
      item.score += 1 / (60 + rank + 1);
      fused.set(candidate.id, item);
    }
  }
  const pool = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, 50);
  if (!pool.length) return [];
  const maximum = pool[0].score;
  // ponytail: at most 50 candidates and 8192 characters per candidate; lexical
  // Jaccard is intentionally not semantic paraphrase detection.
  for (const item of pool) {
    item.relevance = item.score / maximum;
    item.terms = new Set(tokenize(`${item.candidate.title}\n${item.candidate.text}`.slice(0, 8192)));
  }
  const selected = [pool.shift()];
  while (pool.length && selected.length < limit) {
    let best = 0, bestScore = -Infinity;
    for (const [i, item] of pool.entries()) {
      let overlap = 0;
      for (const prior of selected) {
        let intersection = 0;
        for (const term of item.terms) if (prior.terms.has(term)) intersection++;
        const union = item.terms.size + prior.terms.size - intersection;
        overlap = Math.max(overlap, union ? intersection / union : 0);
      }
      const score = 0.8 * item.relevance - 0.2 * overlap;
      if (score > bestScore) { best = i; bestScore = score; }
    }
    selected.push(pool.splice(best, 1)[0]);
  }
  return selected.map(item => item.candidate);
}
