import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.WORKBENCH_FIXTURE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { rankResults } = await import(pathToFileURL(resolve(root, 'src/search.mjs')));
const config = await import(pathToFileURL(resolve(root, 'src/config.mjs')));
const item = (id, score, projectId = 'project-c') => ({ id, score, projectId, title: 'src/config.mjs' });

test('C-v1-identity: search project retains its own same-named config', () => {
  assert.equal(config.projectId, 'project-c');
  assert.equal(config.moduleKind, 'scoped-search');
});
test('C-v1-score: preserves descending score without mutating input', () => {
  const input = [item('low', 1), item('high', 8)];
  const before = structuredClone(input);
  assert.deepEqual(rankResults(input, { projectId: 'project-c' }), [input[1], input[0]]);
  assert.deepEqual(input, before);
});
test('C-v1-ties: all input permutations produce codepoint id order at equal scores', () => {
  const rows = [item('b', 2), item('a', 2), item('A', 2)];
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    assert.deepEqual(rankResults(order.map(i => rows[i]), { projectId: 'project-c' }).map(r => r.id), ['A', 'a', 'b']);
  }
});
test('C-v1-scope: same-named knowledge from A and B never enters C results', () => {
  const own = item('own', 1);
  assert.deepEqual(rankResults([item('a-secret', 100, 'project-a'), own, item('b-secret', 99, 'project-b')], { projectId: 'project-c' }), [own]);
  assert.deepEqual(rankResults([own], { projectId: 'project-a' }), []);
  assert.throws(() => rankResults([own]), /projectId is required/);
});
