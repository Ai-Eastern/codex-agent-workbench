import fs from 'node:fs';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {assertContained,digest,projectIdentity} from './contracts.mjs';

const PROJECT=/^[a-z0-9][a-z0-9-]{0,63}$/;
const RUN=/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const THREAD=/^[0-9a-f]{8}-[0-9a-f-]{27}$/i;
const HASH=/^[0-9a-f]{64}$/;
const known=new Set(['PORTFOLIO_BARRIER_INVALID','PORTFOLIO_BARRIER_IDENTITY','PORTFOLIO_BARRIER_CONFLICT','PORTFOLIO_BARRIER_CHANGED','PORTFOLIO_BARRIER_INCOMPLETE','PORTFOLIO_BARRIER_TIMEOUT']);

function failure(code,message,cause){
  const error=new Error(message,{cause});error.code=code;error.delivery='NOT_SENT';return error;
}
function location(manifestPath){
  try{
    if(typeof manifestPath!=='string'||!path.isAbsolute(manifestPath))throw Error('Absolute manifestPath required');
    const file=path.resolve(manifestPath),directory=path.dirname(file);
    assertContained(directory,file);
    if(path.basename(file).toLowerCase()==='release.json')throw Error('Manifest cannot be release.json');
    return {file,directory};
  }catch(error){throw failure('PORTFOLIO_BARRIER_INVALID','Invalid portfolio barrier path',error);}
}
function readManifest(file){
  try{
    assertContained(path.dirname(file),file);
    const bytes=fs.readFileSync(file),value=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
    if(!RUN.test(value?.id??'')||!Array.isArray(value.projects)||!value.projects.length||value.projects.length>12)throw Error('Invalid manifest');
    const identities=new Set(),threads=new Set();
    for(const item of value.projects){
      if(!PROJECT.test(item?.projectId??'')||!RUN.test(item?.runId??'')||!THREAD.test(item?.pmThreadId??'')||!HASH.test(item?.configHash??''))throw Error('Invalid project identity');
      const key=`${item.projectId}\0${item.runId}`;
      if(identities.has(key)||threads.has(item.pmThreadId))throw Error('Duplicate project or PM identity');identities.add(key);threads.add(item.pmThreadId);
    }
    return {bytes,value,hash:digest(bytes)};
  }catch(error){
    if(known.has(error.code))throw error;
    throw failure('PORTFOLIO_BARRIER_INVALID','Unreadable portfolio barrier manifest',error);
  }
}
function readyPath(directory,item){
  const file=path.join(directory,`${item.projectId}.${item.runId}.ready.json`);assertContained(directory,file);return file;
}
function writeExclusive(file,value,code='PORTFOLIO_BARRIER_CONFLICT'){
  const bytes=Buffer.from(`${JSON.stringify(value)}\n`);let fd;
  try{fd=fs.openSync(file,'wx');fs.writeFileSync(fd,bytes);return bytes;}
  catch(error){throw failure(code,`Barrier file already exists or cannot be created: ${path.basename(file)}`,error);}
  finally{if(fd!==undefined)fs.closeSync(fd);}
}
function removeOwn(directory,file,bytes){
  try{assertContained(directory,file);if(fs.readFileSync(file).equals(bytes))fs.unlinkSync(file);}catch{}
}
function parseFile(file,code){
  try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}
  catch(error){throw failure(code,`Invalid barrier file: ${path.basename(file)}`,error);}
}
function alive(pid){
  if(!Number.isInteger(pid)||pid<1)return false;
  try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}
}
function sameManifest(file,hash){try{return readManifest(file).hash===hash;}catch(error){if(error.code==='PORTFOLIO_BARRIER_INVALID')return false;throw error;}}

