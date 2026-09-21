import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configFrom, digest, readJson, safePath, writeJson, validateRequest } from './contracts.mjs';
import { begin, advance, getPacket, submitResult, status, delivery, repairTask } from './workflow.mjs';
import { createWorkspace, inspectWorkspace, exportPatch } from './git-workspace.mjs';
import { runCodex } from './codex-executor.mjs';
import { runLocalCheck } from './local-check.mjs';

function paths(stateRoot, id) {
  if (!path.isAbsolute(stateRoot)) throw Error('An absolute state directory is required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id ?? '')) throw Error('A stable task id is required');
  const root = safePath(stateRoot, `runs/${id}`);
  return { root, manifest: safePath(root, 'run.json'), config: safePath(root, 'project.json'), lock: safePath(root, 'execution.lock') };
}

function contract(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('A task request object is required');
  const allowed = ['id', 'objective', 'files', 'deletedFiles', 'checks', 'acceptanceFiles', 'knowledgeFiles', 'constraints', 'model', 'reasoning', 'timeoutMs'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw Error(`Unknown request field; allowed: ${allowed.join(', ')}`);
  const request = structuredClone(input);
  if (typeof request.objective !== 'string' || !request.objective.trim()) throw Error('Task objective is required');
  for (const key of ['files', 'acceptanceFiles', 'knowledgeFiles']) {
    request[key] ??= [];
    if (!Array.isArray(request[key]) || request[key].some(file => typeof file !== 'string')) throw Error(`${key} must be an array of relative paths`);
  }
  if (!request.files.length || !Array.isArray(request.checks) || !request.checks.length) throw Error('Exact writable files and at least one acceptance command are required');
  if (request.acceptanceFiles.some(file => request.files.includes(file))) throw Error('Acceptance files cannot be writable task files');
  request.timeoutMs ??= 600000;
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > 3600000) throw Error('timeoutMs must be between 100 and 3600000');
  return request;
}

const taskContract = request => ({
  id: request.id, objective: request.objective, mode: 'direct', reason: 'A bounded local Codex task in an isolated Git worktree.',
  constraints: request.constraints ?? [],
  tasks: [{ id: 'implementation', objective: request.objective, files: request.files,
    ...(request.deletedFiles ? { deletedFiles: request.deletedFiles } : {}) }],
  checks: request.checks,
});

function event(file, type, data = {}) {
  fs.appendFileSync(path.join(path.dirname(file), 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), type, ...data }) + '\n');
}
function save(file, record, phase, data = {}) {
  Object.assign(record, data, { phase, updatedAt: new Date().toISOString() });
  writeJson(file, record);
  event(file, phase, { attempt: record.attemptId ?? null });
}
function lockRun(files) {
  const fd = fs.openSync(files.lock, 'wx');
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  return () => { fs.closeSync(fd); fs.unlinkSync(files.lock); };
}
function protectedHashes(cfg, request) {
  return Object.fromEntries(request.acceptanceFiles.map(file => [file, digest(fs.readFileSync(safePath(cfg.workRoot, file)))]));
}
function inspect(record, cfg) {
  if (digest(protectedHashes(cfg, record.request)) !== digest(record.acceptanceFiles)) throw Error('Frozen acceptance files changed');
  const result = inspectWorkspace({ ...record.workspace, allowedFiles: record.request.files });
  if (result.unexpectedFiles.length || result.headChanged || result.sourceHeadChanged) throw Error(`Workspace review failed: ${JSON.stringify(result)}`);
  return result;
}

