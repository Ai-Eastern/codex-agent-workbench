import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

export const digest=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export const readJson=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
export function writeJson(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
  fs.renameSync(temp,file);
}
export function safePath(root,relative){
  if(typeof relative!=='string'||!relative||path.isAbsolute(relative)||path.win32.isAbsolute(relative)||/[:<>"|?*\x00-\x1f]/.test(relative))throw Error('A safe relative path is required');
  const parts=relative.replaceAll('\\','/').split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw Error('Unsafe path component');
  const target=path.resolve(root,...parts);
  assertContained(root,target);return target;
}
export function assertContained(root,target){
  if(!path.isAbsolute(root)||!path.isAbsolute(target))throw Error('Absolute roots required');
  const relative=path.relative(path.resolve(root),path.resolve(target));
  if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('Path escapes its authorized root');
  let cursor=path.parse(path.resolve(target)).root;
  for(const part of path.resolve(target).slice(cursor.length).split(path.sep)){
    cursor=path.join(cursor,part);
    let stat;try{stat=fs.lstatSync(cursor);}catch(e){if(e.code!=='ENOENT')throw e;}
    if(stat?.isSymbolicLink())throw Error(`Symlink/junction is outside this workflow: ${cursor}`);
  }
  return target;
}
export function ownedPath(cfg,relative){
  const full=safePath(cfg.workRoot,relative);
  for(const reserved of [cfg.vaultRoot,cfg.controlRoot]){
    const rel=path.relative(reserved,full);
    if(!rel||(!rel.startsWith('..'+path.sep)&&rel!=='..'&&!path.isAbsolute(rel)))throw Error('Task files cannot modify knowledge or control state');
  }
  return full;
}
export function knowledgeIndexPath(cfg){
  const name=cfg.knowledgeIndexFile??'knowledge.sqlite';
  if(typeof name!=='string'||!/^knowledge(?:-[a-z0-9-]+)?\.sqlite$/.test(name))throw Error('Invalid knowledgeIndexFile');
  return safePath(cfg.controlRoot,name);
}
export function configFrom(file,{requireExplicitModel=false}={}){
  const cfg=readJson(file);
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(cfg.projectId??''))throw Error('Invalid projectId');
  for(const key of ['projectRoot','controlRoot','workRoot']){
    if(!path.isAbsolute(cfg[key]??''))throw Error(`Absolute ${key} required`);
    cfg[key]=path.resolve(cfg[key]);assertContained(cfg.projectRoot,cfg[key]);
  }
  if(!path.isAbsolute(cfg.vaultRoot??''))throw Error('Absolute vaultRoot required');
  cfg.vaultRoot=path.resolve(cfg.vaultRoot);
  // An explicit exact-directory grant permits a project subfolder in an existing Obsidian vault.
  if(cfg.externalVaultRoot!==undefined){
    if(!path.isAbsolute(cfg.externalVaultRoot)||path.resolve(cfg.externalVaultRoot)!==cfg.vaultRoot)throw Error('externalVaultRoot must exactly match vaultRoot');
    cfg.externalVaultRoot=path.resolve(cfg.externalVaultRoot);
    assertContained(cfg.externalVaultRoot,cfg.vaultRoot);
  }else assertContained(cfg.projectRoot,cfg.vaultRoot);
  cfg.knowledgeIndexFile??='knowledge.sqlite';
  knowledgeIndexPath(cfg);
  if(cfg.workRoot===cfg.controlRoot||cfg.workRoot===cfg.vaultRoot||cfg.vaultRoot===cfg.controlRoot)throw Error('Use separate work, control and knowledge directories');
  if(!Number.isInteger(cfg.maxWorkers)||cfg.maxWorkers<1||cfg.maxWorkers>12)throw Error('maxWorkers must be 1..12');
  if(requireExplicitModel&&(!Object.hasOwn(cfg,'model')||!Object.hasOwn(cfg,'thinking')))throw Error('Explicit model and thinking required for new plans');
  if(!Object.hasOwn(cfg,'model'))cfg.model='gpt-5.5';
  if(!Object.hasOwn(cfg,'thinking'))cfg.thinking='low';
  // Configuration preserves user intent; current host support is checked by the adapter.
  if(typeof cfg.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(cfg.model)||typeof cfg.thinking!=='string'||!/^[a-z][a-z0-9_-]{0,31}$/.test(cfg.thinking))throw Error('Invalid model or thinking profile syntax');
  cfg.workerThreads??={};
  const ids=Object.values(cfg.workerThreads);
  const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
  if(!uuid.test(cfg.pmThreadId??'')||ids.some(id=>!uuid.test(id)||id===cfg.pmThreadId)||new Set(ids).size!==ids.length)throw Error('Distinct existing PM and engineer task IDs required');
  Object.defineProperty(cfg,'configFile',{value:path.resolve(file)});
  return cfg;
}
export function validateRequest(value,cfg){
  const req=structuredClone(value);
  if(req.projectId!==undefined&&req.projectId!==cfg.projectId)throw Error('Request projectId does not match selected project config');
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(req.id??'')||typeof req.objective!=='string'||!req.objective.trim())throw Error('Stable request id and objective required');
  if(!['direct','native','langgraph'].includes(req.mode)||typeof req.reason!=='string'||!req.reason.trim())throw Error('Explicit execution mode and reason required');
  if(!Array.isArray(req.tasks)||!req.tasks.length||req.tasks.length>cfg.maxWorkers)throw Error('Invalid task count');
  const ids=new Set(),files=[];
  for(const task of req.tasks){
    if(!/^[A-Za-z0-9_-]{1,40}$/.test(task.id??'')||ids.has(task.id)||!task.objective?.trim())throw Error('Unique task IDs and objectives required');
    ids.add(task.id);task.dependsOn??=[];
    if(task.constraints!==undefined&&(!Array.isArray(task.constraints)||task.constraints.some(x=>typeof x!=='string')))throw Error('Task constraints must describe local module responsibilities and interfaces');
    if(task.knowledge!==undefined){
      const k=task.knowledge;
      if(!k||typeof k!=='object'||Array.isArray(k)||Object.keys(k).some(key=>!['query','ids','limit','maxChars','strategy'].includes(key)))throw Error('Invalid task knowledge policy');
      if(k.strategy!==undefined&&!['bm25','smart'].includes(k.strategy))throw Error('Invalid task knowledge strategy');
      if(k.query!==undefined&&(typeof k.query!=='string'||k.query.length>2048))throw Error('Invalid task knowledge query');
      if(k.ids!==undefined&&(!Array.isArray(k.ids)||k.ids.length>50||k.ids.some(id=>typeof id!=='string'||!id.trim()||id.length>200||/[\x00-\x1f\x7f]/u.test(id))))throw Error('Invalid task knowledge IDs');
      if(k.limit!==undefined&&(!Number.isInteger(k.limit)||k.limit<1||k.limit>50))throw Error('Invalid task knowledge limit');
      if(k.maxChars!==undefined&&(!Number.isInteger(k.maxChars)||k.maxChars<0||k.maxChars>100000))throw Error('Invalid task knowledge maxChars');
    }
    if(!Array.isArray(task.dependsOn)||new Set(task.dependsOn).size!==task.dependsOn.length)throw Error('Invalid dependencies');
    if(!Array.isArray(task.files)||!task.files.length)throw Error('Exact file ownership required');
    for(const name of task.files){
      const full=ownedPath(cfg,name),key=full.toLowerCase();
      if(files.some(x=>x===key||x.startsWith(key+path.sep)||key.startsWith(x+path.sep)))throw Error('Overlapping file ownership');
      files.push(key);
    }
    if(req.mode==='langgraph'&&!cfg.workerThreads[task.id])throw Error(`Missing existing Desktop engineer task: ${task.id}`);
  }
  const done=new Set();
  while(done.size<ids.size){
    const wave=req.tasks.filter(t=>!done.has(t.id)&&t.dependsOn.every(id=>done.has(id)));
    if(!wave.length)throw Error('Unknown or cyclic task dependency');
    wave.forEach(t=>done.add(t.id));
  }
  if(req.mode==='direct'&&req.tasks.length!==1)throw Error('Direct mode has one task');
  if(req.mode!=='langgraph'&&req.tasks.some(t=>t.dependsOn.length))throw Error('Dependencies require LangGraph');
  if(!Array.isArray(req.checks)||!req.checks.length)throw Error('Independent acceptance commands required');
  const checkIds=new Set();
  for(const c of req.checks){
    if(!c.id||checkIds.has(c.id)||typeof c.command!=='string'||!c.command||!Array.isArray(c.args)||c.args.some(a=>typeof a!=='string'||a.includes('\0')))throw Error('Invalid argv acceptance command');
    safePath(cfg.controlRoot,`check-output/${c.id}`);
    checkIds.add(c.id);
    if(c.timeoutMs!==undefined&&(!Number.isInteger(c.timeoutMs)||c.timeoutMs<1||c.timeoutMs>300000))throw Error('Invalid command timeout');
  }
  req.constraints??=[];
  if(!Array.isArray(req.constraints)||req.constraints.some(x=>typeof x!=='string'))throw Error('Invalid constraints');
  return req;
}
export function projectIdentity(cfg){return digest({projectId:cfg.projectId,projectRoot:cfg.projectRoot,controlRoot:cfg.controlRoot,workRoot:cfg.workRoot,vaultRoot:cfg.vaultRoot,pmThreadId:cfg.pmThreadId,workerThreads:cfg.workerThreads,model:cfg.model,thinking:cfg.thinking,maxWorkers:cfg.maxWorkers,captureEnabled:cfg.captureEnabled===true});}

