import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {prepare,advance,delivery,getPacket,pause} from '../src/workflow.mjs';
import {writeJson,digest} from '../src/contracts.mjs';
import {main} from '../src/cli.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-delivery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg={projectId:'fixture',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:2,model:'gpt-5.5',thinking:'low',captureEnabled:true,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{}};fs.mkdirSync(cfg.workRoot,{recursive:true});return cfg;
}
function request(id){return {id,objective:'交付验证',mode:'direct',reason:'bounded test',tasks:[{id:'A',objective:'实现文件',files:['result.txt'],dependsOn:[]}],checks:[{id:'ok',command:'node',args:['-e','process.exit(0)']}]};}
async function complete(cfg,id,candidate=true){prepare(cfg,request(id));await advance(cfg,id);const p=getPacket(cfg,id,'A');fs.writeFileSync(p.files[0],'verified');writeJson(p.receiptPath,{runId:id,taskId:'A',attemptId:p.attemptId,status:'done',summary:'done',...(candidate?{knowledgeCandidate:{id:`lesson-${id}`,title:'交付经验',body:'body',kind:'solution'}}:{})});await advance(cfg,id);return p;}

test('delivery returns one compact verified fact package and reuses it',async t=>{
  const cfg=fixture(t);await complete(cfg,'done');const first=delivery(cfg,'done'),second=delivery(cfg,'done');
  assert.equal(first.schemaVersion,1);assert.equal(first.status,'COMPLETE');assert.equal(first.acceptance.verified,true);assert.equal(first.acceptance.passed,true);assert.equal(first.artifacts['result.txt'],digest('verified'));assert.equal(first.knowledge.status,'CAPTURED');assert.deepEqual(first,second);
});

test('delivery rejects pause, incomplete, and artifact drift',async t=>{
  const cfg=fixture(t);prepare(cfg,request('paused'));pause(cfg,'paused');assert.throws(()=>delivery(cfg,'paused'),/PAUSED/);
  const drift=fixture(t);await complete(drift,'drift',false);fs.writeFileSync(path.join(drift.workRoot,'result.txt'),'changed');assert.throws(()=>delivery(drift,'drift'),/Acceptance evidence|Accepted artifacts/);
});

test('delivery rejects stale knowledge capture content',async t=>{
  const cfg=fixture(t);await complete(cfg,'knowledge');const receipt=JSON.parse(fs.readFileSync(path.join(cfg.controlRoot,'runs/knowledge/knowledge-receipt.json')));fs.appendFileSync(receipt.captures[0].path,'changed');assert.throws(()=>delivery(cfg,'knowledge'),/Knowledge capture content changed/);
});

test('CLI persists parseable delivery once and completed continuation reuses acceptance',async t=>{
  const cfg=fixture(t),configFile=path.join(cfg.projectRoot,'project.json');writeJson(configFile,cfg);
  await complete(cfg,'cli');
  const output=path.join(cfg.projectRoot,'delivery.json');
  const result=await main(['continue','--project',configFile,'--run','cli','--output',output]);
  assert.deepEqual(JSON.parse(fs.readFileSync(output,'utf8')),result.delivery);
  const acceptance=fs.readFileSync(result.delivery.acceptance.path),receipt=fs.readFileSync(result.delivery.knowledge.path);
  await assert.rejects(main(['continue','--project',configFile,'--run','cli','--output',output]),/already exists/);
  const another=path.join(cfg.projectRoot,'another.json');
  const second=await main(['delivery','--project',configFile,'--run','cli','--output',another]);
  assert.deepEqual(second,result.delivery);assert.deepEqual(fs.readFileSync(second.acceptance.path),acceptance);assert.deepEqual(fs.readFileSync(second.knowledge.path),receipt);
});

test('disabled capture reports the boundary and still preserves a candidate',async t=>{
  const cfg=fixture(t);cfg.captureEnabled=false;await complete(cfg,'disabled');
  const result=delivery(cfg,'disabled');assert.equal(result.knowledge.status,'CAPTURE_DISABLED');assert.deepEqual(result.knowledge.captures,[]);
});
