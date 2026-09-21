import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {startApp} from '../src/app-server.mjs';
import http from 'node:http';

async function apiFixture(t,executor){
  const root=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'workbench-api-'));
  const repository=path.join(root,'repo'),stateRoot=path.join(root,'state');fs.mkdirSync(repository);
  const git=(...args)=>execFileSync('git',args,{cwd:repository,encoding:'utf8',windowsHide:true});
  git('init','-q');fs.writeFileSync(path.join(repository,'value.txt'),'old');git('add','.');
  git('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','baseline');
  const {url,stop}=await startApp({repository,stateRoot,port:0,executor});
  t.after(async()=>{
    await stop();
    assert(root.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep+'workbench-api-'));
    if(fs.existsSync(path.join(stateRoot,'runs')))for(const id of fs.readdirSync(path.join(stateRoot,'runs'))){const target=path.join(stateRoot,'runs',id,'worktree');if(fs.existsSync(target))git('worktree','remove','--force',target);}
    fs.rmSync(root,{recursive:true,force:true});
  });
  return {root,repository,stateRoot,url};
}

test('live task API requires local authorization and submits real worktree changes for acceptance',async t=>{
  let invocations=0;
  const {repository,url}=await apiFixture(t,async ({cwd,onEvent})=>{
    invocations++;onEvent({type:'item.completed',item:{type:'agent_message',text:'测试执行器，未调用模型'}});
    fs.writeFileSync(path.join(cwd,'value.txt'),'fixed');return {status:'completed',summary:'测试执行器输出',exitCode:0};
  });
  const project=await(await fetch(`${url}/api/project`)).json();assert.equal(project.repository,repository);
  const malformed=await new Promise((resolve,reject)=>{
    const request=http.request({hostname:'127.0.0.1',port:new URL(url).port,path:'http://['},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});
    request.once('error',reject);request.end();
  });
  assert.equal(malformed,400);
  assert.equal((await fetch(`${url}/api/project`)).status,200);
  assert.equal((await fetch(`${url}/api/runs`,{method:'POST',body:'{}'})).status,403);
  const headers={'Content-Type':'application/json','X-Workbench-Token':project.token};
  assert.equal((await fetch(`${url}/api/runs`,{method:'POST',headers:{...headers,Origin:'https://foreign.example'},body:'{}'})).status,403);
  assert.equal(invocations,0);
  const task={objective:'修复目标文件',files:['value.txt'],checks:[{id:'value',command:'node',args:['-e',"if(require('fs').readFileSync('value.txt','utf8')!=='fixed')process.exit(1)"]}]};
  const response=await fetch(`${url}/api/runs`,{method:'POST',headers,body:JSON.stringify(task)});
  assert.equal(response.status,202);const {id}=await response.json();
  let record;
  const deadline=Date.now()+30000;
  do {record=await(await fetch(`${url}/api/runs/${id}`)).json();if(['READY_FOR_REVIEW','BLOCKED'].includes(record.phase))break;await delay(20);}while(Date.now()<deadline);
  assert.equal(record.phase,'READY_FOR_REVIEW');assert.equal(record.request.objective,task.objective);assert.equal(invocations,1);
  assert.equal(record.acceptanceDetails.passed,true);assert.equal(record.acceptanceDetails.checks[0].exitCode,0);
  assert.deepEqual(record.acceptanceDetails.checks[0].args,task.checks[0].args);
  const {diff}=await(await fetch(`${url}/api/runs/${id}/diff`)).json();assert.match(diff,/\+fixed/);
  const {events}=await(await fetch(`${url}/api/runs/${id}/events`)).json();assert(events.some(e=>e.type==='workbench.ready'));
  assert.equal(fs.readFileSync(path.join(repository,'value.txt'),'utf8'),'old');
  assert.equal((await(await fetch(`${url}/api/runs`)).json()).runs.length,1);
  assert.equal((await fetch(`${url}/api/runs/${id}/repair`,{method:'POST',headers,body:JSON.stringify({reason:'not failed'})})).status,400);
  fs.writeFileSync(record.acceptance.path,'{"passed":true,"checks":[{"stdout":"untrusted replacement"}]}');
  const changed=await(await fetch(`${url}/api/runs/${id}`)).json();
  assert.equal(changed.phase,'EVIDENCE_CHANGED');assert.equal(changed.acceptanceDetails,undefined);
  assert.match(changed.acceptanceError,/changed/);
  assert.equal((await fetch(`${url}/api/runs/${id}/diff`)).status,400);
});

