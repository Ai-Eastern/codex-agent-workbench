import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publishPlan} from '../src/plan.mjs';
import {preparePhase,phaseStatus,advancePlan,finish,status,pause,getPacket,reconcilePhasePreparation,openStore} from '../src/workflow.mjs';
import {main} from '../src/cli.mjs';
import {writeJson} from '../src/contracts.mjs';

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-phases-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg={projectId:'fixture',projectRoot:root,workRoot:path.join(root,'work'),controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'knowledge'),maxWorkers:3,model:'gpt-6-astra',thinking:'ultra',pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{}};
  const old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=cfg.pmThreadId;
  t.after(()=>{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;});
  const plan={schemaVersion:1,projectId:cfg.projectId,planId:'ordered',revision:1,objective:'Build and refine one artifact',constraints:['Keep the module API'],phases:[{id:'build',dependsOn:[],maxNativeWorkers:3},{id:'refine',dependsOn:['build'],maxNativeWorkers:0}],tasks:[{id:'base',revision:1,phaseId:'build',dependsOn:[],executor:'direct',files:['result.txt'],contextRefs:[],acceptanceRefs:['base']},{id:'refine',revision:1,phaseId:'refine',dependsOn:['base'],executor:'direct',files:['result.txt'],contextRefs:[],acceptanceRefs:['refine']}]};
  publishPlan(cfg,plan,{expectedRevision:0,reason:'Authorized bounded plan'});
  return {root,cfg,plan};
}
const group=(task,phase=task==='base'?'build':'refine')=>({expectedRevision:1,phaseId:phase,groupId:task,taskIds:[task],decision:{topology:'serial',carrier:'direct',context:'continue',reason:'One ready edit'},checks:[{id:task,command:process.execPath,args:['-e',`if(require('fs').readFileSync('result.txt','utf8')!==${JSON.stringify(task)})process.exit(1)`]}]});

test('phases reuse legacy runs, hand off sequential ownership and return the next ready group',async t=>{
  const {cfg}=fixture(t);
  assert.throws(()=>preparePhase(cfg,group('refine')),{code:'DEPENDENCY_NOT_READY'});
  const prepared=preparePhase(cfg,group('base'));
  assert.equal(prepared.status,'PREPARED');
  assert.equal(preparePhase(cfg,group('base')).nextAction.type,'READ_RUN');
  const started=await advancePlan(cfg,prepared.runId),packet=started.packets[0];
  assert.equal(packet.planBinding.revision,1);assert.equal(packet.model,'gpt-6-astra');assert.equal(packet.thinking,'ultra');
  fs.writeFileSync(packet.files[0],'base');await finish(cfg,prepared.runId,'base',{expectedAttemptId:packet.attemptId,summary:'Base delivered'});
  assert.deepEqual(phaseStatus(cfg).nextAction.taskIds,['refine']);
  const next=preparePhase(cfg,group('refine')),second=(await advancePlan(cfg,next.runId)).packets[0];
  fs.writeFileSync(second.files[0],'refine');await finish(cfg,next.runId,'refine',{expectedAttemptId:second.attemptId,summary:'Refinement delivered'});
  assert.equal(phaseStatus(cfg).nextAction.type,'PLAN_COMPLETE');
  assert.equal(phaseStatus(cfg).runs.length,2);
  assert.equal(getPacket(cfg,prepared.runId,'base').attemptId,packet.attemptId);
});

test('same group cannot replace acceptance or bypass dependencies with a different identity',t=>{
  const {cfg}=fixture(t),definition=group('base');preparePhase(cfg,definition);
  assert.throws(()=>preparePhase(cfg,{...definition,checks:[{id:'base',command:process.execPath,args:['-e','process.exit(0)']}]}),{code:'PLAN_CONFLICT'});
  assert.throws(()=>preparePhase(cfg,{...definition,groupId:'other'}),{code:'DEPENDENCY_NOT_READY'});
  assert.throws(()=>preparePhase(cfg,{...definition,expectedRevision:2}),{code:'PLAN_CONFLICT'});
  assert.throws(()=>preparePhase(cfg,{...definition,decision:{...definition.decision,context:'handoff'}}),{code:'CAPABILITY_UNAVAILABLE'});
  process.env.CODEX_THREAD_ID='other';assert.throws(()=>preparePhase(cfg,group('base')),/PM/);
});

