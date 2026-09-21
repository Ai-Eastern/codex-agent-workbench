import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {configFrom,digest,readJson,validatePlan,validatePortfolio,validateAction,validateActionReceipt,validateRequest,writeJson} from '../src/contracts.mjs';

function plan(){
  return {schemaVersion:1,projectId:'project-a',planId:'bulk-import',revision:1,objective:'Implement bulk import',
    phases:[{id:'implement',dependsOn:[],maxNativeWorkers:3}],
    tasks:[{id:'validate-input',revision:1,phaseId:'implement',dependsOn:[],executor:'native',files:['src/import.mjs'],contextRefs:['import-contract-v1'],acceptanceRefs:['import-acceptance-v1']}]};
}
function secondTask(p,overrides={}){p.tasks.push({...structuredClone(p.tasks[0]),id:'save-input',files:['src/save.mjs'],...overrides});return p;}
function portfolio(){
  return {schemaVersion:1,portfolioId:'demo-portfolio',revision:1,coordinatorEpoch:1,budget:{maxActiveWorkers:3,maxAttemptsPerTask:2},projects:[
    {projectId:'project-a',planId:'bulk-import',acceptedPlanRevision:1,priority:3},
    {projectId:'project-b',planId:'sdk-compatibility',acceptedPlanRevision:2,priority:2},
  ],dependencies:[]};
}
function dependency(){
  return {from:{projectId:'project-a',planId:'bulk-import',planRevision:1,taskId:'validate-input',taskRevision:1,artifactId:'import-api',artifactVersion:1,artifactHash:`sha256:${digest('published import contract')}`},
    to:{projectId:'project-b',planId:'sdk-compatibility',planRevision:2,taskId:'adapt-sdk',taskRevision:3}};
}
function action(){return {id:'action-001',type:'DISPATCH',portfolioId:'demo-portfolio',projectId:'project-a',coordinatorEpoch:1,planRevision:1,taskId:'validate-input',taskRevision:1,attemptId:'attempt-001',actorBindingRef:'project-a-lead',packetHash:`sha256:${digest('frozen packet')}`};}
function accepted(){return {actionId:'action-001',projectId:'project-a',attemptId:'attempt-001',status:'ACCEPTED',hostReceiptRef:'local-private-evidence:dispatch-001'};}
function fixture(t){
  const parent=fs.realpathSync(os.tmpdir()),root=fs.mkdtempSync(path.join(parent,'plan-contract-'));
  t.after(()=>{assert.equal(path.dirname(root),parent);assert.equal(fs.lstatSync(root).isSymbolicLink(),false);fs.rmSync(root,{recursive:true,force:true});});
  const cfg={projectId:'project-a',projectRoot:root,workRoot:path.join(root,'work'),controlRoot:path.join(root,'control'),vaultRoot:path.join(root,'knowledge'),maxWorkers:3,pmThreadId:'11111111-1111-4111-8111-111111111111',workerThreads:{}};
  fs.mkdirSync(cfg.workRoot);
  return {root,cfg,file:path.join(root,'project.json')};
}

test('minimal documented plan and shipped example load without mutating their source',()=>{
  const input=plan(),result=validatePlan(input,'project-a');
  assert.deepEqual(result.constraints,[]);assert.deepEqual(result.tasks[0].constraints,[]);
  assert.equal(Object.hasOwn(input,'constraints'),false);assert.equal(Object.hasOwn(input.tasks[0],'constraints'),false);
  const example=readJson(new URL('../examples/plan.example.json',import.meta.url));
  assert.equal(validatePlan(example,'example-project').tasks.length,1);
  assert.equal(result.phases[0].decision,undefined);
});

test('plan requires project identity, supported schema, versions and execution carrier',()=>{
  assert.throws(()=>validatePlan(plan(),'project-b'),/projectId/);
  for(const mutate of [p=>delete p.revision,p=>p.revision=0,p=>p.revision=1.5,p=>p.schemaVersion=2,p=>p.tasks[0].revision='1',p=>p.tasks[0].executor='headless',p=>p.tasks[0].phaseId='missing',p=>p.phases[0].maxNativeWorkers=4,p=>p.constraints=null,p=>p.tasks[0].dependsOn=null,p=>p.tasks[0].contextRefs=Array(1)]){
    const p=plan();mutate(p);assert.throws(()=>validatePlan(p));
  }
  for(const input of [null,[],42])assert.throws(()=>validatePlan(input));
});

