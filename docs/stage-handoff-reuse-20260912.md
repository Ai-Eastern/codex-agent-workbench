# Reuse Decision

Decision: Take

## Evidence

- Project search: `workflow.mjs::acceptanceSummary`, `status`, `projectIdentity`, stored acceptance/knowledge receipts already provide verified delivery state. `cli.mjs::continue` already avoids repeated checks, but does not produce the reusable complete handoff object. Current baseline: `228a524`.
- GitHub / official search: this is a bounded integration of the existing local controller; no external implementation or dependency is copied. Read-only Desktop entry inspection found read/send tools, no exposed task-compaction entry. The official [Responses Compact API](https://developers.openai.com/api/reference/java/resources/responses/methods/compact) is not documented as a Codex Desktop task operation.
- License: reuse the user's existing local project implementation under the current authorization; no new third-party source or license assumption.
- Maintenance: the current local controller and 101-test suite are the integration surface.
- Compatibility: completed-run identity includes the PM ID. A new phase PM must use a new configuration file while preserving the old configuration and control store; editing an old PM ID in place would invalidate prior run access.
- Verification: focused tests must reject incomplete/paused/stale evidence and demonstrate repeated summary reads do not execute acceptance or capture again.

## Rationale

Expose the existing completion facts as one bounded `delivery` result and reuse it in `continue`. Keep authorization, write ownership, acceptance and knowledge boundaries. One GM turn chooses and dispatches an already-authorized task. A short handoff carries evidence references rather than conversation history; it does not claim to compact an existing task.

## Next step

Add the minimal delivery projection and Skill guidance. Use the user's existing authorization for a project-visible test task to open one fresh PM phase, preserving the prior task/configuration. Validate on the next real LianYu data-tooling task and report one-time setup separately from product work. No artificial parallel workers or repeated source evaluation.
