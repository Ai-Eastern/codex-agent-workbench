import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {prepare,advance,status,getPacket,repairTask,retryAcceptance,pause} from '../src/workflow.mjs';
import {writeJson} from '../src/contracts.mjs';
import {continueGate} from '../src/continue-gate.mjs';

function fixture(t,mode='direct'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-gate-'));
  t.after(()=>{assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'workbench-gate-'));fs.rmSync(root,{recursive:true,force:true});});
  const cfg={projectId:'gate',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:1,model:'gpt-5.6-luna',thinking:'medium',captureEnabled:true,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{A:'22222222-2222-4222-8222-222222222222'}};
  prepare(cfg,{id:'probe',projectId:'gate',objective:'bounded continuation test',mode,reason:'gate fixture',tasks:[{id:'A',objective:'write one artifact',files:['value.txt']}],checks:[{id:'contract',command:'node',args:['-e','process.exit(0)']}]});
  return cfg;
}
function receipt(cfg,extra={}){const p=getPacket(cfg,'probe','A');fs.writeFileSync(p.files[0],'fixture');writeJson(p.receiptPath,{runId:p.runId,taskId:p.taskId,attemptId:p.attemptId,status:'done',summary:'fixture output',knowledgeIds:[],...extra});return p;}
const codes=s=>s.continueGate?.signals.map(x=>x.code)??[];
const fail=async()=>({exitCode:1});
const desktop=cfg=>({read:async id=>({id,archived:false,status:'idle',turnId:'initial',turnStatus:'completed'}),send:async()=>{}});
function eventCount(cfg){const db=new DatabaseSync(path.join(cfg.controlRoot,'state.sqlite'),{readOnly:true});try{return db.prepare('SELECT COUNT(*) AS n FROM events').get().n;}finally{db.close();}}

test('normal, waiting, pause and completion add no advice or database queries',()=>{
  const db={prepare(){throw Error('Normal actions must not query history');}};
  for(const action of ['EXECUTE_DIRECT','CLAIM_NATIVE','BIND_NATIVE','WAIT_FOR_WORKERS','WAIT_FOR_USER','REPORT_ACCEPTANCE','CONTINUE_CAPTURE','CONTINUE','RECONCILE_EVIDENCE'])assert.equal(continueGate(db,{id:'r'},[],action,null),null);
});

test('repeated first-batch preflight failures warn without dispatch or status mutation',async t=>{
  const cfg=fixture(t,'langgraph'),d=desktop(cfg);let sends=0;d.send=async()=>sends++;d.read=async id=>({id,archived:false,status:'active',turnId:'busy',turnStatus:'inProgress'});
  await assert.rejects(advance(cfg,'probe',{desktop:d}),/busy/);assert.deepEqual(codes(status(cfg,'probe')),[]);
  await assert.rejects(advance(cfg,'probe',{desktop:d}),/busy/);
  const count=eventCount(cfg),first=status(cfg,'probe');assert.deepEqual(codes(first),['REPEATED_PREFLIGHT_FAILURE']);assert.equal(first.nextAction.type,'START');assert.equal(first.continueGate.signals[0].count,2);
  assert.deepEqual(status(cfg,'probe'),first);assert.equal(eventCount(cfg),count);assert.equal(sends,0);
  const healthy=desktop(cfg);healthy.send=async()=>sends++;const resumed=await advance(cfg,'probe',{desktop:healthy});assert.equal(resumed.nextAction.type,'WAIT_FOR_WORKERS');assert.deepEqual(codes(resumed),[]);assert.equal(sends,1);
  pause(cfg,'probe');assert.deepEqual(codes(status(cfg,'probe')),[]);
});

test('unknown delivery is evidence to preserve, never permission to resend',async t=>{
  const cfg=fixture(t,'langgraph'),d=desktop(cfg);let sends=0;d.send=async()=>{sends++;throw Error('ack unknown');};
  const s=await advance(cfg,'probe',{desktop:d});assert.deepEqual(codes(s),['DELIVERY_UNCONFIRMED']);assert.equal(s.status,'BLOCKED');assert.equal(s.continueGate.advisoryOnly,true);
  await advance(cfg,'probe',{desktop:d,resume:true});assert.equal(sends,1);
});

