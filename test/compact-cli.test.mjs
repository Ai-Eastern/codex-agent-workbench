import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main} from '../src/cli.mjs';
import {prepare,status,getPacket} from '../src/workflow.mjs';
import {writeJson,digest} from '../src/contracts.mjs';

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-compact-'));t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const cfg={projectId:'fixture',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:1,model:'gpt-5.5',thinking:'low',captureEnabled:false,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{}};
  const config=path.join(root,'project.json');writeJson(config,cfg);
  const req={id:'run',objective:'preserve contract',mode:'direct',reason:'test',constraints:['只改分配文件。'.repeat(80)],tasks:[{id:'A',objective:'write one result',files:['result.txt'],constraints:['固定值 result']}],checks:[{id:'result',command:process.execPath,args:['-e',"const fs=require('fs');if(fs.readFileSync('result.txt','utf8')!=='result')process.exit(1)"]}]};
  const old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=cfg.pmThreadId;t.after(()=>{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;});
  prepare(cfg,req);return {cfg,config};
}
function saved(view){const bytes=fs.readFileSync(view.presentation.detailsPath);assert.equal(digest(bytes),view.presentation.detailsHash);return JSON.parse(bytes);}
test('compact CLI preserves frozen execution prompt and keeps a complete hash-bound local record',async t=>{
  const {cfg,config}=fixture(t),out=await main(['start','--project',config,'--run','run','--view','compact']);
  const full=saved(out);assert.equal(out.nextAction.type,'EXECUTE_DIRECT');assert.equal(out.packets[0].prompt,full.packets[0].prompt);assert.equal(out.packets[0].contextHash,getPacket(cfg,'run','A').contextHash);
  assert(JSON.stringify(out,null,2).length<JSON.stringify(full,null,2).length);assert(JSON.stringify(out,null,2).length<=12000);
});
test('invalid compact budget is rejected before start or an observation file is created',async t=>{
  const {cfg,config}=fixture(t);await assert.rejects(main(['start','--project',config,'--run','run','--view','compact','--max-output-chars','10']),/1024/);
  assert.equal(status(cfg,'run').status,'PREPARED');assert.equal(fs.existsSync(path.join(cfg.controlRoot,'views')),false);
});
test('submit and compact continue reuse original acceptance and delivery semantics',async t=>{
  const {cfg,config}=fixture(t);await main(['start','--project',config,'--run','run']);const p=getPacket(cfg,'run','A');fs.writeFileSync(p.files[0],'result');
  const submitted=await main(['submit','--project',config,'--run','run','--task','A','--attempt',p.attemptId,'--summary','完成实现']);assert.equal(submitted.acceptance,'NOT_RUN');
  const output=path.join(cfg.projectRoot,'delivery.json'),out=await main(['continue','--project',config,'--run','run','--output',output,'--view','compact']);
  const full=saved(out),delivery=JSON.parse(fs.readFileSync(output));assert.equal(out.status,'COMPLETE');assert.deepEqual(delivery,full.delivery);assert.equal(delivery.acceptance.passed,true);
  const acceptance=fs.readFileSync(delivery.acceptance.path);await assert.rejects(main(['continue','--project',config,'--run','run','--output',output,'--view','compact']),e=>e.doNotRetry===true&&fs.existsSync(e.detailsPath));assert.deepEqual(fs.readFileSync(delivery.acceptance.path),acceptance);
});
test('compact search preserves retrieved note body and oversized execution output explicitly requires reading',async t=>{
  const {cfg,config}=fixture(t);fs.mkdirSync(cfg.vaultRoot,{recursive:true});fs.writeFileSync(path.join(cfg.vaultRoot,'rule.md'),'# boundary\nPreserve source evidence.');
  const search=await main(['search','--project',config,'--query','boundary','--view','compact']),full=saved(search);assert.equal(search.items.length,1);assert.equal(search.items[0].text,full.items[0].text);assert.equal(search.items[0].hash,full.items[0].hash);
  const out=await main(['start','--project',config,'--run','run','--view','compact','--max-output-chars','1024']);assert.equal(out.needsRead,true);assert(JSON.stringify(out,null,2).length<=1024);assert.equal(saved(out).packets[0].taskId,'A');
});
test('failed compact command exposes a hash-bound error detail and preserves original state',async t=>{
  const {cfg,config}=fixture(t);
  await assert.rejects(main(['submit','--project',config,'--run','run','--task','A','--attempt','stale','--summary','test','--view','compact']),error=>{
    assert.equal(error.doNotRetry,true);assert.equal(error.detailsHash,digest(fs.readFileSync(error.detailsPath)));return true;
  });
  assert.equal(status(cfg,'run').status,'PREPARED');
});
