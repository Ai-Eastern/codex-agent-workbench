import fs from 'node:fs';
import path from 'node:path';
import {SqliteSaver} from '@langchain/langgraph-checkpoint-sqlite';
import {assertContained, configFrom, digest, projectIdentity, readJson, safePath, validatePortfolio} from './contracts.mjs';
import {activePlan, planRevision, taskDefinitionHash} from './plan.mjs';
import {delivery, openStore} from './workflow.mjs';
import {resolveIdentity} from './handoff.mjs';

const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
const threadId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pathKey = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const overlaps = (a, b) => {
  a = pathKey(a); b = pathKey(b);
  return a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep);
};
const contains = (parent, child) => pathKey(child) === pathKey(parent) || pathKey(child).startsWith(pathKey(parent) + path.sep);
function absolute(value, label) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('PORTFOLIO_INVALID', `Absolute ${label} required`);
  const full = path.resolve(value);
  assertContained(path.parse(full).root, full);
  return full;
}

function validateRegistry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PORTFOLIO_INVALID', 'A private portfolio registry is required');
  const controlRoot = absolute(value.controlRoot, 'portfolio controlRoot');
  if (!threadId.test(value.coordinatorThreadId ?? '')) fail('PORTFOLIO_INVALID', 'A real coordinator task identity is required');
  const manifest = validatePortfolio(value.manifest);
  if (!value.bindings || typeof value.bindings !== 'object' || Array.isArray(value.bindings)) fail('PORTFOLIO_INVALID', 'Project bindings are required');
  const ids = manifest.projects.map(ref => ref.projectId);
  if (Object.keys(value.bindings).length !== ids.length || Object.keys(value.bindings).some(id => !ids.includes(id))) fail('PROJECT_BINDING_CHANGED', 'Bindings must exactly match the portfolio projects');
  const bindings = {}, configs = {}, fingerprints = {};
  const actors = new Set([value.coordinatorThreadId.toLowerCase()]);
  const roots = [{name: 'portfolio controlRoot', value: controlRoot}];
  const projects = [];
  for (const id of ids) {
    const file = absolute(value.bindings[id], 'project configuration path');
    const cfg = configFrom(file, {requireExplicitModel: true});
    if (cfg.projectId !== id) fail('PROJECT_BINDING_CHANGED', 'Configuration projectId does not match its binding');
    if (!fs.statSync(cfg.projectRoot).isDirectory()) fail('PROJECT_BINDING_CHANGED', 'Project root must be a directory');
    if (overlaps(controlRoot, cfg.projectRoot) || projects.some(root => overlaps(root, cfg.projectRoot))) fail('PROJECT_ROOT_OVERLAP', 'Portfolio storage and project roots must be independent');
    projects.push(cfg.projectRoot);
    for (const actor of [cfg.pmThreadId, ...Object.values(cfg.workerThreads)]) {
      if (!threadId.test(actor) || actors.has(actor.toLowerCase())) fail('PROJECT_ACTOR_OVERLAP', 'Coordinator, project owners and workers must have distinct identities');
      actors.add(actor.toLowerCase());
    }
    if (overlaps(cfg.controlRoot, cfg.vaultRoot) || contains(cfg.controlRoot, cfg.workRoot) || contains(cfg.vaultRoot, cfg.workRoot)) fail('PROJECT_ROOT_OVERLAP', 'Control and knowledge roots must be independent and cannot contain the working root');
    for (const name of ['workRoot', 'controlRoot', 'vaultRoot']) {
      const root = cfg[name];
      if (roots.some(previous => previous.projectId !== id && overlaps(previous.value, root))) fail('PROJECT_ROOT_OVERLAP', 'Storage roots cannot cross project boundaries');
      roots.push({name, value: root, projectId: id});
    }
    bindings[id] = file; configs[id] = cfg;
    fingerprints[id] = {file, configHash: digest(fs.readFileSync(file)), identity: projectIdentity(cfg)};
  }
  // An external vault must not sit inside another project's source tree either.
  for (const [id, cfg] of Object.entries(configs)) for (const [otherId, other] of Object.entries(configs)) {
    if (id !== otherId && ['workRoot', 'controlRoot', 'vaultRoot'].some(name => overlaps(cfg[name], other.projectRoot))) fail('PROJECT_ROOT_OVERLAP', 'Project storage crosses another project root');
  }
  const registry = {controlRoot, coordinatorThreadId: value.coordinatorThreadId, manifest, bindings};
  return {registry, configs, registryHash: digest({...registry, fingerprints})};
}

export function loadPortfolioRegistry(file) {
  const absoluteFile = absolute(file, 'registry path');
  const {registry} = validateRegistry(readJson(absoluteFile));
  Object.defineProperty(registry, 'registryFile', {value: absoluteFile});
  return registry;
}

