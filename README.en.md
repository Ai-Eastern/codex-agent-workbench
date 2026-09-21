# Codex Agent Workbench

**Run a coding task against your own Git repository and receive a patch backed by independent command acceptance.**

Define the objective, exact writable files and acceptance commands. Workbench creates a detached Git worktree, invokes your local Codex CLI, records execution events and runs acceptance through its controller. Failures remain available. Explicit repair creates a new attempt. Accepted changes become a reviewable diff with artifact hashes; you decide how to merge them.

[中文](README.md) · [Evidence map](docs/evidence-map.md) · [Verification record](docs/verification-20260921.md)

![The actual workbench task form](docs/assets/workbench.png)

One small real Codex CLI task has completed the coding → independent acceptance → patch flow. This establishes one working path, not a model benchmark. **The project remains private and its original code is all rights reserved under [LICENSE](LICENSE). It has not been formally open-sourced.**

## Start the workbench

Requirements: **Node.js 24+, Git and an installed, usable Codex CLI**. The target repository needs a commit. Prepare the tools and dependencies required by its acceptance commands. Workbench uses existing Codex authentication and quota; Desktop task registration is not required.

From this project's directory, replace the example paths:

~~~sh
npm ci
npm start -- --repo "D:/projects/my-app" --state "D:/workbench-state/my-app"
~~~

--repo must identify the target Git root; --state must be outside it. Open the printed loopback URL, normally http://127.0.0.1:4317. Starting the server does not start coding. **Submitting a task invokes Codex and uses your quota.**

Add --port 4318 if needed. Add --executable "D:/tools/codex.exe" when native executable discovery is unavailable. On Windows, supported npm shims are resolved without interpolating prompts into shell commands.

1. Describe the objective and expected behavior.
2. List exact writable repository-relative files, one per line, using /. Directories and globs are not supported.
3. Supply an acceptance argv array, such as ["node", "--test", "test/example.test.js"]. List protected acceptance files separately; they cannot also be writable files.
4. Start coding and inspect actual status, recent events, the agent summary and acceptance results. Full acceptance stdout / stderr is available after hash verification. Active execution can be stopped.
5. After failed acceptance, give a specific reason to authorize one repair. Once ready for review, inspect or download the diff.

The worktree starts from the target repository's **HEAD commit**. Uncommitted changes, ignored node_modules and local environment files are not copied. Workbench does not automatically commit, merge or push.

## Try one real task

A separate generated repository provides a small end-to-end task:

~~~sh
npm run smoke:agent -- --output .local/real-smoke
~~~

**This uses real Codex authentication and quota**, with a 120-second execution budget. The output directory must not exist. It repairs a label-normalization function in a newly created repository, runs fixed Node acceptance and saves summary.json plus task evidence. It is not a zero-model demo, and CI does not automatically invoke it.

One real call through a temporary script using the same execution path reached READY_FOR_REVIEW, changed only the allowed implementation file, passed two fixed assertions and preserved the source repository. The new smoke:agent entry passed help and safe-rejection checks; it has not made an additional model call. The observed call inherited local model configuration; the service-observed model identity was unavailable. See the [verification record](docs/verification-20260921.md).

## Implemented behavior

| Behavior | Implementation |
|---|---|
| Prompt on stdin, retained JSONL and stderr, successful exit plus completed-turn evidence | [Codex executor](src/codex-executor.mjs) |
| Detached worktree, exact file scope and binary-capable patch export | [Git workspace](src/git-workspace.mjs) |
| Controller-owned acceptance, frozen acceptance-file checks and artifact binding | [Local runner](src/local-runner.mjs), [acceptance process](src/local-check.mjs) |
| Preserved failures, one explicit repair, existing task IDs reused without another model call | [Workflow](src/workflow.mjs) |
| Explicitly selected Markdown retrieved through local FTS5/BM25 and frozen into task context | [Knowledge](src/knowledge.mjs) |

Each task in this new entry point has one coding executor using the bounded direct route. Automatic knowledge capture is disabled. Existing native-subagent and Desktop/LangGraph routes remain separate in the [Desktop guide](docs/desktop-guide.md); they are not parallel-agent features of this new UI.

## CLI

Adapt [agent-task.example.json](examples/agent-task.example.json) to your repository. Its acceptance and knowledge paths must exist in the selected base commit. CLI requests need a stable id; the browser generates one.

~~~sh
npm run agent -- run --repo "D:/projects/my-app" --state "D:/workbench-state/my-app" --request examples/agent-task.example.json
npm run agent -- status --state "D:/workbench-state/my-app" --run normalize-labels
npm run agent -- diff --state "D:/workbench-state/my-app" --run normalize-labels
~~~

Use --ref on run to select another baseline. Optional model and reasoning request fields only override configuration when supplied. Default execution timeoutMs is 600000.

~~~sh
npm run agent -- repair --state "D:/workbench-state/my-app" --run normalize-labels --reason "Fix the boundary input rejected by acceptance"
npm run agent -- continue --state "D:/workbench-state/my-app" --run normalize-labels
~~~

Repair requires confirmed failed acceptance and has a one-attempt budget. Continue resumes acceptance from EXECUTED / ACCEPTING, or revalidates completed delivery; it does not silently restart interrupted coding. Reusing an ID returns its existing run. Changing that ID's contract is rejected. Blocked runs and stale execution locks require inspection.

## Records and boundaries

State lives under --state/runs/<task-id>/: manifest, phase events, retained worktree, per-attempt execution logs, executor result, controller acceptance and, after acceptance, candidate.patch. Browser-launched tasks also retain activity.jsonl. The UI shows recent events; full retained records are the files on disk. Logs can contain source, prompts and tool output; inspect them before sharing.

- Codex is invoked with workspace-write. Workbench's whitelist, hashes and Git worktrees do not add an OS security sandbox or hidden-test confidentiality.
- Acceptance-file hashes are checked at boundaries. This is not tamper-proof storage or continuous file-access enforcement. Ignored runtime caches outside the whitelist are excluded from patch checks.
- Source HEAD and candidate HEAD changes are detected. Changes to the original worktree's uncommitted contents are not fully monitored throughout a task.
- The loopback API checks Host, origin and a session token. It does not provide public hosting, team authorization or container isolation.
- Passing local commands still requires human review. No reproducible public evidence currently establishes model success rates, speedups or cost advantages.

## Additional mechanism checks

~~~sh
npm test
npm run evaluate -- --output .local/mechanism-check-001
npm run demo -- --report .local/mechanism-check-001/report.json --port 4318
~~~

Evidence Lab is a secondary, read-only mechanism viewer with public fixed patches and zero model calls. It exercises the controller and Node acceptance. Assertion counts are not coding-agent benchmark scores; its screenshots are not actual coding-task evidence. Use a new output directory for every evaluation.

[Evidence map](docs/evidence-map.md) · [Verification](docs/verification-20260921.md) · [Product direction](docs/product-direction.md) · [Evaluation protocol](docs/evaluation-protocol.md) · [Third-party notices](third_party/README.md)