async function arm(cfg,runId,manifestPath,{timeoutMs=60000,pollMs=200}={}){
  const {file,directory}=location(manifestPath);
  if(!PROJECT.test(cfg?.projectId??'')||!RUN.test(runId??'')||!THREAD.test(cfg?.pmThreadId??''))throw failure('PORTFOLIO_BARRIER_IDENTITY','Invalid PM barrier identity');
  if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000||!Number.isInteger(pollMs)||pollMs<1||pollMs>60000)throw failure('PORTFOLIO_BARRIER_INVALID','Invalid barrier timing');
  const manifest=readManifest(file),configHash=projectIdentity(cfg);
  const item=manifest.value.projects.find(x=>x.projectId===cfg.projectId&&x.runId===runId);
  if(!item||item.pmThreadId!==cfg.pmThreadId||item.configHash!==configHash)throw failure('PORTFOLIO_BARRIER_IDENTITY','PM identity does not match frozen manifest');
  const release=path.join(directory,'release.json');assertContained(directory,release);
  if(fs.existsSync(release))throw failure('PORTFOLIO_BARRIER_CONFLICT','Portfolio barrier is already released');
  const ready=readyPath(directory,item),createdAt=Date.now(),record={manifestId:manifest.value.id,manifestHash:manifest.hash,projectId:item.projectId,runId:item.runId,pmThreadId:item.pmThreadId,pid:process.pid,createdAt,expiresAt:createdAt+timeoutMs};
  let own;
  try{
    own=writeExclusive(ready,record);
    const deadline=record.expiresAt;
    while(true){
      if(!sameManifest(file,manifest.hash))throw failure('PORTFOLIO_BARRIER_CHANGED','Portfolio barrier manifest changed');
      if(Date.now()>deadline)throw failure('PORTFOLIO_BARRIER_TIMEOUT','Portfolio barrier timed out');
      if(fs.existsSync(release)){
        const value=parseFile(release,'PORTFOLIO_BARRIER_INVALID');
        if(value.manifestId!==manifest.value.id||value.manifestHash!==manifest.hash||value.projects!==manifest.value.projects.length)throw failure('PORTFOLIO_BARRIER_CHANGED','Release does not match frozen manifest');
        if(!sameManifest(file,manifest.hash))throw failure('PORTFOLIO_BARRIER_CHANGED','Portfolio barrier manifest changed');
        return {status:'RELEASED',manifestHash:manifest.hash};
      }
      const remaining=deadline-Date.now();
      await delay(Math.max(1,Math.min(pollMs,remaining)));
    }
  }catch(error){
    if(own)removeOwn(directory,ready,own);
    if(known.has(error.code))throw error;
    throw failure('PORTFOLIO_BARRIER_INVALID','Portfolio barrier failed before dispatch',error);
  }
}

function release(manifestPath){
  const {file,directory}=location(manifestPath),manifest=readManifest(file),release=path.join(directory,'release.json');assertContained(directory,release);
  if(fs.existsSync(release))throw failure('PORTFOLIO_BARRIER_CONFLICT','Portfolio barrier is already released');
  let expiresAt=Infinity;
  for(const item of manifest.value.projects){
    const ready=parseFile(readyPath(directory,item),'PORTFOLIO_BARRIER_INCOMPLETE');
    if(ready.manifestId!==manifest.value.id||ready.manifestHash!==manifest.hash||ready.projectId!==item.projectId||ready.runId!==item.runId||ready.pmThreadId!==item.pmThreadId||!Number.isInteger(ready.createdAt)||!Number.isInteger(ready.expiresAt)||ready.createdAt<1||ready.expiresAt<ready.createdAt||Date.now()>ready.expiresAt||!alive(ready.pid))throw failure('PORTFOLIO_BARRIER_INCOMPLETE',`Project is not ready: ${item.projectId}`);
    expiresAt=Math.min(expiresAt,ready.expiresAt);
  }
  if(Date.now()>expiresAt)throw failure('PORTFOLIO_BARRIER_INCOMPLETE','A project ready record expired');
  if(!sameManifest(file,manifest.hash))throw failure('PORTFOLIO_BARRIER_CHANGED','Portfolio barrier manifest changed');
  const value={manifestId:manifest.value.id,manifestHash:manifest.hash,projects:manifest.value.projects.length},own=writeExclusive(release,value);
  if(!sameManifest(file,manifest.hash)){removeOwn(directory,release,own);throw failure('PORTFOLIO_BARRIER_CHANGED','Portfolio barrier manifest changed');}
  if(Date.now()>expiresAt){removeOwn(directory,release,own);throw failure('PORTFOLIO_BARRIER_INCOMPLETE','A project ready record expired');}
  return value;
}

export async function armPortfolioBarrier(...args){
  try{return await arm(...args);}catch(error){
    if(known.has(error?.code)&&error.delivery==='NOT_SENT')throw error;
    throw failure('PORTFOLIO_BARRIER_INVALID','Portfolio barrier failed before dispatch',error);
  }
}
export function releasePortfolioBarrier(...args){
  try{return release(...args);}catch(error){
    if(known.has(error?.code)&&error.delivery==='NOT_SENT')throw error;
    throw failure('PORTFOLIO_BARRIER_INVALID','Portfolio barrier release failed',error);
  }
}
