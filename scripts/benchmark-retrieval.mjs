import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKnowledge } from '../src/knowledge.mjs';

const LIMIT = 5, MAX_CHARS = 1800;
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = value => createHash('sha256').update(value).digest('hex');
const fileHash = file => { const b = readFileSync(file); return { sha256: sha(b), bytes: b.length }; };
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''));
const readText = file => readFileSync(file, 'utf8').replace(/^\uFEFF/u, '').replace(/\r\n/gu, '\n');
const jsonHash = value => sha(JSON.stringify(value));
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const abs = value => { if (!path.isAbsolute(value)) fail('INPUT', 'base must be absolute'); return path.resolve(value); };
const same = (a, b) => a.sha256 === b.sha256 && a.bytes === b.bytes;

function load(base) {
  const snapshotPath = path.join(base, 'snapshot.json'), casesPath = path.join(base, 'cases.json');
  const snapshot = readJson(snapshotPath);
  const cases = readJson(casesPath);
  const freezePath = path.join(base, 'algorithm-freeze.json'), freeze = readJson(freezePath);
  if (!Array.isArray(snapshot.files) || !snapshot.projectId || !snapshot.vaultRoot || !snapshot.sourceRoot) fail('INPUT', 'Invalid snapshot');
  if (!Array.isArray(cases.cases) || cases.humanVerified !== false || cases.projectId !== snapshot.projectId) fail('INPUT', 'Invalid cases');
  if (!Array.isArray(freeze.implementation) || freeze.limit !== LIMIT || freeze.maxChars !== MAX_CHARS) fail('INPUT', 'Invalid algorithm freeze');
  for (const item of freeze.implementation) {
    const actual = fileHash(path.join(REPO, item.path)).sha256;
    if (actual !== item.sha256) fail('ALGORITHM_STALE', `Algorithm mismatch: ${item.path}`);
  }
  const source = path.resolve(snapshot.sourceRoot), vault = path.join(base, 'vault');
  const before = [];
  for (const item of snapshot.files) {
    if (!item?.name || path.basename(item.name) !== item.name || !/\.md$/iu.test(item.name) || !/^[a-f\d]{64}$/iu.test(item.sha256)) fail('INPUT', 'Invalid snapshot file name or hash');
    const origin = path.resolve(snapshot.vaultRoot, item.name), copy = path.resolve(vault, item.name);
    if (path.relative(path.resolve(snapshot.vaultRoot), origin).startsWith('..') || path.relative(vault, copy).startsWith('..')) fail('INPUT', 'Snapshot traversal');
    const oh = fileHash(origin), ch = fileHash(copy);
    if (!same(oh, item) || !same(ch, item)) fail('STALE', `Snapshot mismatch: ${item.name}`);
    before.push({ name: item.name, ...oh, vault: ch });
  }
  const labelHash = fileHash(casesPath).sha256, snapshotHash = fileHash(snapshotPath).sha256;
  const algorithmHash = jsonHash(freeze.implementation.map(item => ({ path: item.path, sha256: item.sha256 })));
  const expected = new Map();
  for (const item of snapshot.files) {
    const text = readText(path.resolve(vault, item.name));
    let id = `file:${sha(item.name)}`;
    if (text.startsWith('---\ncodex_workbench: ')) {
      const end = text.indexOf('\n---\n', 4); let meta;
      try { meta = JSON.parse(text.slice(4 + 'codex_workbench: '.length, end)); } catch { fail('LABEL', `Bad metadata: ${item.name}`); }
      id = meta.id;
    }
    expected.set(id, { name: item.name, text });
  }
  for (const c of cases.cases) for (const r of c.relevant ?? []) {
    const note = expected.get(r.id); if (!note || typeof r.evidenceQuote !== 'string' || !note.text.includes(r.evidenceQuote)) fail('LABEL', `Label mismatch: ${c.id}/${r.id}`);
  }
  return { snapshot, cases, source, origin: path.resolve(snapshot.vaultRoot), vault, before, labelHash, snapshotHash, algorithmHash, freezeHash: fileHash(freezePath).sha256, freezePath, snapshotPath, casesPath };
}

function fingerprint(state) {
  const source = state.before.map(x => ({ name: x.name, ...fileHash(path.resolve(state.origin, x.name)) }));
  if (source.some((x, i) => !same(x, state.before[i]))) fail('SOURCE_CHANGED', 'Original source changed');
  if (state.before.some(x => !same(fileHash(path.resolve(state.vault, x.name)), x.vault))) fail('VAULT_CHANGED', 'Frozen benchmark vault changed');
  const labels = fileHash(state.casesPath).sha256, snapshot = fileHash(state.snapshotPath).sha256;
  if (labels !== state.labelHash || snapshot !== state.snapshotHash) fail('INPUT_CHANGED', 'Labels or snapshot changed');
  const freeze = readJson(state.freezePath);
  const algorithmHash = jsonHash((freeze.implementation ?? []).map(item => ({ path: item.path, sha256: fileHash(path.join(REPO, item.path)).sha256 })));
  if (fileHash(state.freezePath).sha256 !== state.freezeHash) fail('ALGORITHM_CHANGED', 'Algorithm freeze changed');
  if (algorithmHash !== state.algorithmHash) fail('ALGORITHM_CHANGED', 'Retrieval source changed');
  return { sourceHash: jsonHash(source), labelsHash: labels, snapshotHash: snapshot, algorithmHash, algorithmFreezeHash: state.freezeHash };
}

