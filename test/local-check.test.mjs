import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runLocalCheck} from '../src/local-check.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => {
  try {
    process.kill(pid, 0);
    if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))) return false;
    return true;
  } catch { return false; }
};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-check-中文-'));
  t.after(() => {
    for (const name of ['tree.json', 'leaf.json']) {
      const file = path.join(root, name);
      if (!fs.existsSync(file)) continue;
      for (const pid of Object.values(JSON.parse(fs.readFileSync(file)))) {
        if (!alive(pid)) continue;
        if (process.platform === 'win32') spawnSync(path.join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        else { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
    }
    const relative = path.relative(os.tmpdir(), root);
    assert.ok(relative.startsWith('workbench-check-中文-') && !relative.includes(path.sep));
    fs.rmSync(root, {recursive: true, force: true});
  });
  return root;
}

test('acceptance runs without blocking the event loop and preserves Chinese JSON and failure output', async t => {
  const root = fixture(t);
  const argument = '中文 "引号"\n$(never-run) & literal';
  const context = {runId: '中文验收', checkId: 'check', workRoot: root, outputRoot: path.join(root, 'results')};
  let beats = 0;
  const interval = setInterval(() => beats++, 5);
  t.after(() => clearInterval(interval));
  const result = await runLocalCheck({command: 'node', args: ['-e', 'setTimeout(()=>console.log(JSON.stringify({argument:process.argv[1],context:JSON.parse(process.env.CODEX_WORKBENCH_CHECK)})),150)', argument]}, root, context);
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, null);
  assert.deepEqual(JSON.parse(result.stdout), {argument, context});
  assert.ok(beats > 5, 'HTTP and cancellation timers must keep running while acceptance executes');
  const failed = await runLocalCheck({command: 'node', args: ['-e', 'process.stderr.write("真实失败\\n");process.exit(7)']}, root);
  assert.equal(failed.exitCode, 7);
  assert.equal(failed.error, null);
  assert.equal(failed.stderr, '真实失败\n');
});

test('acceptance strips Desktop and Git authority while keeping ordinary environment variables', async t => {
  const root = fixture(t);
  const names = ['CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_TASK_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_AGENT_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_WORKBENCH_CHECK', 'GIT_DIR', 'GIT_CONFIG_COUNT', 'WORKBENCH_CHECK_TEST_VALUE'];
  const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) process.env[name] = 'public-fixture-value';
  try {
    const selectedNames = JSON.stringify([...names, 'NODE_TEST_CONTEXT']);
    const result = await runLocalCheck({command: 'node', args: ['-e', `console.log(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key])=>${selectedNames}.includes(key.toUpperCase())||key.toUpperCase().startsWith('GIT_')))))`]}, root);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout), {WORKBENCH_CHECK_TEST_VALUE: 'public-fixture-value'});
  } finally {
    for (const [name, value] of Object.entries(original)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
});

function treeCheck(root, timeoutMs) {
  const leaf = `const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(path.join(root, 'leaf.json'))},JSON.stringify({leaf:process.pid}));setInterval(()=>{},1000)`;
  const middle = `const {spawn}=require('child_process');spawn(process.execPath,['-e',${JSON.stringify(leaf)}],{windowsHide:true,stdio:'ignore'});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
  const script = `const fs=require('fs');const {spawn}=require('child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(middle)}],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(path.join(root, 'tree.json'))},JSON.stringify({worker:process.ppid,acceptance:process.pid,middle:child.pid}));setInterval(()=>{},1000)`;
  return {command: 'node', args: ['-e', script], timeoutMs};
}

async function waitForTree(root) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(path.join(root, 'leaf.json')) && Date.now() < deadline) await delay(20);
  assert.ok(fs.existsSync(path.join(root, 'leaf.json')), 'fixture grandchild must have started');
  return {...JSON.parse(fs.readFileSync(path.join(root, 'tree.json'))), ...JSON.parse(fs.readFileSync(path.join(root, 'leaf.json')))};
}

for (const mode of ['TIMEOUT', 'ABORTED']) {
  test(`${mode} stops only the worker and its real acceptance descendants`, async t => {
    const root = fixture(t), controller = new AbortController();
    const pending = runLocalCheck(treeCheck(root, mode === 'TIMEOUT' ? 2500 : 10000), root, undefined, {signal: controller.signal});
    const pids = await waitForTree(root);
    if (mode === 'ABORTED') controller.abort();
    const result = await pending;
    assert.equal(result.exitCode, null);
    assert.equal(result.error, mode);
    assert.equal(result.terminationError, undefined);
    const deadline = Date.now() + 2000;
    while (Object.values(pids).some(alive) && Date.now() < deadline) await delay(20);
    for (const [role, pid] of Object.entries(pids)) assert.equal(alive(pid), false, `${role} must have exited`);
    assert.equal(alive(process.pid), true, 'parent test process must remain alive');
  });
}

test('an already aborted check never executes and escaped worker output is bounded', async t => {
  const root = fixture(t), controller = new AbortController(); controller.abort();
  const result = await runLocalCheck({command: 'node', args: ['-e', 'require("fs").writeFileSync("must-not-exist","x")']}, root, undefined, {signal: controller.signal});
  assert.equal(result.error, 'ABORTED');
  assert.equal(fs.existsSync(path.join(root, 'must-not-exist')), false);
  const large = await runLocalCheck({command: 'node', args: ['-e', 'process.stdout.write("\\0".repeat(1500000))']}, root);
  assert.equal(large.exitCode, null);
  assert.equal(large.error, 'OUTPUT_LIMIT');
});

test('Windows npm and npx resolve only the standard Node installation and never execute arbitrary shims', {skip: process.platform !== 'win32'}, async t => {
  const root = fixture(t);
  for (const command of ['npm', 'npx']) {
    const result = await runLocalCheck({command, args: ['--version']}, root);
    const cli = path.join(path.dirname(process.execPath), 'node_modules/npm/bin', `${command}-cli.js`);
    if (fs.existsSync(cli)) { assert.equal(result.exitCode, 0); assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/); }
    else { assert.equal(result.exitCode, null); assert.match(result.error, /^NPM_CLI_NOT_FOUND/); }
    assert.equal(result.command, command);
    assert.deepEqual(result.args, ['--version']);
  }
  const shim = path.join(root, 'untrusted.cmd');
  fs.writeFileSync(shim, '@echo off\r\necho unsafe > SHOULD_NOT_EXIST\r\n');
  const result = await runLocalCheck({command: shim, args: []}, root);
  assert.equal(result.exitCode, null);
  assert.match(result.error, /^SHELL_SHIM_UNSUPPORTED/);
  assert.equal(fs.existsSync(path.join(root, 'SHOULD_NOT_EXIST')), false);
});
