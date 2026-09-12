const contractCommands=new Set(['start','packet','claim']);
const ordinaryCommands=new Set(['status','continue','delivery','index','capture']);
const ordinaryKeys=['projectId','runId','mode','status','phase','reason','nextAction','continueGate','acceptance','knowledgeIssues'];
const jsonSize=value=>JSON.stringify(value,null,2).length;
const reference=(detailsPath,detailsHash,form)=>({form,detailsPath,detailsHash,detailsAvailable:true});

function requireReference(detailsPath,detailsHash){
  if(typeof detailsPath!=='string'||!detailsPath||typeof detailsHash!=='string'||!detailsHash)throw Error('detailsPath and detailsHash are required');
}
function marked(payload,detailsPath,detailsHash,form){return {...payload,presentation:reference(detailsPath,detailsHash,form)};}
function searchProjection(result){
  return {...Object.fromEntries(['projectId','query','chars'].filter(k=>Object.hasOwn(result,k)).map(k=>[k,result[k]])),items:Array.isArray(result.items)?result.items.map(item=>Object.fromEntries(['id','title','path','hash','text','kind'].filter(k=>Object.hasOwn(item??{},k)).map(k=>[k,item[k]]))):[]};
}
function referenceOnly(result,detailsPath,detailsHash,maxChars){
  const safe=Object.fromEntries(['status','phase'].filter(k=>Object.hasOwn(result??{},k)).map(k=>[k,result[k]]));
  safe.needsRead=true;safe.warning='详情可能含阻塞/恢复约束，读取前不执行';
  const out=marked(safe,detailsPath,detailsHash,'reference');
  if(jsonSize(out)>maxChars)throw Error('OUTPUT_BUDGET_TOO_SMALL');
  return out;
}
function contractProjection(packet){return {...Object.fromEntries(['projectId','runId','taskId','attemptId','mode','model','thinking','contextHash','receiptPath','prompt'].filter(k=>Object.hasOwn(packet??{},k)).map(k=>[k,packet[k]])),...(Object.hasOwn(packet??{},'contextHash')?{contextHashScope:'full-context'}:{})};}

export function compactOutput(command,result,{detailsPath,detailsHash,maxChars=12000}={}){
  requireReference(detailsPath,detailsHash);
  if(!Number.isSafeInteger(maxChars)||maxChars<1024)throw Error('maxChars must be at least 1024');
  if(result===null||typeof result!=='object'){
    const full=marked({value:result},detailsPath,detailsHash,'full');return jsonSize(full)<=maxChars?full:referenceOnly({},detailsPath,detailsHash,maxChars);
  }
  if(contractCommands.has(command)){
    const packetList=Array.isArray(result.packets)?result.packets:null,completePackets=packetList?.length>0&&packetList.every(p=>typeof p?.prompt==='string'&&p.prompt.length>0),completeSingle=!packetList&&typeof result.prompt==='string'&&result.prompt.length>0;
    if(command==='start'&&packetList!==null&&!packetList.length)return compactOutput('status',result,{detailsPath,detailsHash,maxChars});
    if(!(packetList?completePackets:completeSingle))return referenceOnly(result,detailsPath,detailsHash,maxChars);
    const packet=packetList?{...Object.fromEntries(ordinaryKeys.filter(k=>Object.hasOwn(result,k)).map(k=>[k,result[k]])),packets:packetList.map(contractProjection)}:contractProjection(result);
    const compact=marked(packet,detailsPath,detailsHash,'compact-contract');
    return jsonSize(compact)<=maxChars?compact:referenceOnly(result,detailsPath,detailsHash,maxChars);
  }
  if(command==='search'){
    const compact=marked(searchProjection(result),detailsPath,detailsHash,'compact-search');
    return jsonSize(compact)<=maxChars?compact:referenceOnly(result,detailsPath,detailsHash,maxChars);
  }
  if(command==='continue'&&Array.isArray(result.packets)&&result.packets.length){
    if(!result.packets.every(p=>typeof p?.prompt==='string'&&p.prompt.length>0))return referenceOnly(result,detailsPath,detailsHash,maxChars);
    const compact=marked({...Object.fromEntries(ordinaryKeys.filter(k=>Object.hasOwn(result,k)).map(k=>[k,result[k]])),packets:result.packets.map(contractProjection)},detailsPath,detailsHash,'compact');
    return jsonSize(compact)<=maxChars?compact:referenceOnly(result,detailsPath,detailsHash,maxChars);
  }
  const full=marked(result,detailsPath,detailsHash,'full');
  if(jsonSize(full)<=maxChars)return full;
  if(!ordinaryCommands.has(command))return referenceOnly(result,detailsPath,detailsHash,maxChars);
  const summary=marked(Object.fromEntries(ordinaryKeys.filter(k=>Object.hasOwn(result,k)).map(k=>[k,result[k]])),detailsPath,detailsHash,'compact');
  return jsonSize(summary)<=maxChars?summary:referenceOnly(result,detailsPath,detailsHash,maxChars);
}