function metrics(c, result, elapsedMs) {
  const relevant = new Map((c.relevant ?? []).map(r => [r.id, r]));
  const items = result.items ?? [];
  const required = (c.relevant ?? []).filter(r => r.required);
  const requiredHits = required.filter(r => items.some(i => i.id === r.id && i.text.includes(r.evidenceQuote))).length;
  const first = items.findIndex(i => relevant.has(i.id) && i.text.includes(relevant.get(i.id).evidenceQuote));
  return { id: c.id, ms: elapsedMs, requiredRecall: required.length ? requiredHits / required.length : 1, mrr: first < 0 ? 0 : 1 / (first + 1), irrelevantCount: items.filter(i => !relevant.has(i.id) || !i.text.includes(relevant.get(i.id).evidenceQuote)).length, forbiddenCount: items.filter(i => (c.forbiddenIds ?? []).includes(i.id)).length, noAnswerReturned: c.answerable === false ? items.length : 0, chars: result.chars ?? items.reduce((n, i) => n + i.text.length, 0), retrieval: result.retrieval ?? null, returned: items.map(i => ({ id: i.id, hash: i.hash, chars: i.text.length })) };
}

function summarize(rows, answerable) { const scored = rows.filter(x => answerable.has(x.id)); const times = [...rows.map(x => x.ms)].sort((a, b) => a - b); return { requiredRecall: scored.length ? scored.reduce((n, x) => n + x.requiredRecall, 0) / scored.length : 1, meanMRR: scored.length ? scored.reduce((n, x) => n + x.mrr, 0) / scored.length : 0, totalIrrelevant: rows.reduce((n, x) => n + x.irrelevantCount, 0), totalForbidden: rows.reduce((n, x) => n + x.forbiddenCount, 0), noAnswerReturned: rows.reduce((n, x) => n + x.noAnswerReturned, 0), totalChars: rows.reduce((n, x) => n + x.chars, 0), medianMs: times.length ? (times.length % 2 ? times[(times.length - 1) / 2] : (times[times.length / 2 - 1] + times[times.length / 2]) / 2) : 0 }; }

async function main() {
  const flag = process.argv.indexOf('--base'); if (flag < 0 || !process.argv[flag + 1]) fail('INPUT', 'Usage: node scripts/benchmark-retrieval.mjs --base <absolute-private-base>');
  const base = abs(process.argv[flag + 1]); const output = path.join(base, 'comparison.json'); if (existsSync(output)) fail('OUTPUT_EXISTS', 'comparison.json already exists');
  const state = load(base); const startFingerprint = fingerprint(state); const scriptHash = fileHash(fileURLToPath(import.meta.url)).sha256;
  const knowledge = createKnowledge({ projectId: state.snapshot.projectId, vaultRoot: state.vault, indexPath: path.join(base, 'benchmark.sqlite'), sourceRoot: state.source });
  const rows = { bm25: [], smart: [] }; const order = ['bm25', 'smart']; let finalFingerprint;
  try {
    for (const strategy of order) knowledge.search('', { strategy, limit: LIMIT, maxChars: MAX_CHARS });
    for (let n = 0; n < state.cases.cases.length; n++) for (const strategy of [order[n % 2], order[(n + 1) % 2]]) {
      const c = state.cases.cases[n]; fingerprint(state); const t = performance.now(); const result = knowledge.search(c.query, { strategy, limit: LIMIT, maxChars: MAX_CHARS });
      const elapsed = performance.now() - t; const row = metrics(c, result, elapsed); rows[strategy].push(row); fingerprint(state);
    }
    finalFingerprint = fingerprint(state);
  } finally { knowledge.close(); }
  if (fileHash(fileURLToPath(import.meta.url)).sha256 !== scriptHash) fail('SCRIPT_CHANGED', 'Benchmark script changed during run');
  const answerable = new Set(state.cases.cases.filter(c => c.answerable !== false).map(c => c.id)); const baseline = summarize(rows.bm25, answerable), candidate = summarize(rows.smart, answerable);
  const byId = key => new Map(rows.bm25.map(r => [r.id, r])); const baseMap = byId();
  const perQueryGate = rows.smart.filter(r => answerable.has(r.id)).every(r => r.requiredRecall >= (baseMap.get(r.id)?.requiredRecall ?? 0));
  const totalsGate = candidate.totalForbidden <= baseline.totalForbidden && candidate.noAnswerReturned <= baseline.noAnswerReturned && candidate.totalIrrelevant <= baseline.totalIrrelevant;
  const improved = candidate.requiredRecall > baseline.requiredRecall || candidate.meanMRR > baseline.meanMRR || candidate.totalIrrelevant < baseline.totalIrrelevant;
  const result = { schemaVersion: 1, projectId: state.snapshot.projectId, generatedAt: new Date().toISOString(), config: { limit: LIMIT, maxChars: MAX_CHARS, warmups: 2, note: 'single evaluation; not a multi-run performance benchmark' }, hashes: { ...startFingerprint, scriptHash, final: finalFingerprint }, baseline: { strategy: 'bm25', queries: rows.bm25, summary: baseline }, comparison: { strategy: 'smart', queries: rows.smart, summary: candidate }, gate: { perQueryRequiredRecall: perQueryGate, totals: totalsGate, improved, adopted: perQueryGate && totalsGate && improved, rules: 'Each answerable query requiredRecall >= baseline; total forbidden, no-answer returned, and irrelevant do not increase; requiredRecall or meanMRR improves, or irrelevant decreases.' } };
  const fd = openSync(output, 'wx'); try { writeFileSync(fd, JSON.stringify(result, null, 2)); } finally { closeSync(fd); }
}

main().catch(error => { process.stderr.write(JSON.stringify({ error: error.code || 'BENCHMARK_FAILED', message: error.message }) + '\n'); process.exitCode = 1; });
