import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {configFrom,readJson,safePath} from './contracts.mjs';
import {prepare,status,pause,advance,listRuns,knowledge,promptFor,getPacket,claimNative,bindNative,retryAcceptance,repairTask,repairKnowledge} from './workflow.mjs';
import {desktopClient} from './desktop.mjs';

export async function main(args=process.argv.slice(2)){
  if(!args.length||['help','--help','-h'].includes(args[0]))return {
    usage:'node <cli> <command> --project /absolute/project.json [--name value]',
    search:'node <cli> search --project /absolute/project.json --query "task keywords"',
    commands:['prepare','start','continue','pause','retry-acceptance','repair-task','repair-knowledge','status','packet','claim','bind','search','index','capture','portfolio'],
    note:'Read the installed Skill execution reference for command-specific arguments. portfolio uses --registry instead of --project.'
  };
  const command=args.shift(),opts={};
  while(args.length){const key=args.shift();if(!key.startsWith('--')||!args.length)throw Error('Use --name value arguments');opts[key.slice(2)]=args.shift();}
  if(command==='portfolio'){
    const projects=readJson(opts.registry).projects;
    return {projects:projects.map(p=>listRuns(configFrom(p.config)))};
  }
  if(!opts.project)throw Error('--project /absolute/project.json is required');
  const cfg=configFrom(path.resolve(opts.project));
  if(command==='prepare')return prepare(cfg,readJson(opts.request));
  if(command==='status')return opts.run?status(cfg,opts.run):listRuns(cfg);
  if(command==='pause')return pause(cfg,opts.run);
  if(command==='retry-acceptance')return retryAcceptance(cfg,opts.run,{expectedAcceptanceHash:opts['acceptance-hash'],reason:opts.reason});
  if(command==='repair-task')return repairTask(cfg,opts.run,opts.task,{expectedAcceptanceHash:opts['acceptance-hash'],reason:opts.reason});
  if(command==='repair-knowledge')return repairKnowledge(cfg,opts.run,opts.task,{expectedAcceptanceHash:opts['acceptance-hash'],expectedCandidateHash:opts['candidate-hash'],candidate:readJson(opts.candidate),reason:opts.reason});
  if(command==='claim')return claimNative(cfg,opts.run,opts.task);
  if(command==='bind')return bindNative(cfg,opts.run,opts.task,opts.thread);
  if(command==='search'||command==='index'||command==='capture'){
    const index=knowledge(cfg);
    try{return command==='search'?index.search(opts.query??'',{maxChars:Number(opts['max-chars']??6000)}):command==='index'?index.sync():index.capture(readJson(opts.candidate));}finally{index.close();}
  }
  if(command==='start'||command==='continue'){
    const current=status(cfg,opts.run);
    const desktop=current.mode==='langgraph'?desktopClient(cfg):undefined;
    const result=await advance(cfg,opts.run,{desktop,resume:command==='continue'});
    if(command==='continue'&&result.packets.length){
      const {packets,...summary}=result;
      return {...summary,awaitingResults:packets.map(p=>({taskId:p.taskId,receiptPath:p.receiptPath}))};
    }
    return {...result,packets:result.packets.map(p=>({...p,prompt:promptFor(p)}))};
  }
  if(command==='packet'){
    return getPacket(cfg,opts.run,opts.task);
  }
  throw Error('Commands: prepare, start, continue, pause, retry-acceptance, repair-task, repair-knowledge, status, packet, claim, bind, search, index, capture, portfolio');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await main(),null,2));}catch(e){console.error(JSON.stringify({status:'ERROR',message:e.message}));process.exitCode=1;}
}
