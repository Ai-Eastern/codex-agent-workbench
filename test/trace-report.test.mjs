import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {controllerTimeline,reportedTurns,taskAttemptTimeline,traceReport} from '../src/trace-report.mjs';
import {prepare,advance,getPacket} from '../src/workflow.mjs';
import {writeJson} from '../src/contracts.mjs';
import {main} from '../src/cli.mjs';

const event=(id,at,kind,data={})=>({id,at,kind,data});
test('state spans partition elapsed wall time, collapse polls and keep repair/failure markers',()=>{
  const es=[event(1,0,'prepared'),event(2,10,'status',{status:'RUNNING'}),event(3,20,'status',{status:'RUNNING'}),event(4,30,'status',{status:'FAILED'}),event(5,50,'task_repair',{taskId:'A',attemptId:'new'}),event(6,50,'status',{status:'RUNNING'}),event(7,80,'status',{status:'ACCEPTING'}),event(8,90,'acceptance',{passed:true}),event(9,90,'status',{status:'COMPLETE'})];
  const r=controllerTimeline({created_at:0,status:'COMPLETE'},es);
  assert.deepEqual(r.phases.map(p=>[p.state,p.durationMs]),[['PREPARED',10],['RUNNING',20],['FAILED',20],['RUNNING',30],['ACCEPTING',10],['COMPLETE',0]]);
  assert.equal(r.phases.reduce((n,p)=>n+p.durationMs,0),r.observedWindowMs);assert.equal(r.criticalPathMs,null);assert.equal(r.markers.find(m=>m.kind==='task_repair').attemptId,'new');
});
test('pause is a point and an open phase never acquires an invented end',()=>{
  const r=controllerTimeline({created_at:100,status:'RUNNING'},[event(1,110,'status',{status:'RUNNING'}),event(2,120,'paused')]);
  assert.equal(r.complete,false);assert.equal(r.phases.at(-1).durationMs,null);assert.equal(r.phases.at(-1).endMs,null);assert.equal(r.observedThroughMs,120);assert.equal(r.pauseRequests,1);assert.equal(r.pauseDurationMs,null);
});
test('task timing is grouped by attempt and only matching observed turns get an interval',()=>{
  const es=[
    event(1,1,'task_assigned',{taskId:'A',attemptId:'old',mode:'langgraph',threadId:'worker'}),
    event(2,2,'dispatch_intent',{taskId:'A',attemptId:'old',threadId:'worker'}),
    event(3,3,'dispatch_ack',{taskId:'A',attemptId:'old',threadId:'worker'}),
    event(4,4,'turn_started_observed',{taskId:'A',attemptId:'old',threadId:'worker',turnId:'turn-1'}),
    event(5,9,'task_result',{taskId:'A',attemptId:'old',threadId:'worker',turnId:'turn-2',status:'done'}),
    event(6,10,'task_repair',{taskId:'A',previousAttemptId:'old',attemptId:'new'}),
    event(7,11,'task_assigned',{taskId:'A',attemptId:'new',mode:'langgraph',threadId:'worker'}),
    event(8,12,'turn_started_observed',{taskId:'A',attemptId:'new',threadId:'worker',turnId:'turn-3'}),
    event(9,15,'task_result',{taskId:'A',attemptId:'new',threadId:'worker',turnId:'turn-3',status:'done'}),
    event(10,16,'task_result',{taskId:'A',status:'done'})
  ];
  const r=taskAttemptTimeline(es);
  assert.deepEqual(r.attempts.map(x=>x.attemptId),['old','new']);
  assert.equal(r.attempts[0].turnObservation,null);
  assert.deepEqual(r.attempts[0].diagnostics,['TURN_ID_MISMATCH']);
  assert.deepEqual(r.attempts[1].turnObservation,{turnId:'turn-3',startMs:12,endMs:15,durationMs:3});
  assert.deepEqual(r.unassociated,[{eventId:10,atMs:16,kind:'task_result',taskId:'A'}]);
  const changed=structuredClone(es);changed[8].data.threadId='different-worker';
  assert.equal(taskAttemptTimeline(changed).attempts[1].turnObservation,null);
});
test('clock reversals and malformed event order cannot produce plausible elapsed values',()=>{
  for(const es of [[event(1,9,'prepared')],[event(2,20,'prepared'),event(1,20,'paused')],[event(1,20,'prepared'),event(2,19,'paused')],[event(1,NaN,'prepared')]])assert.throws(()=>controllerTimeline({created_at:10,status:'RUNNING'},es),/clock\/order/);
});
const stamp=ms=>new Date(ms).toISOString();
const cost=(windows)=>({schemaVersion:1,scope:'explicit-turn-rollout-telemetry',id:'fixture',complete:true,actors:windows.map(([start,end],i)=>({threadId:`worker-${i}`,turnIds:['t'],role:'engineer',project:'fixture',phase:'declared-phase',kind:'product',usage:{turns:[{id:'t',startedAt:stamp(start),finishedAt:end===null?null:stamp(end),diagnostics:[]}]}}))});
test('unknown cross-thread clocks never produce a combined wall time; one stream uses union',()=>{
  const input=cost([[0,10],[5,15],[15,20]]),r=reportedTurns(input);
  assert.equal(r.knownParticipantMs,25);assert.equal(r.knownCoveredWallMs,null);assert.equal(r.maxReportedOverlap,null);assert.equal(r.verifiedAgainstRollouts,false);assert.equal(r.criticalPathMs,null);assert.match(r.scope,/not-bound/);
  input.actors=[{...input.actors[0],turnIds:['a','b','c'],usage:{turns:input.actors.map((a,i)=>({...a.usage.turns[0],id:['a','b','c'][i]}))}}];
  const one=reportedTurns(input);assert.equal(one.knownCoveredWallMs,20);assert.equal(one.knownParticipantMs,25);assert.equal(one.maxReportedOverlap,2);
});
test('missing, incomplete, reversed and timezone-less telemetry remains partial; duplicates reject',()=>{
  const input=cost([[0,10],[5,null]]);input.actors.push({...cost([[0,1]]).actors[0],threadId:'missing',usage:{turns:[]}});
  const r=reportedTurns(input);assert.equal(r.allReportedTimesPresent,false);assert.equal(r.knownCoveredWallMs,null);assert.equal(r.knownParticipantMs,10);assert.equal(r.diagnostics.length,2);
  const bad=cost([[10,0]]);assert.equal(reportedTurns(bad).spans[0].durationMs,null);
  bad.actors[0].usage.turns[0].startedAt='2026-09-12 12:00:00';assert.equal(reportedTurns(bad).knownCoveredWallMs,null);
  const duplicate=cost([[0,10]]);duplicate.actors.push(duplicate.actors[0]);assert.throws(()=>reportedTurns(duplicate),/Duplicate/);
  const extra=cost([[0,10]]);extra.actors[0].usage.turns.push({id:'not-declared'});assert.throws(()=>reportedTurns(extra),/scope/);
});