/** The process owns orchestration; the coding executor never submits its own acceptance result. */
export async function runLocalTask({ repository, stateRoot, request: input, ref = 'HEAD', executable, signal, onEvent, executor = runCodex }) {
  const request = contract(input), files = paths(stateRoot, request.id);
  const repositoryPath = path.resolve(repository);
  const relativeState = path.relative(repositoryPath, stateRoot);
  if (!relativeState || (!relativeState.startsWith('..' + path.sep) && relativeState !== '..' && !path.isAbsolute(relativeState))) throw Error('Keep the state directory outside the source repository');
  if (fs.existsSync(files.manifest)) {
    const prior = readJson(files.manifest);
    if (prior.requestHash !== digest(request) || prior.repository !== repositoryPath || prior.ref !== ref) throw Error('Task id already belongs to a different repository or contract');
    return { ...readLocalTask({ stateRoot, id: request.id }), reused: true };
  }
  fs.mkdirSync(path.dirname(files.root), { recursive: true });
  fs.mkdirSync(files.root); // One durable run reservation; never overwrite an interrupted creation.
  const release = lockRun(files);
  const record = { schemaVersion: 1, id: request.id, repository: repositoryPath, ref, request, requestHash: digest(request), createdAt: new Date().toISOString(), phase: 'PREPARING' };
  try {
    writeJson(files.manifest, record);
    const config = {
      executionHost: 'local', projectId: `local-${digest(repositoryPath).slice(0, 16)}`,
      projectRoot: files.root, controlRoot: path.join(files.root, 'control'),
      workRoot: path.join(files.root, 'worktree'), vaultRoot: path.join(files.root, 'knowledge'),
      maxWorkers: 1, workerThreads: {}, captureEnabled: false,
      model: request.model ?? null, thinking: request.reasoning ?? null,
    };
    writeJson(files.config, config);
    const cfg = configFrom(files.config);
    validateRequest(taskContract(request), cfg);
    for (const file of [...request.acceptanceFiles, ...request.knowledgeFiles]) safePath(cfg.workRoot, file);
    record.workspace = createWorkspace({ repository: repositoryPath, directory: cfg.workRoot, ref });
    fs.mkdirSync(cfg.vaultRoot, { recursive: true });
    for (const [index, file] of request.knowledgeFiles.entries()) {
      if (!file.toLowerCase().endsWith('.md')) throw Error('Knowledge files must be explicitly selected Markdown files');
      fs.copyFileSync(safePath(cfg.workRoot, file), path.join(cfg.vaultRoot, `${index}-${path.basename(file)}`));
    }
    record.acceptanceFiles = protectedHashes(cfg, request);
    await begin(cfg, taskContract(request));
    save(files.manifest, record, 'PREPARED');
    await executeAttempt(files, record, cfg, { executor, executable, signal, onEvent });
  } catch (error) {
    if (record.phase !== 'BLOCKED') save(files.manifest, record, 'BLOCKED', { error: error.message });
    throw error;
  } finally { release(); }
  return readLocalTask({ stateRoot, id: request.id });
}

async function executeAttempt(files, record, cfg, options) {
  const packet = getPacket(cfg, record.id, 'implementation');
  const outputDirectory = path.join(files.root, 'attempts', packet.attemptId);
  save(files.manifest, record, 'EXECUTING', { attemptId: packet.attemptId, outputDirectory });
  options.onEvent?.({ type: 'workbench.executing', runId: record.id, attemptId: packet.attemptId });
  const result = await options.executor({ cwd: cfg.workRoot, prompt: packet.prompt, outputDirectory,
    model: cfg.model ?? undefined, reasoning: cfg.thinking ?? undefined,
    executable: options.executable, timeoutMs: record.request.timeoutMs, signal: options.signal, onEvent: options.onEvent });
  const resultPath = path.join(files.root, `executor-${packet.attemptId}.json`);
  writeJson(resultPath, result);
  save(files.manifest, record, result.status === 'completed' ? 'EXECUTED' : 'BLOCKED', { executorResult: resultPath, executorResultHash: digest(fs.readFileSync(resultPath)), execution: result });
  if (result.status === 'completed') await acceptResult(files, record, cfg, options.onEvent, options.signal);
}