test('GET stays responsive during real acceptance and API cancellation blocks delivery',async t=>{
  let invocations=0;
  const {repository,stateRoot,url}=await apiFixture(t,async ({cwd})=>{
    invocations++;
    fs.writeFileSync(path.join(cwd,'value.txt'),'fixed');
    return {status:'completed',summary:'合成执行器；验收运行真实子进程，模型调用为 0',exitCode:0};
  });
  const project=await(await fetch(`${url}/api/project`)).json();
  const headers={'Content-Type':'application/json','X-Workbench-Token':project.token};
  const code="const fs=require('fs'),path=require('path');const {outputRoot}=JSON.parse(process.env.CODEX_WORKBENCH_CHECK);fs.mkdirSync(outputRoot,{recursive:true});fs.writeFileSync(path.join(outputRoot,'started.json'),JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)";
  const request={objective:'验证验收期间可查询与取消',files:['value.txt'],checks:[{id:'slow',command:'node',args:['-e',code],timeoutMs:10000}]};
  const submitted=await fetch(`${url}/api/runs`,{method:'POST',headers,body:JSON.stringify(request)});
  assert.equal(submitted.status,202);
  const {id}=await submitted.json();
  const runRoot=path.join(stateRoot,'runs',id);
  const marker=path.join(runRoot,'control','runs',id,'check-output','slow','started.json');
  const startupDeadline=Date.now()+6000;
  while(!fs.existsSync(marker)&&Date.now()<startupDeadline)await delay(20);
  assert.ok(fs.existsSync(marker),'the real acceptance command must have started');
  const {pid}=JSON.parse(fs.readFileSync(marker,'utf8'));
  assert.doesNotThrow(()=>process.kill(pid,0),'acceptance must still be running when GET is sent');
  const readStarted=Date.now();
  const current=await fetch(`${url}/api/runs/${id}`,{signal:AbortSignal.timeout(2000)});
  assert.equal(current.status,200);
  assert.equal((await current.json()).phase,'ACCEPTING');
  assert.ok(Date.now()-readStarted<2000,'GET must respond while the long acceptance command is still running');
  const canceled=await fetch(`${url}/api/runs/${id}/cancel`,{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(2000)});
  assert.equal(canceled.status,202);
  assert.equal((await canceled.json()).status,'STOP_REQUESTED');
  let record;
  const finishDeadline=Date.now()+10000;
  do{record=await(await fetch(`${url}/api/runs/${id}`)).json();if(record.phase!=='ACCEPTING')break;await delay(20);}while(Date.now()<finishDeadline);
  assert.equal(record.phase,'BLOCKED');
  assert.equal(record.acceptance.passed,false);
  assert.equal(record.patch,undefined);
  const acceptance=JSON.parse(fs.readFileSync(record.acceptance.path,'utf8'));
  assert.equal(acceptance.checks[0].exitCode,null);
  assert.equal(acceptance.checks[0].error,'ABORTED');
  assert.equal(fs.existsSync(path.join(runRoot,'candidate.patch')),false);
  assert.equal((await fetch(`${url}/api/runs/${id}/diff`)).status,400);
  const {events}=await(await fetch(`${url}/api/runs/${id}/events`)).json();
  assert.ok(events.some(event=>event.type==='workbench.check.started'));
  assert.equal(events.some(event=>event.type==='workbench.ready'),false);
  assert.equal(invocations,1);
  assert.equal(fs.readFileSync(path.join(repository,'value.txt'),'utf8'),'old');
});
