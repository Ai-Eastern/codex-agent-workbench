// Read reported Codex rollout counters; these are telemetry, not a billing API.
const fields=['input_tokens','cached_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const zero=()=>Object.fromEntries(fields.map(k=>[k,0]));
export async function summarizeUsage(records,{turnIds}={}){
  let current=null,previous=zero();const turns=new Map(),diagnostics=[];
  const ensure=id=>{if(!turns.has(id))turns.set(id,{id,model:null,startedAt:null,finishedAt:null,usageEvents:0,reported:zero(),diagnostics:[]});return turns.get(id);};
  for await(const r of records){
    const p=r.payload??{};
    if(r.type==='turn_context'){current=p.turn_id;const t=ensure(current);t.model=p.model;t.startedAt??=r.timestamp;}
    if(r.type!=='event_msg')continue;
    if(p.type==='task_started'&&p.turn_id){current=p.turn_id;ensure(current).startedAt??=r.timestamp;}
    if(['task_complete','task_completed','turn_aborted'].includes(p.type)&&current){const t=ensure(p.turn_id??current);t.finishedAt=r.timestamp;if(p.type==='turn_aborted')t.diagnostics.push('aborted');}
    if(p.type!=='token_count'||!current)continue;
    const t=ensure(current),u=p.info?.total_token_usage;
    if(!u){t.diagnostics.push('missing_usage');continue;}
    const next=Object.fromEntries(fields.map(k=>[k,u[k]??null]));
    if(fields.some(k=>!Number.isSafeInteger(next[k])||next[k]<0)){t.diagnostics.push('invalid_counter');continue;}
    if(next.input_tokens+next.output_tokens!==next.total_tokens||next.cached_input_tokens>next.input_tokens||next.reasoning_output_tokens>next.output_tokens){t.diagnostics.push('inconsistent_counter');previous=next;continue;}
    const delta=Object.fromEntries(fields.map(k=>[k,next[k]-previous[k]]));previous=next;t.usageEvents++;
    if(fields.some(k=>delta[k]<0)){t.diagnostics.push('counter_reset');continue;}
    for(const k of fields)t.reported[k]+=delta[k];
    t.firstUsageAt??=r.timestamp;t.lastUsageAt=r.timestamp;
  }
  const selected=[...turns.values()].filter(t=>!turnIds||turnIds.includes(t.id));const reported=zero();
  for(const t of selected){if(!t.usageEvents)t.diagnostics.push('no_usage_events');for(const k of fields)reported[k]+=t.reported[k];for(const d of t.diagnostics)diagnostics.push(`${t.id}:${d}`);}
  if(!selected.length)diagnostics.push('no_selected_turns');
  const coherent=diagnostics.length===0;
  return {scope:'reported-rollout-telemetry',coherent,allTurnsTerminal:selected.length>0&&selected.every(t=>t.finishedAt),reported:coherent?reported:null,knownReportedLowerBound:reported,diagnostics,turns:selected};
}
