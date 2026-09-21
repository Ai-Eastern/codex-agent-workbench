import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCodex, resolveCodexExecutable } from '../src/codex-executor.mjs';

// This executable is a protocol fixture, never a real model or Codex execution.
const fakeSource = `
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const mode = process.argv[2];
const args = process.argv.slice(3);
const output = args[args.indexOf('--output-last-message') + 1];
const emit = (event) => process.stdout.write(JSON.stringify(event) + '\\n');
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
fs.writeFileSync(path.join(path.dirname(output), 'fixture-input.json'), JSON.stringify({ args, prompt }));
if (mode === 'environment') {
  const parentKeys = Object.keys(process.env).filter((key) => /^(?:GIT_|CODEX_(?:THREAD_ID|TURN_ID|TASK_ID|PARENT_THREAD_ID|AGENT_ID|SESSION_ID|APP_TOOLS_PIPE_PATH|WORKBENCH_CHECK)$)/i.test(key));
  fs.writeFileSync(path.join(path.dirname(output), 'fixture-environment.json'), JSON.stringify({ parentKeys, codexHome: process.env.CODEX_HOME, normalConfig: process.env.WORKBENCH_FIXTURE_CONFIG }));
}
if (mode === 'empty') process.exit(0);
if (mode === 'nonjson') { process.stdout.write('not-json\\n'); process.exit(0); }
if (mode === 'primitive') { process.stdout.write('true\\n'); process.exit(0); }
if (mode === 'invalid-utf8') { process.stdout.write(Buffer.from([0xff, 0x0a])); process.exit(0); }
if (mode === 'truncated') { process.stdout.write('{"type":"turn.completed"}'); process.exit(0); }
if (mode === 'bigline') { process.stdout.write('x'.repeat(2 * 1024 * 1024 + 1)); setInterval(() => {}, 1000); }
else if (mode === 'bigoutput') { for(let i = 0; i < 40; i++) process.stderr.write('x'.repeat(1024 * 1024)); setInterval(() => {}, 1000); }
else {
  emit({ type: 'thread.started', thread_id: 'fixture-thread' });
  emit({ type: 'turn.started' });
  process.stderr.write('fixture diagnostic\\n');
  if (mode === 'wait' || mode === 'tree') {
    if (mode === 'tree') {
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); process.stdout.write("READY"); setInterval(() => {}, 1000)'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.once('data', () => emit({ type: 'fixture.child', pid: child.pid }));
    }
    setInterval(() => {}, 1000);
  } else {
    if (mode === 'error') emit({ type: 'error', message: 'fixture failure' });
    if (mode === 'failed') emit({ type: 'turn.failed', error: { message: 'fixture failed turn' } });
    const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '中文 fixture summary' } }) + '\\n';
    const bytes = Buffer.from(message);
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    await new Promise(resolve => setTimeout(resolve, 10));
    process.stdout.write(bytes.subarray(split));
    fs.writeFileSync(output, mode === 'bigsummary' ? 'x'.repeat(1024 * 1024 + 1) : '中文 fixture summary');
    if (mode !== 'incomplete') emit({ type: 'turn.completed', usage: { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7 } });
    if (mode === 'exit') process.exitCode = 2;
  }
}
`;

async function fixture(t, mode = 'ok') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'workbench-codex-fixture-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, 'fake-process.mjs');
  await fs.writeFile(script, fakeSource);
  return { directory, options: { cwd: directory, prompt: 'fixture-only prompt', outputDirectory: path.join(directory, 'logs'), timeoutMs: 10000, command: { file: process.execPath, args: [script, mode] } } };
}