test('CLI report only reads existing state, binds receipt timing and refuses overwrite/identity drift',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-trace-'));
  let db;
  t.after(()=>{db?.close();assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'workbench-trace-'));fs.rmSync(root,{recursive:true,force:true});});
  const cfg={projectId:'trace',projectRoot:root,workRoot:path.join(root,'work'),controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'knowledge'),maxWorkers:1,model:'gpt-5.6-luna',thinking:'medium',captureEnabled:true,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{A:'22222222-2222-4222-8222-222222222222'}};
  const config=path.join(root,'project.json');writeJson(config,cfg);
  prepare(cfg,{projectId:'trace',id:'trace',objective:'trace fixture',reason:'bounded test',mode:'direct',tasks:[{id:'A',objective:'write artifact',files:['result.txt']}],checks:[{id:'one',command:'node',args:['-e','process.exit(0)']}]});
  await advance(cfg,'trace');const p=getPacket(cfg,'trace','A');fs.writeFileSync(p.files[0],'done');writeJson(p.receiptPath,{runId:'trace',taskId:'A',attemptId:p.attemptId,status:'done',summary:'fixture',knowledgeIds:[]});
  await advance(cfg,'trace',{commandRunner:async()=>({exitCode:0,elapsedMs:7})});
  db=new DatabaseSync(path.join(cfg.controlRoot,'state.sqlite'),{readOnly:true});const count=()=>db.prepare('SELECT COUNT(*) AS n FROM events').get().n,before=count();
  const report=traceReport(cfg,'trace');assert.equal(report.controller.complete,true);assert.equal(report.acceptanceCommands.knownConfirmedCommandMs,7);assert.equal(count(),before);
  assert.throws(()=>traceReport({...cfg,projectId:'other'},'trace'),/configuration changed/);
  const file=path.join(root,'trace.json');await main(['trace-report','--project',config,'--run','trace','--output',file]);const bytes=fs.readFileSync(file);await assert.rejects(main(['trace-report','--project',config,'--run','trace','--output',file]),/EEXIST/);assert.deepEqual(fs.readFileSync(file),bytes);assert.equal(count(),before);
  fs.appendFileSync(path.join(cfg.controlRoot,'runs/trace/acceptance.json'),' ');assert.equal(traceReport(cfg,'trace').acceptanceCommands.available,false);
});
