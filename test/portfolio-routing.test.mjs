import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configFrom, writeJson, validatePortfolio} from '../src/contracts.mjs';
import {activePlan, publishPlan} from '../src/plan.mjs';
import {getPacket, knowledge, prepare} from '../src/workflow.mjs';
import {loadPortfolioRegistry, registerPortfolio, routeProject, observeProject, portfolioStatus} from '../src/portfolio.mjs';

const coordinator = '99999999-9999-4999-8999-999999999999';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-portfolio-'));
  const before = process.env.CODEX_THREAD_ID;
  t.after(() => { if (before === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = before; fs.rmSync(root, {recursive: true, force: true}); });
  const configs = {}, plans = {}, bindings = {};
  for (const [letter, digit] of [['a', '1'], ['b', '2']]) {
    const id = `project-${letter}`, projectRoot = path.join(root, id);
    fs.mkdirSync(projectRoot);
    const cfg = {projectId: id, projectRoot, controlRoot: path.join(projectRoot, 'control'), workRoot: path.join(projectRoot, 'work'), vaultRoot: path.join(projectRoot, 'knowledge'), pmThreadId: `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`, workerThreads: {}, maxWorkers: 3, model: 'gpt-6-astra', thinking: 'ultra', captureEnabled: false};
    bindings[id] = path.join(projectRoot, 'project.json'); writeJson(bindings[id], cfg); configs[id] = configFrom(bindings[id]);
    fs.mkdirSync(cfg.vaultRoot); fs.writeFileSync(path.join(cfg.vaultRoot, 'contract.md'), `# contract\n${letter.toUpperCase()} PRIVATE KNOWLEDGE`);
    plans[id] = {schemaVersion: 1, projectId: id, planId: 'delivery', revision: 1, objective: `Deliver ${letter.toUpperCase()}`, constraints: ['Preserve API'], phases: [{id: 'build', dependsOn: [], maxNativeWorkers: 1}], tasks: [{id: 'same-task', revision: 1, phaseId: 'build', dependsOn: [], executor: 'direct', files: ['src/config.mjs'], contextRefs: [], acceptanceRefs: [`accept-${letter}`]}]};
  }
  const registryData = {controlRoot: path.join(root, 'portfolio'), coordinatorThreadId: coordinator, manifest: {schemaVersion: 1, portfolioId: 'two-projects', revision: 1, coordinatorEpoch: 1, budget: {maxActiveWorkers: 3, maxAttemptsPerTask: 2}, projects: Object.keys(configs).map(projectId => ({projectId, planId: 'delivery', acceptedPlanRevision: 1, priority: projectId === 'project-a' ? 2 : 1})), dependencies: []}, bindings};
  const registryFile = path.join(root, 'registry.json'); writeJson(registryFile, registryData);
  process.env.CODEX_THREAD_ID = coordinator;
  const publish = (id, revision = 1) => {
    process.env.CODEX_THREAD_ID = configs[id].pmThreadId;
    try { return publishPlan(configs[id], {...plans[id], revision}, {expectedRevision: revision - 1, reason: `Authorized revision ${revision}`}); }
    finally { process.env.CODEX_THREAD_ID = coordinator; }
  };
  return {root, configs, plans, bindings, registryData, registryFile, registry: loadPortfolioRegistry(registryFile), publish};
}

test('two projects keep identical task IDs, filenames and knowledge names in their own scope', t => {
  const f = fixture(t); registerPortfolio(f.registry); f.publish('project-a'); f.publish('project-b');
  for (const [id, letter] of [['project-a', 'A'], ['project-b', 'B']]) {
    const cfg = routeProject(f.registry, id);
    assert.equal(cfg.projectId, id); assert.equal(cfg.model, 'gpt-6-astra'); assert.equal(cfg.thinking, 'ultra');
    const index = knowledge(cfg);
    try { assert.match(index.search('contract').items[0].text, new RegExp(`${letter} PRIVATE KNOWLEDGE`)); }
    finally { index.close(); }
    prepare(cfg, {projectId: id, id: 'same-run', mode: 'direct', reason: 'One scoped task', objective: `Implement ${letter}`, tasks: [{id: 'same-task', objective: `Implement ${letter}`, files: ['src/config.mjs'], knowledge: {query: 'contract'}}], checks: [{id: 'accept', command: process.execPath, args: ['-e', 'process.exit(0)']}]});
    const packet = getPacket(cfg, 'same-run', 'same-task');
    assert.equal(packet.projectId, id); assert.equal(packet.files[0], path.join(cfg.workRoot, 'src/config.mjs'));
    assert.match(packet.context.items[0].text, new RegExp(`${letter} PRIVATE KNOWLEDGE`));
    assert.equal(activePlan(cfg).plan.projectId, id);
  }
  assert.throws(() => routeProject(f.registry), {code: 'PROJECT_NOT_REGISTERED'});
  assert.throws(() => routeProject(f.registry, 'unknown'), {code: 'PROJECT_NOT_REGISTERED'});
});