test('duplicate IDs, unknown dependencies, and phase/task cycles fail closed',()=>{
  for(const mutate of [
    p=>p.tasks.push(structuredClone(p.tasks[0])),
    p=>p.phases.push(structuredClone(p.phases[0])),
    p=>p.tasks[0].dependsOn=['absent'],
    p=>p.phases[0].dependsOn=['absent'],
    p=>p.tasks[0].dependsOn=['validate-input'],
    p=>p.phases[0].dependsOn=['implement'],
    p=>{secondTask(p,{dependsOn:['validate-input']});p.tasks[0].dependsOn=['save-input'];},
    p=>{p.phases.push({id:'verify',dependsOn:['implement'],maxNativeWorkers:0});secondTask(p,{phaseId:'verify',executor:'direct'});p.tasks[0].dependsOn=['save-input'];},
  ]){const p=plan();mutate(p);assert.throws(()=>validatePlan(p),/Duplicate|Unknown|Cyclic/);}
});

test('parallel aliases and directory overlaps are rejected; explicit task order permits shared files',()=>{
  for(const file of ['src/IMPORT.mjs','src\\import.mjs','src'])assert.throws(()=>validatePlan(secondTask(plan(),{files:[file]})),/Overlapping/);
  const ordered=secondTask(plan(),{files:['src/import.mjs'],dependsOn:['validate-input']});
  assert.equal(validatePlan(ordered).tasks.length,2);
  const transitive=secondTask(plan(),{dependsOn:['validate-input']});
  transitive.tasks.push({...structuredClone(transitive.tasks[0]),id:'finish-input',dependsOn:['save-input']});
  assert.equal(validatePlan(transitive).tasks.length,3);
  const duplicate=plan();duplicate.tasks[0].files.push('SRC/import.mjs');
  assert.throws(()=>validatePlan(duplicate),/Overlapping/);
});

test('transitive phase barriers permit sequential file reuse even through an empty phase',()=>{
  const p=plan();
  p.phases.push({id:'review',dependsOn:['implement'],maxNativeWorkers:0},{id:'verify',dependsOn:['review'],maxNativeWorkers:0});
  secondTask(p,{phaseId:'verify',executor:'direct',files:['src/import.mjs']});
  assert.equal(validatePlan(p).tasks.length,2);
  p.phases[1].dependsOn=[];
  assert.throws(()=>validatePlan(p),/Overlapping/);
});

test('task paths stay portable and inside the registered work ownership boundary',t=>{
  const {cfg}=fixture(t);
  for(const file of ['../escape.mjs','src/../escape.mjs','/absolute.mjs','C:\\secret.txt','src/*','src/file:stream','src/NUL.txt','src/end.','src//x']){
    const p=plan();p.tasks[0].files=[file];assert.throws(()=>validatePlan(p,cfg));
  }
  const p=plan();p.tasks[0].files=['control/state.sqlite'];
  assert.throws(()=>validatePlan(p,{...cfg,workRoot:cfg.projectRoot}),/control state/);
});

test('phase decisions and task acceptance references carry explicit, bounded choices',()=>{
  const p=plan();p.phases[0].decision={topology:'parallel',carrier:'native',context:'select',reason:'Two independent write sets'};
  assert.equal(validatePlan(p).phases[0].decision.context,'select');
  p.phases[0].decision.context='reset-every-message';assert.throws(()=>validatePlan(p),/decision/);
  delete p.phases[0].decision;p.phases[0].maxNativeWorkers=0;assert.throws(()=>validatePlan(p),/capacity/);
  p.tasks[0].executor='direct';assert.equal(validatePlan(p).phases[0].maxNativeWorkers,0);
  p.tasks[0].acceptanceRefs=[];assert.throws(()=>validatePlan(p),/acceptanceRefs/);
});