async function acceptResult(files, record, cfg, onEvent, signal) {
  inspect(record, cfg);
  const result = readJson(record.executorResult);
  if (digest(fs.readFileSync(record.executorResult)) !== record.executorResultHash || result.status !== 'completed') throw Error('Executor result evidence changed or is not complete');
  const packet = getPacket(cfg, record.id, 'implementation');
  try {
    // Continue after a submitted result without rewriting it or launching the executor again.
    if (!fs.existsSync(packet.receiptPath)) {
      submitResult(cfg, record.id, packet.taskId, { expectedAttemptId: packet.attemptId, summary: result.summary?.trim().slice(0, 4000) || 'Codex execution completed; independent acceptance follows.' });
    }
    save(files.manifest, record, 'ACCEPTING');
    let interrupted = false;
    const outcome = await advance(cfg, record.id, { commandRunner: async (check, cwd, context) => {
      inspect(record, cfg);
      onEvent?.({ type: 'workbench.check.started', id: check.id });
      const checked = await runLocalCheck(check, cwd, context, { signal });
      if (checked.exitCode === null) interrupted = true;
      inspect(record, cfg);
      onEvent?.({ type: 'workbench.check.completed', id: check.id, exitCode: checked.exitCode });
      return checked;
    } });
    if (outcome.status !== 'COMPLETE') {
      save(files.manifest, record, outcome.status === 'FAILED' && !interrupted ? 'FAILED_ACCEPTANCE' : 'BLOCKED', { acceptance: outcome.acceptance });
      return;
    }
    inspect(record, cfg);
    const receipt = delivery(cfg, record.id);
    const patchPath = path.join(files.root, 'candidate.patch');
    let patch = record.patch;
    if (!fs.existsSync(patchPath)) patch = exportPatch({ ...record.workspace, allowedFiles: record.request.files, outputPath: patchPath });
    else if (!patch) {
      // A crash can leave a valid patch before the manifest is updated. Recompute
      // and compare it; never bless an unbound file merely because it exists.
      const recovered = exportPatch({ ...record.workspace, allowedFiles: record.request.files, outputPath: path.join(files.root, 'recovery-patches', `${randomUUID()}.patch`) });
      if (digest(fs.readFileSync(patchPath)) !== recovered.sha256) throw Error('Unbound candidate patch does not match accepted artifacts');
      patch = { ...recovered, path: patchPath };
    }
    if (!patch || digest(fs.readFileSync(patchPath)) !== patch.sha256) throw Error('Candidate patch changed');
    save(files.manifest, record, 'READY_FOR_REVIEW', { patch: { ...patch, path: patchPath }, delivery: receipt, acceptance: outcome.acceptance });
    onEvent?.({ type: 'workbench.ready', runId: record.id, patchPath });
  } catch (error) {
    save(files.manifest, record, 'BLOCKED', { error: error.message });
    throw error;
  }
}

export function readLocalTask({ stateRoot, id }) {
  const files = paths(stateRoot, id), record = readJson(files.manifest);
  let controller;
  if (record.workspace && fs.existsSync(files.config)) {
    const cfg = configFrom(files.config);
    try {
      controller = status(cfg, id);
      if (record.phase === 'READY_FOR_REVIEW') {
        inspect(record, cfg); delivery(cfg, id);
        if (digest(fs.readFileSync(record.patch.path)) !== record.patch.sha256) throw Error('Candidate patch changed');
      }
    } catch (error) {
      return { ...record, phase: 'EVIDENCE_CHANGED', evidenceError: error.message, controller };
    }
  }
  return { ...record, controller, locked: fs.existsSync(files.lock), runDirectory: files.root };
}

export function listLocalTasks({ stateRoot }) {
  const directory = path.join(stateRoot, 'runs');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory() && fs.existsSync(path.join(directory, item.name, 'run.json'))).map(item => readLocalTask({ stateRoot, id: item.name }));
}

export async function continueLocalTask({ stateRoot, id, onEvent, signal }) {
  const files = paths(stateRoot, id), release = lockRun(files);
  let reused = false;
  try {
    const record = readJson(files.manifest), cfg = configFrom(files.config);
    if (record.phase === 'READY_FOR_REVIEW') reused = true;
    else {
      if (!['EXECUTED', 'ACCEPTING'].includes(record.phase)) throw Error(`Cannot continue ${record.phase}; preserve this run and inspect it before any new execution`);
      await acceptResult(files, record, cfg, onEvent, signal);
    }
  } finally { release(); }
  return { ...readLocalTask({ stateRoot, id }), ...(reused ? { reused: true } : {}) };
}

export async function repairLocalTask({ stateRoot, id, reason, executor = runCodex, executable, signal, onEvent }) {
  if (typeof reason !== 'string' || !reason.trim()) throw Error('An explicit repair reason is required');
  const files = paths(stateRoot, id), release = lockRun(files);
  let record, repaired = false;
  try {
    record = readJson(files.manifest);
    const cfg = configFrom(files.config);
    if (record.phase !== 'FAILED_ACCEPTANCE') throw Error('Only a confirmed acceptance failure can authorize a repair');
    inspect(record, cfg);
    repairTask(cfg, id, 'implementation', { expectedAcceptanceHash: record.acceptance.hash, reason });
    repaired = true;
    await advance(cfg, id);
    event(files.manifest, 'REPAIR_AUTHORIZED', { reason });
    await executeAttempt(files, record, cfg, { executor, executable, signal, onEvent });
  } catch (error) {
    if (repaired && record.phase !== 'BLOCKED') save(files.manifest, record, 'BLOCKED', { error: error.message });
    throw error;
  } finally { release(); }
  return readLocalTask({ stateRoot, id });
}

export function createTaskId() { return `task-${Date.now()}-${randomUUID().slice(0, 8)}`; }
