import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {configFrom, digest, writeJson} from '../src/contracts.mjs';
import {publishPlan} from '../src/plan.mjs';
import {advance, advancePlan, finish, openStore, pause, preparePhase, submitResult, supersedePhase} from '../src/workflow.mjs';
import {acceptHandoff, createHandoff} from '../src/handoff.mjs';
import {assertRunPermit, observeProject, pausePortfolio, portfolioStatus, registerPortfolio, releaseUndispatched, releaseWorkers, reserveWorkers, revisePortfolio} from '../src/portfolio.mjs';

const coordinator = '99999999-9999-4999-8999-999999999999';
function fixture(t, {capacity = 1, attempts = 2, native = false, dependencies = [], sharedArtifact = false} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-budget-')), before = process.env.CODEX_THREAD_ID;
  t.after(() => { if (before === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = before; fs.rmSync(root, {recursive: true, force: true}); });
  const configs = {}, bindings = {}, plans = {};
  for (const [id, digit] of [['project-a', '1'], ['project-b', '2']]) {
    const projectRoot = path.join(root, id); fs.mkdirSync(projectRoot);
    const cfg = {projectId: id, projectRoot, workRoot: path.join(projectRoot, 'work'), controlRoot: path.join(projectRoot, 'control'), vaultRoot: path.join(projectRoot, 'knowledge'), pmThreadId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`, workerThreads: {}, model: 'gpt-6-astra', thinking: 'ultra', maxWorkers: 3, captureEnabled: false};
    bindings[id] = path.join(projectRoot, 'project.json'); writeJson(bindings[id], cfg); configs[id] = configFrom(bindings[id]);
    plans[id] = {schemaVersion: 1, projectId: id, planId: 'delivery', revision: 1, objective: `Implement ${id}`, phases: [{id: 'build', dependsOn: [], maxNativeWorkers: 3}], tasks: [1, 2, 3, 4].map(i => ({id: `task-${i}`, revision: 1, phaseId: 'build', dependsOn: [], executor: native ? 'native' : 'direct', files: [`value-${i}.txt`], contextRefs: [], acceptanceRefs: [`check-${i}`]}))};
    if (sharedArtifact && id === 'project-a') plans[id].tasks[0].artifacts = [{id: 'shared-result', version: 1, path: 'value-1.txt'}];
    process.env.CODEX_THREAD_ID = cfg.pmThreadId; publishPlan(configs[id], plans[id], {expectedRevision: 0, reason: 'Authorized fixture plan'});
  }
  const registry = {controlRoot: path.join(root, 'portfolio'), coordinatorThreadId: coordinator, bindings, manifest: {schemaVersion: 1, portfolioId: 'budget-fixture', revision: 1, coordinatorEpoch: 1, budget: {maxActiveWorkers: capacity, maxAttemptsPerTask: attempts}, projects: Object.keys(configs).map(projectId => ({projectId, planId: 'delivery', acceptedPlanRevision: 1, priority: projectId === 'project-a' ? 10 : 1})), dependencies}};
  const registryFile = path.join(root, 'registry.json'); writeJson(registryFile, registry); process.env.CODEX_THREAD_ID = coordinator; registerPortfolio(registry);
  const owner = id => { process.env.CODEX_THREAD_ID = configs[id].pmThreadId; return configs[id]; };
  const prepare = (id, numbers = [1], revision = 1) => {
    const cfg = owner(id);
    return preparePhase(cfg, {expectedRevision: revision, phaseId: 'build', groupId: `group-${revision}-${numbers.join('-')}`, taskIds: numbers.map(i => `task-${i}`), decision: {topology: native ? 'parallel' : 'serial', carrier: native ? 'native' : 'direct', context: 'continue', reason: 'Ready independent fixture work'}, checks: numbers.map(i => ({id: `check-${i}`, command: process.execPath, args: ['-e', `if(require('node:fs').readFileSync('value-${i}.txt','utf8')!=='done')process.exit(1)`]}))});
  };
  const reserve = (id, runId, selectedRegistry = registry, expectedEpoch = selectedRegistry.manifest.coordinatorEpoch) => { owner(id); return reserveWorkers(selectedRegistry, {projectId: id, runId, expectedEpoch}); };
  const complete = async (id, runId, {autoRelease = true} = {}) => {
    const cfg = owner(id), started = await advancePlan(cfg, runId), packet = started.packets[0];
    fs.writeFileSync(packet.files[0], 'done');
    const result = {expectedAttemptId: packet.attemptId, summary: 'Fixture completed'};
    if (autoRelease) await finish(cfg, runId, packet.taskId, result);
    else { submitResult(cfg, runId, packet.taskId, result); await advance(cfg, runId); }
    return packet;
  };
  const resources = (selectedRegistry = registry) => { process.env.CODEX_THREAD_ID = coordinator; return portfolioStatus(selectedRegistry).resources; };
  return {root, registry, registryFile, configs, plans, owner, prepare, reserve, complete, resources};
}

test('group reservation counts actual work, persists binding and is idempotent for one action', t => {
  const f = fixture(t, {capacity: 3}), run = f.prepare('project-a');
  const store = openStore(f.configs['project-a']);
  try { assert.deepEqual(JSON.parse(store.db.prepare('SELECT registry FROM portfolio_binding WHERE id=1').get().registry), f.registry); }
  finally { store.close(); }
  assert.throws(() => assertRunPermit(f.registry, f.configs['project-a'], run.runId), {code: 'RESOURCE_UNAVAILABLE'});
  const first = f.reserve('project-a', run.runId), again = f.reserve('project-a', run.runId);
  assert.equal(first.status, 'RESERVED'); assert.equal(first.reservation.workerCount, 1); assert.equal(again.reused, true);
  assert.deepEqual(first.reservation, again.reservation); assert.equal(assertRunPermit(f.registry, f.configs['project-a'], run.runId).allowed, true);
  assert.equal(f.resources().heldWorkers, 1); assert.equal(f.resources().reservations.length, 1);
  assert.throws(() => reserveWorkers(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}), {code: 'ACTOR_MISMATCH'});
});

test('two independent processes competing for one slot cannot both reserve it', async t => {
  const f = fixture(t), runs = ['project-a', 'project-b'].map(id => [id, f.prepare(id).runId]);
  const module = pathToFileURL(path.resolve('src/portfolio.mjs')).href;
  const execute = ([projectId, runId]) => new Promise((resolve, reject) => {
    const script = `import {reserveWorkers} from ${JSON.stringify(module)};try{process.stdout.write(JSON.stringify(reserveWorkers(${JSON.stringify(f.registryFile)},${JSON.stringify({projectId, runId, expectedEpoch: 1})})))}catch(e){process.stderr.write(e.stack);process.exitCode=1}`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {env: {...process.env, CODEX_THREAD_ID: f.configs[projectId].pmThreadId}, windowsHide: true});
    let stdout = '', stderr = ''; child.stdout.on('data', data => stdout += data); child.stderr.on('data', data => stderr += data); child.on('error', reject); child.on('close', code => resolve({code, stdout, stderr}));
  });
  const results = await Promise.all(runs.map(execute));
  assert(results.every(result => result.code === 0), JSON.stringify(results));
  assert.deepEqual(results.map(result => JSON.parse(result.stdout).status).sort(), ['RESERVED', 'WAITING']);
  assert.equal(f.resources().heldWorkers, 1);
});

test('project pause leaves unrelated projects eligible and global pause blocks every new dispatch', t => {
  const f = fixture(t, {capacity: 2}), a = f.prepare('project-a'), b = f.prepare('project-b'); f.reserve('project-a', a.runId);
  f.owner('project-a'); pausePortfolio(f.registry, {projectId: 'project-a', paused: true, expectedEpoch: 1});
  assert.throws(() => assertRunPermit(f.registry, f.configs['project-a'], a.runId), {code: 'PROJECT_PAUSED'});
  assert.throws(() => pausePortfolio(f.registry, {projectId: 'project-b', paused: true, expectedEpoch: 1}), {code: 'ACTOR_MISMATCH'});
  assert.equal(f.reserve('project-b', b.runId).status, 'RESERVED');
  assert.throws(() => pausePortfolio(f.registry, {paused: true, expectedEpoch: 1}), {code: 'ACTOR_MISMATCH'});
  process.env.CODEX_THREAD_ID = coordinator; const paused = pausePortfolio(f.registry, {paused: true, expectedEpoch: 1});
  assert.equal(paused.inFlight, 'UNCHANGED_PENDING_HOST_EVIDENCE'); assert.equal(f.resources().heldWorkers, 2);
  f.owner('project-b'); assert.throws(() => assertRunPermit(f.registry, f.configs['project-b'], b.runId), {code: 'PORTFOLIO_PAUSED'});
  process.env.CODEX_THREAD_ID = coordinator; pausePortfolio(f.registry, {paused: false, expectedEpoch: 1});
  f.owner('project-b'); assert.equal(assertRunPermit(f.registry, f.configs['project-b'], b.runId).allowed, true);
  f.owner('project-a'); assert.throws(() => assertRunPermit(f.registry, f.configs['project-a'], a.runId), {code: 'PROJECT_PAUSED'});
});

test('UNKNOWN and failed completion do not release or allocate another reservation', t => {
  const f = fixture(t), a = f.prepare('project-a'), b = f.prepare('project-b'); f.reserve('project-a', a.runId);
  const store = openStore(f.configs['project-a']);
  try { store.db.prepare("UPDATE runs SET status='BLOCKED' WHERE id=?").run(a.runId); store.db.prepare("UPDATE tasks SET status='RESERVED' WHERE run_id=?").run(a.runId); }
  finally { store.close(); }
  assert.throws(() => f.reserve('project-a', a.runId), {code: 'DISPATCH_UNKNOWN'});
  assert.throws(() => releaseWorkers(f.registry, {projectId: 'project-a', runId: a.runId, expectedEpoch: 1}), {code: 'RECONCILE_REQUIRED'});
  assert.equal(f.reserve('project-b', b.runId).status, 'WAITING'); assert.equal(f.resources().heldWorkers, 1);
  const failed = openStore(f.configs['project-a']);
  try { failed.db.prepare("UPDATE runs SET status='FAILED' WHERE id=?").run(a.runId); failed.db.prepare("UPDATE tasks SET status='DONE' WHERE run_id=?").run(a.runId); }
  finally { failed.close(); }
  f.owner('project-a');
  assert.throws(() => f.reserve('project-a', a.runId), {code: 'RECONCILE_REQUIRED'});
  assert.throws(() => assertRunPermit(f.registry, f.configs['project-a'], a.runId), {code: 'RECONCILE_REQUIRED'});
  assert.throws(() => releaseWorkers(f.registry, {projectId: 'project-a', runId: a.runId, expectedEpoch: 1}), {code: 'RECONCILE_REQUIRED'});
});

test('capacity release requires current accepted artifacts and recorded receipt byte hashes', async t => {
  const f = fixture(t), run = f.prepare('project-a'); f.reserve('project-a', run.runId);
  // The supported lower-level submit/advance path leaves release explicit, so
  // this unit test can inspect stale completion evidence before returning quota.
  const packet = await f.complete('project-a', run.runId, {autoRelease: false}), receipt = fs.readFileSync(packet.receiptPath);
  fs.appendFileSync(packet.receiptPath, ' ');
  assert.throws(() => releaseWorkers(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}), {code: 'INPUT_STALE'});
  assert.equal(f.resources().heldWorkers, 1); fs.writeFileSync(packet.receiptPath, receipt);
  fs.writeFileSync(packet.files[0], 'tampered'); f.owner('project-a');
  assert.throws(() => releaseWorkers(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}), /stale|changed|Acceptance/);
  fs.writeFileSync(packet.files[0], 'done'); const first = releaseWorkers(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1});
  assert.equal(first.released, true); assert.equal(first.reservation.status, 'RELEASED');
  assert.equal(releaseWorkers(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}).reused, true);
  assert.equal(f.resources().heldWorkers, 0);
});

test('a waiting lower priority project gets capacity before a just-served project can refill it', async t => {
  const f = fixture(t), firstA = f.prepare('project-a'), secondA = f.prepare('project-a', [2]), b = f.prepare('project-b');
  f.reserve('project-a', firstA.runId); assert.equal(f.reserve('project-b', b.runId).status, 'WAITING');
  await f.complete('project-a', firstA.runId); releaseWorkers(f.registry, {projectId: 'project-a', runId: firstA.runId, expectedEpoch: 1});
  const wait = f.reserve('project-a', secondA.runId); assert.equal(wait.status, 'WAITING'); assert.equal(wait.candidateOrder[0].projectId, 'project-b');
  assert.equal(f.reserve('project-b', b.runId).status, 'RESERVED');
  await f.complete('project-b', b.runId); releaseWorkers(f.registry, {projectId: 'project-b', runId: b.runId, expectedEpoch: 1});
  assert.equal(f.reserve('project-a', secondA.runId).status, 'RESERVED');
});

test('native groups reserve atomically and cannot expand one owner beyond three workers', t => {
  const f = fixture(t, {capacity: 4, native: true}), a = f.prepare('project-a', [1, 2, 3]), more = f.prepare('project-a', [4]), b = f.prepare('project-b', [1, 2]);
  assert.equal(f.reserve('project-a', a.runId).reservation.workerCount, 3);
  assert.equal(f.reserve('project-a', more.runId).status, 'WAITING'); assert.equal(f.reserve('project-b', b.runId).status, 'WAITING');
  assert.equal(f.resources().heldWorkers, 3); assert.equal(f.resources().reservations.length, 1);
});

test('revision CAS preserves history, rejects budget expansion, and invalidates old owner epochs', t => {
  const f = fixture(t, {capacity: 2}), run = f.prepare('project-a'); f.reserve('project-a', run.runId);
  const next = structuredClone(f.registry); next.manifest.revision = 2; next.manifest.coordinatorEpoch = 2; next.manifest.projects[1].priority = 20;
  process.env.CODEX_THREAD_ID = coordinator;
  const expanded = structuredClone(next); expanded.manifest.budget.maxActiveWorkers = 3;
  assert.throws(() => revisePortfolio(f.registry, expanded, {expectedRevision: 1, expectedEpoch: 1, reason: 'not authorized'}), {code: 'BUDGET_EXPANSION_FORBIDDEN'});
  assert.equal(revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'New owner generation'}).revision, 2);
  assert.throws(() => revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'Stale writer'}), {code: 'PLAN_CONFLICT'});
  f.owner('project-a'); assert.throws(() => reserveWorkers(next, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}), {code: 'OWNER_EPOCH_MISMATCH'});
  assert.throws(() => assertRunPermit(next, f.configs['project-a'], run.runId), {code: 'OWNER_EPOCH_MISMATCH'});
  assert.equal(f.resources(next).heldWorkers, 1);
});

test('overview revision must match an activated plan and task attempt counts survive revisions', async t => {
  const f = fixture(t, {attempts: 1}), first = f.prepare('project-a'); f.reserve('project-a', first.runId); await f.complete('project-a', first.runId);
  releaseWorkers(f.registry, {projectId: 'project-a', runId: first.runId, expectedEpoch: 1});
  const next = structuredClone(f.registry); next.manifest.revision = 2; next.manifest.projects[0].acceptedPlanRevision = 2;
  process.env.CODEX_THREAD_ID = coordinator;
  assert.throws(() => revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'No source plan yet'}), {code: 'INPUT_STALE'});
  f.owner('project-a'); const revised = {...f.plans['project-a'], revision: 2, tasks: f.plans['project-a'].tasks.map(task => task.id === 'task-1' ? {...task, revision: 2} : task)};
  publishPlan(f.configs['project-a'], revised, {expectedRevision: 1, reason: 'Changed task contract'});
  process.env.CODEX_THREAD_ID = coordinator; revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'Observe revision two'});
  const second = f.prepare('project-a', [1], 2);
  assert.throws(() => f.reserve('project-a', second.runId, next), {code: 'ATTEMPT_BUDGET_EXHAUSTED'});
});

test('owner rebinding without an accepted identity transfer never becomes a portfolio revision', t => {
  const f = fixture(t), cfg = f.configs['project-a'], nextFile = path.join(cfg.projectRoot, 'next-project.json');
  writeJson(nextFile, {...cfg, pmThreadId: '33333333-3333-4333-8333-333333333333'});
  const next = structuredClone(f.registry); next.bindings['project-a'] = nextFile; next.manifest.revision = 2; next.manifest.coordinatorEpoch = 2;
  assert.throws(() => revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'Unproved replacement'}), {code: 'CAPABILITY_UNAVAILABLE'});
  assert.equal(portfolioStatus(f.registry).revision, 1);
});

test('accepted handoff evidence permits owner migration while preserving attempts and rejecting the old owner', async t => {
  // This exercises local protocol fixtures, not a real new Desktop model context.
  const f = fixture(t), run = f.prepare('project-a'), cfg = f.configs['project-a']; f.reserve('project-a', run.runId);
  const git = (...args) => {
    const result = spawnSync('git', ['-C', cfg.workRoot, ...args], {encoding: 'utf8', windowsHide: true});
    assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
  };
  git('init', '--quiet'); fs.writeFileSync(path.join(cfg.workRoot, 'baseline.txt'), 'fixture'); git('add', '.');
  git('-c', 'user.name=Protocol Fixture', '-c', 'user.email=protocol@example.invalid', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(f.root, 'no-hooks')}`, 'commit', '-m', 'fixture baseline');
  pause(cfg, run.runId);
  const handoff = createHandoff(cfg, {id: 'owner-migration', runId: run.runId, expectedPlanRevision: 1, expectedHead: git('rev-parse', 'HEAD'), budget: {maxActiveWorkers: 1, maxAttemptsPerTask: 2}, nextStep: 'Resume the same frozen attempt after receiving the portfolio owner grant.', allowedActions: ['READ_STATE', 'RESUME']});
  const newId = '33333333-3333-4333-8333-333333333333', nextFile = path.join(cfg.projectRoot, 'next-project.json');
  writeJson(nextFile, {...cfg, pmThreadId: newId}); const nextCfg = configFrom(nextFile);
  const receiptPath = path.join(cfg.controlRoot, 'host-evidence', 'session.json');
  writeJson(receiptPath, {schemaVersion: 1, kind: 'registered', threadId: newId, sourceThreadId: cfg.pmThreadId, context: 'fresh', forkedFrom: null, cwd: cfg.projectRoot, createdAt: Date.now(), receiptId: 'protocol-fixture-registration', registeredBy: 'user', registrationReason: 'Synthetic protocol fixture'});
  const bytes = fs.readFileSync(receiptPath);
  process.env.CODEX_THREAD_ID = newId;
  await acceptHandoff(nextCfg, {handoffId: handoff.handoffId, expectedHash: handoff.packetHash, expectedHead: git('rev-parse', 'HEAD'), sessionEvidence: {kind: 'registered', threadId: newId, sourceThreadId: cfg.pmThreadId, cwd: cfg.projectRoot, receiptPath, receiptHash: digest(bytes)}, desktop: {read: async id => ({id, cwd: cfg.projectRoot, archived: false, status: id === cfg.pmThreadId ? 'idle' : 'active', turnId: `fixture-${id}`, turnStatus: id === cfg.pmThreadId ? 'completed' : 'inProgress'})}});
  const next = structuredClone(f.registry); next.bindings['project-a'] = nextFile; next.manifest.revision = 2; next.manifest.coordinatorEpoch = 2;
  process.env.CODEX_THREAD_ID = coordinator; fs.appendFileSync(receiptPath, ' ');
  assert.throws(() => revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'Observe accepted owner'}), {code: 'INPUT_STALE'});
  fs.writeFileSync(receiptPath, bytes);
  revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'Observe accepted owner'});
  const resource = f.resources(next); assert.equal(resource.heldWorkers, 1); assert.equal(resource.reservations[0].epoch, 2);
  assert.equal(observeProject(next, 'project-a').summary.runs[0].status, 'PAUSED');
  process.env.CODEX_THREAD_ID = cfg.pmThreadId;
  assert.throws(() => reserveWorkers(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}), {code: 'ACTOR_MISMATCH'});
  process.env.CODEX_THREAD_ID = newId;
  assert.throws(() => assertRunPermit(next, nextCfg, run.runId), {code: 'PROJECT_PAUSED'});
});

