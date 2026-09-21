import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHandoff,acceptHandoff,resolveIdentity} from '../src/handoff.mjs';
import {publishPlan,activePlan} from '../src/plan.mjs';
import {preparePhase,pause,advance,advancePlan,getPacket,openStore,status,submitResult} from '../src/workflow.mjs';
import {digest,readJson,writeJson,projectIdentity} from '../src/contracts.mjs';

// These are deterministic protocol fixtures. They do not establish real Desktop
// creation, a fresh model context, or user acceptance in the live host.
const sourceId='11111111-1111-4111-8111-111111111111',targetId='22222222-2222-4222-8222-222222222222',workerId='33333333-3333-4333-8333-333333333333';
function git(root,...args){
  const result=spawnSync('git',['-C',root,...args],{encoding:'utf8',windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.error?.message);return result.stdout.trim();
}
function commit(root,message){
  git(root,'add','.');
  git(root,'-c','user.name=Protocol Fixture','-c','user.email=protocol@example.invalid','-c','commit.gpgsign=false','-c',`core.hooksPath=${path.join(root,'.empty-hooks')}`,'commit','-m',message);
}
function fixture(t,{executor='direct',paused=true}={}){
  const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'context-handoff-')),workRoot=path.join(root,'work');
  const previous=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=sourceId;
  t.after(()=>{if(previous===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=previous;assert.equal(path.dirname(root),parent);assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(workRoot);git(workRoot,'init','--quiet');fs.writeFileSync(path.join(workRoot,'result.txt'),'baseline');commit(workRoot,'fixture baseline');
  const cfg={projectId:'handoff-fixture',projectRoot:root,workRoot,controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'knowledge'),maxWorkers:2,model:'gpt-6-astra',thinking:'ultra',pmThreadId:sourceId,workerThreads:executor==='desktop'?{write:workerId}:{},captureEnabled:false};
  const oldFile=path.join(root,'old-project.json'),newFile=path.join(root,'new-project.json');writeJson(oldFile,cfg);Object.defineProperty(cfg,'configFile',{value:oldFile});
  const newCfg={...cfg,pmThreadId:targetId};writeJson(newFile,newCfg);Object.defineProperty(newCfg,'configFile',{value:newFile});
  const plan={schemaVersion:1,projectId:cfg.projectId,planId:'deliver',revision:1,objective:'Deliver and preserve verified constraints',constraints:['Keep the original API'],phases:[{id:'build',dependsOn:[],maxNativeWorkers:1}],tasks:[{id:'write',revision:1,phaseId:'build',dependsOn:[],executor,files:['result.txt'],contextRefs:['api-v1'],acceptanceRefs:['check-result']}]};
  publishPlan(cfg,plan,{expectedRevision:0,reason:'Protocol fixture'});
  const prepared=preparePhase(cfg,{expectedRevision:1,phaseId:'build',groupId:'first',taskIds:['write'],decision:{topology:'serial',carrier:executor,context:'select',reason:'Protocol fixture'},checks:[{id:'check-result',command:process.execPath,args:['-e','process.exit(0)']}]});
  if(paused)pause(cfg,prepared.runId);
  const options={id:'handoff-1',runId:prepared.runId,expectedPlanRevision:1,expectedHead:git(workRoot,'rev-parse','HEAD'),budget:{maxActiveWorkers:2,maxAttemptsPerTask:2},nextStep:'Inspect preserved state and explicitly resume the existing run.',allowedActions:['READ_STATE','RESUME','CONTINUE_PLAN']};
  return {root,cfg,newCfg,plan,options,runId:prepared.runId,oldFile};
}
function proof(f,prepared,{kind='created',...overrides}={}){
  const packet=readJson(prepared.packetPath),receiptPath=path.join(f.cfg.controlRoot,'host-evidence','new-session.json');
  const receipt={schemaVersion:1,kind,threadId:targetId,cwd:f.cfg.projectRoot,sourceThreadId:sourceId,context:'fresh',forkedFrom:null,createdAt:Math.max(Date.now(),packet.createdAt),receiptId:'protocol-fixture-session-receipt',...(kind==='created'?{hostReceipt:{threadId:targetId,hostId:'fixture-host'}}:{registeredBy:'user',registrationReason:'Protocol fixture for a user-registered independent context'}),...overrides};
  writeJson(receiptPath,receipt);
  return {kind,threadId:targetId,cwd:f.cfg.projectRoot,sourceThreadId:sourceId,receiptPath,receiptHash:digest(fs.readFileSync(receiptPath))};
}
function adapter(f,overrides={}){
  return {read:async id=>({id,cwd:f.cfg.projectRoot,archived:false,status:id===sourceId?'idle':'active',turnId:`fixture-turn-${id}`,turnStatus:id===sourceId?'completed':'inProgress',...overrides[id]})};
}
function receiving(f,prepared,extra={}){
  process.env.CODEX_THREAD_ID=targetId;
  return {handoffId:prepared.handoffId,expectedHash:prepared.packetHash,expectedHead:f.options.expectedHead,desktop:adapter(f),sessionEvidence:proof(f,prepared),...extra};
}
function persisted(f){
  const store=openStore(f.cfg);
  try{return {runs:store.db.prepare('SELECT * FROM runs ORDER BY id').all(),tasks:store.db.prepare('SELECT * FROM tasks ORDER BY run_id,task_id').all(),ownership:store.db.prepare('SELECT * FROM ownership ORDER BY file').all(),plans:store.db.prepare('SELECT * FROM plans ORDER BY revision').all(),events:store.db.prepare('SELECT * FROM events ORDER BY id').all()};}
  finally{store.close();}
}

test('protocol fixture freezes user constraints, baseline, attempts, artifacts and unresolved facts',t=>{
  const f=fixture(t),before=persisted(f),prepared=createHandoff(f.cfg,f.options),packet=readJson(prepared.packetPath);
  assert.equal(digest(fs.readFileSync(prepared.packetPath)),prepared.packetHash);
  assert.equal(packet.source.identity,projectIdentity(f.cfg));assert.equal(packet.source.threadId,sourceId);
  assert.deepEqual(packet.facts.plan.userConstraints,['Keep the original API']);assert.equal(packet.facts.plan.revision,1);
  assert.equal(packet.facts.runs[0].tasks[0].attemptId,before.tasks[0].attempt);assert.equal(packet.facts.runs[0].tasks[0].taskRevision,1);
  assert.deepEqual(packet.facts.artifacts,[{path:'result.txt',hash:digest('baseline')}]);
  assert.equal(packet.budgetUsage.attempts[0].recordedAttempts,1);assert.equal(packet.budgetUsage.attempts[0].remainingAttempts,1);
  assert.equal(packet.facts.git.head,f.options.expectedHead);assert.equal(packet.facts.runs[0].events.at(-1).kind,'paused');
  assert.equal(createHandoff(f.cfg,f.options).reused,true);assert.deepEqual(persisted(f),before);
});

test('protocol fixture refuses missing intent, wrong baseline, changed plan version and wrong actor',t=>{
  const f=fixture(t);
  for(const [field,value] of [['nextStep',undefined],['budget',undefined],['allowedActions',[]],['expectedPlanRevision',2],['expectedHead','0'.repeat(40)]])assert.throws(()=>createHandoff(f.cfg,{...f.options,[field]:value}));
  assert.throws(()=>createHandoff(f.cfg,{...f.options,budget:{maxActiveWorkers:3,maxAttemptsPerTask:2}}),{code:'HANDOFF_INVALID'});
  process.env.CODEX_THREAD_ID=targetId;assert.throws(()=>createHandoff(f.cfg,f.options),{code:'ACTOR_MISMATCH'});
});

test('protocol fixture requires a distinct new PM and preserves every other config field',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  process.env.CODEX_THREAD_ID=sourceId;
  await assert.rejects(acceptHandoff(f.cfg,options),{code:'ACTOR_MISMATCH'});
  process.env.CODEX_THREAD_ID=targetId;
  for(const changes of [{projectId:'wrong-project'},{model:'gpt-5.5'},{thinking:'low'},{workerThreads:{other:workerId}},{maxWorkers:1}])await assert.rejects(acceptHandoff({...f.newCfg,...changes},options),{code:'PROJECT_BINDING_CHANGED'});
  await assert.rejects(acceptHandoff(f.newCfg,{...options,expectedHead:'0'.repeat(40)}),{code:'INPUT_STALE'});
});

