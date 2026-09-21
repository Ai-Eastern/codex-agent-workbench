import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configFrom, writeJson} from '../src/contracts.mjs';
import {publishPlan} from '../src/plan.mjs';
import {advance, advancePlan, bindNative, claimNative, finish, getPacket, openStore, prepare, preparePhase, status, submitResult} from '../src/workflow.mjs';
import {pausePortfolio, portfolioStatus, registerPortfolio, releaseWorkers, reserveWorkers, revisePortfolio} from '../src/portfolio.mjs';

// These tests use the real controller and SQLite. Synthetic task identities do
// not establish actual native-agent creation or Desktop host acceptance.
const coordinator = '99999999-9999-4999-8999-999999999999';
const nativeWorker = '33333333-3333-4333-8333-333333333333';
function fixture(t, {register = true} = {}) {
  const parent = fs.realpathSync(os.tmpdir()), root = fs.mkdtempSync(path.join(parent, 'workbench-execution-')), previous = process.env.CODEX_THREAD_ID;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous; assert.equal(path.dirname(root), parent); assert.equal(fs.lstatSync(root).isSymbolicLink(), false); fs.rmSync(root, {recursive: true, force: true}); });
  const configs = {}, bindings = {};
  for (const [id, digit] of [['project-a', '1'], ['project-b', '2']]) {
    const projectRoot = path.join(root, id); fs.mkdirSync(projectRoot);
    const cfg = {projectId: id, projectRoot, workRoot: path.join(projectRoot, 'work'), controlRoot: path.join(projectRoot, 'control'), vaultRoot: path.join(projectRoot, 'knowledge'), maxWorkers: 3, model: 'gpt-6-astra', thinking: 'ultra', captureEnabled: false, pmThreadId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`, workerThreads: {}};
    bindings[id] = path.join(projectRoot, 'project.json'); writeJson(bindings[id], cfg); configs[id] = configFrom(bindings[id]);
    process.env.CODEX_THREAD_ID = cfg.pmThreadId;
    publishPlan(configs[id], {schemaVersion: 1, projectId: id, planId: 'delivery', revision: 1, objective: `Verify ${id}`, phases: [{id: 'build', dependsOn: [], maxNativeWorkers: 3}], tasks: ['direct', 'native'].map(executor => ({id: executor, revision: 1, phaseId: 'build', dependsOn: [], executor, files: [`${executor}.txt`], contextRefs: [], acceptanceRefs: [`check-${executor}`]}))}, {expectedRevision: 0, reason: 'Freeze controller integration fixture'});
  }
  const registry = {controlRoot: path.join(root, 'portfolio'), coordinatorThreadId: coordinator, bindings, manifest: {schemaVersion: 1, portfolioId: 'execution', revision: 1, coordinatorEpoch: 1, budget: {maxActiveWorkers: 2, maxAttemptsPerTask: 2}, projects: Object.keys(configs).map(projectId => ({projectId, planId: 'delivery', acceptedPlanRevision: 1, priority: 1})), dependencies: []}};
  const owner = projectId => { process.env.CODEX_THREAD_ID = configs[projectId].pmThreadId; return configs[projectId]; };
  const prepareGroup = (projectId, executor) => {
    const cfg = owner(projectId);
    return preparePhase(cfg, {expectedRevision: 1, phaseId: 'build', groupId: executor, taskIds: [executor], decision: {topology: 'serial', carrier: executor, context: 'continue', reason: 'One ready task in the selected project'}, checks: [{id: `check-${executor}`, command: process.execPath, args: ['-e', `if(require('node:fs').readFileSync('${executor}.txt','utf8')!==${JSON.stringify(projectId)})process.exit(1)`]}]});
  };
  const reserve = (projectId, runId, current = registry) => { owner(projectId); return reserveWorkers(current, {projectId, runId, expectedEpoch: current.manifest.coordinatorEpoch}); };
  const resources = (current = registry) => { process.env.CODEX_THREAD_ID = coordinator; return portfolioStatus(current).resources; };
  process.env.CODEX_THREAD_ID = coordinator; if (register) registerPortfolio(registry);
  return {configs, registry, owner, prepareGroup, reserve, resources};
}
function taskState(cfg, runId, taskId) {
  return status(cfg, runId).tasks.find(task => task.id === taskId).status;
}

test('persistent registration blocks direct and native phase dispatch until their exact groups have quota', async t => {
  const f = fixture(t), a = f.prepareGroup('project-a', 'direct'), b = f.prepareGroup('project-b', 'native');
  assert.equal(a.nextAction.type, 'RESERVE_WORKERS'); assert.equal(b.nextAction.type, 'RESERVE_WORKERS');
  for (const [id, run, task] of [['project-a', a, 'direct'], ['project-b', b, 'native']]) {
    const cfg = f.owner(id); assert.equal(Object.hasOwn(cfg, 'portfolio'), false);
    await assert.rejects(advancePlan({...cfg}, run.runId), {code: 'RESOURCE_UNAVAILABLE'});
    assert.equal(taskState(cfg, run.runId, task), 'PENDING'); assert.equal(fs.existsSync(getPacket(cfg, run.runId, task).receiptPath), false);
    f.reserve(id, run.runId); const started = await advancePlan(cfg, run.runId);
    assert.equal(started.nextAction.type, task === 'direct' ? 'EXECUTE_DIRECT' : 'CLAIM_NATIVE');
    assert.equal(taskState(cfg, run.runId, task), 'ASSIGNED');
  }
  f.owner('project-b'); const claimed = claimNative(f.configs['project-b'], b.runId, 'native');
  assert.equal(claimed.projectId, 'project-b'); assert.equal(claimed.model, 'gpt-6-astra'); assert.equal(claimed.thinking, 'ultra');
  assert.equal(f.resources().heldWorkers, 2);
});

test('pausing project A rejects its new dispatch while project B advances through its native claim', async t => {
  const f = fixture(t), a = f.prepareGroup('project-a', 'direct'), b = f.prepareGroup('project-b', 'native');
  f.reserve('project-a', a.runId); f.reserve('project-b', b.runId);
  const cfgA = f.owner('project-a'); pausePortfolio(f.registry, {projectId: 'project-a', paused: true, expectedEpoch: 1});
  await assert.rejects(advancePlan(cfgA, a.runId), {code: 'PROJECT_PAUSED'}); assert.equal(taskState(cfgA, a.runId, 'direct'), 'PENDING');
  const cfgB = f.owner('project-b'); await advancePlan(cfgB, b.runId); claimNative(cfgB, b.runId, 'native');
  assert.equal(taskState(cfgB, b.runId, 'native'), 'NATIVE_CLAIMED'); assert.equal(f.resources().heldWorkers, 2);
});

test('a global pause between assignment and native claim is checked again before claiming', async t => {
  const f = fixture(t), b = f.prepareGroup('project-b', 'native'), cfg = f.configs['project-b']; f.reserve('project-b', b.runId);
  const started = await advancePlan(cfg, b.runId), attempt = started.packets[0].attemptId;
  process.env.CODEX_THREAD_ID = coordinator; pausePortfolio(f.registry, {paused: true, expectedEpoch: 1});
  f.owner('project-b'); assert.throws(() => claimNative(cfg, b.runId, 'native'), {code: 'PORTFOLIO_PAUSED'});
  assert.equal(taskState(cfg, b.runId, 'native'), 'ASSIGNED');
  process.env.CODEX_THREAD_ID = coordinator; pausePortfolio(f.registry, {paused: false, expectedEpoch: 1});
  f.owner('project-b'); assert.equal(claimNative(cfg, b.runId, 'native').attemptId, attempt);
});

test('global pause still collects in-flight direct and native results and automatically releases verified completion', async t => {
  const f = fixture(t), a = f.prepareGroup('project-a', 'direct'), b = f.prepareGroup('project-b', 'native');
  f.reserve('project-a', a.runId); const aPacket = (await advancePlan(f.configs['project-a'], a.runId)).packets[0];
  f.reserve('project-b', b.runId); await advancePlan(f.configs['project-b'], b.runId);
  const bPacket = claimNative(f.configs['project-b'], b.runId, 'native'); bindNative(f.configs['project-b'], b.runId, 'native', nativeWorker);
  process.env.CODEX_THREAD_ID = coordinator; pausePortfolio(f.registry, {paused: true, expectedEpoch: 1});
  fs.writeFileSync(aPacket.files[0], 'project-a'); const cfgA = f.owner('project-a');
  const aDone = await finish(cfgA, a.runId, 'direct', {expectedAttemptId: aPacket.attemptId, summary: 'Direct fixture delivered while new dispatch is paused'});
  assert.equal(aDone.status, 'COMPLETE'); assert.equal(aDone.resources.released, true); assert.equal(aDone.plan.nextAction.type, 'SELECT_GROUP');
  assert.equal(releaseWorkers(f.registry, {projectId: 'project-a', runId: a.runId, expectedEpoch: 1}).reused, true);
  fs.writeFileSync(bPacket.files[0], 'project-b'); process.env.CODEX_THREAD_ID = nativeWorker;
  submitResult(f.configs['project-b'], b.runId, 'native', {expectedAttemptId: bPacket.attemptId, summary: 'Bound worker result'});
  f.owner('project-b'); const bDone = await advancePlan(f.configs['project-b'], b.runId);
  assert.equal(bDone.status, 'COMPLETE'); assert.equal(bDone.resources.released, true);
  const resources = f.resources(); assert.equal(resources.heldWorkers, 0); assert.equal(resources.paused, true);
});

test('portfolio revision updates the persistent guard and prevents an old epoch from starting a prepared run', async t => {
  const f = fixture(t), a = f.prepareGroup('project-a', 'direct'); f.reserve('project-a', a.runId);
  const next = structuredClone(f.registry); next.manifest.revision = 2; next.manifest.coordinatorEpoch = 2; next.manifest.projects[1].priority = 9;
  process.env.CODEX_THREAD_ID = coordinator; revisePortfolio(f.registry, next, {expectedRevision: 1, expectedEpoch: 1, reason: 'New coordinator generation'});
  const cfgA = f.owner('project-a');
  await assert.rejects(advancePlan(cfgA, a.runId), {code: 'OWNER_EPOCH_MISMATCH'});
  await assert.rejects(advance(cfgA, a.runId), {code: 'OWNER_EPOCH_MISMATCH'});
  assert.equal(taskState(cfgA, a.runId, 'direct'), 'PENDING');
  const store = openStore(cfgA);
  try { assert.equal(JSON.parse(store.db.prepare('SELECT registry FROM portfolio_binding WHERE id=1').get().registry).manifest.coordinatorEpoch, 2); }
  finally { store.close(); }
  const b = f.prepareGroup('project-b', 'direct'); f.reserve('project-b', b.runId, next);
  assert.equal((await advancePlan(f.configs['project-b'], b.runId)).nextAction.type, 'EXECUTE_DIRECT');
});

test('a preserved legacy run remains on its original contract when portfolio registration is introduced', async t => {
  const f = fixture(t, {register: false}), cfg = f.owner('project-a');
  const legacy = prepare(cfg, {id: 'legacy-before-registration', mode: 'direct', reason: 'Preserve the pre-plan execution contract', objective: 'Legacy artifact', tasks: [{id: 'legacy', objective: 'Write legacy result', files: ['legacy.txt']}], checks: [{id: 'legacy', command: process.execPath, args: ['-e', 'process.exit(0)']}]});
  const original = getPacket(cfg, legacy.runId, 'legacy');
  process.env.CODEX_THREAD_ID = coordinator; registerPortfolio(f.registry); f.owner('project-a');
  assert.equal((await advance(cfg, legacy.runId)).nextAction.type, 'EXECUTE_DIRECT');
  assert.deepEqual(getPacket(cfg, legacy.runId, 'legacy'), original); assert.equal(f.resources().heldWorkers, 0);
});
