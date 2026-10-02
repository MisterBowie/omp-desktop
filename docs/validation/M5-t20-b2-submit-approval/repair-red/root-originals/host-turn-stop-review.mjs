// Independent B2 review: production bridge/lifecycle + real Rust host SQLite + patched OMP.
// The public hostTurns.begin seam invokes and awaits real user Stop just before delivering
// the real durable id. This is a controlled async-boundary test, not a native transport timing claim.
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,realpathSync,rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const repo='/Users/vv/Documents/对话/omp-desktop-review-m5-r4b',app=join(repo,'app');
register(pathToFileURL(join(app,'apps/desktop/test/helpers/ts-import-hooks.mjs')));
const {preparePatchedTree}=await import(pathToFileURL(join(app,'scripts/omp-patch.mjs')));
const {FakeProvider}=await import(pathToFileURL(join(app,'experiments/omp-bridge/lib/provider.mjs')));
const {writeModelsConfig}=await import(pathToFileURL(join(app,'experiments/omp-bridge/lib/models-config.mjs')));
const {OmpRuntimeSupervisor,ensureSessionStateDir,findGateExtension}=await import(pathToFileURL(join(app,'packages/omp-runtime/src/index.ts')));
const {createOmpSessionBridge}=await import(pathToFileURL(join(app,'apps/desktop/electron/main/runtime/omp-session.ts')));
const {createOmpHostTurnLifecycle}=await import(pathToFileURL(join(app,'apps/desktop/electron/main/runtime/omp-session-wiring.ts')));
const {HostProcess}=await import(pathToFileURL(join(app,'packages/host-runtime/dist/host-process.js')));
const {PROTOCOL_VERSION}=await import(pathToFileURL(join(app,'packages/shared/dist/protocol.js')));
const binary=join(app,'target/release/pi-desktop-host-core');
const report={candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),hostSha256:createHash('sha256').update(readFileSync(binary)).digest('hex'),layer:'production bridge/production host-turn lifecycle/actual HostProcess SQLite/patched OMP/local FakeProvider; controlled public lifecycle seam delivers a real begin id after real Stop completes; not an unmodified transport-timing proof',cases:[]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(fn){for(let i=0;i<600;i++){if(fn())return;await delay(25);}throw Error('review wait expired');}
let prepared;
try{
 prepared=await preparePatchedTree({prepareBuild:true,keep:true});
 const launcher=join(prepared.tree,'packages/coding-agent/scripts/omp'),gate=findGateExtension(app);assert.ok(gate);
 for(const strategy of ['control','stop-before-begin-id-delivery']){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'omp-b2-host-stop-'))),project=join(root,'project'),hostData=join(root,'host'),data=join(root,'runtime');
  mkdirSync(project);mkdirSync(hostData);const dir=ensureSessionStateDir(data);
  const row={strategy,ends:[],begins:[],durableEnds:[],hostExited:false};report.cases.push(row);
  const host=new HostProcess({binaryPath:binary,dataDir:hostData,onStderr:()=>{}});host.onExit(()=>{row.hostExited=true;});
  const provider=await FakeProvider.start();provider.script([{text:'REAL-INITIAL-PROVIDER-RESPONSE',finish:'stop'}]);
  let bridge,supervisor,db,nativeRef={},triggered=false;
  try{
   await host.call('app.handshake',{protocolVersion:PROTOCOL_VERSION});
   const session=(await host.call('session.create',{engine:'omp',mode:'agent',title:strategy,projectPath:project})).session;
   const dbPath=join(hostData,readdirSync(hostData).find(n=>n.endsWith('.sqlite')));db=new DatabaseSync(dbPath,{readOnly:true});
   const rows=()=>db.prepare('SELECT id,status FROM turns WHERE session_id=? ORDER BY rowid').all(session.id).map(r=>({...r}));
   const lifecycle=createOmpHostTurnLifecycle(()=>host);
   bridge=createOmpSessionBridge({launcher,isPackaged:false,appPath:app,sessionDir:dir,gateResolver:()=>gate,
    sessionPolicy:{policy:async()=>({mode:'agent',permissionMode:'ask'})},
    hostTurns:{
     begin:async input=>{
      const id=await lifecycle.begin(input);row.begins.push(id);
      if(strategy!=='control'&&!triggered){
       triggered=true;row.providerAtStop=provider.requests.filter(r=>r.method==='POST').length;
       row.rowsAtStop=rows();row.nativeAtStop=nativeRef.nativeSessionId;
       row.stop=await bridge.stop(session.id);
       row.rowsAfterStopBeforeIdDelivery=rows();
      }
      return id;
     },
     end:async input=>{row.durableEnds.push({...input});return lifecycle.end(input);},
    },
    persistNativeSession:info=>{nativeRef={nativeSessionId:info.nativeSessionId,nativeSessionPath:info.nativeSessionPath,runtimeVersion:info.runtimeVersion};},
    emitAgentEvent:()=>{},onTurnEnd:info=>row.ends.push(info),
    createSupervisor:()=>{
     supervisor=new OmpRuntimeSupervisor({dataRoot:data,launcherPath:launcher,expectedRuntimeVersion:'18.3.0',sessionDir:dir,args:['--model','m1fake/local-model','--trusted-extension',gate],prepareRun:paths=>writeModelsConfig(paths.agentDir,{baseUrl:provider.baseUrl,modelId:'local-model'}),readyTimeoutMs:60000});
     supervisor.setWorkingDirectory(project);return supervisor;
    },
   });
   try{row.prompt=await bridge.prompt({sessionId:session.id,content:'initial '+strategy,projectPath:project});}
   catch(error){row.prompt={refused:true,errorCode:error.errorCode??error.code??null,message:error.message};}
   await waitFor(()=>bridge.status(session.id).state==='idle'&&rows().every(r=>r.status!=='running'));
   row.initialProviderRequests=provider.requests.filter(r=>r.method==='POST').length;
   row.initialRows=rows();row.initialEnds=structuredClone(row.ends);row.initialDurableEnds=structuredClone(row.durableEnds);
   if(strategy==='control'){
    assert.equal(row.initialProviderRequests,1);assert.equal(row.prompt.accepted,true);
    assert.equal(row.initialRows.length,1);assert.equal(row.initialRows[0].status,'completed');
    assert.equal(row.prompt.hostTurnId,row.initialRows[0].id);assert.notEqual(row.prompt.turnId,row.prompt.hostTurnId);
   }else{
    // Observe recovery even if the cancellation is RED, so one failure does not hide a stale row.
    const before=row.initialProviderRequests;provider.script([{text:'REAL-RECOVERY-PROVIDER-RESPONSE',finish:'stop'}]);
    row.recovery={};
    try{row.recovery.prompt=await bridge.prompt({sessionId:session.id,content:'genuine recovery after Stop',projectPath:project,...nativeRef});}
    catch(error){row.recovery.error=error.message;}
    await waitFor(()=>bridge.status(session.id).state==='idle'&&rows().every(r=>r.status!=='running'));
    row.recovery.providerRequests=provider.requests.filter(r=>r.method==='POST').length-before;
    row.recovery.rows=rows();row.recovery.sameNativeId=nativeRef.nativeSessionId===row.nativeAtStop;
    assert.equal(row.providerAtStop,0);assert.equal(row.initialProviderRequests,0,'Stop during begin must cancel the pending prompt');
    assert.equal(row.prompt.refused,true);assert.equal(row.initialRows.length,1);assert.equal(row.initialRows[0].status,'aborted');
    assert.equal(row.recovery.prompt?.accepted,true);assert.equal(row.recovery.providerRequests,1);assert.equal(row.recovery.sameNativeId,true);
    assert.equal(row.recovery.rows.length,2);assert.equal(row.recovery.rows[1].status,'completed');
   }
   assert.equal(row.initialDurableEnds.length,1);
   row.messageCount=db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(session.id).count;assert.equal(row.messageCount,0);
   row.passed=true;
  }catch(error){row.passed=false;row.error=String(error.stack??error);}
  finally{
   if(bridge)row.dispose=await bridge.dispose('independent B2 host-turn Stop review complete');
   if(supervisor)row.runtimeStop=await supervisor.stop();
   if(db)db.close();await host.dispose();await provider.close();
   if(row.hostExited&&(!bridge||row.dispose?.ok)&&(!supervisor||(row.runtimeStop?.reaped&&row.runtimeStop?.cleaned))){rmSync(root,{recursive:true,force:true});row.scratchRemoved=true;}else row.retainedScratch=root;
  }
 }
}catch(error){report.error=String(error.stack??error);}
finally{prepared?.cleanup();}
report.passed=!report.error&&report.cases.length===2&&report.cases.every(r=>r.passed&&r.scratchRemoved);
writeFileSync(join('/Users/vv/Documents/对话/omp-t20-b2-review-20261003','host-turn-stop-'+report.candidate.slice(0,8)+'.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
