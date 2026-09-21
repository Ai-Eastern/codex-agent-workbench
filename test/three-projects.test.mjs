import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareProjects } from '../examples/three-projects/prepare.mjs';
import { sha256, validateManifest, verifyThreeProjects } from '../scripts/verify-three-projects.mjs';

const fixtures = fileURLToPath(new URL('../examples/three-projects/', import.meta.url));
const lock = JSON.parse(fs.readFileSync(path.join(fixtures, 'acceptance-lock.json'), 'utf8'));
const sources = { 'project-a': 'import.mjs', 'project-b': 'client.mjs', 'project-c': 'search.mjs' };
const git = (root, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', '-c', 'commit.gpgsign=false', '-c', 'user.name=Workbench Fixture', '-c', 'user.email=fixture@example.invalid', '-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-three-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function runAcceptance(root, projectId, revision) {
  // Run the independently frozen script, even when the worktree contains copies.
  const env = { ...process.env, WORKBENCH_FIXTURE_ROOT: root };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, ['--test', '--test-reporter=tap', path.join(fixtures, projectId, 'acceptance', `v${revision}.test.mjs`)], {
    cwd: root, encoding: 'utf8', env,
  });
}
function patch(root, projectId, revision) {
  fs.copyFileSync(path.join(fixtures, 'reference', `${projectId.slice(-1)}-v${revision}.mjs`), path.join(root, 'src', sources[projectId]));
}

test('frozen business fixtures expose intended defects; reference patches pass only their acceptance revision', t => {
  const temp = temporary(t);
  for (const [file, hash] of Object.entries({ ...lock.files, ...lock.baselineFiles })) assert.equal(sha256(fs.readFileSync(path.join(fixtures, file))), hash, file);
  const expectedFailures = { 'project-a': ['A-v1-errors', 'A-v1-duplicates'], 'project-b': ['B-v1-legacy', 'B-v1-errors', 'B-v1-invalid'], 'project-c': ['C-v1-ties', 'C-v1-scope'] };
  for (const projectId of Object.keys(sources)) {
    const root = path.join(temp, projectId);
    fs.cpSync(path.join(fixtures, projectId), root, { recursive: true });
    const baseline = runAcceptance(root, projectId, 1);
    assert.equal(baseline.status, 1, baseline.stdout + baseline.stderr);
    for (const name of expectedFailures[projectId]) assert.match(baseline.stdout, new RegExp(`not ok \\d+ - ${name}`));
    assert.match(baseline.stdout, new RegExp(`# fail ${expectedFailures[projectId].length}(?:\\r?\\n|$)`));
    patch(root, projectId, 1);
    const fixed = runAcceptance(root, projectId, 1);
    assert.equal(fixed.status, 0, fixed.stdout + fixed.stderr);
    if (projectId === 'project-a') {
      const stale = runAcceptance(root, projectId, 2);
      assert.equal(stale.status, 1);
      assert.match(stale.stdout, /not ok \d+ - A-v2-context/);
      assert.match(stale.stdout, /not ok \d+ - A-v2-isolation/);
      patch(root, projectId, 2);
      const updated = runAcceptance(root, projectId, 2);
      assert.equal(updated.status, 0, updated.stdout + updated.stderr);
    }
  }
});

test('same-named config routed to the wrong project fails its independent identity acceptance', t => {
  const root = path.join(temporary(t), 'project-c');
  fs.cpSync(path.join(fixtures, 'project-c'), root, { recursive: true });
  patch(root, 'project-c', 1);
  fs.copyFileSync(path.join(fixtures, 'project-b/src/config.mjs'), path.join(root, 'src/config.mjs'));
  const result = runAcceptance(root, 'project-c', 1);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not ok \d+ - C-v1-identity/);
});

test('repository setup creates three isolated baselines and refuses existing destinations', t => {
  const root = path.join(temporary(t), 'run');
  const setup = prepareProjects(root);
  assert.equal(setup.hostAcceptance, 'incomplete');
  for (const p of setup.projects) {
    const repository = path.join(root, p.repository);
    assert.equal(git(repository, 'rev-parse', 'HEAD'), p.baseCommit);
    assert.equal(git(repository, 'status', '--porcelain'), '');
    assert.equal(fs.existsSync(path.join(repository, 'reference')), false);
    assert.equal(fs.existsSync(path.join(repository, '.git')), true);
  }
  assert.throws(() => prepareProjects(root), /EEXIST/);
});

