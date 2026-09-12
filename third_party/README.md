# Ruflo attribution

`src/cost-report.mjs` adapts the numeric delta and key-union map comparison from
[`plugins/ruflo-cost-tracker/scripts/diff.mjs`](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/plugins/ruflo-cost-tracker/scripts/diff.mjs).

Upstream: ruvnet/ruflo, commit `39e0b0540c9b018174955fc8a21f355bbac26c6a`.
The MIT copyright and permission notice is preserved in `ruflo-cost-LICENSE.txt`.
Changes use Codex token counters, explicit incomplete data and zero-baseline
growth, and remove USD pricing, external CLI/storage and automatic budget actions.
The Codex rollout reader and identity/turn scope checks are local implementation.

`src/retrieval.mjs` also adapts reciprocal rank fusion and maximal marginal
relevance selection from [`v3/@claude-flow/memory/src/smart-retrieval.ts`](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/v3/@claude-flow/memory/src/smart-retrieval.ts)
at the same pinned commit, under the same retained MIT notice. The adaptation
uses stable project knowledge IDs, Unicode Chinese terms, normalized rank
scores, and bounded candidate sets. It omits AgentDB, embeddings, English
prompt templates, recency decay and session round-robin. Source validation
and Markdown/index ownership remain local Workbench code.

The Skill's role/mode/state routing also borrows the always-present constitution
and selectively loaded shards pattern from
[`v3/@claude-flow/guidance/src/retriever.ts`](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/v3/@claude-flow/guidance/src/retriever.ts)
at the same pinned commit. This is a design adaptation in local Markdown rules;
no Guidance package code, hash embeddings or intent classifier is imported.