test('retired undispatched preparation releases against its frozen proof after a plan change without refunding attempts', t => {
  const f = fixture(t, {attempts: 1}), first = f.prepare('project-a'); f.reserve('project-a', first.runId);
  const cfg = f.configs['project-a'], revised = {...f.plans['project-a'], revision: 2, tasks: f.plans['project-a'].tasks.map(task => task.id === 'task-1' ? {...task, revision: 2} : task)};
  publishPlan(cfg, revised, {expectedRevision: 1, reason: 'Replace the undispatched task contract'});
  supersedePhase(cfg, first.runId, {expectedPlanRevision: 2, reason: 'This preparation never reached assignment'});
  const initial = releaseUndispatched(f.registry, {projectId: 'project-a', runId: first.runId, expectedEpoch: 1});
  assert.equal(initial.delivery, 'NOT_SENT'); assert.equal(initial.reused, false);
  assert.equal(releaseUndispatched(f.registry, {projectId: 'project-a', runId: first.runId, expectedEpoch: 1}).reused, true);
  assert.throws(() => f.reserve('project-a', first.runId), {code: 'RESULT_SUPERSEDED'});
  assert.equal(f.resources().heldWorkers, 0);
  const next = structuredClone(f.registry); next.manifest.revision = 2; next.manifest.projects[0].acceptedPlanRevision = 2;
  revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'Observe replacement plan'});
  const replacement = f.prepare('project-a', [1], 2);
  assert.throws(() => f.reserve('project-a', replacement.runId, next), {code: 'ATTEMPT_BUDGET_EXHAUSTED'});
});