test('protocol fixture rejects summary-only, forked, unregistered and altered host evidence',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  await assert.rejects(acceptHandoff(f.newCfg,{...options,sessionEvidence:'New context, trust this summary'}),{code:'HANDOFF_INVALID'});
  for(const bad of [{forkedFrom:sourceId},{context:'summary'},{hostReceipt:{threadId:workerId,hostId:'fixture-host'}},{createdAt:0}])await assert.rejects(acceptHandoff(f.newCfg,{...options,sessionEvidence:proof(f,prepared,bad)}),{code:'HANDOFF_INVALID'});
  const registered=proof(f,prepared,{kind:'registered',registeredBy:'model'});
  await assert.rejects(acceptHandoff(f.newCfg,{...options,sessionEvidence:registered}),{code:'HANDOFF_INVALID'});
  const changed=proof(f,prepared);fs.appendFileSync(changed.receiptPath,' ');
  await assert.rejects(acceptHandoff(f.newCfg,{...options,sessionEvidence:changed}),{code:'INPUT_STALE'});
});

test('protocol fixture protects the saved original configuration from overwrite during handoff',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  const sameFile={...f.newCfg,configFile:f.oldFile};
  await assert.rejects(acceptHandoff(sameFile,options),{code:'PROJECT_BINDING_CHANGED'});
  writeJson(f.oldFile,{...f.cfg,pmThreadId:targetId});
  await assert.rejects(acceptHandoff(f.newCfg,options),{code:'INPUT_STALE'});
});

