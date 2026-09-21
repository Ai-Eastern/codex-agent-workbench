import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = process.env.WORKBENCH_FIXTURE_ROOT ?? fileURLToPath(new URL('../', import.meta.url));
const { createClient } = await import(pathToFileURL(resolve(root, 'src/client.mjs')));
const config = await import(pathToFileURL(resolve(root, 'src/config.mjs')));

test('B-v1-identity: SDK project retains its own same-named config', () => {
  assert.equal(config.projectId, 'project-b');
  assert.equal(config.moduleKind, 'compatibility-sdk');
});
test('B-v1-new: keeps the current object-call result and default method', async () => {
  const calls = [];
  const client = createClient({ transport: async request => { calls.push(request); return { status: 200, data: ['ok'] }; } });
  assert.deepEqual(await client.request({ path: '/tickets' }), ['ok']);
  assert.deepEqual(calls, [{ path: '/tickets', method: 'GET', body: undefined }]);
});
test('B-v1-legacy: old and new calls produce identical requests and results', async () => {
  const calls = [];
  const client = createClient({ transport: async request => { calls.push(request); return { status: 201, data: { id: 'T1' } }; } });
  const options = { method: 'POST', body: { title: 'Ticket' } };
  assert.deepEqual(await client.request('/tickets', options), await client.request({ path: '/tickets', ...options }));
  assert.deepEqual(calls, [{ path: '/tickets', ...options }, { path: '/tickets', ...options }]);
  assert.deepEqual(options, { method: 'POST', body: { title: 'Ticket' } });
});
test('B-v1-errors: preserves transport errors and exposes HTTP error status', async () => {
  const sentinel = new Error('transport offline');
  await assert.rejects(createClient({ transport: async () => { throw sentinel; } }).request('/tickets'), error => error === sentinel);
  const client = createClient({ transport: async () => ({ status: 403, data: { error: 'denied' } }) });
  for (const request of ['/tickets', { path: '/tickets' }]) {
    await assert.rejects(client.request(request), error => error.code === 'HTTP_ERROR' && error.status === 403);
  }
});
test('B-v1-invalid: rejects invalid paths before calling transport', async () => {
  let calls = 0;
  const client = createClient({ transport: async () => { calls++; return { status: 200 }; } });
  for (const input of [null, {}, '', { path: ' ' }]) await assert.rejects(client.request(input), /path is required/);
  assert.equal(calls, 0);
});
