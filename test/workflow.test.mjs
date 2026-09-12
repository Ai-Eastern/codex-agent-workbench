import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepare,advance,status,pause,getPacket,knowledge,claimNative,bindNative,promptFor} from '../src/workflow.mjs';
import {writeJson,digest,validateRequest,configFrom} from '../src/contracts.mjs';
import {main as cliMain} from '../src/cli.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg={projectId:'fixture',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:3,model:'gpt-5.5',thinking:'low',captureEnabled:true,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{A:'22222222-2222-4222-8222-222222222222',B:'33333333-3333-4333-8333-333333333333',C:'44444444-4444-4444-8444-444444444444'}};
  const old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=cfg.pmThreadId;t.after(()=>{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;});
  fs.mkdirSync(cfg.workRoot,{recursive:true});
  return cfg;
}
function request(id='demo',mode='direct'){
  return {id,objective:'实现项目标签规范化',mode,reason:'bounded test',tasks:[{id:'A',objective:'读取知识并实现标签规范化',files:['normalize.mjs'],dependsOn:[]}],checks:[{id:'result',command:'node',args:['--input-type=module','-e',"import {normalize} from './normalize.mjs';if(normalize(' A ')!=='a')process.exit(1)"]}]};
}
function complete(cfg,run,task='A',extra={}){
  const p=getPacket(cfg,run,task);
  for(const file of p.files){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,"export const normalize=s=>s.trim().toLowerCase();\n");}
  writeJson(p.receiptPath,{runId:run,taskId:task,attemptId:p.attemptId,status:'done',summary:'implemented and locally checked',knowledgeIds:p.context.items.map(x=>x.id),...extra});
  return p;
}
test('direct retrieves project knowledge, validates commands and reuses completed acceptance',async t=>{
  const cfg=fixture(t),k=knowledge(cfg),evidence=path.join(cfg.projectRoot,'seed.txt');
  fs.writeFileSync(evidence,'fixture evidence');
  k.capture({id:'label-rule',title:'项目标签规范化',body:'标签规范化需要先去掉首尾空白再转小写。',kind:'decision',source:{runId:'seed',taskId:'seed',evidence:[{path:evidence,sha256:digest('fixture evidence')}]}});k.close();
  assert.equal(prepare(cfg,request()).status,'PREPARED');
  const first=await advance(cfg,'demo');assert.equal(first.packets.length,1);assert.equal(first.packets[0].context.items[0].id,'label-rule');
  complete(cfg,'demo','A',{knowledgeCandidate:{id:'normalization-verified',title:'规范化已通过检查',body:'规范化保留 trim 与小写行为；本地命令已验证。',kind:'solution'}});
  assert.equal((await advance(cfg,'demo')).status,'COMPLETE');
  const file=path.join(cfg.controlRoot,'runs/demo/acceptance.json'),before=fs.readFileSync(file,'utf8');
  assert.equal((await advance(cfg,'demo')).reused,true);assert.equal(fs.readFileSync(file,'utf8'),before);
  const again=knowledge(cfg);assert.ok(again.search('规范化').items.some(x=>x.id==='normalization-verified'));again.close();
});
test('DAG dispatch has a whole-batch barrier and no redispatch across graph invocations',async t=>{
  const cfg=fixture(t),req=request('dag','langgraph');
  req.tasks=[{id:'A',objective:'A',files:['a.mjs']},{id:'B',objective:'B',files:['b.mjs']},{id:'C',objective:'C',files:['normalize.mjs'],dependsOn:['A','B']}];
  const sent=[],heads=new Map(Object.values(cfg.workerThreads).map(id=>[id,{id,archived:false,status:'idle',turnId:'before',turnStatus:'completed'}]));
  const desktop={read:async id=>heads.get(id),send:async(id)=>{const role=Object.keys(cfg.workerThreads).find(k=>cfg.workerThreads[k]===id);sent.push(role);complete(cfg,'dag',role);heads.set(id,{id,archived:false,status:'idle',turnId:`after-${role}`,turnStatus:'completed'});return {ok:true};}};
  prepare(cfg,req);await advance(cfg,'dag',{desktop});assert.deepEqual(sent,['A','B']);
  await advance(cfg,'dag',{desktop});assert.deepEqual(sent,['A','B','C']);
  assert.equal((await advance(cfg,'dag',{desktop})).status,'COMPLETE');
  await advance(cfg,'dag',{desktop});assert.equal(sent.length,3);
});
test('busy engineer blocks the entire first batch',async t=>{
  const cfg=fixture(t),req=request('busy','langgraph');req.tasks.push({id:'B',objective:'B',files:['b.mjs']});
  prepare(cfg,req);let sent=0;
  const desktop={read:async id=>({id,archived:false,status:id===cfg.workerThreads.B?'active':'idle',turnId:'head',turnStatus:id===cfg.workerThreads.B?'inProgress':'completed'}),send:async()=>sent++};
  await assert.rejects(advance(cfg,'busy',{desktop}),/busy/);assert.equal(sent,0);
});
test('ambiguous delivery remains blocked and cannot silently retry',async t=>{
  const cfg=fixture(t);prepare(cfg,request('unknown','langgraph'));let sent=0;
  const desktop={read:async id=>({id,archived:false,status:'idle',turnId:'head',turnStatus:'completed'}),send:async()=>{sent++;throw Object.assign(Error('lost reply'),{delivery:'UNCONFIRMED_DO_NOT_RETRY'});}};
  assert.equal((await advance(cfg,'unknown',{desktop})).status,'BLOCKED');
  await advance(cfg,'unknown',{desktop,resume:true});assert.equal(sent,1);
});
test('pause preserves acceptance progress and does not rerun a completed command',async t=>{
  const cfg=fixture(t),req=request('pause');req.checks.push({id:'second',command:'node',args:['-e','process.exit(0)']});
  prepare(cfg,req);await advance(cfg,'pause');complete(cfg,'pause');
  const calls=[];
  const commandRunner=async c=>{calls.push(c.id);if(c.id==='result')pause(cfg,'pause');return {exitCode:0};};
  const stopped=await advance(cfg,'pause',{commandRunner});assert.equal(stopped.status,'PAUSED');assert.equal(stopped.phase,'ACCEPTING');assert.deepEqual(calls,['result']);
  assert.equal((await advance(cfg,'pause',{resume:true,commandRunner})).status,'COMPLETE');assert.deepEqual(calls,['result','second']);
});
test('pause after the last acceptance command resumes only knowledge capture',async t=>{
  const cfg=fixture(t);prepare(cfg,request('last'));await advance(cfg,'last');complete(cfg,'last');let calls=0;
  const commandRunner=async()=>{calls++;pause(cfg,'last');return {exitCode:0};};
  const stopped=await advance(cfg,'last',{commandRunner});assert.equal(stopped.status,'PAUSED');assert.equal(stopped.phase,'ACCEPTED');
  assert.equal((await advance(cfg,'last',{resume:true,commandRunner})).status,'COMPLETE');assert.equal(calls,1);
});
test('failed acceptance is retained and never automatically rerun',async t=>{
  const cfg=fixture(t);prepare(cfg,request('fail'));await advance(cfg,'fail');complete(cfg,'fail');let checks=0;
  const commandRunner=async()=>{checks++;return {exitCode:1};};
  assert.equal((await advance(cfg,'fail',{commandRunner})).status,'FAILED');await advance(cfg,'fail',{commandRunner,resume:true});assert.equal(checks,1);
});
test('invalid or changed result and acceptance evidence cannot count as success',async t=>{
  const cfg=fixture(t);prepare(cfg,request('identity'));await advance(cfg,'identity');const p=complete(cfg,'identity');
  writeJson(p.receiptPath,{runId:'other',taskId:'A',attemptId:p.attemptId,status:'done',summary:'wrong'});
  await assert.rejects(advance(cfg,'identity'),/identity/);complete(cfg,'identity');await advance(cfg,'identity');
  const f=path.join(cfg.controlRoot,'runs/identity/acceptance.json'),data=JSON.parse(fs.readFileSync(f));data.passed=false;writeJson(f,data);
  await assert.rejects(advance(cfg,'identity'),/receipt changed/);
});
test('native route returns isolated knowledge packets and checks outputs through the same graph',async t=>{
  const cfg=fixture(t),req=request('native','native');req.tasks.push({id:'B',objective:'independent',files:['b.mjs']});prepare(cfg,req);
  const assigned=await advance(cfg,'native');assert.equal(assigned.packets.length,2);
  claimNative(cfg,'native','A');claimNative(cfg,'native','B');
  assert.throws(()=>claimNative(cfg,'native','A'),/already claimed/);
  assert.equal((await advance(cfg,'native')).packets.length,0);
  bindNative(cfg,'native','A','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');bindNative(cfg,'native','B','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  complete(cfg,'native','A');complete(cfg,'native','B');assert.equal((await advance(cfg,'native')).status,'COMPLETE');
});
test('file conflicts, traversal, request replacement and project identity drift are rejected',t=>{
  const cfg=fixture(t),req=request();req.tasks.push({id:'B',objective:'duplicate',files:['NORMALIZE.mjs']});assert.throws(()=>validateRequest(req,cfg),/Overlapping/);
  req.tasks[1].files=['../escape.mjs'];assert.throws(()=>validateRequest(req,cfg),/Unsafe/);
  const rootCfg={...cfg,workRoot:cfg.projectRoot},controlReq=request();controlReq.tasks[0].files=['control/state.sqlite'];assert.throws(()=>validateRequest(controlReq,rootCfg),/control state/);
  prepare(cfg,request());assert.throws(()=>prepare(cfg,{...request(),objective:'changed'}),/different contract/);
  assert.throws(()=>getPacket({...cfg,projectId:'other'},'demo','A'),/configuration changed/);
  assert.throws(()=>getPacket(cfg,'../demo','A'),/Unknown run/);
});
test('explicit Spark profile reaches task packets without silently replacing the model',async t=>{
  const cfg=fixture(t),file=path.join(cfg.projectRoot,'project.json');
  writeJson(file,{...cfg,model:'gpt-5.3-codex-spark'});
  const spark=configFrom(file);prepare(spark,request('spark-profile'));
  const result=await advance(spark,'spark-profile');
  assert.equal(result.packets[0].model,'gpt-5.3-codex-spark');
  assert.throws(()=>status(cfg,'spark-profile'),/configuration changed/);
  writeJson(file,{...cfg,model:'unapproved-model'});
  assert.throws(()=>configFrom(file),/profile/);
});
test('Luna medium survives configuration, all route packets and native claim prompts',async t=>{
  for(const mode of ['direct','native','langgraph']){
    const base=fixture(t),file=path.join(base.projectRoot,'project.json');
    writeJson(file,{...base,model:'gpt-5.6-luna',thinking:'medium'});
    const cfg=configFrom(file),run=`luna-${mode}`;
    prepare(cfg,request(run,mode));
    const p=getPacket(cfg,run,'A');
    assert.equal(p.model,'gpt-5.6-luna');assert.equal(p.thinking,'medium');
    if(mode==='direct')assert.match(promptFor(p),/PM，沿用当前指定模型与推理档位/);
    else assert.match(promptFor(p),/gpt-5\.6-luna\/medium/);
    assert.throws(()=>status({...cfg,thinking:'low'},run),/configuration changed/);
    if(mode==='native'){
      await advance(cfg,run);
      assert.match(claimNative(cfg,run,'A').prompt,/gpt-5\.6-luna\/medium/);
    }
    writeJson(file,{...cfg,thinking:'ultra'});
    assert.throws(()=>configFrom(file),/profile/);
    const legacy={...p,model:'gpt-5.5'};delete legacy.thinking;
    if(mode==='direct')assert.match(promptFor(legacy),/PM，沿用当前指定模型与推理档位/);
    else assert.match(promptFor(legacy),/gpt-5\.5\/low/);
  }
});

test('status and waiting continuation keep task context out of repeated summaries',async t=>{
  const cfg=fixture(t),file=path.join(cfg.projectRoot,'project.json');writeJson(file,cfg);
  prepare(cfg,request('bounded-status'));await advance(cfg,'bounded-status');
  const original=getPacket(cfg,'bounded-status','A');
  const query=await cliMain(['status','--project',file,'--run','bounded-status']);
  assert.equal(query.tasks[0].status,'ASSIGNED');assert.equal(Object.hasOwn(query,'packets'),false);
  const waiting=await cliMain(['continue','--project',file,'--run','bounded-status']);
  assert.deepEqual(waiting.awaitingResults,[{taskId:'A',receiptPath:original.receiptPath}]);
  assert.equal(Object.hasOwn(waiting,'packets'),false);assert.equal(fs.existsSync(original.receiptPath),false);
  assert.equal(getPacket(cfg,'bounded-status','A').contextHash,original.contextHash);
});
test('linked control descendants and reserved task names are rejected before reserving ownership',t=>{
  const cfg=fixture(t),outside=path.join(cfg.projectRoot,'outside');fs.mkdirSync(outside);fs.mkdirSync(path.join(cfg.controlRoot,'runs'),{recursive:true});
  fs.symlinkSync(outside,path.join(cfg.controlRoot,'runs','linked'),'junction');
  assert.throws(()=>prepare(cfg,request('linked')),/Symlink/);
  assert.equal(fs.readdirSync(outside).length,0);
  const invalid=request('reserved');invalid.tasks[0].id='con';assert.throws(()=>prepare(cfg,invalid),/Unsafe/);
  assert.throws(()=>status(cfg,'reserved'),/Unknown run/);
});
test('knowledge conflict keeps accepted engineering work and does not re-run checks',async t=>{
  const cfg=fixture(t),k=knowledge(cfg),evidence=path.join(cfg.projectRoot,'seed.txt');fs.writeFileSync(evidence,'seed');
  k.capture({id:'shared-lesson',title:'Original',body:'original',kind:'decision',source:{runId:'seed',taskId:'seed',evidence:[{path:evidence,sha256:digest('seed')}]}});k.close();
  prepare(cfg,request('capture-conflict'));await advance(cfg,'capture-conflict');complete(cfg,'capture-conflict','A',{knowledgeCandidate:{id:'shared-lesson',title:'New',body:'different',kind:'solution'}});
  let checks=0;const commandRunner=async()=>{checks++;return {exitCode:0};};
  assert.equal((await advance(cfg,'capture-conflict',{commandRunner})).status,'COMPLETE_CAPTURE_PENDING');
  assert.equal((await advance(cfg,'capture-conflict',{commandRunner})).status,'COMPLETE_CAPTURE_PENDING');assert.equal(checks,1);
});
