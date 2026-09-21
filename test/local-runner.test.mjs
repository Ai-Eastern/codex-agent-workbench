import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {runLocalTask, readLocalTask, continueLocalTask, repairLocalTask} from '../src/local-runner.mjs';

// All coding executors in this suite are explicit fakes; Git, workflow and acceptance run locally.
// These tests never invoke Codex or a real model.
function fixture(t) {
  const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'workbench-local-runner-'));
  const repository=path.join(root,'repo'),stateRoot=path.join(root,'state');
  fs.mkdirSync(repository);
  const git=(...args)=>execFileSync('git',args,{cwd:repository,encoding:'utf8',windowsHide:true});
  git('init','-q');
  fs.writeFileSync(path.join(repository,'value.txt'),'before');
  fs.writeFileSync(path.join(repository,'acceptance.mjs'),"import fs from 'node:fs';if(fs.readFileSync('value.txt','utf8')!=='fixed')process.exit(1);\n");
  git('add','.');git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','baseline');
  const head=git('rev-parse','HEAD').trim();
  fs.writeFileSync(path.join(repository,'value.txt'),'personal-uncommitted-work');
  const originalStatus=git('status','--porcelain');
  t.after(()=>{
    assert(root.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep+'workbench-local-runner-'));
    if(fs.existsSync(stateRoot))for(const entry of fs.readdirSync(path.join(stateRoot,'runs'),{withFileTypes:true})) {
      const worktree=path.join(stateRoot,'runs',entry.name,'worktree');
      if(fs.existsSync(worktree))git('worktree','remove','--force',worktree);
    }
    fs.rmSync(root,{recursive:true,force:true});
  });
  const request={id:'fix-value',objective:'Fix value without editing the acceptance script',files:['value.txt'],acceptanceFiles:['acceptance.mjs'],checks:[{id:'value',command:'node',args:['acceptance.mjs']}]};
  return {root,repository,stateRoot,request,git,head,originalStatus};
}

test('real worktree and acceptance produce a patch, preserve dirty source, and do not rerun completed tasks',async t=>{
  const f=fixture(t);let calls=0;
  const executor=async ({cwd,prompt})=>{
    calls++;assert.match(prompt,/value\.txt/);fs.writeFileSync(path.join(cwd,'value.txt'),'fixed');
    return {status:'completed',summary:'Changed value',exitCode:0,threadId:'test-process',usage:{input_tokens:1,output_tokens:1}};
  };
  const result=await runLocalTask({...f,executor});
  assert.equal(result.phase,'READY_FOR_REVIEW');assert.equal(result.delivery.acceptance.passed,true);
  assert.equal(result.locked,false);assert.equal(fs.existsSync(path.join(result.runDirectory,'execution.lock')),false);
  assert.match(fs.readFileSync(result.patch.path,'utf8'),/\+fixed/);
  assert.equal(f.git('rev-parse','HEAD').trim(),f.head);assert.equal(f.git('status','--porcelain'),f.originalStatus);
  assert.equal(fs.readFileSync(path.join(f.repository,'value.txt'),'utf8'),'personal-uncommitted-work');
  assert.equal((await runLocalTask({...f,executor})).reused,true);
  const continued=await continueLocalTask({stateRoot:f.stateRoot,id:f.request.id});
  assert.equal(continued.reused,true);assert.equal(continued.locked,false);
  assert.equal(calls,1);
  await assert.rejects(runLocalTask({...f,request:{...f.request,objective:'changed'},executor}),/different/);
  const manifest=path.join(result.runDirectory,'run.json'),before=fs.readFileSync(manifest,'utf8');
  await assert.rejects(repairLocalTask({stateRoot:f.stateRoot,id:f.request.id,reason:'Invalid repair of a successful run',executor}),/confirmed acceptance failure/);
  assert.equal(fs.readFileSync(manifest,'utf8'),before);
  fs.appendFileSync(path.join(result.workspace.directory,'value.txt'),'tampered');
  assert.equal(readLocalTask({stateRoot:f.stateRoot,id:f.request.id}).phase,'EVIDENCE_CHANGED');
});

test('failed acceptance persists until explicit bounded repair through the real controller',async t=>{
  const f=fixture(t);let calls=0;
  const executor=async ({cwd})=>{calls++;fs.writeFileSync(path.join(cwd,'value.txt'),calls===1?'wrong':'fixed');return {status:'completed',summary:'candidate',exitCode:0};};
  const failed=await runLocalTask({...f,executor});
  assert.equal(failed.phase,'FAILED_ACCEPTANCE');assert.equal(failed.acceptance.passed,false);
  assert.equal(failed.locked,false);
  const oldAttempt=failed.attemptId;
  assert.equal((await runLocalTask({...f,executor})).phase,'FAILED_ACCEPTANCE');assert.equal(calls,1);
  const repaired=await repairLocalTask({stateRoot:f.stateRoot,id:f.request.id,reason:'Fix the value rejected by acceptance',executor});
  assert.equal(repaired.phase,'READY_FOR_REVIEW');assert.notEqual(repaired.attemptId,oldAttempt);assert.equal(calls,2);
  assert.equal(repaired.locked,false);assert.equal(fs.existsSync(path.join(repaired.runDirectory,'execution.lock')),false);
  const archived=path.join(repaired.runDirectory,'control/runs/fix-value/history',`repair-${oldAttempt}`,'acceptance.json');
  assert.equal(JSON.parse(fs.readFileSync(archived)).passed,false);
});

