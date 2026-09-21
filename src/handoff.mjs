import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest,readJson,safePath,assertContained,projectIdentity} from './contracts.mjs';
import {openStore} from './workflow.mjs';
import {activePlan,planRevision} from './plan.mjs';
import {comparableCwd} from './desktop.mjs';

const fail=(code,message,details={})=>{throw Object.assign(Error(message),{code,...details});};
const idPattern=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal=new Set(['COMPLETE','FAILED','BLOCKED']);
const unsafeTasks=new Set(['RESERVED','DISPATCHED','NATIVE_BOUND','NATIVE_CLAIMED']);
const actions=new Set(['READ_STATE','RECONCILE','RESUME','REPAIR','CONTINUE_PLAN']);
const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
const same=(a,b)=>canonical(a)===canonical(b);
const text=(value,label)=>{if(typeof value!=='string'||!value.trim()||value.length>2000||value.includes('\0'))fail('HANDOFF_INVALID',`${label} is required and limited to 2000 characters`);};
const hash=(value,label)=>{if(typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value))fail('HANDOFF_INVALID',`${label} must be a SHA-256 hash`);};
function init(store){
  store.db.exec(`CREATE TABLE IF NOT EXISTS handoffs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,source_identity TEXT NOT NULL,intent_hash TEXT NOT NULL,packet_hash TEXT NOT NULL UNIQUE,packet_path TEXT NOT NULL,status TEXT NOT NULL,target_identity TEXT,target_thread_id TEXT,created_at INTEGER NOT NULL,accepted_at INTEGER,receipt TEXT);
    CREATE TABLE IF NOT EXISTS identity_transfers(previous_identity TEXT PRIMARY KEY,current_identity TEXT NOT NULL,handoff_hash TEXT NOT NULL,at INTEGER NOT NULL);`);
}

export function resolveIdentity(store,originalIdentity){
  if(!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='identity_transfers'").get())return originalIdentity;
  const seen=new Set();let identity=originalIdentity;
  while(true){
    if(seen.has(identity))fail('PROJECT_BINDING_CHANGED','Identity transfer chain is cyclic');
    seen.add(identity);
    const row=store.db.prepare('SELECT current_identity FROM identity_transfers WHERE previous_identity=?').get(identity);
    if(!row)return identity;
    hash(row.current_identity,'Transferred identity');identity=row.current_identity;
  }
}

function configuration(cfg){return JSON.parse(canonical(Object.fromEntries(Object.entries(cfg).filter(([key])=>key!=='configFile'))));}
function requireActor(cfg){if(process.env.CODEX_THREAD_ID!==cfg.pmThreadId)fail('ACTOR_MISMATCH','Handoff requires the actual configured PM task');}
function currentOwner(store,cfg){if(resolveIdentity(store,projectIdentity(cfg))!==projectIdentity(cfg))fail('ACTOR_MISMATCH','This PM identity has already been handed off');}
function inside(root,file){const rel=path.relative(root,file);return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));}
function fileHash(file){
  try{if(!fs.lstatSync(file).isFile())fail('INPUT_STALE',`Expected a regular evidence file: ${file}`);return digest(fs.readFileSync(file));}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
}
function git(cfg,args){
  const result=spawnSync('git',['-C',cfg.workRoot,...args],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024});
  if(result.error||result.status!==0)fail('CAPABILITY_UNAVAILABLE','A readable Git checkout and committed HEAD are required for context handoff');
  return result.stdout;
}
function baseline(cfg){
  const root=path.resolve(git(cfg,['rev-parse','--show-toplevel']).trim());
  assertContained(cfg.projectRoot,root);assertContained(root,cfg.workRoot);
  const head=git(cfg,['rev-parse','HEAD']).trim();
  if(!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(head))fail('INPUT_STALE','Git HEAD is not a committed object');
  const untracked=git(cfg,['ls-files','--others','--exclude-standard','-z','--','.']).split('\0').filter(Boolean).sort().map(relative=>{
    const file=safePath(cfg.workRoot,relative);
    return inside(cfg.controlRoot,file)||inside(cfg.vaultRoot,file)?null:{path:relative,hash:fileHash(file)};
  }).filter(Boolean);
  return {root,head,diffHash:digest(git(cfg,['diff','--no-ext-diff','--no-textconv','--binary','HEAD','--','.'])),untracked};
}
function expectedHead(actual,expected){if(typeof expected!=='string'||actual.head!==expected)fail('INPUT_STALE','Expected Git HEAD does not match the current repository baseline');}

