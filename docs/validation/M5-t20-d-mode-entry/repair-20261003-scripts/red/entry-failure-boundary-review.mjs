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

async function buildBridge({ host, dataRoot, project, provider, events = [], nativeBindings = [], onTurnEnd = () => {}, onEvent = () => {}, transformEnterReply, catalogHook }) {
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
    plans: { ...createHostPlansEndpoints(() => host), enter: async input => { const actual = await host.call("plans.enter", input); return transformEnterReply ? await transformEnterReply(actual, input) : actual; } },
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
    hostTools: { executor: hostTools.executor, catalog: async projectPath => { const actual = await hostTools.catalog(projectPath); return catalogHook ? await catalogHook(actual) : actual; } },
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
const report={candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'real production bridge/gate/adapter/HostProcess+SQLite/patched source OMP/local FakeProvider; controlled public host reply/catalog await; not unmodified transport scheduling/Renderer/installer',cases:[]};
async function cleanFrom(index){const errors=[];for(const entry of scratch.splice(index).reverse()){try{if(entry?.cleanup)await entry.cleanup();else if(entry?.close)await entry.close();else if(typeof entry==='string')rmSync(entry,{recursive:true,force:true});}catch(error){errors.push(String(error));}}return errors;}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
try{
 assert.ok(HOST_BINARY&&GATE&&PATCHED_LAUNCHER);
 for(const kind of ['plan','goal'])for(const scenario of ['malformed-committed-reply','catalog-error-after-commit','stop-during-catalog']){
  const mark=scratch.length,row={kind,scenario,ends:[],catalogCalls:0};report.cases.push(row);
  const project=makeScratch('root-d-entry-failure-project-'),dataRoot=makeScratch('root-d-entry-failure-data-');
  let bridge,db;const hold=deferred();
  try{
   const host=await startHost(dataRoot);host.onExit(()=>row.hostExited=true);
   const provider=await FakeProvider.start({model:'local-model'});scratch.push({close:()=>provider.close()});
   const sessionId=await createSession(host,{title:scenario+' '+kind,projectPath:project,mode:'agent',permissionMode:'auto'}),events=[];
   const built=await buildBridge({host,dataRoot,project,provider,events,onTurnEnd:info=>row.ends.push({...info}),transformEnterReply:async actual=>{row.realHostReply=actual;return scenario==='malformed-committed-reply'?{...actual,kind:'invalid-kind'}:actual;},catalogHook:async catalog=>{row.catalogCalls++;if(row.catalogCalls===2){row.enterCatalogReached=true;if(scenario==='catalog-error-after-commit')throw new Error('controlled catalog failure');if(scenario==='stop-during-catalog')await hold.promise;}return catalog;}});bridge=built.bridge;
   db=new DatabaseSync(join(dataRoot,'pi.sqlite'),{readOnly:true});
   const turns=()=>db.prepare('SELECT id,status FROM turns WHERE session_id=? ORDER BY rowid').all(sessionId).map(r=>({...r}));
   const enterName=kind==='plan'?'EnterPlanMode':'EnterGoalMode';
   provider.script([{toolCalls:[{id:'entry-'+kind,name:enterName,args:{}}],finish:'tool_calls'},{toolCalls:[{id:'write-in-inconsistent-mode',name:'write',args:{path:'inconsistent-write.txt',content:'unexpected write after host commit'}}],finish:'tool_calls'},{text:'unexpected continuation',finish:'stop'}]);
   const accepted=await promptThrough(host,bridge,sessionId,'Enter '+kind+' before any implementation.');row.hostTurnId=accepted.hostTurnId;
   if(scenario==='stop-during-catalog'){
    assert.equal(await waitFor(()=>row.enterCatalogReached,30000),true);
    row.modeAtStop=(await host.call('session.get',{id:sessionId})).session.mode;
    row.stop=await bridge.stop(sessionId);hold.resolve();
   }
   assert.equal(await waitFor(()=>row.ends.length===1&&!bridge.status(sessionId).isRunning&&turns().every(t=>t.status!=='running'),30000),true,'terminal lifecycle settles');
   row.modeAfter=(await host.call('session.get',{id:sessionId})).session.mode;row.turnsBeforeRecovery=turns();row.initialEnd={...row.ends[0]};
   row.initialProviderCount=provider.requests.filter(r=>r.method==='POST').length;
   row.forbiddenEffect=existsSync(join(project,'inconsistent-write.txt'))?readFileSync(join(project,'inconsistent-write.txt'),'utf8'):null;
   row.audit=db.prepare("SELECT payload_json FROM audit_log WHERE session_id=? AND kind='plan_entered' ORDER BY id").all(sessionId).map(r=>JSON.parse(r.payload_json));
   row.initialEvents=[...events];
   provider.script([{text:'Recovery read-only turn complete.',finish:'stop'}]);
   row.recoveryAccepted=await promptThrough(host,bridge,sessionId,'Read the current contract and stop.');
   assert.equal(await waitFor(()=>row.ends.length===2&&!bridge.status(sessionId).isRunning&&turns().every(t=>t.status!=='running'),30000),true,'recovery settles');
   const latest=provider.requests.filter(r=>r.method==='POST').at(-1).body;
   row.recoveryTools=latest.tools.map(t=>t.function?.name??t.name);row.recoverySystem=latest.messages.filter(m=>['system','developer'].includes(m.role)).map(m=>m.content).join('\n');row.finalTurns=turns();
   row.messageCount=db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id=?').get(sessionId).n;
   const failures=[];function check(name,fn){try{fn();}catch(error){failures.push({name,error:String(error.message??error)});}}
   check('real host commit remains durable',()=>{assert.equal(row.realHostReply.kind,kind);assert.equal(row.modeAfter,kind);assert.equal(row.audit.length,1);assert.equal(row.audit[0].turnId,row.hostTurnId);});
   check('inconsistent or cancelled run does not continue',()=>{assert.equal(row.initialProviderCount,1);assert.equal(row.forbiddenEffect,null);assert.equal(row.turnsBeforeRecovery[0].status,scenario==='stop-during-catalog'?'aborted':'failed');});
   check('next real prompt recovers from durable mode',()=>{assert.ok(row.recoveryTools.includes(kind==='plan'?'SubmitPlan':'SubmitGoal'));assert.equal(row.recoveryTools.includes('EnterPlanMode'),false);assert.equal(row.recoveryTools.includes('write'),false);assert.ok(row.recoverySystem.includes(composeModeSystemPrompt(kind,'')));assert.equal(row.finalTurns.length,2);assert.equal(row.finalTurns[1].status,'completed');assert.equal(row.messageCount,0);});
   row.failures=failures;row.passed=failures.length===0;
  }catch(error){row.error=String(error.stack??error);row.passed=false;}
  finally{hold.resolve();if(bridge)row.dispose=await bridge.dispose('root Entry failure review complete');if(db)db.close();row.cleanupErrors=await cleanFrom(mark);row.scratchRemoved=!existsSync(project)&&!existsSync(dataRoot);}
 }
}catch(error){report.error=String(error.stack??error);}
finally{report.finalCleanupErrors=await cleanFrom(0);}
report.passed=!report.error&&report.cases.length===6&&report.cases.every(r=>r.passed&&r.dispose?.ok&&r.hostExited&&r.scratchRemoved&&!r.cleanupErrors.length)&&!report.finalCleanupErrors.length;
writeFileSync('/home/vv/person/code/omp-desktop-m5-t20-d-enter/docs/validation/M5-t20-d-mode-entry/repair-20261003-red/entry-failure-boundary-'+report.candidate.slice(0,8)+'.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({...report,cases:report.cases.map(({initialEvents,recoverySystem,...row})=>row)},null,2));process.exitCode=report.passed?0:1;
