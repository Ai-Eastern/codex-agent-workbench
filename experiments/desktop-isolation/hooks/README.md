# Managed PreToolUse probe

Result: **FAIL as a complete isolation boundary.** One GPT-5.5/low Desktop task could read its own history; explicit foreign-host and omitted-host foreign reads were denied. Injecting hook process exit 1 let Desktop return the foreign synthetic marker. Enforcement was restored and live testing stopped. See the [verified result](../../../docs/desktop-hooks-results-20260911.md).

This code is an experiment fixture, not an installable production security policy. It contains deliberate fault injection and allows tools outside the scoped `read_thread` test. Do not install it as a whole-tool sandbox.

## Reuse Decision

Decision: Borrow

### Evidence
- Project search: `src/desktop.mjs` checks target ownership in its own wrapper, but a worker can call native `codex_app.read_thread` directly; the original Desktop isolation experiment proved that route returns another group's canary.
- Official search: [Hooks](https://learn.chatgpt.com/docs/hooks#managed-hooks-from-requirementstoml) documents managed `requirements.toml`, pinned hooks, synchronous PreToolUse deny decisions and tool-coverage exceptions.
- License: reuse the installed Apache-2.0 Codex CLI and Python standard library; no upstream application source is copied. The hook protocol is adapted from official documentation.
- Maintenance: use the existing locally built Docker runtime; no package installation or new framework. Record the resulting image identity locally.
- Compatibility: remote CLI 0.153.4 reports `hooks stable true`. This does not prove its Desktop dynamic tool path is intercepted; that is the live experiment.
- Verification: first check the guard's bounded allow/deny contract and protected configuration, then use a real GPT-5.5/low Desktop task. Preserve existing failure evidence.

### Rationale

Install an immutable script and system-managed requirements in an experimental image. Put the tiny target policy in a root-owned directory on the existing private server volume so only the coordinator can change the test case. Reuse the A container's home, work and SSH volumes; preserve the old stopped container for rollback and do not change Desktop global permissions.

### Experiment protocol

Confirm ordinary same-group reads, explicit foreign-host reads, omitted-host foreign-task reads, and behavior when the hook process fails. The script's deliberate `crash` mode is only fault injection for this experiment, never a production feature. Stop after any confirmed enforcement counterexample. Hooks are not assumed to cover every Desktop tool.

The local audit file is diagnostic and worker-writable, not a tamper-proof audit trail. Correlate its call IDs with actual Desktop tool calls and raw outputs. This run did not persist a separate hook event in the rollout. No private task identity or canary belongs in this directory.
