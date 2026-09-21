import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareProjects} from '../examples/three-projects/prepare.mjs';
import {configFrom, digest, readJson, writeJson} from '../src/contracts.mjs';
import {activePlan, publishPlan} from '../src/plan.mjs';
import {advancePlan, finish, getPacket, openStore, pause, phaseStatus, preparePhase, status} from '../src/workflow.mjs';
import {acceptHandoff, createHandoff} from '../src/handoff.mjs';
import {observeProject, pausePortfolio, portfolioStatus, registerPortfolio, reserveWorkers, revisePortfolio} from '../src/portfolio.mjs';

const fixtures = fileURLToPath(new URL('../examples/three-projects/', import.meta.url));
const coordinator = '99999999-9999-4999-8999-999999999999';
const replacementOwner = '44444444-4444-4444-8444-444444444444';
const modules = {'project-a': 'import', 'project-b': 'client', 'project-c': 'search'};

// Deterministic controller integration only: reference patches are not model
// deliveries, and the injected Desktop read/context evidence is not host acceptance.
test('A/B/C Git fixtures compose real acceptance, local revision, safe owner transfer and bounded dispatch', async t => {
  const setup = prepareProjects(), previousActor = process.env.CODEX_THREAD_ID;
  const previousFixtureRoot = process.env.WORKBENCH_FIXTURE_ROOT;
  delete process.env.WORKBENCH_FIXTURE_ROOT;
  t.after(() => {
    if (previousActor === undefined) delete process.env.CODEX_THREAD_ID;
    else process.env.CODEX_THREAD_ID = previousActor;
    if (previousFixtureRoot === undefined) delete process.env.WORKBENCH_FIXTURE_ROOT;
    else process.env.WORKBENCH_FIXTURE_ROOT = previousFixtureRoot;
    fs.rmSync(setup.root, {recursive: true, force: true});
  });
  assert.equal(setup.hostAcceptance, 'incomplete');
  const configs = {}, bindings = {}, plans = {}, configBytes = {};
  const lock = readJson(path.join(fixtures, 'acceptance-lock.json'));
  const assertFrozenAcceptance = () => {
    for (const [relative, hash] of Object.entries(lock.files)) {
      assert.equal(digest(fs.readFileSync(path.join(setup.root, relative))), hash, relative);
    }
  };
  assertFrozenAcceptance();
  for (const [index, {projectId}] of setup.projects.entries()) {
    const digit = String(index + 1), projectRoot = path.join(setup.root, projectId);
    const config = {
      projectId, projectRoot, workRoot: projectRoot,
      controlRoot: path.join(projectRoot, '.runtime', 'control'),
      vaultRoot: path.join(projectRoot, '.runtime', 'knowledge'),
      pmThreadId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`,
      workerThreads: {}, model: 'gpt-6-astra', thinking: 'ultra', maxWorkers: 3, captureEnabled: false,
    };
    bindings[projectId] = path.join(config.controlRoot, 'project.json');
    writeJson(bindings[projectId], config);
    configBytes[projectId] = fs.readFileSync(bindings[projectId]);
    configs[projectId] = configFrom(bindings[projectId]);
    plans[projectId] = {
      schemaVersion: 1, projectId, planId: 'business', revision: 1,
      objective: `Repair the frozen ${projectId} business contract`,
      constraints: ['Preserve this project identity and the frozen acceptance files'],
      phases: [{id: 'implement', dependsOn: [], maxNativeWorkers: 0}],
      tasks: [{id: 'implement', revision: 1, phaseId: 'implement', dependsOn: [], executor: 'direct',
        files: ['src/config.mjs', `src/${modules[projectId]}.mjs`], contextRefs: [], acceptanceRefs: ['business-v1']}],
    };
    process.env.CODEX_THREAD_ID = config.pmThreadId;
    publishPlan(configs[projectId], plans[projectId], {expectedRevision: 0, reason: 'Freeze deterministic business fixture scope'});
  }
  let registry = {
    controlRoot: path.join(setup.root, 'portfolio'), coordinatorThreadId: coordinator, bindings,
    manifest: {schemaVersion: 1, portfolioId: 'three-project-runtime-fixture', revision: 1, coordinatorEpoch: 1,
      budget: {maxActiveWorkers: 2, maxAttemptsPerTask: 2},
      projects: setup.projects.map(({projectId}, index) => ({projectId, planId: 'business', acceptedPlanRevision: 1, priority: 3 - index})),
      dependencies: []},
  };
  const owner = id => { process.env.CODEX_THREAD_ID = configs[id].pmThreadId; return configs[id]; };
  const resources = () => {
    process.env.CODEX_THREAD_ID = coordinator;
    const result = portfolioStatus(registry).resources;
    assert.ok(result.heldWorkers >= 0 && result.heldWorkers <= result.maxActiveWorkers);
    return result;
  };
  const reserve = (id, runId) => {
    owner(id);
    const result = reserveWorkers(registry, {projectId: id, runId, expectedEpoch: registry.manifest.coordinatorEpoch});
    resources();
    return result;
  };
  const revise = (edit, reason) => {
    const next = structuredClone(registry); next.manifest.revision++;
    edit(next); process.env.CODEX_THREAD_ID = coordinator;
    registry = revisePortfolio(registry, next, {expectedRevision: registry.manifest.revision,
      expectedEpoch: registry.manifest.coordinatorEpoch, reason}).registry;
    resources();
  };
  const prepare = (id, revision = 1) => preparePhase(owner(id), {
    expectedRevision: revision, phaseId: 'implement', groupId: `implementation-v${revision}`, taskIds: ['implement'],
    decision: {topology: 'serial', carrier: 'direct', context: 'continue', reason: 'One deterministic reference patch'},
    checks: [{id: `business-v${revision}`, command: process.execPath,
      args: ['--test', '--test-reporter=tap', `acceptance/v${revision}.test.mjs`]}],
  });
  const packetFile = (cfg, runId) => path.join(cfg.controlRoot, 'runs', runId, 'packets', 'implement.json');
  const complete = async (id, runId, revision = 1, options = {}) => {
    const cfg = owner(id), packet = (await advancePlan(cfg, runId, options)).packets[0];
    assert.equal(packet.projectId, id);
    assert.equal(packet.workRoot, cfg.workRoot);
    assert.deepEqual(packet.files, ['config', modules[id]].map(name => path.join(cfg.workRoot, 'src', `${name}.mjs`)));
    fs.copyFileSync(path.join(fixtures, 'reference', `${id.at(-1)}-v${revision}.mjs`), packet.files[1]);
    const result = await finish(cfg, runId, packet.taskId, {
      expectedAttemptId: packet.attemptId,
      summary: 'Deterministic fixture reference patch applied; this is not model delivery or host acceptance',
    });
    assert.equal(result.status, 'COMPLETE');
    const current = status(cfg, runId);
    assert.equal(current.acceptance.verified, true);
    assert.equal(current.acceptance.passed, true);
    const accepted = readJson(current.acceptance.path), check = accepted.checks[0];
    assert.equal(accepted.evidenceLevel, 'local-command');
    assert.equal(accepted.humanVerified, false);
    assert.equal(check.exitCode, 0);
    assert.deepEqual(check.args, ['--test', '--test-reporter=tap', `acceptance/v${revision}.test.mjs`]);
    assert.match(check.stdout, new RegExp(`# pass ${id === 'project-b' ? 5 : 4}\\b`));
    assert.match(check.stdout, /# fail 0\b/);
    assert.equal(readJson(packet.receiptPath).attemptId, packet.attemptId);
    assertFrozenAcceptance(); resources();
    return packet;
  };
  process.env.CODEX_THREAD_ID = coordinator; registerPortfolio(registry);
  const a1 = prepare('project-a'), b = prepare('project-b'), c = prepare('project-c');
  assert.equal(reserve('project-a', a1.runId).status, 'RESERVED');
  assert.equal(reserve('project-b', b.runId).status, 'RESERVED');
  assert.equal(resources().heldWorkers, 2);
  assert.equal(reserve('project-c', c.runId).status, 'WAITING');
  const a1Packet = await complete('project-a', a1.runId);
  const a1Receipt = fs.readFileSync(a1Packet.receiptPath);
  const a1PacketBytes = fs.readFileSync(packetFile(configs['project-a'], a1.runId));
  assert.equal(resources().heldWorkers, 1);

  // A's requirement change replaces only A's task definition and acceptance.
  const unchanged = ['project-b', 'project-c'].map(id => ({id, plan: activePlan(configs[id]),
    snapshotBytes: fs.readFileSync(activePlan(configs[id]).snapshot),
    source: fs.readFileSync(path.join(configs[id].workRoot, 'src', `${modules[id]}.mjs`)),
    packet: fs.readFileSync(packetFile(configs[id], id === 'project-b' ? b.runId : c.runId))}));
  process.env.CODEX_THREAD_ID = coordinator;
  for (const {id} of unchanged) observeProject(registry, id);
  const nextA = structuredClone(plans['project-a']);
  nextA.revision = 2; nextA.tasks[0].revision = 2;
  nextA.tasks[0].acceptanceRefs = ['business-v2'];
  nextA.tasks[0].constraints = ['Require explicit tenant context and isolate existing ticket ids by tenant'];
  publishPlan(owner('project-a'), nextA, {expectedRevision: 1, reason: 'Add the frozen A v2 tenant requirement'});
  for (const before of unchanged) {
    assert.equal(activePlan(configs[before.id]).planHash, before.plan.planHash);
    assert.deepEqual(before.snapshotBytes, fs.readFileSync(activePlan(configs[before.id]).snapshot));
    assert.deepEqual(fs.readFileSync(path.join(configs[before.id].workRoot, 'src', `${modules[before.id]}.mjs`)), before.source);
    assert.deepEqual(fs.readFileSync(packetFile(configs[before.id], before.id === 'project-b' ? b.runId : c.runId)), before.packet);
    process.env.CODEX_THREAD_ID = coordinator;
    assert.equal(observeProject(registry, before.id).changed, false);
  }
  owner('project-a'); pausePortfolio(registry, {projectId: 'project-a', paused: true, expectedEpoch: 1});
  revise(next => {
    next.manifest.projects[0].acceptedPlanRevision = 2;
    next.manifest.projects[2].priority = 10;
    next.manifest.budget.maxActiveWorkers = 1;
  }, 'Observe only A v2, prioritize waiting C and reduce active capacity');
  const a2 = prepare('project-a', 2);
  assert.notEqual(a2.runId, a1.runId);
  assert.throws(() => reserve('project-a', a2.runId), {code: 'PROJECT_PAUSED'});
  assert.equal(status(configs['project-a'], a2.runId).tasks[0].status, 'PENDING');

  // B stops before assignment. No in-flight host interruption is claimed.
  const oldB = owner('project-b'), oldBPacket = getPacket(oldB, b.runId, 'implement');
  const oldBPacketBytes = fs.readFileSync(packetFile(oldB, b.runId));
  assert.equal(pause(oldB, b.runId).status, 'PAUSED');
  const baseline = setup.projects.find(project => project.projectId === 'project-b').baseCommit;
  const handoff = createHandoff(oldB, {id: 'b-safe-owner-transfer', runId: b.runId,
    expectedPlanRevision: 1, expectedHead: baseline,
    budget: {maxActiveWorkers: 1, maxAttemptsPerTask: 2},
    nextStep: 'Resume the original frozen B attempt after portfolio owner binding is updated',
    allowedActions: ['READ_STATE', 'RESUME', 'CONTINUE_PLAN']});
  const nextConfigFile = path.join(oldB.controlRoot, 'replacement-project.json');
  writeJson(nextConfigFile, {...oldB, pmThreadId: replacementOwner});
  const nextB = configFrom(nextConfigFile);
  const receiptPath = path.join(oldB.controlRoot, 'host-evidence', 'fixture-context.json');
  // Synthetic registration fixture, consumed by the real handoff protocol.
  // It is never saved in the public real-host evidence manifest.
  writeJson(receiptPath, {schemaVersion: 1, kind: 'registered', threadId: replacementOwner,
    sourceThreadId: oldB.pmThreadId, context: 'fresh', forkedFrom: null, cwd: oldB.projectRoot,
    createdAt: Date.now(), receiptId: 'synthetic-runtime-fixture-registration', registeredBy: 'user',
    registrationReason: 'Synthetic controller fixture only; no actual Desktop task was created'});
  const hostReads = [];
  process.env.CODEX_THREAD_ID = replacementOwner;
  await acceptHandoff(nextB, {handoffId: handoff.handoffId, expectedHash: handoff.packetHash, expectedHead: baseline,
    sessionEvidence: {kind: 'registered', threadId: replacementOwner, sourceThreadId: oldB.pmThreadId,
      cwd: oldB.projectRoot, receiptPath, receiptHash: digest(fs.readFileSync(receiptPath))},
    desktop: {read: async id => {
      hostReads.push(id);
      assert.ok([oldB.pmThreadId, replacementOwner].includes(id));
      return {id, cwd: oldB.projectRoot, archived: false, status: id === oldB.pmThreadId ? 'idle' : 'active',
        turnId: `synthetic-${id}`, turnStatus: id === oldB.pmThreadId ? 'completed' : 'inProgress'};
    }}});
  assert.deepEqual(new Set(hostReads), new Set([oldB.pmThreadId, replacementOwner]));
  revise(next => { next.bindings['project-b'] = nextConfigFile; next.manifest.coordinatorEpoch++; },
    'Bind the accepted B owner transfer while preserving its run and reservation');
  configs['project-b'] = nextB;
  const bReservation = resources().reservations.find(item => item.runId === b.runId);
  assert.equal(bReservation.status, 'HELD'); assert.equal(bReservation.epoch, 2);
  process.env.CODEX_THREAD_ID = oldB.pmThreadId;
  await assert.rejects(() => advancePlan(oldB, b.runId, {resume: true}), /This PM identity has already been handed off/);
  const bPacket = await complete('project-b', b.runId, 1, {resume: true});
  assert.equal(bPacket.attemptId, oldBPacket.attemptId);
  assert.deepEqual(fs.readFileSync(packetFile(nextB, b.runId)), oldBPacketBytes);
  assert.deepEqual(fs.readFileSync(bindings['project-b']), configBytes['project-b']);
  assert.equal(resources().projects.find(item => item.projectId === 'project-a').paused, true);

  // C can progress while A is paused, but a global pause prevents assignment.
  assert.equal(reserve('project-c', c.runId).status, 'RESERVED');
  process.env.CODEX_THREAD_ID = coordinator;
  pausePortfolio(registry, {paused: true, expectedEpoch: 2});
  owner('project-c');
  await assert.rejects(() => advancePlan(configs['project-c'], c.runId), {code: 'PORTFOLIO_PAUSED'});
  assert.equal(status(configs['project-c'], c.runId).tasks[0].status, 'PENDING');
  assert.equal(resources().heldWorkers, 1);
  process.env.CODEX_THREAD_ID = coordinator;
  pausePortfolio(registry, {paused: false, expectedEpoch: 2});
  await complete('project-c', c.runId);
  owner('project-a');
  assert.throws(() => reserveWorkers(registry, {projectId: 'project-a', runId: a2.runId, expectedEpoch: 2}), {code: 'PROJECT_PAUSED'});
  pausePortfolio(registry, {projectId: 'project-a', paused: false, expectedEpoch: 2});
  assert.equal(reserve('project-a', a2.runId).status, 'RESERVED');
  const a2Packet = await complete('project-a', a2.runId, 2);
  assert.notEqual(a2Packet.attemptId, a1Packet.attemptId);
  assert.deepEqual(fs.readFileSync(a1Packet.receiptPath), a1Receipt);
  assert.deepEqual(fs.readFileSync(packetFile(configs['project-a'], a1.runId)), a1PacketBytes);
  assert.equal(getPacket(configs['project-a'], a1.runId, 'implement').planBinding.revision, 1);
  assert.equal(resources().heldWorkers, 0);
  for (const {projectId} of setup.projects) {
    const cfg = owner(projectId);
    assert.equal(phaseStatus(cfg).nextAction.type, 'PLAN_COMPLETE');
    assert.equal(digest(fs.readFileSync(path.join(cfg.workRoot, 'src', 'config.mjs'))), lock.baselineFiles[`${projectId}/src/config.mjs`]);
    const store = openStore(cfg);
    try {
      const expectedRuns = projectId === 'project-a' ? 2 : 1;
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, expectedRuns);
      for (const event of ['task_assigned', 'task_result', 'acceptance']) {
        assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM events WHERE kind=?').get(event).n, expectedRuns);
      }
    } finally { store.close(); }
  }
  assertFrozenAcceptance();
});