test('executor streams real fixture bytes, preserves Unicode, passes prompt only on stdin and requires completion', async (t) => {
  const { options } = await fixture(t);
  const events = [];
  const prompt = '中文 "quoted"\n$(never-run) & del *';
  const result = await runCodex({ ...options, prompt, onEvent: (event) => events.push(event) });
  assert.equal(result.status, 'completed');
  assert.equal(result.threadId, 'fixture-thread');
  assert.equal(result.summary, '中文 fixture summary');
  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.usage, { input_tokens: 12, cached_input_tokens: 3, output_tokens: 7 });
  const input = JSON.parse(await fs.readFile(path.join(options.outputDirectory, 'fixture-input.json'), 'utf8'));
  assert.equal(input.prompt, prompt);
  assert.ok(!input.args.includes(prompt));
  assert.deepEqual(input.args.slice(0, 5), ['exec', '--json', '--sandbox', 'workspace-write', '--ephemeral']);
  assert.equal(input.args.at(-1), '-');
  assert.ok(!input.args.includes('-m') && !input.args.includes('-c'));
  assert.ok(!input.args.some((arg) => arg.includes('dangerously') || arg.includes('danger-full-access')));
  assert.deepEqual((await fs.readFile(result.eventsPath, 'utf8')).trim().split('\n').map(JSON.parse), events);
  assert.equal(await fs.readFile(result.stderrPath, 'utf8'), 'fixture diagnostic\n');
});

test('executor only overrides explicitly requested model and reasoning through separate argv values', async (t) => {
  const { options } = await fixture(t);
  assert.equal((await runCodex({ ...options, model: 'user-selected-model', reasoning: 'high' })).status, 'completed');
  const { args } = JSON.parse(await fs.readFile(path.join(options.outputDirectory, 'fixture-input.json'), 'utf8'));
  assert.equal(args[args.indexOf('-m') + 1], 'user-selected-model');
  assert.equal(args[args.indexOf('-c') + 1], 'model_reasoning_effort="high"');
});

test('executor removes parent task and Git environment without changing authentication configuration or parent environment', async (t) => {
  const { options, directory } = await fixture(t, 'environment');
  const synthetic = {
    CODEX_THREAD_ID: 'fixture-parent-thread', CODEX_TURN_ID: 'fixture-parent-turn',
    CODEX_TASK_ID: 'fixture-parent-task', CODEX_PARENT_THREAD_ID: 'fixture-parent-parent',
    CODEX_AGENT_ID: 'fixture-parent-agent', CODEX_SESSION_ID: 'fixture-parent-session',
    CODEX_APP_TOOLS_PIPE_PATH: 'fixture-desktop-pipe', CODEX_WORKBENCH_CHECK: 'fixture-parent-check',
    GIT_DIR: 'fixture-parent-git', GIT_WORK_TREE: 'fixture-parent-tree',
    GIT_INDEX_FILE: 'fixture-parent-index', GIT_CONFIG_COUNT: '0',
    CODEX_HOME: path.join(directory, 'fixture-auth-home'), WORKBENCH_FIXTURE_CONFIG: 'fixture-normal-config',
  };
  const previous = Object.fromEntries(Object.keys(synthetic).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, synthetic);
  assert.equal((await runCodex(options)).status, 'completed');
  const observed = JSON.parse(await fs.readFile(path.join(options.outputDirectory, 'fixture-environment.json'), 'utf8'));
  assert.deepEqual(observed.parentKeys, []);
  assert.equal(observed.codexHome, synthetic.CODEX_HOME);
  assert.equal(observed.normalConfig, synthetic.WORKBENCH_FIXTURE_CONFIG);
  for (const [key, value] of Object.entries(synthetic)) assert.equal(process.env[key], value);
});

