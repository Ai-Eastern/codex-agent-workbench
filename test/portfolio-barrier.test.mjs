import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {digest,projectIdentity} from '../src/contracts.mjs';
import {armPortfolioBarrier,releasePortfolioBarrier} from '../src/portfolio-barrier.mjs';

const uuid=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
function cfg(root,projectId,n){return {projectId,projectRoot:root,controlRoot:path.join(root,`${projectId}-control`),workRoot:path.join(root,`${projectId}-work`),vaultRoot:path.join(root,`${projectId}-knowledge`),pmThreadId:uuid(n),workerThreads:{},model:'gpt-5.5',thinking:'low',maxWorkers:3,captureEnabled:false};}
function fixture(t,count=2){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'portfolio-barrier-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const configs=Array.from({length:count},(_,i)=>cfg(root,`project-${i+1}`,i+1)),runId='run-1',manifestPath=path.join(root,'manifest.json');
  const manifest={id:'portfolio-1',projects:configs.map(c=>({projectId:c.projectId,runId,pmThreadId:c.pmThreadId,configHash:projectIdentity(c)}))};
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));return {root,configs,runId,manifestPath,manifest};
}
async function waitReady(root,count){
  const end=Date.now()+500;
  while(Date.now()<end){if(fs.readdirSync(root).filter(x=>x.endsWith('.ready.json')).length===count)return;await new Promise(r=>setTimeout(r,5));}
  assert.fail(`Expected ${count} ready files`);
}

test('release waits for every frozen-manifest project to become ready',async t=>{
  const f=fixture(t),first=armPortfolioBarrier(f.configs[0],f.runId,f.manifestPath,{timeoutMs:700,pollMs:10});
  await waitReady(f.root,1);
  assert.throws(()=>releasePortfolioBarrier(f.manifestPath),{code:'PORTFOLIO_BARRIER_INCOMPLETE'});
  const second=armPortfolioBarrier(f.configs[1],f.runId,f.manifestPath,{timeoutMs:700,pollMs:10});
  await waitReady(f.root,2);
  assert.equal(releasePortfolioBarrier(f.manifestPath).projects,2);
  assert.deepEqual((await Promise.all([first,second])).map(x=>x.status),['RELEASED','RELEASED']);
});

test('arm rejects a PM identity outside the frozen manifest',async t=>{
  const f=fixture(t,1),changed={...f.configs[0],thinking:'medium'};
  await assert.rejects(armPortfolioBarrier(changed,f.runId,f.manifestPath,{timeoutMs:100,pollMs:5}),error=>error.code==='PORTFOLIO_BARRIER_IDENTITY'&&error.delivery==='NOT_SENT');
  assert.equal(fs.readdirSync(f.root).some(x=>x.endsWith('.ready.json')),false);
});

test('manifest cannot bind one PM thread to two projects',async t=>{
  const f=fixture(t);f.manifest.projects[1].pmThreadId=f.manifest.projects[0].pmThreadId;fs.writeFileSync(f.manifestPath,JSON.stringify(f.manifest));
  await assert.rejects(armPortfolioBarrier(f.configs[0],f.runId,f.manifestPath,{timeoutMs:100,pollMs:5}),error=>error.code==='PORTFOLIO_BARRIER_INVALID'&&error.delivery==='NOT_SENT');
});

test('arm rejects a symlinked manifest path',async t=>{
  const f=fixture(t,1),link=path.join(f.root,'linked-manifest.json');
  try{fs.symlinkSync(f.manifestPath,link,'file');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('symlinks unavailable');return;}throw error;}
  await assert.rejects(armPortfolioBarrier(f.configs[0],f.runId,link,{timeoutMs:100,pollMs:5}),error=>error.code==='PORTFOLIO_BARRIER_INVALID'&&error.delivery==='NOT_SENT');
});

test('arm fails closed and removes only its ready file when the manifest changes',async t=>{
  const f=fixture(t,1),armed=armPortfolioBarrier(f.configs[0],f.runId,f.manifestPath,{timeoutMs:500,pollMs:5});
  await waitReady(f.root,1);fs.appendFileSync(f.manifestPath,' ');
  await assert.rejects(armed,error=>error.code==='PORTFOLIO_BARRIER_CHANGED'&&error.delivery==='NOT_SENT');
  assert.equal(fs.readdirSync(f.root).some(x=>x.endsWith('.ready.json')),false);
});