function checked(input) {
  if (typeof input === 'string') return validateRegistry(readJson(absolute(input, 'registry path')));
  if (input?.registryFile) return validateRegistry(readJson(absolute(input.registryFile, 'registry path')));
  return validateRegistry(input);
}
function requireActor(registry, cfg) {
  const actual = process.env.CODEX_THREAD_ID;
  if (!actual || (actual !== registry.coordinatorThreadId && actual !== cfg?.pmThreadId)) fail('ACTOR_MISMATCH', 'Only the coordinator or the selected project owner may use this route');
}
function openPortfolio(registry, create = false) {
  const file = safePath(registry.controlRoot, 'portfolio.sqlite');
  for (const suffix of ['-wal', '-shm', '-journal']) safePath(registry.controlRoot, `portfolio.sqlite${suffix}`);
  if (!create && !fs.existsSync(file)) fail('PORTFOLIO_NOT_REGISTERED', 'Register this portfolio before routing projects');
  if (create) fs.mkdirSync(registry.controlRoot, {recursive: true});
  const saver = SqliteSaver.fromConnString(file), db = saver.db;
  db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000');
  if (create) db.exec(`CREATE TABLE IF NOT EXISTS portfolio_registration(id INTEGER PRIMARY KEY CHECK(id=1), portfolio_id TEXT NOT NULL, registry_hash TEXT NOT NULL, manifest TEXT NOT NULL, registered_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS project_snapshots(project_id TEXT PRIMARY KEY, hash TEXT NOT NULL, summary TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS portfolio_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, kind TEXT NOT NULL, summary TEXT NOT NULL, at INTEGER NOT NULL);`);
  db.exec(`CREATE TABLE IF NOT EXISTS portfolio_revisions(revision INTEGER PRIMARY KEY, registry TEXT NOT NULL, registry_hash TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS portfolio_runtime(id INTEGER PRIMARY KEY CHECK(id=1), paused INTEGER NOT NULL DEFAULT 0, grant_sequence INTEGER NOT NULL DEFAULT 0);
    INSERT OR IGNORE INTO portfolio_runtime(id) VALUES(1);
    CREATE TABLE IF NOT EXISTS project_resources(project_id TEXT PRIMARY KEY, paused INTEGER NOT NULL DEFAULT 0, last_grant INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS worker_reservations(action_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, epoch INTEGER NOT NULL, worker_count INTEGER NOT NULL, mode TEXT NOT NULL, attempts TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, released_at INTEGER, release_evidence TEXT);
    CREATE TABLE IF NOT EXISTS worker_attempts(project_id TEXT NOT NULL, plan_id TEXT NOT NULL, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL, action_id TEXT NOT NULL, PRIMARY KEY(project_id,plan_id,task_id,attempt_id));
    CREATE TABLE IF NOT EXISTS resource_queue(action_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL, worker_count INTEGER NOT NULL, requested_at INTEGER NOT NULL);`);
  return db;
}
function requireRegistration(db, registryHash) {
  const row = db.prepare('SELECT * FROM portfolio_registration WHERE id=1').get();
  if (!row) fail('PORTFOLIO_NOT_REGISTERED', 'Register this portfolio before routing projects');
  if (row.registry_hash !== registryHash) fail('PROJECT_BINDING_CHANGED', 'The registered manifest or project configuration changed; reconcile explicitly');
  return row;
}
const sequence = db => db.prepare('SELECT COALESCE(MAX(sequence),0) AS value FROM portfolio_events').get().value;

export function registerPortfolio(input) {
  const {registry, configs, registryHash} = checked(input);
  requireActor(registry);
  const db = openPortfolio(registry, true);
  try {
    return db.transaction(() => {
      const existing = db.prepare('SELECT * FROM portfolio_registration WHERE id=1').get();
      if (existing) requireRegistration(db, registryHash);
      else db.prepare('INSERT INTO portfolio_registration VALUES(1,?,?,?,?)').run(registry.manifest.portfolioId, registryHash, JSON.stringify(registry.manifest), Date.now());
      db.prepare('INSERT OR IGNORE INTO portfolio_revisions VALUES(?,?,?,?,?)').run(registry.manifest.revision, JSON.stringify(registry), registryHash, 'Initial explicit registration', Date.now());
      bindProjects(registry, configs, db);
      for (const ref of registry.manifest.projects) db.prepare('INSERT OR IGNORE INTO project_resources(project_id) VALUES(?)').run(ref.projectId);
      const projects = registry.manifest.projects.map(({projectId, planId, acceptedPlanRevision, priority}) => ({projectId, planId, acceptedPlanRevision, priority}));
      return {portfolioId: registry.manifest.portfolioId, revision: registry.manifest.revision, coordinatorEpoch: registry.manifest.coordinatorEpoch, manifestHash: digest(registry.manifest), projects, reused: !!existing};
    }).immediate();
  } finally { db.close(); }
}

export function routeProject(input, projectId) {
  const {registry, configs, registryHash} = checked(input);
  if (typeof projectId !== 'string' || !Object.hasOwn(configs, projectId)) fail('PROJECT_NOT_REGISTERED', 'An explicit registered projectId is required');
  requireActor(registry, configs[projectId]);
  const db = openPortfolio(registry);
  try { requireRegistration(db, registryHash); return configs[projectId]; }
  finally { db.close(); }
}

function projectSummary(cfg, ref) {
  const current = activePlan(cfg), store = openStore(cfg);
  try {
    const runs = store.db.prepare('SELECT id,identity,status,pause_requested,acceptance_hash FROM runs ORDER BY created_at,id').all();
    if (runs.some(run => resolveIdentity(store, run.identity) !== projectIdentity(cfg))) fail('PROJECT_BINDING_CHANGED', 'A run belongs to a different project configuration');
    const summary = runs.map(run => {
      const tasks = store.tasks(run.id), taskCounts = {};
      for (const task of tasks) taskCounts[task.status] = (taskCounts[task.status] ?? 0) + 1;
      return {runId: run.id, status: run.pause_requested ? 'PAUSED' : run.status, taskCounts, acceptanceHash: run.acceptance_hash};
    });
    return {projectId: cfg.projectId, planId: current?.plan.planId ?? ref.planId, acceptedPlanRevision: ref.acceptedPlanRevision,
      planRevision: current?.plan.revision ?? null, planHash: current?.planHash ?? null,
      status: !current ? 'PLAN_MISSING' : current.plan.planId !== ref.planId || current.plan.revision < ref.acceptedPlanRevision ? 'INPUT_STALE' : current.plan.revision > ref.acceptedPlanRevision ? 'STALE_OVERVIEW' : 'CURRENT',
      objective: current?.plan.objective.slice(0, 500) ?? null, phaseIds: current?.plan.phases.map(phase => phase.id) ?? [],
      runs: summary, blockers: summary.filter(run => ['BLOCKED', 'FAILED'].includes(run.status)).map(run => ({runId: run.runId, status: run.status}))};
  } finally { store.close(); }
}

