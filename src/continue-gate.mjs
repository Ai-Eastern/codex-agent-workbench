// Borrowed decision pattern: Ruflo ContinueGate, pinned in ../docs/continue-gate-reuse-20260912.md.
// Only consume existing run facts. No inferred steps, token budget, time limits or new state.
export function continueGate(db,run,tasks,action,acceptance){
  // Other anomalies (including RECONCILE_EVIDENCE) retain their existing nextAction/details.
  if(!['START','DIAGNOSE_FAILURE','RECONCILE_BLOCK','REPAIR_KNOWLEDGE'].includes(action))return null;
  const signals=[];
  if(action==='REPAIR_KNOWLEDGE'){
    if(acceptance?.verified&&acceptance.passed)signals.push({code:'KNOWLEDGE_ONLY',message:'工程已验收；只处理知识，不重做代码或验收。'});
  }else if(action==='START'){
    // Only the initial PREPARED batch: later blocked recovery retains its original diagnosis.
    const e=db.prepare("SELECT COUNT(*) AS count,MAX(id) AS lastEventId FROM events WHERE run_id=? AND kind='batch_preflight_failed'").get(run.id);
    if(e.count>=2)signals.push({code:'REPEATED_PREFLIGHT_FAILURE',count:e.count,lastEventId:e.lastEventId,message:'首批准备阶段多次预检失败；先核对条件变化，避免重复 start。'});
  }else{
    const reserved=tasks.filter(t=>t.status==='RESERVED').map(t=>t.task_id);
    if(reserved.length)signals.push({code:'DELIVERY_UNCONFIRMED',taskIds:reserved,message:'送达不明；保留原任务，不按超时重发。'});
    const repairs=db.prepare("SELECT COUNT(*) AS count,MAX(id) AS lastEventId FROM events WHERE run_id=? AND kind IN ('task_repair','blocked_task_repair')").get(run.id);
    if(repairs.count)signals.push({code:'REPAIR_BUDGET_USED',count:repairs.count,lastEventId:repairs.lastEventId,message:'本运行的一次代码返修预算已使用；不能再派代码返修或换 ID 重置预算。'});
    const failed=action==='DIAGNOSE_FAILURE'&&acceptance?.verified&&!acceptance.passed?acceptance.checks.find(c=>Number.isInteger(c.exitCode)&&c.exitCode!==0):null;
    if(failed){
      // Count only the current failed check in the current code attempt, not every recovery.
      const e=db.prepare("SELECT COUNT(*) AS count,MAX(id) AS lastEventId FROM events WHERE run_id=? AND kind='acceptance_recovery' AND id>? AND json_extract(data,'$.nextCheck')=?").get(run.id,repairs.lastEventId??0,failed.id);
      if(e.count>=2)signals.push({code:'REPEATED_ACCEPTANCE_RECOVERY',checkId:failed.id,count:e.count,lastEventId:e.lastEventId,message:'当前失败检查已多次恢复；核对新证据，避免重复同一接续。'});
    }
  }
  return signals.length?{advisoryOnly:true,signals}:null;
}
