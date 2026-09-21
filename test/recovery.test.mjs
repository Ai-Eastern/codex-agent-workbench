import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as workflow from '../src/workflow.mjs';
import {writeJson,digest,readJson} from '../src/contracts.mjs';

async function failedRun(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-recovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg={projectId:'recovery',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:1,model:'gpt-5.3-codex-spark',thinking:'low',captureEnabled:true,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{}};
  const req={id:'recover',objective:'bounded acceptance recovery',mode:'direct',reason:'single task',tasks:[{id:'A',objective:'write result',files:['result.txt']}],checks:[{id:'business',command:'node',args:['-e','process.exit(0)']},{id:'transient',command:'node',args:['-e','process.exit(0)']}]};
  workflow.prepare(cfg,req);await workflow.advance(cfg,req.id);
  const packet=workflow.getPacket(cfg,req.id,'A');fs.writeFileSync(packet.files[0],'verified artifact');
  writeJson(packet.receiptPath,{runId:req.id,taskId:'A',attemptId:packet.attemptId,status:'done',summary:'done'});
  const calls=[];const result=await workflow.advance(cfg,req.id,{commandRunner:c=>{calls.push(c.id);return {exitCode:c.id==='transient'?23:0};}});
  assert.equal(result.status,'FAILED');
  const file=path.join(cfg.controlRoot,'runs/recover/acceptance.json'),bytes=fs.readFileSync(file),hash=digest(bytes);
  return {cfg,req,file,bytes,hash,calls,grant:{expectedAcceptanceHash:hash,reason:'The separately controlled transient validation condition is now resolved; artifacts unchanged.'}};
}
test('explicit acceptance recovery preserves successful checks and original failure',async t=>{
  const f=await failedRun(t);
  const stopped=await workflow.advance(f.cfg,f.req.id,{commandRunner:()=>{throw Error('Must not automatically retry');}});assert.equal(stopped.status,'FAILED');
  const ready=workflow.retryAcceptance(f.cfg,f.req.id,f.grant);assert.equal(ready.phase,'ACCEPTING');
  assert.throws(()=>workflow.retryAcceptance(f.cfg,f.req.id,f.grant),/FAILED/);
  const result=await workflow.advance(f.cfg,f.req.id,{commandRunner:c=>{f.calls.push(c.id);return {exitCode:0};}});
  assert.equal(result.status,'COMPLETE');assert.deepEqual(f.calls,['business','transient','transient']);
  const archive=path.join(f.cfg.controlRoot,`runs/recover/history/acceptance-${f.hash}.json`);
  assert.deepEqual(fs.readFileSync(archive),f.bytes);assert.equal(readJson(f.file).passed,true);
  assert.equal((await workflow.advance(f.cfg,f.req.id,{commandRunner:()=>{throw Error('Must reuse completed acceptance');}})).reused,true);
});
test('acceptance recovery rejects changed artifacts and stale or tampered evidence',async t=>{
  const f=await failedRun(t);
  assert.throws(()=>workflow.retryAcceptance(f.cfg,f.req.id,{...f.grant,expectedAcceptanceHash:'0'.repeat(64)}),/evidence/);
  fs.writeFileSync(path.join(f.cfg.workRoot,'result.txt'),'changed after validation');
  assert.throws(()=>workflow.retryAcceptance(f.cfg,f.req.id,f.grant),/artifacts/);
  fs.writeFileSync(path.join(f.cfg.workRoot,'result.txt'),'verified artifact');fs.appendFileSync(f.file,' ');
  assert.throws(()=>workflow.retryAcceptance(f.cfg,f.req.id,{...f.grant,expectedAcceptanceHash:digest(fs.readFileSync(f.file))}),/evidence/);
  assert.equal(workflow.status(f.cfg,f.req.id).phase,'FAILED');
});
test('acceptance recovery respects the runner lock and requires an explicit reason',async t=>{
  const f=await failedRun(t);
  assert.throws(()=>workflow.retryAcceptance(f.cfg,f.req.id,{...f.grant,reason:''}),/reason/);
  const lock=path.join(f.cfg.controlRoot,'.runner.lock');fs.writeFileSync(lock,'another owner');
  assert.throws(()=>workflow.retryAcceptance(f.cfg,f.req.id,f.grant),/EEXIST/);assert.equal(fs.readFileSync(lock,'utf8'),'another owner');
  assert.deepEqual(fs.readFileSync(f.file),f.bytes);
});

