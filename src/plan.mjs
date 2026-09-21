import fs from 'node:fs';
import path from 'node:path';
import {digest, safePath, projectIdentity, validatePlan} from './contracts.mjs';
import {openStore} from './workflow.mjs';
import {resolveIdentity} from './handoff.mjs';

const fail = (code, message) => { throw Object.assign(Error(message), {code}); };
const requirePM = cfg => {
  if (process.env.CODEX_THREAD_ID !== cfg.pmThreadId) fail('ACTOR_MISMATCH', 'Plan mutation requires the configured project owner');
};

export function taskDefinitionHash(plan, task) {
  const memo = new Map();
  function hash(current) {
    if (memo.has(current.id)) return memo.get(current.id);
    const phases = new Set(), visit = id => { for (const prior of plan.phases.find(p => p.id === id).dependsOn) if (!phases.has(prior)) { phases.add(prior); visit(prior); } };
    visit(current.phaseId);
    const dependencies = plan.tasks.filter(t => current.dependsOn.includes(t.id) || phases.has(t.phaseId)).map(t => [t.id,hash(t)]);
    const result = digest({task:current, objective:plan.objective, constraints:plan.constraints, dependencies});
    memo.set(current.id,result); return result;
  }
  return hash(task);
}

export function planImpact(before, after) {
  if (before.projectId !== after.projectId || before.planId !== after.planId) fail('PLAN_INVALID', 'Changes must stay in the same project and plan');
  const previous = new Map(before.tasks.map(t => [t.id,t]));
  const affected = after.tasks.filter(task => !previous.has(task.id) || taskDefinitionHash(before,previous.get(task.id)) !== taskDefinitionHash(after,task)).map(t => t.id);
  return {affected, unchanged:after.tasks.filter(t => !affected.includes(t.id)).map(t => t.id), removed:before.tasks.filter(t => !after.tasks.some(next => next.id === t.id)).map(t => t.id)};
}

export function parsePlanMarkdown(markdown, cfg) {
  const start = '<!-- workbench-plan -->', end = '<!-- /workbench-plan -->';
  if (typeof markdown !== 'string' || markdown.split(start).length !== 2 || markdown.split(end).length !== 2) {
    fail('PLAN_INVALID', 'Exactly one workbench-plan block is required');
  }
  const block = markdown.slice(markdown.indexOf(start) + start.length, markdown.indexOf(end));
  const match = /^\s*```json\s*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(block);
  if (!match) fail('PLAN_INVALID', 'The marked block must contain only one fenced JSON plan');
  return validatePlan(JSON.parse(match[1]), cfg);
}

function readStored(cfg, row, store) {
  if (!row) return null;
  if (resolveIdentity(store,row.identity) !== projectIdentity(cfg)) fail('PROJECT_BINDING_CHANGED', 'Plan configuration changed; reconcile the owner and project binding');
  const file = safePath(cfg.controlRoot, row.snapshot), bytes = fs.readFileSync(file);
  if (digest(bytes) !== row.hash) fail('INPUT_STALE', 'Immutable plan snapshot changed');
  const plan = validatePlan(JSON.parse(bytes), cfg);
  if (plan.projectId !== row.project_id || plan.planId !== row.plan_id || plan.revision !== row.revision) fail('INPUT_STALE', 'Plan snapshot identity changed');
  return {plan, planHash: row.hash, snapshot: file, createdAt: row.created_at, reason: row.reason};
}

export function activePlan(cfg, existingStore) {
  const store = existingStore ?? openStore(cfg);
  try {
    return readStored(cfg, store.db.prepare(`SELECT p.* FROM plans p JOIN active_plans a
      ON p.project_id=a.project_id AND p.plan_id=a.plan_id AND p.revision=a.revision WHERE a.project_id=?`).get(cfg.projectId), store);
  } finally { if (!existingStore) store.close(); }
}

export function planRevision(cfg, planId, revision, existingStore) {
  const store = existingStore ?? openStore(cfg);
  try { return readStored(cfg, store.db.prepare('SELECT * FROM plans WHERE project_id=? AND plan_id=? AND revision=?').get(cfg.projectId, planId, revision), store); }
  finally { if (!existingStore) store.close(); }
}

// The file is immutable and durable before the transaction can make it active.
// A failed CAS may leave an unreferenced snapshot, never an active partial plan.
export function publishPlan(cfg, input, {expectedRevision, reason} = {}) {
  requirePM(cfg);
  const plan = validatePlan(input, cfg);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || plan.revision !== expectedRevision + 1) fail('PLAN_CONFLICT', 'Plan revision must follow expectedRevision');
  if (typeof reason !== 'string' || !reason.trim()) fail('PLAN_INVALID', 'A plan change reason is required');
  const store = openStore(cfg);
  try {
    const bytes = JSON.stringify(plan, null, 2) + '\n', hash = digest(bytes);
    const relative = `plans/${plan.planId}/${plan.revision}-${hash}.json`, file = safePath(cfg.controlRoot, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    let fd;
    try {
      fd = fs.openSync(file, 'wx'); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (digest(fs.readFileSync(file)) !== hash) fail('INPUT_STALE', 'Existing snapshot differs from its content hash');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
    return store.db.transaction(() => {
      const current = store.db.prepare('SELECT * FROM active_plans WHERE project_id=?').get(cfg.projectId);
      if ((current?.revision ?? 0) !== expectedRevision || (current && current.plan_id !== plan.planId)) fail('PLAN_CONFLICT', 'Active revision changed; read it before merging');
      let impact = {affected:plan.tasks.map(t => t.id),unchanged:[],removed:[]};
      if (current) {
        const before = readStored(cfg, store.db.prepare('SELECT * FROM plans WHERE project_id=? AND plan_id=? AND revision=?').get(cfg.projectId, current.plan_id, current.revision), store).plan;
        impact = planImpact(before,plan);
        for (const task of plan.tasks) {
          const old = before.tasks.find(t => t.id === task.id);
          if (old) {
            const {revision:oldRevision,...oldBody} = old, {revision:newRevision,...newBody} = task;
            if (newRevision < oldRevision || (digest(oldBody) !== digest(newBody) && newRevision <= oldRevision)) fail('PLAN_CONFLICT', 'A changed task definition requires a newer task revision');
          }
        }
      }
      const createdAt = Date.now();
      store.db.prepare('INSERT INTO plans VALUES(?,?,?,?,?,?,?,?)').run(cfg.projectId, plan.planId, plan.revision, hash, relative, projectIdentity(cfg), createdAt, reason);
      store.db.prepare('INSERT INTO active_plans VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET plan_id=excluded.plan_id,revision=excluded.revision').run(cfg.projectId, plan.planId, plan.revision);
      store.event(null, 'plan_published', {projectId: cfg.projectId, planId: plan.planId, revision: plan.revision, planHash: hash, reason,impact});
      return {plan, planHash: hash, snapshot: file, createdAt, reason,impact};
    }).immediate();
  } finally { store.close(); }
}
