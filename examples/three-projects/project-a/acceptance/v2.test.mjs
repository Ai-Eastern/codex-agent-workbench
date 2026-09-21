import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.WORKBENCH_FIXTURE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { importTickets } = await import(pathToFileURL(resolve(root, 'src/import.mjs')));
const config = await import(pathToFileURL(resolve(root, 'src/config.mjs')));

test('A-v2-identity: new requirements retain project identity', () => {
  assert.equal(config.projectId, 'project-a');
  assert.equal(config.moduleKind, 'ticket-import');
});
test('A-v2-context: requires an explicit nonempty tenant context', () => {
  assert.throws(() => importTickets([]), /tenantId is required/);
  assert.throws(() => importTickets([], { tenantId: ' ' }), /tenantId is required/);
});
test('A-v2-isolation: rejects missing and foreign tenants with row errors', () => {
  const rows = [null, { id: 'T1', title: 'Missing tenant' }, { id: 'T2', title: 'Foreign', tenantId: 'blue' }, { id: 'T3', title: 'Own', tenantId: 'red' }];
  const before = structuredClone(rows);
  assert.deepEqual(importTickets(rows, { tenantId: 'red' }), {
    imported: [{ id: 'T3', title: 'Own', tenantId: 'red' }],
    errors: [{ row: 1, code: 'INVALID_ROW' }, { row: 2, code: 'TENANT_REQUIRED' }, { row: 3, code: 'TENANT_MISMATCH' }],
  });
  assert.deepEqual(rows, before);
});
test('A-v2-duplicates: existing ids are scoped to the active tenant', () => {
  const row = (id, title) => ({ id, title, tenantId: 'red' });
  const existing = [{ id: 'T1', tenantId: 'blue' }, { id: 'T2', tenantId: 'red' }];
  const before = structuredClone(existing);
  assert.deepEqual(importTickets([row('T1', 'Keep'), row('T1', 'Duplicate'), row('T2', 'Existing'), row(' ', 'Bad id'), row('T3', ' ')], { tenantId: 'red', existing }), {
    imported: [row('T1', 'Keep')],
    errors: [{ row: 2, code: 'DUPLICATE_ID' }, { row: 3, code: 'DUPLICATE_ID' }, { row: 4, code: 'ID_REQUIRED' }, { row: 5, code: 'TITLE_REQUIRED' }],
  });
  assert.deepEqual(existing, before);
});
