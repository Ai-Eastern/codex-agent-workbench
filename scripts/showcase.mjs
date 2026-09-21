import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runEvidenceLab } from './evidence-lab.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const assets = path.join(repository, 'showcase');

export function standaloneReport(report) {
  // JSON is data even when a fixture contains HTML or a closing script tag.
  const json = JSON.stringify(report).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028').replaceAll('\u2029', '\\u2029');
  const css = fs.readFileSync(path.join(assets, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(assets, 'app.js'), 'utf8');
  return fs.readFileSync(path.join(assets, 'index.html'), 'utf8')
    .replace('<link rel="stylesheet" href="./style.css">', () => `<style>${css}</style>`)
    .replace('<script type="module" src="./app.js"></script>', () => `<script>window.WORKBENCH_REPORT=${json};</script><script type="module">${js}</script>`);
}

export async function serveReport(report, { port = 4317 } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('port must be an integer between 0 and 65535');
  const routes = new Map([
    ['/', ['text/html; charset=utf-8', fs.readFileSync(path.join(assets, 'index.html'))]],
    ['/style.css', ['text/css; charset=utf-8', fs.readFileSync(path.join(assets, 'style.css'))]],
    ['/app.js', ['text/javascript; charset=utf-8', fs.readFileSync(path.join(assets, 'app.js'))]],
    ['/report.json', ['application/json; charset=utf-8', JSON.stringify(report, null, 2) + '\n']],
    ['/export.html', ['text/html; charset=utf-8', standaloneReport(report)]],
  ]);
  // Fixed read-only routes: no filesystem browsing, shell actions, or project writes.
  const server = http.createServer((request, response) => {
    if (request.headers.host !== `127.0.0.1:${server.address().port}`) {
      response.writeHead(403); response.end('Loopback host required'); return;
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
    }
    const route = routes.get(request.url);
    if (!route) { response.writeHead(404); response.end('Not found'); return; }
    const [contentType, body] = route;
    response.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      ...(request.url === '/export.html' ? { 'Content-Disposition': 'attachment; filename="workbench-evidence.html"' } : {}),
    });
    response.end(request.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function main() {
  const { values } = parseArgs({ options: {
    port: { type: 'string', default: '4317' },
    output: { type: 'string' },
    report: { type: 'string' },
    help: { type: 'boolean' },
  } });
  if (values.help) {
    console.log('npm run demo -- [--port 4317] [--output <new directory>]\nReuse a report without executing the lab: npm run demo -- --report <report.json>');
    return;
  }
  if (values.report && values.output) throw Error('--report and --output cannot be used together');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error('--port must be between 0 and 65535');
  let report;
  if (values.report) {
    report = JSON.parse(fs.readFileSync(path.resolve(values.report), 'utf8'));
    if (report.schemaVersion !== 1 || report.execution?.kind !== 'deterministic-fixture' || !Array.isArray(report.stages)) throw Error('Expected an Evidence Lab v1 report');
  } else {
    const outputRoot = values.output ? path.resolve(values.output) : path.join(repository, '.local', 'evidence-lab', `${Date.now()}-${process.pid}`);
    const result = await runEvidenceLab({ outputRoot });
    report = result.report;
    fs.writeFileSync(path.join(result.outputRoot, 'report.html'), standaloneReport(report), { flag: 'wx' });
    console.log(`Evidence: ${result.reportPath}\nOffline viewer: ${path.join(result.outputRoot, 'report.html')}`);
  }
  const { server, url } = await serveReport(report, { port });
  console.log(`\nEvidence Lab: ${url}\nDeterministic fixtures; no model calls. Press Ctrl+C to stop.`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
