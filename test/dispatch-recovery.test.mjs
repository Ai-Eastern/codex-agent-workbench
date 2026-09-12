import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {prepare,advance,status,getPacket,reconcileDispatch} from '../src/workflow.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {projectId:'dispatch',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:3,model:'gpt-5.5',thinking:'low',captureEnabled:false,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{A:'22222222-2222-4222-8222-222222222222',B:'33333333-3333-4333-8333-333333333333',C:'44444444-4444-4444-8444-444444444444'}};
}
function request(id='recover'){
  return {id,objective:'bounded dispatch recovery',mode:'langgraph',reason:'test',tasks:[{id:'A',objective:'A',files:['a.txt']},{id:'B',objective:'B',files:['b.txt']}],checks:[{id:'check',command:'node',args:['-e','process.exit(0)']}]};
}
function desktop(cfg,send){
  const read=async id=>({id,status:'idle',archived:false,turnId:id===cfg.workerThreads.A?'baseline-a':'baseline',turnStatus:'completed'});
  return {read,send};
}
test('reconcileDispatch restores one uncertain reservation without sending',async t=>{
  const cfg=fixture(t),req=request();prepare(cfg,req);let sends=0;
  const d=desktop(cfg,async()=>{sends++;throw Object.assign(Error('lost acknowledgement'),{delivery:'UNCONFIRMED_DO_NOT_RETRY'});});
  assert.equal((await advance(cfg,req.id,{desktop:d})).status,'BLOCKED');assert.equal(sends,1);
  const p=getPacket(cfg,req.id,'A');
  const recovered=await reconcileDispatch(cfg,req.id,'A',{expectedAttemptId:p.attemptId,expectedBaseline:'baseline-a',reason:'Maintainer confirmed the send was not delivered.',confirmedNotDelivered:true,desktop:desktop(cfg,async()=>{})});
  assert.equal(recovered.status,'RUNNING');assert.equal(recovered.tasks.find(x=>x.id==='A').status,'PENDING');assert.equal(sends,1);
  assert.ok(fs.existsSync(path.join(cfg.controlRoot,'runs',req.id,'history',`dispatch-${p.attemptId}`,'failure.json')));
  await assert.rejects(reconcileDispatch(cfg,req.id,'A',{expectedAttemptId:p.attemptId,expectedBaseline:'baseline-a',reason:'again',confirmedNotDelivered:true,desktop:desktop(cfg,async()=>{})}),/blocked LangGraph/);
});
test('reconcileDispatch keeps blocked when confirmation or desktop evidence is insufficient',async t=>{
  const cfg=fixture(t),req=request('reject');prepare(cfg,req);
  const d=desktop(cfg,async()=>{throw Object.assign(Error('uncertain'),{delivery:'UNCONFIRMED_DO_NOT_RETRY'});});await advance(cfg,req.id,{desktop:d});
  const p=getPacket(cfg,req.id,'A');
  await assert.rejects(reconcileDispatch(cfg,req.id,'A',{expectedAttemptId:p.attemptId,expectedBaseline:'baseline-a',reason:'x',confirmedNotDelivered:false,desktop:desktop(cfg,async()=>{})}),/confirmation/);
  await assert.rejects(reconcileDispatch(cfg,req.id,'A',{expectedAttemptId:p.attemptId,expectedBaseline:'baseline-a',reason:'x',confirmedNotDelivered:true,desktop:{read:async id=>({id,status:'idle',archived:false,turnId:'changed',turnStatus:'completed'})}}),/baseline/);
  assert.equal(status(cfg,req.id).status,'BLOCKED');
});
test('first batch preflight failure keeps PREPARED and sends nothing',async t=>{
  const cfg=fixture(t),req=request('preflight');prepare(cfg,req);let sends=0;
  const d={read:async id=>({id,status:'idle',archived:true,turnId:'head',turnStatus:'completed'}),send:async()=>{sends++;}};
  await assert.rejects(advance(cfg,req.id,{desktop:d}),/busy or has no readable baseline/);
  const view=status(cfg,req.id);assert.equal(view.status,'PREPARED');assert.equal(view.tasks.every(x=>x.status==='PENDING'),true);assert.equal(sends,0);
  await advance(cfg,req.id,{desktop:desktop(cfg,async()=>{sends++;})});assert.equal(sends,2);
});

