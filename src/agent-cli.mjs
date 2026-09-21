import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';
import {readJson} from './contracts.mjs';
import {runLocalTask, readLocalTask, listLocalTasks, continueLocalTask, repairLocalTask} from './local-runner.mjs';

export async function main(args = process.argv.slice(2), {signal} = {}) {
  const {values, positionals} = parseArgs({args, allowPositionals:true, options:{
    repo:{type:'string'}, state:{type:'string'}, request:{type:'string'}, run:{type:'string'},
    ref:{type:'string',default:'HEAD'}, reason:{type:'string'}, executable:{type:'string'},
    help:{type:'boolean'},
  }});
  if (values.help || !positionals.length) return {
    usage:'npm run agent -- <run|status|list|continue|repair|diff> --state <state-directory> [options]',
    run:'run --repo <git-repository> --request <task.json> --state <state-directory>',
    status:'status --state <state-directory> --run <task-id>',
    repair:'repair --state <state-directory> --run <task-id> --reason "specific repair authorization"',
    note:'Real Codex execution uses existing CLI authentication. A successful task produces a reviewable patch; it never merges or pushes.',
  };
  if (positionals.length !== 1 || !values.state) throw Error('One command and --state are required');
  const command=positionals[0], stateRoot=path.resolve(values.state);
  const onEvent = event => {
    if (event.type.startsWith('workbench.') || ['thread.started','turn.started','turn.completed','turn.failed'].includes(event.type)) process.stderr.write(JSON.stringify(event)+'\n');
  };
  if(command==='run') {
    if(!values.repo || !values.request) throw Error('run requires --repo and --request');
    return runLocalTask({repository:path.resolve(values.repo),stateRoot,request:readJson(path.resolve(values.request)),ref:values.ref,executable:values.executable,signal,onEvent});
  }
  if(command==='list') return listLocalTasks({stateRoot});
  if(!values.run) throw Error('--run is required');
  if(command==='status') return readLocalTask({stateRoot,id:values.run});
  if(command==='continue') return continueLocalTask({stateRoot,id:values.run,onEvent,signal});
  if(command==='repair') return repairLocalTask({stateRoot,id:values.run,reason:values.reason,executable:values.executable,signal,onEvent});
  if(command==='diff') {
    const run=readLocalTask({stateRoot,id:values.run});
    if(run.phase!=='READY_FOR_REVIEW') throw Error(`No valid accepted patch: ${run.phase}`);
    return fs.readFileSync(run.patch.path,'utf8');
  }
  throw Error('Unknown command; use --help');
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const controller=new AbortController();
  for(const event of ['SIGINT','SIGTERM']) process.once(event,()=>controller.abort());
  try {
    const result=await main(undefined,{signal:controller.signal});
    console.log(typeof result==='string'?result:JSON.stringify(result,null,2));
    if(['BLOCKED','FAILED_ACCEPTANCE','EVIDENCE_CHANGED'].includes(result?.phase))process.exitCode=1;
  } catch(error) {console.error(error.message);process.exitCode=1;}
}
