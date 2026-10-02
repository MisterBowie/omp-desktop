import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs';
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
const tests=[
 {name:'agent-write-ask-deny-control',mode:'agent',permission:'ask',tool:'write',decision:'deny',expectedCards:1,effect:false},
 {name:'agent-write-ask-allow-control',mode:'agent',permission:'ask',tool:'write',decision:'allow-once',expectedCards:1,effect:true},
 {name:'agent-write-auto',mode:'agent',permission:'auto',tool:'write',decision:'deny',expectedCards:0,effect:true},
 {name:'agent-write-accept-edits',mode:'agent',permission:'accept-edits',tool:'write',decision:'deny',expectedCards:0,effect:true},
 {name:'plan-bash-ask-deny',mode:'plan',permission:'ask',tool:'bash',decision:'deny',expectedCards:1,effect:false},
 {name:'plan-bash-auto',mode:'plan',permission:'auto',tool:'bash',decision:'deny',expectedCards:0,effect:true},
 {name:'agent-read-outside-ask',mode:'agent',permission:'ask',tool:'read',decision:'deny',expectedCards:1,effect:false},
 {name:'agent-read-outside-auto',mode:'agent',permission:'auto',tool:'read',decision:'deny',expectedCards:0,effect:true},
];
const prepared=await preparePatchedTree({prepareBuild:true,keep:true});
const launcher=join(prepared.tree,'packages/coding-agent/scripts/omp'),gate=findGateExtension(app);
const report={desktopCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'actual fixed patched OMP + production bridge/runner/gate + local FakeProvider; tool bodies and file effects or returned read payload measured; no hidden/unregistered tool negative substituted for gate refusal',results:[]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 for(const test of tests){
  const root=mkdtempSync(join(tmpdir(),'omp-c-native-review-')),project=join(root,'project');mkdirSync(project);
  const sentinel=join(test.tool==='read'?root:project,'sentinel.txt'),secret='ROOT-NATIVE-READ-CONTROL-7c1359b0';
  writeFileSync(sentinel,test.tool==='read'?secret:'untouched\n');
  const data=join(root,'data'),dir=ensureSessionStateDir(data),provider=await FakeProvider.start();
  const args=test.tool==='write'?{path:sentinel,content:'native-effect\n'}:test.tool==='bash'?{command:'printf "native-effect\\n" > sentinel.txt'}:{path:sentinel};
  provider.script([{toolCalls:[{id:'review_native',name:test.tool,args}],finish:'tool_calls'},{text:'policy done',finish:'stop'}]);
  const row={case:test.name,expected:{cards:test.expectedCards,effect:test.effect},cards:[],events:[],ends:[]};
  let bridge,supervisor;
  bridge=createOmpSessionBridge({launcher,isPackaged:false,appPath:app,sessionDir:dir,gateResolver:()=>gate,sessionPolicy:{policy:async()=>({mode:test.mode,permissionMode:test.permission})},
   emitAgentEvent:envelope=>{row.events.push(envelope.event.type);if(envelope.event.type==='tool_permission_request'){
    const request=envelope.event.request;row.cards.push({toolName:request.toolName,risk:request.risk});
    // Wait until the runner finishes registering its pending UI request.
    queueMicrotask(()=>{row.resolution=bridge.resolvePermission(request.requestId,test.decision);});
   }},onTurnEnd:info=>row.ends.push(info),
   createSupervisor:()=>{
    supervisor=new OmpRuntimeSupervisor({dataRoot:data,launcherPath:launcher,expectedRuntimeVersion:'18.3.0',sessionDir:dir,args:['--model','m1fake/local-model','--trusted-extension',gate],prepareRun:paths=>writeModelsConfig(paths.agentDir,{baseUrl:provider.baseUrl,modelId:'local-model'}),readyTimeoutMs:60000});
    supervisor.setWorkingDirectory(project);return supervisor;
   }});
  try{
   row.prompt=await bridge.prompt({sessionId:'native-policy-review',content:'Perform the one scripted native policy check',projectPath:project});
   for(let i=0;i<600&&bridge.status('native-policy-review').state!=='idle';i++)await sleep(50);
   row.finalState=bridge.status('native-policy-review').state;
   const posts=provider.requests.filter(r=>r.method==='POST');row.providerRequests=posts.length;
   row.toolWasAdvertised=posts[0]?.body?.tools?.some(t=>(t.function?.name??t.name)===test.tool)??false;
   const toolMessages=posts.slice(1).flatMap(p=>(p.body?.messages??[]).filter(m=>m.role==='tool'));
   row.toolResults=toolMessages.map(m=>m.content);
   row.effect=test.tool==='read'?JSON.stringify(toolMessages).includes(secret):readFileSync(sentinel,'utf8')==='native-effect\n';
   row.passed=row.prompt.accepted===true&&row.finalState==='idle'&&row.toolWasAdvertised&&row.providerRequests===2&&row.cards.length===test.expectedCards&&row.effect===test.effect&&row.ends.length===1&&row.ends[0].reason==='completed';
  }catch(error){row.error=String(error.stack??error);row.passed=false;}
  finally{
   row.dispose=await bridge.dispose('native policy review complete');row.finalStop=await supervisor.stop();await provider.close();
   if(row.dispose.ok&&row.finalStop.reaped&&row.finalStop.cleaned)rmSync(root,{recursive:true,force:true});else{row.retainedScratch=root;row.passed=false;}
  }
  report.results.push(row);
 }
}finally{prepared.cleanup();}
report.passed=report.results.every(r=>r.passed);
const path='/Users/vv/Documents/对话/omp-t20-c-review-20261003/production-native-policy-'+report.desktopCommit.slice(0,8)+'.json';writeFileSync(path,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({path,passed:report.passed,results:report.results.map(({case:name,expected,cards,effect,passed,error,providerRequests,toolWasAdvertised,dispose,finalStop})=>({name,expected,cards,effect,passed,error,providerRequests,toolWasAdvertised,dispose,finalStop}))},null,2));process.exitCode=report.passed?0:1;
