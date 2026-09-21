import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const workerPath = fileURLToPath(new URL('./acceptance-worker.mjs', import.meta.url));
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const PARENT_CONTEXT_KEYS = new Set(['CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_TASK_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_AGENT_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_WORKBENCH_CHECK', 'NODE_TEST_CONTEXT']);

/** Async acceptance with the existing runCheck receipt and one authoritative process-tree deadline. */
export async function runLocalCheck(check, cwd, context, {signal} = {}) {
  if (!check || typeof check.command !== 'string' || !check.command || check.command.includes('\0') || !Array.isArray(check.args) || check.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new TypeError('Acceptance requires a command and string argv');
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) throw new TypeError('Acceptance cwd must be absolute');
  const timeoutMs = check.timeoutMs ?? 60000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) throw new TypeError('Acceptance timeoutMs must be between 1 and 300000');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid abort signal');
  const start = Date.now();
  const failure = (error, stderr = '') => ({command: check.command, args: check.args, exitCode: null, stdout: '', stderr, error, elapsedMs: Date.now() - start});
  if (signal?.aborted) return failure('ABORTED');
  const input = JSON.stringify({check, cwd, context});
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => {
    const name = key.toUpperCase();
    return !name.startsWith('GIT_') && !PARENT_CONTEXT_KEYS.has(name);
  }));
  let worker;
  try {
    worker = spawn(process.execPath, [workerPath], {cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']});
  } catch { return failure('SPAWN_FAILED'); }
  return new Promise(resolve => {
    let receipt, reason, outputBytes = 0, ended = false, termination, timeout, closeTimer;
    const stdout = [], stderr = [];
    const abort = () => stop('ABORTED');
    const terminate = () => {
      if (termination || !worker.pid) return;
      // Keep the worker alive until its receipt is received, so taskkill never loses its tree root.
      if (process.platform === 'win32') {
        termination = new Promise(done => {
          const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
          const killer = spawn(executable, ['/PID', String(worker.pid), '/T', '/F'], {shell: false, windowsHide: true, stdio: 'ignore', timeout: 5000});
          killer.once('error', () => { try { worker.kill(); } catch {} done(false); });
          killer.once('close', code => { if (code !== 0) { try { worker.kill(); } catch {} } done(code === 0); });
        });
      } else {
        try { process.kill(-worker.pid, 'SIGKILL'); termination = Promise.resolve(true); }
        catch (error) { termination = Promise.resolve(error.code === 'ESRCH'); }
      }
      closeTimer = setTimeout(() => {
        try { worker.kill('SIGKILL'); } catch {}
        worker.stdin.destroy(); worker.stdout.destroy(); worker.stderr.destroy();
        finish(true);
      }, 5500);
    };
    function stop(error) {
      if (ended) return;
      reason ??= error;
      terminate();
    }
    async function finish(forced = false) {
      if (ended) return;
      ended = true;
      clearTimeout(timeout); clearTimeout(closeTimer);
      signal?.removeEventListener('abort', abort);
      const terminated = termination ? await termination : !worker.pid;
      const diagnostics = Buffer.concat(stderr).toString('utf8');
      if (forced || !terminated) reason ??= 'PROCESS_TREE_TERMINATION_FAILED';
      if (!receipt) reason ??= 'INVALID_WORKER_RESULT';
      const result = reason ? failure(reason, diagnostics) : {...receipt, elapsedMs: Date.now() - start};
      if (forced || !terminated) result.terminationError = 'Worker process-tree termination could not be confirmed';
      resolve(result);
    }
    const record = (chunk, isStdout) => {
      if (ended) return;
      if (outputBytes + chunk.length > MAX_OUTPUT_BYTES) return stop('OUTPUT_LIMIT');
      outputBytes += chunk.length;
      (isStdout ? stdout : stderr).push(chunk);
      if (!isStdout || reason) return;
      if (receipt) return stop('INVALID_WORKER_RESULT');
      if (!chunk.includes(10)) return; // JSON strings escape newlines; concatenate only at the terminator.
      const bytes = Buffer.concat(stdout);
      const newline = bytes.indexOf(10);
      try {
        if (newline !== bytes.length - 1) throw Error('Extra worker output');
        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes.subarray(0, newline)));
        if (!value || value.command !== check.command || JSON.stringify(value.args) !== JSON.stringify(check.args) || !(value.exitCode === null || Number.isInteger(value.exitCode)) || typeof value.stdout !== 'string' || typeof value.stderr !== 'string' || !(value.error === null || typeof value.error === 'string') || !Number.isFinite(value.elapsedMs)) throw Error('Invalid receipt');
        receipt = value;
        clearTimeout(timeout);
        terminate();
      } catch { stop('INVALID_WORKER_RESULT'); }
    };
    worker.stdout.on('data', chunk => record(chunk, true));
    worker.stderr.on('data', chunk => record(chunk, false));
    worker.stdout.once('error', () => stop('STDOUT_FAILED'));
    worker.stderr.once('error', () => stop('STDERR_FAILED'));
    worker.stdin.once('error', () => stop('STDIN_FAILED'));
    worker.once('error', () => { reason ??= 'SPAWN_FAILED'; });
    worker.once('close', () => finish());
    signal?.addEventListener('abort', abort, {once: true});
    timeout = setTimeout(() => stop('TIMEOUT'), Math.max(1, timeoutMs - (Date.now() - start)));
    if (signal?.aborted) abort();
    if (!reason) worker.stdin.end(input);
  });
}