test('optional artifact declarations bind unique IDs and versions to each task exact owned files',t=>{
  const {cfg}=fixture(t),p=secondTask(plan());
  assert.equal(Object.hasOwn(validatePlan(p,cfg).tasks[0],'artifacts'),false);
  p.tasks[0].artifacts=[{id:'import-api',version:1,path:'src/import.mjs'}];
  p.tasks[1].artifacts=[{id:'save-api',version:2,path:'src/save.mjs'}];
  assert.deepEqual(validatePlan(p,cfg).tasks[1].artifacts,p.tasks[1].artifacts);
  assert.equal(Object.hasOwn(p.tasks[0].artifacts[0],'hash'),false);
  for(const version of [undefined,0,-1,1.5,'1',Number.MAX_SAFE_INTEGER+1]){
    const broken=structuredClone(p);broken.tasks[0].artifacts[0].version=version;
    assert.throws(()=>validatePlan(broken,cfg),/Artifact version/);
  }
  for(const artifactPath of ['src/save.mjs','../escape.mjs','src/IMPORT.mjs','src/import.mjs/child',undefined]){
    const broken=structuredClone(p);broken.tasks[0].artifacts[0].path=artifactPath;
    assert.throws(()=>validatePlan(broken,cfg),/task.files/);
  }
  const duplicate=structuredClone(p);duplicate.tasks[1].artifacts[0].id='import-api';
  assert.throws(()=>validatePlan(duplicate,cfg),/Duplicate plan artifact/);
  duplicate.tasks[1].artifacts=[];duplicate.tasks[0].artifacts.push({...duplicate.tasks[0].artifacts[0]});
  assert.throws(()=>validatePlan(duplicate,cfg),/Duplicate plan artifact/);
  const invalid=structuredClone(p);invalid.tasks[0].artifacts[0].id='../bad-id';
  assert.throws(()=>validatePlan(invalid,cfg),/artifact id/);
  invalid.tasks[0].artifacts=null;assert.throws(()=>validatePlan(invalid,cfg),/artifacts/);
});

test('portfolio references exact cross-project task and artifact versions',()=>{
  const p=portfolio();p.dependencies.push(dependency());
  const result=validatePortfolio(p);
  assert.equal(result.dependencies[0].from.artifactHash,digest('published import contract'));
  assert.ok(p.dependencies[0].from.artifactHash.startsWith('sha256:'));
  for(const mutate of [
    x=>x.projects.push({...x.projects[0]}),x=>x.budget.maxActiveWorkers=0,
    x=>delete x.projects[0].acceptedPlanRevision,x=>x.coordinatorEpoch=0,
    x=>x.dependencies[0].from.planRevision=2,x=>x.dependencies[0].from.projectId='project-c',
    x=>delete x.dependencies[0].from.artifactVersion,x=>x.dependencies[0].from.artifactHash='sha256:<placeholder>',
    x=>delete x.dependencies[0].to.taskRevision,
  ]){const broken=structuredClone(p);mutate(broken);assert.throws(()=>validatePortfolio(broken));}
  p.projects[0].acceptedPlanRevision=2;
  assert.equal(validatePortfolio(p).dependencies[0].from.planRevision,1);
  p.dependencies[0].to.planRevision=1;
  assert.throws(()=>validatePortfolio(p),/revision/);
});

test('actions require real hashes and complete positive version identity',()=>{
  const a=action(),normalized=validateAction(a);
  assert.equal(normalized.packetHash,digest('frozen packet'));
  assert.ok(a.packetHash.startsWith('sha256:'));
  for(const mutate of [a=>a.packetHash='sha256:<generated-from-frozen-packet>',a=>delete a.taskRevision,a=>a.coordinatorEpoch=0,a=>a.type='SILENT_RETRY',a=>a.projectId='../project-a']){
    const broken=action();mutate(broken);assert.throws(()=>validateAction(broken));
  }
});

test('cross-project cycles and duplicate delivery edges are rejected',()=>{
  const p=portfolio(),forward=dependency();
  p.dependencies=[forward,{from:{...forward.to,artifactId:'sdk-api',artifactVersion:1,artifactHash:digest('sdk contract')},to:{projectId:forward.from.projectId,planId:forward.from.planId,planRevision:forward.from.planRevision,taskId:forward.from.taskId,taskRevision:forward.from.taskRevision}}];
  assert.throws(()=>validatePortfolio(p),/Cyclic cross-project/);
  p.dependencies=[forward,{from:Object.fromEntries(Object.entries(forward.from).reverse()),to:forward.to}];
  assert.throws(()=>validatePortfolio(p),/Duplicate cross-project/);
  // A previous revision's delivery can feed the next revision without forming a cycle.
  p.projects[0].acceptedPlanRevision=2;
  p.dependencies=[forward,{from:{...forward.to,artifactId:'sdk-api',artifactVersion:1,artifactHash:digest('sdk contract')},to:{projectId:'project-a',planId:'bulk-import',planRevision:2,taskId:'validate-input',taskRevision:2}}];
  assert.equal(validatePortfolio(p).dependencies.length,2);
});