const stableId=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
function object(value,label){
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error(`${label} must be an object`);
  return value;
}
function identifier(value,label){if(typeof value!=='string'||!stableId.test(value))throw Error(`Invalid ${label}`);}
function projectId(value){if(typeof value!=='string'||!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))throw Error('Invalid projectId');}
function positive(value,label){if(!Number.isSafeInteger(value)||value<1)throw Error(`${label} must be a positive integer`);}
function nonempty(value,label){if(typeof value!=='string'||!value.trim()||value.length>10000||/[\x00-\x1f\x7f]/.test(value))throw Error(`Invalid ${label}`);}
function strings(value,label,{nonEmpty=false,unique=false}={}){
  if(!Array.isArray(value)||(nonEmpty&&!value.length)||Array.from(value).some(x=>typeof x!=='string'||!x.trim()||/[\x00-\x1f\x7f]/.test(x))||(unique&&new Set(value).size!==value.length))throw Error(`Invalid ${label}`);
}
function sha256(value,label){
  if(typeof value!=='string'||!/^(?:sha256:)?[a-fA-F0-9]{64}$/.test(value))throw Error(`Invalid ${label}: SHA-256 required`);
  return value.replace(/^sha256:/,'').toLowerCase();
}
function hashes(value,label){
  if(!Array.isArray(value))throw Error(`Invalid ${label}`);
  return Array.from(value,hash=>sha256(hash,label));
}
function ancestors(entries,label){
  const byId=new Map(entries.map(entry=>[entry.id,entry])),done=new Map();
  for(const entry of entries){
    strings(entry.dependsOn,`${label} dependencies`,{unique:true});
    for(const id of entry.dependsOn)if(!byId.has(id))throw Error(`Unknown ${label} dependency: ${id}`);
  }
  while(done.size<byId.size){
    const ready=entries.filter(entry=>!done.has(entry.id)&&entry.dependsOn.every(id=>done.has(id)));
    if(!ready.length)throw Error(`Cyclic ${label} dependency`);
    for(const entry of ready){
      const deps=new Set(entry.dependsOn);
      for(const id of entry.dependsOn)for(const previous of done.get(id))deps.add(previous);
      done.set(entry.id,deps);
    }
  }
  return done;
}
function uniqueEntries(entries,label){
  if(!Array.isArray(entries)||!entries.length)throw Error(`${label} must be a nonempty array`);
  const ids=new Set();
  for(const entry of entries){
    object(entry,label);identifier(entry.id,`${label} id`);
    if(ids.has(entry.id))throw Error(`Duplicate ${label} id: ${entry.id}`);
    ids.add(entry.id);if(entry.dependsOn===undefined)entry.dependsOn=[];
  }
  return ids;
}

