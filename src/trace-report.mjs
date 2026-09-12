import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {digest,safePath,projectIdentity} from './contracts.mjs';

const labels={PREPARED:'准备记录建立后待启动',RUNNING:'执行与等待，未拆分',ACCEPTING:'验收状态区间',ACCEPTED:'验收后知识处理',FAILED:'失败停留，含等待',BLOCKED:'阻塞停留，含等待',COMPLETE_CAPTURE_PENDING:'知识保存待处理',COMPLETE:'已完成'};
const millis=n=>Number.isSafeInteger(n)&&n>=0;

export function controllerTimeline(run,events){
  if(!millis(run.created_at))throw Error('Invalid run timestamp');
  let lastAt=run.created_at,lastId=0;
  const phases=[{state:'PREPARED',label:labels.PREPARED,startMs:lastAt,startEventId:null}],markers=[];
  for(const e of events){
    if(!millis(e.at)||e.at<lastAt||!Number.isSafeInteger(e.id)||e.id<=lastId)throw Error('Controller event clock/order is invalid; timing not computed');
    lastAt=e.at;lastId=e.id;
    if(e.kind==='status'){
      if(!Object.hasOwn(labels,e.data.status))throw Error('Unknown controller state');
      const current=phases.at(-1);
      if(e.data.status!==current.state){current.endMs=e.at;current.durationMs=e.at-current.startMs;current.endEventId=e.id;phases.push({state:e.data.status,label:labels[e.data.status],startMs:e.at,startEventId:e.id});}
    }
    if(['prepared','paused','dispatch_intent','dispatch_failed','task_result','task_repair','blocked_task_repair','acceptance_recovery','dispatch_reconcile','acceptance','knowledge_correction','batch_preflight_failed'].includes(e.kind))markers.push({eventId:e.id,atMs:e.at,kind:e.kind,...(typeof e.data.taskId==='string'?{taskId:e.data.taskId}:{}),...(typeof e.data.attemptId==='string'?{attemptId:e.data.attemptId}:{}),...(typeof e.data.passed==='boolean'?{passed:e.data.passed}:{})});
  }
  const current=phases.at(-1),complete=events.length>0&&run.status==='COMPLETE'&&current.state==='COMPLETE';
  current.endMs=complete?lastAt:null;current.durationMs=complete?lastAt-current.startMs:null;current.observedThroughMs=lastAt;
  return {scope:'controller-state-residence-not-agent-compute',complete,observedStartMs:run.created_at,observedThroughMs:lastAt,observedWindowMs:lastAt-run.created_at,phases,markers,pauseRequests:markers.filter(m=>m.kind==='paused').length,pauseDurationMs:null,criticalPathMs:null};
}

function timestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))return null;
  const n=Date.parse(value);return millis(n)?n:null;
}
export function reportedTurns(cost){
  if(cost?.schemaVersion!==1||cost.scope!=='explicit-turn-rollout-telemetry'||typeof cost.id!=='string'||!Array.isArray(cost.actors)||!cost.actors.length||typeof cost.complete!=='boolean')throw Error('Expected an existing cost-report snapshot');
  const seen=new Set(),spans=[],diagnostics=[];
  for(const actor of cost.actors){
    if(typeof actor.threadId!=='string'||!actor.threadId||!Array.isArray(actor.turnIds)||!actor.turnIds.length||!Array.isArray(actor.usage?.turns))throw Error('Malformed cost actor scope');
    if(actor.usage.turns.some(t=>!actor.turnIds.includes(t.id)))throw Error('Cost turns differ from declared scope');
    for(const id of actor.turnIds){
      const key=JSON.stringify([actor.threadId,id]);if(typeof id!=='string'||!id||seen.has(key))throw Error('Duplicate or invalid cost turn scope');seen.add(key);
      const matches=actor.usage.turns.filter(t=>t.id===id);if(matches.length>1)throw Error('Duplicate cost turn data');
      const t=matches[0],start=timestamp(t?.startedAt),end=timestamp(t?.finishedAt),valid=start!==null&&end!==null&&end>=start;
      if(!valid)diagnostics.push({threadId:actor.threadId,turnId:id,code:t?'MISSING_OR_INVALID_TIME':'MISSING_TURN'});
      spans.push({threadId:actor.threadId,turnId:id,role:actor.role,project:actor.project,phase:actor.phase,kind:actor.kind,startMs:start,endMs:end,durationMs:valid?end-start:null,sourceDiagnostics:t?.diagnostics??[]});
    }
  }
  const known=spans.filter(s=>s.durationMs!==null),edges=known.flatMap(s=>s.durationMs?[{at:s.startMs,d:1},{at:s.endMs,d:-1}]:[]).sort((a,b)=>a.at-b.at||a.d-b.d);
  let active=0,peak=0,union=0,last=edges[0]?.at;
  for(const e of edges){if(active)union+=e.at-last;active+=e.d;peak=Math.max(peak,active);last=e.at;}
  const sum=known.reduce((n,s)=>n+s.durationMs,0);if(!Number.isSafeInteger(sum)||!Number.isSafeInteger(union))throw Error('Duration aggregate overflow');
  const singleThread=new Set(spans.map(s=>s.threadId)).size===1;
  return {scope:'independent-cost-manifest-not-bound-to-controller-run',costReportId:cost.id,sourceClaimedComplete:cost.complete,verifiedAgainstRollouts:false,allReportedTimesPresent:spans.length>0&&!diagnostics.length,clockCorrelation:singleThread?'single-thread-report':'unverified-between-threads',spans,diagnostics,knownParticipantMs:known.length?sum:null,knownCoveredWallMs:singleThread&&known.length?union:null,maxReportedOverlap:singleThread&&known.length?peak:null,criticalPathMs:null};
}

