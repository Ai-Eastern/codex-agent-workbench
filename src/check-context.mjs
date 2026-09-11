import path from 'node:path';
import {assertContained} from './contracts.mjs';

// An accidental-invocation guard for cooperating checks, not an OS sandbox.
export function requireCheckContext({expectedWorkRoot,expectedOutputRoot}={}){
  let context;
  try{context=JSON.parse(process.env.CODEX_WORKBENCH_CHECK??'');}catch{throw Error('Acceptance must be invoked by the controller');}
  if(!context||typeof context!=='object'||Array.isArray(context))throw Error('Invalid acceptance context');
  for(const key of ['workRoot','outputRoot'])if(typeof context[key]!=='string'||!path.isAbsolute(context[key]))throw Error('Absolute acceptance paths required');
  for(const key of ['runId','checkId'])if(typeof context[key]!=='string'||!context[key])throw Error('Acceptance identity required');
  const same=(a,b)=>process.platform==='win32'?path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase():path.resolve(a)===path.resolve(b);
  if(!same(process.cwd(),context.workRoot)||(expectedWorkRoot&&!same(expectedWorkRoot,context.workRoot)))throw Error('Acceptance working directory mismatch');
  if(expectedOutputRoot&&!same(expectedOutputRoot,context.outputRoot))throw Error('Acceptance output directory mismatch');
  assertContained(context.workRoot,context.workRoot);assertContained(context.outputRoot,context.outputRoot);
  return Object.freeze(context);
}
