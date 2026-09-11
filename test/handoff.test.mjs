import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as flow from '../src/workflow.mjs';
import {main} from '../src/cli.mjs';
import {digest,writeJson} from '../src/contracts.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-handoff-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cfg={projectId:'handoff',projectRoot:root,controlRoot:path.join(root,'control'),workRoot:path.join(root,'work'),vaultRoot:path.join(root,'knowledge'),maxWorkers:1,model:'gpt-5.5',thinking:'low',captureEnabled:true,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{}};
 const req={id:'handoff',mode:'direct',objective:'bounded delivery',reason:'one module',tasks:[{id:'D',objective:'write module',constraints:['Export only the assigned pure function; consume UI through its declared interface.'],files:['result.txt']}],checks:[{id:'value',command:'node',args:['-e',"if(require('node:fs').readFileSync('result.txt','utf8')!=='verified')process.exit(1)"]}]};
 writeJson(path.join(root,'project.json'),cfg);flow.prepare(cfg,req);return {cfg,req};
}
async function deliver(f,candidate){
 await flow.advance(f.cfg,f.req.id);const p=flow.getPacket(f.cfg,f.req.id,'D');fs.writeFileSync(p.files[0],'verified');
 const result={runId:p.runId,taskId:p.taskId,attemptId:p.attemptId,status:'done',summary:'written'};
 if(candidate!==undefined)result.knowledgeCandidate=candidate;
 writeJson(p.receiptPath,result);return p;
}
const candidate={id:'verified-rule',title:'Verified rule',body:'The fixture result must equal verified.',kind:'solution'};

test('direct assignment identifies the current PM and immediate work, including compact continuation',async t=>{
 const f=fixture(t);assert.equal(flow.status(f.cfg,f.req.id).nextAction.type,'START');
 const ready=await flow.advance(f.cfg,f.req.id);assert.equal(ready.nextAction.type,'EXECUTE_DIRECT');assert.equal(ready.nextAction.actorThreadId,f.cfg.pmThreadId);
 assert.deepEqual(ready.nextAction.taskIds,['D']);assert.deepEqual(ready.packets[0].taskConstraints,f.req.tasks[0].constraints);
 const again=await main(['continue','--project',path.join(f.cfg.projectRoot,'project.json'),'--run',f.req.id]);
 assert.equal(again.nextAction.type,'EXECUTE_DIRECT');assert.equal(Object.hasOwn(again,'packets'),false);assert.equal(fs.existsSync(ready.packets[0].receiptPath),false);
});

test('accepted summary supplies results without re-running checks and rejects stale artifacts',async t=>{
 const f=fixture(t),p=await deliver(f);let calls=0;
 const done=await flow.advance(f.cfg,f.req.id,{commandRunner:()=>{calls++;return {exitCode:0};}});
 assert.equal(done.nextAction.type,'REPORT_ACCEPTANCE');assert.equal(done.acceptance.verified,true);assert.deepEqual(done.acceptance.checks,[{id:'value',exitCode:0}]);
 await flow.advance(f.cfg,f.req.id,{commandRunner:()=>{throw Error('duplicate acceptance');}});assert.equal(calls,1);
 fs.writeFileSync(p.files[0],'changed');const changed=flow.status(f.cfg,f.req.id);
 assert.equal(changed.acceptance.verified,false);assert.equal(changed.nextAction.type,'RECONCILE_EVIDENCE');
});

test('invalid candidate is diagnosed before acceptance and corrected without changing delivery or rechecking',async t=>{
 const f=fixture(t),p=await deliver(f,[candidate]);let checks=0;
 const pending=await flow.advance(f.cfg,f.req.id,{commandRunner:()=>{checks++;return {exitCode:0};}});
 assert.equal(pending.status,'COMPLETE_CAPTURE_PENDING');assert.equal(pending.nextAction.type,'REPAIR_KNOWLEDGE');assert.match(pending.knowledgeIssues[0].message,/object/i);
 const db=new DatabaseSync(path.join(f.cfg.controlRoot,'state.sqlite'),{readOnly:true});
 const events=db.prepare('SELECT kind FROM events WHERE run_id=? ORDER BY id').all(f.req.id).map(x=>x.kind);db.close();
 assert(events.indexOf('knowledge_candidate_invalid')<events.indexOf('acceptance'));
 const original=fs.readFileSync(p.receiptPath),accepted=fs.readFileSync(pending.acceptance.path);
 const corrected=flow.repairKnowledge(f.cfg,f.req.id,'D',{expectedAcceptanceHash:pending.acceptance.hash,expectedCandidateHash:pending.knowledgeCandidates[0].hash,candidate,reason:'Correct array into the intended single candidate object.'});
 assert.equal(corrected.nextAction.type,'CONTINUE_CAPTURE');
 const complete=await flow.advance(f.cfg,f.req.id,{commandRunner:()=>{throw Error('must not repeat acceptance');}});
 assert.equal(complete.status,'COMPLETE');assert.equal(checks,1);assert.deepEqual(fs.readFileSync(p.receiptPath),original);assert.deepEqual(fs.readFileSync(pending.acceptance.path),accepted);
 const index=flow.knowledge(f.cfg);assert(index.search('fixture verified').items.some(x=>x.id===candidate.id));index.close();
});

test('candidate correction refuses stale, changed, or locked accepted evidence',async t=>{
 const f=fixture(t),p=await deliver(f,[candidate]);const pending=await flow.advance(f.cfg,f.req.id);
 const grant={expectedAcceptanceHash:pending.acceptance.hash,expectedCandidateHash:pending.knowledgeCandidates[0].hash,candidate,reason:'Correct candidate only.'};
 assert.throws(()=>flow.repairKnowledge(f.cfg,f.req.id,'D',{...grant,expectedCandidateHash:'0'.repeat(64)}),/candidate.*changed/i);
 const lock=path.join(f.cfg.controlRoot,'.runner.lock');fs.writeFileSync(lock,'owner');assert.throws(()=>flow.repairKnowledge(f.cfg,f.req.id,'D',grant),/EEXIST/);assert.equal(fs.readFileSync(lock,'utf8'),'owner');fs.unlinkSync(lock);
 fs.appendFileSync(p.receiptPath,' ');assert.throws(()=>flow.repairKnowledge(f.cfg,f.req.id,'D',grant),/receipt.*changed/i);
});