test('failed or paused groups remain on their original run and cannot be bypassed by a new group',async t=>{
  const {cfg}=fixture(t),prepared=preparePhase(cfg,group('base')),packet=(await advancePlan(cfg,prepared.runId)).packets[0];
  pause(cfg,prepared.runId);
  assert.equal((await advancePlan(cfg,prepared.runId)).status,'PAUSED');
  assert.throws(()=>preparePhase(cfg,{...group('base'),groupId:'retry'}),{code:'DEPENDENCY_NOT_READY'});
  await advancePlan(cfg,prepared.runId,{resume:true});
  fs.writeFileSync(packet.files[0],'wrong');
  assert.equal((await finish(cfg,prepared.runId,'base',{expectedAttemptId:packet.attemptId,summary:'Rejected output'})).status,'FAILED');
  assert.equal((await advancePlan(cfg,prepared.runId)).status,'FAILED');
  assert.throws(()=>preparePhase(cfg,{...group('base'),groupId:'retry'}),{code:'DEPENDENCY_NOT_READY'});
  assert.equal(status(cfg,prepared.runId).status,'FAILED');
});

test('changed accepted inputs block a dependent phase',async t=>{
  const {cfg}=fixture(t),prepared=preparePhase(cfg,group('base')),packet=(await advancePlan(cfg,prepared.runId)).packets[0];
  fs.writeFileSync(packet.files[0],'base');await finish(cfg,prepared.runId,'base',{expectedAttemptId:packet.attemptId,summary:'done'});
  fs.writeFileSync(packet.files[0],'unrecorded edit');
  assert.throws(()=>preparePhase(cfg,group('refine')),{code:'INPUT_STALE'});
});

test('plan CLI publishes Markdown, reports readiness and prepares without dispatch',async t=>{
  const {root,cfg,plan}=fixture(t),config=path.join(root,'project.json'),source=path.join(root,'DEVELOPMENT.md'),definition=path.join(root,'group.json');
  writeJson(config,cfg);writeJson(definition,{...group('base'),expectedRevision:2});
  fs.writeFileSync(source,`# Development\n<!-- workbench-plan -->\n\`\`\`json\n${JSON.stringify({...plan,revision:2})}\n\`\`\`\n<!-- /workbench-plan -->\n`);
  await main(['plan-publish','--project',config,'--source',source,'--expected-revision','1','--reason','Document snapshot']);
  assert.equal((await main(['plan-status','--project',config])).planRevision,2);
  assert.equal((await main(['phase-prepare','--project',config,'--group',definition])).status,'PREPARED');
});

test('a prepared group cannot dispatch an incompatible old definition after a plan revision',async t=>{
  const {cfg,plan}=fixture(t),prepared=preparePhase(cfg,group('base')),packet=getPacket(cfg,prepared.runId,'base');
  const revised=structuredClone(plan);revised.revision=2;revised.tasks[0].revision=2;revised.tasks[0].acceptanceRefs=['base-v2'];
  publishPlan(cfg,revised,{expectedRevision:1,reason:'New requirement before the prepared group starts'});
  await assert.rejects(()=>advancePlan(cfg,prepared.runId),error=>['INPUT_STALE','RESULT_SUPERSEDED','PLAN_CONFLICT'].includes(error.code));
  const current=status(cfg,prepared.runId);
  assert.equal(current.status,'PREPARED');assert.equal(current.tasks[0].status,'PENDING');
  assert.deepEqual(getPacket(cfg,prepared.runId,'base'),packet);
});

test('the final plan refuses changed outputs while preserving legal sequential rewrites',async t=>{
  const {cfg}=fixture(t);
  for(const task of ['base','refine']){
    const prepared=preparePhase(cfg,group(task)),packet=(await advancePlan(cfg,prepared.runId)).packets[0];
    fs.writeFileSync(packet.files[0],task);
    await finish(cfg,prepared.runId,task,{expectedAttemptId:packet.attemptId,summary:`Accepted ${task} artifact`});
  }
  assert.equal(phaseStatus(cfg).nextAction.type,'PLAN_COMPLETE');
  fs.writeFileSync(path.join(cfg.workRoot,'result.txt'),'unaccepted change after final delivery');
  assert.throws(()=>phaseStatus(cfg),{code:'INPUT_STALE'});
});

