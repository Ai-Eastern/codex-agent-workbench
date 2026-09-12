# Reuse Decision

Decision: Borrow

## Evidence

- Project search: `src/knowledge.mjs::createKnowledge().search` already supplies Chinese Unicode terms, project-scoped FTS5/BM25, source validation, and bounded output. It synchronizes the Vault for every call and returns source-bearing documents without a raw relevance score. `src/workflow.mjs::prepare` freezes that result in the task packet.
- GitHub / official search: one candidate, Ruflo commit `39e0b0540c9b018174955fc8a21f355bbac26c6a`, `v3/@claude-flow/memory/src/smart-retrieval.ts`; inspected `applyRRF`, `reciprocalRankFusion`, `mmrRerank`, query expansion and the public search contract. [Pinned source](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/v3/@claude-flow/memory/src/smart-retrieval.ts).
- License: read the pinned root MIT license, copyright 2024–2026 ruvnet. Existing `third_party/ruflo-cost-LICENSE.txt` retains the same notice; retrieval adaptation will be added to its attribution index.
- Maintenance: the selected revision was verified against main during this research. Its identity is pinned; upstream performance statements are not local evidence.
- Compatibility: upstream `SearchFn` accepts query/namespace/limit/threshold and returns scored candidates. Our synchronous, source-validated API needs a local adaptation. Upstream English keyword/Jaccard tokenization discards Chinese; raw FTS5 scores and RRF scores must not be mixed. Upstream recency/session defaults do not encode our authoritative project decisions.
- Verification: source review only before implementation. Focused tests will verify Chinese handling, one sync per search, ID/source boundaries, stable ranking and final limits. One frozen real-project corpus and independently authored labels will compare the two routes under identical final limits. No performance pass is claimed yet.

## Rationale

Borrow RRF's rank union and MMR's relevance/diversity tradeoff. Keep all scanning, identity, hash checks and source ownership in the existing knowledge module. Use original lexical terms plus a Chinese multi-character/identifier term variant; deduplicate equivalent variants. Normalize fused relevance before the diversity penalty. Keep the first relevance result, use bounded candidate sets, and apply the existing character limit after ranking. Do not add semantic embeddings, AgentDB, model calls, recency decay, session round-robin or automatic policy learning.

Default remains BM25. `strategy: smart` is explicit and frozen per task, with no change to existing run identities. The independent real corpus is small and not human-labelled; its result is a local diagnostic, not general retrieval superiority or a coding-speed claim.

## Next step

Implement the bounded adapter; compare required-knowledge coverage, irrelevant results, no-answer distractors, context characters and retrieval time. Freeze configuration before reading the independent labels. Enable a real task only if required knowledge does not regress and a useful retrieval metric improves without increasing unknown-answer distractors. Otherwise retain the baseline and report the failed adoption gate without repeated tuning.