test('undispatched release rejects changed proof, assigned or unknown state, late events and disk results', t => {
  const cases = [
    ['proof', 'INPUT_STALE', (store, runId) => store.db.prepare("UPDATE plan_retirements SET evidence=evidence||' ' WHERE run_id=?").run(runId)],
    ['assigned', 'DISPATCH_UNKNOWN', (store, runId) => store.db.prepare("UPDATE tasks SET status='ASSIGNED' WHERE run_id=?").run(runId)],
    ['unknown', 'DISPATCH_UNKNOWN', (store, runId) => store.db.prepare("UPDATE runs SET status='BLOCKED',reason='UNCONFIRMED_DO_NOT_RETRY' WHERE id=?").run(runId)],
    ['events', 'DISPATCH_UNKNOWN', (store, runId) => store.event(runId, 'dispatch_intent', {taskId: 'task-1'})],
    ['attempt', 'INPUT_STALE', (store, runId) => store.db.prepare("UPDATE tasks SET attempt='changed-attempt' WHERE run_id=?").run(runId)],
    ['result', 'DISPATCH_UNKNOWN', (store, runId, cfg) => writeJson(path.join(cfg.controlRoot, 'runs', runId, 'results', 'late.json'), {unconfirmed: true})],
  ];
  for (const [name, code, mutate] of cases) {
    const f = fixture(t), run = f.prepare('project-a'), cfg = f.configs['project-a']; f.reserve('project-a', run.runId);
    supersedePhase(cfg, run.runId, {expectedPlanRevision: 1, reason: `Undispatched fixture ${name}`});
    const store = openStore(cfg); try { mutate(store, run.runId, cfg); } finally { store.close(); }
    assert.throws(() => releaseUndispatched(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}), {code}, name);
    assert.equal(f.resources().heldWorkers, 1, name);
  }
});