export function validatePlan(value,cfgOrProjectId){
  const plan=structuredClone(object(value,'Plan'));
  if(plan.schemaVersion!==1)throw Error('Unsupported plan schemaVersion');
  projectId(plan.projectId);identifier(plan.planId,'planId');positive(plan.revision,'Plan revision');nonempty(plan.objective,'Plan objective');
  const cfg=typeof cfgOrProjectId==='object'&&cfgOrProjectId!==null?cfgOrProjectId:undefined;
  const expected=cfg?.projectId??cfgOrProjectId;
  if(expected!==undefined&&plan.projectId!==expected)throw Error('Plan projectId does not match selected project');
  if(plan.constraints===undefined)plan.constraints=[];strings(plan.constraints,'Plan constraints');
  const phases=uniqueEntries(plan.phases,'phase');
  for(const phase of plan.phases){
    if(!Number.isInteger(phase.maxNativeWorkers)||phase.maxNativeWorkers<0||phase.maxNativeWorkers>3)throw Error('maxNativeWorkers must be 0..3');
    if(phase.decision!==undefined){
      const decision=object(phase.decision,'Phase decision');
      if(!['serial','parallel'].includes(decision.topology)||!['direct','native','desktop'].includes(decision.carrier)||!['continue','select','handoff'].includes(decision.context))throw Error('Invalid phase scheduling decision');
      nonempty(decision.reason,'Phase decision reason');
    }
  }
  const phaseAncestors=ancestors(plan.phases,'phase');
  uniqueEntries(plan.tasks,'task');
  const files=new Map(),artifactIds=new Set();
  for(const task of plan.tasks){
    positive(task.revision,'Task revision');
    if(!phases.has(task.phaseId))throw Error('Unknown task phaseId');
    if(!['direct','native','desktop'].includes(task.executor))throw Error('Unknown task executor');
    if(task.executor==='native'&&plan.phases.find(phase=>phase.id===task.phaseId).maxNativeWorkers===0)throw Error('Native task requires phase capacity');
    if(task.objective!==undefined)nonempty(task.objective,'Task objective');
    if(task.constraints===undefined)task.constraints=[];strings(task.constraints,'Task constraints');
    strings(task.contextRefs,'Task contextRefs',{unique:true});strings(task.acceptanceRefs,'Task acceptanceRefs',{nonEmpty:true,unique:true});
    strings(task.files,'Task files',{nonEmpty:true,unique:true});
    strings(task.dependsOn,'task dependencies',{unique:true});
    const owned=task.files.map(file=>{
      const full=cfg?.workRoot?ownedPath(cfg,file):safePath(path.parse(path.resolve('.')).root,file);
      return full.toLowerCase();
    });
    const overlaps=(a,b)=>a===b||a.startsWith(b+path.sep)||b.startsWith(a+path.sep);
    if(owned.some((file,i)=>owned.slice(i+1).some(other=>overlaps(file,other))))throw Error('Overlapping files within task');
    files.set(task.id,owned);
    if(task.artifacts!==undefined){
      if(!Array.isArray(task.artifacts))throw Error('Task artifacts must be an array');
      for(const artifact of task.artifacts){
        object(artifact,'Task artifact');identifier(artifact.id,'artifact id');positive(artifact.version,'Artifact version');
        if(artifactIds.has(artifact.id))throw Error(`Duplicate plan artifact id: ${artifact.id}`);
        if(typeof artifact.path!=='string'||!task.files.includes(artifact.path))throw Error('Artifact path must be an existing task.files entry');
        artifactIds.add(artifact.id);
      }
    }
  }
  // Phase barriers count as ordering edges, including barriers through empty phases.
  const combined=plan.tasks.map(task=>({id:task.id,dependsOn:[...new Set([...task.dependsOn,...plan.tasks.filter(previous=>phaseAncestors.get(task.phaseId).has(previous.phaseId)).map(previous=>previous.id)])]}));
  const taskAncestors=ancestors(combined,'task');
  for(let i=0;i<plan.tasks.length;i++)for(let j=i+1;j<plan.tasks.length;j++){
    const a=plan.tasks[i],b=plan.tasks[j];
    if(taskAncestors.get(a.id).has(b.id)||taskAncestors.get(b.id).has(a.id))continue;
    if(files.get(a.id).some(x=>files.get(b.id).some(y=>x===y||x.startsWith(y+path.sep)||y.startsWith(x+path.sep))))throw Error(`Overlapping parallel file ownership: ${a.id}, ${b.id}`);
  }
  return plan;
}

