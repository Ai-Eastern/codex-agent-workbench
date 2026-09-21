import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configFrom, digest, projectIdentity, validateRequest, writeJson, readJson} from '../src/contracts.mjs';
import {begin, advance, submitResult, getPacket, delivery, status, prepare, repairTask} from '../src/workflow.mjs';

function fixture(t) {
  const temporaryRoot = fs.realpathSync.native(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryRoot, 'workbench-local-controller-'));
  t.after(() => {
    assert.equal(path.dirname(root), temporaryRoot);
    assert.equal(fs.lstatSync(root).isSymbolicLink(), false);
    fs.rmSync(root, {recursive: true, force: true});
  });
  const base = {projectId: 'local-test', projectRoot: root, controlRoot: path.join(root, 'control'), workRoot: path.join(root, 'work'), vaultRoot: path.join(root, 'knowledge'), executionHost: 'local', maxWorkers: 1, workerThreads: {}, captureEnabled: false};
  const configFile = path.join(root, 'project.json');
  const configure = overrides => {writeJson(configFile, {...base, ...overrides}); return configFrom(configFile);};
  const req = {id: 'local-run', objective: 'deliver a local code change', mode: 'direct', reason: 'one local executor', tasks: [{id: 'A', objective: 'write the result', files: ['result.txt']}], checks: [{id: 'result', command: 'node', args: ['-e', "const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!=='done')process.exit(1)"]}]};
  return {root, base, configure, req};
}