test('missing evidence is explicitly incomplete and CLI never invokes paid work', () => {
  assert.deepEqual(verifyThreeProjects().status, 'incomplete');
  assert.throws(() => validateManifest({ schemaVersion: 1, kind: 'fixture-setup' }), /schemaVersion\/kind/);
  const result = spawnSync(process.execPath, ['scripts/verify-three-projects.mjs'], { cwd: path.resolve(fixtures, '../..'), encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).hostAcceptance, false);
});

// All following receipts and sessions are generated test data, never host evidence.
function syntheticEvidence(t) {
  const root = path.join(temporary(t), 'run');
  const setup = prepareProjects(root);
  fs.mkdirSync(path.join(root, 'evidence'));
  const manifest = {
    schemaVersion: 1, kind: 'fixture', runId: 'synthetic-protocol-test', recordedAt: '2026-01-01T00:00:00Z',
    host: { name: 'synthetic-test', version: 'fixture', toolVersion: 'fixture' }, budget: { maxActiveWorkers: 3 },
    coordinatorRef: 'coordinator', eventsRef: 'events', usageRef: 'usage', timingRef: 'timing', artifacts: {}, projects: [],
  };
  const save = (ref, value) => {
    const bytes = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    const file = `evidence/${ref}.json`;
    fs.writeFileSync(path.join(root, file), bytes);
    manifest.artifacts[ref] = { path: file, sha256: sha256(bytes) };
    return ref;
  };
  const bindings = new Map();
  function binding(ref, projectId) {
    const data = { projectId, actorId: `${ref}-actor`, sessionId: `synthetic-${ref}`, contextMode: 'new', requestedModel: 'fixture-model', requestedReasoning: 'fixture', observedModel: 'fixture-model', observedReasoning: 'fixture', hostSnapshotRef: `${ref}-host` };
    save(data.hostSnapshotRef, { source: 'codex-tool', tool: 'synthetic-snapshot', observedAt: manifest.recordedAt, body: { sessionId: data.sessionId, synthetic: true } });
    save(ref, data); bindings.set(ref, data); return data;
  }
  binding('coordinator', 'portfolio');
  function report(p, revision, commitId, ref) {
    const repository = path.join(root, p.repository);
    const result = runAcceptance(repository, p.projectId, revision);
    const sourceHashes = {};
    for (const file of git(repository, 'ls-tree', '-r', '--name-only', commitId, '--', 'src').split(/\r?\n/)) {
      sourceHashes[file] = sha256(execFileSync('git', ['-C', repository, 'show', `${commitId}:${file}`]));
    }
    save(ref, {
      projectId: p.projectId, revision, commit: commitId,
      command: ['node', '--test', '--test-reporter=tap', `acceptance/v${revision}.test.mjs`],
      acceptanceHash: lock.files[`${p.projectId}/acceptance/v${revision}.test.mjs`],
      exitCode: result.status, passed: Number(result.stdout.match(/# pass (\d+)/)[1]), failed: Number(result.stdout.match(/# fail (\d+)/)[1]),
      outputRef: save(`${ref}-tap`, result.stdout), sourceHashes,
    });
  }
  for (const p of setup.projects) {
    const repository = path.join(root, p.repository);
    const revision = p.projectId === 'project-a' ? 2 : 1;
    p.baselineAcceptanceRef = `${p.projectId}-baseline`; report(p, 1, p.baseCommit, p.baselineAcceptanceRef);
    patch(repository, p.projectId, revision);
    git(repository, 'add', 'src'); git(repository, 'commit', '--quiet', '-m', 'Synthetic reference result, not model delivery');
    p.finalCommit = git(repository, 'rev-parse', 'HEAD');
    p.identityRef = p.projectId; binding(p.projectId, p.projectId);
    p.planRevisions = revision === 2 ? [1, 2] : [1];
    p.acceptanceRef = `${p.projectId}-final`; report(p, revision, p.finalCommit, p.acceptanceRef);
    manifest.projects.push(p);
  }
  binding('b-resumed', 'project-b');
  save('resume-project', { source: 'user', scope: 'project-resume', runId: manifest.runId });
  save('resume-portfolio', { source: 'user', scope: 'portfolio-resume', runId: manifest.runId });
  const unchanged = { 'project-b': { planHash: 'b'.repeat(64), artifactHashes: { config: 'b'.repeat(64) } }, 'project-c': { planHash: 'c'.repeat(64), artifactHashes: { config: 'c'.repeat(64) } } };
  save('before-change', unchanged); save('after-change', unchanged);
  save('handoff', { projectId: 'project-b', planRevision: 1, constraints: ['preserve legacy calls'], failedAttempts: ['recorded interruption'], unfinished: ['sdk-fix'], validDeliveries: ['valid-checkpoint'] });
  const events = [];
  function event(type, projectId, extra = {}) {
    const ref = projectId === 'project-b' && events.some(e => e.type === 'CONTEXT_RESUMED') ? 'b-resumed' : projectId ?? 'coordinator';
    const identity = bindings.get(ref);
    const revision = projectId === 'project-a' && events.some(e => e.type === 'REQUIREMENTS_CHANGED') ? 2 : 1;
    const item = { seq: events.length + 1, type, ...(projectId ? { projectId, planRevision: revision } : {}), actorId: identity.actorId, coordinatorEpoch: ref === 'b-resumed' ? 2 : 1, ...extra };
    item.evidenceRef = save(`event-${item.seq}`, { source: 'controller-export', event: { ...item }, hostSnapshotRef: identity.hostSnapshotRef });
    events.push(item); return item;
  }
  function dispatch(id, task = 'fix') {
    const number = events.length + 1;
    return event('DISPATCH', id, { actionId: `action-${number}`, attemptId: `attempt-${number}`, taskId: task, taskRevision: 1, packetHash: sha256(`packet-${number}`) });
  }
  function result(d, type = 'RESULT') { return event(type, d.projectId, { attemptId: d.attemptId, taskRevision: d.taskRevision, packetHash: d.packetHash, planRevision: d.planRevision, status: 'done', hostCompletionConfirmed: true }); }
  const oldA = dispatch('project-a');
  event('REQUIREMENTS_CHANGED', 'project-a', { nextRevision: 2, beforeRef: 'before-change', afterRef: 'after-change' });
  result(oldA, 'RESULT_SUPERSEDED');
  result(dispatch('project-b', 'valid-checkpoint'));
  event('INTERRUPTED', 'project-b', { handoffRef: 'handoff' });
  event('CONTEXT_RESUMED', 'project-b', { identityRef: 'b-resumed', handoffRef: 'handoff', nextEpoch: 2, preservedDeliveries: ['valid-checkpoint'] });
  event('PROJECT_PAUSED', 'project-a');
  event('PRIORITY_CHANGED', 'project-c', { priority: 3 });
  result(dispatch('project-b', 'sdk-fix'));
  result(dispatch('project-c'));
  event('PROJECT_RESUMED', 'project-a', { authorizationRef: 'resume-project' });
  event('RESOURCE_CHANGED', undefined, { maxActiveWorkers: 1 });
  event('PORTFOLIO_PAUSED');
  event('PORTFOLIO_RESUMED', undefined, { authorizationRef: 'resume-portfolio' });
  result(dispatch('project-a'));
  for (const p of manifest.projects) event('ACCEPT', p.projectId, { acceptanceRef: p.acceptanceRef });
  save('events', events);
  save('usage', { roles: [...bindings.values()].map(b => ({ sessionId: b.sessionId, inputTokens: 0, outputTokens: 0 })) });
  save('timing', { coordinationMs: 0, executionMs: 0 });
  const filename = path.join(root, 'manifest.json');
  const write = () => fs.writeFileSync(filename, JSON.stringify(manifest));
  const rewriteEvents = updated => {
    for (const [index, item] of updated.entries()) {
      item.seq = index + 1;
      const ref = item.evidenceRef;
      const existing = JSON.parse(fs.readFileSync(path.join(root, manifest.artifacts[ref].path), 'utf8'));
      const { evidenceRef, ...body } = item;
      save(ref, { ...existing, event: body });
    }
    save('events', updated); write();
  };
  write(); return { root, manifest, filename, save, write, events, rewriteEvents };
}

test('saved evidence verifier rejects missing, stale, cross-project, pause and recovery evidence', async t => {
  const fixture = syntheticEvidence(t);
  const original = structuredClone(fixture.manifest);
  const originalEvents = structuredClone(fixture.events);
  const result = verifyThreeProjects(fixture.filename);
  assert.equal(result.consistencyVerified, true, JSON.stringify(result));
  assert.equal(result.status, 'incomplete');
  assert.equal(result.hostAcceptance, false);
  assert.match(result.missing.join(' '), /Fixture\/synthetic/);
  const reset = () => {
    Object.assign(fixture.manifest, structuredClone(original));
    fixture.rewriteEvents(structuredClone(originalEvents));
  };
  const reject = pattern => {
    const result = verifyThreeProjects(fixture.filename);
    assert.equal(result.consistencyVerified, false, JSON.stringify(result));
    assert.match(result.missing.join(' '), pattern);
  };
  await t.test('artifact hash tampering', () => {
    fs.appendFileSync(path.join(fixture.root, fixture.manifest.artifacts.timing.path), ' ');
    reject(/hash mismatch/);
    fixture.save('timing', { coordinationMs: 0, executionMs: 0 }); reset();
  });
  await t.test('cross-project acceptance and old A acceptance cannot pass final v2', () => {
    fixture.manifest.projects[0].acceptanceRef = fixture.manifest.projects[1].acceptanceRef;
    fixture.write(); reject(/acceptance identity\/version\/commit mismatch/); reset();
    fixture.manifest.projects[0].acceptanceRef = fixture.manifest.projects[0].baselineAcceptanceRef;
    fixture.write(); reject(/acceptance identity\/version\/commit mismatch/); reset();
  });
  await t.test('missing lifecycle event', () => {
    fixture.rewriteEvents(structuredClone(originalEvents).filter(e => e.type !== 'RESOURCE_CHANGED'));
    reject(/missing lifecycle events.*RESOURCE_CHANGED/); reset();
  });
  await t.test('dispatch during global pause', () => {
    const events = structuredClone(originalEvents);
    const dispatch = events.findLast(e => e.type === 'DISPATCH');
    events.splice(events.indexOf(dispatch), 1);
    events.splice(events.findIndex(e => e.type === 'PORTFOLIO_RESUMED'), 0, dispatch);
    fixture.rewriteEvents(events); reject(/dispatch during pause/); reset();
  });
  await t.test('dispatch during project pause and silent repetition of a preserved B delivery', () => {
    const events = structuredClone(originalEvents);
    const dispatch = events.findLast(e => e.type === 'DISPATCH');
    events.splice(events.indexOf(dispatch), 1);
    events.splice(events.findIndex(e => e.type === 'PROJECT_RESUMED'), 0, dispatch);
    fixture.rewriteEvents(events); reject(/dispatch during pause/); reset();
    const repeated = structuredClone(originalEvents);
    repeated.find(e => e.type === 'DISPATCH' && e.taskId === 'sdk-fix').taskId = 'valid-checkpoint';
    fixture.rewriteEvents(repeated); reject(/recovery repeated a valid delivery/); reset();
  });
  await t.test('duplicate dispatch and stale coordinator', () => {
    const events = structuredClone(originalEvents);
    events.findLast(e => e.type === 'DISPATCH').actionId = events[0].actionId;
    fixture.rewriteEvents(events); reject(/duplicate dispatch/); reset();
    const stale = structuredClone(originalEvents);
    stale.find(e => e.type === 'DISPATCH' && e.taskId === 'sdk-fix').coordinatorEpoch = 1;
    fixture.rewriteEvents(stale); reject(/actor\/owner epoch mismatch/); reset();
  });
  await t.test('recovery must use a new session and preserve constraints', () => {
    const events = structuredClone(originalEvents);
    events.find(e => e.type === 'CONTEXT_RESUMED').identityRef = 'project-b';
    fixture.rewriteEvents(events); reject(/genuinely new session/); reset();
    fixture.save('handoff', { projectId: 'project-b', planRevision: 1, constraints: [], failedAttempts: ['interruption'], unfinished: ['sdk-fix'], validDeliveries: ['valid-checkpoint'] });
    fixture.write(); reject(/handoff constraints missing/);
  });
});