export function validatePortfolio(value){
  const portfolio=structuredClone(object(value,'Portfolio'));
  if(portfolio.schemaVersion!==1)throw Error('Unsupported portfolio schemaVersion');
  identifier(portfolio.portfolioId,'portfolioId');positive(portfolio.revision,'Portfolio revision');positive(portfolio.coordinatorEpoch,'coordinatorEpoch');
  object(portfolio.budget,'Portfolio budget');
  positive(portfolio.budget.maxActiveWorkers,'maxActiveWorkers');positive(portfolio.budget.maxAttemptsPerTask,'maxAttemptsPerTask');
  if(!Array.isArray(portfolio.projects)||!portfolio.projects.length)throw Error('Portfolio projects required');
  const projects=new Map();
  for(const ref of portfolio.projects){
    object(ref,'Project reference');projectId(ref.projectId);identifier(ref.planId,'planId');positive(ref.acceptedPlanRevision,'acceptedPlanRevision');
    if(!Number.isSafeInteger(ref.priority)||ref.priority<0)throw Error('Project priority must be a nonnegative integer');
    if(projects.has(ref.projectId))throw Error('Duplicate portfolio projectId');
    if(ref.lastEventSequence!==undefined&&(!Number.isSafeInteger(ref.lastEventSequence)||ref.lastEventSequence<0))throw Error('Invalid lastEventSequence');
    projects.set(ref.projectId,ref);
  }
  if(portfolio.dependencies===undefined)portfolio.dependencies=[];
  if(!Array.isArray(portfolio.dependencies))throw Error('Invalid portfolio dependencies');
  const edges=new Set(),nodes=new Map();
  for(const dependency of portfolio.dependencies){
    object(dependency,'Cross-project dependency');
    for(const side of ['from','to']){
      const ref=object(dependency[side],`Dependency ${side}`),project=projects.get(ref.projectId);
      if(!project||ref.planId!==project.planId)throw Error('Unknown dependency project or plan');
      positive(ref.planRevision,'Dependency planRevision');identifier(ref.taskId,'Dependency taskId');positive(ref.taskRevision,'Dependency taskRevision');
      if(side==='to'?ref.planRevision!==project.acceptedPlanRevision:ref.planRevision>project.acceptedPlanRevision)throw Error('Dependency plan revision does not match portfolio reference');
    }
    const {from,to}=dependency;
    if(from.projectId===to.projectId)throw Error('Portfolio dependencies must cross projects');
    identifier(from.artifactId,'Dependency artifactId');positive(from.artifactVersion,'Dependency artifactVersion');from.artifactHash=sha256(from.artifactHash,'Dependency artifactHash');
    const node=ref=>`${ref.projectId}/${ref.planId}/${ref.planRevision}/${ref.taskId}/${ref.taskRevision}`;
    const source=node(from),target=node(to);
    const key=JSON.stringify([source,target,from.taskRevision,to.taskRevision,from.artifactId,from.artifactVersion]);
    if(edges.has(key))throw Error('Duplicate cross-project dependency');edges.add(key);
    if(!nodes.has(source))nodes.set(source,{id:source,dependsOn:[]});
    if(!nodes.has(target))nodes.set(target,{id:target,dependsOn:[]});
    if(!nodes.get(target).dependsOn.includes(source))nodes.get(target).dependsOn.push(source);
  }
  ancestors([...nodes.values()],'cross-project');
  return portfolio;
}

