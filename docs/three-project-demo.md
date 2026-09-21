# Three-project fixture and saved-evidence verification

This is the self-contained fixture portion of WB-08. It is **not a completed real Codex run**, a hidden benchmark, or a model performance result. The governing requirements remain [DEVELOPMENT.md §19](../DEVELOPMENT.md#19-首个三项目真实验收). The three fixtures use Node ESM and `node:test` without npm dependencies.

## Frozen business contracts

Every project contains `src/config.mjs`; each acceptance script checks both its distinct `projectId` and `moduleKind`. This detects accidental routing of the same-named file from another project.

| Project/version | Public interface | Frozen functional acceptance |
| --- | --- | --- |
| A v1 | `importTickets(rows)` → `{ imported, errors }` | Keep valid `{id,title}` rows in input order. Report one-based `row` with `INVALID_ROW`, `ID_REQUIRED`, `TITLE_REQUIRED`, or `DUPLICATE_ID`. First valid occurrence wins; an invalid row does not reserve its ID. Inputs are not mutated. |
| A v2 | `importTickets(rows, {tenantId, existing = []})` → `{ imported, errors }` | Explicit nonblank tenant context required. Rows require a matching tenant; errors add `TENANT_REQUIRED` and `TENANT_MISMATCH`. IDs are unique within the active tenant, including `existing`; another tenant's ID does not conflict. Imported rows retain `tenantId`. |
| B v1 | `createClient({transport}).request(path, options)` and `.request({path, method, body})` | Both call shapes make the same transport request, default to GET, return `response.data`, preserve thrown transport errors, and reject HTTP status ≥400 with `code: HTTP_ERROR` and the status. A blank/missing path is rejected before transport. |
| C v1 | `rankResults(results, {projectId})` | Require explicit project scope; filter before sorting by descending finite score, then ascending case-sensitive codepoint ID. IDs are unique strings within a project. Preserve input and prevent same-named A/B knowledge from entering C results. |

A v2 deliberately changes the accepted interface; a passing A v1 result is preserved as historical evidence and cannot satisfy A v2. Validation precedence is row shape → tenant checks (v2) → ID → title → duplicate. Valid string values are preserved; blank detection does not silently trim identifiers.

[acceptance-lock.json](../examples/three-projects/acceptance-lock.json) freezes the four acceptance scripts and defective starting sources by SHA-256. The integration owner owns these scripts. Executors change `src/` only; a business change needs a new acceptance version and retained prior evidence. These tests are readable in the same account and are functional acceptance, not blind evaluation.

The committed sources intentionally contain real defects: A aborts on an invalid row and admits duplicates; B only understands the object call and ignores HTTP errors; C inherits input tie order and omits project filtering. `reference/` contains explicit **fixture reference implementations**, not agent deliveries. Repository setup does not copy them into the three working repositories.

## Reproduce without paid model calls

From the Workbench repository:

```sh
node --test test/three-projects.test.mjs
node --test test/three-projects-runtime.test.mjs
node examples/three-projects/prepare.mjs
node scripts/verify-three-projects.mjs
```

The first command creates temporary copies, verifies named baseline failures, applies the reference implementation only to those copies, and checks the frozen acceptance. It also checks wrong-project config, A v1 versus v2, and malformed saved lifecycle evidence. Temporary Git repositories and synthetic receipts are removed on completion. Expected business baseline failures are A: 2, B: 3, C: 2; they are assertions inside the passing fixture test, not broken repository tests.

The runtime integration test uses three independent Git fixtures with the actual plan, portfolio, handoff and workflow controllers. It runs A v1, B v1, C v1 and A v2 through frozen `node:test` acceptance, verifies that A's revision preserves B/C snapshots, transfers B's paused original run and attempt to a separate configuration, and checks project/global pause plus a 2-to-1 worker limit. Reference patches supply the business code, and Desktop observations are injected fixtures. This tests controller composition and original receipt preservation, not real model delivery or a real new Desktop context.

The prepare command creates a new temporary directory containing three independent Git repositories and `setup.json` with the actual base commit for each. An optional destination must not already exist. It only initializes these directories, uses per-command Git identity/signing options, and does not edit global Git configuration. Commit IDs are recorded per setup run, not assumed to be identical across machines. Do not commit generated `.git` directories or evidence to Workbench.

The verifier has no manifest by default and returns `status: incomplete`, `hostAcceptance: false`, exit code 2. Missing real host evidence is an expected support gap. It does not create tasks, drive the controller, call a model, or manufacture a run.

Inside each generated repository, use `node --test acceptance/v1.test.mjs` for the initial baseline. After A's approved revision, use `node --test acceptance/v2.test.mjs`. The integration harness can run the original frozen scripts against a worktree using `WORKBENCH_FIXTURE_ROOT`; this override is only a source location, not an identity or authorization.

## Real run still required

1. Use one coordinator entry and bind three genuinely distinct project contexts to the generated repositories. Save raw host snapshots, private session identities, requested model/reasoning, observably reported runtime model/reasoning (or explicit `null`), baseline commits, and acceptance failures. Configure private runtime state outside this repository.
2. Record stage routing and resource decisions; start with at most the authorized capacity and no obligation to fill all slots. A project lead may do its small task directly. Establish task/attempt/packet versions before dispatch. Do not use `reference/` as model-generated work.
3. While an A v1 attempt is outstanding, inject the tenant requirement, publish plan v2, and record the old result as superseded. Preserve B/C plan hashes and artifact hashes before/after the change. Accept A only against frozen v2.
4. At a safe B checkpoint, preserve a valid completed delivery, outstanding work, failure/interruption facts, and user constraints. Record the interruption and the real newly created context's host identity. Resume from the handoff with a new owner epoch; do not redispatch the valid delivery. A historical-context fork does not count as a new clean context.
5. Pause A and change C priority. Record B and C progress while A is paused; keep uncertain work reservations until host completion is confirmed. Record a real worker-capacity adjustment within the original budget. Pause the portfolio, confirm no dispatch during that interval, then resume only with authorization tied to the current run and owner.
6. Commit reviewable source changes separately in each repository. Run the independent frozen final acceptance against those exact commits, saving raw TAP and complete source hashes. Preserve all failed attempts. Export controller events and actual tool results; verify the saved manifest below and independently review its raw host provenance.

**Current boundary:** This fixture implementation supplies business cases and an offline evidence gate. No three project contexts, real model deliveries, B new-context recovery, live pause/resource behavior, runtime model observations, or paid evaluation have been performed by this fixture work. A registered project/session configuration and authentic controller/host exports are prerequisites to the real run. The fixture helper is not a host adapter or an automatic exporter. Where the host requires explicit user authorization to create additional visible tasks, the development document cannot grant it; use authorized creation or manually created tasks followed by binding. Missing capabilities remain `CAPABILITY_UNAVAILABLE`/incomplete while ordinary source and fixture work continues.

## Private evidence manifest

[evidence.schema.json](../examples/three-projects/evidence.schema.json) specifies the top-level manifest. `verify-three-projects.mjs` enforces its required fields and the cross-record rules below without an external schema dependency. Pass a saved manifest as the sole argument:

```sh
node scripts/verify-three-projects.mjs path/to/private-run/manifest.json
```

Keep the three repositories and evidence files beneath the manifest directory. All references are artifact-map keys; every artifact specifies a relative `path` and SHA-256 of its exact bytes. Absolute paths, traversal, and symlink escapes are rejected. Raw identities, transcripts, tool responses and local paths belong in this private directory, never public Git. The verifier is read-only but requires Git to inspect the saved repositories and exact baseline/final objects.

The manifest records `schemaVersion: 1`, `kind: real-host` (or `fixture` for test data), `runId`, ISO `recordedAt`, `host: {name, version, toolVersion}`, `budget: {maxActiveWorkers}`, `coordinatorRef`, `eventsRef`, `usageRef`, `timingRef`, an `artifacts` map, and exactly one entry for each project. Project entries contain `projectId`, relative `repository`, `baseCommit`, `finalCommit`, `identityRef`, `planRevisions` (A `[1,2]`, B/C `[1]`), `baselineAcceptanceRef`, and `acceptanceRef`.

| Saved record | Required contents |
| --- | --- |
| Identity | `projectId` (`portfolio` for coordinator), `actorId`, `sessionId`, `requestedModel`, `requestedReasoning`, `observedModel`, `observedReasoning`, `hostSnapshotRef`; B's replacement also requires `contextMode: new`. Unknown observed configuration is `null` and keeps the result incomplete. |
| Raw host snapshot | `source: codex-tool`, actual `tool` name, `observedAt`, and original tool response in `body`. The associated session identity must appear in the saved body. Preserve the original source alongside any normalized export; this wrapper is not a cryptographic host signature. |
| Acceptance report | `projectId`, `commit`, `revision`, `command: ["node","--test","--test-reporter=tap","acceptance/vN.test.mjs"]`, `acceptanceHash`, `exitCode`, `passed`, `failed`, `outputRef`, and `sourceHashes` covering every tracked `src/` file. Baseline v1 must have named failures; final A v2 and B/C v1 must pass. Record raw TAP with the explicit reporter flag shown here. |
| Event sequence | JSON array ordered by contiguous `seq`, with `type`, `actorId`, `coordinatorEpoch`, `evidenceRef`; project events also have `projectId` and `planRevision`. Initial owner epochs are 1 for this bounded scenario. |
| Event evidence | `source: controller-export`, `event` equal to the sequence event without `evidenceRef`. Dispatch, result, interruption and context-resume exports additionally require `hostSnapshotRef` to the recorded tool result. |
| Usage | `roles` array covering coordinator, every project context and B's replacement, with `sessionId`, `inputTokens`, `outputTokens`. Unknown usage is explicit `null` and keeps verification incomplete. Real additional workers must be included in the recording; this first scenario models direct project-lead execution. |
| Timing | Nonnegative observed `coordinationMs` and `executionMs`; zero is only appropriate if actually observed, never a substitute for missing telemetry. This fixture does not measure or claim model efficiency. |

Event-specific fields:

| Event | Required fields / relation |
| --- | --- |
| `DISPATCH` | `actionId`, `attemptId`, `taskId`, positive `taskRevision`, `packetHash`; no duplicate action or attempt, no paused dispatch, and active attempts must fit current capacity. |
| `RESULT` / `RESULT_SUPERSEDED` | Original `attemptId`, `planRevision`, `taskRevision`, `packetHash`; `status` is `done`, `failed`, or `cancelled`; `hostCompletionConfirmed: true` plus the host snapshot. Superseded A v1 results are retained and cannot satisfy A v2 acceptance. |
| `ACCEPT` | `acceptanceRef` equals that project's final report, a current-version successful delivery exists, and no attempt remains active for the project. |
| `REQUIREMENTS_CHANGED` | A v1 event with `nextRevision: 2`, `beforeRef` and `afterRef`. Both artifacts map B/C project IDs to unchanged `{planHash, artifactHashes}`. |
| `INTERRUPTED` | B event with `handoffRef`. Handoff contains matching `projectId`/`planRevision` and nonempty `constraints`, `failedAttempts`, `unfinished`, `validDeliveries` arrays. `validDeliveries` are completed task IDs. |
| `CONTEXT_RESUMED` | B event by the old owner with `handoffRef`, replacement `identityRef`, `nextEpoch: 2`, `preservedDeliveries` identical to the handoff. Subsequent B events use the new owner and epoch. |
| `PROJECT_PAUSED` / `PROJECT_RESUMED` | A pause followed by resume with `authorizationRef`. B and C must show completed work during A's pause. |
| `PRIORITY_CHANGED` | C event with a positive `priority`, preceding C's progress during A's pause. |
| `RESOURCE_CHANGED` | Coordinator event with a changed positive `maxActiveWorkers`, no smaller than active reservations and no larger than the original budget. |
| `PORTFOLIO_PAUSED` / `PORTFOLIO_RESUMED` | Coordinator events; resume requires `authorizationRef`. Authorization records have `source: user`, matching `runId`, and `scope: project-resume` or `portfolio-resume`; retain the original authorizing user input privately. |

The validator refuses missing lifecycle events, changed frozen acceptance, mismatched hashes, unchanged/invalid base/final commits, stale versions, wrong project/owner, duplicate dispatch, invalid capacity, dispatch during pause, repeated preserved B deliveries, incomplete handoff and missing final acceptance. It does not execute source or tests from the manifest.

`incomplete` (exit 2) means missing/invalid evidence or unavailable observations. `evidence-verified` (exit 0) means only the saved records are internally consistent. Both retain `hostAcceptance: false`: hashes and locally supplied JSON cannot independently authenticate Codex execution. Fixture data always remains incomplete even if its internal consistency checks pass. A reviewer must inspect actual host provenance before marking WB-08 real acceptance complete. Publish only redacted aliases, commit/artifact hashes, observed results and explicit missing items; do not publish this private manifest or pretend a synthetic passing trace is a real run.