function facts(cfg,store,runId){
  const current=activePlan(cfg,store);
  if(!current)fail('HANDOFF_INVALID','A versioned active plan is required for context handoff');
  const groups=store.db.prepare('SELECT * FROM plan_runs WHERE project_id=? ORDER BY run_id').all(cfg.projectId);
  if(!groups.some(group=>group.run_id===runId)||!store.run(runId))fail('HANDOFF_INVALID','The selected run must belong to a versioned plan group');
  const ownership=store.db.prepare('SELECT * FROM ownership ORDER BY file').all();
  const files=new Set(current.plan.tasks.flatMap(task=>task.files)),runs=[];
  for(const run of store.db.prepare('SELECT * FROM runs ORDER BY id').all()){
    if(resolveIdentity(store,run.identity)!==projectIdentity(cfg))fail('PROJECT_BINDING_CHANGED','A preserved run is bound to a different project configuration');
    const request=JSON.parse(run.request),group=groups.find(group=>group.run_id===run.id);
    if(digest(request)!==run.digest)fail('INPUT_STALE','A frozen run request changed');
    if(request.projectId!==undefined&&request.projectId!==cfg.projectId)fail('PROJECT_BINDING_CHANGED','Run project does not match handoff project');
    if(group){
      const record=planRevision(cfg,group.plan_id,group.plan_revision,store);
      if(!record||record.planHash!==request.planBinding?.planHash||!same(JSON.parse(group.request),request)||!same(JSON.parse(group.task_refs),request.planBinding?.taskRefs))fail('INPUT_STALE','A run plan binding changed');
    }
    const tasks=store.tasks(run.id).map(task=>{
      const packet=JSON.parse(task.packet),relative=`runs/${run.id}/packets/${task.task_id}.json`,packetPath=safePath(cfg.controlRoot,relative);
      if(!same(readJson(packetPath),packet)||packet.projectId!==cfg.projectId||packet.attemptId!==task.attempt||packet.runId!==run.id||packet.taskId!==task.task_id)fail('INPUT_STALE','A frozen task packet changed');
      const receiptPath=assertContained(cfg.controlRoot,packet.receiptPath),receiptHash=fileHash(receiptPath);
      if(task.result!==null&&(!receiptHash||!same(readJson(receiptPath),JSON.parse(task.result))))fail('INPUT_STALE','Recorded task result evidence changed');
      return {taskId:task.task_id,taskRevision:request.planBinding?.taskRefs.find(ref=>ref.id===task.task_id)?.revision??null,attemptId:task.attempt,status:task.status,threadId:task.thread_id,baseline:task.baseline,packetPath,packetHash:fileHash(packetPath),contextHash:packet.contextHash,receiptPath,receiptHash,result:task.result===null?null:JSON.parse(task.result)};
    });
    for(const task of request.tasks)for(const file of task.files)files.add(file);
    let acceptance=null;
    if(run.acceptance_hash){
      const file=safePath(cfg.controlRoot,`runs/${run.id}/acceptance.json`);
      if(fileHash(file)!==run.acceptance_hash)fail('INPUT_STALE','Acceptance evidence changed');
      const receipt=readJson(file);
      if(receipt.requestHash!==run.digest)fail('INPUT_STALE','Acceptance no longer binds the original request');
      acceptance={path:file,hash:run.acceptance_hash,passed:receipt.passed};
    }
    const events=store.db.prepare('SELECT id,at,kind,data FROM events WHERE run_id=? ORDER BY id').all(run.id).map(event=>({...event,data:JSON.parse(event.data)}));
    runs.push({runId:run.id,identity:run.identity,status:run.status,paused:run.pause_requested===1,reason:run.reason,requestHash:run.digest,planBinding:request.planBinding??null,userConstraints:request.constraints,acceptance,acceptanceState:run.acceptance===null?null:JSON.parse(run.acceptance),tasks,events});
  }
  const artifacts=[...files].sort().map(relative=>({path:relative,hash:fileHash(safePath(cfg.workRoot,relative))}));
  return {plan:{planId:current.plan.planId,revision:current.plan.revision,hash:current.planHash,snapshot:current.snapshot,objective:current.plan.objective,userConstraints:current.plan.constraints,tasks:current.plan.tasks},groups,runs,ownership,artifacts,git:baseline(cfg)};
}
function reconciliation(snapshot){
  const needs=[];
  for(const group of snapshot.groups)if(!snapshot.runs.some(run=>run.runId===group.run_id))needs.push({runId:group.run_id,status:'PREPARE_PENDING'});
  for(const run of snapshot.runs){
    if(!terminal.has(run.status)&&!run.paused)needs.push({runId:run.runId,status:run.status,reason:'PAUSE_REQUIRED'});
    if(/UNCONFIRMED|UNKNOWN|Ambiguous dispatch/i.test(run.reason??''))needs.push({runId:run.runId,status:run.status,reason:'DISPATCH_UNKNOWN'});
    for(const task of run.tasks)if(unsafeTasks.has(task.status))needs.push({runId:run.runId,taskId:task.taskId,attemptId:task.attemptId,status:task.status,threadId:task.threadId});
    if(run.acceptanceState?.inFlight)needs.push({runId:run.runId,reason:'ACCEPTANCE_IN_FLIGHT'});
  }
  return needs;
}
function readPacket(cfg,row){
  const file=safePath(cfg.controlRoot,row.packet_path);
  if(fileHash(file)!==row.packet_hash)fail('INPUT_STALE','Handoff packet changed or is missing');
  const packet=readJson(file);
  if(packet.schemaVersion!==1||packet.handoffId!==row.id||packet.projectId!==cfg.projectId||packet.source.identity!==row.source_identity||packet.runId!==row.run_id)fail('PROJECT_BINDING_CHANGED','Handoff packet identity mismatch');
  return packet;
}
function preserveConfig(packet,newCfg){
  const file=packet.source.configFile;
  if(!file)return;
  if(fileHash(file)!==packet.source.configFileHash)fail('INPUT_STALE','Preserved source configuration changed');
  if(newCfg&&(typeof newCfg.configFile!=='string'||!path.isAbsolute(newCfg.configFile)||comparableCwd(newCfg.configFile)===comparableCwd(file)||fileHash(newCfg.configFile)===null))fail('PROJECT_BINDING_CHANGED','New PM requires a separate saved configuration; preserve the source file');
}
function budgetUsage(snapshot,budget){
  const attempts=snapshot.runs.flatMap(run=>run.tasks.map(task=>{
    const ids=new Set([task.attemptId]);
    for(const event of run.events)if(event.data.taskId===task.taskId)for(const key of ['attemptId','previousAttemptId'])if(typeof event.data[key]==='string')ids.add(event.data[key]);
    return {runId:run.runId,taskId:task.taskId,recordedAttempts:ids.size,remainingAttempts:Math.max(0,budget.maxAttemptsPerTask-ids.size)};
  }));
  return {reservedOrActiveWorkers:snapshot.runs.reduce((total,run)=>total+run.tasks.filter(task=>unsafeTasks.has(task.status)).length,0),attempts};
}
function immutable(file,bytes){
  fs.mkdirSync(path.dirname(file),{recursive:true});let fd;
  try{fd=fs.openSync(file,'wx');fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function locked(cfg,body){
  const lock=safePath(cfg.controlRoot,'.runner.lock');let fd;
  try{fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,action:'context-handoff'}));return body();}
  finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}}
}

