import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.WORKBENCH_FIXTURE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { importTickets } = await import(pathToFileURL(resolve(root, 'src/import.mjs')));
const config = await import(pathToFileURL(resolve(root, 'src/config.mjs')));

test('A-v1-identity: import project retains its own same-named config', () => {
  assert.equal(config.projectId, 'project-a');
  assert.equal(config.moduleKind, 'ticket-import');
});
test('A-v1-valid: preserves valid rows without mutating input', () => {
  const rows = [{ id: 'T1', title: 'First ticket' }];
  const before = structuredClone(rows);
  assert.deepEqual(importTickets(rows), { imported: before, errors: [] });
  assert.deepEqual(rows, before);
  assert.deepEqual(importTickets([]), { imported: [], errors: [] });
});
test('A-v1-errors: reports stable one-based row errors and retains valid rows', () => {
  assert.deepEqual(importTickets([null, { id: ' ', title: 'Missing id' }, { id: 'T2', title: '' }, { id: 'T3', title: 'Keep' }]), {
    imported: [{ id: 'T3', title: 'Keep' }],
    errors: [{ row: 1, code: 'INVALID_ROW' }, { row: 2, code: 'ID_REQUIRED' }, { row: 3, code: 'TITLE_REQUIRED' }],
  });
});
test('A-v1-duplicates: first valid occurrence wins and invalid rows reserve no id', () => {
  assert.deepEqual(importTickets([{ id: 'T1', title: '' }, { id: 'T1', title: 'Keep' }, { id: 'T1', title: 'Duplicate' }]), {
    imported: [{ id: 'T1', title: 'Keep' }],
    errors: [{ row: 1, code: 'TITLE_REQUIRED' }, { row: 3, code: 'DUPLICATE_ID' }],
  });
});
