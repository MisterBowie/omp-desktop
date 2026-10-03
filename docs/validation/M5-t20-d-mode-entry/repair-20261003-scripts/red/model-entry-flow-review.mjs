/** Independent D-Enter same-turn integration review. Actual product bridge/gate/adapter/host DB and patched OMP, local FakeProvider.
 * Scripted model emits Enter -> allowed read -> unavailable native write -> Submit.
 * Baseline missing Entry is expected RED. Runs against current original Git checkout, no product edits.
 * Optional fixture capability snapshot contains one memory marker to check preservation, not real host-memory provenance.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = '/home/vv/person/code/omp-desktop-m5-t20-d-enter/app/apps/desktop/test';
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/experiments/omp-bridge/lib/provider.mjs');
const { writeModelsConfig } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/experiments/omp-bridge/lib/models-config.mjs');
const { preparePatchedTree } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/scripts/omp-patch.mjs');
const {
  OmpRuntimeSupervisor,
  ensureSessionStateDir,
  findGateExtension,
  findPinnedLauncher,
} = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/packages/omp-runtime/src/index.ts');
const { createOmpSessionBridge } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/apps/desktop/electron/main/runtime/omp-session.ts');
const { createOmpHostToolAdapter, createHostPlansEndpoints } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/apps/desktop/electron/main/runtime/omp-host-tools.ts');
const { createOmpHostTurnLifecycle, resolveEffectivePermissionMode } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/apps/desktop/electron/main/runtime/omp-session-wiring.ts');
const { HostProcess } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/packages/host-runtime/dist/index.js');
const { createPlanRuntime } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/apps/desktop/electron/main/runtime/plans.ts');
const { createSessionCoordination } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/apps/desktop/electron/main/runtime/session-coordination.ts');
const { createEngineRouter } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/apps/desktop/electron/main/runtime/engine-router.ts');
const { ENGINE_ADAPTER_VERSION } = await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/packages/shared/dist/index.js');

/** Every temporary thing this file creates, removed in `after`. */
const scratch = [];
function makeScratch(prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(path);
  return path;
}

