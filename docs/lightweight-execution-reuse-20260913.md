# Reuse Decision

Decision: Borrow

## Evidence

- Project search: `src/cli.mjs` execute, `src/workflow.mjs` prepare/advance/claimNative/bindNative/submitResult/delivery, `src/contracts.mjs` validateRequest and projectIdentity. Existing native still uses the same StateGraph and ownership ledger.
- Official search: one [LangGraph persistence page](https://docs.langchain.com/oss/javascript/langgraph/persistence), retrieved 2026-09-13. It distinguishes execution checkpoints from longer-lived knowledge. No new dependency or copied external code is needed.
- License: this repository's `LICENSE` reserves Eastern's rights to original code; installed LangGraph `node_modules/@langchain/langgraph/LICENSE` is MIT. Package manifest pins LangGraph 1.4.14 and checkpoint-sqlite 1.0.4.
- Maintenance: local baseline `c9f26cdaed7e7f0da7618c0c373bd6927f05f4aa`; extend maintained local entrypoints, without migrating storage or old task contracts.
- Compatibility: retain project identity, run/attempt, complete write-set reservation, real native creation/binding, receipt hash validation, one formal acceptance and evidence-bound capture. The CLI cannot create a Codex native agent; PM still calls the real native tool.
- Verification: 155 tests, 154 passed, no failures, one existing platform skip. Ten added lifecycle tests include paused creation and interrupted finish; source and installed Skill validators passed. See [results](lightweight-execution-results-20260913.md).

## Rationale

Combine existing operations into `begin` for new direct/native work, transactional native batch binding, and `finish` for direct PM submission plus acceptance. Existing low-level commands and recovery remain. The fresh native begin response alone permits creation; repeated begin returns the existing state without another claim or creation prompt. This reduces model-facing protocol operations while retaining the existing state machine.

## Next step

Implement these bounded entrypoints and useful knowledgeCandidate field errors, update the Skill's PM/GM routing, then verify lifecycle, actor, ownership, replay and failure boundaries. Do not treat reduced command count as measured end-to-end savings.
