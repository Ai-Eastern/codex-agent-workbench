import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {configFrom,readJson,safePath,digest} from './contracts.mjs';
import {prepare,status,pause,advance,delivery,listRuns,knowledge,promptFor,getPacket,submitResult,claimNative,bindNative,retryAcceptance,repairTask,repairKnowledge,reconcileDispatch,repairBlockedTask} from './workflow.mjs';
import {desktopClient,sanitizeErrorDetail} from './desktop.mjs';
import {armPortfolioBarrier,releasePortfolioBarrier} from './portfolio-barrier.mjs';
import {costReport,costDiff} from './cost-report.mjs';
import {traceReport} from './trace-report.mjs';
import {compactOutput} from './output.mjs';

export async function main(args=process.argv.slice(2)){
  if(!args.length||['help','--help','-h'].includes(args[0]))return {
    usage:'node <cli> <command> --project /absolute/project.json [--name value]',
    search:'node <cli> search --project /absolute/project.json --query "task keywords"',
    commands:['prepare','preflight','start','continue','submit','delivery','pause','reconcile-dispatch','repair-blocked-task','retry-acceptance','repair-task','repair-knowledge','status','packet','claim','bind','search','index','capture','portfolio','release-portfolio','cost-report','cost-diff','trace-report'],
    compact:'Add --view compact [--max-output-chars 12000]; full output is saved automatically under controlRoot/views. needsRead requires reading those details before action.',
    note:'Read the installed Skill execution reference for command-specific arguments. portfolio uses --registry instead of --project.'
  };
  const command=args.shift(),opts={};
  while(args.length){const key=args.shift();if(!key.startsWith('--')||!args.length)throw Error('Use --name value arguments');opts[key.slice(2)]=args.shift();}
  if(opts.view!==undefined&&!['full','compact'].includes(opts.view))throw Error('--view must be full or compact');
  if(opts['max-output-chars']!==undefined&&opts.view!=='compact')throw Error('--max-output-chars requires --view compact');
  if(opts.view!=='compact')return execute(command,opts);
  if(!['prepare','preflight','start','continue','submit','delivery','status','packet','claim','search'].includes(command))throw Error('Compact view is not supported for this command');
  const maxChars=Number(opts['max-output-chars']??12000);
  if(!Number.isSafeInteger(maxChars)||maxChars<1024||maxChars>1000000)throw Error('--max-output-chars must be 1024 to 1000000');
  if(!opts.project)throw Error('--project /absolute/project.json is required');
  const cfg=configFrom(path.resolve(opts.project)),detailsPath=safePath(cfg.controlRoot,`views/${randomUUID()}.json`);
  compactOutput(command,{status:'UNKNOWN',reason:'x'.repeat(maxChars+1)},{detailsPath,detailsHash:'0'.repeat(64),maxChars});
  fs.mkdirSync(path.dirname(detailsPath),{recursive:true});
  const fd=fs.openSync(detailsPath,'wx');let saved=false;
  try{
    const result=await execute(command,opts),bytes=JSON.stringify(result,null,2)+'\n';
    fs.writeFileSync(fd,bytes);saved=true;
    return compactOutput(command,result,{detailsPath,detailsHash:digest(bytes),maxChars});
  }catch(error){
    error.detailsPath=detailsPath;error.doNotRetry=true;
    try{
      if(!saved){fs.ftruncateSync(fd,0);fs.writeSync(fd,JSON.stringify({status:'ERROR',...errorSummary(error)},null,2)+'\n',0,'utf8');}
      error.detailsHash=digest(fs.readFileSync(detailsPath));
    }catch(saveError){error.detailsError=saveError.message;}
    throw error;
  }finally{fs.closeSync(fd);}
}
async function execute(command,opts){
  if(command==='cost-report'||command==='cost-diff'){
    const result=command==='cost-report'?await costReport(readJson(opts.manifest)):costDiff(readJson(opts.baseline),readJson(opts.current));
    if(opts.output){if(!path.isAbsolute(opts.output))throw Error('--output must be absolute');fs.writeFileSync(opts.output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {output:opts.output,complete:result.complete};}
    return result;
  }
  if(command==='release-portfolio')return releasePortfolioBarrier(opts.barrier);
  if(command==='portfolio'){
    const projects=readJson(opts.registry).projects;
    return {projects:projects.map(p=>listRuns(configFrom(p.config)))};
  }
  if(!opts.project)throw Error('--project /absolute/project.json is required');
  const cfg=configFrom(path.resolve(opts.project));
  if(command==='trace-report'){
    const result=traceReport(cfg,opts.run,{cost:opts['cost-report']?readJson(opts['cost-report']):undefined});
    if(opts.output){if(!path.isAbsolute(opts.output))throw Error('--output must be absolute');fs.writeFileSync(opts.output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});return {output:opts.output,complete:result.controller.complete};}
    return result;
  }
  if(opts.output&&['delivery','continue'].includes(command)){
    if(!path.isAbsolute(opts.output)||!fs.statSync(path.dirname(opts.output)).isDirectory())throw Error('--output requires an existing absolute parent directory');
    if(fs.existsSync(opts.output))throw Error('--output already exists; preserve it and use status after any completed action');
  }
  if(command==='preflight'){
    const desktop=desktopClient(cfg),entries=Object.entries(cfg.workerThreads);
    const results=await Promise.allSettled(entries.map(async([taskId,id])=>{
      const view=await desktop.read(id);
      if(view.archived!==false||view.status==='active'||view.turnStatus!=='completed'||!view.turnId)throw Error(`Engineer ${taskId} is not available with a completed baseline`);
      return {taskId,...view};
    }));
    return {status:results.every(r=>r.status==='fulfilled')?'READY':'UNAVAILABLE',projectId:cfg.projectId,checkedAt:new Date().toISOString(),workers:results.map((r,i)=>r.status==='fulfilled'?r.value:{taskId:entries[i][0],id:entries[i][1],error:errorSummary(r.reason)}),dispatches:0};
  }
  if(command==='prepare')return prepare(cfg,readJson(opts.request));
  if(command==='submit')return submitResult(cfg,opts.run,opts.task,{expectedAttemptId:opts.attempt,summary:opts.summary,status:opts.status??'done',...(opts.candidate?{knowledgeCandidate:readJson(opts.candidate)}:{})});
  if(command==='status')return opts.run?status(cfg,opts.run):listRuns(cfg);
  if(command==='delivery'){
    const result=delivery(cfg,opts.run);
    if(opts.output)fs.writeFileSync(opts.output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
    return result;
  }
  if(command==='pause')return pause(cfg,opts.run);
  if(command==='reconcile-dispatch')return reconcileDispatch(cfg,opts.run,opts.task,{expectedAttemptId:opts.attempt,expectedBaseline:opts.baseline,confirmedNotDelivered:opts['confirm-not-delivered']==='true',reason:opts.reason,desktop:desktopClient(cfg)});
  if(command==='repair-blocked-task')return repairBlockedTask(cfg,opts.run,opts.task,{expectedAttemptId:opts.attempt,expectedReceiptHash:opts['receipt-hash'],expectedArtifactsHash:opts['artifacts-hash'],reason:opts.reason,desktop:desktopClient(cfg)});
  if(command==='retry-acceptance')return retryAcceptance(cfg,opts.run,{expectedAcceptanceHash:opts['acceptance-hash'],reason:opts.reason});
  if(command==='repair-task')return repairTask(cfg,opts.run,opts.task,{expectedAcceptanceHash:opts['acceptance-hash'],reason:opts.reason});
  if(command==='repair-knowledge')return repairKnowledge(cfg,opts.run,opts.task,{expectedAcceptanceHash:opts['acceptance-hash'],expectedCandidateHash:opts['candidate-hash'],candidate:readJson(opts.candidate),reason:opts.reason});
  if(command==='claim')return claimNative(cfg,opts.run,opts.task);
  if(command==='bind')return bindNative(cfg,opts.run,opts.task,opts.thread);
  if(command==='search'||command==='index'||command==='capture'){
    const index=knowledge(cfg);
    try{return command==='search'?index.search(opts.query??'',{maxChars:Number(opts['max-chars']??6000),limit:Number(opts.limit??5),strategy:opts.strategy??'bm25'}):command==='index'?index.sync():index.capture(readJson(opts.candidate));}finally{index.close();}
  }
  if(command==='start'||command==='continue'){
    const current=status(cfg,opts.run);
    const desktop=current.mode==='langgraph'?desktopClient(cfg):undefined;
    if(opts.barrier){
      if(command!=='start'||current.mode!=='langgraph'||current.status!=='PREPARED')throw Error('Portfolio barrier is only for the initial prepared Desktop dispatch');
      await armPortfolioBarrier(cfg,opts.run,opts.barrier);
    }
    const result=await advance(cfg,opts.run,{desktop,resume:command==='continue'});
    if(command==='continue'&&result.nextAction?.type==='REPORT_ACCEPTANCE'){
      const handoff=delivery(cfg,opts.run),withDelivery={...result,delivery:handoff};
      if(opts.output)fs.writeFileSync(opts.output,JSON.stringify(handoff,null,2)+'\n',{flag:'wx'});
      return withDelivery;
    }
    if(command==='continue'&&result.packets.length){
      const {packets,...summary}=result;
      return {...summary,awaitingResults:packets.map(p=>({taskId:p.taskId,receiptPath:p.receiptPath}))};
    }
    return {...result,packets:result.packets.map(p=>({...p,prompt:promptFor(p)}))};
  }
  if(command==='packet'){
    return getPacket(cfg,opts.run,opts.task);
  }
  throw Error('Unknown command; run help for available commands');
}
function errorSummary(e){return Object.fromEntries(['message','code','reason','delivery','detailsPath','detailsHash','detailsError','doNotRetry'].filter(k=>e?.[k]!==undefined).map(k=>[k,sanitizeErrorDetail(e[k])]));}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await main(),null,2));}catch(e){console.error(JSON.stringify({status:'ERROR',...errorSummary(e)}));process.exitCode=1;}
}