test('registration is repeatable and changed observations produce only incremental summaries', t => {
  const f = fixture(t);
  assert.equal(registerPortfolio(f.registryFile).reused, false); assert.equal(registerPortfolio(f.registry).reused, true);
  f.publish('project-a'); f.publish('project-b');
  assert.equal(observeProject(f.registry, 'project-a').sequence, 1);
  assert.equal(observeProject(f.registry, 'project-b').sequence, 2);
  const first = portfolioStatus(f.registry);
  assert.deepEqual(first.projects.map(project => project.projectId), ['project-a', 'project-b']);
  assert.equal(first.events.length, 2); assert.equal(first.sequence, 2);
  const json = JSON.stringify(first);
  assert.equal(json.includes('PRIVATE KNOWLEDGE'), false); assert.equal(json.includes(f.root), false); assert.equal(json.includes(coordinator), false);
  assert.equal(observeProject(f.registry, 'project-a').changed, false);
  assert.deepEqual(portfolioStatus(f.registry, {afterSequence: first.sequence}).projects, []);
  assert.deepEqual(portfolioStatus(f.registry, {afterSequence: first.sequence}).events, []);
  for (const afterSequence of [-1, 0.5, 3, '1']) assert.throws(() => portfolioStatus(f.registry, {afterSequence}), {code: 'INVALID_EVENT_SEQUENCE'});
});

test('a stale overview reports the real newer plan without changing either project or manifest', t => {
  const f = fixture(t); registerPortfolio(f.registry); f.publish('project-a'); const b = f.publish('project-b');
  observeProject(f.registry, 'project-a'); const second = observeProject(f.registry, 'project-b');
  const manifestBytes = fs.readFileSync(f.registryFile), bBytes = fs.readFileSync(b.snapshot);
  const next = f.publish('project-a', 2), observed = observeProject(f.registry, 'project-a');
  assert.equal(observed.summary.status, 'STALE_OVERVIEW'); assert.equal(observed.summary.planRevision, 2); assert.equal(observed.summary.acceptedPlanRevision, 1);
  assert.equal(observed.summary.planHash, next.planHash); assert.equal(activePlan(f.configs['project-a']).plan.revision, 2);
  assert.deepEqual(fs.readFileSync(f.registryFile), manifestBytes); assert.deepEqual(fs.readFileSync(b.snapshot), bBytes);
  assert.equal(observeProject(f.registry, 'project-b').changed, false);
  const changes = portfolioStatus(f.registry, {afterSequence: second.sequence});
  assert.deepEqual(changes.projects.map(project => project.projectId), ['project-a']); assert.equal(changes.sequence, 3);
});

test('coordinator owns registration and aggregate reads while project owners may route only themselves', t => {
  const f = fixture(t); delete process.env.CODEX_THREAD_ID;
  assert.throws(() => registerPortfolio(f.registry), {code: 'ACTOR_MISMATCH'});
  process.env.CODEX_THREAD_ID = f.configs['project-a'].pmThreadId;
  assert.throws(() => registerPortfolio(f.registry), {code: 'ACTOR_MISMATCH'}); assert.equal(fs.existsSync(f.registryData.controlRoot), false);
  process.env.CODEX_THREAD_ID = coordinator; registerPortfolio(f.registry);
  process.env.CODEX_THREAD_ID = f.configs['project-a'].pmThreadId;
  assert.equal(routeProject(f.registry, 'project-a').projectId, 'project-a'); assert.equal(observeProject(f.registry, 'project-a').summary.status, 'PLAN_MISSING');
  assert.throws(() => routeProject(f.registry, 'project-b'), {code: 'ACTOR_MISMATCH'});
  assert.throws(() => observeProject(f.registry, 'project-b'), {code: 'ACTOR_MISMATCH'});
  assert.throws(() => portfolioStatus(f.registry), {code: 'ACTOR_MISMATCH'});
  delete process.env.CODEX_THREAD_ID;
  assert.throws(() => routeProject(f.registry, 'project-a'), {code: 'ACTOR_MISMATCH'});
  assert.throws(() => portfolioStatus(f.registry), {code: 'ACTOR_MISMATCH'});
});

