import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {createKnowledge} from '../src/knowledge.mjs';
import {validateRequest} from '../src/contracts.mjs';
import {prepare,getPacket} from '../src/workflow.mjs';

test('explicit knowledge IDs filter before top-k and preserve the normal body budget',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-scope-'));
  assert.ok(path.basename(root).startsWith('workbench-scope-'));
  const vault=path.join(root,'notes');fs.mkdirSync(vault);
  for(let i=0;i<6;i++)fs.writeFileSync(path.join(vault,`noise-${i}.md`),'# validation\nvalidation');
  const body='# Target\nvalidation '+ '合同边界'.repeat(2000);
  fs.writeFileSync(path.join(vault,'target.md'),body);
  const k=createKnowledge({projectId:'scope',sourceRoot:root,vaultRoot:vault,indexPath:path.join(root,'index.sqlite')});
  t.after(()=>{k.close();fs.rmSync(root,{recursive:true,force:true});});
  const id='file:'+createHash('sha256').update('target.md').digest('hex');
  assert.notEqual(k.search('validation',{limit:1}).items[0].id,id);
  const hit=k.search('validation',{ids:[id],limit:1,maxChars:200});
  assert.deepEqual(hit.items.map(x=>x.id),[id]);assert.equal(hit.chars,200);assert.equal(hit.items[0].text,body.slice(0,200));
  assert.deepEqual(k.search('validation',{ids:[]}).items,[]);
  assert.deepEqual(k.search('validation',{ids:['missing']}).items,[]);
  for(const ids of [null,'all',[3],[''],['a\nb'],Array(51).fill('x')])assert.throws(()=>k.search('validation',{ids}),/knowledge IDs/);
});

test('task knowledge policy rejects invalid or misspelled options before preparing a run',()=>{
  const root=path.resolve(os.tmpdir(),'workbench-scope-contract');
  const cfg={projectId:'scope',projectRoot:root,workRoot:path.join(root,'work'),controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'notes'),maxWorkers:1};
  const req={id:'scope',mode:'direct',reason:'one task',objective:'bounded',tasks:[{id:'A',objective:'A',files:['a.mjs']}],checks:[{id:'x',command:'node',args:[]}]};
  for(const knowledge of [null,[],{query:4},{query:'x'.repeat(2049)},{ids:'all'},{ids:['']},{limit:0},{limit:51},{maxChars:-1},{maxChars:100001},{stage:'coding'}]){
    assert.throws(()=>validateRequest({...req,tasks:[{...req.tasks[0],knowledge}]},cfg),/knowledge/i);
  }
  assert.deepEqual(validateRequest({...req,tasks:[{...req.tasks[0],knowledge:{query:'合同',ids:[],limit:2,maxChars:1500}}]},cfg).tasks[0].knowledge,{query:'合同',ids:[],limit:2,maxChars:1500});
});

test('prepare applies task scope and never rewrites a previously frozen knowledge packet',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-scope-packet-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg={projectId:'scope',projectRoot:root,workRoot:path.join(root,'work'),controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'notes'),maxWorkers:1,model:'gpt-5.6-luna',thinking:'medium'};
  fs.mkdirSync(cfg.vaultRoot);const note=path.join(cfg.vaultRoot,'target.md');fs.writeFileSync(note,'# validation\ncurrent contract');
  fs.writeFileSync(path.join(cfg.vaultRoot,'noise.md'),'# validation\nold scores');
  const id='file:'+createHash('sha256').update('target.md').digest('hex');
  const req={id:'packet',mode:'direct',reason:'one task',objective:'unrelated',tasks:[{id:'A',objective:'bounded',files:['a.mjs'],knowledge:{query:'validation',ids:[id],limit:1,maxChars:20}}],checks:[{id:'x',command:'node',args:[]}]};
  prepare(cfg,req);const before=getPacket(cfg,req.id,'A');
  assert.deepEqual(before.context.items.map(x=>x.id),[id]);assert.equal(before.context.chars,20);
  fs.writeFileSync(note,'# validation\nchanged source');
  assert.equal(prepare(cfg,req).reused,true);assert.deepEqual(getPacket(cfg,req.id,'A'),before);
});
