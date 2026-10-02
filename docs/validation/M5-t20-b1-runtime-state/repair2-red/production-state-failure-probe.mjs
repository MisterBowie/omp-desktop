import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const repo = '/Users/vv/Documents/对话/omp-desktop-review-m5-r4b';
const app = join(repo, 'app');
register(pathToFileURL(join(app, 'apps/desktop/test/helpers/ts-import-hooks.mjs')));
const { preparePatchedTree } = await import(pathToFileURL(join(app, 'scripts/omp-patch.mjs')));
const { FakeProvider } = await import(pathToFileURL(join(app, 'experiments/omp-bridge/lib/provider.mjs')));
const { writeModelsConfig } = await import(pathToFileURL(join(app, 'experiments/omp-bridge/lib/models-config.mjs')));
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension } = await import(pathToFileURL(join(app, 'packages/omp-runtime/src/index.ts')));
const { createOmpSessionBridge } = await import(pathToFileURL(join(app, 'apps/desktop/electron/main/runtime/omp-session.ts')));
const { createOmpHostToolAdapter } = await import(pathToFileURL(join(app, 'apps/desktop/electron/main/runtime/omp-host-tools.ts')));
const desktopState = await import(pathToFileURL(join(app, 'packages/omp-runtime/src/desktop-state.ts')));
const desktopCommit = execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
const prepared = await preparePatchedTree({prepareBuild: true, keep: true});
const launcher = join(prepared.tree, 'packages/coding-agent/scripts/omp');
const gate = findGateExtension(app);
const results = [];
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
try {
  for (const strategy of ['control', 'delete', 'malformed', 'owned-invalid', 'delete-channel-files']) {
    const root = mkdtempSync(join(tmpdir(), 'omp-b1-review-failure-'));
    const project = join(root, 'project');
    mkdirSync(project);
    const data = join(root, 'data');
    const mutations = join(root, 'mutations.jsonl');
    const disableMutation = join(root, 'disable-mutation');
    const mutator = join(root, 'mutator.ts');
    writeFileSync(mutator, `import {readFileSync,writeFileSync,appendFileSync,unlinkSync,existsSync} from 'node:fs';
import {dirname,join} from 'node:path';
export default function(api) { api.on('before_agent_start',(event,ctx) => {
 if (existsSync(${JSON.stringify(disableMutation)})) return;
 const path=process.env.OMP_DESKTOP_STATE;
 if (!path) throw new Error('expected production desktop state');
 const state=JSON.parse(readFileSync(path,'utf8'));
 const sessionId=ctx.sessionManager.getSessionId();
 appendFileSync(${JSON.stringify(mutations)}, JSON.stringify({strategy:${JSON.stringify(strategy)},mode:state.mode,owner:state.sessionId,firing:sessionId})+'\\n');
 if (sessionId!==state.sessionId) return;
 ${strategy === 'delete' ? 'unlinkSync(path);' : strategy === 'malformed' ? "writeFileSync(path,'{');" : strategy === 'owned-invalid' ? "state.mode='invalid-mode'; writeFileSync(path,JSON.stringify(state));" : strategy === 'delete-channel-files' ? "unlinkSync(path); const marker=join(dirname(path),'desktop-state.required'); if (existsSync(marker)) unlinkSync(marker);" : ''}
 }); }
`);
    const provider = await FakeProvider.start();
    provider.script([{text: 'REVIEW-PROVIDER-REQUEST', finish: 'stop'}]);
    const dir = ensureSessionStateDir(data);
    let supervisor;
    const events = [];
    const ends = [];
    let nativeRef = {};
    const bridge = createOmpSessionBridge({
      launcher, isPackaged:false, appPath:app, sessionDir:dir,
      gateResolver:()=>gate,
      sessionPolicy:{policy:async()=>({mode:'plan',permissionMode:'ask'})},
      persistNativeSession: info => {nativeRef = {nativeSessionId:info.nativeSessionId,nativeSessionPath:info.nativeSessionPath,runtimeVersion:info.runtimeVersion};},
      emitAgentEvent:e=>events.push(e), onTurnEnd:e=>ends.push(e),
      createSupervisor:()=> {
        supervisor = new OmpRuntimeSupervisor({
          dataRoot:data, launcherPath:launcher, expectedRuntimeVersion:'18.3.0',sessionDir:dir,
          args:['--model','m1fake/local-model','--trusted-extension',mutator,'--trusted-extension',gate],
          prepareRun:paths=>writeModelsConfig(paths.agentDir,{baseUrl:provider.baseUrl,modelId:'local-model'}),
          readyTimeoutMs:60000
        });
        supervisor.setWorkingDirectory(project);
        return supervisor;
      }
    });
    const row = {strategy};
    try {
      try {row.prompt = await bridge.prompt({sessionId:'review-failure',content:'state failure review',projectPath:project});}
      catch(error) {row.prompt={error:String(error.message)};}
      await wait(1500);
      row.providerRequests = provider.requests.filter(r=>r.method==='POST').length;
      row.eventTypes = events.map(e=>e.event.type);
      row.turnEnds = [...ends];
      row.diagnostics = bridge.diagnostics();
      row.mutations = existsSync(mutations) ? readFileSync(mutations,'utf8').trim().split('\n').map(JSON.parse) : [];
      writeFileSync(disableMutation,'1');
      const retryRequestsBefore = provider.requests.filter(r=>r.method==='POST').length;
      try {row.retry = await bridge.prompt({sessionId:'review-failure',content:'retry state failure review',projectPath:project,...nativeRef});}
      catch(error) {row.retry={error:String(error.message)};}
      await wait(1500);
      row.retryProviderRequests = provider.requests.filter(r=>r.method==='POST').length-retryRequestsBefore;
      row.retryState = bridge.status('review-failure').state;
    } finally {
      try {row.disposeResult=await bridge.dispose('review failure probe complete'); row.bridgeDisposed=row.disposeResult.ok;}
      catch(error) {row.bridgeDisposed=false;row.cleanupError=String(error.message);}
      if (supervisor) {
        try {row.finalStop=await supervisor.stop();}
        catch(error) {row.stopError=String(error.message);}
      }
      await provider.close();
      if (row.bridgeDisposed && !row.stopError) rmSync(root,{recursive:true,force:true});
      else row.retainedScratch=root;
    }
    results.push(row);
  }
  {
    const root = mkdtempSync(join(tmpdir(), 'omp-b1-review-catalog-'));
    const project = join(root, 'project'); mkdirSync(project);
    const data=join(root,'data'), dir=ensureSessionStateDir(data);
    const provider=await FakeProvider.start();
    let mode='agent', tools=[], supervisor, nativeRef={};
    const plugins={getTools:()=>tools,getSkills:()=>[],listLoaded:()=>[]};
    const hostTools=createOmpHostToolAdapter({plugins,userMcp:{toolsForProject:async()=>[]},pluginActiveInProject:()=>true});
    const events=[], ends=[];
    const bridge=createOmpSessionBridge({
      launcher,isPackaged:false,appPath:app,sessionDir:dir,gateResolver:()=>gate,hostTools,
      sessionPolicy:{policy:async()=>({mode,permissionMode:'ask'})},
      persistNativeSession:info=>{nativeRef={nativeSessionId:info.nativeSessionId,nativeSessionPath:info.nativeSessionPath,runtimeVersion:info.runtimeVersion};},
      emitAgentEvent:e=>events.push(e),onTurnEnd:e=>ends.push(e),
      createSupervisor:()=>{
        supervisor=new OmpRuntimeSupervisor({dataRoot:data,launcherPath:launcher,expectedRuntimeVersion:'18.3.0',sessionDir:dir,args:['--model','m1fake/local-model','--trusted-extension',gate],prepareRun:paths=>writeModelsConfig(paths.agentDir,{baseUrl:provider.baseUrl,modelId:'local-model'}),readyTimeoutMs:60000});
        supervisor.setWorkingDirectory(project);return supervisor;
      }
    });
    const row={strategy:'new-unsafe-plugin-during-plan',phases:[]};
    const tool={pluginId:'demo',fullName:'plugin_demo_new_unsafe',name:'new_unsafe',description:'new unsafe plugin',schema:{type:'object',properties:{}},risk:'high',planSafeActions:[],execute:async()=> 'should not execute in this catalogue probe'};
    try {
      for(const phase of ['agent-baseline','plan-baseline','plan-add-plugin','agent-same-catalog']) {
        mode=phase.startsWith('agent')?'agent':'plan';
        if(phase==='plan-add-plugin') tools=[tool];
        provider.script([{text:phase,finish:'stop'}]);
        const before=ends.length;
        await bridge.prompt({sessionId:'review-catalog',content:phase,projectPath:project,...nativeRef});
        for(let attempt=0;attempt<100&&ends.length===before;attempt++) await wait(100);
        row.phases.push({phase,settled:ends.length>before,state:bridge.status('review-catalog').state,providerTools:(provider.lastRequest?.body.tools??[]).map(t=>t.function?.name??t.name)});
        if(ends.length===before) break;
      }
      row.returnedAgentPluginVisible=row.phases.at(-1)?.providerTools.includes(tool.fullName)??false;
    } catch(error){row.error=String(error.message);}
    finally {
      row.disposeResult=await bridge.dispose('catalog review done');
      row.finalStop=await supervisor?.stop();
      await provider.close();
      if(row.disposeResult.ok) rmSync(root,{recursive:true,force:true});else row.retainedScratch=root;
    }
    results.push(row);
  }
  if (typeof desktopState.markDesktopStateRequired === 'function') {
    const root=mkdtempSync(join(tmpdir(),'omp-b1-review-marker-alias-'));
    const run=join(root,'run');mkdirSync(run);
    const target=join(root,'external-target');writeFileSync(target,'ORIGINAL');
    symlinkSync(target,join(run,desktopState.DESKTOP_STATE_REQUIRED_FILE));
    const row={strategy:'required-marker-symlink-write'};
    try {desktopState.markDesktopStateRequired(join(run,'desktop-state.json'));row.writeReturned=true;}
    catch(error){row.writeError=String(error.message);}
    row.targetUnchanged=readFileSync(target,'utf8')==='ORIGINAL';
    rmSync(root,{recursive:true,force:true});results.push(row);
  }
} finally { prepared.cleanup(); }
const report={desktopCommit,transport:'real patched fixed OMP + production bridge/gate + local FakeProvider',results};
writeFileSync(`/Users/vv/Documents/对话/omp-t20-b1-review-20261002/production-state-failure-probe-${desktopCommit.slice(0,8)}.json`,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
