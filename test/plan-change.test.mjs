import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {publishPlan,activePlan,planImpact} from '../src/plan.mjs';
import {preparePhase,phaseStatus,advancePlan,finish,getPacket,openStore,supersedePhase} from '../src/workflow.mjs';

function fixture(t,letter='a') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-change-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg={projectId:`project-${letter}`,projectRoot:root,workRoot:path.join(root,'work'),controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'knowledge'),maxWorkers:3,model:'gpt-6-astra',thinking:'ultra',pmThreadId:`${letter.repeat(8)}-${letter.repeat(4)}-4${letter.repeat(3)}-8${letter.repeat(3)}-${letter.repeat(12)}`,workerThreads:{}};
  const old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=cfg.pmThreadId;
  t.after(()=>{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;});
  const task=(id,dependsOn=[])=>({id,revision:1,phaseId:'build',dependsOn,executor:'direct',files:[`${id}.txt`],contextRefs:[],acceptanceRefs:[`${id}-v1`]});
  const plan={schemaVersion:1,projectId:cfg.projectId,planId:'change',revision:1,objective:'Maintain scoped artifacts',constraints:['Keep failures'],phases:[{id:'build',dependsOn:[],maxNativeWorkers:0}],tasks:[task('api'),task('consumer',['api']),task('independent')]};
  return {cfg,plan,publish:()=>publishPlan(cfg,plan,{expectedRevision:0,reason:'initial'})};
}
function group(task,revision=1){return {expectedRevision:revision,phaseId:'build',groupId:task.id,taskIds:[task.id],decision:{topology:'serial',carrier:'direct',context:'continue',reason:'Dependency order'},checks:[{id:task.acceptanceRefs[0],command:process.execPath,args:['-e',`if(require('fs').readFileSync('${task.id}.txt','utf8')!=='${task.id}')process.exit(1)`]}]};}
async function complete(cfg,task,revision=1){const run=preparePhase(cfg,group(task,revision)),packet=(await advancePlan(cfg,run.runId)).packets[0];fs.writeFileSync(packet.files[0],task.id);await finish(cfg,run.runId,task.id,{expectedAttemptId:packet.attemptId,summary:'Exact artifact'});return {run,packet};}

test('local revision invalidates changed task and consumers while retaining unrelated project results',async t=>{
  const a=fixture(t),b=fixture(t,'b');
  process.env.CODEX_THREAD_ID=b.cfg.pmThreadId;b.publish();const bHash=activePlan(b.cfg).planHash;
  process.env.CODEX_THREAD_ID=a.cfg.pmThreadId;a.publish();
  for(const task of a.plan.tasks)await complete(a.cfg,task);
  const before=activePlan(a.cfg).plan,after=structuredClone(before);after.revision=2;after.tasks[0].revision=2;after.tasks[0].acceptanceRefs=['api-tenant-v2'];
  assert.deepEqual(planImpact(before,after),{affected:['api','consumer'],unchanged:['independent'],removed:[]});
  const published=publishPlan(a.cfg,after,{expectedRevision:1,reason:'User adds tenant contract'});
  assert.deepEqual(published.impact.affected,['api','consumer']);
  const state=phaseStatus(a.cfg);
  assert.equal(state.tasks.find(t=>t.id==='api').status,'READY');assert.equal(state.tasks.find(t=>t.id==='consumer').status,'WAITING');assert.equal(state.tasks.find(t=>t.id==='independent').status,'COMPLETE');
  assert.equal(activePlan(b.cfg).planHash,bHash);
});

test('in-flight old result retains frozen contract and cannot satisfy revised acceptance',async t=>{
  const {cfg,plan,publish}=fixture(t);publish();
  const original=preparePhase(cfg,group(plan.tasks[0])),packet=(await advancePlan(cfg,original.runId)).packets[0];
  const next=structuredClone(activePlan(cfg).plan);next.revision=2;next.tasks[0].revision=2;next.tasks[0].acceptanceRefs=['api-v2'];
  publishPlan(cfg,next,{expectedRevision:1,reason:'New acceptance while old attempt is active'});
  assert.deepEqual(getPacket(cfg,original.runId,'api'),{...packet,prompt:getPacket(cfg,original.runId,'api').prompt});
  assert.throws(()=>preparePhase(cfg,group(next.tasks[0],2)),{code:'DEPENDENCY_NOT_READY'});
  const store=openStore(cfg);try{assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ownership').get().n,1);}finally{store.close();}
  fs.writeFileSync(packet.files[0],'api');await finish(cfg,original.runId,'api',{expectedAttemptId:packet.attemptId,summary:'Old interface result retained'});
  assert.equal(phaseStatus(cfg).tasks.find(t=>t.id==='consumer').status,'WAITING');
  const replacement=preparePhase(cfg,group(next.tasks[0],2));
  assert.notEqual(replacement.runId,original.runId);assert.equal(getPacket(cfg,original.runId,'api').planBinding.revision,1);
});

test('editing task fields without advancing its revision is rejected',t=>{
  const {cfg,publish}=fixture(t);publish();const next=structuredClone(activePlan(cfg).plan);next.revision=2;next.tasks[0].files=['different.txt'];
  assert.throws(()=>publishPlan(cfg,next,{expectedRevision:1,reason:'Missing task revision'}),{code:'PLAN_CONFLICT'});
  assert.equal(activePlan(cfg).plan.revision,1);
});

test('a proven undispatched stale group can be superseded without erasing its original attempt',async t=>{
  const {cfg,publish,plan}=fixture(t);publish();const first=preparePhase(cfg,group(plan.tasks[0])),packet=getPacket(cfg,first.runId,'api');
  const next=structuredClone(activePlan(cfg).plan);next.revision=2;next.tasks[0].revision=2;next.tasks[0].acceptanceRefs=['api-v2'];
  publishPlan(cfg,next,{expectedRevision:1,reason:'New input contract'});
  await assert.rejects(advancePlan(cfg,first.runId),{code:'INPUT_STALE'});
  const retired=supersedePhase(cfg,first.runId,{expectedPlanRevision:2,reason:'Replace only the group never handed to a host'});
  assert.equal(retired.status,'RESULT_SUPERSEDED');assert.equal(supersedePhase(cfg,first.runId,{expectedPlanRevision:2,reason:'Read retirement'}).reused,true);
  assert.equal(getPacket(cfg,first.runId,'api').attemptId,packet.attemptId);
  await assert.rejects(advancePlan(cfg,first.runId),{code:'RESULT_SUPERSEDED'});
  const replacement=preparePhase(cfg,group(next.tasks[0],2));assert.notEqual(replacement.runId,first.runId);
  const started=await advancePlan(cfg,replacement.runId);assert.equal(started.nextAction.type,'EXECUTE_DIRECT');
  assert.throws(()=>supersedePhase(cfg,replacement.runId,{expectedPlanRevision:2,reason:'Cannot claim active work never ran'}),{code:'DISPATCH_UNKNOWN'});
  const store=openStore(cfg);try{assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM ownership').get().n,1);}finally{store.close();}
});
