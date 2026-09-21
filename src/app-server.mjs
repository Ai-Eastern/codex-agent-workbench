import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parseArgs} from 'node:util';
import {fileURLToPath} from 'node:url';
import {runLocalTask,readLocalTask,listLocalTasks,repairLocalTask,createTaskId} from './local-runner.mjs';
import {digest,assertContained} from './contracts.mjs';

const assets=fileURLToPath(new URL('../app/',import.meta.url));
const runId=id=>{if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id))throw Error('Invalid task id');return id;};
function json(response,status,value) {
  response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  response.end(JSON.stringify(value));
}
async function body(request) {
  const chunks=[];let size=0;
  for await(const chunk of request) {
    size+=chunk.length;
    if(size>65536)throw Error('Request exceeds 64 KiB');
    chunks.push(chunk);
  }
  const result=JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');
  if(!result||typeof result!=='object'||Array.isArray(result))throw Error('A JSON object is required');
  return result;
}
function recentEvents(file) {
  if(!fs.existsSync(file))return [];
  const fd=fs.openSync(file,'r');
  try {
    const size=fs.fstatSync(fd).size,start=Math.max(0,size-128*1024),buffer=Buffer.alloc(size-start);
    fs.readSync(fd,buffer,0,buffer.length,start);
    let lines=buffer.toString('utf8').split('\n');
    if(start)lines.shift();
    return lines.filter(Boolean).slice(-100).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  }finally{fs.closeSync(fd);}
}

function withAcceptanceDetails(record,stateRoot) {
  if(!record.acceptance?.hash||!record.acceptance.path)return record;
  try {
    const file=assertContained(path.join(stateRoot,'runs',record.id),record.acceptance.path);
    if(fs.statSync(file).size>8*1024*1024)throw Error('Acceptance receipt exceeds 8 MiB');
    const bytes=fs.readFileSync(file);
    if(digest(bytes)!==record.acceptance.hash)throw Error('Acceptance receipt changed');
    const receipt=JSON.parse(bytes);
    return {...record,acceptanceDetails:{passed:receipt.passed,checks:receipt.checks}};
  }catch(error){return {...record,acceptanceError:error.message};}
}