test('dispatch receipt validates against its action without claiming completion',()=>{
  const receipt=validateActionReceipt(accepted(),action());
  assert.equal(receipt.status,'ACCEPTED');assert.equal(receipt.artifactHashes,undefined);
  for(const [key,value] of [['actionId','other'],['projectId','project-b'],['attemptId','old'],['planRevision',2],['taskRevision',2],['coordinatorEpoch',2],['packetHash',digest('changed packet')]]){
    assert.throws(()=>validateActionReceipt({...accepted(),[key]:value},action()),/mismatch/);
  }
  assert.throws(()=>validateActionReceipt(accepted()),/Action/);
  assert.throws(()=>validateActionReceipt({...accepted(),hostReceiptRef:' '},action()),/hostReceiptRef/);
});

test('completion binds packet, input and artifact hashes; verification uses a separate acceptance action',()=>{
  const a={...action(),inputArtifactHashes:[digest('input')]},r={...accepted(),status:'COMPLETED',packetHash:a.packetHash,inputArtifactHashes:[`sha256:${digest('input')}`],artifactHashes:[digest('output')]};
  assert.equal(validateActionReceipt(r,a).status,'COMPLETED');
  for(const field of ['packetHash','inputArtifactHashes','artifactHashes']){const broken={...r};delete broken[field];assert.throws(()=>validateActionReceipt(broken,a),/requires/);}
  assert.throws(()=>validateActionReceipt({...r,inputArtifactHashes:[digest('other input')]},a),/mismatch/);
  const verification={...r,status:'VERIFIED',acceptanceHash:digest('frozen acceptance')};
  assert.throws(()=>validateActionReceipt(verification,a),/separate acceptance/);
  assert.throws(()=>validateActionReceipt(verification,{...a,type:'ACCEPT'}),/frozen acceptanceHash/);
  assert.equal(validateActionReceipt(verification,{...a,type:'ACCEPT',acceptanceHash:verification.acceptanceHash}).status,'VERIFIED');
});

test('new plans demand explicit model settings and preserve syntax-valid user choices',t=>{
  const {cfg,file}=fixture(t);
  writeJson(file,cfg);
  assert.equal(configFrom(file).model,'gpt-5.5');assert.equal(configFrom(file).thinking,'low');
  assert.throws(()=>configFrom(file,{requireExplicitModel:true}),/Explicit model/);
  for(const [model,thinking] of [['gpt-6-astra','ultra'],['gpt-5.6-luna','ultra'],['custom-provider/custom-model','future-effort']]){
    writeJson(file,{...cfg,model,thinking});
    const actual=configFrom(file,{requireExplicitModel:true});assert.equal(actual.model,model);assert.equal(actual.thinking,thinking);
  }
  for(const change of [{model:null,thinking:'low'},{model:'',thinking:'low'},{model:'gpt-6-astra',thinking:' '},{model:'model\nother',thinking:'low'}]){
    writeJson(file,{...cfg,...change});assert.throws(()=>configFrom(file),/syntax/);
  }
});

test('legacy request restrictions are unchanged by the new plan graph contract',t=>{
  const {cfg}=fixture(t),request={id:'legacy',objective:'Legacy direct request',mode:'direct',reason:'Single bounded task',tasks:[{id:'A',objective:'Write A',files:['a.mjs'],dependsOn:['A']}],checks:[{id:'verify',command:'node',args:['-e','process.exit(0)']}]};
  assert.throws(()=>validateRequest(request,cfg),/cyclic/);
  request.tasks[0].dependsOn=[];request.tasks.push({id:'B',objective:'Write B',files:['b.mjs']});
  assert.throws(()=>validateRequest(request,cfg),/Direct mode/);
});