test('preparation recovery rechecks accepted inputs before creating the saved pending run',async t=>{
  const {cfg}=fixture(t),base=preparePhase(cfg,group('base')),packet=(await advancePlan(cfg,base.runId)).packets[0];
  fs.writeFileSync(packet.files[0],'base');await finish(cfg,base.runId,'base',{expectedAttemptId:packet.attemptId,summary:'Base accepted'});
  const mkdir=fs.mkdirSync;
  t.mock.method(fs,'mkdirSync',function(directory,...args){
    if(path.resolve(directory)===cfg.workRoot)throw Error('injected prepare directory failure before run insertion');
    return mkdir.call(this,directory,...args);
  });
  try{assert.throws(()=>preparePhase(cfg,group('refine')),/injected prepare directory failure/);}
  finally{t.mock.restoreAll();}
  const pending=phaseStatus(cfg).runs.find(run=>run.status==='PREPARE_PENDING');
  assert.ok(pending,'the real preparation intent survives the filesystem failure');
  fs.writeFileSync(packet.files[0],'unaccepted dependency change');
  assert.throws(()=>reconcilePhasePreparation(cfg,pending.runId),{code:'INPUT_STALE'});
  const store=openStore(cfg);
  try{assert.equal(store.run(pending.runId),undefined);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ownership').get().n,0);}
  finally{store.close();}
  fs.writeFileSync(packet.files[0],'base');
  const restored=reconcilePhasePreparation(cfg,pending.runId);
  assert.equal(restored.runId,pending.runId);assert.equal(restored.status,'PREPARED');
  assert.equal(status(cfg,pending.runId).tasks[0].status,'PENDING');
});

test('preparation recovery restores a missing frozen packet without replacing its attempt or divergent bytes',async t=>{
  const {cfg}=fixture(t),write=fs.writeFileSync;
  t.mock.method(fs,'writeFileSync',function(file,...args){
    if(typeof file==='string'&&path.basename(path.dirname(file))==='packets')throw Error('injected frozen packet write failure');
    return write.call(this,file,...args);
  });
  try{assert.throws(()=>preparePhase(cfg,group('base')),/injected frozen packet write failure/);}
  finally{t.mock.restoreAll();}
  const runId=phaseStatus(cfg).runs[0].runId,packet=getPacket(cfg,runId,'base');
  const packetFile=path.join(cfg.controlRoot,`runs/${runId}/packets/base.json`);
  assert.equal(fs.existsSync(packetFile),false);
  const store=openStore(cfg);let frozen;
  try{frozen=JSON.parse(store.tasks(runId)[0].packet);}
  finally{store.close();}
  const expectedBytes=JSON.stringify(frozen,null,2)+'\n';
  reconcilePhasePreparation(cfg,runId);
  assert.equal(fs.readFileSync(packetFile,'utf8'),expectedBytes);
  assert.deepEqual(getPacket(cfg,runId,'base'),packet);
  assert.equal(status(cfg,runId).tasks[0].status,'PENDING');
  const divergent=JSON.stringify({...frozen,objective:'Changed outside the frozen contract'});
  fs.writeFileSync(packetFile,divergent);
  assert.throws(()=>reconcilePhasePreparation(cfg,runId),/packet|changed|stale/i);
  assert.equal(fs.readFileSync(packetFile,'utf8'),divergent);
  fs.writeFileSync(packetFile,expectedBytes);
  const assigned=(await advancePlan(cfg,runId)).packets[0];
  assert.equal(assigned.attemptId,packet.attemptId);
  fs.writeFileSync(assigned.files[0],'base');
  assert.equal((await finish(cfg,runId,'base',{expectedAttemptId:assigned.attemptId,summary:'Recovered original attempt'})).status,'COMPLETE');
});
