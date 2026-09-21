// Read-only consistency checks over saved evidence. No model or host calls.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const fixtureRoot = fileURLToPath(new URL('../examples/three-projects/', import.meta.url));
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const commit = value => typeof value === 'string' && /^[a-f0-9]{40}([a-f0-9]{24})?$/.test(value);
const same = (actual, expected, message) => requireThat(isDeepStrictEqual(actual, expected), message);

export function validateManifest(manifest) {
  requireThat(manifest?.schemaVersion === 1 && ['real-host', 'fixture'].includes(manifest.kind), 'schemaVersion/kind must identify a saved run, not a setup or reference result');
  requireThat(text(manifest.runId) && !Number.isNaN(Date.parse(manifest.recordedAt)), 'runId/recordedAt missing');
  for (const key of ['name', 'version', 'toolVersion']) requireThat(text(manifest.host?.[key]), `host.${key} missing`);
  requireThat(Number.isInteger(manifest.budget?.maxActiveWorkers) && manifest.budget.maxActiveWorkers > 0, 'worker budget missing');
  requireThat(manifest.artifacts && typeof manifest.artifacts === 'object' && !Array.isArray(manifest.artifacts), 'artifacts missing');
  for (const key of ['coordinatorRef', 'eventsRef', 'usageRef', 'timingRef']) requireThat(text(manifest[key]) && manifest.artifacts[manifest[key]], `${key} missing`);
  requireThat(Array.isArray(manifest.projects), 'projects missing');
  same(manifest.projects.map(p => p.projectId).sort(), ['project-a', 'project-b', 'project-c'], 'three distinct project identities required');
  for (const p of manifest.projects) {
    requireThat(text(p.repository) && commit(p.baseCommit) && commit(p.finalCommit) && p.baseCommit !== p.finalCommit, `${p.projectId}: baseline/final commits missing or unchanged`);
    same(p.planRevisions, p.projectId === 'project-a' ? [1, 2] : [1], `${p.projectId}: unexpected plan revisions`);
    for (const key of ['identityRef', 'baselineAcceptanceRef', 'acceptanceRef']) requireThat(text(p[key]) && manifest.artifacts[p[key]], `${p.projectId}: ${key} missing`);
  }
  return manifest;
}

function contained(root, relative) {
  requireThat(text(relative) && !path.isAbsolute(relative), 'evidence paths must be relative');
  const resolved = fs.realpathSync(path.resolve(root, relative));
  const rel = path.relative(root, resolved);
  requireThat(rel && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel), 'evidence path escapes manifest directory');
  return resolved;
}