export function observeProject(input, projectId) {
  const {registry, configs, registryHash} = checked(input);
  if (typeof projectId !== 'string' || !Object.hasOwn(configs, projectId)) fail('PROJECT_NOT_REGISTERED', 'An explicit registered projectId is required');
  const cfg = configs[projectId]; requireActor(registry, cfg);
  const db = openPortfolio(registry);
  try {
    requireRegistration(db, registryHash);
    return db.transaction(() => {
      const summary = projectSummary(cfg, registry.manifest.projects.find(ref => ref.projectId === projectId)), hash = digest(summary);
      const previous = db.prepare('SELECT * FROM project_snapshots WHERE project_id=?').get(projectId);
      if (previous?.hash === hash) return {portfolioId: registry.manifest.portfolioId, projectId, changed: false, sequence: sequence(db), summary: JSON.parse(previous.summary)};
      const at = Date.now(), value = {...summary, updatedAt: at}, json = JSON.stringify(value);
      db.prepare('INSERT INTO project_snapshots VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET hash=excluded.hash,summary=excluded.summary,updated_at=excluded.updated_at').run(projectId, hash, json, at);
      db.prepare('INSERT INTO portfolio_events(project_id,kind,summary,at) VALUES(?,?,?,?)').run(projectId, 'PROJECT_OBSERVED', json, at);
      return {portfolioId: registry.manifest.portfolioId, projectId, changed: true, sequence: sequence(db), summary: value};
    }).immediate();
  } finally { db.close(); }
}

export function portfolioStatus(input, {afterSequence = 0} = {}) {
  const {registry, registryHash} = checked(input); requireActor(registry);
  const db = openPortfolio(registry);
  try {
    requireRegistration(db, registryHash);
    return db.transaction(() => {
      const latest = sequence(db);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0 || afterSequence > latest) fail('INVALID_EVENT_SEQUENCE', 'afterSequence must refer to the retained portfolio history');
      const events = db.prepare('SELECT sequence,project_id AS projectId,kind,at FROM portfolio_events WHERE sequence>? ORDER BY sequence').all(afterSequence);
      const changedIds = [...new Set(events.map(event => event.projectId))];
      const projects = changedIds.map(id => db.prepare('SELECT summary FROM project_snapshots WHERE project_id=?').get(id)).filter(Boolean).map(row => JSON.parse(row.summary));
      return {portfolioId: registry.manifest.portfolioId, revision: registry.manifest.revision, coordinatorEpoch: registry.manifest.coordinatorEpoch, afterSequence, sequence: latest, events, projects, resources: resourceSummary(db, registry)};
    })();
  } finally { db.close(); }
}

