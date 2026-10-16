import {existsSync,readFileSync,readdirSync,lstatSync} from "node:fs";
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
  if(turn)summary.turn={expectedMarker:markers.includes(turn.expectedText)?turn.expectedText:"UNKNOWN",running:turn.last?.status?.isRunning===true,hasSessionError:Boolean(turn.last?.status?.lastError),stopVisible:turn.last?.ui?.stop===true,approvalVisible:Boolean(turn.last?.ui?.permission),documentVisible:turn.visibility?.state==="visible"};
  const tap=find("packaged-plan-goal.tap");if(tap){const text=readFileSync(tap,"utf8");summary.strict=Object.fromEntries(["tests","pass","fail","skipped"].map(key=>[key,Number(new RegExp("^# "+key+" (\\d+)$","m").exec(text)?.[1]??-1)]));summary.failedStrictNumbers=[...text.matchAll(/^\s*not ok (\d+) - /gm)].map(match=>Number(match[1]));}
  result.push(summary);
 }
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{console.log("::notice title=Safe native validation summary::"+JSON.stringify(summarizeValidation(process.argv[2])));}
 catch{console.log("::notice title=Safe native validation summary::VALIDATION_UNAVAILABLE");}
}
