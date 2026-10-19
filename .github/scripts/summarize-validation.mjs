import {readFileSync,readdirSync,lstatSync} from "node:fs";
import {join,basename,resolve} from "node:path";
import {pathToFileURL} from "node:url";

const stages=["spawn","Main inspector connected","installed Main identity verified","owned renderer connected","ready","installed deny","installed allow once","installed project test","installed process stop","restart same installed payload/profile"];
const steps=["project","deny","allowOnce","projectTest","stopTree","recoveryNoReplay","freshTurn","defaultIsolation"];
const markers=["INSTALLED_DENIED_DONE","INSTALLED_ALLOWED_DONE","INSTALLED_TEST_DONE","INSTALLED_RESTART_DONE"];
const errors=[
 ["ASSERTION",/AssertionError|ERR_ASSERTION/], ["TIMEOUT",/Timed out|timeout/i],
 ["SEND_TIMEOUT",/Composer Send enabled/], ["APPROVAL_TIMEOUT",/real write approval|second real write approval|fresh bash permission|long tool permission/],
 ["TURN_TIMEOUT",/turn completed/], ["PROCESS_TREE_TIMEOUT",/actual external child and grandchild|real tool child tree reaped/],
 ["MAIN_TIMEOUT",/owned Main inspector|product initialization/], ["RENDERER_TIMEOUT",/renderer belonging|actual installed renderer ready|new installed renderer document|reloaded composer/],
 ["VISIBLE_WINDOW_TIMEOUT",/owned installed window visible|visible owned window/],
 ["HISTORY_MISMATCH",/native transcript|native record|history projection|replayed/],
 ["OWNERSHIP_FAILURE",/owned process|observed as owned|ownership/], ["MISSING_FILE",/ENOENT/],
 ["CONNECTION_CLOSED",/ECONNRESET|ECONNREFUSED|WebSocket.*closed|socket.*closed/i],
];
const diagnosticCodes=["OMP_RESTORE_FAILED","OMP_CAPABILITY_STATE_FAILED","OMP_HOST_TURN_FAILED","OMP_SESSION_CREATE_FAILED","OMP_HOST_TOOL_REGISTRATION_FAILED","OMP_HISTORY_READ_FAILED","NOT_STARTED","ERR_ASSERTION"];
const sourceFiles=["omp-session.ts","session.ts","protocol.ts","supervisor.ts","process.ts","installed-product.mjs","installed-application.mjs","installed-payload.mjs","installed-workflow.mjs","e2e-installed-smoke.mjs"];
const publicImages=["omp desktop.exe","pi-desktop-host-core.exe","omp.exe","conhost.exe","python.exe","cmd.exe","powershell.exe","node.exe","werfault.exe","wermgr.exe","msmpeng.exe","mpcmdrun.exe","svchost.exe","rundll32.exe","dllhost.exe"];
/** Only fixed process roles and bounded control outcomes leave the runner. */
export function summarizeProcessCleanup(smoke){
 const reports=Array.isArray(smoke?.processReports)?smoke.processReports:[];
 const normalize=value=>String(value??"").replaceAll("\\","/").toLowerCase();
 const root=normalize(smoke?.runRoot).replace(/\/$/,"");
 const snapshots=reports.filter(r=>["before-ordered-quit","wait-exit","cleanup-before","after-Windows-handle-reclaim"].includes(r.label)&&Array.isArray(r.processes));
 const last=snapshots.at(-1);
 const processes=(last?.processes??[]).slice(0,32).map(p=>{
  const exe=normalize(p.exe),image=exe.split("/").at(-1);
  const first=reports.find(r=>Array.isArray(r.processes)&&r.processes.some(x=>x.pid===p.pid&&x.starttime===p.starttime));
  const original=first?.processes.find(x=>x.pid===p.pid&&x.starttime===p.starttime),parent=first?.processes.find(x=>x.pid===original?.ppid);
  const knownBirth=value=>typeof value==="string"&&/^\d+$/.test(value);
  const childPredatesParent=knownBirth(original?.starttime)&&knownBirth(parent?.starttime)?BigInt(original.starttime)<BigInt(parent.starttime):null;
  return {image:publicImages.includes(image)?image:"OTHER",state:["R","Z","X"].includes(p.state)?p.state:"UNKNOWN",hasIdentity:typeof p.starttime==="string"&&/^\d+(?:\.\d+)?$/.test(p.starttime),executableUnderRunRoot:root.length>=10&&exe.startsWith(root+"/"),firstOwnership:["root","descendant","argv-run-root","environ-run-root"].includes(original?.ownership)?original.ownership:"UNKNOWN",parentObserved:Boolean(parent),childPredatesParent};
 });
 const controls=reports.filter(r=>r.label==="cleanup-pinned-Windows-handles").slice(-3).map(r=>(Array.isArray(r.result?.results)?r.result.results:[]).slice(0,32).map(p=>({terminated:p.terminated===true,refusedOutsideRoot:p.refusedOutsideRoot===true,identityMismatch:p.identityMismatch===true,openError:[5,6,87].includes(p.openError)?p.openError:null,waitStatus:[0,258,4294967295].includes(p.waitStatus)?p.waitStatus:null})));
 return {lastSnapshot:last?.label??"NONE",survivorCount:last?.processes?.length??0,processes,controls};
}
function coordinates(text){return sourceFiles.flatMap(file=>[...text.matchAll(new RegExp("(?:[/\\\\]|^)"+file.replaceAll(".","\\.")+":(\\d+):(\\d+)","g"))].map(match=>({file,line:Number(match[1]),column:Number(match[2])})));}
/** TAP diagnostics are untrusted: return only source coordinates and enums. */
export function summarizeStrictFailures(text){
 const failures=[];
 for(const match of text.matchAll(/^not ok (\d+) - [^\n]*\n([\s\S]*?)(?=^(?:# Subtest:|(?:not )?ok \d+ - |1\.\.)|$(?![\s\S]))/gm)){
  const block=match[2],result={number:Number(match[1])};
  result.approvalInTimeline=/timeline:[^\n]*tool_permission_request/.test(block);result.noReportedErrors=/errors: \[\]/.test(block);
  result.source=coordinates(block);result.diagnosticCodes=diagnosticCodes.filter(code=>block.includes(code));
  const allowed={failureType:["testCodeFailure","testTimeoutFailure","cancelledByParent"],code:["ERR_ASSERTION","SQLITE_ERROR","ERR_SQLITE_ERROR","ENOENT","ETIMEDOUT"],operator:["strictEqual","deepStrictEqual","equal","ok","match","rejects"]};
  for(const [key,values] of Object.entries(allowed)){const value=new RegExp("^\\s+"+key+": ['\"]?([^'\"\\r\\n]+)","m").exec(block)?.[1];if(values.includes(value))result[key]=value;}
  result.lines=[...block.matchAll(/omp-plan-submit-e2e\.test\.mjs:(\d+):(\d+)/g)].map(item=>({line:Number(item[1]),column:Number(item[2])}));
  for(const key of ["expected","actual"]){const value=new RegExp("^\\s+"+key+": (.+)$","m").exec(block)?.[1];if(/^(?:true|false|null|-?\d+(?:\.\d+)?)$/.test(value??""))result[key]=JSON.parse(value);else if(["'running'","'completed'","'aborted'","'interrupted'"].includes(value))result[key]=value.slice(1,-1);}
  failures.push(result);
 }
 return failures;
}
export function summarizeValidation(directory){
 const files=[];
 function visit(dir){for(const name of readdirSync(dir)){const path=join(dir,name),stat=lstatSync(path);if(stat.isSymbolicLink())continue;if(stat.isDirectory())visit(path);else if(stat.isFile())files.push(path);}}
 visit(directory);
 const result=[];
 for(const target of ["darwin-arm64","darwin-x64","win32-x64","linux-x64"]){
  const owned=files.filter(path=>path.replaceAll("\\","/").includes("/validation-"+target+"/"));
  if(!owned.length)continue;
  const find=name=>owned.find(path=>basename(path)===name);
  const json=name=>{try{return JSON.parse(readFileSync(find(name),"utf8"));}catch{return null;}};
  const runtime=json("packaged-runtime.json"),smoke=json("installed-smoke.json"),facts=json("workflow-facts.json"),progress=json("progress.json"),turn=json("turn-timeout.json");
  const failure=String(smoke?.failure??"")+"\n"+String(smoke?.cleanupFailure??"");
  const summary={target,runtimeReportValid:Boolean(runtime),runtimeGetState:runtime?.run?.getState===true,smokeReportExists:Boolean(smoke),cleaned:smoke?.cleaned===true,orderedQuit:smoke?.bootAndOrderedQuit===true,completedChecks:facts?.checks?.length??0,steps:Object.fromEntries(steps.map(key=>[key,facts?.steps?.[key]===true])),progress:stages.includes(progress?.label)?progress.label:"UNKNOWN",errorClasses:errors.filter(([,pattern])=>pattern.test(failure)).map(([code])=>code),normalQuits:smoke?.processReports?.filter(item=>item.label==="ordered-quit"&&item.noOwnedProcessesRemain===true).length??0};
  summary.failureSource=coordinates(failure);summary.diagnosticCodes=diagnosticCodes.filter(code=>failure.includes(code));
  if(target==="win32-x64"&&smoke)summary.processCleanup=summarizeProcessCleanup(smoke);
  if(turn)summary.turn={expectedMarker:markers.includes(turn.expectedText)?turn.expectedText:"UNKNOWN",running:turn.last?.status?.isRunning===true,hasSessionError:Boolean(turn.last?.status?.lastError),stopVisible:turn.last?.ui?.stop===true,approvalVisible:Boolean(turn.last?.ui?.permission),documentVisible:turn.visibility?.state==="visible"};
  const tap=find("packaged-plan-goal.tap");if(tap){const text=readFileSync(tap,"utf8");summary.strict=Object.fromEntries(["tests","pass","fail","skipped"].map(key=>[key,Number(new RegExp("^# "+key+" (\\d+)$","m").exec(text)?.[1]??-1)]));summary.failedStrictNumbers=[...text.matchAll(/^\s*not ok (\d+) - /gm)].map(match=>Number(match[1]));summary.strictFailures=summarizeStrictFailures(text);}
  result.push(summary);
 }
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log("::notice title=Safe native validation summary::"+JSON.stringify(summarizeValidation(process.argv[2])));}
 catch{console.log("::notice title=Safe native validation summary::VALIDATION_UNAVAILABLE");}
}
