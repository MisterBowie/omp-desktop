import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync,mkdirSync,writeFileSync,rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const repo='/Users/vv/Documents/对话/omp-desktop-review-m5-r4b',app=join(repo,'app');
register(pathToFileURL(join(app,'apps/desktop/test/helpers/ts-import-hooks.mjs')));
const { preparePatchedTree }=await import(pathToFileURL(join(app,'scripts/omp-patch.mjs')));
const { FakeProvider }=await import(pathToFileURL(join(app,'experiments/omp-bridge/lib/provider.mjs')));
const { writeModelsConfig }=await import(pathToFileURL(join(app,'experiments/omp-bridge/lib/models-config.mjs')));
const { OmpRuntimeSupervisor,OmpRuntimeProcess,ensureSessionStateDir,findGateExtension }=await import(pathToFileURL(join(app,'packages/omp-runtime/src/index.ts')));
const { createOmpSessionBridge }=await import(pathToFileURL(join(app,'apps/desktop/electron/main/runtime/omp-session.ts')));
const { turnCommandToken }=await import(pathToFileURL(join(app,'packages/omp-runtime/src/session/turn-fence.ts')));
const prepared=await preparePatchedTree({prepareBuild:true,keep:true});
const launcher=join(prepared.tree,'packages/coding-agent/scripts/omp'),gate=findGateExtension(app);
const report={desktopCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'actual patched OMP + production bridge/runner/gate + local FakeProvider; public runtimeFactory seam only invokes user stop immediately after real command discovery is submitted; no RPC frames or responses delayed/forged/reordered',results:[]};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
try{
 for(const strategy of ['control','stop-on-command-discovery']){
  const root=mkdtempSync(join(tmpdir(),'omp-b1-fence-stop-review-')),project=join(root,'project');mkdirSync(project);
  const data=join(root,'data'),dir=ensureSessionStateDir(data);
  const provider=await FakeProvider.start();provider.script([{text:'ACTUAL-PROVIDER-TURN',finish:'stop'}]);
  const row={strategy,rpc:[],events:[],ends:[]};
  let bridge,supervisor,stopTask,triggered=false;
  bridge=createOmpSessionBridge({launcher,isPackaged:false,appPath:app,sessionDir:dir,gateResolver:()=>gate,
   sessionPolicy:{policy:async()=>({mode:'plan',permissionMode:'ask'})},
   emitAgentEvent:e=>row.events.push(e.event.type),onTurnEnd:e=>row.ends.push(e),
   createSupervisor:()=>{
    supervisor=new OmpRuntimeSupervisor({dataRoot:data,launcherPath:launcher,expectedRuntimeVersion:'18.3.0',sessionDir:dir,args:['--model','m1fake/local-model','--trusted-extension',gate],prepareRun:paths=>writeModelsConfig(paths.agentDir,{baseUrl:provider.baseUrl,modelId:'local-model'}),readyTimeoutMs:60000,
     runtimeFactory:async options=>{
      const actual=await OmpRuntimeProcess.start(options);
      return new Proxy(actual,{get(target,key){
       if(key==='request')return(command,requestOptions)=>{
        row.rpc.push({type:command.type,...(command.type==='prompt'?{control:!!turnCommandToken(command.message),message:turnCommandToken(command.message)?'[turn binding]':command.message}:{})});
        const result=target.request(command,requestOptions);
        if(strategy==='stop-on-command-discovery'&&!triggered&&command.type==='get_available_commands'){
         triggered=true;row.providerAtStopRequest=provider.requests.filter(r=>r.method==='POST').length;
         stopTask=bridge.stop('fence-stop-review');
         row.stateAtStopRequest=bridge.status('fence-stop-review').state;
        }
        return result;
       };
       const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
     }});
    supervisor.setWorkingDirectory(project);return supervisor;
   }});
  try{
   try{row.prompt=await bridge.prompt({sessionId:'fence-stop-review',content:'user prompt cancelled before the fence completed',projectPath:project});}
   catch(error){row.prompt={error:String(error.message)};}
   if(stopTask)row.stop=await stopTask;
   for(let i=0;i<100&&bridge.status('fence-stop-review').state!=='idle';i++)await wait(50);
   row.providerRequests=provider.requests.filter(r=>r.method==='POST').length;
   row.finalState=bridge.status('fence-stop-review').state;
   row.passed=strategy==='control'?row.providerRequests===1&&row.finalState==='idle':triggered&&row.providerAtStopRequest===0&&row.providerRequests===0&&row.finalState==='idle'&&!!row.prompt.error;
  }catch(error){row.probeError=String(error.message);row.passed=false;}
  finally{
   row.dispose=await bridge.dispose('fence stop review complete');
   row.finalStop=await supervisor.stop();
   await provider.close();
   if(row.dispose.ok&&row.finalStop.reaped&&row.finalStop.cleaned)rmSync(root,{recursive:true,force:true});else row.retainedScratch=root;
  }
  report.results.push(row);
 }
}finally{prepared.cleanup();}
report.passed=report.results.every(row=>row.passed);
writeFileSync('/Users/vv/Documents/对话/omp-t20-b1-review-20261002/production-fence-stop-race-'+report.desktopCommit.slice(0,8)+'.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
process.exitCode=report.passed?0:1;