test('out-of-scope and protected test edits cannot reach acceptance or patch delivery',async t=>{
  const f=fixture(t);
  await assert.rejects(runLocalTask({...f,executor:async ({cwd})=>{
    fs.writeFileSync(path.join(cwd,'value.txt'),'fixed');
    fs.writeFileSync(path.join(cwd,'acceptance.mjs'),'process.exit(0);');
    return {status:'completed',summary:'changed checks',exitCode:0};
  }}),/acceptance files changed/);
  const result=readLocalTask({stateRoot:f.stateRoot,id:f.request.id});
  assert.equal(result.phase,'BLOCKED');assert.equal(result.patch,undefined);
  assert.equal(f.git('status','--porcelain'),f.originalStatus);
});

test('interrupted execution is retained and never silently restarted',async t=>{
  const f=fixture(t);let calls=0;
  const executor=async()=>{calls++;return {status:'interrupted',reason:'ABORTED',exitCode:null,summary:''};};
  const first=await runLocalTask({...f,executor});assert.equal(first.phase,'BLOCKED');assert.equal(first.locked,false);
  assert.equal((await runLocalTask({...f,executor})).phase,'BLOCKED');assert.equal(calls,1);
  const manifest=path.join(first.runDirectory,'run.json'),before=fs.readFileSync(manifest,'utf8');
  await assert.rejects(continueLocalTask({stateRoot:f.stateRoot,id:f.request.id}),/Cannot continue BLOCKED/);
  assert.equal(fs.readFileSync(manifest,'utf8'),before);
  await assert.rejects(runLocalTask({...f,stateRoot:path.join(f.repository,'state'),executor}),/outside/);
});

test('repair executor exceptions persist BLOCKED and release the real lock',async t=>{
  const f=fixture(t);
  const failed=await runLocalTask({...f,executor:async ({cwd})=>{
    fs.writeFileSync(path.join(cwd,'value.txt'),'wrong');return {status:'completed',summary:'fake candidate',exitCode:0};
  }});
  await assert.rejects(repairLocalTask({stateRoot:f.stateRoot,id:f.request.id,reason:'Repair a confirmed failure',executor:async()=>{
    throw Error('fake executor crashed');
  }}),/fake executor crashed/);
  const result=readLocalTask({stateRoot:f.stateRoot,id:f.request.id});
  assert.equal(result.phase,'BLOCKED');assert.equal(result.locked,false);
  assert.match(result.error,/fake executor crashed/);assert.notEqual(result.attemptId,failed.attemptId);
  assert.equal(fs.existsSync(path.join(result.runDirectory,'execution.lock')),false);
});

for(const matching of [true,false])test(`continue ${matching?'recovers':'rejects'} an orphan patch by comparing accepted artifacts without rerunning the fake executor`,async t=>{
  const f=fixture(t);let calls=0;
  const result=await runLocalTask({...f,executor:async ({cwd})=>{
    calls++;fs.writeFileSync(path.join(cwd,'value.txt'),'fixed');return {status:'completed',summary:'fake candidate',exitCode:0};
  }});
  const manifest=path.join(result.runDirectory,'run.json'),interrupted=JSON.parse(fs.readFileSync(manifest,'utf8'));
  interrupted.phase='ACCEPTING';delete interrupted.patch;
  fs.writeFileSync(manifest,JSON.stringify(interrupted,null,2)+'\n');
  if(!matching)fs.appendFileSync(result.patch.path,'unbound patch fixture\n');
  const before=fs.readFileSync(result.patch.path);
  if(matching) {
    const recovered=await continueLocalTask({stateRoot:f.stateRoot,id:f.request.id});
    assert.equal(recovered.phase,'READY_FOR_REVIEW');assert.equal(recovered.locked,false);
    assert.equal(recovered.patch.sha256,result.patch.sha256);assert.equal(recovered.patch.path,result.patch.path);
  } else {
    await assert.rejects(continueLocalTask({stateRoot:f.stateRoot,id:f.request.id}),/Unbound candidate patch does not match/);
    const blocked=readLocalTask({stateRoot:f.stateRoot,id:f.request.id});
    assert.equal(blocked.phase,'BLOCKED');assert.equal(blocked.locked,false);assert.equal(blocked.patch,undefined);
    assert.match(blocked.error,/Unbound candidate patch does not match/);
  }
  assert.equal(calls,1);assert.deepEqual(fs.readFileSync(result.patch.path),before);
  assert.equal(fs.existsSync(path.join(result.runDirectory,'execution.lock')),false);
  assert.equal(fs.readdirSync(path.join(result.runDirectory,'recovery-patches')).length,1);
});