test('binding drift, changed manifest and missing explicit model fail before routing', t => {
  const f = fixture(t); registerPortfolio(f.registry);
  const configFile = f.bindings['project-a'], initial = fs.readFileSync(configFile);
  writeJson(configFile, {...f.configs['project-a'], thinking: 'high'});
  assert.throws(() => routeProject(f.registry, 'project-a'), {code: 'PROJECT_BINDING_CHANGED'});
  fs.writeFileSync(configFile, initial);
  const noModel = {...f.configs['project-a']}; delete noModel.model; writeJson(configFile, noModel);
  assert.throws(() => loadPortfolioRegistry(f.registryFile), /Explicit model/);
  fs.writeFileSync(configFile, initial);
  f.registryData.manifest.projects[0].priority = 9; writeJson(f.registryFile, f.registryData);
  assert.throws(() => registerPortfolio(f.registry), {code: 'PROJECT_BINDING_CHANGED'});
  assert.throws(() => routeProject(f.registry, 'project-a'), {code: 'PROJECT_BINDING_CHANGED'});
});

test('wrong project bindings and reused coordinator or project owner identities are rejected', t => {
  const f = fixture(t), file = f.bindings['project-b'], original = fs.readFileSync(file);
  assert.throws(() => registerPortfolio({...f.registryData, bindings: {...f.bindings, 'project-a': file}}), {code: 'PROJECT_BINDING_CHANGED'});
  for (const pmThreadId of [coordinator, f.configs['project-a'].pmThreadId]) {
    writeJson(file, {...f.configs['project-b'], pmThreadId});
    assert.throws(() => registerPortfolio(f.registryData), {code: 'PROJECT_ACTOR_OVERLAP'});
  }
  fs.writeFileSync(file, original);
  assert.equal(fs.existsSync(f.registryData.controlRoot), false);
});

test('shared and nested work, knowledge and control roots are rejected before storage is created', t => {
  const f = fixture(t), a = f.configs['project-a'], b = f.configs['project-b'];
  const bFile = f.bindings['project-b'], bBytes = fs.readFileSync(bFile);
  writeJson(bFile, {...b, vaultRoot: a.vaultRoot, externalVaultRoot: a.vaultRoot});
  assert.throws(() => registerPortfolio(f.registryData), {code: 'PROJECT_ROOT_OVERLAP'});
  fs.writeFileSync(bFile, bBytes);
  writeJson(f.bindings['project-a'], {...a, workRoot: path.join(a.controlRoot, 'work')});
  assert.throws(() => registerPortfolio(f.registryData), {code: 'PROJECT_ROOT_OVERLAP'});
  writeJson(f.bindings['project-a'], {...a, vaultRoot: path.join(a.controlRoot, 'knowledge')});
  assert.throws(() => registerPortfolio(f.registryData), {code: 'PROJECT_ROOT_OVERLAP'});
  writeJson(f.bindings['project-a'], a);
  assert.throws(() => registerPortfolio({...f.registryData, controlRoot: path.join(a.projectRoot, 'portfolio')}), {code: 'PROJECT_ROOT_OVERLAP'});
  assert.equal(fs.existsSync(f.registryData.controlRoot), false);
});

test('repository-root work directories may contain their own separate control and knowledge subdirectories', t => {
  const f = fixture(t), a = f.configs['project-a'];
  writeJson(f.bindings['project-a'], {...a, workRoot: a.projectRoot});
  assert.equal(registerPortfolio(f.registryData).reused, false);
  const cfg = routeProject(f.registryData, 'project-a'); assert.equal(cfg.workRoot, a.projectRoot);
  for (const file of ['control/state.sqlite', 'knowledge/contract.md']) {
    assert.throws(() => prepare(cfg, {projectId: cfg.projectId, id: 'reserved-path', mode: 'direct', reason: 'Ownership protection', objective: 'Forbidden private write', tasks: [{id: 'bad', objective: 'Forbidden private write', files: [file]}], checks: [{id: 'no', command: process.execPath, args: ['-e', 'process.exit(0)']}]}), /knowledge or control/);
  }
});

test('registry and project bindings must use real absolute paths without symlink aliases', t => {
  const f = fixture(t);
  assert.throws(() => loadPortfolioRegistry('registry.json'), {code: 'PORTFOLIO_INVALID'});
  assert.throws(() => registerPortfolio({...f.registryData, bindings: {...f.bindings, 'project-a': 'project-a/project.json'}}), {code: 'PORTFOLIO_INVALID'});
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.configs['project-a'].projectRoot, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => registerPortfolio({...f.registryData, bindings: {...f.bindings, 'project-a': path.join(alias, 'project.json')}}), /Symlink|junction/);
  assert.throws(() => routeProject(f.registry, 'project-a'), {code: 'PORTFOLIO_NOT_REGISTERED'});
});

test('public portfolio example contains only a valid portable manifest', () => {
  const example = JSON.parse(fs.readFileSync(new URL('../examples/portfolio.example.json', import.meta.url), 'utf8'));
  assert.equal(validatePortfolio(example).projects.length, 3);
  assert.equal(Object.hasOwn(example, 'bindings'), false); assert.equal(Object.hasOwn(example, 'coordinatorThreadId'), false);
});
