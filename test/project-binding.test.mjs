import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepare } from '../src/workflow.mjs';
import { digest, validateRequest } from '../src/contracts.mjs';

function cfg(root, projectId = 'fixture') {
  return {
    projectId,
    projectRoot: root,
    controlRoot: path.join(root, 'control'),
    workRoot: path.join(root, 'work'),
    vaultRoot: path.join(root, 'knowledge'),
    maxWorkers: 1,
    model: 'gpt-5.5',
    thinking: 'low',
    captureEnabled: true,
    pmThreadId: '11111111-1111-4111-8111-111111111111',
    workerThreads: {},
  };
}

function request(projectId) {
  const req = {
    id: 'project-bound',
    objective: 'bind request to project',
    mode: 'direct',
    reason: 'prevent wrong config use',
    tasks: [{ id: 'A', objective: 'write one file', files: ['result.txt'] }],
    checks: [{ id: 'result', command: 'node', args: ['-e', 'process.exit(0)'] }],
  };
  if (projectId !== undefined) req.projectId = projectId;
  return req;
}

test('request projectId mismatch is rejected before state or knowledge roots are created', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-project-bind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const wrong = cfg(root, 'wrong-project');

  assert.throws(() => prepare(wrong, request('intended-project')), /projectId/i);
  assert.equal(fs.existsSync(wrong.controlRoot), false);
  assert.equal(fs.existsSync(wrong.vaultRoot), false);
});

test('matching request projectId is accepted', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-project-bind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = cfg(root, 'intended-project');

  assert.equal(prepare(current, request('intended-project')).status, 'PREPARED');
});

test('legacy requests without projectId keep their original contract and remain reusable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-project-bind-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const current = cfg(root);
  const legacy = request();
  const before = structuredClone(legacy);
  const legacyDigest = digest(validateRequest(legacy, current));

  assert.equal(prepare(current, legacy).status, 'PREPARED');
  assert.deepEqual(legacy, before);
  assert.equal(prepare(current, legacy).reused, true);

  const db = new DatabaseSync(path.join(current.controlRoot, 'state.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT digest, request FROM runs WHERE id=?').get(legacy.id);
    assert.equal(row.digest, legacyDigest);
    assert.equal(Object.hasOwn(JSON.parse(row.request), 'projectId'), false);
  } finally {
    db.close();
  }
});
