import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {decode, desktopClient, readThreadState} from '../src/desktop.mjs';

function db(rows) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-state-'));
  tempDirs.add(dir);
  const file=path.join(dir,'state_5.sqlite');
  const d=new DatabaseSync(file);
  d.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0)');
  const s=d.prepare('INSERT INTO threads (id,cwd,archived) VALUES (?,?,?)');
  for(const r of rows)s.run(r.id,r.cwd,typeof r.archived==='boolean'?(r.archived?1:0):r.archived);
  d.close();
  return {dir,file};
}
const cfg=(state, root)=>({desktopStatePath:state, projectRoot:root, pmThreadId:'pm', workerThreads:{w:'worker'}, model:'m', thinking:'high'});
const tempDirs=new Set();
test.afterEach(()=>{for(const dir of tempDirs){fs.rmSync(dir,{recursive:true,force:true}); tempDirs.delete(dir);}});

test('archived thread is rejected before bridge send', async()=>{
  const {file}=db([{id:'archived',cwd:'C:\\project',archived:true}]);
  process.env.CODEX_THREAD_ID='pm'; process.env.CODEX_APP_TOOLS_PIPE_PATH=path.join(os.tmpdir(),'missing-pipe');
  const c=desktopClient({...cfg(file,'C:\\project'), pmThreadId:'pm'});
  await assert.rejects(c.send('archived','hello'), e=>e.code==='THREAD_ARCHIVED'&&e.delivery==='NOT_SENT');
});
test('missing database and wrong cwd are explicit failures',()=>{
  assert.throws(()=>readThreadState(cfg(path.join(os.tmpdir(),'missing-state.sqlite'),'C:\\project'),'x'), /state database/i);
  const {file}=db([{id:'x',cwd:'C:\\other',archived:false}]);
  assert.throws(()=>readThreadState(cfg(file,'C:\\project'),'x'), /different|cwd/i);
});
test('CODEX_HOME resolves state database directly',()=>{
  const {file,dir}=db([{id:'x',cwd:'C:\\project',archived:0}]);
  const old=process.env.CODEX_HOME;
  try { process.env.CODEX_HOME=dir; const r=readThreadState({projectRoot:'C:\\project'},'x'); assert.equal(r.archived,false); assert.equal(r.availabilityEvidence.statePath,file); }
  finally { if(old===undefined)delete process.env.CODEX_HOME; else process.env.CODEX_HOME=old; }
});
test('unknown archive metadata is rejected',()=>{
  const {file}=db([{id:'x',cwd:'C:\\project',archived:2}]);
  assert.throws(()=>readThreadState(cfg(file,'C:\\project'),'x'),e=>e.code==='THREAD_ARCHIVE_UNKNOWN'&&e.delivery==='NOT_SENT');
});
test('valid local state returns archived false and evidence',()=>{
  const {file}=db([{id:'x',cwd:'C:\\project',archived:false}]);
  const r=readThreadState(cfg(file,'C:\\project'),'x');
  assert.equal(r.archived,false); assert.match(r.availabilityEvidence.fields,/archived/);
});
test('Windows extended cwd prefix is equivalent',()=>{
  const {file}=db([{id:'x',cwd:'\\\\?\\C:\\project',archived:false}]);
  assert.equal(readThreadState(cfg(file,'C:\\project'),'x').archived,false);
});
test('negative acknowledgement preserves bounded reason and remains unconfirmed',()=>{
  assert.throws(()=>decode({success:false,reason:'specific reason Bearer secret sk-abc123',message:'detail'}),e=>e.reason.includes('specific reason')&&!e.reason.includes('secret')&&!e.reason.includes('sk-abc123')&&e.message==='detail'&&e.delivery==='UNCONFIRMED_DO_NOT_RETRY');
});
test('malformed acknowledgement is not retryable',()=>{
  assert.throws(()=>decode({success:true,content:[{type:'text',text:'not-json'}]}),e=>e.delivery==='UNCONFIRMED_DO_NOT_RETRY');
});