test('protocol fixture requires the source to be stopped and host cwd/identity to be observed',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared),before=persisted(f);
  await assert.rejects(acceptHandoff(f.newCfg,{...options,desktop:adapter(f,{[sourceId]:{status:'active',turnStatus:'inProgress'}})}),{code:'HANDOFF_RECONCILE_REQUIRED'});
  for(const changes of [{cwd:path.join(f.root,'wrong')},{id:workerId},{archived:true},{turnId:undefined}])await assert.rejects(acceptHandoff(f.newCfg,{...options,desktop:adapter(f,{[targetId]:changes})}),{code:'CAPABILITY_UNAVAILABLE'});
  await assert.rejects(acceptHandoff(f.newCfg,{...options,desktop:undefined}),{code:'CAPABILITY_UNAVAILABLE'});
  assert.deepEqual(persisted(f),before);
});

test('protocol fixture transfers identity once without rewriting runs, attempts, configs or ownership',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),before=persisted(f),oldBytes=fs.readFileSync(f.oldFile),options=receiving(f,prepared);
  const accepted=await acceptHandoff(f.newCfg,options);
  assert.equal(accepted.status,'ACCEPTED');assert.deepEqual(accepted.runs,[{runId:f.runId,status:'PREPARED',paused:true}]);
  assert.deepEqual(persisted(f),before);assert.deepEqual(fs.readFileSync(f.oldFile),oldBytes);
  const store=openStore(f.cfg);
  try{assert.equal(resolveIdentity(store,projectIdentity(f.cfg)),projectIdentity(f.newCfg));assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM identity_transfers').get().n,1);}
  finally{store.close();}
  assert.equal((await acceptHandoff(f.newCfg,options)).reused,true);
  process.env.CODEX_THREAD_ID=sourceId;assert.throws(()=>createHandoff(f.cfg,{...f.options,id:'old-owner-again'}),{code:'ACTOR_MISMATCH'});
});