export async function startApp({repository,stateRoot,port=4317,executable,executor}) {
  if(!path.isAbsolute(repository)||!path.isAbsolute(stateRoot))throw Error('Absolute repository and state paths are required');
  if(!Number.isInteger(port)||port<0||port>65535)throw Error('Invalid port');
  const actualRoot=execFileSync('git',['-C',repository,'rev-parse','--show-toplevel'],{encoding:'utf8',windowsHide:true}).trim();
  if(path.resolve(actualRoot)!==path.resolve(repository))throw Error('--repo must identify the repository root');
  const relative=path.relative(repository,stateRoot);
  if(!relative||(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative)))throw Error('State must be outside the source repository');
  const token=randomBytes(32).toString('hex'),active=new Map();
  const staticRoutes=new Map([['/',['index.html','text/html']],['/app.js',['app.js','text/javascript']],['/style.css',['style.css','text/css']]]);
  function launch(id,operation) {
    if(active.has(id))throw Error('Task is already running');
    const abort=new AbortController();
    const onEvent=event=>{
      const root=path.join(stateRoot,'runs',id);
      fs.mkdirSync(root,{recursive:true});
      fs.appendFileSync(path.join(root,'activity.jsonl'),JSON.stringify({at:new Date().toISOString(),...event})+'\n');
    };
    const promise=operation({signal:abort.signal,onEvent}).catch(error=>{
      const root=path.join(stateRoot,'runs',id);
      if(fs.existsSync(root))onEvent({type:'workbench.error',message:error.message});
      return {phase:'BLOCKED',error:error.message};
    }).finally(()=>active.delete(id));
    active.set(id,{abort,promise});
  }
  const server=http.createServer(async(request,response)=>{
    const host=`127.0.0.1:${server.address().port}`;
    if(request.headers.host!==host){json(response,403,{error:'Loopback host required'});return;}
    try {
      const url=new URL(request.url,`http://${host}`);
      if(url.search){json(response,400,{error:'Unexpected query parameters'});return;}
      if(request.method==='POST'&&(request.headers['x-workbench-token']!==token||(request.headers.origin&&request.headers.origin!==`http://${host}`))){json(response,403,{error:'Local session token and same origin required'});return;}
      if(request.method==='GET'&&staticRoutes.has(url.pathname)) {
        const [name,type]=staticRoutes.get(url.pathname);
        const content=fs.readFileSync(path.join(assets,name));
        response.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",'Referrer-Policy':'no-referrer'});
        response.end(content);return;
      }
      if(request.method==='GET'&&url.pathname==='/api/project'){json(response,200,{repository,projectName:path.basename(repository),token});return;}
      if(request.method==='GET'&&url.pathname==='/api/runs'){json(response,200,{runs:listLocalTasks({stateRoot}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});return;}
      if(request.method==='POST'&&url.pathname==='/api/runs') {
        const task=await body(request);
        if(typeof task.objective!=='string'||!task.objective.trim()||!Array.isArray(task.files)||!task.files.length||!Array.isArray(task.checks)||!task.checks.length)throw Error('Objective, exact writable files and acceptance commands are required');
        const id=createTaskId();
        launch(id,options=>runLocalTask({repository,stateRoot,request:{...task,id},executable,executor,...options}));
        // runLocalTask reserves a durable manifest before any awaited executor work.
        await new Promise(resolve=>setImmediate(resolve));
        const record=readLocalTask({stateRoot,id});
        json(response,202,{id,phase:record.phase});return;
      }
      const match=/^\/api\/runs\/([^/]+)(?:\/(events|diff|cancel|repair))?$/.exec(url.pathname);
      if(match) {
        const id=runId(match[1]),action=match[2];
        const record=readLocalTask({stateRoot,id});
        if(request.method==='GET'&&!action){json(response,200,withAcceptanceDetails(record,stateRoot));return;}
        if(request.method==='GET'&&action==='events'){json(response,200,{events:recentEvents(path.join(record.runDirectory??path.join(stateRoot,'runs',id),'activity.jsonl'))});return;}
        if(request.method==='GET'&&action==='diff') {
          if(record.phase!=='READY_FOR_REVIEW')throw Error(`Patch is not ready: ${record.phase}`);
          json(response,200,{diff:fs.readFileSync(record.patch.path,'utf8')});return;
        }
        if(request.method==='POST'&&action==='cancel') {
          await body(request);
          const running=active.get(id);if(!running)throw Error('Task is not executing in this server process');
          running.abort.abort();json(response,202,{id,status:'STOP_REQUESTED'});return;
        }
        if(request.method==='POST'&&action==='repair') {
          const {reason}=await body(request);
          if(typeof reason!=='string'||!reason.trim())throw Error('An explicit repair reason is required');
          if(record.phase!=='FAILED_ACCEPTANCE')throw Error('Only a failed acceptance can be repaired');
          launch(id,options=>repairLocalTask({stateRoot,id,reason,executor,executable,...options}));json(response,202,{id});return;
        }
      }
      json(response,404,{error:'Not found'});
    }catch(error){json(response,400,{error:error.message});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const stop=async()=>{
    for(const job of active.values())job.abort.abort();
    await Promise.all([...active.values()].map(job=>job.promise));
    await new Promise(resolve=>server.close(resolve));
  };
  return {server,url:`http://127.0.0.1:${server.address().port}`,stop};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const {values}=parseArgs({options:{repo:{type:'string'},state:{type:'string'},port:{type:'string',default:'4317'},executable:{type:'string'},help:{type:'boolean'}}});
    if(values.help)console.log('npm start -- --repo <git-repository> --state <directory-outside-repository> [--port 4317] [--executable <codex-executable>]');
    else {
      if(!values.repo||!values.state)throw Error('--repo and --state are required');
      const {url,stop}=await startApp({repository:path.resolve(values.repo),stateRoot:path.resolve(values.state),port:Number(values.port),executable:values.executable});
      console.log(`Coding workbench: ${url}\nProject: ${path.resolve(values.repo)}\nTasks start only when you submit them. Existing Codex authentication and quota apply.`);
      for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void stop();});
    }
  }catch(error){console.error(error.message);process.exitCode=1;}
}
