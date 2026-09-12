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
export function configFrom(file){
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
  cfg.model??='gpt-5.5';cfg.thinking??='low';
  if(!(['gpt-5.3-codex-spark','gpt-5.5'].includes(cfg.model)&&cfg.thinking==='low')&&!(cfg.model==='gpt-5.6-luna'&&['low','medium'].includes(cfg.thinking)))throw Error('Supported live profiles: gpt-5.3-codex-spark/low, gpt-5.5/low, gpt-5.6-luna/low or medium');
  cfg.workerThreads??={};
  const ids=Object.values(cfg.workerThreads);
  const uuid=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
  if(!uuid.test(cfg.pmThreadId??'')||ids.some(id=>!uuid.test(id)||id===cfg.pmThreadId)||new Set(ids).size!==ids.length)throw Error('Distinct existing PM and engineer task IDs required');
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
      if(!k||typeof k!=='object'||Array.isArray(k)||Object.keys(k).some(key=>!['query','ids','limit','maxChars'].includes(key)))throw Error('Invalid task knowledge policy');
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