export function createHandoff(cfg,{id,runId,expectedPlanRevision,expectedHead:head,budget,nextStep,allowedActions}={}){
  requireActor(cfg);
  if(!idPattern.test(id??'')||!idPattern.test(runId??''))fail('HANDOFF_INVALID','Stable handoff and run IDs are required');
  text(nextStep,'nextStep');
  if(!budget||!Number.isSafeInteger(budget.maxActiveWorkers)||budget.maxActiveWorkers<1||budget.maxActiveWorkers>cfg.maxWorkers||!Number.isSafeInteger(budget.maxAttemptsPerTask)||budget.maxAttemptsPerTask<1)fail('HANDOFF_INVALID','An explicit budget within the configured worker limit is required');
  if(!Array.isArray(allowedActions)||!allowedActions.length||new Set(allowedActions).size!==allowedActions.length||allowedActions.some(action=>!actions.has(action)))fail('HANDOFF_INVALID','Explicit bounded allowedActions are required');
  const store=openStore(cfg);init(store);
  try{return locked(cfg,()=>store.db.transaction(()=>{
    currentOwner(store,cfg);
    const snapshot=facts(cfg,store,runId);expectedHead(snapshot.git,head);
    if(snapshot.plan.revision!==expectedPlanRevision)fail('INPUT_STALE','Active plan revision changed before handoff');
    const intent={runId,expectedPlanRevision,expectedHead:head,budget,nextStep,allowedActions},intentHash=digest(canonical(intent));
    const previous=store.db.prepare('SELECT * FROM handoffs WHERE id=?').get(id);
    if(previous){
      const packet=readPacket(cfg,previous);
      preserveConfig(packet);
      if(previous.source_identity!==projectIdentity(cfg)||previous.intent_hash!==intentHash)fail('HANDOFF_CONFLICT','Handoff id already binds a different intent');
      if(!same(packet.facts,snapshot))fail('INPUT_STALE','The existing handoff facts are stale');
      return {handoffId:id,packetPath:safePath(cfg.controlRoot,previous.packet_path),packetHash:previous.packet_hash,status:previous.status,reused:true};
    }
    const configFileHash=cfg.configFile?fileHash(cfg.configFile):null;
    if(cfg.configFile&&!configFileHash)fail('INPUT_STALE','Source configuration file is missing');
    const createdAt=Date.now(),packet={schemaVersion:1,handoffId:id,projectId:cfg.projectId,runId,createdAt,source:{threadId:cfg.pmThreadId,identity:projectIdentity(cfg),config:configuration(cfg),configFile:cfg.configFile??null,configFileHash},intent,facts:snapshot,nextStep,allowedActions,budget,budgetUsage:budgetUsage(snapshot,budget),knowledgeRefs:[...new Set(snapshot.plan.tasks.flatMap(task=>task.contextRefs))],reconciliation:reconciliation(snapshot)};
    const bytes=JSON.stringify(packet,null,2)+'\n',packetHash=digest(bytes),relative=`handoffs/${id}-${packetHash}.json`;
    immutable(safePath(cfg.controlRoot,relative),bytes);
    store.db.prepare('INSERT INTO handoffs(id,project_id,run_id,source_identity,intent_hash,packet_hash,packet_path,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,cfg.projectId,runId,projectIdentity(cfg),intentHash,packetHash,relative,'PREPARED',createdAt);
    return {handoffId:id,packetPath:safePath(cfg.controlRoot,relative),packetHash,status:'PREPARED',reconciliation:packet.reconciliation,requires:['SOURCE_IDLE','NEW_CONTEXT_EVIDENCE']};
  }).immediate());}finally{store.close();}
}

function evidence(cfg,packet,proof){
  if(!proof||!['created','registered'].includes(proof.kind)||proof.threadId!==cfg.pmThreadId||proof.sourceThreadId!==packet.source.threadId||typeof proof.cwd!=='string'||comparableCwd(proof.cwd)!==comparableCwd(cfg.projectRoot))fail('HANDOFF_INVALID','A matching created or explicitly registered new session receipt is required');
  hash(proof.receiptHash,'Session receipt hash');
  if(typeof proof.receiptPath!=='string'||!path.isAbsolute(proof.receiptPath))fail('HANDOFF_INVALID','An absolute local session receipt path is required');
  assertContained(cfg.controlRoot,proof.receiptPath);
  if(fileHash(proof.receiptPath)!==proof.receiptHash)fail('INPUT_STALE','Session receipt evidence changed');
  const receipt=readJson(proof.receiptPath);
  if(receipt.schemaVersion!==1||receipt.kind!==proof.kind||receipt.threadId!==cfg.pmThreadId||receipt.sourceThreadId!==packet.source.threadId||receipt.context!=='fresh'||receipt.forkedFrom!==null||typeof receipt.cwd!=='string'||comparableCwd(receipt.cwd)!==comparableCwd(proof.cwd))fail('HANDOFF_INVALID','Session receipt must record an independent context, not a fork or a summary');
  if(!Number.isSafeInteger(receipt.createdAt)||receipt.createdAt<packet.createdAt||receipt.createdAt>Date.now()||typeof receipt.receiptId!=='string'||!receipt.receiptId.trim())fail('HANDOFF_INVALID','Session receipt creation identity and timestamp are required');
  if(proof.kind==='created'&&(receipt.hostReceipt?.threadId!==cfg.pmThreadId||typeof receipt.hostReceipt?.hostId!=='string'||!receipt.hostReceipt.hostId))fail('HANDOFF_INVALID','Created sessions require the original host creation receipt');
  if(proof.kind==='registered'&&(receipt.registeredBy!=='user'||typeof receipt.registrationReason!=='string'||!receipt.registrationReason.trim()))fail('HANDOFF_INVALID','Existing new sessions require explicit human registration evidence');
  return {kind:proof.kind,path:proof.receiptPath,hash:proof.receiptHash,receiptId:receipt.receiptId};
}
async function observe(desktop,id,cfg,{idle=false}={}){
  const view=await desktop.read(id);
  if(view?.id!==id||view.archived!==false||typeof view.cwd!=='string'||comparableCwd(view.cwd)!==comparableCwd(cfg.projectRoot))fail('CAPABILITY_UNAVAILABLE','Desktop did not verify the actual session identity and project directory');
  if(!['active','idle'].includes(view.status)||typeof view.turnId!=='string'||!view.turnId||!['completed','inProgress'].includes(view.turnStatus))fail('CAPABILITY_UNAVAILABLE','Desktop session state is incomplete');
  if(idle&&(view.status!=='idle'||view.turnStatus!=='completed'))fail('HANDOFF_RECONCILE_REQUIRED','Source PM is still active; preserve its run and ownership');
  return {id:view.id,cwd:view.cwd,status:view.status,turnId:view.turnId,turnStatus:view.turnStatus,observedAt:Date.now()};
}

export async function acceptHandoff(newCfg,{handoffId,expectedHash,expectedHead:head,desktop,sessionEvidence}={}){
  requireActor(newCfg);hash(expectedHash,'Expected handoff hash');
  if(!idPattern.test(handoffId??''))fail('HANDOFF_INVALID','A stable handoffId is required');
  if(!desktop||typeof desktop.read!=='function')fail('CAPABILITY_UNAVAILABLE','A real Desktop state adapter is required to accept new context');
  if(!uuidPattern.test(newCfg.pmThreadId??''))fail('HANDOFF_INVALID','The new PM must have a real session UUID');
  const store=openStore(newCfg);init(store);
  const lock=safePath(newCfg.controlRoot,'.runner.lock');let fd;
  try{
    fd=fs.openSync(lock,'wx');fs.writeFileSync(fd,JSON.stringify({pid:process.pid,action:'accept-context-handoff'}));
    const row=store.db.prepare('SELECT * FROM handoffs WHERE id=?').get(handoffId);
    if(!row||row.project_id!==newCfg.projectId||row.packet_hash!==expectedHash)fail('PROJECT_BINDING_CHANGED','Handoff project or expected packet hash does not match');
    const packet=readPacket(newCfg,row),sourceCfg=packet.source.config,targetConfig=configuration(newCfg);
    expectedHead(packet.facts.git,head);
    if(newCfg.pmThreadId===packet.source.threadId)fail('ACTOR_MISMATCH','Receiving a summary in the same PM does not establish new context');
    preserveConfig(packet,newCfg);
    if(!same({...configuration(newCfg),pmThreadId:sourceCfg.pmThreadId},sourceCfg))fail('PROJECT_BINDING_CHANGED','Only PM identity and configFile may change during handoff');
    if(Object.values(newCfg.workerThreads).includes(newCfg.pmThreadId))fail('ACTOR_MISMATCH','A registered worker cannot become a supposedly fresh PM');
    const receipt=evidence(newCfg,packet,sessionEvidence);
    if(row.status==='ACCEPTED'){
      if(row.target_identity!==projectIdentity(newCfg)||resolveIdentity(store,row.source_identity)!==projectIdentity(newCfg))fail('ACTOR_MISMATCH','Handoff was accepted by a different or superseded owner');
      return {handoffId,status:'ACCEPTED',reused:true,sourceThreadId:packet.source.threadId,targetThreadId:newCfg.pmThreadId,packetHash:expectedHash,nextStep:packet.nextStep,allowedActions:packet.allowedActions};
    }
    currentOwner(store,sourceCfg);
    const before=facts(sourceCfg,store,packet.runId);expectedHead(before.git,head);
    if(!same(before,packet.facts))fail('INPUT_STALE','Plan, attempt, events, artifacts or repository changed after handoff');
    const needs=reconciliation(before);
    if(needs.length)fail('HANDOFF_RECONCILE_REQUIRED','Pause and reconcile original execution before transferring its owner',{reconciliation:needs});
    const sourceView=await observe(desktop,packet.source.threadId,newCfg,{idle:true}),targetView=await observe(desktop,newCfg.pmThreadId,newCfg);
    requireActor(newCfg);
    return store.db.transaction(()=>{
      currentOwner(store,sourceCfg);
      readPacket(newCfg,row);
      preserveConfig(packet,newCfg);
      if(!same(configuration(newCfg),targetConfig))fail('PROJECT_BINDING_CHANGED','Target configuration changed during host verification');
      if(!same(facts(sourceCfg,store,packet.runId),packet.facts))fail('INPUT_STALE','Handoff facts changed during host verification');
      evidence(newCfg,packet,sessionEvidence);
      const at=Date.now(),currentIdentity=projectIdentity(newCfg);
      if(resolveIdentity(store,currentIdentity)!==currentIdentity||currentIdentity===row.source_identity)fail('ACTOR_MISMATCH','Target PM identity is not a new owner');
      const acceptance={schemaVersion:1,handoffId,packetHash:expectedHash,sourceThreadId:packet.source.threadId,targetThreadId:newCfg.pmThreadId,sourceView,targetView,sessionEvidence:receipt,acceptedAt:at};
      store.db.prepare('INSERT INTO identity_transfers VALUES(?,?,?,?)').run(row.source_identity,currentIdentity,expectedHash,at);
      const changed=store.db.prepare("UPDATE handoffs SET status='ACCEPTED',target_identity=?,target_thread_id=?,accepted_at=?,receipt=? WHERE id=? AND status='PREPARED'").run(currentIdentity,newCfg.pmThreadId,at,JSON.stringify(acceptance),handoffId);
      if(changed.changes!==1)fail('HANDOFF_CONFLICT','Handoff was already accepted');
      return {handoffId,status:'ACCEPTED',sourceThreadId:packet.source.threadId,targetThreadId:newCfg.pmThreadId,packetHash:expectedHash,nextStep:packet.nextStep,allowedActions:packet.allowedActions,budget:packet.budget,runs:packet.facts.runs.map(run=>({runId:run.runId,status:run.status,paused:run.paused})),acceptance};
    }).immediate();
  }finally{if(fd!==undefined){fs.closeSync(fd);fs.unlinkSync(lock);}store.close();}
}