for (const [mode, reason] of Object.entries({ empty: 'EMPTY_EVENTS', nonjson: 'INVALID_JSONL', primitive: 'INVALID_EVENT', 'invalid-utf8': 'INVALID_UTF8', truncated: 'TRUNCATED_JSONL', incomplete: 'NO_COMPLETED_TURN', exit: 'NONZERO_EXIT', error: 'CODEX_ERROR_EVENT', failed: 'CODEX_ERROR_EVENT', bigline: 'EVENT_LINE_LIMIT', bigoutput: 'OUTPUT_LIMIT', bigsummary: 'SUMMARY_LIMIT' })) {
  test(`executor rejects fixture ${mode} output`, async (t) => {
    const { options } = await fixture(t, mode);
    const result = await runCodex(options);
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, reason);
    assert.ok((await fs.stat(result.eventsPath)).isFile());
    assert.ok((await fs.stat(result.stderrPath)).isFile());
    assert.ok((await fs.stat(result.eventsPath)).size + (await fs.stat(result.stderrPath)).size <= 32 * 1024 * 1024);
  });
}

test('executor reports missing executable without credentials or stderr in its reason', async (t) => {
  const { options, directory } = await fixture(t);
  const result = await runCodex({ ...options, command: { file: path.join(directory, 'missing-executable'), args: [] } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'SPAWN_FAILED');
});

test('executor refuses to overwrite previous raw logs', async (t) => {
  const { options } = await fixture(t);
  const first = await runCodex(options);
  const original = await fs.readFile(first.eventsPath, 'utf8');
  const second = await runCodex(options);
  assert.equal(second.reason, 'OUTPUT_DIRECTORY_UNAVAILABLE_OR_USED');
  assert.equal(await fs.readFile(first.eventsPath, 'utf8'), original);
});

test('executor timeout interrupts its fixture process', async (t) => {
  const { options } = await fixture(t, 'wait');
  const start = Date.now();
  const result = await runCodex({ ...options, timeoutMs: 200 });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reason, 'TIMEOUT');
  assert.ok(Date.now() - start < 6000);
});

test('executor abort interrupts only its spawned process tree', async (t) => {
  const { options } = await fixture(t, 'tree');
  const controller = new AbortController();
  let childPid;
  const result = await runCodex({ ...options, signal: controller.signal, onEvent: (event) => {
    if (event.type === 'fixture.child') { childPid = event.pid; controller.abort(); }
  } });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reason, 'ABORTED');
  assert.ok(childPid);
  const deadline = Date.now() + 2000;
  let alive = true;
  while (alive && Date.now() < deadline) {
    try { process.kill(childPid, 0); } catch { alive = false; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive, false, 'fixture descendant must be terminated');
  assert.doesNotThrow(() => process.kill(process.pid, 0), 'the test runner must remain alive');
});

test('executor honors an already aborted signal without spawning the fixture', async (t) => {
  const { options } = await fixture(t);
  const controller = new AbortController(); controller.abort();
  const result = await runCodex({ ...options, signal: controller.signal });
  assert.equal(result.status, 'interrupted');
  assert.equal(result.reason, 'ABORTED');
  await assert.rejects(fs.stat(path.join(options.outputDirectory, 'fixture-input.json')), { code: 'ENOENT' });
});

test('executor contains event observer failure', async (t) => {
  const { options } = await fixture(t);
  const result = await runCodex({ ...options, onEvent: () => { throw Error('private observer error'); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.reason, 'EVENT_CALLBACK_FAILED');
});

test('Windows resolver recognizes known npm installation layout without executing a shim', { skip: process.platform !== 'win32' }, async (t) => {
  const { directory } = await fixture(t);
  const shim = path.join(directory, 'codex.cmd');
  const native = path.join(directory, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  await fs.mkdir(path.dirname(native), { recursive: true });
  await fs.writeFile(native, 'resolver fixture, never executed');
  await fs.writeFile(shim, `@echo off\r\n"${native}" %*\r\n`);
  assert.equal(resolveCodexExecutable(shim, { arch: 'x64' }), native);
  await fs.writeFile(shim, '@echo off\r\n"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  assert.equal(resolveCodexExecutable(shim, { arch: 'x64' }), native);
  await fs.writeFile(shim, '@echo off\r\nmalicious-command & codex\r\n');
  assert.throws(() => resolveCodexExecutable(shim), { code: 'CODEX_EXECUTABLE_NOT_FOUND' });
});
