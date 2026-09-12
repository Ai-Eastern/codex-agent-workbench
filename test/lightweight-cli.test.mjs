import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {main} from '../src/cli.mjs';
import {status,pause,prepare,getPacket} from '../src/workflow.mjs';
import {digest,writeJson} from '../src/contracts.mjs';
import {SqliteSaver} from '@langchain/langgraph-checkpoint-sqlite';

const children=['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','cccccccc-cccc-4ccc-8ccc-cccccccccccc'];
function fixture(t,mode='direct'){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-light-'));
  t.after(()=>{assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
  const cfg={projectId:'fixture',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:3,model:'gpt-5.5',thinking:'low',captureEnabled:true,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{}};
  const config=path.join(root,'project.json'),request=path.join(root,'request.json');writeJson(config,cfg);
  const tasks=(mode==='native'?['A','B','C']:['A']).map(id=>({id,objective:'write the assigned letter',files:[id+'.txt'],knowledge:{ids:[]}}));
  const req={id:'run',projectId:cfg.projectId,objective:'deliver exact letters',mode,reason:'independent bounded task',tasks,checks:[{id:'letters',command:process.execPath,args:['-e',`const fs=require('fs');for(const id of ${JSON.stringify(tasks.map(t=>t.id))})if(fs.readFileSync(id+'.txt','utf8')!==id)process.exit(1);fs.appendFileSync(${JSON.stringify(path.join(root,'check-count.txt'))},'x')`]}]};
  writeJson(request,req);const old=process.env.CODEX_THREAD_ID;process.env.CODEX_THREAD_ID=cfg.pmThreadId;t.after(()=>{if(old===undefined)delete process.env.CODEX_THREAD_ID;else process.env.CODEX_THREAD_ID=old;});
  return {root,cfg,config,request,req,begin:(extra=[])=>main(['begin','--project',config,'--request',request,...extra])};
}
const finishArgs=(f,p,extra=[])=>['finish','--project',f.config,'--run','run','--task',p.taskId,'--attempt',p.attemptId,'--summary','Completed the assigned letter',...extra];

test('direct begin and finish retain one acceptance, source-bound capture, and immutable delivery',async t=>{
  const f=fixture(t),started=await f.begin(),p=started.packets[0];assert.equal(started.nextAction.type,'EXECUTE_DIRECT');assert(p.prompt.includes('"finish"'));fs.writeFileSync(p.files[0],'A');
  const candidate=path.join(f.root,'candidate.json');writeJson(candidate,{id:'lesson',title:'exact letters',body:'Verify the exact assigned value.',kind:'solution'});
  const out=path.join(f.root,'delivery.json'),done=await main(finishArgs(f,p,['--candidate',candidate,'--output',out]));assert.equal(done.status,'COMPLETE');assert.equal(done.delivery.acceptance.passed,true);assert.equal(done.delivery.knowledge.status,'CAPTURED');assert.equal(fs.readFileSync(path.join(f.root,'check-count.txt'),'utf8'),'x');assert.deepEqual(JSON.parse(fs.readFileSync(out)),done.delivery);
  const acceptance=fs.readFileSync(done.delivery.acceptance.path);await assert.rejects(main(finishArgs(f,p)),/authorized|complete/i);const again=await f.begin();assert.equal(again.reused,true);assert.equal(again.packets,undefined);assert.deepEqual(fs.readFileSync(done.delivery.acceptance.path),acceptance);assert.equal(fs.readFileSync(path.join(f.root,'check-count.txt'),'utf8'),'x');
});
test('native begin claims all once; batch binding and leaf submission preserve actual actors',async t=>{
  const f=fixture(t,'native'),start=await f.begin();assert.equal(start.nextAction.type,'CREATE_NATIVE');assert.equal(start.packets.length,3);assert(start.tasks.every(x=>x.status==='NATIVE_CLAIMED'));
  const repeated=await f.begin();assert.equal(repeated.reused,true);assert.equal(repeated.nextAction.type,'BIND_NATIVE');assert.equal(repeated.packets,undefined);
  const bindings=Object.fromEntries(start.packets.map((p,i)=>[p.taskId,children[i]]));
  await assert.rejects(main(['bind','--project',f.config,'--run','run','--bindings',JSON.stringify({...bindings,C:bindings.B})]),/distinct|duplicate|unique/i);assert(status(f.cfg,'run').tasks.every(x=>x.status==='NATIVE_CLAIMED'));
  const bound=await main(['bind','--project',f.config,'--run','run','--bindings',JSON.stringify(bindings)]);assert(bound.tasks.every(x=>x.status==='NATIVE_BOUND'));assert.equal(bound.nextAction.type,'WAIT_FOR_WORKERS');
  for(const [i,p] of start.packets.entries()){
    fs.writeFileSync(p.files[0],p.taskId);process.env.CODEX_THREAD_ID=children[i];await assert.rejects(main(finishArgs(f,p)),/PM|direct/i);
    await main(['submit','--project',f.config,'--run','run','--task',p.taskId,'--attempt',p.attemptId,'--summary','done']);
  }
  process.env.CODEX_THREAD_ID=f.cfg.pmThreadId;const done=await main(['continue','--project',f.config,'--run','run']);assert.equal(done.status,'COMPLETE');assert.equal(fs.readFileSync(path.join(f.root,'check-count.txt'),'utf8'),'x');
});
test('batch binding rejects the whole batch when one target is invalid and preserves pause',async t=>{
  const f=fixture(t,'native');await f.begin();const invoke=bindings=>main(['bind','--project',f.config,'--run','run','--bindings',JSON.stringify(bindings)]);
  await assert.rejects(invoke({A:children[0],Unknown:children[1]}),/Unknown/);assert(status(f.cfg,'run').tasks.every(x=>x.status==='NATIVE_CLAIMED'));
  process.env.CODEX_THREAD_ID=children[0];await assert.rejects(invoke({A:children[0]}),/PM/);process.env.CODEX_THREAD_ID=f.cfg.pmThreadId;pause(f.cfg,'run');await assert.rejects(invoke({A:children[0]}),/authorized|paused/i);assert.equal(status(f.cfg,'run').status,'PAUSED');
});
test('begin rejects wrong PM, desktop route, changed contract and overlapping write sets before dispatch',async t=>{
  const f=fixture(t);process.env.CODEX_THREAD_ID=children[0];await assert.rejects(f.begin(),/PM/);assert.equal(fs.existsSync(path.join(f.cfg.controlRoot,'state.sqlite')),false);process.env.CODEX_THREAD_ID=f.cfg.pmThreadId;
  writeJson(f.request,{...f.req,mode:'langgraph'});await assert.rejects(f.begin(),/direct.*native/i);assert.equal(fs.existsSync(path.join(f.cfg.controlRoot,'state.sqlite')),false);writeJson(f.request,f.req);await f.begin();
  writeJson(f.request,{...f.req,objective:'changed'});await assert.rejects(f.begin(),/different contract/);
  writeJson(f.request,{...f.req,id:'second'});await assert.rejects(f.begin(),/UNIQUE|ownership/i);assert.throws(()=>status(f.cfg,'second'),/Unknown run/);
});
test('already prepared or paused begin does not start, resume or expose a fresh creation prompt',async t=>{
  const f=fixture(t,'native');prepare(f.cfg,f.req);const reused=await f.begin();assert.equal(reused.status,'PREPARED');assert.equal(reused.packets,undefined);pause(f.cfg,'run');const paused=await f.begin();assert.equal(paused.status,'PAUSED');assert(paused.tasks.every(x=>x.status==='PENDING'));
});
test('finish validates output and attempts before writing and cannot overwrite submitted results',async t=>{
  const f=fixture(t),p=(await f.begin()).packets[0];fs.writeFileSync(p.files[0],'A');const out=path.join(f.root,'existing.json');fs.writeFileSync(out,'preserve');
  await assert.rejects(main(finishArgs(f,p,['--output',out])),/already exists/);await assert.rejects(main(finishArgs(f,{...p,attemptId:'stale'})),/attempt/);assert.equal(fs.existsSync(p.receiptPath),false);
  await main(['submit',...finishArgs(f,p).slice(1)]);const bytes=fs.readFileSync(p.receiptPath);await assert.rejects(main(finishArgs(f,p)),/already exists/);assert.deepEqual(fs.readFileSync(p.receiptPath),bytes);assert.equal(fs.existsSync(path.join(f.root,'check-count.txt')),false);
});
test('failed acceptance remains failed and begin or finish cannot retry it',async t=>{
  const f=fixture(t),p=(await f.begin()).packets[0];fs.writeFileSync(p.files[0],'wrong');const failed=await main(finishArgs(f,p));assert.equal(failed.status,'FAILED');assert.equal(failed.delivery,undefined);
  const evidence=fs.readFileSync(failed.acceptance.path);assert.equal((await f.begin()).status,'FAILED');await assert.rejects(main(finishArgs(f,p)),/authorized/i);assert.deepEqual(fs.readFileSync(failed.acceptance.path),evidence);
});
test('compact begin saves complete claimed prompts; retry reads state without claiming again',async t=>{
  const f=fixture(t,'native'),view=await f.begin(['--view','compact','--max-output-chars','1024']);assert.equal(view.needsRead,true);const bytes=fs.readFileSync(view.presentation.detailsPath);assert.equal(digest(bytes),view.presentation.detailsHash);const full=JSON.parse(bytes);assert.equal(full.nextAction.type,'CREATE_NATIVE');assert.equal(full.packets.length,3);assert(full.packets.every(p=>p.prompt.includes(p.attemptId)));
  const retry=await f.begin(['--view','compact']);assert.equal(retry.nextAction.type,'BIND_NATIVE');assert.equal(retry.packets,undefined);
});
test('pause between native claim and final snapshot never returns creation permission',async t=>{
  const f=fixture(t,'native'),open=SqliteSaver.fromConnString;let opens=0;
  t.mock.method(SqliteSaver,'fromConnString',function(...args){
    if(++opens===4)pause(f.cfg,'run');
    return open.apply(this,args);
  });
  const result=await f.begin();assert.equal(result.status,'PAUSED');assert.equal(result.nextAction.type,'WAIT_FOR_USER');assert.equal(result.packets,undefined);
});
test('finish interrupted after submission keeps its receipt and resumes through continue only',async t=>{
  const f=fixture(t),p=(await f.begin()).packets[0];fs.writeFileSync(p.files[0],'A');const lock=path.join(f.cfg.controlRoot,'.runner.lock');fs.writeFileSync(lock,'occupied');
  await assert.rejects(main(finishArgs(f,p)),e=>e.code==='EEXIST'&&e.doNotRetry===true);
  const receipt=fs.readFileSync(p.receiptPath);assert.equal(fs.existsSync(path.join(f.root,'check-count.txt')),false);await assert.rejects(main(finishArgs(f,p)),/already exists/);assert.deepEqual(fs.readFileSync(p.receiptPath),receipt);
  fs.unlinkSync(lock);const done=await main(['continue','--project',f.config,'--run','run']);assert.equal(done.status,'COMPLETE');assert.equal(fs.readFileSync(path.join(f.root,'check-count.txt'),'utf8'),'x');
});