test('recovery fails closed on ambiguous availability, changed packets and late artifacts',async t=>{
  const cfg=fixture(t),req=request('guards');prepare(cfg,req);
  const d=desktop(cfg,async()=>{throw Object.assign(Error('uncertain'),{delivery:'UNCONFIRMED_DO_NOT_RETRY'});});
  await advance(cfg,req.id,{desktop:d});
  const p=getPacket(cfg,req.id,'A'),b=getPacket(cfg,req.id,'B');
  const opts={expectedAttemptId:p.attemptId,expectedBaseline:'baseline-a',reason:'explicit diagnosis',confirmedNotDelivered:true,desktop:d};
  for(const archived of [true,undefined])await assert.rejects(reconcileDispatch(cfg,req.id,'A',{...opts,desktop:{read:async id=>({...await d.read(id),archived})}}),/unavailable/);
  await assert.rejects(reconcileDispatch(cfg,req.id,'A',{...opts,expectedBaseline:null}),/baseline are required/);
  const bf=path.join(cfg.controlRoot,'runs',req.id,'packets','B.json'),original=fs.readFileSync(bf);
  fs.writeFileSync(bf,JSON.stringify({...b,objective:'tampered'}));
  await assert.rejects(reconcileDispatch(cfg,req.id,'A',opts),/packet changed/);fs.writeFileSync(bf,original);
  fs.mkdirSync(path.dirname(b.receiptPath),{recursive:true});fs.writeFileSync(b.receiptPath,'{}');
  await assert.rejects(reconcileDispatch(cfg,req.id,'A',opts),/evidence already exists/);fs.unlinkSync(b.receiptPath);
  await assert.rejects(reconcileDispatch(cfg,req.id,'A',{...opts,desktop:{read:async id=>{fs.writeFileSync(b.files[0],'late output');return d.read(id);}}}),/artifact already exists/);
  fs.unlinkSync(b.files[0]);
  await reconcileDispatch(cfg,req.id,'A',opts);
  await advance(cfg,req.id,{desktop:d});
  await assert.rejects(reconcileDispatch(cfg,req.id,'A',opts),/budget is exhausted/);
  assert.equal(status(cfg,req.id).status,'BLOCKED');
});

test('reconciled dispatch blocks a late original turn before any resend',async t=>{
  const cfg=fixture(t),req=request('late-turn');prepare(cfg,req);let sends=0,late=false,first=true;
  const d={read:async id=>({id,status:'idle',archived:false,turnId:id===cfg.workerThreads.A?(late?'late-a':'baseline-a'):'baseline',turnStatus:'completed'}),send:async()=>{sends++;if(first){first=false;throw Object.assign(Error('uncertain'),{delivery:'UNCONFIRMED_DO_NOT_RETRY'});}}};
  await advance(cfg,req.id,{desktop:d});const p=getPacket(cfg,req.id,'A');
  await reconcileDispatch(cfg,req.id,'A',{expectedAttemptId:p.attemptId,expectedBaseline:'baseline-a',reason:'No turn was visible at confirmation.',confirmedNotDelivered:true,desktop:d});late=true;
  await assert.rejects(advance(cfg,req.id,{desktop:d}),/reconciled baseline/i);
  assert.equal(sends,1);assert.equal(status(cfg,req.id).status,'BLOCKED');
});

test('reconciled dispatch blocks artifacts appearing during preflight before any resend',async t=>{
  const cfg=fixture(t),req=request('late-artifact');prepare(cfg,req);let sends=0,first=true;
  const d=desktop(cfg,async()=>{sends++;if(first){first=false;throw Object.assign(Error('uncertain'),{delivery:'UNCONFIRMED_DO_NOT_RETRY'});}});
  await advance(cfg,req.id,{desktop:d});const p=getPacket(cfg,req.id,'A');
  await reconcileDispatch(cfg,req.id,'A',{expectedAttemptId:p.attemptId,expectedBaseline:'baseline-a',reason:'No artifact was visible at confirmation.',confirmedNotDelivered:true,desktop:d});
  let wrote=false;const late={...d,read:async id=>{const view=await d.read(id);if(!wrote){wrote=true;fs.writeFileSync(p.files[0],'late original output');}return view;}};
  await assert.rejects(advance(cfg,req.id,{desktop:late}),/artifact already exists/i);
  assert.equal(sends,1);assert.equal(status(cfg,req.id).status,'BLOCKED');
});

test('legacy reconciliations without frozen evidence cannot dispatch',async t=>{
  const cfg=fixture(t),req=request('legacy-reconcile');prepare(cfg,req);let sends=0,first=true;
  const d=desktop(cfg,async()=>{sends++;if(first){first=false;throw Object.assign(Error('uncertain'),{delivery:'UNCONFIRMED_DO_NOT_RETRY'});}});
  await advance(cfg,req.id,{desktop:d});const p=getPacket(cfg,req.id,'A');
  await reconcileDispatch(cfg,req.id,'A',{expectedAttemptId:p.attemptId,expectedBaseline:'baseline-a',reason:'Legacy fixture.',confirmedNotDelivered:true,desktop:d});
  const db=new DatabaseSync(path.join(cfg.controlRoot,'state.sqlite')),row=db.prepare("SELECT id,data FROM events WHERE run_id=? AND kind='dispatch_reconcile'").get(req.id),data=JSON.parse(row.data);
  delete data.evidenceHash;db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(data),row.id);db.prepare("UPDATE tasks SET baseline=NULL WHERE run_id=? AND task_id='A'").run(req.id);db.close();
  await assert.rejects(advance(cfg,req.id,{desktop:d}),/frozen baseline or absence evidence/i);
  assert.equal(sends,1);assert.equal(status(cfg,req.id).status,'BLOCKED');
});
