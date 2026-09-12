import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {createKnowledge} from '../src/knowledge.mjs';
import {prepare,getPacket} from '../src/workflow.mjs';
import {validateRequest} from '../src/contracts.mjs';
import {main} from '../src/cli.mjs';

const sha = x => createHash('sha256').update(x).digest('hex');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-smart-'));
  const cfg={projectId:'smart',projectRoot:root,sourceRoot:root,workRoot:path.join(root,'work'),controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'notes'),maxWorkers:1,pmThreadId:'11111111-1111-4111-8111-111111111111'};
  fs.mkdirSync(cfg.vaultRoot);fs.mkdirSync(cfg.workRoot);fs.mkdirSync(cfg.controlRoot);
  const index=createKnowledge({...cfg,indexPath:path.join(cfg.controlRoot,'knowledge.sqlite')});
  t.after(()=>{index.close();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('workbench-smart-'));fs.rmSync(root,{recursive:true,force:true});});
  const note=(name,text)=>{fs.writeFileSync(path.join(cfg.vaultRoot,name),text);return 'file:'+sha(name);};
  return {cfg,index,note};
}

test('Chinese diversity preserves the primary result and includes a different relevant note with one scan',t=>{
  const {cfg,index,note}=fixture(t);
  const first=note('a.md','# 训练数据检查\n训练数据检查：检查重复样本和重复内容。');
  note('b.md','# 训练数据检查\n训练数据检查：检查重复样本和重复内容。');
  const different=note('c.md','# 训练数据校验\n训练数据需要核对标注、回复方和来源。');
  const original=fs.readdirSync;let scans=0;
  fs.readdirSync=(directory,...args)=>{if(path.resolve(directory)===cfg.vaultRoot)scans++;return original(directory,...args);};syncBuiltinESMExports();
  let result;
  try {result=index.search('训练数据检查',{strategy:'smart',limit:2});}
  finally {fs.readdirSync=original;syncBuiltinESMExports();}
  assert.equal(scans,1);assert.equal(result.retrieval.queryCount,2);
  assert.deepEqual(result.items.map(x=>x.id),[first,different]);
  assert.equal(result.items[0].hash,sha(fs.readFileSync(result.items[0].path)));
});

test('smart retrieval keeps ID scope, final budget and baseline default; invalid strategies fail',t=>{
  const {index,note}=fixture(t);
  const wanted=note('wanted.md','# 来源一致\n保留完整来源证据，不能修改旧验收。');
  note('other.md','# 来源一致\n无关记录');
  assert.deepEqual(index.search('来源一致'),index.search('来源一致',{strategy:'bm25'}));
  const result=index.search('来源一致',{strategy:'smart',ids:[wanted],maxChars:8});
  assert.deepEqual(result.items.map(x=>x.id),[wanted]);assert.equal(result.chars,8);assert.equal(result.items[0].text.length,8);
  for(const ids of [[],['missing']])assert.deepEqual(index.search('来源一致',{strategy:'smart',ids}).items,[]);
  for(const query of ['', '!!!', 'zzzzunrecorded'])assert.deepEqual(index.search(query,{strategy:'smart'}).items,[]);
  for(const strategy of [null,0,'SMART','vector'])assert.throws(()=>index.search('来源',{strategy}),/strategy/);
});

test('smart retrieval excludes stale capture evidence and cross-project Markdown',t=>{
  const {cfg,index}=fixture(t);const evidence=path.join(cfg.projectRoot,'accepted.json');fs.writeFileSync(evidence,'{}');
  const saved=index.capture({id:'proof',title:'校验来源',body:'已核对证据哈希',kind:'solution',source:{runId:'one',taskId:'one',evidence:[{path:'accepted.json',sha256:sha('{}')}]}});
  const foreign=fs.readFileSync(saved.path,'utf8').replace('"projectId":"smart"','"projectId":"other"').replace('"id":"proof"','"id":"foreign"');
  fs.writeFileSync(path.join(cfg.vaultRoot,'foreign.md'),foreign);
  assert.deepEqual(index.search('校验来源',{strategy:'smart'}).items.map(x=>x.id),['proof']);
  fs.writeFileSync(evidence,'{"changed":true}');
  assert.deepEqual(index.search('校验来源',{strategy:'smart'}).items,[]);
  assert.ok(fs.existsSync(saved.path));
});

test('explicit smart strategy reaches CLI and frozen task packets without changing old defaults',async t=>{
  const {cfg,note}=fixture(t);const id=note('contract.md','# 合同边界\n冻结来源和验收要求。');
  const configPath=path.join(cfg.projectRoot,'project.json');fs.writeFileSync(configPath,JSON.stringify(cfg));
  const live=await main(['search','--project',configPath,'--query','合同边界','--strategy','smart','--limit','1']);
  assert.equal(live.retrieval.strategy,'smart');assert.equal(live.items.length,1);
  const request={id:'smart-packet',mode:'direct',reason:'one bounded task',objective:'合同边界',tasks:[{id:'A',objective:'合同边界',files:['a.mjs'],knowledge:{query:'合同边界',strategy:'smart',limit:1}}],checks:[{id:'check',command:process.execPath,args:['--version']}]};
  for(const strategy of [null,'typo',2])assert.throws(()=>validateRequest({...request,tasks:[{...request.tasks[0],knowledge:{strategy}}]},cfg),/strategy/);
  prepare(cfg,request);const before=getPacket(cfg,request.id,'A');
  assert.equal(before.context.retrieval.strategy,'smart');assert.deepEqual(before.context.items.map(x=>x.id),[id]);
  note('contract.md','# 合同边界\n此后更新不得悄悄进入旧任务。');
  assert.equal(prepare(cfg,request).reused,true);assert.deepEqual(getPacket(cfg,request.id,'A'),before);
});
