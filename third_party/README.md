# Ruflo attribution

`src/cost-report.mjs` adapts the numeric delta and key-union map comparison from
[`plugins/ruflo-cost-tracker/scripts/diff.mjs`](https://github.com/ruvnet/ruflo/blob/39e0b0540c9b018174955fc8a21f355bbac26c6a/plugins/ruflo-cost-tracker/scripts/diff.mjs).

Upstream: ruvnet/ruflo, commit `39e0b0540c9b018174955fc8a21f355bbac26c6a`.
The MIT copyright and permission notice is preserved in `ruflo-cost-LICENSE.txt`.
Changes use Codex token counters, explicit incomplete data and zero-baseline
growth, and remove USD pricing, external CLI/storage and automatic budget actions.
The Codex rollout reader and identity/turn scope checks are local implementation.