test('undispatched release requires retirement proof and preserves another controller lock', t => {
  const f = fixture(t), run = f.prepare('project-a'), cfg = f.configs['project-a']; f.reserve('project-a', run.runId);
  assert.throws(() => releaseUndispatched(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}), {code: 'INPUT_STALE'});
  supersedePhase(cfg, run.runId, {expectedPlanRevision: 1, reason: 'Retire before dispatch'});
  const lock = path.join(cfg.controlRoot, '.runner.lock'); fs.writeFileSync(lock, 'other owner');
  assert.throws(() => releaseUndispatched(f.registry, {projectId: 'project-a', runId: run.runId, expectedEpoch: 1}), {code: 'EEXIST'});
  assert.equal(fs.readFileSync(lock, 'utf8'), 'other owner'); assert.equal(f.resources().heldWorkers, 1);
});

const dependency = () => ({from: {projectId: 'project-a', planId: 'delivery', planRevision: 1, taskId: 'task-1', taskRevision: 1, artifactId: 'shared-result', artifactVersion: 1, artifactHash: digest('done')}, to: {projectId: 'project-b', planId: 'delivery', planRevision: 1, taskId: 'task-1', taskRevision: 1}});

test('cross-project tasks wait for the exact declared source delivery and reject later source artifact changes', async t => {
  const f = fixture(t, {capacity: 2, dependencies: [dependency()], sharedArtifact: true}), source = f.prepare('project-a'), target = f.prepare('project-b');
  assert.throws(() => f.reserve('project-b', target.runId), {code: 'DEPENDENCY_NOT_READY'});
  f.reserve('project-a', source.runId); const packet = await f.complete('project-a', source.runId);
  assert.equal(f.reserve('project-b', target.runId).status, 'RESERVED');
  assert.equal(assertRunPermit(f.registry, f.configs['project-b'], target.runId).allowed, true);
  fs.writeFileSync(packet.files[0], 'unaccepted source');
  await assert.rejects(advancePlan(f.configs['project-b'], target.runId), {code: 'INPUT_STALE'});
  assert.equal(f.resources().heldWorkers, 1);
});

