import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {createHash} from 'node:crypto';
import {summarizeUsage} from './usage.mjs';

const fields=['input_tokens','cached_input_tokens','cache_write_input_tokens','output_tokens','reasoning_output_tokens','total_tokens'];
const zero=()=>Object.fromEntries(fields.map(k=>[k,0]));

// Borrowed and adapted from ruvnet/ruflo scripts/diff.mjs (MIT).
// Pinned source and copyright notice: ../third_party/ruflo-cost-LICENSE.txt.
// Unlike upstream, unknown counters stay unknown and a zero baseline is explicit.
export function diffNumber(b,c){
  if(b===null||c===null||b===undefined||c===undefined)return {baseline:b??null,current:c??null,delta:null,pct:null,status:'unknown'};
  if(!Number.isSafeInteger(b)||!Number.isSafeInteger(c)||b<0||c<0)throw Error('Diff requires nonnegative safe integer token counters');
  const delta=c-b;
  return {baseline:b,current:c,delta,pct:b>0?delta/b*100:c>0?null:0,status:b===0&&c>0?'new':c===0&&b>0?'removed':delta===0?'unchanged':'changed'};
}
export function diffMap(bMap,cMap,{complete=false}={}){
  const keys=new Set([...Object.keys(bMap??{}),...Object.keys(cMap??{})]);
  return [...keys].map(key=>({key,...diffNumber(bMap?.[key]??(complete?0:null),cMap?.[key]??(complete?0:null))}))
    .sort((a,b)=>Math.abs(b.delta??0)-Math.abs(a.delta??0)||a.key.localeCompare(b.key));
}

function validateManifest(manifest){
  if(manifest.schemaVersion!==1||typeof manifest.id!=='string'||!Array.isArray(manifest.actors)||!manifest.actors.length)throw Error('Expected schemaVersion 1, id and nonempty explicit actors');
  const seen=new Set();
  for(const a of manifest.actors){
    for(const key of ['threadId','role','project','phase','kind'])if(typeof a[key]!=='string'||!a[key].trim())throw Error(`Actor needs ${key}`);
    if(!path.isAbsolute(a.rolloutPath??''))throw Error('Actor rolloutPath must be absolute; no HOME or history discovery');
    if(!Array.isArray(a.turnIds)||!a.turnIds.length||a.turnIds.some(id=>typeof id!=='string'||!id))throw Error('Actor needs explicit turnIds');
    for(const id of a.turnIds){const key=JSON.stringify([a.threadId,id]);if(seen.has(key))throw Error('Duplicate thread/turn scope would double count usage');seen.add(key);}
  }
}

async function readTelemetry(file){
  const records=[],activity=new Map(),hash=createHash('sha256');
  let current=null,threadId=null;
  const input=fs.createReadStream(file);input.on('data',chunk=>hash.update(chunk));
  const lines=readline.createInterface({input,crlfDelay:Infinity});
  for await(const line of lines){
    if(!line.trim())continue;
    const r=JSON.parse(line),p=r.payload??{};
    if(r.type==='session_meta')threadId=p.id;
    if(r.type==='turn_context')current=p.turn_id;
    if(r.type==='event_msg'&&p.type==='task_started'&&p.turn_id)current=p.turn_id;
    if(r.type==='turn_context'||r.type==='token_usage_record'||r.type==='event_msg'&&['task_started','task_complete','task_completed','turn_aborted','token_count'].includes(p.type)){
      // Retain counters and lifecycle metadata only, never source text/prompts.
      records.push({timestamp:r.timestamp,type:r.type,payload:r.type==='turn_context'?{turn_id:p.turn_id,model:p.model}:r.type==='token_usage_record'?{turn_id:p.turn_id,response_id:p.response_id,usage:p.usage,turn_token_usage:p.turn_token_usage,model:p.model}:{type:p.type,turn_id:p.turn_id,info:p.type==='token_count'?{total_token_usage:p.info?.total_token_usage}:undefined}});
    }
    if(r.type==='response_item'&&current){
      if(!activity.has(current))activity.set(current,{toolCalls:0,toolResults:0,toolResultCharacters:0,byTool:{}});
      const t=activity.get(current);
      if(['function_call','custom_tool_call'].includes(p.type)){t.toolCalls++;const name=p.name??'unknown';t.byTool[name]=(t.byTool[name]??0)+1;}
      if(['function_call_output','custom_tool_call_output'].includes(p.type)){t.toolResults++;t.toolResultCharacters+=typeof p.output==='string'?p.output.length:JSON.stringify(p.output??'').length;}
    }
  }
  return {threadId,records,activity,sha256:hash.digest('hex')};
}

