import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runCheck} from '../src/workflow.mjs';

test('guarded check accepts controller context and rejects missing or wrong cwd before output writes',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-check-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const work=path.join(root,'work'),output=path.join(root,'output');fs.mkdirSync(work);
 const source=`import fs from 'node:fs';import {requireCheckContext} from ${JSON.stringify(new URL('../src/check-context.mjs',import.meta.url).href)};const c=requireCheckContext({expectedWorkRoot:${JSON.stringify(work)},expectedOutputRoot:${JSON.stringify(output)}});fs.mkdirSync(c.outputRoot,{recursive:true});fs.writeFileSync(c.outputRoot+'/result.txt','checked');`;
 const check={id:'check',command:'node',args:['--input-type=module','-e',source]},context={workRoot:work,outputRoot:output,runId:'guard',checkId:'check'};
 assert.equal(runCheck(check,work).exitCode,1);assert.equal(fs.existsSync(output),false);
 const wrong=spawnSync(process.execPath,check.args,{cwd:root,env:{...process.env,CODEX_WORKBENCH_CHECK:JSON.stringify(context)},windowsHide:true,encoding:'utf8'});
 assert.equal(wrong.status,1);assert.match(wrong.stderr,/working directory mismatch/);assert.equal(fs.existsSync(output),false);
 assert.equal(runCheck(check,work,context).exitCode,0);assert.equal(fs.readFileSync(path.join(output,'result.txt'),'utf8'),'checked');
});