test('same failed check warns after two recoveries and clears on successful continuation',async t=>{
  const cfg=fixture(t);await advance(cfg,'probe');receipt(cfg);let checks=0;
  const failed=async()=>{checks++;return {exitCode:1};};
  let s=await advance(cfg,'probe',{commandRunner:failed});assert.deepEqual(codes(s),[]);
  for(let i=0;i<2;i++){retryAcceptance(cfg,'probe',{expectedAcceptanceHash:s.acceptance.hash,reason:'explicit fixture external-condition recovery'});s=await advance(cfg,'probe',{commandRunner:failed});}
  assert.deepEqual(codes(s),['REPEATED_ACCEPTANCE_RECOVERY']);assert.equal(s.continueGate.signals[0].checkId,'contract');assert.equal(s.continueGate.signals[0].count,2);
  const count=eventCount(cfg);assert.deepEqual(status(cfg,'probe').continueGate,s.continueGate);assert.equal(eventCount(cfg),count);
  retryAcceptance(cfg,'probe',{expectedAcceptanceHash:s.acceptance.hash,reason:'fixture condition now resolved'});
  s=await advance(cfg,'probe',{commandRunner:async()=>{checks++;return {exitCode:0};}});assert.equal(s.status,'COMPLETE');assert.deepEqual(codes(s),[]);
  await advance(cfg,'probe',{commandRunner:async()=>{throw Error('Completed checks must not run');}});assert.equal(checks,4);
});

test('repair budget survives new attempt; old acceptance recovery counts do not',async t=>{
  const cfg=fixture(t);await advance(cfg,'probe');const original=receipt(cfg);let s=await advance(cfg,'probe',{commandRunner:fail});
  for(let i=0;i<2;i++){retryAcceptance(cfg,'probe',{expectedAcceptanceHash:s.acceptance.hash,reason:'fixture recovery'});s=await advance(cfg,'probe',{commandRunner:fail});}
  repairTask(cfg,'probe','A',{expectedAcceptanceHash:s.acceptance.hash,reason:'one authorized code repair'});assert.deepEqual(codes(status(cfg,'probe')),[]);
  await advance(cfg,'probe');const revised=receipt(cfg);assert.notEqual(revised.attemptId,original.attemptId);
  s=await advance(cfg,'probe',{commandRunner:fail});assert.deepEqual(codes(s),['REPAIR_BUDGET_USED']);assert.equal(s.continueGate.signals[0].count,1);
  assert.throws(()=>repairTask(cfg,'probe','A',{expectedAcceptanceHash:s.acceptance.hash,reason:'unavailable second repair'}),/budget/);
});

test('only current failed check counts, and knowledge capture ignores code-repair history',()=>{
  const db=new DatabaseSync(':memory:');try{
    db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY,run_id TEXT,kind TEXT,data TEXT)');
    const insert=db.prepare('INSERT INTO events(run_id,kind,data) VALUES(?,?,?)');
    for(let i=0;i<3;i++)insert.run('r','acceptance_recovery',JSON.stringify({nextCheck:'other'}));
    insert.run('r','acceptance_recovery',JSON.stringify({nextCheck:'current'}));
    for(let i=0;i<5;i++)insert.run('other-run','acceptance_recovery',JSON.stringify({nextCheck:'current'}));
    const acceptance={verified:true,passed:false,checks:[{id:'current',exitCode:1}]};
    assert.equal(continueGate(db,{id:'r'},[],'DIAGNOSE_FAILURE',acceptance),null);
    insert.run('r','acceptance_recovery',JSON.stringify({nextCheck:'current'}));
    assert.equal(continueGate(db,{id:'r'},[],'DIAGNOSE_FAILURE',{...acceptance,checks:[{id:'current',exitCode:null}]}),null);
    assert.equal(continueGate(db,{id:'r'},[],'DIAGNOSE_FAILURE',{...acceptance,verified:false}),null);
    const unusedDb={prepare(){throw Error('Capture should not query repair history');}};
    assert.deepEqual(continueGate(unusedDb,{id:'r'},[],'REPAIR_KNOWLEDGE',{verified:true,passed:true}).signals.map(s=>s.code),['KNOWLEDGE_ONLY']);
    assert.equal(continueGate(unusedDb,{id:'r'},[],'REPAIR_KNOWLEDGE',{verified:false,passed:true}),null);
  }finally{db.close();}
});