function desktopIdentity(t, value) {
  const previous = process.env.CODEX_THREAD_ID;
  if(value === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = value;
  t.after(() => {if(previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous;});
}

test('local controller runs without a Desktop identity and leaves an existing identity untouched', async t => {
  const f = fixture(t), cfg = f.configure({});
  assert.equal(cfg.pmThreadId, 'local:local-test');
  assert.equal(cfg.model, null); assert.equal(cfg.thinking, null);
  desktopIdentity(t, undefined);
  const started = await begin(cfg, f.req), packet = getPacket(cfg, f.req.id, 'A');
  assert.equal(started.nextAction.actorThreadId, cfg.pmThreadId);
  assert.equal(process.env.CODEX_THREAD_ID, undefined);
  assert.equal(packet.executionHost, 'local'); assert.equal(packet.executorManaged, true);
  assert.equal(packet.resultTool, undefined); assert.equal(packet.model, null); assert.equal(packet.thinking, null);
  assert(!packet.prompt.includes(packet.receiptPath)); assert(!packet.prompt.includes('CODEX_THREAD_ID'));
  assert.match(packet.prompt, /父控制器/); assert(!packet.prompt.includes('的 PM'));
  const unrelatedDesktop = '33333333-3333-4333-8333-333333333333';
  process.env.CODEX_THREAD_ID = unrelatedDesktop;
  fs.writeFileSync(packet.files[0], 'done');
  assert.equal(submitResult(cfg, f.req.id, 'A', {expectedAttemptId: packet.attemptId, summary: 'done'}).status, 'SUBMITTED');
  assert.equal((await advance(cfg, f.req.id)).status, 'COMPLETE');
  const delivered = delivery(cfg, f.req.id);
  assert.equal(delivered.acceptance.passed, true); assert.equal(delivered.knowledge.status, 'CAPTURE_DISABLED');
  assert.equal((await advance(cfg, f.req.id)).reused, true);
  assert.throws(() => status({...cfg, executionHost: undefined}, f.req.id), /configuration changed/);
  assert.equal(process.env.CODEX_THREAD_ID, unrelatedDesktop);
});

test('local configuration keeps paths, direct-only execution and identity namespaces constrained', t => {
  const f = fixture(t), cfg = f.configure({model: 'provider/custom-model:v1', thinking: 'custom-effort'});
  assert.equal(cfg.model, 'provider/custom-model:v1'); assert.equal(cfg.thinking, 'custom-effort');
  for(const override of [{maxWorkers: 2}, {workerThreads: {A: '22222222-2222-4222-8222-222222222222'}}, {workerThreads: []}, {pmThreadId: '11111111-1111-4111-8111-111111111111'}, {pmThreadId: 'local:other'}, {executionHost: 'unknown'}, {model: ''}, {thinking: 'bad\nvalue'}]) assert.throws(() => f.configure(override));
  assert.throws(() => f.configure({workRoot: path.dirname(f.root)}), /escapes/);
  for(const mode of ['native', 'langgraph']) assert.throws(() => validateRequest({...f.req, mode}, cfg), /local.*direct/i);
  const desktop = f.configure({executionHost: undefined, pmThreadId: '11111111-1111-4111-8111-111111111111'});
  assert.equal(desktop.model, 'gpt-5.5'); assert.equal(desktop.thinking, 'low');
  assert.throws(() => f.configure({executionHost: undefined, pmThreadId: 'local:local-test'}), /task IDs/);
  assert.throws(() => f.configure({executionHost: undefined, pmThreadId: desktop.pmThreadId, model: 'provider/custom-model:v1'}), /Supported live profiles/);
});

test('local host identities cannot reopen Desktop runs and legacy project hashes stay unchanged', async t => {
  const f = fixture(t), desktop = f.configure({executionHost: undefined, pmThreadId: '11111111-1111-4111-8111-111111111111'});
  const legacyHash = digest({projectId:desktop.projectId,projectRoot:desktop.projectRoot,controlRoot:desktop.controlRoot,workRoot:desktop.workRoot,vaultRoot:desktop.vaultRoot,pmThreadId:desktop.pmThreadId,workerThreads:desktop.workerThreads,model:desktop.model,thinking:desktop.thinking,maxWorkers:desktop.maxWorkers,captureEnabled:desktop.captureEnabled===true});
  assert.equal(projectIdentity(desktop), legacyHash);
  prepare(desktop, f.req);
  const local = f.configure({model: desktop.model, thinking: desktop.thinking});
  assert.notEqual(projectIdentity(local), projectIdentity({...local, executionHost: undefined}));
  assert.throws(() => status(local, f.req.id), /configuration changed/);
  await assert.rejects(begin({...local, pmThreadId: desktop.pmThreadId}, f.req), /PM/);
  desktopIdentity(t, 'local:local-test');
  await assert.rejects(begin(desktop, f.req), /PM/);
});

test('declared local deletion is required at submit, acceptance and delivery', async t => {
  const f = fixture(t), cfg = f.configure({});
  f.req.tasks[0].files.push('obsolete.txt'); f.req.tasks[0].deletedFiles = ['obsolete.txt'];
  f.req.checks[0].args[1] += ";if(fs.existsSync('obsolete.txt'))process.exit(1)";
  const started = await begin(cfg, f.req), packet = getPacket(cfg, f.req.id, 'A');
  assert.equal(started.status, 'RUNNING'); assert.deepEqual(packet.deletedFiles, ['obsolete.txt']);
  fs.writeFileSync(packet.files[0], 'done'); fs.writeFileSync(packet.files[1], 'remove me');
  const submit = () => submitResult(cfg, f.req.id, 'A', {expectedAttemptId: packet.attemptId, summary: 'result updated and obsolete file removed'});
  assert.throws(submit, /artifact/i); assert.equal(fs.existsSync(packet.receiptPath), false);
  fs.unlinkSync(packet.files[1]); submit();
  assert.deepEqual(readJson(packet.receiptPath).artifactHashes, {'result.txt': digest('done'), 'obsolete.txt': null});
  fs.writeFileSync(packet.files[1], 'unexpected restoration');
  await assert.rejects(advance(cfg, f.req.id), /artifact/i);
  fs.unlinkSync(packet.files[1]);
  assert.equal((await advance(cfg, f.req.id)).status, 'COMPLETE');
  assert.equal(delivery(cfg, f.req.id).artifacts['obsolete.txt'], null);
  fs.writeFileSync(packet.files[1], 'unexpected restoration'); assert.throws(() => delivery(cfg, f.req.id), /stale|artifact/i);
  fs.unlinkSync(packet.files[1]); assert.equal((await advance(cfg, f.req.id)).reused, true);
});

test('deletion declarations must be unique exact owned paths and remain unavailable to Desktop', t => {
  const f = fixture(t), cfg = f.configure({});
  for(const deletedFiles of [['missing.txt'], ['result.txt', 'result.txt'], 'result.txt', ['../result.txt']]) {
    const req = structuredClone(f.req); req.tasks[0].deletedFiles = deletedFiles;
    assert.throws(() => validateRequest(req, cfg), /deletedFiles/);
  }
  const req = structuredClone(f.req); req.tasks[0].deletedFiles = ['result.txt'];
  assert.throws(() => validateRequest(req, {...cfg, executionHost: undefined}), /deletedFiles.*local/i);
});

test('local deletion survives an explicit repair while keeping failed evidence', async t => {
  const f = fixture(t), cfg = f.configure({});
  f.req.tasks[0].files.push('obsolete.txt'); f.req.tasks[0].deletedFiles = ['obsolete.txt'];
  await begin(cfg, f.req); const first = getPacket(cfg, f.req.id, 'A');
  fs.writeFileSync(first.files[0], 'wrong');
  submitResult(cfg, f.req.id, 'A', {expectedAttemptId: first.attemptId, summary: 'first attempt'});
  const failed = await advance(cfg, f.req.id); assert.equal(failed.status, 'FAILED');
  repairTask(cfg, f.req.id, 'A', {expectedAcceptanceHash: failed.acceptance.hash, reason: 'repair the incorrect retained file'});
  await advance(cfg, f.req.id); const repaired = getPacket(cfg, f.req.id, 'A');
  fs.writeFileSync(repaired.files[0], 'done');
  submitResult(cfg, f.req.id, 'A', {expectedAttemptId: repaired.attemptId, summary: 'corrected'});
  assert.equal((await advance(cfg, f.req.id)).status, 'COMPLETE');
  assert.equal(readJson(repaired.repair.acceptancePath).passed, false); assert.equal(fs.existsSync(first.receiptPath), true);
});