test('duplicate arm cannot overwrite or clean up the first PM ready file',async t=>{
  const f=fixture(t,1),first=armPortfolioBarrier(f.configs[0],f.runId,f.manifestPath,{timeoutMs:500,pollMs:5});
  await waitReady(f.root,1);
  await assert.rejects(armPortfolioBarrier(f.configs[0],f.runId,f.manifestPath,{timeoutMs:100,pollMs:5}),error=>error.code==='PORTFOLIO_BARRIER_CONFLICT'&&error.delivery==='NOT_SENT');
  assert.equal(fs.readdirSync(f.root).filter(x=>x.endsWith('.ready.json')).length,1);
  fs.appendFileSync(f.manifestPath,' ');await assert.rejects(first,{code:'PORTFOLIO_BARRIER_CHANGED'});
});

test('timeout is NOT_SENT and cleans up the PM ready file',async t=>{
  const f=fixture(t,1);
  await assert.rejects(armPortfolioBarrier(f.configs[0],f.runId,f.manifestPath,{timeoutMs:80,pollMs:5}),error=>error.code==='PORTFOLIO_BARRIER_TIMEOUT'&&error.delivery==='NOT_SENT');
  assert.equal(fs.readdirSync(f.root).some(x=>x.endsWith('.ready.json')),false);
});

test('arm rejects a release first observed after its deadline',async t=>{
  const f=fixture(t,1),armed=armPortfolioBarrier(f.configs[0],f.runId,f.manifestPath,{timeoutMs:40,pollMs:40});
  await waitReady(f.root,1);const end=Date.now()+70;while(Date.now()<end){}
  fs.writeFileSync(path.join(f.root,'release.json'),JSON.stringify({manifestId:f.manifest.id,manifestHash:digest(fs.readFileSync(f.manifestPath)),projects:1}));
  await assert.rejects(armed,error=>error.code==='PORTFOLIO_BARRIER_TIMEOUT'&&error.delivery==='NOT_SENT');
  assert.equal(fs.readdirSync(f.root).some(x=>x.endsWith('.ready.json')),false);
});

test('release rejects an expired ready record even while its PID is alive',t=>{
  const f=fixture(t,1),item=f.manifest.projects[0],now=Date.now(),ready=path.join(f.root,`${item.projectId}.${item.runId}.ready.json`);
  fs.writeFileSync(ready,JSON.stringify({manifestId:f.manifest.id,manifestHash:digest(fs.readFileSync(f.manifestPath)),projectId:item.projectId,runId:item.runId,pmThreadId:item.pmThreadId,pid:process.pid,createdAt:now-200,expiresAt:now-100}));
  assert.throws(()=>releasePortfolioBarrier(f.manifestPath),error=>error.code==='PORTFOLIO_BARRIER_INCOMPLETE'&&error.delivery==='NOT_SENT');
  assert.equal(fs.existsSync(path.join(f.root,'release.json')),false);
});

test('release rejects dead ready owners and can be created only once',async t=>{
  const dead=fixture(t,1),pending=armPortfolioBarrier(dead.configs[0],dead.runId,dead.manifestPath,{timeoutMs:500,pollMs:5});
  await waitReady(dead.root,1);
  const ready=path.join(dead.root,fs.readdirSync(dead.root).find(x=>x.endsWith('.ready.json'))),record=JSON.parse(fs.readFileSync(ready,'utf8'));
  fs.writeFileSync(ready,JSON.stringify({...record,pid:2147483647}));
  assert.throws(()=>releasePortfolioBarrier(dead.manifestPath),error=>error.code==='PORTFOLIO_BARRIER_INCOMPLETE'&&error.delivery==='NOT_SENT');
  fs.appendFileSync(dead.manifestPath,' ');await assert.rejects(pending,{code:'PORTFOLIO_BARRIER_CHANGED'});
  assert.equal(fs.existsSync(ready),true);

  const once=fixture(t,1),armed=armPortfolioBarrier(once.configs[0],once.runId,once.manifestPath,{timeoutMs:500,pollMs:5});
  await waitReady(once.root,1);releasePortfolioBarrier(once.manifestPath);
  assert.throws(()=>releasePortfolioBarrier(once.manifestPath),error=>error.code==='PORTFOLIO_BARRIER_CONFLICT'&&error.delivery==='NOT_SENT');
  assert.equal((await armed).status,'RELEASED');
});