function bindProjects(registry, configs, db) {
  const known = new Set(db.prepare('SELECT registry FROM portfolio_revisions').all().map(row => digest(JSON.parse(row.registry))));
  known.add(digest(registry));
  for (const cfg of Object.values(configs)) {
    const store = openStore(cfg);
    try {
      store.db.exec('CREATE TABLE IF NOT EXISTS portfolio_binding(id INTEGER PRIMARY KEY CHECK(id=1), registry TEXT NOT NULL)');
      const previous = store.db.prepare('SELECT registry FROM portfolio_binding WHERE id=1').get();
      if (previous && !known.has(digest(JSON.parse(previous.registry)))) fail('PROJECT_BINDING_CHANGED', 'Project is bound to another or unrecognized portfolio');
      store.db.prepare('INSERT INTO portfolio_binding VALUES(1,?) ON CONFLICT(id) DO UPDATE SET registry=excluded.registry').run(JSON.stringify(registry));
    } finally { store.close(); }
  }
}
function requireEpoch(registry, expectedEpoch) {
  if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch !== registry.manifest.coordinatorEpoch) fail('OWNER_EPOCH_MISMATCH', 'Read the current coordinator epoch before changing resources');
}
function projectConfig(context, projectId) {
  if (typeof projectId !== 'string' || !Object.hasOwn(context.configs, projectId)) fail('PROJECT_NOT_REGISTERED', 'An explicit registered projectId is required');
  return context.configs[projectId];
}
function requireProjectOwner(cfg) {
  if (process.env.CODEX_THREAD_ID !== cfg.pmThreadId) fail('ACTOR_MISMATCH', 'Worker reservation and dispatch require the real project owner');
  const store = openStore(cfg);
  try { if (resolveIdentity(store, projectIdentity(cfg)) !== projectIdentity(cfg)) fail('ACTOR_MISMATCH', 'This project owner has already handed off its identity'); }
  finally { store.close(); }
}
function checkPause(db, projectId) {
  if (db.prepare('SELECT paused FROM portfolio_runtime WHERE id=1').get().paused) fail('PORTFOLIO_PAUSED', 'The portfolio is paused; no new dispatch is permitted');
  if (db.prepare('SELECT paused FROM project_resources WHERE project_id=?').get(projectId)?.paused) fail('PROJECT_PAUSED', 'The project is paused; no new dispatch is permitted');
}
function resourceEvent(db, projectId, kind, data) {
  db.prepare('INSERT INTO portfolio_events(project_id,kind,summary,at) VALUES(?,?,?,?)').run(projectId ?? '*', kind, JSON.stringify(data), Date.now());
}
function resourceSummary(db, registry) {
  const runtime = db.prepare('SELECT * FROM portfolio_runtime WHERE id=1').get();
  return {maxActiveWorkers: registry.manifest.budget.maxActiveWorkers, heldWorkers: db.prepare("SELECT COALESCE(SUM(worker_count),0) AS n FROM worker_reservations WHERE status='HELD'").get().n,
    paused: !!runtime.paused, projects: db.prepare('SELECT project_id AS projectId,paused,last_grant AS lastGrant FROM project_resources ORDER BY project_id').all().map(row => ({...row, paused: !!row.paused})),
    reservations: db.prepare('SELECT action_id AS actionId,project_id AS projectId,run_id AS runId,epoch,worker_count AS workerCount,status FROM worker_reservations ORDER BY created_at,action_id').all()};
}
function reservationView(row) {
  return {actionId: row.action_id, projectId: row.project_id, runId: row.run_id, epoch: row.epoch, workerCount: row.worker_count, status: row.status};
}
function runFacts(registry, cfg, runId, {current = true, configs} = {}) {
  const store = openStore(cfg);
  try {
    const binding = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio_binding'").get();
    const bound = binding && store.db.prepare('SELECT registry FROM portfolio_binding WHERE id=1').get();
    if (!bound || digest(JSON.parse(bound.registry)) !== digest(registry)) fail('PROJECT_BINDING_CHANGED', 'Project has no current persistent portfolio binding');
    const run = store.run(runId), mapped = store.db.prepare('SELECT * FROM plan_runs WHERE run_id=? AND project_id=?').get(runId, cfg.projectId);
    if (!run || !mapped || resolveIdentity(store, run.identity) !== projectIdentity(cfg)) fail('PROJECT_BINDING_CHANGED', 'A mapped run from this project and owner is required');
    const req = JSON.parse(run.request), tasks = store.tasks(runId), refs = JSON.parse(mapped.task_refs);
    if (digest(req) !== run.digest || digest(JSON.parse(mapped.request)) !== run.digest || !req.planBinding || tasks.length !== req.tasks.length || tasks.length !== refs.length) fail('INPUT_STALE', 'Run mapping no longer matches the frozen task contract');
    const ref = registry.manifest.projects.find(project => project.projectId === cfg.projectId);
    if (current) {
      if (store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plan_retirements'").get() && store.db.prepare('SELECT 1 FROM plan_retirements WHERE run_id=?').get(runId)) fail('RESULT_SUPERSEDED', 'Retired groups cannot obtain a new dispatch permit');
      const active = activePlan(cfg);
      if (!active || active.plan.planId !== ref.planId || active.plan.revision !== ref.acceptedPlanRevision) fail('STALE_OVERVIEW', 'Observe the active project plan and revise the portfolio reference');
      if (req.planBinding.planHash !== active.planHash || req.planBinding.revision !== active.plan.revision) fail('INPUT_STALE', 'This run was prepared against a different active plan');
    }
    const attempts = tasks.map(task => {
      const packet = JSON.parse(task.packet), file = safePath(cfg.controlRoot, `runs/${runId}/packets/${task.task_id}.json`);
      if (packet.projectId !== cfg.projectId || packet.runId !== runId || packet.taskId !== task.task_id || packet.attemptId !== task.attempt || digest(packet.planBinding) !== digest(req.planBinding) || digest(JSON.parse(fs.readFileSync(file, 'utf8'))) !== digest(packet)) fail('INPUT_STALE', 'Frozen task packet or attempt identity changed');
      return {taskId: task.task_id, attemptId: task.attempt, packetHash: digest(packet)};
    });
    const workerCount = tasks.length;
    if (!workerCount || !['direct', 'native', 'langgraph'].includes(req.mode) || (req.mode === 'direct' && workerCount !== 1) || (req.mode === 'native' && workerCount > 3)) fail('CAPABILITY_UNAVAILABLE', 'This release supports one direct worker or at most three native workers per owner');
    const actionId = digest({portfolioId: registry.manifest.portfolioId, projectId: cfg.projectId, runId, attempts});
    if (current) checkCrossDependencies(registry, cfg, req, configs);
    return {actionId, run, req, tasks, attempts, workerCount};
  } finally { store.close(); }
}
function candidateOrder(db, registry, configs) {
  const candidates = [];
  for (const row of db.prepare('SELECT q.*,r.paused,r.last_grant FROM resource_queue q JOIN project_resources r ON r.project_id=q.project_id').all()) {
    if (row.paused) continue;
    const cfg = configs[row.project_id];
    try {
      const facts = runFacts(registry, cfg, row.run_id, {configs});
      if (facts.actionId !== row.action_id || !['PREPARED', 'RUNNING'].includes(facts.run.status) || facts.run.pause_requested || facts.tasks.some(task => !['PENDING', 'ASSIGNED', 'NATIVE_CLAIMED'].includes(task.status))) continue;
      candidates.push({...row, priority: registry.manifest.projects.find(project => project.projectId === row.project_id).priority});
    } catch { /* Stale input cannot take another project's dispatch turn. */ }
  }
  candidates.sort((a, b) => a.last_grant - b.last_grant || a.requested_at - b.requested_at || b.priority - a.priority || a.project_id.localeCompare(b.project_id));
  return candidates;
}

export function reserveWorkers(input, {projectId, runId, expectedEpoch} = {}) {
  const context = checked(input), {registry, registryHash, configs} = context, cfg = projectConfig(context, projectId);
  requireProjectOwner(cfg); requireEpoch(registry, expectedEpoch);
  const db = openPortfolio(registry);
  try {
    requireRegistration(db, registryHash);
    return db.transaction(() => {
      checkPause(db, projectId);
      const facts = runFacts(registry, cfg, runId, {configs}), existing = db.prepare('SELECT * FROM worker_reservations WHERE action_id=?').get(facts.actionId);
      if (existing) {
        if (existing.epoch !== expectedEpoch) fail('OWNER_EPOCH_MISMATCH', 'The existing reservation belongs to an older owner epoch');
        if (facts.run.status === 'BLOCKED' || facts.tasks.some(task => task.status === 'RESERVED')) fail('DISPATCH_UNKNOWN', 'Delivery remains unresolved; the original reservation is retained');
        if (existing.status === 'HELD' && !['PREPARED', 'RUNNING', 'COMPLETE'].includes(facts.run.status)) fail('RECONCILE_REQUIRED', 'Failed or incomplete acceptance retains its reservation until reconciled');
        return {status: existing.status === 'HELD' ? 'RESERVED' : 'RELEASED', reused: true, reservation: reservationView(existing), candidateOrder: []};
      }
      if (db.prepare("SELECT 1 FROM worker_reservations WHERE project_id=? AND run_id=? AND status='HELD'").get(projectId, runId)) fail('RECONCILE_REQUIRED', 'A prior attempt still holds this run capacity');
      if (!['PREPARED', 'RUNNING'].includes(facts.run.status) || facts.run.pause_requested || facts.tasks.some(task => !['PENDING', 'ASSIGNED', 'NATIVE_CLAIMED'].includes(task.status))) fail('RECONCILE_REQUIRED', 'Only an undispatched ready group can reserve new capacity');
      for (const attempt of facts.attempts) {
        const used = db.prepare('SELECT COUNT(*) AS n FROM worker_attempts WHERE project_id=? AND plan_id=? AND task_id=?').get(projectId, facts.req.planBinding.planId, attempt.taskId).n;
        if (used >= registry.manifest.budget.maxAttemptsPerTask) fail('ATTEMPT_BUDGET_EXHAUSTED', 'The task attempt budget is exhausted');
      }
      db.prepare('INSERT OR IGNORE INTO resource_queue VALUES(?,?,?,?,?)').run(facts.actionId, projectId, runId, facts.workerCount, Date.now());
      const candidates = candidateOrder(db, registry, configs), order = candidates.map(row => ({projectId: row.project_id, runId: row.run_id, workerCount: row.worker_count}));
      const held = resourceSummary(db, registry).heldWorkers, available = registry.manifest.budget.maxActiveWorkers - held;
      const nativeHeld = db.prepare("SELECT COALESCE(SUM(worker_count),0) AS n FROM worker_reservations WHERE project_id=? AND mode='native' AND status='HELD'").get(projectId).n;
      const eligible = candidates.filter(row => row.worker_count <= available).filter(row => {
        const candidate = runFacts(registry, configs[row.project_id], row.run_id, {configs});
        const used = db.prepare("SELECT COALESCE(SUM(worker_count),0) AS n FROM worker_reservations WHERE project_id=? AND mode='native' AND status='HELD'").get(row.project_id).n;
        return candidate.req.mode !== 'native' || used + row.worker_count <= 3;
      });
      if (facts.workerCount > available || (facts.req.mode === 'native' && nativeHeld + facts.workerCount > 3) || eligible[0]?.action_id !== facts.actionId) return {status: 'WAITING', reused: false, reason: 'RESOURCE_UNAVAILABLE', candidateOrder: order};
      db.prepare("INSERT INTO worker_reservations VALUES(?,?,?,?,?,?,?,'HELD',?,NULL,NULL)").run(facts.actionId, projectId, runId, expectedEpoch, facts.workerCount, facts.req.mode, JSON.stringify(facts.attempts), Date.now());
      for (const attempt of facts.attempts) db.prepare('INSERT INTO worker_attempts VALUES(?,?,?,?,?)').run(projectId, facts.req.planBinding.planId, attempt.taskId, attempt.attemptId, facts.actionId);
      db.prepare('DELETE FROM resource_queue WHERE action_id=?').run(facts.actionId);
      db.prepare('UPDATE portfolio_runtime SET grant_sequence=grant_sequence+1 WHERE id=1').run();
      db.prepare('UPDATE project_resources SET last_grant=(SELECT grant_sequence FROM portfolio_runtime WHERE id=1) WHERE project_id=?').run(projectId);
      resourceEvent(db, projectId, 'WORKERS_RESERVED', {actionId: facts.actionId, runId, epoch: expectedEpoch, workerCount: facts.workerCount});
      return {status: 'RESERVED', reused: false, reservation: reservationView(db.prepare('SELECT * FROM worker_reservations WHERE action_id=?').get(facts.actionId)), candidateOrder: order};
    }).immediate();
  } finally { db.close(); }
}

export function assertRunPermit(input, cfg, runId) {
  const context = checked(input), {registry, registryHash} = context, registered = projectConfig(context, cfg.projectId);
  if (projectIdentity(cfg) !== projectIdentity(registered)) fail('PROJECT_BINDING_CHANGED', 'Dispatch configuration differs from the registered project');
  requireProjectOwner(registered);
  const db = openPortfolio(registry);
  try {
    requireRegistration(db, registryHash); checkPause(db, cfg.projectId);
    const facts = runFacts(registry, registered, runId, {configs: context.configs}), reservation = db.prepare("SELECT * FROM worker_reservations WHERE action_id=? AND status='HELD'").get(facts.actionId);
    if (!reservation) fail('RESOURCE_UNAVAILABLE', 'Reserve this exact group before dispatch');
    if (reservation.epoch !== registry.manifest.coordinatorEpoch) fail('OWNER_EPOCH_MISMATCH', 'An old owner epoch cannot dispatch');
    if (facts.run.pause_requested) fail('PROJECT_PAUSED', 'The underlying run is paused');
    if (facts.run.status === 'BLOCKED' || facts.tasks.some(task => task.status === 'RESERVED')) fail('DISPATCH_UNKNOWN', 'Unresolved delivery must be reconciled before another dispatch');
    if (!['PREPARED', 'RUNNING'].includes(facts.run.status)) fail('RECONCILE_REQUIRED', 'This run is not eligible for another dispatch');
    return {allowed: true, ...reservationView(reservation)};
  } finally { db.close(); }
}

function completionEvidence(cfg, runId) {
  const evidence = delivery(cfg, runId), store = openStore(cfg);
  try {
    for (const task of store.tasks(runId)) {
      const event = store.db.prepare("SELECT data FROM events WHERE run_id=? AND kind='task_result' AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.attemptId')=? ORDER BY id DESC LIMIT 1").get(runId, task.task_id, task.attempt);
      const recorded = event && JSON.parse(event.data), packet = JSON.parse(task.packet);
      if (!recorded?.receiptHash || digest(fs.readFileSync(packet.receiptPath)) !== recorded.receiptHash) fail('INPUT_STALE', 'Completion receipt no longer matches its recorded byte hash');
    }
    return evidence;
  } finally { store.close(); }
}

function checkCrossDependencies(registry, cfg, request, configs) {
  const dependencies = registry.manifest.dependencies.filter(dependency => dependency.to.projectId === cfg.projectId && request.tasks.some(task => task.id === dependency.to.taskId));
  for (const {from, to} of dependencies) {
    const target = request.planBinding.taskRefs.find(task => task.id === to.taskId);
    if (request.planBinding.planId !== to.planId || request.planBinding.revision !== to.planRevision || target?.revision !== to.taskRevision) fail('INPUT_STALE', 'Cross-project input names a different target contract');
    const source = configs?.[from.projectId];
    if (!source) fail('PROJECT_BINDING_CHANGED', 'Cross-project source must come from the verified portfolio registry');
    const frozen = planRevision(source, from.planId, from.planRevision);
    if (!frozen) fail('DEPENDENCY_NOT_READY', 'The frozen source plan is not available');
    const task = frozen.plan.tasks.find(candidate => candidate.id === from.taskId), artifact = task?.artifacts?.find(candidate => candidate.id === from.artifactId);
    if (task?.revision !== from.taskRevision || artifact?.version !== from.artifactVersion || !task.files.includes(artifact.path)) fail('INPUT_STALE', 'Cross-project source artifact is not declared by the exact frozen task version');
    const store = openStore(source); let matching;
    try {
      const groups = store.db.prepare('SELECT * FROM plan_runs WHERE project_id=? AND plan_id=? AND plan_revision=? ORDER BY created_at,run_id').all(source.projectId, from.planId, from.planRevision);
      for (const group of groups) {
        const references = JSON.parse(group.task_refs), reference = references.find(candidate => candidate.id === from.taskId && candidate.revision === from.taskRevision);
        if (!reference) continue;
        const run = store.run(group.run_id); if (run?.status !== 'COMPLETE') continue;
        const req = JSON.parse(run.request);
        if (reference.definitionHash !== taskDefinitionHash(frozen.plan, task) || run.digest !== digest(req) || run.digest !== digest(JSON.parse(group.request)) || req.planBinding.planHash !== frozen.planHash || digest(req.planBinding.taskRefs) !== digest(references)) fail('INPUT_STALE', 'Source completion no longer matches its frozen request and task definitions');
        if (matching) fail('INPUT_STALE', 'The shared source contract has ambiguous completed groups');
        matching = group.run_id;
      }
    } finally { store.close(); }
    if (!matching) fail('DEPENDENCY_NOT_READY', 'The declared source task has no completed accepted delivery');
    let evidence;
    try { evidence = completionEvidence(source, matching); }
    catch { fail('INPUT_STALE', 'Shared source acceptance, result receipt or current artifact evidence changed'); }
    if (evidence.artifacts[artifact.path] !== from.artifactHash) fail('INPUT_STALE', 'The shared artifact hash does not match the explicitly authorized version');
  }
}

export function releaseWorkers(input, {projectId, runId, expectedEpoch} = {}) {
  const context = checked(input), {registry, registryHash} = context, cfg = projectConfig(context, projectId);
  requireActor(registry, cfg); requireEpoch(registry, expectedEpoch);
  const db = openPortfolio(registry);
  try {
    requireRegistration(db, registryHash);
    return db.transaction(() => {
      const facts = runFacts(registry, cfg, runId, {current: false}), reservation = db.prepare('SELECT * FROM worker_reservations WHERE action_id=?').get(facts.actionId);
      if (!reservation) fail('RESOURCE_UNAVAILABLE', 'No matching reservation exists');
      if (reservation.status === 'RELEASED') return {released: true, reused: true, reservation: reservationView(reservation)};
      if (facts.run.status !== 'COMPLETE' || facts.tasks.some(task => task.status !== 'DONE' || !task.result)) fail('RECONCILE_REQUIRED', 'Only verified COMPLETE groups release capacity; unresolved or failed work keeps its reservation');
      const evidence = completionEvidence(cfg, runId);
      const releaseEvidence = {acceptanceHash: evidence.acceptance.hash, artifacts: evidence.artifacts};
      db.prepare("UPDATE worker_reservations SET status='RELEASED',released_at=?,release_evidence=? WHERE action_id=? AND status='HELD'").run(Date.now(), JSON.stringify(releaseEvidence), facts.actionId);
      resourceEvent(db, projectId, 'WORKERS_RELEASED', {actionId: facts.actionId, runId, acceptanceHash: evidence.acceptance.hash});
      return {released: true, reused: false, reservation: reservationView(db.prepare('SELECT * FROM worker_reservations WHERE action_id=?').get(facts.actionId))};
    }).immediate();
  } finally { db.close(); }
}

export function releaseUndispatched(input, {projectId, runId, expectedEpoch} = {}) {
  const context = checked(input), {registry, registryHash} = context, cfg = projectConfig(context, projectId);
  requireActor(registry, cfg); requireEpoch(registry, expectedEpoch);
  const db = openPortfolio(registry), lock = safePath(cfg.controlRoot, '.runner.lock'); let fd;
  try {
    requireRegistration(db, registryHash);
    fd = fs.openSync(lock, 'wx'); fs.writeFileSync(fd, JSON.stringify({pid: process.pid, runId, action: 'release-undispatched'}));
    return db.transaction(() => {
      const facts = runFacts(registry, cfg, runId, {current: false});
      const reservation = db.prepare('SELECT * FROM worker_reservations WHERE action_id=?').get(facts.actionId);
      if (!reservation) fail('RESOURCE_UNAVAILABLE', 'No reservation exists for this unchanged attempt');
      const store = openStore(cfg); let retirement;
      try {
        retirement = store.db.prepare('SELECT * FROM plan_retirements WHERE run_id=?').get(runId);
        if (!retirement || digest(retirement.evidence) !== retirement.evidence_hash) fail('INPUT_STALE', 'A matching immutable retirement proof is required');
        const evidence = JSON.parse(retirement.evidence);
        if (evidence.projectId !== projectId || evidence.runId !== runId || evidence.requestHash !== facts.run.digest || evidence.delivery !== 'NOT_SENT' || evidence.proof !== 'NO_ASSIGNMENT_OR_DISPATCH_INTENT') fail('INPUT_STALE', 'Retirement proof does not bind this undispatched run');
        if (!['PREPARED', 'RUNNING'].includes(facts.run.status) || /UNCONFIRMED|UNKNOWN|Ambiguous dispatch/i.test(facts.run.reason ?? '') || facts.tasks.some(task => task.status !== 'PENDING' || task.result !== null || task.baseline !== null)) fail('DISPATCH_UNKNOWN', 'Assignment, delivery uncertainty or a result prevents undispatched release');
        const actualTasks = facts.tasks.map(task => ({taskId: task.task_id, attemptId: task.attempt, status: task.status}));
        if (digest(actualTasks) !== digest(evidence.tasks)) fail('INPUT_STALE', 'Retired task attempts changed');
        const events = store.db.prepare('SELECT id,kind,data FROM events WHERE run_id=? ORDER BY id').all(runId), terminal = events.at(-1);
        if (!Array.isArray(evidence.events) || evidence.events.some(event => !['phase_prepare_intent', 'prepared', 'status'].includes(event.kind)) || events.length !== evidence.events.length + 1 || terminal?.kind !== 'phase_superseded' || digest(events.slice(0, -1)) !== digest(evidence.events)) fail('DISPATCH_UNKNOWN', 'Execution events no longer prove absence of assignment and dispatch');
        const marker = JSON.parse(terminal.data);
        if (marker.evidenceHash !== retirement.evidence_hash || marker.reason !== evidence.reason) fail('INPUT_STALE', 'Retirement event does not match the frozen proof');
        const results = safePath(cfg.controlRoot, `runs/${runId}/results`);
        if ((fs.existsSync(results) && fs.readdirSync(results).length) || facts.tasks.some(task => fs.existsSync(assertContained(cfg.controlRoot, JSON.parse(task.packet).receiptPath)))) fail('DISPATCH_UNKNOWN', 'A disk result exists; retain its capacity for reconciliation');
      } finally { store.close(); }
      const releaseEvidence = {delivery: 'NOT_SENT', proof: 'NO_ASSIGNMENT_OR_DISPATCH_INTENT', retirementHash: retirement.evidence_hash, requestHash: facts.run.digest, attempts: facts.attempts};
      if (reservation.status === 'RELEASED') {
        if (!reservation.release_evidence || digest(JSON.parse(reservation.release_evidence)) !== digest(releaseEvidence)) fail('INPUT_STALE', 'This reservation was released using different evidence');
        return {released: true, reused: true, delivery: 'NOT_SENT', reservation: reservationView(reservation)};
      }
      if (reservation.status !== 'HELD') fail('RESOURCE_UNAVAILABLE', 'Only a held reservation may be released');
      db.prepare("UPDATE worker_reservations SET status='RELEASED',released_at=?,release_evidence=? WHERE action_id=? AND status='HELD'").run(Date.now(), JSON.stringify(releaseEvidence), facts.actionId);
      resourceEvent(db, projectId, 'WORKERS_RELEASED_UNDISPATCHED', {actionId: facts.actionId, runId, retirementHash: retirement.evidence_hash, delivery: 'NOT_SENT'});
      return {released: true, reused: false, delivery: 'NOT_SENT', reservation: reservationView(db.prepare('SELECT * FROM worker_reservations WHERE action_id=?').get(facts.actionId))};
    }).immediate();
  } finally { if (fd !== undefined) { fs.closeSync(fd); fs.unlinkSync(lock); } db.close(); }
}

export function pausePortfolio(input, {projectId, paused, expectedEpoch} = {}) {
  const context = checked(input), {registry, registryHash} = context, cfg = projectId === undefined ? undefined : projectConfig(context, projectId);
  requireActor(registry, cfg); requireEpoch(registry, expectedEpoch);
  if (typeof paused !== 'boolean') fail('PORTFOLIO_INVALID', 'An explicit pause or resume decision is required');
  const db = openPortfolio(registry);
  try {
    requireRegistration(db, registryHash);
    return db.transaction(() => {
      const row = projectId === undefined ? db.prepare('SELECT paused FROM portfolio_runtime WHERE id=1').get() : db.prepare('SELECT paused FROM project_resources WHERE project_id=?').get(projectId);
      const changed = !!row.paused !== paused;
      if (changed) {
        if (projectId === undefined) db.prepare('UPDATE portfolio_runtime SET paused=? WHERE id=1').run(Number(paused));
        else db.prepare('UPDATE project_resources SET paused=? WHERE project_id=?').run(Number(paused), projectId);
        resourceEvent(db, projectId, paused ? 'DISPATCH_PAUSED' : 'DISPATCH_RESUMED', {projectId: projectId ?? null, paused, epoch: expectedEpoch});
      }
      return {portfolioId: registry.manifest.portfolioId, projectId: projectId ?? null, paused, changed, inFlight: 'UNCHANGED_PENDING_HOST_EVIDENCE'};
    }).immediate();
  } finally { db.close(); }
}

function verifiedMigration(previous, next) {
  const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (previous.pmThreadId === next.pmThreadId || previous.configFile === next.configFile || canonical({...previous, pmThreadId: next.pmThreadId}) !== canonical({...next})) fail('CAPABILITY_UNAVAILABLE', 'Rebinding requires a separate new config with only the accepted PM identity changed');
  const store = openStore(next), source = projectIdentity(previous), target = projectIdentity(next), hashes = [];
  try {
    if (resolveIdentity(store, source) !== target) fail('CAPABILITY_UNAVAILABLE', 'An accepted identity transfer must precede portfolio rebinding');
    let identity = source;
    while (identity !== target) {
      const transfer = store.db.prepare('SELECT * FROM identity_transfers WHERE previous_identity=?').get(identity);
      const handoff = transfer && store.db.prepare("SELECT * FROM handoffs WHERE packet_hash=? AND status='ACCEPTED' AND source_identity=? AND target_identity=?").get(transfer.handoff_hash, identity, transfer.current_identity);
      if (!handoff || handoff.project_id !== next.projectId) fail('INPUT_STALE', 'Identity transfer lacks its matching accepted handoff');
      const packetFile = safePath(next.controlRoot, handoff.packet_path), packetBytes = fs.readFileSync(packetFile), packet = JSON.parse(packetBytes), receipt = JSON.parse(handoff.receipt);
      if (digest(packetBytes) !== handoff.packet_hash || packet.source.identity !== identity || packet.source.identity !== projectIdentity(packet.source.config) || packet.projectId !== next.projectId || receipt.packetHash !== handoff.packet_hash || receipt.sourceThreadId !== packet.source.threadId || receipt.targetThreadId !== handoff.target_thread_id) fail('INPUT_STALE', 'Accepted handoff identity or packet evidence changed');
      const evidence = receipt.sessionEvidence;
      if (!evidence?.path || !evidence.hash) fail('INPUT_STALE', 'Accepted handoff has no session evidence');
      assertContained(next.controlRoot, evidence.path);
      const sessionBytes = fs.readFileSync(evidence.path), session = JSON.parse(sessionBytes);
      if (digest(sessionBytes) !== evidence.hash || session.threadId !== receipt.targetThreadId || session.sourceThreadId !== receipt.sourceThreadId || session.context !== 'fresh' || session.forkedFrom !== null) fail('INPUT_STALE', 'Accepted session evidence changed');
      hashes.push(handoff.packet_hash); identity = transfer.current_identity;
    }
    return hashes;
  } finally { store.close(); }
}

export function revisePortfolio(input, nextRegistry, {expectedRevision, expectedEpoch, reason} = {}) {
  const current = checked(input), next = checked(nextRegistry), {registry, registryHash} = current;
  requireActor(registry); requireEpoch(registry, expectedEpoch);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== registry.manifest.revision || next.registry.manifest.revision !== expectedRevision + 1) fail('PLAN_CONFLICT', 'Portfolio revision must follow the expected revision');
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 2000) fail('PORTFOLIO_INVALID', 'A bounded revision reason is required');
  const updated = next.registry, before = registry.manifest, after = updated.manifest;
  if (updated.controlRoot !== registry.controlRoot || updated.coordinatorThreadId !== registry.coordinatorThreadId || after.portfolioId !== before.portfolioId) fail('CAPABILITY_UNAVAILABLE', 'This revision path preserves the portfolio storage and coordinator task');
  if (![expectedEpoch, expectedEpoch + 1].includes(after.coordinatorEpoch)) fail('OWNER_EPOCH_MISMATCH', 'A revision may keep the current epoch or advance it once');
  if (after.budget.maxActiveWorkers > before.budget.maxActiveWorkers || after.budget.maxAttemptsPerTask > before.budget.maxAttemptsPerTask) fail('BUDGET_EXPANSION_FORBIDDEN', 'A portfolio revision cannot expand the authorized budget');
  if (digest(before.dependencies) !== digest(after.dependencies)) fail('CAPABILITY_UNAVAILABLE', 'Cross-project dependency edits require a separate compatibility review');
  if (after.projects.length !== before.projects.length || after.projects.some(ref => !before.projects.some(old => old.projectId === ref.projectId && old.planId === ref.planId))) fail('CAPABILITY_UNAVAILABLE', 'This revision path preserves the registered project and plan set');
  const migrations = [];
  for (const ref of after.projects) if (updated.bindings[ref.projectId] !== registry.bindings[ref.projectId] || projectIdentity(next.configs[ref.projectId]) !== projectIdentity(current.configs[ref.projectId])) {
    if (after.coordinatorEpoch !== expectedEpoch + 1) fail('OWNER_EPOCH_MISMATCH', 'Project owner transfer requires a new coordinator epoch');
    migrations.push({projectId: ref.projectId, handoffHashes: verifiedMigration(current.configs[ref.projectId], next.configs[ref.projectId])});
  }
  for (const ref of after.projects) {
    const old = before.projects.find(project => project.projectId === ref.projectId);
    if (ref.acceptedPlanRevision < old.acceptedPlanRevision) fail('PLAN_CONFLICT', 'Portfolio plan references cannot move backwards');
    if (ref.acceptedPlanRevision !== old.acceptedPlanRevision) {
      const active = activePlan(next.configs[ref.projectId]);
      if (!active || active.plan.planId !== ref.planId || active.plan.revision !== ref.acceptedPlanRevision) fail('INPUT_STALE', 'A new overview reference must match the actual active project plan');
    }
  }
  const db = openPortfolio(registry);
  try {
    return db.transaction(() => {
      const row = db.prepare('SELECT * FROM portfolio_registration WHERE id=1').get();
      if (!row) fail('PORTFOLIO_NOT_REGISTERED', 'Register this portfolio before revising it');
      const stored = JSON.parse(row.manifest);
      if (stored.revision !== expectedRevision || stored.coordinatorEpoch !== expectedEpoch) fail('PLAN_CONFLICT', 'Portfolio changed while the revision was prepared');
      requireRegistration(db, registryHash);
      if (resourceSummary(db, registry).heldWorkers > after.budget.maxActiveWorkers) fail('BUDGET_IN_USE', 'Complete and release existing reservations before shrinking below current use');
      bindProjects(updated, next.configs, db);
      db.prepare('INSERT INTO portfolio_revisions VALUES(?,?,?,?,?)').run(after.revision, JSON.stringify(updated), next.registryHash, reason.trim(), Date.now());
      db.prepare('UPDATE portfolio_registration SET registry_hash=?,manifest=? WHERE id=1').run(next.registryHash, JSON.stringify(after));
      for (const migration of migrations) {
        // The accepted handoff already proved no source work is still executing.
        // Preserve attempts and consumed budget while recording the new owner generation.
        const reservations = db.prepare("SELECT action_id,epoch FROM worker_reservations WHERE project_id=? AND status='HELD'").all(migration.projectId);
        db.prepare("UPDATE worker_reservations SET epoch=? WHERE project_id=? AND status='HELD'").run(after.coordinatorEpoch, migration.projectId);
        resourceEvent(db, migration.projectId, 'RESERVATION_OWNER_TRANSFERRED', {...migration, previousReservations: reservations, epoch: after.coordinatorEpoch});
      }
      db.prepare('DELETE FROM resource_queue').run();
      resourceEvent(db, undefined, 'PORTFOLIO_REVISED', {revision: after.revision, coordinatorEpoch: after.coordinatorEpoch, reason: reason.trim()});
      return {portfolioId: after.portfolioId, revision: after.revision, coordinatorEpoch: after.coordinatorEpoch, manifestHash: digest(after), registry: updated};
    }).immediate();
  } finally { db.close(); }
}