function waitFor(predicate, timeoutMs = 30_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const tick = () => {
      if (predicate()) return resolve(true);
      if (Date.now() > deadline) return resolve(false);
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

/** The host-core binary the tests drive (env override, then the dev builds). */
function resolveHostBinary() {
  const candidates = [
    process.env.PI_DESKTOP_HOST_BIN,
    join(here, "../../../target/debug/pi-desktop-host-core"),
    join(here, "../../../target/release/pi-desktop-host-core"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const HOST_BINARY = resolveHostBinary();
const GATE = findGateExtension(here);

// The fixed patched runtime: a scratch copy of the pinned submodule with the
// controlled patch set (.4) applied. Prepared once; the runtime under test is
// the patched tree, never the bare submodule (which lacks the declaration).
// `OMP_B2_UNPATCHED=1` selects the bare pinned submodule instead — the RED
// track for the first probe, which shows the settlement declaration is what
// ends the run (the base runtime ignores the host result flag and continues
// to the next provider request).
let PATCHED_LAUNCHER = null;
let PATCH_MANIFEST = null;
const UNPATCHED = process.env.OMP_B2_UNPATCHED === "1";
if (HOST_BINARY && GATE && UNPATCHED) {
  PATCHED_LAUNCHER = findPinnedLauncher(here);
} else if (HOST_BINARY && GATE) {
  const prepared = await preparePatchedTree({ prepareBuild: true, keep: true });
  scratch.push({ cleanup: prepared.cleanup });
  PATCH_MANIFEST = prepared.manifest;
  PATCHED_LAUNCHER = join(prepared.tree, "packages", "coding-agent", "scripts", "omp");
}

/** Start the real host-core on an isolated data directory and handshake. */
async function startHost(dataDir) {
  const host = new HostProcess({ binaryPath: HOST_BINARY, dataDir, onStderr: () => undefined });
  await host.handshake();
  scratch.push({ close: () => host.dispose?.() });
  return host;
}

/** Create one OMP session row (real DB) and return its id. */
async function createSession(host, { title, projectPath, mode, permissionMode }) {
  const created = await host.call("session.create", {
    title,
    engine: "omp",
    mode,
    projectPath,
    // The same binding the fixture's models.yml projects, so the dispatch
    // path (which reads the durable row, not prompt input) sees one identity.
    providerId: "m1fake",
    modelId: "local-model",
    ...(permissionMode ? { permissionMode } : {}),
  });
  const sessionId = created?.session?.id;
  assert.ok(typeof sessionId === "string" && sessionId.length > 0, "session.create must return an id");
  // `session.create` only inherits a permission mode from a parent, so an
  // explicit mode is applied through the real configure transaction (the same
  // write the composer's permission picker uses).
  if (permissionMode) {
    await host.call("session.configure", { id: sessionId, mode, permissionMode });
  }
  return sessionId;
}

/**
 * The production bridge over the patched runtime and the real host: model
 * projection into the fake provider, the host's own turn lifecycle, the
 * production host-tool adapter with the real `plans.submit` endpoint, and the
 * session policy read from the real session row.
 */
/**
 * Prompt through the bridge with the session's own durable binding — the way
 * agent-ipc reads the row — so the first prompt and the approved-execution
 * dispatch describe the same model/thinking identity.
 */
async function promptThrough(host, bridge, sessionId, content) {
  const { session } = await host.call("session.get", { id: sessionId });
  return bridge.prompt({
    sessionId,
    content,
    projectPath: session.projectPath,
    providerId: session.providerId,
    modelId: session.modelId,
    thinkingLevel: session.thinkingLevel,
  });
}

async function buildBridge({ host, dataRoot, project, provider, events = [], nativeBindings = [], onTurnEnd = () => {}, onEvent = () => {} }) {
  const sessionDir = ensureSessionStateDir(dataRoot);
  // One supervisor per session, exactly like the production wiring: a shared
  // supervisor would refuse a second session's working directory while the
  // first session's runtime is live.
  const supervisors = new Map();
  const supervisorFor = (spec) => {
    const existing = supervisors.get(spec.sessionId);
    if (existing) return existing;
    const supervisor = new OmpRuntimeSupervisor({
      // Production wiring: the gate refuses a turn whose run-scoped state cannot
      // be read back as owned-and-valid.
      desktopStateRequired: true,
      dataRoot,
      launcherPath: PATCHED_LAUNCHER,
      expectedRuntimeVersion: "18.3.0",
      sessionDir,
      args: ["--trusted-extension", GATE],
      prepareRun: (paths) => {
        writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" });
      },
      readyTimeoutMs: 60_000,
    });
    supervisor.setWorkingDirectory(project);
    scratch.push({ close: () => supervisor.reclaimAll() });
    supervisors.set(spec.sessionId, supervisor);
    return supervisor;
  };

  const hostTools = createOmpHostToolAdapter({
    plugins: {
      getTools: () => [],
      getSkills: () => [],
      loadSkillBody: () => {
        throw new Error("no plugin skills in this fixture");
      },
    },
    userMcp: { toolsForProject: async () => [], callTool: async () => "" },
    pluginActiveInProject: () => true,
    plans: createHostPlansEndpoints(() => host),
  });

  const bridge = createOmpSessionBridge({
    createSupervisor: (spec) => supervisorFor(spec),
    launcher: PATCHED_LAUNCHER,
    isPackaged: false,
    appPath: here,
    sessionDir,
    gateResolver: () => GATE,
    emitAgentEvent: (envelope) => { events.push(envelope); onEvent(envelope); },
    onTurnEnd,
    logger: { app: () => undefined },
    sessionPolicy: {
      policy: async (sessionId) => {
        const { session } = await host.call("session.get", { id: sessionId });
        if (!session) return null;
        return {
          mode: session.mode,
          permissionMode: resolveEffectivePermissionMode(session.permissionMode, "ask"),
        };
      },
    },
    capabilities: { snapshot: async () => ({ skills: [], memory: "ROOT_D_ENTRY_MEMORY" }) },
    hostTurns: createOmpHostTurnLifecycle(() => host),
    hostTools,
    persistNativeSession: async (info) => {
      await host.call("session.bindEngine", {
        id: info.sessionId,
        adapterVersion: ENGINE_ADAPTER_VERSION,
        runtimeVersion: info.runtimeVersion,
        nativeSessionId: info.nativeSessionId,
        nativeSessionPath: info.nativeSessionPath,
      });
      nativeBindings.push({...info});
    },
  });
  return { bridge, supervisors };
}


const {execFileSync}=await import('node:child_process');
const {composeModeSystemPrompt}=await import('file:///home/vv/person/code/omp-desktop-m5-t20-d-enter/app/packages/agent-runtime/src/mode-prompts.ts');
const repo='/home/vv/person/code/omp-desktop-m5-t20-d-enter';
const report={candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'actual production bridge/gate/adapter/HostProcess+SQLite/patched source OMP/local FakeProvider; fixture memory marker only; no Renderer/installer claim',cases:[]};
async function cleanFrom(index){const errors=[];for(const entry of scratch.splice(index).reverse()){try{if(entry?.cleanup)await entry.cleanup();else if(entry?.close)await entry.close();else if(typeof entry==='string')rmSync(entry,{recursive:true,force:true});}catch(error){errors.push(String(error));}}return errors;}
function systemText(body){return body.messages.filter(m=>m.role==='system'||m.role==='developer').map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).join('\n');}
function occurrences(s,value){return s.split(value).length-1;}
try{
 assert.ok(HOST_BINARY&&GATE&&PATCHED_LAUNCHER);report.patchManifest=PATCH_MANIFEST;
 for(const kind of ['plan','goal']){
  const mark=scratch.length,row={kind,ends:[],permissionCards:[],nativeBindings:[]};report.cases.push(row);
  const project=makeScratch('root-d-entry-flow-project-'),dataRoot=makeScratch('root-d-entry-flow-data-');
  writeFileSync(join(project,'read-seed.txt'),'ROOT_D_ENTRY_READ_CONTENT');
  let bridge,db;
  try{
   const host=await startHost(dataRoot);host.onExit(()=>{row.hostExited=true;});
   const provider=await FakeProvider.start({model:'local-model'});scratch.push({close:()=>provider.close()});
   const sessionId=await createSession(host,{title:'same-turn Entry '+kind,projectPath:project,mode:'agent',permissionMode:'auto'});
   const events=[];
   const built=await buildBridge({host,dataRoot,project,provider,events,nativeBindings:row.nativeBindings,onTurnEnd:info=>row.ends.push({...info}),onEvent:envelope=>{if(envelope.event.type==='tool_permission_request'){const request=envelope.event.request;row.permissionCards.push({toolName:request.toolName,risk:request.risk});bridge.resolvePermission(request.requestId,'deny');}}});bridge=built.bridge;
   db=new DatabaseSync(join(dataRoot,'pi.sqlite'),{readOnly:true});
   const turns=()=>db.prepare('SELECT id,status FROM turns WHERE session_id=? ORDER BY rowid').all(sessionId).map(r=>({...r}));
   const enterName=kind==='plan'?'EnterPlanMode':'EnterGoalMode',submitName=kind==='plan'?'SubmitPlan':'SubmitGoal';
   const proposal={title:'Entry '+kind,markdown:'# Entry '+kind+'\n\nReach the intended outcome.\n\n## Acceptance criteria\n- Verify the exact result.\n\n## Boundaries\n- Isolated review workspace only.\n',question:'Approve this isolated '+kind+'?'};
   provider.script([
    {toolCalls:[{id:'entry-'+kind,name:enterName,args:{}}],finish:'tool_calls'},
    {toolCalls:[{id:'read-after-entry',name:'read',args:{path:'read-seed.txt'}}],finish:'tool_calls'},
    {toolCalls:[{id:'write-after-entry',name:'write',args:{path:'forbidden-after-entry.txt',content:'forbidden'}}],finish:'tool_calls'},
    {toolCalls:[{id:'submit-after-entry',name:submitName,args:proposal}],finish:'tool_calls'},
    {text:'unexpected provider request after Submit',finish:'stop'}
   ]);
   const accepted=await promptThrough(host,bridge,sessionId,'Negotiate a '+kind+' contract, inspect the seed file and submit it for approval.');
   assert.equal(await waitFor(()=>row.ends.length===1&&!bridge.status(sessionId).isRunning&&turns().every(t=>t.status!=='running'),45000),true,'the real run must end');
   const posts=provider.requests.filter(r=>r.method==='POST');
   row.requests=posts.map((r,index)=>({index,toolNames:(r.body.tools??[]).map(t=>t.function?.name??t.name),system:systemText(r.body),toolMessages:r.body.messages.filter(m=>m.role==='tool')}));
   row.engineRef=(await host.call('session.getEngineRef',{id:sessionId})).engineRef;
   row.nativeSessionId=row.engineRef.nativeSessionId;
   const nativeEntries=readFileSync(row.engineRef.nativeSessionPath,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
   row.nativeHeader=nativeEntries.find(entry=>entry.type==='session');
   row.nativeUserMessageCount=nativeEntries.filter(entry=>entry.type==='message'&&entry.message?.role==='user').length;
   row.modeAfter=(await host.call('session.get',{id:sessionId})).session.mode;
   row.turns=turns();row.hostTurnId=accepted.hostTurnId;
   row.enterAudit=db.prepare("SELECT payload_json FROM audit_log WHERE session_id=? AND kind='plan_entered' ORDER BY id").all(sessionId).map(r=>JSON.parse(r.payload_json));
   row.messageCount=db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id=?').get(sessionId).n;
   row.forbiddenEffect=existsSync(join(project,'forbidden-after-entry.txt'))?readFileSync(join(project,'forbidden-after-entry.txt'),'utf8'):null;
   row.pending=(await host.call('plans.pending',{sessionId})).plans;
   row.events=events;
   if(row.pending.length){const artifact=row.pending[0].artifact;const bytes=readFileSync(join(project,artifact.relativePath));row.artifact={relativePath:artifact.relativePath,sha256:createHash('sha256').update(bytes).digest('hex'),sizeBytes:bytes.length,markdown:bytes.toString()};}
   const failures=[];function check(name,fn){try{fn();}catch(error){failures.push({name,error:String(error.message??error)});}}
   check('initial Agent advertises both Enter tools',()=>{assert.ok(row.requests[0].toolNames.includes('EnterPlanMode'));assert.ok(row.requests[0].toolNames.includes('EnterGoalMode'));});
   check('Enter stays in same durable turn and persists kind',()=>{assert.equal(row.modeAfter,kind);assert.equal(row.turns.length,1);assert.equal(row.turns[0].id,row.hostTurnId);assert.equal(row.turns[0].status,'completed');assert.equal(row.enterAudit.length,1);assert.equal(row.enterAudit[0].turnId,row.hostTurnId);assert.equal(row.enterAudit[0].toolCallId,'entry-'+kind);});
   check('subsequent provider uses contract catalog and exact mode block once',()=>{
    for(const request of row.requests.slice(1)){
     for(const forbidden of ['EnterPlanMode','EnterGoalMode','write','edit','task','eval'])assert.equal(request.toolNames.includes(forbidden),false,forbidden+' advertised after Entry');
     assert.ok(request.toolNames.includes(submitName));assert.equal(request.toolNames.includes(kind==='plan'?'SubmitGoal':'SubmitPlan'),false);
     assert.equal(occurrences(request.system,composeModeSystemPrompt(kind,'')),1);assert.equal(occurrences(request.system,composeModeSystemPrompt('agent','')),0);assert.equal(occurrences(request.system,'ROOT_D_ENTRY_MEMORY'),1);
    }
   });
   check('allowed read executes and forbidden write has zero effects',()=>{assert.ok(JSON.stringify(row.requests[2]?.toolMessages).includes('ROOT_D_ENTRY_READ_CONTENT'));assert.equal(row.forbiddenEffect,null);});
   check('Submit creates exact immutable artifact and terminates',()=>{
    assert.equal(posts.length,4);assert.equal(row.pending.length,1);const p=row.pending[0];assert.equal(p.kind,kind);assert.equal(p.turnId,row.hostTurnId);assert.equal(p.toolCallId,'submit-after-entry');assert.ok(row.artifact.relativePath.startsWith('.pi/'+kind+'/'));assert.equal(row.artifact.markdown,proposal.markdown);assert.equal(row.artifact.sha256,p.artifact.sha256);assert.equal(row.artifact.sizeBytes,p.artifact.sizeBytes);
   });
   check('same native session and exactly one user prompt',()=>{assert.equal(row.nativeBindings.length,1);assert.equal(row.nativeBindings[0].nativeSessionId,row.nativeSessionId);assert.equal(row.nativeHeader.id,row.nativeSessionId);assert.equal(row.nativeUserMessageCount,1);});
   check('host does not duplicate native body',()=>assert.equal(row.messageCount,0));
   row.failures=failures;row.passed=failures.length===0;
  }catch(error){row.error=String(error.stack??error);row.passed=false;}
  finally{if(bridge)row.dispose=await bridge.dispose('root D Entry flow complete');if(db)db.close();row.cleanupErrors=await cleanFrom(mark);row.scratchRemoved=!existsSync(project)&&!existsSync(dataRoot);}
 }
}catch(error){report.error=String(error.stack??error);}
finally{report.finalCleanupErrors=await cleanFrom(0);}
report.passed=!report.error&&report.cases.length===2&&report.cases.every(r=>r.passed&&r.dispose?.ok&&r.hostExited&&r.scratchRemoved&&!r.cleanupErrors.length)&&!report.finalCleanupErrors.length;
const output='/home/vv/person/code/omp-desktop-m5-t20-d-enter/docs/validation/M5-t20-d-mode-entry/repair-20261003-red/model-entry-flow-'+report.candidate.slice(0,8)+'.json';writeFileSync(output,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,patchManifest:undefined,cases:report.cases.map(r=>({...r,events:undefined,requests:r.requests?.map(({system,toolMessages,...request})=>({...request,systemSha256:createHash('sha256').update(system).digest('hex')}))}))},null,2));process.exitCode=report.passed?0:1;
