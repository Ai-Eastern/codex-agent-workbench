# Reuse Decision

Decision: Borrow

## Evidence

- Project search (tool-backed anchors): `src/usage.mjs::summarizeUsage` already validates cumulative Codex counters and marks resets incomplete; it does **not** yet consume `token_usage_record`. The previous local `audit-attributed-usage.mjs` demonstrates unique response ID sums reconciled with per-turn counters. Reuse both existing approaches, do not replace them with a Claude parser.
- GitHub / official search (tool-backed anchors): pinned Ruflo commit `39e0b0540c9b018174955fc8a21f355bbac26c6a`, committed 2026-09-12; scoped snapshot includes all cost-plugin files plus root license/manifest and its CI workflow. Full per-file evaluation is recorded separately. Source: [diff.mjs](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/plugins/ruflo-cost-tracker/scripts/diff.mjs), specifically `diffNumber` and `diffMap`; [track.mjs](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/plugins/ruflo-cost-tracker/scripts/track.mjs), `summarizeSession`; [_sessions.mjs](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/plugins/ruflo-cost-tracker/scripts/_sessions.mjs), `loadSessions`.
- License: inspected root MIT License, copyright 2024–2026 ruvnet; retained notice accompanies adapted comparison logic.
- Maintenance: current main commit and all downloaded Git blob identities verified; this is provenance evidence, not an upstream reliability guarantee. The snapshot differs from the earlier exploratory review and remains frozen for this evaluation.
- Compatibility (contract comparison): upstream reads Claude `assistant.message.usage`, maps models to Anthropic price tiers and defaults unknown prices to zero. Codex emits explicit `turn_id/response_id`, per-response and per-turn counters; cached input is included in input. A Codex subscription bill is not derivable. Upstream analytics load sessions through repeated npx/AgentDB calls; the local controller already has explicit run/task identity and local logs.
- Verification (commands/tests and observed result): executed only inspected upstream `diff.mjs` against two synthetic local snapshots, without network or package installation. Baseline 0 → current 10 with a 1% threshold returned exit 0 and `alert.triggered=false`: Infinity growth is excluded by `isFinite`. Local adaptation must represent a new category explicitly, never silently treat it as zero growth. Codex parser/report changes require focused tests before the real product task.

## Rationale

Borrow the upstream numeric/key-union snapshot comparison and token-class presentation. Adapt them to explicit project/role/turn scope, integer token counts, missing/partial evidence and baseline-zero growth. Preserve the MIT notice and exact source reference. Existing Codex collection will be extended to reconcile attributed response records; no Claude project scan, dynamic npx install, AgentDB service, price table, assumed model downgrade or autonomous hard-stop budget is included.

Stage labels must identify their evidence. Role/turn attribution is exact where recorded; inferred tool-purpose labels are not exact token causality. Retain unclassified work and count framework evaluation/implementation separately from recurring product delivery. Observed input/cache repetition alone does not prove avoidable waste.

## Next step

Add an explicit-manifest local usage report and snapshot delta command; retain incomplete-data diagnostics. Apply it to the next real LianYu data-engineering delivery, with GM and PM using the existing desktop roles. Do not create synthetic work solely to occupy workers. Whole-plugin evaluation continues independently and will list every file, external dependency boundary and executed versus unexecuted verification.
