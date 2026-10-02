import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync,mkdirSync,readFileSync,realpathSync,writeFileSync,rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const repo='/Users/vv/Documents/对话/omp-desktop-review-m5-r4b',app=join(repo,'app');
register(pathToFileURL(join(app,'apps/desktop/test/helpers/ts-import-hooks.mjs')));
const { preparePatchedTree }=await import(pathToFileURL(join(app,'scripts/omp-patch.mjs')));
const { FakeProvider }=await import(pathToFileURL(join(app,'experiments/omp-bridge/lib/provider.mjs')));
const { writeModelsConfig }=await import(pathToFileURL(join(app,'experiments/omp-bridge/lib/models-config.mjs')));
const { OmpRuntimeSupervisor,ensureSessionStateDir,findGateExtension }=await import(pathToFileURL(join(app,'packages/omp-runtime/src/index.ts')));
const { createOmpSessionBridge }=await import(pathToFileURL(join(app,'apps/desktop/electron/main/runtime/omp-session.ts')));
const prepared=await preparePatchedTree({prepareBuild:true,keep:true});
const launcher=join(prepared.tree,'packages/coding-agent/scripts/omp'),gate=findGateExtension(app);
const quote=value=>"'"+value.replaceAll("'","'\\''")+"'";
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const report={desktopCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'actual production bridge/gate + fixed patched OMP + local FakeProvider; the first genuine native Bash is approved once through the production UI decision path; it changes only the owned disposable state file permissionMode, without changing desktop policy; the next native Bash in the SAME admitted Plan/ask prompt must still require approval or fail closed',results:[]};
try{
 for(const mutate of [false,true]){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'omp-c-turn-policy-'))),project=join(root,'project');mkdirSync(project);
  const sentinel=join(project,'sentinel.txt');writeFileSync(sentinel,'untouched\n');
  const data=join(root,'data'),dir=ensureSessionStateDir(data),provider=await FakeProvider.start();
  const marker=mutate?'review-owned-policy-mutated':'review-control-approved';
  const script=mutate?'const fs=require("node:fs");const p=process.env.OMP_DESKTOP_STATE;if(!p)throw Error("missing owned state env");const s=JSON.parse(fs.readFileSync(p,"utf8"));if(s.mode!=="plan"||s.permissionMode!=="ask")throw Error("unexpected initial policy");s.permissionMode="auto";fs.writeFileSync(p,JSON.stringify(s));console.log("'+marker+'");':'console.log("'+marker+'")';
  provider.script([
   {toolCalls:[{id:'review_first',name:'bash',args:{command:quote(process.execPath)+' -e '+quote(script)}}],finish:'tool_calls'},
   {toolCalls:[{id:'review_second',name:'bash',args:{command:'printf "unauthorized-effect\\n" > sentinel.txt'}}],finish:'tool_calls'},
   {text:'turn policy done',finish:'stop'},
  ]);
  const row={case:mutate?'same-turn-owned-policy-mutated':'same-turn-unchanged-control',cards:[],ends:[],hostPolicy:{mode:'plan',permissionMode:'ask'}};
  let bridge,supervisor;
  bridge=createOmpSessionBridge({launcher,isPackaged:false,appPath:app,sessionDir:dir,gateResolver:()=>gate,sessionPolicy:{policy:async()=>({...row.hostPolicy})},
   emitAgentEvent:envelope=>{if(envelope.event.type==='tool_permission_request'){const request=envelope.event.request;const decision=row.cards.length===0?'allow-once':'deny';row.cards.push({toolName:request.toolName,risk:request.risk,decision});queueMicrotask(()=>bridge.resolvePermission(request.requestId,decision));}},onTurnEnd:info=>row.ends.push(info),
   createSupervisor:()=>{supervisor=new OmpRuntimeSupervisor({dataRoot:data,launcherPath:launcher,expectedRuntimeVersion:'18.3.0',sessionDir:dir,args:['--model','m1fake/local-model','--trusted-extension',gate],prepareRun:paths=>writeModelsConfig(paths.agentDir,{baseUrl:provider.baseUrl,modelId:'local-model'}),readyTimeoutMs:60000});supervisor.setWorkingDirectory(project);return supervisor;}
  });
  try{
   row.prompt=await bridge.prompt({sessionId:'turn-policy-review',content:row.case,projectPath:project});
   for(let i=0;i<600&&bridge.status('turn-policy-review').state!=='idle';i++)await wait(50);
   row.finalState=bridge.status('turn-policy-review').state;const posts=provider.requests.filter(r=>r.method==='POST');row.providerRequests=posts.length;
   row.bashAdvertised=posts[0]?.body?.tools?.some(t=>(t.function?.name??t.name)==='bash')??false;
   row.toolResults=posts.at(-1)?.body?.messages?.filter(m=>m.role==='tool').map(m=>({id:m.tool_call_id,content:m.content}))??[];
   row.firstBodyExecuted=row.toolResults.some(r=>r.id==='review_first'&&JSON.stringify(r.content).includes(marker));
   row.effect=readFileSync(sentinel,'utf8')!=='untouched\n';
   row.passed=row.prompt.accepted===true&&row.bashAdvertised&&row.providerRequests===3&&row.firstBodyExecuted&&!row.effect&&row.cards.length===2&&row.finalState==='idle'&&row.ends.length===1&&row.ends[0].reason==='completed';
  }catch(error){row.error=String(error.stack??error);row.passed=false;}
  finally{row.dispose=await bridge.dispose('turn policy review complete');row.finalStop=await supervisor.stop();await provider.close();if(row.dispose.ok&&row.finalStop.reaped&&row.finalStop.cleaned)rmSync(root,{recursive:true,force:true});else{row.retainedScratch=root;row.passed=false;}}
  report.results.push(row);
 }
}finally{prepared.cleanup();}
report.passed=report.results.length===2&&report.results.every(r=>r.passed);
const path='/Users/vv/Documents/对话/omp-t20-c-review-20261003/production-turn-policy-'+report.desktopCommit.slice(0,8)+'.json';writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
