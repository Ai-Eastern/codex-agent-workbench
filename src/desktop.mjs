// Native framing adapted from codex-mcp-bridge (MIT). See licenses/.
// This is an internal Desktop capability, not a stable public service API.
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';

export function sanitizeErrorDetail(value){
  return String(value??'').replace(/\bBearer\s+[^\s,;]+/gi,'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g,'[redacted]').replace(/[\w.+-]+:\/\/[^\s]+/gi,'[redacted]').replace(/((?:token|secret|password|api[_-]?key))\s*[:=]\s*[^\s,;]+/gi,'$1=[redacted]').slice(0,600);
}
function rejected(raw){
  const code=sanitizeErrorDetail(raw?.code||raw?.error?.code||'DESKTOP_ACK_REJECTED');
  const reason=sanitizeErrorDetail(raw?.reason||raw?.error?.reason);
  const message=sanitizeErrorDetail(raw?.message||raw?.error?.message||'Desktop acknowledgement rejected')||'Desktop acknowledgement rejected';
  const e=Error(message); e.code=code; e.delivery='UNCONFIRMED_DO_NOT_RETRY'; if(reason)e.reason=reason; throw e;
}
export function decode(raw){
  if(raw?.success!==true||raw.isError)rejected(raw);
  let result=raw.structuredContent;
  if(result===undefined){
    const text=(raw.contentItems??raw.content??[]).filter(c=>['text','inputText'].includes(c.type)).map(c=>c.text).join('\n');
    if(text){try{result=JSON.parse(text);}catch{throw Object.assign(Error('Invalid Desktop acknowledgement'),{code:'MALFORMED_ACK',delivery:'UNCONFIRMED_DO_NOT_RETRY'});}}
  }
  result??=raw;
  if(result.isError||result.success===false)rejected(result);
  return result;
}
function statePath(cfg){return cfg.desktopStatePath||(process.env.CODEX_HOME?path.join(process.env.CODEX_HOME,'state_5.sqlite'):path.join(os.homedir(),'.codex','state_5.sqlite'));}
function comparableCwd(value){
  let v=String(value);
  if(/^\\\\\?\\UNC\\/i.test(v))v='\\\\'+v.slice(8);
  else if(/^\\\\\?\\/i.test(v))v=v.slice(4);
  return path.win32.normalize(v).replace(/[\\/]+$/,'').toLowerCase();
}
export function readThreadState(cfg,id){
  const file=statePath(cfg);
  let d; try{d=new DatabaseSync(file,{readOnly:true});}catch{throw Object.assign(Error(`Codex state database unavailable: ${file}`),{code:'STATE_DB_UNAVAILABLE',delivery:'NOT_SENT'});}
  try{
    let row; try{row=d.prepare('SELECT id,cwd,archived FROM threads WHERE id = ?').get(id);}catch{throw Object.assign(Error('Codex state database has no readable threads table'),{code:'STATE_SCHEMA_UNAVAILABLE',delivery:'NOT_SENT'});}
    if(!row)throw Object.assign(Error(`Codex thread not found: ${id}`),{code:'THREAD_NOT_FOUND',delivery:'NOT_SENT'});
    if(typeof row.cwd!=='string'||comparableCwd(row.cwd)!==comparableCwd(cfg.projectRoot))throw Object.assign(Error('Desktop task belongs to a different or unverified project'),{code:'THREAD_CWD_MISMATCH',delivery:'NOT_SENT'});
    if(![0,1,false,true].includes(row.archived))throw Object.assign(Error(`Codex thread archive state is unavailable: ${id}`),{code:'THREAD_ARCHIVE_UNKNOWN',delivery:'NOT_SENT'});
    const archived=row.archived===1||row.archived===true;
    if(archived)throw Object.assign(Error(`Codex thread is archived: ${id}`),{code:'THREAD_ARCHIVED',delivery:'NOT_SENT'});
    return {id,cwd:row.cwd,archived:false,availabilityEvidence:{fields:'threads.id,threads.cwd,threads.archived',observedAt:new Date().toISOString(),statePath:file}};
  }finally{d.close();}
}
export function desktopClient(cfg){
  const caller=process.env.CODEX_THREAD_ID,pipe=process.env.CODEX_APP_TOOLS_PIPE_PATH;
  if(caller!==cfg.pmThreadId||!pipe)throw Error('Run this command inside the configured PM Desktop task');
  const targets=new Set([cfg.pmThreadId,...Object.values(cfg.workerThreads)]);
  async function call(tool,args){
    if(!['read_thread','send_message_to_thread'].includes(tool)||!targets.has(args.threadId))throw Error('Desktop target outside project');
    if(tool==='send_message_to_thread'&&(args.threadId===caller||args.model!==cfg.model||args.thinking!==cfg.thinking))throw Error('Invalid Desktop dispatch');
    if(process.env.CODEX_THREAD_ID!==caller||process.env.CODEX_APP_TOOLS_PIPE_PATH!==pipe)throw Error('Desktop identity changed');
    const id=randomUUID(),request={jsonrpc:'2.0',id,method:'tools/call',params:{namespace:'codex_app',threadId:caller,tool,arguments:args,callId:`workbench-${randomUUID()}`,turnId:`workbench-${randomUUID()}`}};
    const data=Buffer.from(JSON.stringify(request)),header=Buffer.alloc(4);header.writeUInt32LE(data.length);
    if(data.length>128*1024)throw Error('Desktop prompt exceeds frame budget');
    return new Promise((resolve,reject)=>{
      let buffer=Buffer.alloc(0),sent=false,ended=false;
      const socket=net.connect({path:pipe});
      const finish=(err,result)=>{if(ended)return;ended=true;clearTimeout(timer);socket.destroy();if(err){err.delivery=sent?'UNCONFIRMED_DO_NOT_RETRY':'NOT_SENT';reject(err);}else{try{resolve(decode(result));}catch(e){e.delivery='UNCONFIRMED_DO_NOT_RETRY';reject(e);}}};
      const timer=setTimeout(()=>finish(Error('Desktop reply timeout')),45000);
      socket.on('connect',()=>{sent=true;socket.write(Buffer.concat([header,data]));});
      socket.on('error',e=>finish(Error(`Desktop socket ${e.code??'error'}`)));
      socket.on('close',()=>finish(Error('Desktop connection closed without acknowledgement')));
      socket.on('data',chunk=>{
        buffer=Buffer.concat([buffer,chunk]);
        while(!ended&&buffer.length>=4){
          const size=buffer.readUInt32LE();
          if(!size||size>8*1024*1024)return finish(Error('Desktop frame outside bound'));
          if(buffer.length<4+size)return;
          let res;try{res=JSON.parse(buffer.subarray(4,4+size));}catch{return finish(Error('Invalid Desktop JSON'));}
          buffer=buffer.subarray(4+size);
          if(res.id!==id)continue;
          if(res.error||!Object.hasOwn(res,'result'))return finish(null,{success:false,...(res.error||{}),code:res.error?.code||'DESKTOP_RPC_REJECTED'});
          finish(null,res.result);
        }
      });
    });
  }
  return {
    async read(id){
      const local=readThreadState(cfg,id);
      const r=await call('read_thread',{threadId:id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1000});
      if(r.thread?.id!==id)throw Error('Desktop returned mismatched identity');
      if(typeof r.thread.cwd!=='string'||comparableCwd(r.thread.cwd)!==comparableCwd(cfg.projectRoot))throw Error('Desktop task belongs to a different or unverified project');
      const turn=r.page?.order==='newest_first'?r.turns?.[0]:undefined;
      return {...local,status:r.thread.status?.type,turnId:turn?.id,turnStatus:turn?.status};
    },
    async send(id,prompt){
      readThreadState(cfg,id);
      return call('send_message_to_thread',{threadId:id,hostId:'local',prompt,model:cfg.model,thinking:cfg.thinking});
    }
  };
}
