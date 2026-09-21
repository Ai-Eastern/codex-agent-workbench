import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { serveReport, standaloneReport } from '../scripts/showcase.mjs';

test('viewer is loopback-only, read-only, allowlisted and exports safely embedded data', async t => {
  const report = { schemaVersion: 1, scenario: { title: '</script><script>globalThis.injected=true</script>' }, stages: [] };
  const { server, url } = await serveReport(report, { port: 0 });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`${url}/report.json`);
  assert.deepEqual(await response.json(), report);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(`${url}/`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${url}/package.json`)).status, 404);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${url}/report.json`, { headers: { Host: 'other.example' } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${url}/`, { method: 'HEAD' })).status, 200);
  const exported = await fetch(`${url}/export.html`);
  assert.match(exported.headers.get('content-disposition'), /attachment/);
  const html = await exported.text();
  assert.equal(html, standaloneReport(report));
  assert(!html.includes(report.scenario.title));
  assert(html.includes('\\u003c/script>'));
  assert(!html.includes('src="./app.js"'));
  assert(!html.includes('href="./style.css"'));
});
