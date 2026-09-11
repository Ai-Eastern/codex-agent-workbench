import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeUsage} from '../src/usage.mjs';
const context=id=>({type:'turn_context',timestamp:'start',payload:{turn_id:id,model:'gpt-5.3-codex-spark'}});
const usage=(input,cached,output,reasoning)=>({type:'event_msg',timestamp:'usage',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,output_tokens:output,reasoning_output_tokens:reasoning,total_tokens:input+output}}}});
const done=id=>({type:'event_msg',timestamp:'end',payload:{type:'task_complete',turn_id:id}});
test('cumulative repeated counters are not summed again and subsets stay separate',async()=>{
 const r=await summarizeUsage([context('one'),usage(100,80,20,5),usage(100,80,20,5),usage(150,110,30,9),done('one')]);
 assert.equal(r.coherent,true);assert.equal(r.allTurnsTerminal,true);assert.equal(r.reported.total_tokens,180);assert.equal(r.reported.cached_input_tokens,110);assert.equal(r.reported.reasoning_output_tokens,9);
});
test('turn selection subtracts earlier lifetime counters instead of charging prior work',async()=>{
 const r=await summarizeUsage([context('old'),usage(100,80,20,5),done('old'),context('new'),usage(160,120,40,10),done('new')],{turnIds:['new']});
 assert.equal(r.reported.total_tokens,80);assert.equal(r.reported.input_tokens,60);assert.equal(r.reported.output_tokens,20);
});
test('missing or reset counters remain incomplete, never fabricate a complete total',async()=>{
 const r=await summarizeUsage([context('bad'),usage(100,80,20,5),usage(10,0,2,0),done('bad')]);assert.equal(r.coherent,false);assert.equal(r.reported,null);assert(r.diagnostics.some(d=>d.includes('counter_reset')));
 const absent=await summarizeUsage([context('empty'),done('empty')]);assert.equal(absent.reported,null);
});