test('one explicit task repair preserves the run and evidence but starts a new attempt',async t=>{
  const f=await failedRun(t),old=workflow.getPacket(f.cfg,f.req.id,'A');
  const oldActor=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=f.cfg.pmThreadId;
  t.after(()=>{if(oldActor===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=oldActor;});
  const oldResult=fs.readFileSync(old.receiptPath),oldPacket=fs.readFileSync(path.join(f.cfg.controlRoot,'runs/recover/packets/A.json'));
  const ready=workflow.repairTask(f.cfg,f.req.id,'A',f.grant);
  assert.equal(ready.status,'RUNNING');assert.equal(ready.tasks[0].status,'PENDING');
  const current=workflow.getPacket(f.cfg,f.req.id,'A');assert.notEqual(current.attemptId,old.attemptId);assert.deepEqual(current.files,old.files);
  assert.equal(current.runId,old.runId);assert.match(current.prompt,/REPAIR/);
  const archive=path.join(f.cfg.controlRoot,`runs/recover/history/repair-${old.attemptId}`);
  assert.deepEqual(fs.readFileSync(path.join(archive,'result.json')),oldResult);assert.deepEqual(fs.readFileSync(path.join(archive,'packet.json')),oldPacket);
  assert.deepEqual(fs.readFileSync(path.join(archive,'acceptance.json')),f.bytes);
  for(let i=0;i<2;i++){
    const waiting=await workflow.advance(f.cfg,f.req.id);assert.equal(waiting.status,'RUNNING');assert.equal(waiting.tasks[0].status,'ASSIGNED');
  }
  assert.notEqual(current.receiptPath,old.receiptPath);assert.equal(fs.existsSync(current.receiptPath),false);
  assert.deepEqual(fs.readFileSync(old.receiptPath),oldResult);
  fs.writeFileSync(current.files[0],'repaired artifact');
  const submitted=workflow.submitResult(f.cfg,f.req.id,'A',{expectedAttemptId:current.attemptId,summary:'repaired'});
  assert.equal(submitted.status,'SUBMITTED');assert.equal(submitted.receiptPath,current.receiptPath);
  const calls=[];const done=await workflow.advance(f.cfg,f.req.id,{commandRunner:c=>{calls.push(c.id);return {exitCode:0};}});
  assert.equal(done.status,'COMPLETE');assert.deepEqual(calls,['business','transient']);
  assert.deepEqual(fs.readFileSync(old.receiptPath),oldResult);assert.deepEqual(fs.readFileSync(path.join(archive,'result.json')),oldResult);
  assert.throws(()=>workflow.repairTask(f.cfg,f.req.id,'A',f.grant),/FAILED/);
});

test('task repair rejects drift, invalid task, locks and a second repair attempt',async t=>{
  const f=await failedRun(t);
  assert.throws(()=>workflow.repairTask(f.cfg,f.req.id,'A',{...f.grant,reason:''}),/reason/);
  assert.throws(()=>workflow.repairTask(f.cfg,f.req.id,'B',f.grant),/single/);
  assert.throws(()=>workflow.repairTask(f.cfg,f.req.id,'A',{...f.grant,expectedAcceptanceHash:'0'.repeat(64)}),/evidence/);
  const file=path.join(f.cfg.workRoot,'result.txt');fs.writeFileSync(file,'unauthorized drift');
  assert.throws(()=>workflow.repairTask(f.cfg,f.req.id,'A',f.grant),/artifacts/);fs.writeFileSync(file,'verified artifact');
  const lock=path.join(f.cfg.controlRoot,'.runner.lock');fs.writeFileSync(lock,'other owner');
  assert.throws(()=>workflow.repairTask(f.cfg,f.req.id,'A',f.grant),/EEXIST/);assert.equal(fs.readFileSync(lock,'utf8'),'other owner');fs.unlinkSync(lock);
  workflow.repairTask(f.cfg,f.req.id,'A',f.grant);await workflow.advance(f.cfg,f.req.id);
  const p=workflow.getPacket(f.cfg,f.req.id,'A');writeJson(p.receiptPath,{runId:f.req.id,taskId:'A',attemptId:p.attemptId,status:'done',summary:'still failing'});
  await workflow.advance(f.cfg,f.req.id,{commandRunner:()=>({exitCode:1})});
  assert.throws(()=>workflow.repairTask(f.cfg,f.req.id,'A',{...f.grant,expectedAcceptanceHash:digest(fs.readFileSync(f.file))}),/budget/);
});

test('a timed-out or otherwise unknown command result cannot enter recovery',async t=>{
  const f=await failedRun(t);workflow.retryAcceptance(f.cfg,f.req.id,f.grant);
  await workflow.advance(f.cfg,f.req.id,{commandRunner:()=>({exitCode:null,error:'ETIMEDOUT'})});
  const grant={...f.grant,expectedAcceptanceHash:digest(fs.readFileSync(f.file))};
  assert.throws(()=>workflow.retryAcceptance(f.cfg,f.req.id,grant),/confirmed command/);
  assert.throws(()=>workflow.repairTask(f.cfg,f.req.id,'A',grant),/confirmed command/);
});
