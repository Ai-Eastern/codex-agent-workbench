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
const attributed=(turn,response,input,output,turnInput=input,turnOutput=output)=>({type:'token_usage_record',timestamp:`t-${response}`,payload:{turn_id:turn,response_id:response,usage:{input_tokens:input,cached_input_tokens:Math.floor(input/2),cache_write_input_tokens:0,output_tokens:output,reasoning_output_tokens:0,total_tokens:input+output},turn_token_usage:{input_tokens:turnInput,cached_input_tokens:Math.floor(turnInput/2),cache_write_input_tokens:0,output_tokens:turnOutput,reasoning_output_tokens:0,total_tokens:turnInput+turnOutput}}});
test('attributed records deduplicate responses and reconcile against final turn total',async()=>{
 const a=attributed('one','r1',10,2),b=attributed('one','r2',20,3,30,5);const r=await summarizeUsage([a,a,b,done('one')]);
 assert.equal(r.coherent,true);assert.equal(r.measurementMethod,'attributed-response-usage');assert.equal(r.reported.input_tokens,30);assert.equal(r.reported.output_tokens,5);assert.equal(r.turns[0].responses.length,2);
});
test('conflicting response duplicate and turn mismatch are conservative',async()=>{
 const a=attributed('one','r1',10,2),conflict=attributed('one','r1',11,2),bad=attributed('one','r2',20,3,31,5);const r=await summarizeUsage([a,conflict,bad,done('one')]);
 assert.equal(r.coherent,false);assert.equal(r.reported,null);assert.equal(r.knownReportedLowerBound.input_tokens,30);assert(r.diagnostics.some(d=>d.includes('conflicting_duplicate')));assert(r.diagnostics.some(d=>d.includes('response_sum_differs')));
});
test('explicit missing and unfinished attributed turns are diagnosed',async()=>{
 const r=await summarizeUsage([attributed('one','r1',10,2)],{turnIds:['one','missing']});assert.equal(r.coherent,false);assert.equal(r.allTurnsTerminal,false);assert(r.diagnostics.includes('missing:missing_turn'));assert(r.diagnostics.some(d=>d.includes('unfinished_turn')));
});
test('legacy and attributed records coexist without double counting',async()=>{
 const r=await summarizeUsage([context('legacy'),usage(5,2,1,0),done('legacy'),attributed('attr','r1',10,2),done('attr')]);assert.equal(r.coherent,true);assert.equal(r.reported.input_tokens,15);assert.equal(r.reported.output_tokens,3);assert.equal(r.measurementMethod,'attributed-response-usage-with-legacy-fallback');
});
test('missing required usage fields are invalid while cache_write remains optional',async()=>{
 const missing={type:'token_usage_record',payload:{turn_id:'one',response_id:'r1',usage:{},turn_token_usage:{}}};
 const five=attributed('two','r2',10,2);delete five.payload.usage.cache_write_input_tokens;delete five.payload.turn_token_usage.cache_write_input_tokens;
 const r=await summarizeUsage([missing,five,done('one'),done('two')]);assert.equal(r.coherent,false);assert(r.diagnostics.some(d=>d.includes('one:invalid_usage_record')));assert.equal(r.turns.find(t=>t.id==='two').responses.length,1);
});
test('legacy reset does not pollute a complete attributed turn, invalid attribution never falls back',async()=>{
 const a=attributed('one','r1',10,2),legacy=[context('one'),usage(5,2,1,0),usage(1,0,1,0)];
 const good=await summarizeUsage([...legacy,a,done('one')]);assert.equal(good.coherent,true);assert.equal(good.reported.input_tokens,10);
 const bad={type:'token_usage_record',payload:{turn_id:'two',response_id:'r2',usage:{input_tokens:10,output_tokens:2},turn_token_usage:{input_tokens:10,output_tokens:2}}};
 const fallback=await summarizeUsage([context('two'),usage(5,2,1,0),bad,done('two')]);assert.equal(fallback.coherent,false);assert.equal(fallback.reported,null);
});
test('duplicate response turn total conflicts are diagnosed',async()=>{
 const a=attributed('one','r1',10,2,10,2),b=attributed('one','r1',10,2,11,2),r=await summarizeUsage([a,b,done('one')]);assert.equal(r.coherent,false);assert(r.diagnostics.some(d=>d.includes('conflicting_duplicate_turn_total')));
});
test('unselected orphan records do not affect selected diagnostics',async()=>{
 const orphan={type:'token_usage_record',payload:{usage:{},turn_token_usage:{}}},r=await summarizeUsage([orphan,context('one'),usage(5,2,1,0),done('one')],{turnIds:['one']});assert.equal(r.coherent,true);assert.deepEqual(r.diagnostics,[]);
});
test('aggregate overflow is diagnosed instead of wrapping',async()=>{
 const max=Number.MAX_SAFE_INTEGER, rec=id=>({type:'token_usage_record',payload:{turn_id:id,response_id:`r-${id}`,usage:{input_tokens:max,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:max},turn_token_usage:{input_tokens:max,cached_input_tokens:0,output_tokens:0,reasoning_output_tokens:0,total_tokens:max}}});
 const r=await summarizeUsage([rec('one'),done('one'),rec('two'),done('two')]);assert.equal(r.coherent,false);assert(r.diagnostics.some(d=>d.includes('aggregate_overflow')));assert.equal(r.reported,null);
});
