import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {digest, assertContained} from '../src/contracts.mjs';

const usage = 'npm run smoke:agent -- --output <new-directory> [--executable <codex-path>]';
const implementation = 'export function normalizeLabels(labels) { return labels; }\n';
const tests = `import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeLabels} from '../src/normalize.mjs';
test('trim, discard blank, stable deduplication', () => assert.deepEqual(
  normalizeLabels([' a ', '', 'b', 'a', '   ', ' b ', '中文']), ['a', 'b', '中文']
));
test('preserve case and do not mutate input', () => {
  const values = [' A ', 'a'];
  assert.deepEqual(normalizeLabels(values), ['A', 'a']);
  assert.deepEqual(values, [' A ', 'a']);
});
`;

async function main() {
  const {values} = parseArgs({options: {output: {type: 'string'}, executable: {type: 'string'}, help: {type: 'boolean'}}, allowPositionals: false});
  if (values.help) {
    console.log(`${usage}\n\nRuns one real Codex CLI task using your existing sign-in and quota.\nModel and reasoning configuration are inherited; provider-observed model is not collected.\nCreates a fresh Git fixture and sibling state directory, preserves failures and logs, and never merges.\nThis opt-in smoke is not part of npm test or CI. --help does not execute a task.`);
    return;
  }
  if (!values.output?.trim()) throw Error(`--output is required; an existing directory is never reused.\n${usage}`);
  const outputRoot = path.resolve(values.output);
  assertContained(path.parse(outputRoot).root, outputRoot);
  if (fs.existsSync(outputRoot)) throw Error('Output directory already exists; preserve it and choose a new directory');
  if (values.executable !== undefined && (!values.executable.trim() || values.executable.includes('\0'))) throw Error('Invalid --executable');
  const cancellation = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => cancellation.abort());
  const executable = values.executable && /[\\/]/.test(values.executable) ? path.resolve(values.executable) : values.executable;
  fs.mkdirSync(path.dirname(outputRoot), {recursive: true});
  fs.mkdirSync(outputRoot); // Atomic reservation; never reuse an earlier run after an error.
  const repository = path.join(outputRoot, 'repo'), stateRoot = path.join(outputRoot, 'state');
  const setup = path.join(outputRoot, 'setup'), id = 'real-codex-normalize-v1';
  const workbenchRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
  const relative = file => file ? path.relative(outputRoot, file).split(path.sep).join('/') : null;
  const cleanText = value => typeof value === 'string' ? value.replaceAll(outputRoot, '.').replaceAll(outputRoot.replaceAll('\\', '/'), '.').replaceAll(workbenchRoot, '<workbench-source>').replaceAll(workbenchRoot.replaceAll('\\', '/'), '<workbench-source>').replaceAll(process.execPath, 'node') : value;
  let result, sourceBefore, sourceAfter, failure = null, git;
  const sourceSnapshot = () => ({
    head: git('rev-parse', 'HEAD').trim(), status: git('status', '--porcelain=v1', '-z'),
    indexSha256: digest(fs.readFileSync(path.join(repository, '.git', 'index'))),
    implementationSha256: digest(fs.readFileSync(path.join(repository, 'src/normalize.mjs'))),
    acceptanceSha256: digest(fs.readFileSync(path.join(repository, 'test/normalize.test.mjs'))),
  });
  try {
    fs.mkdirSync(repository); fs.mkdirSync(setup);
    const emptyConfig = path.join(setup, 'empty-git-config');
    fs.writeFileSync(emptyConfig, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
    Object.assign(env, {GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1', GIT_OPTIONAL_LOCKS: '0'});
    git = (...args) => execFileSync('git', ['-c', 'user.name=Smoke fixture', '-c', 'user.email=smoke@example.invalid', '-c', 'commit.gpgSign=false', '-c', `core.hooksPath=${setup}`, '-c', 'core.fsmonitor=false', '-c', 'core.autocrlf=false', '-c', 'core.longpaths=true', ...args], {cwd: repository, env, encoding: 'utf8', windowsHide: true, shell: false, timeout: 30000, maxBuffer: 2 * 1024 * 1024});
    git('init', '-q');
    fs.mkdirSync(path.join(repository, 'src')); fs.mkdirSync(path.join(repository, 'test'));
    fs.writeFileSync(path.join(repository, 'src/normalize.mjs'), implementation);
    fs.writeFileSync(path.join(repository, 'test/normalize.test.mjs'), tests);
    git('add', '--', 'src/normalize.mjs', 'test/normalize.test.mjs');
    git('commit', '-qm', 'Intentional normalization defect for opt-in live smoke');
    sourceBefore = sourceSnapshot();
    const {runLocalTask, readLocalTask} = await import('../src/local-runner.mjs');
    console.log('This smoke invokes the real Codex CLI using your existing sign-in and quota. Model and reasoning settings are inherited; executor timeout: 120 seconds.');
    try {
      result = await runLocalTask({repository, stateRoot, executable, signal: cancellation.signal, request: {
        id, objective: 'Implement normalizeLabels(labels) in src/normalize.mjs. Input is an array of strings. Trim each string, discard empty values, remove duplicates while preserving first-occurrence order and case, and do not mutate the input. Only change the allowed implementation file. Run the existing node tests. Do not commit or modify tests.',
        files: ['src/normalize.mjs'], acceptanceFiles: ['test/normalize.test.mjs'],
        checks: [{id: 'normalize-tests', command: 'node', args: ['--test', 'test/normalize.test.mjs'], timeoutMs: 30000}],
        timeoutMs: 120000,
      }, onEvent: event => {
        if (event.type.startsWith('workbench.') || ['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(event.type)) {
          console.log(JSON.stringify({event: event.type, ...(event.id ? {check: event.id} : {}), ...(event.exitCode !== undefined ? {exitCode: event.exitCode} : {})}));
        }
      }});
    } catch (error) {
      failure = cleanText(error.message);
      try { result = readLocalTask({stateRoot, id}); } catch {}
    }
  } catch (error) { failure = cleanText(error.message); }
  if (sourceBefore) {
    try { sourceAfter = sourceSnapshot(); }
    catch (error) { failure ??= cleanText(error.message); }
  }
  const sourceUnchanged = Boolean(sourceBefore && sourceAfter && digest(sourceBefore) === digest(sourceAfter));
  let patch = null, acceptance = null;
  try {
    if (result?.patch) {
      const sha256 = digest(fs.readFileSync(result.patch.path));
      patch = {path: relative(result.patch.path), sha256, recordedSha256: result.patch.sha256, verified: sha256 === result.patch.sha256, changedFiles: result.patch.changedFiles};
    }
    if (result?.acceptance?.path) {
      const bytes = fs.readFileSync(result.acceptance.path), receipt = JSON.parse(bytes);
      acceptance = {path: relative(result.acceptance.path), sha256: digest(bytes), verified: result.acceptance.verified === true && digest(bytes) === result.acceptance.hash, passed: receipt.passed, expectedTests: 2, checks: receipt.checks.map(check => ({id: check.id, exitCode: check.exitCode, error: cleanText(check.error), elapsedMs: check.elapsedMs}))};
    }
  } catch (error) { failure ??= cleanText(error.message); }
  const passed = result?.phase === 'READY_FOR_REVIEW' && sourceUnchanged && patch?.verified === true && acceptance?.verified === true && acceptance?.passed === true && !failure;
  const manifest = path.join(stateRoot, 'runs', id, 'run.json');
  const summary = {
    schemaVersion: 1, generatedAt: new Date().toISOString(), kind: 'live-codex-smoke', passed,
    phase: result?.phase ?? 'BLOCKED', error: failure ?? cleanText(result?.error) ?? null,
    configuration: {model: 'inherited', reasoning: 'inherited', observedModel: null, executorTimeoutMs: 120000, acceptanceTimeoutMs: 30000, executable: values.executable ? 'explicitly supplied' : 'Codex CLI discovery'},
    execution: {kind: 'real-codex-cli', status: result?.execution?.status ?? 'not-started', reason: result?.execution?.reason ?? null, exitCode: result?.execution?.exitCode ?? null, usage: result?.execution?.usage ?? null},
    source: {path: 'repo', unchanged: sourceUnchanged, before: sourceBefore ?? null, after: sourceAfter ?? null},
    acceptance, patch,
    paths: {manifest: fs.existsSync(manifest) ? relative(manifest) : null, events: relative(result?.execution?.eventsPath), stderr: relative(result?.execution?.stderrPath), executorResult: relative(result?.executorResult)},
    limitations: ['One public two-test fixture; this is not a coding benchmark or a hidden evaluation.', 'No trusted provider-side model metadata was collected; observedModel remains null.', 'Failure logs and the worktree remain on disk. No retry, merge, push or automatic cleanup is performed.'],
  };
  fs.writeFileSync(path.join(outputRoot, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify(summary, null, 2));
  if (!passed) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
