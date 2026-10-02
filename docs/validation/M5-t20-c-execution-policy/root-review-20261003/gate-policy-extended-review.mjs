import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const repo='/Users/vv/Documents/对话/omp-desktop-review-m5-r4b',app=join(repo,'app');
register(pathToFileURL(join(app,'apps/desktop/test/helpers/ts-import-hooks.mjs')));
const { default:gate }=await import(pathToFileURL(join(app,'packages/omp-runtime/extensions/omp-desktop-gate.ts')));
const { serializeDesktopCapabilityState,writeDesktopCapabilityState }=await import(pathToFileURL(join(app,'packages/omp-runtime/src/desktop-state.ts')));
const { composeModeSystemPrompt }=await import(pathToFileURL(join(app,'packages/agent-runtime/src/mode-prompts.ts')));
const { OMP_APPROVAL_OPTIONS,parseApprovalDescriptor }=await import(pathToFileURL(join(app,'packages/omp-runtime/src/session/approval-protocol.ts')));
const { OMP_TURN_COMMAND }=await import(pathToFileURL(join(app,'packages/omp-runtime/src/session/turn-fence.ts')));
const root=mkdtempSync(join(tmpdir(),'omp-t20-c-root-gate-')),project=join(root,'project'),outside=join(root,'outside');mkdirSync(project);mkdirSync(outside);
const filename=join(root,'desktop-state.json');
writeFileSync(join(project,'inside.txt'),'inside');writeFileSync(join(outside,'outside.txt'),'outside');
const definitions=[
 {name:'agent-write-ask-with-legacy-allow',mode:'agent',permission:'ask',legacy:'allow',tool:'write',input:{path:'out.txt',content:'x'},blocked:true,cards:1,risk:'high'},
 {name:'agent-browser-ask',mode:'agent',permission:'ask',tool:'browser',input:{action:'open',url:'about:blank'},blocked:true,cards:1,risk:'medium'},
 {name:'agent-computer-ask',mode:'agent',permission:'ask',tool:'computer',input:{action:'screenshot'},blocked:true,cards:1,risk:'medium'},
 {name:'agent-eval-ask',mode:'agent',permission:'ask',tool:'eval',input:{code:'1+1'},blocked:true,cards:1,risk:'medium'},
 {name:'agent-unknown-ask',mode:'agent',permission:'ask',tool:'review_unknown_tool',input:{},blocked:true,cards:1,risk:'medium'},
 {name:'plan-read-relative-escape-ask',mode:'plan',permission:'ask',tool:'read',input:{path:'../outside/outside.txt'},blocked:true,cards:1,risk:'low'},
 {name:'agent-BrowserPreview-ask-contract-mapping-only',mode:'agent',permission:'ask',tool:'BrowserPreview',input:{url:'about:blank'},blocked:true,cards:1,risk:'medium'},
 {name:'agent-write-ask-denied-control',mode:'agent',permission:'ask',tool:'write',input:{path:'out.txt',content:'x'},blocked:true,cards:1,risk:'high'},
 {name:'agent-write-auto',mode:'agent',permission:'auto',tool:'write',input:{path:'out.txt',content:'x'},blocked:false,cards:0},
 {name:'agent-write-accept-edits',mode:'agent',permission:'accept-edits',tool:'write',input:{path:'out.txt',content:'x'},blocked:false,cards:0},
 {name:'plan-write-auto-legacy-allow',mode:'plan',permission:'auto',legacy:'allow',tool:'write',input:{path:'out.txt',content:'x'},blocked:true,cards:0},
 {name:'goal-write-auto',mode:'goal',permission:'auto',tool:'write',input:{path:'out.txt',content:'x'},blocked:true,cards:0},
 {name:'plan-bash-auto',mode:'plan',permission:'auto',tool:'bash',input:{command:'printf review'},blocked:false,cards:0},
 {name:'plan-bash-ask',mode:'plan',permission:'ask',tool:'bash',input:{command:'pwd'},blocked:true,cards:1,risk:'high'},
 {name:'goal-bash-accept-edits',mode:'goal',permission:'accept-edits',tool:'bash',input:{command:'pwd'},blocked:true,cards:1,risk:'high'},
 {name:'agent-plugin-low-ask',mode:'agent',permission:'ask',tool:'plugin_review_action',host:{risk:'low',origin:'plugin',planSafeActions:[]},input:{action:'inspect'},blocked:false,cards:0},
 {name:'agent-plugin-medium-ask',mode:'agent',permission:'ask',tool:'plugin_review_action',host:{risk:'medium',origin:'plugin',planSafeActions:[]},input:{action:'inspect'},blocked:true,cards:1,risk:'medium'},
 {name:'plan-plugin-unsafe-auto',mode:'plan',permission:'auto',legacy:'allow',tool:'plugin_review_action',host:{risk:'low',origin:'plugin',planSafeActions:[]},input:{action:'inspect'},blocked:true,cards:0},
 {name:'plan-plugin-safe-low',mode:'plan',permission:'ask',tool:'plugin_review_action',host:{risk:'low',origin:'plugin',planSafeActions:['inspect']},input:{action:'inspect'},blocked:false,cards:0},
 {name:'agent-user-mcp-low',mode:'agent',permission:'ask',tool:'mcp_review_lookup',host:{risk:'low',origin:'user-mcp',planSafeActions:[]},input:{query:'review'},blocked:false,cards:0},
 {name:'goal-user-mcp-auto-legacy-allow',mode:'goal',permission:'auto',legacy:'allow',tool:'mcp_review_lookup',host:{risk:'low',origin:'user-mcp',planSafeActions:[]},input:{query:'review'},blocked:true,cards:0},
 {name:'agent-read-workspace',mode:'agent',permission:'ask',tool:'read',input:{path:join(project,'inside.txt')},blocked:false,cards:0},
 {name:'agent-read-outside-ask',mode:'agent',permission:'ask',tool:'read',input:{path:join(outside,'outside.txt')},blocked:true,cards:1,risk:'low'},
 {name:'agent-read-outside-auto',mode:'agent',permission:'auto',tool:'read',input:{path:join(outside,'outside.txt')},blocked:false,cards:0},
 {name:'agent-read-prefix-sibling',mode:'agent',permission:'ask',tool:'read',input:{path:project+'-sibling/file.txt'},blocked:true,cards:1,risk:'low'},
 {name:'agent-auto-no-ui-at-call',mode:'agent',permission:'auto',tool:'bash',input:{command:'printf review'},hasUI:false,blocked:false,cards:0},
 {name:'agent-ask-no-ui-at-call',mode:'agent',permission:'ask',tool:'bash',input:{command:'printf review'},hasUI:false,blocked:true,cards:0},
];
const envKeys=['OMP_DESKTOP_STATE','OMP_DESKTOP_STATE_REQUIRED','OMP_DESKTOP_GATE_MODE','OMP_DESKTOP_GATE_TOOLS'];const previous=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
const report={desktopCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'registered production gate handlers + real desktop-state serialization/reader + controlled ExtensionAPI/context; gate decisions/card payloads only, no provider/native or plugin body execution claimed',results:[]};
try{
 for(const test of definitions){
  process.env.OMP_DESKTOP_STATE=filename;process.env.OMP_DESKTOP_STATE_REQUIRED='1';process.env.OMP_DESKTOP_GATE_MODE=test.legacy??'ask';delete process.env.OMP_DESKTOP_GATE_TOOLS;
  const snapshot={sessionId:'native-review',mode:test.mode,modeBlock:composeModeSystemPrompt(test.mode,''),permissionMode:test.permission,skills:[],memory:null,hostTools:test.host?[{name:test.tool,...test.host}]:[]};
  writeDesktopCapabilityState(filename,serializeDesktopCapabilityState(snapshot,Date.now()));
  const handlers=new Map(),commands=new Map(),dialogs=[],notices=[];let active=['read','write','edit','bash','glob','grep','ask',...(test.host?[test.tool]:[])];let aborted=false;
  gate({on:(name,fn)=>{handlers.set(name,[...(handlers.get(name)??[]),fn]);},registerCommand:(name,def)=>commands.set(name,def),getActiveTools:()=>[...active],setActiveTools:async names=>{active=[...names];},logger:{warn:()=>{}}});
  const context={cwd:project,hasUI:true,sessionManager:{getSessionId:()=> 'native-review',getCwd:()=>project},abort:()=>{aborted=true;},ui:{notify:(...args)=>notices.push(args),select:async(title,items)=>{dialogs.push({title,descriptor:parseApprovalDescriptor(items[0]?.description)});return OMP_APPROVAL_OPTIONS[2];}}};
  const row={case:test.name,expected:{blocked:test.blocked,cards:test.cards,...(test.risk?{risk:test.risk}:{})}};
  try{
   await commands.get(OMP_TURN_COMMAND)?.handler('a'.repeat(32),context);
   for(const fn of handlers.get('before_agent_start')??[])await fn({systemPrompt:['native prefix'],prompt:'gate review'},context);
   if(aborted)throw new Error('fixture start refused: '+JSON.stringify(notices));
   for(const fn of handlers.get('agent_start')??[])await fn({type:'agent_start'},context);
   const event={type:'tool_call',toolCallId:'review-tool',toolName:test.tool,input:test.input};
   let blocked=false;const outcomes=[];
   for(const fn of handlers.get('tool_call')??[]){const outcome=await fn(event,{...context,hasUI:test.hasUI??true});outcomes.push(outcome??null);if(outcome?.block)blocked=true;}
   row.actual={blocked,cards:dialogs.length,risk:dialogs[0]?.descriptor?.risk,outcomes};
   row.passed=blocked===test.blocked&&dialogs.length===test.cards&&(!test.risk||row.actual.risk===test.risk);
  }catch(error){row.error=String(error.stack??error);row.passed=false;}
  report.results.push(row);
 }
}finally{for(const key of envKeys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}rmSync(root,{recursive:true,force:true});}
report.passed=report.results.every(row=>row.passed);
const path='/Users/vv/Documents/对话/omp-t20-c-review-20261003/gate-policy-extended-'+report.desktopCommit.slice(0,8)+'.json';writeFileSync(path,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({path,passed:report.results.filter(r=>r.passed).length,total:report.results.length,failures:report.results.filter(r=>!r.passed)},null,2));process.exitCode=report.passed?0:1;
