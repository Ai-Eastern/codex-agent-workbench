import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {promptFor} from '../src/workflow.mjs';

// Compare unique files required by the documented entry routes, not model tokens.
export function measureGuidance(beforeRoot,afterRoot){
  const ref=name=>`references/${name}.md`,entry='SKILL.md';
  const profiles=[
    ['engineer',[entry,ref('worker')],[entry,ref('worker')],true],
    ['pm-direct',[entry,ref('execution'),ref('worker')],[entry,ref('execution'),ref('worker')],true],
    ['pm-native',[entry,ref('execution')],[entry,ref('execution'),ref('native')],false],
    ['pm-langgraph',[entry,ref('execution')],[entry,ref('execution'),ref('desktop')],false],
    ['gm-handoff',[entry,ref('handoff')],[entry,ref('handoff')],false],
    // Cumulative PM lifecycle: recovery is additional material, not free.
    ['pm-langgraph-then-recovery',[entry,ref('execution')],[entry,ref('execution'),ref('desktop'),ref('recovery')],false],
  ];
  const read=(root,file)=>fs.readFileSync(path.join(root,file),'utf8').replace(/\r\n/g,'\n');
  const hash=text=>createHash('sha256').update(text).digest('hex');
  const files=root=>[entry,...fs.readdirSync(path.join(root,'references')).filter(x=>x.endsWith('.md')).map(x=>`references/${x}`)];
  const old=read(beforeRoot,ref('execution')),after=read(afterRoot,ref('recovery'));
  const recovery=old.slice(old.indexOf('## 只修知识候选')).trim();
  if(!recovery.startsWith('## 只修知识候选')||!after.endsWith(`${recovery}\n`))throw Error('Recovery rules were not preserved verbatim');
  const barrier=old.slice(old.indexOf('## 跨项目统一放行'),old.indexOf('## 状态与验收汇报')).trim();
  if(!read(afterRoot,ref('handoff')).includes(barrier))throw Error('Portfolio barrier changed during extraction');
  if(!read(afterRoot,ref('worker')).startsWith(read(beforeRoot,ref('worker')).trim()))throw Error('Existing worker rules were lost');
  for(const file of [ref('knowledge'),ref('cost')])if(read(beforeRoot,file)!==read(afterRoot,file))throw Error(`Unexpected rule change: ${file}`);
  for(const file of files(afterRoot))for(const match of read(afterRoot,file).matchAll(/\]\(([^)]+)\)/g)){
    if(/^(https?:|#)/.test(match[1]))continue;
    if(!fs.existsSync(path.resolve(afterRoot,path.dirname(file),match[1].split('#')[0])))throw Error(`Broken reference: ${file} -> ${match[1]}`);
  }
  const packet={runId:'guidance-probe',attemptId:'fixed-attempt',taskId:'A',mode:'native',model:'gpt-5.6-luna',thinking:'medium',projectObjective:'检查独立模块交付',objective:'实现标签规范化',taskConstraints:['normalize(string) 返回首尾去空格后的大写值；其余类型抛 TypeError'],constraints:['仅完成此模块'],workRoot:'/fixture',files:['/fixture/normalize.mjs'],receiptPath:'/fixture/result.json',dependencies:[],context:{items:[{id:'label-contract',path:'/fixture/knowledge/label.md',hash:'a'.repeat(64),text:'标签规范化采用 trim 后转大写。'}]}};
  const dispatch=promptFor(packet);
  const volume=(root,list,includePrompt)=>{
    const selected=[...new Set(list)],texts=selected.map(file=>read(root,file));
    const fileChars=texts.reduce((n,text)=>n+[...text].length,0);
    return {files:selected,reads:selected.length,normalizedRuleChars:fileChars,unchangedDispatchChars:includePrompt?[...dispatch].length:0,totalChars:fileChars+(includePrompt?[...dispatch].length:0)};
  };
  return {schemaVersion:1,unit:'Unicode code points; CRLF normalized to LF; not tokens',scope:'documented unique-file read plans; same synthetic engineer prompt included where consumed; not observed latency or full conversation usage',excluded:'runtime/project AGENTS, system instructions, tool wrappers, task data outside fixed prompt, existing history and optional project-specific rules',dispatchHash:hash(dispatch),checks:{recoveryVerbatim:true,portfolioVerbatim:true,existingWorkerPreserved:true,knowledgeCostUnchanged:true,linksResolve:true},sourceHashes:{before:Object.fromEntries(files(beforeRoot).map(f=>[f,hash(read(beforeRoot,f))])),after:Object.fromEntries(files(afterRoot).map(f=>[f,hash(read(afterRoot,f))]))},profiles:profiles.map(([role,b,a,p])=>{const before=volume(beforeRoot,b,p),after=volume(afterRoot,a,p);return {role,before,after,changeChars:after.totalChars-before.totalChars,reductionPercent:Math.round((1-after.totalChars/before.totalChars)*10000)/100};})};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const [before,after,output]=process.argv.slice(2);
  if(!before||!after||!output)throw Error('Usage: node scripts/measure-guidance.mjs <before-skill> <after-skill> <new-report.json>');
  const report=measureGuidance(path.resolve(before),path.resolve(after));
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({checks:report.checks,profiles:report.profiles.map(x=>({role:x.role,before:x.before.totalChars,after:x.after.totalChars,reductionPercent:x.reductionPercent,reads:[x.before.reads,x.after.reads]}))},null,2));
}