export function verifyThreeProjects(manifestPath) {
  if (!manifestPath || !fs.existsSync(manifestPath)) return { status: 'incomplete', hostAcceptance: false, missing: ['Saved real-host manifest and raw host evidence have not been supplied.'] };
  const missing = [];
  try {
    const manifest = validateManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    const root = fs.realpathSync(path.dirname(path.resolve(manifestPath)));
    const artifacts = new Map();
    for (const [ref, artifact] of Object.entries(manifest.artifacts)) {
      requireThat(hash(artifact.sha256), `${ref}: invalid SHA-256`);
      const bytes = fs.readFileSync(contained(root, artifact.path));
      requireThat(sha256(bytes) === artifact.sha256, `${ref}: artifact hash mismatch`);
      artifacts.set(ref, bytes);
    }
    const bytes = ref => { requireThat(artifacts.has(ref), `missing evidence ref: ${ref}`); return artifacts.get(ref); };
    const json = ref => JSON.parse(bytes(ref).toString('utf8'));
    const authorized = (ref, scope) => {
      const authorization = json(ref);
      return authorization.source === 'user' && authorization.scope === scope && authorization.runId === manifest.runId;
    };
    const identity = (ref, projectId) => {
      const binding = json(ref);
      requireThat(binding.projectId === projectId && text(binding.actorId) && text(binding.sessionId), `${ref}: identity/project mismatch`);
      requireThat(text(binding.requestedModel) && text(binding.requestedReasoning), `${ref}: requested model configuration missing`);
      requireThat(Object.hasOwn(binding, 'observedModel') && Object.hasOwn(binding, 'observedReasoning'), `${ref}: observed configuration must be explicit, including null`);
      if (!binding.observedModel || !binding.observedReasoning) missing.push(`${ref}: runtime model/reasoning not observed`);
      else if (binding.observedModel !== binding.requestedModel || binding.observedReasoning !== binding.requestedReasoning) missing.push(`${ref}: observed model/reasoning differs from requested configuration`);
      const snapshot = json(binding.hostSnapshotRef);
      requireThat(snapshot.source === 'codex-tool' && text(snapshot.tool) && text(snapshot.observedAt) && snapshot.body && JSON.stringify(snapshot.body).includes(binding.sessionId), `${ref}: raw host identity snapshot missing`);
      return binding;
    };
    const coordinator = identity(manifest.coordinatorRef, 'portfolio');
    const projects = new Map();
    const sessions = new Set([coordinator.sessionId]);
    const lock = JSON.parse(fs.readFileSync(path.join(fixtureRoot, 'acceptance-lock.json'), 'utf8'));
    for (const p of manifest.projects) {
      const binding = identity(p.identityRef, p.projectId);
      requireThat(!sessions.has(binding.sessionId), 'project contexts must use distinct host sessions');
      sessions.add(binding.sessionId);
      const repository = contained(root, p.repository);
      const git = (...args) => execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      for (const revision of [p.baseCommit, p.finalCommit]) git('cat-file', '-e', `${revision}^{commit}`);
      git('merge-base', '--is-ancestor', p.baseCommit, p.finalCommit);
      for (const [file, expectedHash] of Object.entries(lock.baselineFiles).filter(([file]) => file.startsWith(`${p.projectId}/`))) {
        requireThat(sha256(Buffer.from(git('show', `${p.baseCommit}:${file.slice(p.projectId.length + 1)}`))) === expectedHash, `${p.projectId}: fixture baseline source changed`);
      }
      requireThat(git('show', `${p.finalCommit}:src/config.mjs`).includes(`'${p.projectId}'`), `${p.projectId}: wrong final config identity`);
      const changed = git('diff', '--name-only', p.baseCommit, p.finalCommit).trim().split(/\r?\n/);
      requireThat(changed.some(file => file.startsWith('src/')) && !changed.some(file => file.startsWith('acceptance/')), `${p.projectId}: source progress or frozen acceptance violation`);
      const check = (ref, expectedCommit, revision, baseline) => {
        const report = json(ref);
        const acceptancePath = `${p.projectId}/acceptance/v${revision}.test.mjs`;
        requireThat(report.projectId === p.projectId && report.commit === expectedCommit && report.revision === revision, `${ref}: acceptance identity/version/commit mismatch`);
        requireThat(report.acceptanceHash === lock.files[acceptancePath] && sha256(fs.readFileSync(path.join(fixtureRoot, acceptancePath))) === report.acceptanceHash, `${ref}: frozen acceptance hash mismatch`);
        requireThat(sha256(Buffer.from(git('show', `${expectedCommit}:acceptance/v${revision}.test.mjs`))) === report.acceptanceHash, `${ref}: repository acceptance changed`);
        same(report.command, ['node', '--test', '--test-reporter=tap', `acceptance/v${revision}.test.mjs`], `${ref}: unexpected acceptance command`);
        requireThat(Number.isInteger(report.passed) && Number.isInteger(report.failed) && report.passed > 0, `${ref}: test counts missing`);
        requireThat(report.passed + report.failed === (p.projectId === 'project-b' ? 5 : 4), `${ref}: incomplete acceptance test count`);
        requireThat(baseline ? report.exitCode !== 0 && report.failed > 0 : report.exitCode === 0 && report.failed === 0, `${ref}: baseline/final acceptance outcome invalid`);
        const output = bytes(report.outputRef).toString('utf8');
        requireThat(new RegExp(`(?:^|\\n)# pass ${report.passed}(?:\\r?\\n|$)`).test(output) && new RegExp(`(?:^|\\n)# fail ${report.failed}(?:\\r?\\n|$)`).test(output), `${ref}: saved TAP counts disagree`);
        for (const field of ['cancelled', 'skipped', 'todo']) requireThat(new RegExp(`(?:^|\\n)# ${field} 0(?:\\r?\\n|$)`).test(output), `${ref}: acceptance contains non-executed tests`);
        if (baseline) {
          const names = { 'project-a': ['A-v1-errors', 'A-v1-duplicates'], 'project-b': ['B-v1-legacy', 'B-v1-errors', 'B-v1-invalid'], 'project-c': ['C-v1-ties', 'C-v1-scope'] }[p.projectId];
          requireThat(report.failed === names.length && names.every(name => new RegExp(`not ok \\d+ - ${name}`).test(output)), `${ref}: expected baseline defects missing`);
        }
        requireThat(report.sourceHashes && Object.keys(report.sourceHashes).length > 0, `${ref}: tested source hashes missing`);
        const sourceFiles = git('ls-tree', '-r', '--name-only', expectedCommit, '--', 'src').trim().split(/\r?\n/).filter(Boolean);
        same(Object.keys(report.sourceHashes).sort(), sourceFiles.sort(), `${ref}: incomplete tested source set`);
        for (const file of sourceFiles) requireThat(sha256(Buffer.from(git('show', `${expectedCommit}:${file}`))) === report.sourceHashes[file], `${ref}: tested source hash mismatch`);
        return report;
      };
      check(p.baselineAcceptanceRef, p.baseCommit, 1, true);
      check(p.acceptanceRef, p.finalCommit, p.projectId === 'project-a' ? 2 : 1, false);
      projects.set(p.projectId, { ...p, binding, revision: 1, epoch: 1, paused: false });
    }
    const events = json(manifest.eventsRef);
    requireThat(Array.isArray(events) && events.length > 0, 'event sequence missing');
    const required = new Set(['REQUIREMENTS_CHANGED', 'RESULT_SUPERSEDED', 'INTERRUPTED', 'CONTEXT_RESUMED', 'PROJECT_PAUSED', 'PROJECT_RESUMED', 'PRIORITY_CHANGED', 'RESOURCE_CHANGED', 'PORTFOLIO_PAUSED', 'PORTFOLIO_RESUMED']);
    const active = new Map(), actions = new Set(), attempts = new Map(), accepted = new Set(), completed = new Map();
    const advancedDuringPause = new Set();
    let globallyPaused = false, capacity = manifest.budget.maxActiveWorkers, cPriorityChanged = false, interrupted, resumed = false;
    for (const [index, event] of events.entries()) {
      requireThat(event.seq === index + 1 && text(event.type), 'event ordering or type invalid');
      const exported = json(event.evidenceRef);
      const { evidenceRef, ...eventBody } = event;
      requireThat(exported.source === 'controller-export', `${event.seq}: controller export provenance missing`);
      same(exported.event, eventBody, `${event.seq}: saved controller event differs`);
      const p = projects.get(event.projectId);
      const binding = p?.binding ?? coordinator;
      requireThat(event.actorId === binding.actorId && event.coordinatorEpoch === (p?.epoch ?? 1), `${event.seq}: actor/owner epoch mismatch`);
      if (['DISPATCH', 'RESULT', 'RESULT_SUPERSEDED', 'INTERRUPTED', 'CONTEXT_RESUMED'].includes(event.type)) {
        const hostSnapshot = json(exported.hostSnapshotRef);
        requireThat(hostSnapshot.source === 'codex-tool' && text(hostSnapshot.tool) && text(hostSnapshot.observedAt) && JSON.stringify(hostSnapshot.body).includes(binding.sessionId), `${event.seq}: raw host action evidence missing`);
      }
      if (p) requireThat(event.planRevision === p.revision || event.type === 'RESULT_SUPERSEDED', `${event.seq}: stale plan revision`);
      switch (event.type) {
        case 'DISPATCH': {
          requireThat(p && !p.paused && !globallyPaused, `${event.seq}: dispatch during pause or to unknown project`);
          requireThat(text(event.actionId) && text(event.attemptId) && text(event.taskId) && Number.isInteger(event.taskRevision) && event.taskRevision > 0 && hash(event.packetHash), `${event.seq}: dispatch identity/version missing`);
          requireThat(!actions.has(event.actionId) && !attempts.has(event.attemptId), `${event.seq}: duplicate dispatch`);
          requireThat(active.size < capacity, `${event.seq}: worker budget exceeded`);
          if (resumed && p.projectId === 'project-b') requireThat(!interrupted.validDeliveries.includes(event.taskId), 'recovery repeated a valid delivery');
          actions.add(event.actionId); attempts.set(event.attemptId, event); active.set(event.attemptId, event); break;
        }
        case 'RESULT':
        case 'RESULT_SUPERSEDED': {
          const dispatched = active.get(event.attemptId);
          requireThat(dispatched && p && dispatched.projectId === p.projectId && dispatched.planRevision === event.planRevision && dispatched.packetHash === event.packetHash && dispatched.taskRevision === event.taskRevision && event.hostCompletionConfirmed === true, `${event.seq}: result identity/version/completion evidence mismatch`);
          requireThat(event.type === 'RESULT_SUPERSEDED' ? event.planRevision < p.revision : event.planRevision === p.revision, `${event.seq}: superseded result misclassified`);
          requireThat(['done', 'failed', 'cancelled'].includes(event.status), `${event.seq}: result outcome missing`);
          active.delete(event.attemptId);
          completed.set(event.attemptId, event);
          if (['project-b', 'project-c'].includes(p.projectId) && projects.get('project-a').paused && event.status === 'done') {
            if (p.projectId === 'project-c') requireThat(cPriorityChanged, 'C progressed before its recorded priority adjustment');
            advancedDuringPause.add(p.projectId);
          }
          break;
        }
        case 'ACCEPT':
          requireThat(p && event.acceptanceRef === p.acceptanceRef && ![...active.values()].some(a => a.projectId === p.projectId), `${event.seq}: wrong acceptance or active work`);
          requireThat([...completed.values()].some(e => e.projectId === p.projectId && e.planRevision === p.revision && e.status === 'done'), `${event.seq}: no current successful delivery`);
          accepted.add(p.projectId); break;
        case 'REQUIREMENTS_CHANGED': {
          requireThat(p?.projectId === 'project-a' && p.revision === 1 && event.nextRevision === 2, 'expected A v1 to v2 requirement change');
          const before = json(event.beforeRef), after = json(event.afterRef);
          for (const id of ['project-b', 'project-c']) {
            requireThat(before[id]?.planHash && before[id]?.artifactHashes, `${id}: unaffected-project evidence missing`);
            same(after[id], before[id], `${id}: changed by A requirements`);
          }
          p.revision = 2; break;
        }
        case 'INTERRUPTED':
          requireThat(p?.projectId === 'project-b', 'expected B interruption');
          interrupted = json(event.handoffRef);
          for (const field of ['constraints', 'failedAttempts', 'unfinished', 'validDeliveries']) requireThat(Array.isArray(interrupted[field]) && interrupted[field].length > 0, `handoff ${field} missing`);
          requireThat(interrupted.projectId === p.projectId && interrupted.planRevision === p.revision, 'handoff identity/version mismatch');
          for (const taskId of interrupted.validDeliveries) requireThat([...completed.values()].some(e => e.projectId === p.projectId && e.status === 'done' && attempts.get(e.attemptId).taskId === taskId), 'handoff valid delivery lacks completion evidence');
          interrupted.identity = p.binding; interrupted.ref = event.handoffRef; break;
        case 'CONTEXT_RESUMED': {
          requireThat(p?.projectId === 'project-b' && interrupted && event.handoffRef === interrupted.ref && event.nextEpoch === p.epoch + 1, 'B recovery lacks matching handoff/epoch');
          const next = identity(event.identityRef, p.projectId);
          requireThat(next.contextMode === 'new' && next.sessionId !== interrupted.identity.sessionId && !sessions.has(next.sessionId), 'B recovery requires a genuinely new session');
          same(event.preservedDeliveries, interrupted.validDeliveries, 'B recovery dropped valid deliveries');
          p.binding = next; p.epoch = event.nextEpoch; sessions.add(next.sessionId); resumed = true; break;
        }
        case 'PROJECT_PAUSED': requireThat(p?.projectId === 'project-a' && !p.paused, 'expected A pause'); p.paused = true; break;
        case 'PROJECT_RESUMED': requireThat(p?.paused && authorized(event.authorizationRef, 'project-resume'), 'project resume authorization missing'); p.paused = false; break;
        case 'PRIORITY_CHANGED': requireThat(p?.projectId === 'project-c' && Number.isInteger(event.priority) && event.priority > 0, 'C priority change missing'); cPriorityChanged = true; break;
        case 'RESOURCE_CHANGED':
          requireThat(Number.isInteger(event.maxActiveWorkers) && event.maxActiveWorkers > 0 && event.maxActiveWorkers <= manifest.budget.maxActiveWorkers && event.maxActiveWorkers >= active.size && event.maxActiveWorkers !== capacity, 'invalid resource adjustment'); capacity = event.maxActiveWorkers; break;
        case 'PORTFOLIO_PAUSED': requireThat(!p && !globallyPaused, 'invalid portfolio pause'); globallyPaused = true; break;
        case 'PORTFOLIO_RESUMED': requireThat(!p && globallyPaused && authorized(event.authorizationRef, 'portfolio-resume'), 'portfolio resume authorization missing'); globallyPaused = false; break;
        default: throw new Error(`${event.seq}: unsupported event type ${event.type}`);
      }
      required.delete(event.type);
    }
    requireThat(required.size === 0, `missing lifecycle events: ${[...required].join(', ')}`);
    same([...advancedDuringPause].sort(), ['project-b', 'project-c'], 'B/C progress while A paused is missing');
    requireThat(active.size === 0 && !globallyPaused && [...projects.values()].every(p => !p.paused), 'run still active or paused');
    same([...accepted].sort(), [...projects.keys()].sort(), 'final acceptance events missing');
    const usage = json(manifest.usageRef), timing = json(manifest.timingRef);
    requireThat(Array.isArray(usage.roles) && usage.roles.length >= sessions.size, 'role usage coverage missing');
    for (const sessionId of sessions) {
      const role = usage.roles.find(r => r.sessionId === sessionId);
      requireThat(role && Object.hasOwn(role, 'inputTokens') && Object.hasOwn(role, 'outputTokens'), 'actor usage entry missing');
      if (role.inputTokens === null || role.outputTokens === null) missing.push('Some role token usage was not observed.');
      else requireThat(Number.isFinite(role.inputTokens) && role.inputTokens >= 0 && Number.isFinite(role.outputTokens) && role.outputTokens >= 0, 'invalid token usage');
    }
    requireThat(Number.isFinite(timing.coordinationMs) && timing.coordinationMs >= 0 && Number.isFinite(timing.executionMs) && timing.executionMs >= 0, 'coordination/execution timing missing');
    if (manifest.kind === 'fixture') missing.push('Fixture/synthetic evidence cannot establish real host acceptance.');
    return { status: missing.length ? 'incomplete' : 'evidence-verified', hostAcceptance: false, consistencyVerified: true, missing: [...new Set(missing)], scope: 'Saved evidence consistency only; raw host provenance must be independently reviewed. No host or model was called.' };
  } catch (error) {
    return { status: 'incomplete', hostAcceptance: false, consistencyVerified: false, missing: [error.message] };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = verifyThreeProjects(process.argv[2]);
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== 'evidence-verified') process.exitCode = 2;
}