function commandTiming(cfg,run){
  if(!run.acceptance_hash)return {available:false,reason:'NO_ACCEPTANCE_RECEIPT'};
  const file=safePath(cfg.controlRoot,`runs/${run.id}/acceptance.json`);
  try{
    const bytes=fs.readFileSync(file);if(digest(bytes)!==run.acceptance_hash)throw Error('Acceptance receipt hash differs');
    const a=JSON.parse(bytes);if(a.runId!==run.id||a.requestHash!==run.digest||!Array.isArray(a.checks))throw Error('Acceptance receipt identity differs');
    const checks=a.checks.map(c=>({id:c.id,exitCode:c.exitCode,confirmedElapsedMs:Number.isInteger(c.exitCode)&&!c.error&&millis(c.elapsedMs)?c.elapsedMs:null}));
    const known=checks.filter(c=>c.confirmedElapsedMs!==null),sum=known.reduce((n,c)=>n+c.confirmedElapsedMs,0);if(!Number.isSafeInteger(sum))throw Error('Command duration overflow');
    return {available:true,scope:'latest-bound-acceptance-receipt-not-current-artifact-validation',receiptHash:run.acceptance_hash,recordedPassed:a.passed,checks,completeTiming:checks.length>0&&known.length===checks.length,knownConfirmedCommandMs:known.length?sum:null};
  }catch(error){return {available:false,reason:'RECEIPT_UNVERIFIED',message:error.message};}
}

export function traceReport(cfg,id,{cost}={}){
  const file=safePath(cfg.controlRoot,'state.sqlite'),db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec('BEGIN');
    const run=db.prepare('SELECT * FROM runs WHERE id=?').get(id);
    if(!run)throw Error('Unknown run');if(run.identity!==projectIdentity(cfg))throw Error('Project configuration changed; use the original run configuration');
    const rows=db.prepare('SELECT id,at,kind,data FROM events WHERE run_id=? ORDER BY id').all(id),events=rows.map(e=>({...e,data:JSON.parse(e.data)}));
    const controller=controllerTimeline(run,events),acceptanceCommands=commandTiming(cfg,run);
    const telemetry=cost?reportedTurns(cost):null;
    return {schemaVersion:1,projectId:cfg.projectId,runId:id,requestHash:run.digest,eventsHash:digest(rows),controller,acceptanceCommands,...(telemetry?{telemetry}:{}),measurementNotes:['Controller phases are observed state residence, including waiting; not model compute or maintenance labor.','Duplicate states do not create extra phases. Open intervals have no invented end time.','Pause duration, exact worker execution and critical path are unknown; historical task_result events lack attemptId.','Cost telemetry is a separate explicitly supplied manifest scope; roles, time overlap and labels do not bind it to this run.','Turn start can be the first reported context/usage event; wall time includes tools and waiting. Cross-host clocks are not independently verified.','Acceptance command timings cover only the latest hash-bound receipt, not every historic attempt.']};
  }finally{db.close();}
}
