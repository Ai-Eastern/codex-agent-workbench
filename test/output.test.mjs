import test from 'node:test';
import assert from 'node:assert/strict';
import {compactOutput} from '../src/output.mjs';

const details={detailsPath:'C:/details.json',detailsHash:'a'.repeat(64)};
const size=o=>JSON.stringify(o,null,2).length;

test('real search shape keeps every hit field and omits nested source details',()=>{
  const result={projectId:'p',query:'q',chars:22,items:[{id:'i',title:'title',path:'note.md',hash:'b'.repeat(64),text:'body',kind:'decision',source:{evidence:'x'.repeat(20000)}}]};
  const out=compactOutput('search',result,{...details,maxChars:1200});
  assert.equal(out.presentation.form,'compact-search');assert.deepEqual(out.items[0],{id:'i',title:'title',path:'note.md',hash:'b'.repeat(64),text:'body',kind:'decision'});assert.equal(size(out)<=1200,true);
});

test('execution packets remove duplicated structured fields while retaining prompt and identity',()=>{
  const result={projectId:'p',runId:'r',taskId:'A',attemptId:'a',mode:'native',model:'m',thinking:'low',contextHash:'h',receiptPath:'r.json',prompt:'警示与完整合同',objective:'duplicate',constraints:['duplicate'],taskConstraints:['duplicate'],files:['a.js'],dependencies:[{id:'B'}],repair:{previousAttemptId:'old'}};
  const out=compactOutput('packet',result,{...details,maxChars:12000});
  assert.equal(out.prompt,result.prompt);assert.equal(out.contextHash,'h');assert.equal(out.contextHashScope,'full-context');assert.equal(out.objective,undefined);assert.equal(out.repair,undefined);assert.equal(out.presentation.form,'compact-contract');
});

test('missing prompt keeps control output and packets remain executable on continue',()=>{
  const failed=compactOutput('start',{status:'FAILED',phase:'FAILED',nextAction:{type:'DIAGNOSE_FAILURE'},packets:[]},{...details,maxChars:12000});assert.equal(failed.status,'FAILED');assert.equal(failed.nextAction.type,'DIAGNOSE_FAILURE');
  const continued=compactOutput('continue',{status:'RUNNING',packets:[{taskId:'A',prompt:'合同',contextHash:'h',attemptId:'a'}]},{...details,maxChars:12000});assert.equal(continued.packets[0].prompt,'合同');assert.equal(continued.packets[0].contextHashScope,'full-context');
  const unsafe=compactOutput('packet',{constraints:['required'],files:['a.js']},{...details,maxChars:12000});assert.equal(unsafe.needsRead,true);
});

test('start output projects each returned packet without dropping executable prompt',()=>{
  const result={status:'RUNNING',packets:[{projectId:'p',runId:'r',taskId:'A',attemptId:'a',contextHash:'h',receiptPath:'r.json',prompt:'合同',objective:'重复',files:['a.js']}]};
  const out=compactOutput('start',result,{...details,maxChars:12000});assert.equal(out.status,'RUNNING');assert.equal(out.packets[0].prompt,'合同');assert.equal(out.packets[0].objective,undefined);assert.equal(out.packets[0].contextHash,'h');
});

test('oversized contracts and unknown commands use a bounded reference with failure warning',()=>{
  const contract=compactOutput('start',{prompt:'x'.repeat(20000),status:'BLOCKED',phase:'RUNNING'},{...details,maxChars:1024});
  assert.equal(contract.needsRead,true);assert.equal(contract.warning,'详情可能含阻塞/恢复约束，读取前不执行');assert.equal(size(contract)<=1024,true);
  const result={status:'BLOCKED',phase:'RUNNING',reason:'repair',delivery:{knowledge:'preserve'},blob:'x'.repeat(20000)};
  const out=compactOutput('submit',result,{...details,maxChars:1024});assert.equal(out.needsRead,true);assert.equal(out.delivery,undefined);assert.equal(size(out)<=1024,true);
});

test('input stays unchanged, references are mandatory, and minimum budget is enforced',()=>{
  const result={status:'OK',blob:'x'.repeat(20000)};const before=JSON.stringify(result);
  assert.throws(()=>compactOutput('status',result,{maxChars:12000}),/detailsPath/);assert.throws(()=>compactOutput('status',result,{...details,maxChars:1000}),/at least 1024/);
  const out=compactOutput('status',result,{...details,maxChars:1024});assert.equal(size(out)<=1024,true);assert.equal(JSON.stringify(result),before);
  assert.throws(()=>compactOutput('status',{status:'x'.repeat(2000)},{detailsPath:'C:/'+('p'.repeat(2000)),detailsHash:'a'.repeat(64),maxChars:1024}),/OUTPUT_BUDGET_TOO_SMALL/);
});
