import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {parsePlanMarkdown, publishPlan, activePlan, planRevision} from '../src/plan.mjs';
import {prepare, getPacket} from '../src/workflow.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-plan-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const cfg = {projectId:'fixture', projectRoot:root, controlRoot:path.join(root,'control'), workRoot:path.join(root,'work'), vaultRoot:path.join(root,'knowledge'), maxWorkers:3, model:'gpt-6-astra', thinking:'ultra', pmThreadId:'11111111-1111-4111-8111-111111111111', workerThreads:{}};
  const previous = process.env.CODEX_THREAD_ID; process.env.CODEX_THREAD_ID = cfg.pmThreadId;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_THREAD_ID; else process.env.CODEX_THREAD_ID = previous; });
  const plan = {schemaVersion:1, projectId:'fixture', planId:'delivery', revision:1, objective:'Deliver a versioned artifact', constraints:['Keep public API stable'], phases:[{id:'build', dependsOn:[], maxNativeWorkers:1}], tasks:[{id:'write', revision:1, phaseId:'build', dependsOn:[], executor:'direct', files:['result.txt'], contextRefs:[], acceptanceRefs:['exact-value-v1']}]};
  return {root,cfg,plan};
}

test('one marked JSON block is the only executable part of a Markdown plan', t => {
  const {cfg,plan} = fixture(t), block = `<!-- workbench-plan -->\n\`\`\`json\n${JSON.stringify(plan)}\n\`\`\`\n<!-- /workbench-plan -->`;
  assert.equal(parsePlanMarkdown(`Ignore this shell prose\n${block}\n\`\`\`sh\nfalse\n\`\`\``,cfg).planId,plan.planId);
  assert.throws(() => parsePlanMarkdown(block+'\n'+block,cfg), {code:'PLAN_INVALID'});
  assert.throws(() => parsePlanMarkdown(JSON.stringify(plan),cfg), {code:'PLAN_INVALID'});
});

test('publishing is a CAS, preserves old snapshots and does not rewrite legacy attempts', t => {
  const {cfg,plan} = fixture(t);
  const req = {id:'legacy', mode:'direct', objective:'legacy unchanged', reason:'bounded', tasks:[{id:'old',objective:'write',files:['old.txt']}], checks:[{id:'ok',command:process.execPath,args:['-e','process.exit(0)']}]};
  prepare(cfg,req); const packet = getPacket(cfg,'legacy','old');
  const first = publishPlan(cfg,plan,{expectedRevision:0,reason:'Initial authorized plan'}), bytes = fs.readFileSync(first.snapshot);
  const next = {...plan,revision:2,objective:'Revised scope'};
  const second = publishPlan(cfg,next,{expectedRevision:1,reason:'User changes scope'});
  assert.equal(activePlan(cfg).planHash,second.planHash);
  assert.deepEqual(fs.readFileSync(first.snapshot),bytes);
  assert.deepEqual(planRevision(cfg,plan.planId,1).plan,first.plan);
  assert.deepEqual(getPacket(cfg,'legacy','old'),packet);
  assert.throws(() => publishPlan(cfg,next,{expectedRevision:1,reason:'Stale writer'}),{code:'PLAN_CONFLICT'});
  assert.equal(activePlan(cfg).plan.revision,2);
});

test('wrong actor and project cannot publish and snapshot tampering fails closed', t => {
  const {cfg,plan} = fixture(t);
  process.env.CODEX_THREAD_ID = 'wrong';
  assert.throws(() => publishPlan(cfg,plan,{expectedRevision:0,reason:'wrong actor'}),{code:'ACTOR_MISMATCH'});
  assert.equal(fs.existsSync(cfg.controlRoot),false);
  process.env.CODEX_THREAD_ID = cfg.pmThreadId;
  assert.throws(() => publishPlan(cfg,{...plan,projectId:'other'},{expectedRevision:0,reason:'wrong project'}),/project/i);
  const first = publishPlan(cfg,plan,{expectedRevision:0,reason:'initial'});
  fs.appendFileSync(first.snapshot,' ');
  assert.throws(() => activePlan(cfg),{code:'INPUT_STALE'});
  assert.throws(() => publishPlan(cfg,{...plan,revision:2},{expectedRevision:1,reason:'do not erase evidence'}),{code:'INPUT_STALE'});
});

test('snapshot write failure never activates a half-written plan', t => {
  const {cfg,plan} = fixture(t), write = fs.writeFileSync;
  t.mock.method(fs,'writeFileSync',function(file,...rest) {
    if (typeof file === 'number') { write(file,'{'); throw Error('simulated disk failure'); }
    return write(file,...rest);
  });
  assert.throws(() => publishPlan(cfg,plan,{expectedRevision:0,reason:'initial'}),/disk failure/);
  t.mock.restoreAll(); assert.equal(activePlan(cfg),null);
  assert.throws(() => publishPlan(cfg,plan,{expectedRevision:0,reason:'preserve broken snapshot'}),{code:'INPUT_STALE'});
});

test('concurrent publishers cannot both activate the same expected revision', async t => {
  const {cfg,plan} = fixture(t); publishPlan(cfg,plan,{expectedRevision:0,reason:'initial'});
  const module = pathToFileURL(path.resolve('src/plan.mjs')).href;
  const run = objective => new Promise((resolve,reject) => {
    const script = `import {publishPlan} from ${JSON.stringify(module)};try{publishPlan(${JSON.stringify(cfg)},${JSON.stringify({...plan,revision:2,objective})},{expectedRevision:1,reason:'race'});process.stdout.write('ok')}catch(e){process.stdout.write(e.code||e.message);process.exitCode=e.code==='PLAN_CONFLICT'?2:3}`;
    const child = spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,CODEX_THREAD_ID:cfg.pmThreadId},windowsHide:true});
    let stdout='',stderr=''; child.stdout.on('data',b=>stdout+=b); child.stderr.on('data',b=>stderr+=b); child.on('error',reject); child.on('close',code=>resolve({code,stdout,stderr}));
  });
  const results = await Promise.all([run('first writer'),run('second writer')]);
  assert.deepEqual(results.map(r=>r.code).sort(),[0,2],JSON.stringify(results));
  assert.equal(activePlan(cfg).plan.revision,2);
  const db = new DatabaseSync(path.join(cfg.controlRoot,'state.sqlite'),{readOnly:true});
  try { assert.equal(db.prepare('SELECT COUNT(*) AS n FROM plans').get().n,2); }
  finally { db.close(); }
});