test('protocol fixture accepts explicit human registration only with matching live host observations',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  options.sessionEvidence=proof(f,prepared,{kind:'registered'});
  if(process.platform==='win32')options.desktop=adapter(f,{[sourceId]:{cwd:`\\\\?\\${f.cfg.projectRoot}`},[targetId]:{cwd:f.cfg.projectRoot.toUpperCase()}});
  assert.equal((await acceptHandoff(f.newCfg,options)).acceptance.sessionEvidence.kind,'registered');
});

test('protocol fixture continues the same paused direct attempt under the new owner and rejects the old owner',async t=>{
  const f=fixture(t,{paused:false});await advance(f.cfg,f.runId);pause(f.cfg,f.runId);
  const originalAttempt=getPacket(f.cfg,f.runId,'write').attemptId,prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  await acceptHandoff(f.newCfg,options);
  assert.equal(activePlan(f.newCfg).plan.revision,1);assert.equal(status(f.newCfg,f.runId).status,'PAUSED');
  const resumedPacket=getPacket(f.newCfg,f.runId,'write');
  assert.ok(resumedPacket.prompt.includes(JSON.stringify(f.newCfg.configFile)),'Current owner prompt must submit through the new configuration');
  assert.equal(resumedPacket.resultTool.projectConfig,f.oldFile,'The original task packet stays frozen');
  assert.throws(()=>status(f.cfg,f.runId),/configuration changed/i);
  process.env.CODEX_THREAD_ID=sourceId;
  await assert.rejects(advancePlan(f.cfg,f.runId,{resume:true}),/handed off/i);
  assert.throws(()=>publishPlan(f.cfg,{...f.plan,revision:2},{expectedRevision:1,reason:'Old owner cannot mutate'}),/configuration changed|handed off/i);
  process.env.CODEX_THREAD_ID=targetId;await advancePlan(f.newCfg,f.runId,{resume:true});
  assert.equal(getPacket(f.newCfg,f.runId,'write').attemptId,originalAttempt);
  fs.writeFileSync(path.join(f.cfg.workRoot,'result.txt'),'new owner output');
  submitResult(f.newCfg,f.runId,'write',{expectedAttemptId:originalAttempt,summary:'Protocol fixture continued original attempt'});
  const done=await advancePlan(f.newCfg,f.runId,{commandRunner:()=>({exitCode:0})});
  assert.equal(done.status,'COMPLETE');assert.equal(done.plan.nextAction.type,'PLAN_COMPLETE');
  const store=openStore(f.newCfg);
  try{assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get().n,1);assert.equal(store.run(f.runId).identity,projectIdentity(f.cfg));assert.equal(store.tasks(f.runId)[0].attempt,originalAttempt);}
  finally{store.close();}
});

test('protocol fixture keeps unpaused and unknown dispatch attempts for reconciliation',async t=>{
  const f=fixture(t,{paused:false}),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared),before=persisted(f);
  await assert.rejects(acceptHandoff(f.newCfg,options),error=>error.code==='HANDOFF_RECONCILE_REQUIRED'&&error.reconciliation[0].reason==='PAUSE_REQUIRED');
  assert.deepEqual(persisted(f),before);
});

test('protocol fixture preserves ambiguous external dispatch, reservations and original attempt',async t=>{
  const f=fixture(t,{executor:'desktop',paused:false});let sends=0;
  const desktop={read:async id=>({id,cwd:f.cfg.projectRoot,archived:false,status:'idle',turnId:'before-send',turnStatus:'completed'}),send:async()=>{sends++;throw Object.assign(Error('fixture lost acknowledgement'),{delivery:'UNCONFIRMED_DO_NOT_RETRY'});}};
  await advance(f.cfg,f.runId,{desktop});
  const before=persisted(f),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  assert.equal(before.runs[0].status,'BLOCKED');assert.equal(before.tasks[0].status,'RESERVED');
  await assert.rejects(acceptHandoff(f.newCfg,options),{code:'HANDOFF_RECONCILE_REQUIRED'});
  assert.equal(sends,1);assert.deepEqual(persisted(f),before);
});

