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
const prepared=await preparePatchedTree({prepareBuild:true,keep:true});
const launcher=join(prepared.tree,'packages/coding-agent/scripts/omp'),gate=findGateExtension(app);
const root=mkdtempSync(join(tmpdir(),'omp-c-grants-review-')),project=join(root,'project');mkdirSync(project);
const effects=join(project,'effects.txt');writeFileSync(effects,'');
const data=join(root,'data'),dir=ensureSessionStateDir(data),provider=await FakeProvider.start();
const report={desktopCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'actual fixed patched OMP and production bridge/gate; one persistent desktop/native identity; actual Bash append effects; PI host-core stores grants by desktop session; its session.configure route does not clear them (host process restart is outside this probe)',phases:[]};
let bridge,supervisor,phase,mode='plan',nativeRef={};const ends=[];
bridge=createOmpSessionBridge({launcher,isPackaged:false,appPath:app,sessionDir:dir,gateResolver:()=>gate,sessionPolicy:{policy:async()=>({mode,permissionMode:'ask'})},persistNativeSession:info=>{nativeRef={nativeSessionId:info.nativeSessionId,nativeSessionPath:info.nativeSessionPath,runtimeVersion:info.runtimeVersion};},
 emitAgentEvent:envelope=>{if(envelope.event.type==='tool_permission_request'){const request=envelope.event.request;phase.cards.push(request.toolName);queueMicrotask(()=>{phase.resolution=bridge.resolvePermission(request.requestId,phase.name==='initial-plan-grant'?'allow-session':'deny');});}},onTurnEnd:info=>ends.push(info),
 createSupervisor:()=>{supervisor=new OmpRuntimeSupervisor({dataRoot:data,launcherPath:launcher,expectedRuntimeVersion:'18.3.0',sessionDir:dir,args:['--model','m1fake/local-model','--trusted-extension',gate],prepareRun:paths=>writeModelsConfig(paths.agentDir,{baseUrl:provider.baseUrl,modelId:'local-model'}),readyTimeoutMs:60000});supervisor.setWorkingDirectory(project);return supervisor;}
});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 for(const name of ['initial-plan-grant','same-plan-grant-control','agent-after-runtime-rebuild']){
  if(name.startsWith('agent'))mode='agent';
  phase={name,cards:[]};const beforeRequests=provider.requests.filter(r=>r.method==='POST').length,beforeEffects=readFileSync(effects,'utf8').length,beforeEnds=ends.length;
  provider.script([{toolCalls:[{id:'review_grant_'+report.phases.length,name:'bash',args:{command:'printf x >> effects.txt'}}],finish:'tool_calls'},{text:'grant phase done',finish:'stop'}]);
  phase.prompt=await bridge.prompt({sessionId:'grant-review',content:name,projectPath:project,...nativeRef});
  for(let i=0;i<600&&bridge.status('grant-review').state!=='idle';i++)await wait(50);
  phase.nativeId=nativeRef.nativeSessionId;phase.state=bridge.status('grant-review').state;phase.providerRequests=provider.requests.filter(r=>r.method==='POST').length-beforeRequests;phase.effects=readFileSync(effects,'utf8').length-beforeEffects;phase.ends=ends.slice(beforeEnds);
  phase.passed=phase.prompt.accepted===true&&phase.state==='idle'&&phase.providerRequests===2&&phase.effects===1&&phase.cards.length===(name==='initial-plan-grant'?1:0)&&phase.ends.length===1&&phase.ends[0].reason==='completed'&&(report.phases.length===0||phase.nativeId===report.phases[0].nativeId);
  report.phases.push(phase);
 }
}catch(error){report.error=String(error.stack??error);}
finally{
 report.dispose=await bridge.dispose('grant review complete');report.finalStop=await supervisor.stop();await provider.close();if(report.dispose.ok&&report.finalStop.reaped&&report.finalStop.cleaned)rmSync(root,{recursive:true,force:true});else report.retainedScratch=root;prepared.cleanup();
}
report.passed=!report.error&&report.phases.length===3&&report.phases.every(p=>p.passed)&&report.dispose.ok&&report.finalStop.reaped&&report.finalStop.cleaned;
const path='/Users/vv/Documents/对话/omp-t20-c-review-20261003/production-session-grant-'+report.desktopCommit.slice(0,8)+'.json';writeFileSync(path,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
