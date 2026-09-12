import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {prepare,advance,getPacket,claimNative,bindNative,repairTask,status} from '../src/workflow.mjs';
import {writeJson} from '../src/contracts.mjs';

function fixture(t,mode){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-task-time-'));
  t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'workbench-task-time-'));fs.rmSync(root,{recursive:true,force:true});});
  const cfg={projectId:'timing',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:1,model:'gpt-5.6-luna',thinking:'medium',captureEnabled:false,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{A:'22222222-2222-4222-8222-222222222222'}};
  prepare(cfg,{projectId:'timing',id:'sample',objective:'bounded time evidence',mode,reason:'lifecycle contract',tasks:[{id:'A',objective:'write value',files:['value.txt']}],checks:[{id:'value',command:'node',args:['-e','process.exit(0)']}]});
  return cfg;
}
function events(cfg){const db=new DatabaseSync(path.join(cfg.controlRoot,'state.sqlite'),{readOnly:true});try{return db.prepare('SELECT * FROM events ORDER BY id').all().map(e=>({...e,data:JSON.parse(e.data)}));}finally{db.close();}}
function complete(cfg){const p=getPacket(cfg,'sample','A');fs.writeFileSync(p.files[0],'value');writeJson(p.receiptPath,{runId:p.runId,taskId:p.taskId,attemptId:p.attemptId,status:'done',summary:'value',knowledgeIds:[]});return p;}
const passed=async()=>({exitCode:0,elapsedMs:1});

test('assignment and results bind each direct repair attempt without duplicate completion events',async t=>{
  const cfg=fixture(t,'direct');await advance(cfg,'sample');const first=complete(cfg);
  const failed=await advance(cfg,'sample',{commandRunner:async()=>({exitCode:1,elapsedMs:1})});
  repairTask(cfg,'sample','A',{expectedAcceptanceHash:failed.acceptance.hash,reason:'one authorized fixture repair'});
  await advance(cfg,'sample');const second=complete(cfg);await advance(cfg,'sample',{commandRunner:passed});
  const before=events(cfg);await advance(cfg,'sample',{commandRunner:async()=>{throw Error('No repeated acceptance');}});
  assert.deepEqual(events(cfg),before);
  for(const kind of ['task_assigned','task_result']){const es=before.filter(e=>e.kind===kind);assert.deepEqual(es.map(e=>e.data.attemptId),[first.attemptId,second.attemptId]);assert.ok(es.every(e=>e.data.threadId===cfg.pmThreadId));}
});
test('native claim and binding retain attempt identity and idempotent binding adds no event',async t=>{
  const cfg=fixture(t,'native');await advance(cfg,'sample');const p=claimNative(cfg,'sample','A'),child='33333333-3333-4333-8333-333333333333';
  bindNative(cfg,'sample','A',child);const before=events(cfg);bindNative(cfg,'sample','A',child);assert.deepEqual(events(cfg),before);
  complete(cfg);await advance(cfg,'sample',{commandRunner:passed});
  const es=events(cfg).filter(e=>['task_assigned','native_claim','native_bound','task_result'].includes(e.kind));
  assert.equal(es.length,4);assert.ok(es.every(e=>e.data.attemptId===p.attemptId));assert.equal(es.at(-1).data.threadId,child);
});
test('desktop ack is distinct from observed activity; existing polls record activity once',async t=>{
  const cfg=fixture(t,'langgraph');let reads=0,sends=0;
  let view={id:cfg.workerThreads.A,archived:false,status:'idle',turnId:'baseline',turnStatus:'completed'};
  const desktop={read:async()=>{reads++;return view;},send:async()=>{sends++;return {ok:true};}};
  await advance(cfg,'sample',{desktop});let es=events(cfg);assert.equal(es.filter(e=>e.kind==='dispatch_ack').length,1);assert.equal(es.filter(e=>e.kind==='turn_started_observed').length,0);
  await advance(cfg,'sample',{desktop});assert.equal(events(cfg).filter(e=>e.kind==='turn_started_observed').length,0);
  view={...view,status:'active',turnId:'new-turn',turnStatus:'inProgress'};
  await advance(cfg,'sample',{desktop});await advance(cfg,'sample',{desktop});assert.equal(events(cfg).filter(e=>e.kind==='turn_started_observed').length,1);
  const before=events(cfg);status(cfg,'sample');assert.deepEqual(events(cfg),before);
  const p=complete(cfg);view={...view,status:'idle',turnStatus:'completed'};await advance(cfg,'sample',{desktop,commandRunner:passed});
  es=events(cfg).filter(e=>['dispatch_intent','dispatch_ack','turn_started_observed','task_result'].includes(e.kind));
  assert.equal(es.length,4);assert.ok(es.every(e=>e.data.attemptId===p.attemptId));assert.equal(es.at(-1).data.turnId,'new-turn');
  assert.equal(sends,1);assert.equal(reads,5); // One preflight, then four ordinary collections; no telemetry polling.
});
test('uncertain send never emits an ack or activity and cannot resend',async t=>{
  const cfg=fixture(t,'langgraph');let sends=0;const desktop={read:async id=>({id,archived:false,status:'idle',turnId:'baseline',turnStatus:'completed'}),send:async()=>{sends++;throw Error('Lost acknowledgement');}};
  assert.equal((await advance(cfg,'sample',{desktop})).status,'BLOCKED');await advance(cfg,'sample',{desktop});
  assert.equal(sends,1);const es=events(cfg);assert.equal(es.filter(e=>e.kind==='dispatch_failed').length,1);assert.equal(es.filter(e=>['dispatch_ack','turn_started_observed'].includes(e.kind)).length,0);
});
