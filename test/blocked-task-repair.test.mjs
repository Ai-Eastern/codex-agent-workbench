import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as w from '../src/workflow.mjs';
import {digest,writeJson} from '../src/contracts.mjs';
async function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'blocked-repair-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const cfg={projectId:'fixture',projectRoot:root,workRoot:path.join(root,'work'),controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'knowledge'),model:'gpt-5.6-luna',thinking:'medium',maxWorkers:2,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{A:'22222222-2222-4222-8222-222222222222',B:'33333333-3333-4333-8333-333333333333'},captureEnabled:false};
 const req={id:'blocked',objective:'two independent modules',mode:'langgraph',reason:'bounded test',tasks:[{id:'A',objective:'A',files:['a.txt']},{id:'B',objective:'B',files:['b.txt']}],checks:[{id:'test',command:'node',args:['-e','process.exit(0)']}]};
 const sent=[],heads=new Map();let block=true;
 const desktop={read:async id=>({id,archived:false,status:'idle',turnId:heads.get(id)??'before',turnStatus:'completed'}),send:async id=>{const role=Object.keys(cfg.workerThreads).find(r=>cfg.workerThreads[r]===id),p=w.getPacket(cfg,req.id,role);sent.push(role);fs.writeFileSync(p.files[0],role+':output');writeJson(p.receiptPath,{runId:req.id,taskId:role,attemptId:p.attemptId,status:role==='B'&&block?'blocked':'done',summary:'fixture'});heads.set(id,p.attemptId);}};
 w.prepare(cfg,req);await w.advance(cfg,req.id,{desktop});await w.advance(cfg,req.id,{desktop});const packet=w.getPacket(cfg,req.id,'B');
 const grant={expectedAttemptId:packet.attemptId,expectedReceiptHash:digest(fs.readFileSync(packet.receiptPath)),expectedArtifactsHash:digest(Object.fromEntries(req.tasks.flatMap(t=>t.files).map(f=>[f,digest(fs.readFileSync(path.join(cfg.workRoot,f)))]))),reason:'Diagnosed guard bug; repair only B.',desktop};
 return {cfg,req,desktop,packet,grant,sent,unblock:()=>block=false};
}
test('one blocked independent task can be repaired without redispatching completed peers',async t=>{
 const f=await fixture(t);assert.equal(typeof w.repairBlockedTask,'function');
 const oldA=w.getPacket(f.cfg,f.req.id,'A'),beforeA=fs.readFileSync(oldA.files[0]),oldReceipt=fs.readFileSync(f.packet.receiptPath);
 const s=await w.repairBlockedTask(f.cfg,f.req.id,'B',f.grant);assert.equal(s.status,'RUNNING');assert.equal(s.tasks[0].status,'DONE');
 const next=w.getPacket(f.cfg,f.req.id,'B');assert.notEqual(next.attemptId,f.packet.attemptId);assert.notEqual(next.receiptPath,f.packet.receiptPath);
 f.unblock();await w.advance(f.cfg,f.req.id,{desktop:f.desktop});let checks=0;
 assert.equal((await w.advance(f.cfg,f.req.id,{desktop:f.desktop,commandRunner:()=>{checks++;return {exitCode:0};}})).status,'COMPLETE');
 assert.deepEqual(f.sent,['A','B','B']);assert.equal(checks,1);assert.deepEqual(fs.readFileSync(oldA.files[0]),beforeA);assert.deepEqual(fs.readFileSync(f.packet.receiptPath),oldReceipt);
});
test('blocked repair rejects stale evidence, unavailable peers and a second explicit repair',async t=>{
 const f=await fixture(t);
 await assert.rejects(w.repairBlockedTask(f.cfg,f.req.id,'B',{...f.grant,expectedArtifactsHash:'0'.repeat(64)}),/artifact/i);
 await assert.rejects(w.repairBlockedTask(f.cfg,f.req.id,'B',{...f.grant,expectedReceiptHash:'0'.repeat(64)}),/receipt/i);
 await assert.rejects(w.repairBlockedTask(f.cfg,f.req.id,'B',{...f.grant,desktop:{read:async id=>({...await f.desktop.read(id),archived:true})}}),/unavailable/);
 await w.repairBlockedTask(f.cfg,f.req.id,'B',f.grant);await w.advance(f.cfg,f.req.id,{desktop:f.desktop});await w.advance(f.cfg,f.req.id,{desktop:f.desktop});
 await assert.rejects(w.repairBlockedTask(f.cfg,f.req.id,'B',f.grant),/budget/);
});
test('completed peer artifacts stay protected during the repair',async t=>{
 const f=await fixture(t);await w.repairBlockedTask(f.cfg,f.req.id,'B',f.grant);
 fs.writeFileSync(w.getPacket(f.cfg,f.req.id,'A').files[0],'unexpected edit');
 await assert.rejects(w.advance(f.cfg,f.req.id,{desktop:f.desktop}),/Protected/);assert.equal(w.status(f.cfg,f.req.id).status,'BLOCKED');assert.deepEqual(f.sent,['A','B']);
});
test('completed peer changes cannot be adopted as a new repair baseline',async t=>{
 const f=await fixture(t),peer=w.getPacket(f.cfg,f.req.id,'A');fs.writeFileSync(peer.files[0],'tampered before repair');
 const changed=digest(Object.fromEntries(f.req.tasks.flatMap(t=>t.files).map(file=>[file,digest(fs.readFileSync(path.join(f.cfg.workRoot,file)))])));
 await assert.rejects(w.repairBlockedTask(f.cfg,f.req.id,'B',{...f.grant,expectedArtifactsHash:changed}),/completed peer artifact/i);
 assert.equal(w.status(f.cfg,f.req.id).status,'BLOCKED');
});
test('legacy DONE events without artifact hashes cannot authorize repair',async t=>{
 const f=await fixture(t),db=new DatabaseSync(path.join(f.cfg.controlRoot,'state.sqlite'));
 const row=db.prepare("SELECT id,data FROM events WHERE run_id=? AND kind='task_result' ORDER BY id").all(f.req.id).map(x=>({...x,data:JSON.parse(x.data)})).find(x=>x.data.taskId==='A');
 delete row.data.artifacts;db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(row.data),row.id);db.close();
 await assert.rejects(w.repairBlockedTask(f.cfg,f.req.id,'B',f.grant),/completed peer artifact evidence/i);
 assert.equal(w.status(f.cfg,f.req.id).status,'BLOCKED');
});
