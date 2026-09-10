// Native framing adapted from codex-mcp-bridge (MIT). See licenses/.
// This is an internal Desktop capability, not a stable public service API.
import net from 'node:net';
import {randomUUID} from 'node:crypto';
import path from 'node:path';

function decode(raw){
  if(raw?.success!==true||raw.isError)throw Error('Desktop acknowledgement rejected');
  let result=raw.structuredContent;
  if(result===undefined){
    const text=(raw.contentItems??raw.content??[]).filter(c=>['text','inputText'].includes(c.type)).map(c=>c.text).join('\n');
    if(text){try{result=JSON.parse(text);}catch{result={text};}}
  }
  result??=raw;
  if(result.isError||result.success===false)throw Error('Desktop operation rejected');
  return result;
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
          if(res.error||!Object.hasOwn(res,'result'))return finish(Error('Desktop RPC rejected'));
          finish(null,res.result);
        }
      });
    });
  }
  return {
    async read(id){
      const r=await call('read_thread',{threadId:id,hostId:'local',turnLimit:1,includeOutputs:false,maxOutputCharsPerItem:1000});
      if(r.thread?.id!==id)throw Error('Desktop returned mismatched identity');
      if(typeof r.thread.cwd!=='string'||path.resolve(r.thread.cwd).toLowerCase()!==path.resolve(cfg.projectRoot).toLowerCase())throw Error('Desktop task belongs to a different or unverified project');
      const turn=r.page?.order==='newest_first'?r.turns?.[0]:undefined;
      return {id,cwd:r.thread.cwd,status:r.thread.status?.type,turnId:turn?.id,turnStatus:turn?.status};
    },
    send:(id,prompt)=>call('send_message_to_thread',{threadId:id,hostId:'local',prompt,model:cfg.model,thinking:cfg.thinking})
  };
}