export function validateAction(value){
  const action=structuredClone(object(value,'Action'));
  identifier(action.id,'action id');identifier(action.portfolioId,'portfolioId');projectId(action.projectId);
  if(!['DISPATCH','WAIT','RECONCILE','CANCEL','ACCEPT'].includes(action.type))throw Error('Unknown action type');
  for(const field of ['coordinatorEpoch','planRevision','taskRevision'])positive(action[field],field);
  for(const field of ['taskId','attemptId','actorBindingRef'])identifier(action[field],field);
  for(const field of ['planId','runId'])if(action[field]!==undefined)identifier(action[field],field);
  action.packetHash=sha256(action.packetHash,'packetHash');
  for(const field of ['contextHash','acceptanceHash'])if(action[field]!==undefined)action[field]=sha256(action[field],field);
  if(action.inputArtifactHashes!==undefined)action.inputArtifactHashes=hashes(action.inputArtifactHashes,'inputArtifactHashes');
  return action;
}

export function validateActionReceipt(value,expectedAction){
  const action=validateAction(expectedAction),receipt=structuredClone(object(value,'Action receipt'));
  for(const [field,expected] of [['actionId',action.id],['projectId',action.projectId],['attemptId',action.attemptId]])if(receipt[field]!==expected)throw Error(`Receipt ${field} identity mismatch`);
  if(!['ACCEPTED','REJECTED','COMPLETED','FAILED','CANCELLED','UNKNOWN','VERIFIED'].includes(receipt.status))throw Error('Unknown action receipt status');
  nonempty(receipt.hostReceiptRef,'hostReceiptRef');
  for(const field of ['portfolioId','planId','coordinatorEpoch','planRevision','taskId','taskRevision','runId','actorBindingRef'])if(receipt[field]!==undefined&&receipt[field]!==action[field])throw Error(`Receipt ${field} identity mismatch`);
  for(const field of ['packetHash','contextHash','acceptanceHash'])if(receipt[field]!==undefined){
    receipt[field]=sha256(receipt[field],field);
    if(action[field]!==undefined&&receipt[field]!==action[field])throw Error(`Receipt ${field} mismatch`);
  }
  for(const field of ['inputArtifactHashes','artifactHashes'])if(receipt[field]!==undefined)receipt[field]=hashes(receipt[field],field);
  if(action.inputArtifactHashes!==undefined&&receipt.inputArtifactHashes!==undefined&&JSON.stringify(receipt.inputArtifactHashes)!==JSON.stringify(action.inputArtifactHashes))throw Error('Receipt inputArtifactHashes mismatch');
  if(receipt.status==='COMPLETED'||receipt.status==='VERIFIED'){
    if(receipt.packetHash===undefined||receipt.inputArtifactHashes===undefined||!receipt.artifactHashes?.length)throw Error('Completion receipt requires packet, input and artifact hashes');
  }
  if(receipt.status==='VERIFIED'&&(action.type!=='ACCEPT'||receipt.acceptanceHash===undefined||action.acceptanceHash===undefined))throw Error('Verification receipt requires a separate acceptance action and frozen acceptanceHash');
  if(receipt.status==='ACCEPTED'&&action.type!=='DISPATCH')throw Error('ACCEPTED only records dispatch acceptance');
  return receipt;
}
