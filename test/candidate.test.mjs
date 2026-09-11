import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createKnowledge, validateKnowledgeCandidate } from '../src/knowledge.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'workbench-candidate-'));
  const sourceRoot = path.join(root, 'project');
  const vaultRoot = path.join(sourceRoot, 'notes');
  const evidence = path.join(sourceRoot, 'receipt.json');
  const instances = [];
  mkdirSync(vaultRoot, { recursive: true });
  writeFileSync(evidence, '{"accepted":true}');
  t.after(() => {
    for (const instance of instances) instance.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    evidence,
    open: () => {
      const instance = createKnowledge({ projectId: 'project-a', vaultRoot, sourceRoot, indexPath: path.join(root, 'index.sqlite') });
      instances.push(instance);
      return instance;
    },
    source: () => ({ runId: 'run-fixture-1', taskId: 'task-fixture-1', evidence: [{ path: 'receipt.json', sha256: sha256(readFileSync(evidence)) }] }),
  };
}

test('knowledge candidates reject non-object shapes and empty required fields', () => {
  for (const value of [null, [], 'candidate']) {
    assert.throws(() => validateKnowledgeCandidate(value), { code: 'KNOWLEDGE_INPUT' });
  }
  for (const field of ['id', 'title', 'kind']) {
    assert.throws(() => validateKnowledgeCandidate({ id: 'lesson-1', title: 'Lesson', body: 'Body', kind: 'solution', [field]: '' }), { code: 'KNOWLEDGE_INPUT' });
  }
  assert.throws(() => validateKnowledgeCandidate({ id: 'lesson-1', title: 'Lesson', kind: 'solution' }), { code: 'KNOWLEDGE_LIMIT' });
});

test('knowledge candidates reject source injection and unknown fields', () => {
  assert.throws(() => validateKnowledgeCandidate({
    id: 'lesson-1', title: 'Lesson', body: 'Body', kind: 'solution', source: { runId: 'fake', taskId: 'fake', evidence: [] },
  }), { code: 'KNOWLEDGE_INPUT' });
  assert.throws(() => validateKnowledgeCandidate({
    id: 'lesson-1', title: 'Lesson', body: 'Body', kind: 'solution', extra: true,
  }), { code: 'KNOWLEDGE_INPUT' });
});

test('valid knowledge candidates return a clean copy without mutating input', () => {
  const input = {
    id: 'lesson-1',
    title: 'Lesson',
    body: 'Body',
    kind: 'solution',
    expectedHash: 'a'.repeat(64),
  };
  const result = validateKnowledgeCandidate(input);
  assert.deepEqual(result, input);
  assert.notEqual(result, input);
  assert.deepEqual(input, {
    id: 'lesson-1',
    title: 'Lesson',
    body: 'Body',
    kind: 'solution',
    expectedHash: 'a'.repeat(64),
  });
});

test('capture still accepts controller-bound source evidence', t => {
  const f = fixture(t);
  const k = f.open();
  const saved = k.capture({
    ...validateKnowledgeCandidate({ id: 'lesson-1', title: 'Lesson', body: 'Body', kind: 'solution' }),
    source: f.source(),
  });
  assert.equal(saved.reused, false);
  assert.equal(k.capture({
    ...validateKnowledgeCandidate({ id: 'lesson-1', title: 'Lesson', body: 'Body', kind: 'solution' }),
    source: f.source(),
  }).reused, true);
});
