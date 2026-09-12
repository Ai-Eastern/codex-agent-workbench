import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {costReport,costDiff,diffNumber,diffMap} from '../src/cost-report.mjs';

test('Ruflo borrowed comparison preserves zero baseline growth and unknown evidence',()=>{
  assert.deepEqual(diffNumber(0,12),{baseline:0,current:12,delta:12,pct:null,status:'new'});
  assert.equal(diffNumber(null,12).status,'unknown');
  assert.equal(diffMap({}, {PM:12})[0].status,'unknown');
  assert.equal(diffMap({}, {PM:12},{complete:true})[0].status,'new');
  assert.equal(diffMap({A:10},{B:20},{complete:true})[0].key,'B');
  assert.throws(()=>diffNumber(-1,3));
});
test('report requires explicit identity and non-overlapping turn scopes; excludes transcript text',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-cost-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,'rollout.jsonl');
  const u={input_tokens:10,cached_input_tokens:4,output_tokens:2,reasoning_output_tokens:1,total_tokens:12};
  await fs.writeFile(file,[{type:'session_meta',payload:{id:'thread'}},
    {type:'turn_context',timestamp:'2026-09-12T00:00:00Z',payload:{turn_id:'t',model:'model',user_instructions:'PRIVATE_TEXT'}},
    {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:u}}},
    {type:'response_item',payload:{type:'function_call',name:'exec',arguments:'PRIVATE_TEXT'}},
    {type:'response_item',payload:{type:'function_call_output',output:'PRIVATE_TEXT'}},
    {type:'event_msg',timestamp:'2026-09-12T00:01:00Z',payload:{type:'task_complete',turn_id:'t'}}].map(r=>JSON.stringify(r)).join('\n')+'\n');
  const a={threadId:'thread',rolloutPath:file,role:'PM',project:'fixture',phase:'delivery',kind:'product',turnIds:['t']};
  const m={schemaVersion:1,id:'fixture',actors:[a]};
  const report=await costReport(m);
  assert.equal(report.complete,true);assert.equal(report.reported.total_tokens,12);
  assert.equal(report.actors[0].activity.toolCalls,1);assert.equal(report.actors[0].activity.toolResultCharacters,12);
  assert.equal(JSON.stringify(report).includes('PRIVATE_TEXT'),false);
  await assert.rejects(costReport({...m,actors:[a,a]}),/Duplicate/);
  await assert.rejects(costReport({...m,actors:[{...a,threadId:'wrong'}]}),/identity/);
  await assert.rejects(costReport({...m,actors:[{...a,turnIds:[]}]}),/explicit/);
  const partial=await costReport({...m,actors:[{...a,turnIds:['missing']}]});
  assert.equal(partial.complete,false);assert.equal(partial.reported,null);
  const comparison=costDiff(partial,report);
  assert.equal(comparison.complete,false);assert.equal(comparison.totalTokens.status,'unknown');
  assert.equal(comparison.byRole[0].status,'unknown');
});
