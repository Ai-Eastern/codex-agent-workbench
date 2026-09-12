import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepare,advance,getPacket,submitResult,status,pause,claimNative,bindNative} from '../src/workflow.mjs';
import {digest,writeJson} from '../src/contracts.mjs';

function fixture(t,mode='direct',files=['result.txt']){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-submit-'));
  t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const cfg={projectId:'fixture',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:1,model:'gpt-5.5',thinking:'low',captureEnabled:true,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{A:'22222222-2222-4222-8222-222222222222'}};
  const req={id:'run',objective:'submit completed artifact',mode,reason:'test',tasks:[{id:'A',objective:'write file',files}],checks:[{id:'ok',command:process.execPath,args:['-e','process.exit(0)']}]};
  const old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=cfg.pmThreadId;t.after(()=>{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;});
  prepare(cfg,req);return {cfg,req};
}
const submit=(cfg,p,extra={})=>submitResult(cfg,p.runId,p.taskId,{expectedAttemptId:p.attemptId,summary:'实现完成，等待正式验收',...extra});

test('submit derives identity and hashes, leaves acceptance to continue and refuses overwrite',async t=>{
  const {cfg}=fixture(t);await advance(cfg,'run');const p=getPacket(cfg,'run','A');fs.writeFileSync(p.files[0],'done');
  const r=submit(cfg,p,{knowledgeCandidate:{id:'lesson',title:'lesson',body:'verified boundary',kind:'solution'}}),bytes=fs.readFileSync(p.receiptPath),saved=JSON.parse(bytes);
  assert.equal(r.status,'SUBMITTED');assert.equal(saved.attemptId,p.attemptId);assert.deepEqual(saved.artifactHashes,{'result.txt':digest('done')});assert.equal(saved.tests,undefined);assert.equal(saved.acceptance,undefined);assert.equal(status(cfg,'run').status,'RUNNING');
  assert.throws(()=>submit(cfg,p),/exist/i);assert.deepEqual(fs.readFileSync(p.receiptPath),bytes);
  let checks=0;assert.equal((await advance(cfg,'run',{commandRunner:()=>{checks++;return {exitCode:0};}})).status,'COMPLETE');assert.equal(checks,1);
});
test('submit rejects stale attempt, wrong actor, missing artifacts, paused run and altered packet',async t=>{
  const {cfg}=fixture(t);await advance(cfg,'run');const p=getPacket(cfg,'run','A');
  assert.throws(()=>submit(cfg,p,{expectedAttemptId:'stale'}),/attempt/i);
  process.env.CODEX_THREAD_ID=cfg.workerThreads.A;assert.throws(()=>submit(cfg,p),/actor/i);process.env.CODEX_THREAD_ID=cfg.pmThreadId;
  assert.throws(()=>submit(cfg,p),/Missing/);fs.writeFileSync(p.files[0],'done');
  const packetFile=path.join(cfg.controlRoot,'runs/run/packets/A.json'),old=fs.readFileSync(packetFile);writeJson(packetFile,{...JSON.parse(old),objective:'changed'});
  assert.throws(()=>submit(cfg,p),/packet/i);fs.writeFileSync(packetFile,old);pause(cfg,'run');assert.throws(()=>submit(cfg,p),/authorized/i);assert.equal(fs.existsSync(p.receiptPath),false);
});
test('blocked receipt permits absent files and never claims tests or acceptance',async t=>{
  const {cfg}=fixture(t);await advance(cfg,'run');const p=getPacket(cfg,'run','A');submit(cfg,p,{status:'blocked',summary:'输入缺失'});
  const r=JSON.parse(fs.readFileSync(p.receiptPath));assert.deepEqual(r.artifactHashes,{'result.txt':null});assert.equal(r.status,'blocked');
  const result=await advance(cfg,'run',{commandRunner:()=>{throw Error('must not run');}});assert.equal(result.status,'BLOCKED');
});
test('generated result refuses changed artifacts before acceptance',async t=>{
  const {cfg}=fixture(t);await advance(cfg,'run');const p=getPacket(cfg,'run','A');fs.writeFileSync(p.files[0],'before');submit(cfg,p);fs.writeFileSync(p.files[0],'after');
  await assert.rejects(advance(cfg,'run',{commandRunner:()=>{throw Error('must not run');}}),/artifact/i);
});
test('native submit requires the actually bound worker and cannot submit before binding',async t=>{
  const {cfg}=fixture(t,'native');await advance(cfg,'run');const p=claimNative(cfg,'run','A');fs.writeFileSync(p.files[0],'done');
  assert.throws(()=>submit(cfg,p),/authorized/i);
  const child='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';bindNative(cfg,'run','A',child);assert.throws(()=>submit(cfg,p),/actor/i);process.env.CODEX_THREAD_ID=child;
  assert.equal(submit(cfg,p).status,'SUBMITTED');assert.equal((await advance(cfg,'run',{commandRunner:()=>({exitCode:0})})).status,'COMPLETE');
});
test('legal backslash contract paths bind the same artifact at submission and acceptance',async t=>{
  const {cfg}=fixture(t,'direct',['nested\\result.txt']);await advance(cfg,'run');const p=getPacket(cfg,'run','A');fs.mkdirSync(path.dirname(p.files[0]),{recursive:true});fs.writeFileSync(p.files[0],'done');submit(cfg,p);
  assert.equal((await advance(cfg,'run',{commandRunner:()=>({exitCode:0})})).status,'COMPLETE');
});
test('desktop submit belongs to the acknowledged worker and still waits for its completed turn',async t=>{
  const {cfg}=fixture(t,'langgraph');let sent=false,completed=false;
  const desktop={read:async()=>({id:cfg.workerThreads.A,archived:false,status:sent&&!completed?'active':'idle',turnId:sent?'new-turn':'baseline',turnStatus:sent&&!completed?'inProgress':'completed'}),send:async()=>{sent=true;}};
  await advance(cfg,'run',{desktop});const p=getPacket(cfg,'run','A');fs.writeFileSync(p.files[0],'done');assert.throws(()=>submit(cfg,p),/actor/i);process.env.CODEX_THREAD_ID=cfg.workerThreads.A;submit(cfg,p);process.env.CODEX_THREAD_ID=cfg.pmThreadId;
  let calls=0;assert.equal((await advance(cfg,'run',{desktop,commandRunner:()=>{calls++;return {exitCode:0};}})).status,'RUNNING');assert.equal(calls,0);completed=true;
  assert.equal((await advance(cfg,'run',{desktop,commandRunner:()=>{calls++;return {exitCode:0};}})).status,'COMPLETE');assert.equal(calls,1);
});
