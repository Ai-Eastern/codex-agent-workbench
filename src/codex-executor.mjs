import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const PARENT_CONTEXT_KEYS = new Set(['CODEX_THREAD_ID', 'CODEX_TURN_ID', 'CODEX_TASK_ID', 'CODEX_PARENT_THREAD_ID', 'CODEX_AGENT_ID', 'CODEX_SESSION_ID', 'CODEX_APP_TOOLS_PIPE_PATH', 'CODEX_WORKBENCH_CHECK']);
const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// Resolve known npm shims without executing batch/PowerShell code or reading auth/config.
export function resolveCodexExecutable(executable = 'codex', { platform = process.platform, arch = process.arch, envPath = process.env.PATH ?? '', cwd = process.cwd() } = {}) {
  if (typeof executable !== 'string' || !executable || executable.includes('\0')) throw new TypeError('Invalid Codex executable');
  if (platform !== 'win32') return /[\/\\]/.test(executable) ? path.resolve(cwd, executable) : executable;
  const explicit = path.isAbsolute(executable) || /[\/\\]/.test(executable);
  const candidates = explicit ? [path.resolve(cwd, executable)] : envPath.split(path.delimiter)
    .map((entry) => entry.replace(/^"|"$/g, ''))
    .filter((entry) => path.isAbsolute(entry))
    .flatMap((entry) => path.extname(executable) ? [path.join(entry, executable)] : ['.exe', '.cmd', '.ps1'].map((ext) => path.join(entry, executable + ext)));
  for (const candidate of candidates) {
    if (!isFile(candidate)) continue;
    if (/\.exe$/i.test(candidate)) return candidate;
    if (!/\.cmd$|\.ps1$/i.test(candidate) || fs.statSync(candidate).size > 64 * 1024) continue;
    const shim = fs.readFileSync(candidate, 'utf8');
    const direct = shim.match(/^\s*@echo off\s*\r?\n"([^"\r\n]+[\\/]codex\.exe)"\s+%\*\s*$/i);
    if (direct && path.isAbsolute(direct[1]) && /[\\/]node_modules[\\/]@openai[\\/]codex[\\/]/i.test(direct[1]) && isFile(direct[1])) return direct[1];
    let packageRoot;
    if (/node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(shim)) packageRoot = path.join(path.dirname(candidate), 'node_modules', '@openai', 'codex');
    else if (/\.\.[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/i.test(shim)) packageRoot = path.resolve(path.dirname(candidate), '..', '@openai', 'codex');
    if (!packageRoot || !['x64', 'arm64'].includes(arch)) continue;
    const target = `${arch === 'x64' ? 'x86_64' : 'aarch64'}-pc-windows-msvc`;
    const packages = [packageRoot, path.join(path.dirname(packageRoot), `codex-win32-${arch}`), path.join(packageRoot, 'node_modules', '@openai', `codex-win32-${arch}`)];
    const binary = packages.flatMap((root) => ['codex', 'bin'].map((folder) => path.join(root, 'vendor', target, folder, 'codex.exe'))).find(isFile);
    if (binary) return binary;
  }
  const error = new Error('Codex native executable not found; provide executable with the path to codex.exe');
  error.code = 'CODEX_EXECUTABLE_NOT_FOUND';
  throw error;
}

/**
 * Run one new, ephemeral Codex CLI turn. Completion is execution evidence, not acceptance.
 * onEvent is a synchronous observer. command is a test seam; it still uses argv + stdin.
 * Raw logs can contain source, prompts and tool output; the caller owns publication/redaction.
 * Supported CLI contract: https://developers.openai.com/codex/noninteractive
 */