test('protocol fixture carries failed acceptance without turning it into success or unlocking files',async t=>{
  const f=fixture(t,{paused:false});await advance(f.cfg,f.runId);
  const task=getPacket(f.cfg,f.runId,'write');
  fs.writeFileSync(task.files[0],'failed implementation');writeJson(task.receiptPath,{runId:f.runId,taskId:'write',attemptId:task.attemptId,status:'done',summary:'protocol fixture delivery'});
  await advance(f.cfg,f.runId,{commandRunner:()=>({exitCode:1})});
  const before=persisted(f),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  assert.equal(before.runs[0].status,'FAILED');assert.ok(before.ownership.length);
  const accepted=await acceptHandoff(f.newCfg,options);
  assert.equal(accepted.runs[0].status,'FAILED');assert.deepEqual(persisted(f),before);
  assert.equal(readJson(prepared.packetPath).facts.runs[0].acceptance.passed,false);
});

test('protocol fixture refuses changed artifacts, Git baseline and plan facts',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  fs.writeFileSync(path.join(f.cfg.workRoot,'result.txt'),'modified after snapshot');
  await assert.rejects(acceptHandoff(f.newCfg,options),{code:'INPUT_STALE'});
  fs.writeFileSync(path.join(f.cfg.workRoot,'result.txt'),'baseline');
  process.env.CODEX_THREAD_ID=sourceId;publishPlan(f.cfg,{...f.plan,revision:2},{expectedRevision:1,reason:'Changed plan after handoff'});
  process.env.CODEX_THREAD_ID=targetId;await assert.rejects(acceptHandoff(f.newCfg,options),{code:'INPUT_STALE'});
});

test('protocol fixture rechecks file evidence after asynchronous host observations',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared),desktop=adapter(f);
  options.desktop={read:async id=>{const view=await desktop.read(id);if(id===targetId)fs.appendFileSync(prepared.packetPath,' ');return view;}};
  await assert.rejects(acceptHandoff(f.newCfg,options),{code:'INPUT_STALE'});
  const store=openStore(f.cfg);try{assert.equal(resolveIdentity(store,projectIdentity(f.cfg)),projectIdentity(f.cfg));}finally{store.close();}
});

test('protocol fixture detects changed untracked input and a new Git HEAD independently of planned artifacts',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared);
  fs.writeFileSync(path.join(f.cfg.workRoot,'new-input.txt'),'input outside the output file list');
  await assert.rejects(acceptHandoff(f.newCfg,options),{code:'INPUT_STALE'});
  commit(f.cfg.workRoot,'changed baseline after handoff');
  await assert.rejects(acceptHandoff(f.newCfg,options),error=>error.code==='INPUT_STALE'&&/baseline/.test(error.message));
});

test('protocol fixture preserves another runner lock and serializes competing acceptors',async t=>{
  const f=fixture(t),prepared=createHandoff(f.cfg,f.options),options=receiving(f,prepared),lock=path.join(f.cfg.controlRoot,'.runner.lock');
  fs.writeFileSync(lock,'original-runner');
  await assert.rejects(acceptHandoff(f.newCfg,options),{code:'EEXIST'});assert.equal(fs.readFileSync(lock,'utf8'),'original-runner');fs.unlinkSync(lock);
  const results=await Promise.allSettled([acceptHandoff(f.newCfg,options),acceptHandoff(f.newCfg,options)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal(results.find(result=>result.status==='rejected').reason.code,'EEXIST');
});
