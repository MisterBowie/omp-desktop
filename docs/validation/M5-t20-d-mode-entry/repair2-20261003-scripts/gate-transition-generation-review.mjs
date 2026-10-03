// Deterministic registered-handler review. No claim of native scheduling reachability.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const repo='/home/vv/person/code/omp-desktop-m5-t20-d-enter',app=join(repo,'app');
const output='/tmp/omp-t20-d-enter-repair2-local-20261003/out';
register(pathToFileURL(join(app,'apps/desktop/test/helpers/ts-import-hooks.mjs')));
const {default:gate}=await import(pathToFileURL(join(app,'packages/omp-runtime/extensions/omp-desktop-gate.ts')));
const {serializeDesktopCapabilityState}=await import(pathToFileURL(join(app,'packages/omp-runtime/src/desktop-state.ts')));
const {encodeTurnAdmission}=await import(pathToFileURL(join(app,'packages/omp-runtime/src/session/turn-admission.ts')));
const {OMP_TURN_COMMAND}=await import(pathToFileURL(join(app,'packages/omp-runtime/src/session/turn-fence.ts')));
const {encodeModeTransitionDetails}=await import(pathToFileURL(join(app,'packages/omp-runtime/src/session/mode-transition.ts')));
const {parseTurnFailureNotice}=await import(pathToFileURL(join(app,'packages/omp-runtime/src/session/turn-failure.ts')));
const root=realpathSync(mkdtempSync(join(tmpdir(),'root-d-enter-generation-'))),statePath=join(root,'desktop-state.json');
const keys=['OMP_DESKTOP_STATE','OMP_DESKTOP_STATE_REQUIRED','OMP_DESKTOP_GATE_MODE','OMP_DESKTOP_GATE_TOOLS'];
const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
process.env.OMP_DESKTOP_STATE=statePath;process.env.OMP_DESKTOP_STATE_REQUIRED='1';delete process.env.OMP_DESKTOP_GATE_MODE;delete process.env.OMP_DESKTOP_GATE_TOOLS;
const OWNER='owner-native';
const hostTools=['EnterPlanMode','EnterGoalMode','SubmitPlan','SubmitGoal'].map(name=>({name,risk:'low',planSafeActions:[],origin:'desktop'}));
const report={candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'real gate registered handlers, real admission/transition codecs and serialized state; controlled public API promises; no provider/tool bodies/host DB, no universal native reachability claim',cases:[]};
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j;});return {promise,resolve,reject};}
function harness(){
 const handlers=new Map(),commands=new Map(),notices=[],selections=[],prompts=[];
 let waitPrompt=null,waitClamp=null,aborts=0;
 gate({on:(name,handler)=>handlers.set(name,handler),registerCommand:(name,definition)=>commands.set(name,definition.handler),getActiveTools:()=>['read','write','edit','bash',...hostTools.map(t=>t.name)],setActiveTools:async names=>{selections.push([...names]);const p=waitClamp;waitClamp=null;if(p)await p.promise;},setTurnSystemPrompt:async parts=>{prompts.push([...parts]);const p=waitPrompt;waitPrompt=null;if(p)await p.promise;},logger:{warn(){}}});
 const context=(id,hasUI)=>({cwd:root,hasUI,sessionManager:{getSessionId:()=>id,getCwd:()=>root},abort(){aborts++;},...(hasUI?{ui:{notify:message=>notices.push(message),select:async()=>undefined}}:{})});
 const owner=context(OWNER,true),child=context('child-'+Math.random(),false);
 const emit=(name,payload,ctx=owner)=>handlers.get(name)?.(payload,ctx);
 async function admit(token,permissionMode='auto'){
  writeFileSync(statePath,serializeDesktopCapabilityState({sessionId:OWNER,mode:'agent',modeBlock:'Agent mode '+token,permissionMode,skills:[],memory:null,hostTools},Date.now()));
  commands.get(OMP_TURN_COMMAND)(token+' '+encodeTurnAdmission({v:1,nativeSessionId:OWNER,mode:'agent',permissionMode,hostTools,grants:[]}),owner);
  await emit('before_agent_start',{type:'before_agent_start',systemPrompt:['native']});
  await emit('agent_start',{type:'agent_start'});
 }
 const enter=()=>emit('tool_result',{type:'tool_result',toolName:'EnterPlanMode',toolCallId:'entry-A',isError:false,details:encodeModeTransitionDetails({v:1,kind:'plan',state:'ready',sessionId:OWNER,liveTurnId:'omp-turn:owner-native:1',hostTurnId:'host-A',toolCallId:'entry-A',expectedMode:'agent',modeBlock:'Plan mode A',hostTools:hostTools.filter(t=>t.name==='SubmitPlan'),at:Date.now()})});
 const write=ctx=>emit('tool_call',{type:'tool_call',toolName:'write',toolCallId:'write-check',input:{path:join(root,'unexecuted.txt'),content:'no tool body'}},ctx);
 return {admit,enter,write,emit,owner,child,selections,prompts,notices,waitPrompt(p){waitPrompt=p;},waitClamp(p){waitClamp=p;},aborts:()=>aborts,failures:()=>notices.map(message=>parseTurnFailureNotice({type:'extension_ui_request',method:'notify',message})).filter(Boolean)};
}
const A='a'.repeat(32),B='b'.repeat(32);
try{
 for(const scenario of ['positive-current-transition','positive-current-failure','prompt-resolve-after-new-turn','prompt-reject-after-new-turn','clamp-reject-after-new-turn']){
  const h=harness(),row={scenario};report.cases.push(row);await h.admit(A);
  row.beforeAllowed=(await h.write())?.block!==true;
  if(scenario==='positive-current-transition'){
   await h.enter();row.afterBlocked=(await h.write())?.block===true;row.failures=h.failures();row.passed=row.beforeAllowed&&row.afterBlocked&&row.failures.length===0;continue;
  }
  const hold=deferred();if(scenario.startsWith('clamp'))h.waitClamp(hold);else h.waitPrompt(hold);
  const pending=h.enter();await Promise.resolve();await Promise.resolve();
  if(scenario==='positive-current-failure'){
   hold.reject(new Error('controlled current API failure'));await pending;row.failures=h.failures();row.aborts=h.aborts();row.afterBlocked=(await h.write())?.block===true;row.passed=row.beforeAllowed&&row.afterBlocked&&row.aborts===1&&row.failures.length===1&&row.failures[0].turnToken===A;continue;
  }
  await h.emit('agent_end',{type:'agent_end'});await h.admit(B);await h.emit('before_agent_start',{type:'before_agent_start',systemPrompt:['native child']},h.child);await h.emit('agent_start',{type:'agent_start'},h.child);
  row.newOwnerBeforeAllowed=(await h.write())?.block!==true;row.newChildBeforeAllowed=(await h.write(h.child))?.block!==true;const beforeSelections=h.selections.length,beforeAborts=h.aborts();
  if(scenario.includes('reject'))hold.reject(new Error('controlled stale API rejection'));else hold.resolve();
  await pending;
  row.newOwnerAfter=await h.write()??null;row.newChildAfter=await h.write(h.child)??null;row.lateSelections=h.selections.slice(beforeSelections);row.newFailures=h.failures();row.lateAborts=h.aborts()-beforeAborts;
  row.passed=row.beforeAllowed&&row.newOwnerBeforeAllowed&&row.newChildBeforeAllowed&&row.newOwnerAfter?.block!==true&&row.newChildAfter?.block!==true&&row.lateSelections.length===0&&row.newFailures.length===0&&row.lateAborts===0;
 }
}catch(error){report.error=String(error.stack??error);}
finally{for(const k of keys){if(previous[k]===undefined)delete process.env[k];else process.env[k]=previous[k];}rmSync(root,{recursive:true,force:true});report.scratchRemoved=true;}
report.passed=!report.error&&report.cases.length===5&&report.cases.every(r=>r.passed);
writeFileSync(join(output,'gate-transition-generation-'+report.candidate.slice(0,8)+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