function add(target,usage){for(const key of fields){target[key]+=usage[key]??(key==='cache_write_input_tokens'?0:NaN);if(!Number.isSafeInteger(target[key]))throw Error('Invalid aggregate token count');}}
function group(actors,key){
  const groups=new Map();
  for(const a of actors){const name=key(a);if(!groups.has(name))groups.set(name,{key:name,complete:true,reported:zero(),knownReportedLowerBound:zero(),responses:0});const g=groups.get(name);g.complete&&=a.complete;add(g.knownReportedLowerBound,a.usage.knownReportedLowerBound);g.responses+=a.responses;}
  return [...groups.values()].map(g=>({...g,reported:g.complete?g.knownReportedLowerBound:null}));
}
export async function costReport(manifest){
  validateManifest(manifest);const cache=new Map(),actors=[];
  for(const a of manifest.actors){
    if(!cache.has(a.rolloutPath))cache.set(a.rolloutPath,await readTelemetry(a.rolloutPath));
    const data=cache.get(a.rolloutPath);
    if(data.threadId!==a.threadId)throw Error('Rollout session identity differs from manifest');
    const usage=await summarizeUsage(data.records,{turnIds:a.turnIds});
    const complete=usage.coherent&&usage.allTurnsTerminal;
    const activity={toolCalls:0,toolResults:0,toolResultCharacters:0,byTool:{}};
    for(const id of a.turnIds){const v=data.activity.get(id);if(!v)continue;for(const k of ['toolCalls','toolResults','toolResultCharacters'])activity[k]+=v[k];for(const [k,n] of Object.entries(v.byTool))activity.byTool[k]=(activity.byTool[k]??0)+n;}
    const responses=usage.turns.reduce((n,t)=>n+(t.responses?.length??0),0),u=usage.knownReportedLowerBound;
    actors.push({...a,rolloutSha256:data.sha256,complete,usage,responses,activity,
      inputReuseRatio:u.input_tokens?u.cached_input_tokens/u.input_tokens:null,
      uncachedInputTokens:u.input_tokens-u.cached_input_tokens,
      averageInputPerResponse:responses?u.input_tokens/responses:null});
  }
  const complete=actors.every(a=>a.complete),lower=zero();for(const a of actors)add(lower,a.usage.knownReportedLowerBound);
  const modelTurns=actors.flatMap(a=>a.usage.turns.map(t=>({model:t.model??'unknown',complete:a.complete,usage:{knownReportedLowerBound:t.reported},responses:t.responses?.length??0})));
  return {schemaVersion:1,id:manifest.id,collectedAt:new Date().toISOString(),scope:'explicit-turn-rollout-telemetry',complete,reported:complete?lower:null,knownReportedLowerBound:lower,
    measurementNotes:['Not a billing API; no USD estimate or subscription conversion.','Cached input is a subset of input; reasoning is a subset of output.','Phase/kind are explicit manifest labels, not causal per-tool token attribution.','Tool counters cover top-level recorded calls; nested calls are not inferred. Output characters are not tokens.','Active or inconsistent turns remain partial. No missing data is treated as zero.'],
    byRole:group(actors,a=>a.role),byModel:group(modelTurns,a=>a.model),byPhase:group(actors,a=>a.phase),byKind:group(actors,a=>a.kind),actors};
}
export function costDiff(baseline,current){
  for(const s of [baseline,current])if(s?.schemaVersion!==1||s.scope!=='explicit-turn-rollout-telemetry'||typeof s.complete!=='boolean')throw Error('Expected cost-report snapshots');
  const complete=baseline.complete&&current.complete;
  const maps=key=>[baseline,current].map(s=>Object.fromEntries((s[key]??[]).map(g=>[g.key,g.reported?.total_tokens??null])));
  return {schemaVersion:1,comparison:'observational-not-causal',baselineId:baseline.id,currentId:current.id,complete,
    totalTokens:diffNumber(baseline.reported?.total_tokens,current.reported?.total_tokens),
    observedLowerBoundDelta:diffNumber(baseline.knownReportedLowerBound?.total_tokens,current.knownReportedLowerBound?.total_tokens),
    byTokenClass:diffMap(baseline.reported,current.reported),
    byRole:diffMap(...maps('byRole'),{complete}),byModel:diffMap(...maps('byModel'),{complete}),byPhase:diffMap(...maps('byPhase'),{complete})};
}