test('cross-project artifact IDs, versions, task revisions and hashes must match the frozen source declaration', async t => {
  for (const changes of [{artifactId: 'unknown'}, {artifactVersion: 2}, {taskRevision: 2}, {artifactHash: digest('another artifact')}, {toTaskRevision: 2}]) {
    const relation = dependency();
    if (changes.toTaskRevision) relation.to.taskRevision = changes.toTaskRevision; else Object.assign(relation.from, changes);
    const f = fixture(t, {dependencies: [relation], sharedArtifact: true}), source = f.prepare('project-a'), target = f.prepare('project-b');
    f.reserve('project-a', source.runId); await f.complete('project-a', source.runId);
    assert.throws(() => f.reserve('project-b', target.runId), {code: 'INPUT_STALE'}, JSON.stringify(changes));
    assert.equal(f.resources().heldWorkers, 0);
  }
  const f = fixture(t, {dependencies: [dependency()]}), target = f.prepare('project-b');
  assert.throws(() => f.reserve('project-b', target.runId), {code: 'INPUT_STALE'});
});

test('a source acceptance or task receipt hash change invalidates an already reserved cross-project permit', async t => {
  const f = fixture(t, {dependencies: [dependency()], sharedArtifact: true}), source = f.prepare('project-a'), target = f.prepare('project-b');
  f.reserve('project-a', source.runId); const packet = await f.complete('project-a', source.runId);
  f.reserve('project-b', target.runId);
  for (const file of [path.join(f.configs['project-a'].controlRoot, 'runs', source.runId, 'acceptance.json'), packet.receiptPath]) {
    const bytes = fs.readFileSync(file); fs.appendFileSync(file, ' ');
    assert.throws(() => assertRunPermit(f.registry, f.configs['project-b'], target.runId), {code: 'INPUT_STALE'});
    fs.writeFileSync(file, bytes);
  }
  assert.equal((await advancePlan(f.configs['project-b'], target.runId)).nextAction.type, 'EXECUTE_DIRECT');
});