export async function runCodex({ cwd, prompt, outputDirectory, model, reasoning, executable, timeoutMs = DEFAULT_TIMEOUT_MS, signal, onEvent, command } = {}) {
  for (const [name, value] of Object.entries({ cwd, outputDirectory })) {
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new TypeError(`Invalid ${name}`);
  }
  if (typeof prompt !== 'string' || !prompt.trim()) throw new TypeError('A nonempty prompt is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2 ** 31 - 1) throw new TypeError('Invalid timeoutMs');
  if (model !== undefined && (typeof model !== 'string' || !model || /[\r\n\0]/.test(model))) throw new TypeError('Invalid model');
  if (reasoning !== undefined && (typeof reasoning !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(reasoning))) throw new TypeError('Invalid reasoning');
  if (onEvent !== undefined && typeof onEvent !== 'function') throw new TypeError('Invalid onEvent');
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new TypeError('Invalid signal');
  if (command && (typeof command.file !== 'string' || !command.file || command.file.includes('\0') || !Array.isArray(command.args) || command.args.some((arg) => typeof arg !== 'string' || arg.includes('\0')))) throw new TypeError('Invalid command');
  if (command && executable) throw new TypeError('Provide command or executable, not both');
  const directory = path.resolve(outputDirectory);
  const eventsPath = path.join(directory, 'events.jsonl');
  const stderrPath = path.join(directory, 'stderr.log');
  const summaryPath = path.join(directory, 'last-message.txt');
  const result = { status: 'failed', threadId: null, usage: null, summary: '', exitCode: null, eventsPath, stderrPath };
  const handles = [];
  let eventsFd, stderrFd;
  try {
    fs.mkdirSync(directory, { recursive: true });
    eventsFd = fs.openSync(eventsPath, 'wx', 0o600); handles.push(eventsFd);
    stderrFd = fs.openSync(stderrPath, 'wx', 0o600); handles.push(stderrFd);
    const summaryFd = fs.openSync(summaryPath, 'wx', 0o600); fs.closeSync(summaryFd);
  } catch {
    handles.forEach((fd) => fs.closeSync(fd));
    return { ...result, reason: 'OUTPUT_DIRECTORY_UNAVAILABLE_OR_USED' };
  }
  try {
    if (signal?.aborted) return { ...result, status: 'interrupted', reason: 'ABORTED' };
    let file;
    try { file = command?.file ?? resolveCodexExecutable(executable, { cwd }); }
    catch { return { ...result, reason: 'CODEX_EXECUTABLE_NOT_FOUND' }; }
    const args = [...(command?.args ?? []), 'exec', '--json', '--sandbox', 'workspace-write', '--ephemeral', '-C', path.resolve(cwd), '--output-last-message', summaryPath];
    if (model !== undefined) args.push('-m', model);
    if (reasoning !== undefined) args.push('-c', `model_reasoning_effort=${JSON.stringify(reasoning)}`);
    args.push('-');
    // A new task keeps normal CLI/auth configuration, but cannot inherit its parent's
    // task identity, Desktop tool pipe, acceptance context or Git repository overrides.
    const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PARENT_CONTEXT_KEYS.has(key.toUpperCase()) && !key.toUpperCase().startsWith('GIT_')));
    let child;
    try { child = spawn(file, args, { cwd: path.resolve(cwd), env: childEnv, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return { ...result, reason: 'SPAWN_FAILED' }; }
    let reason, interrupted = false, completed = false, events = 0, outputBytes = 0, pending = '', closed = false, terminationStarted = false;
    let forceTimer, closeTimer, timeout;
    const decoder = new TextDecoder('utf-8', { fatal: true });

    const stop = (failure, interruption = false) => {
      if (closed) return;
      if (!reason) { reason = failure; interrupted = interruption; }
      if (terminationStarted || !child.pid) return;
      terminationStarted = true;
      if (process.platform === 'win32') {
        // This exact child PID is the only termination root. Never kill by image name.
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
        killer.once('error', () => { try { child.kill(); } catch {} });
        killer.once('exit', (code) => { if (code !== 0) { try { child.kill(); } catch {} } });
      } else {
        try { process.kill(-child.pid, 'SIGTERM'); } catch {}
        forceTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 300);
      }
      // Bound the wait even when inherited handles remain open or OS termination fails.
      closeTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
      }, 5000);
    };

    function parseLine(line) {
      if (reason) return;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES) return stop('EVENT_LINE_LIMIT');
      let event;
      try { event = JSON.parse(line); }
      catch { return stop('INVALID_JSONL'); }
      if (!event || Array.isArray(event) || typeof event !== 'object' || typeof event.type !== 'string' || !event.type) return stop('INVALID_EVENT');
      events++;
      if (event.type === 'thread.started') {
        if (typeof event.thread_id !== 'string' || !event.thread_id || (result.threadId && result.threadId !== event.thread_id)) return stop('INVALID_THREAD_EVENT');
        result.threadId = event.thread_id;
      }
      if (event.type === 'turn.completed') {
        completed = true;
        result.usage = event.usage ?? null;
      }
      try {
        const callbackResult = onEvent?.(event);
        if (callbackResult && typeof callbackResult.then === 'function') {
          Promise.resolve(callbackResult).catch(() => {});
          stop('ASYNC_EVENT_CALLBACK_UNSUPPORTED');
        }
      } catch { stop('EVENT_CALLBACK_FAILED'); }
      if (event.type === 'turn.failed' || event.type === 'error') stop('CODEX_ERROR_EVENT');
    }

    function record(chunk, fd, stdout) {
      if (closed) return;
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - outputBytes);
      const kept = chunk.subarray(0, remaining);
      outputBytes += kept.length;
      try { if (kept.length) fs.writeSync(fd, kept); }
      catch { return stop('LOG_WRITE_FAILED'); }
      if (kept.length !== chunk.length) return stop('OUTPUT_LIMIT');
      if (!stdout || reason) return;
      try { pending += decoder.decode(kept, { stream: true }); }
      catch { return stop('INVALID_UTF8'); }
      let newline;
      while (!reason && (newline = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, newline).replace(/\r$/, '');
        pending = pending.slice(newline + 1);
        parseLine(line);
      }
      if (Buffer.byteLength(pending) > MAX_LINE_BYTES) stop('EVENT_LINE_LIMIT');
    }

    await new Promise((resolve) => {
      child.stdout.on('data', (chunk) => record(chunk, eventsFd, true));
      child.stderr.on('data', (chunk) => record(chunk, stderrFd, false));
      child.stdout.once('error', () => stop('STDOUT_FAILED'));
      child.stderr.once('error', () => stop('STDERR_FAILED'));
      child.stdin.once('error', () => stop('STDIN_FAILED'));
      child.once('error', () => { reason ||= 'SPAWN_FAILED'; });
      const abort = () => stop('ABORTED', true);
      signal?.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => stop('TIMEOUT', true), timeoutMs);
      child.once('close', (code, exitSignal) => {
        closed = true;
        // A parent can exit on SIGTERM while a descendant ignores it. Reap that
        // same process group before clearing the scheduled escalation.
        if (terminationStarted && process.platform !== 'win32') {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        }
        clearTimeout(timeout); clearTimeout(forceTimer); clearTimeout(closeTimer);
        signal?.removeEventListener('abort', abort);
        result.exitCode = code;
        if (!reason) {
          try { pending += decoder.decode(); }
          catch { reason = 'INVALID_UTF8'; }
          if (pending && !reason) reason = 'TRUNCATED_JSONL';
        }
        if (!reason && exitSignal) { reason = 'PROCESS_SIGNAL'; interrupted = true; }
        if (!reason && code !== 0) reason = 'NONZERO_EXIT';
        if (!reason && !events) reason = 'EMPTY_EVENTS';
        if (!reason && !completed) reason = 'NO_COMPLETED_TURN';
        resolve();
      });
      if (signal?.aborted) abort();
      if (!reason) child.stdin.end(prompt);
    });
    try {
      const stat = fs.lstatSync(summaryPath);
      if (!stat.isFile() || stat.isSymbolicLink()) reason ||= 'INVALID_SUMMARY_FILE';
      else if (stat.size > MAX_SUMMARY_BYTES) reason ||= 'SUMMARY_LIMIT';
      else result.summary = fs.readFileSync(summaryPath, 'utf8');
    } catch { reason ||= 'SUMMARY_READ_FAILED'; }
    return { ...result, status: reason ? (interrupted ? 'interrupted' : 'failed') : 'completed', ...(reason ? { reason } : {}) };
  } finally {
    handles.forEach((fd) => fs.closeSync(fd));
  }
}
