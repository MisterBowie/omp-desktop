/**
 * T20-B2 acceptance against the *real* fixed patched OMP runtime, the
 * production bridge/gate/host-tool adapter, a real host-core database and a
 * local fake provider. No paid/remote model is ever contacted.
 *
 * Covered here (the parts that need a live runtime + live host):
 *
 *   1. a valid `SubmitPlan` in Plan mode publishes the immutable artifact
 *      through the host's own `plans.submit` protocol, records the durable
 *      host turn id (never the live `omp-turn:` generation id) and ends the
 *      run — exactly one provider request, no sibling side effect;
 *   2. a schema-validation rejection (missing required field) terminates the
 *      same way without ever reaching the host and without a second provider
 *      request (the .4 patch's `terminateOnSettle`);
 *   3. a mixed `[bash, SubmitPlan]` batch is rejected whole with zero side
 *      effects and does NOT terminate: the model corrects and a later ordinary
 *      tool call executes (the positive control);
 *   4. a second submission while one is pending is refused with
 *      `PLAN_ALREADY_PENDING` and still terminates; reject → resubmit produces
 *      a new immutable artifact without touching the first;
 *   5. approving a queued execution dispatches into the OMP runtime through
 *      the production `runtime/plans.ts` path with the shared PI instruction
 *      (artifact path + exact markdown), flips the session to agent mode,
 *      completes the execution row, and never replays (a second drain and a
 *      concurrent double-dispatch add no prompt).
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

const here = '/Users/vv/Documents/对话/omp-desktop-review-m5-r4b/app/apps/desktop/test';
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/experiments/omp-bridge/lib/provider.mjs');
const { writeModelsConfig } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/experiments/omp-bridge/lib/models-config.mjs');
const { preparePatchedTree } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/scripts/omp-patch.mjs');
const {
  OmpRuntimeSupervisor,
  ensureSessionStateDir,
  findGateExtension,
  findPinnedLauncher,
} = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/packages/omp-runtime/src/index.ts');
const { createOmpSessionBridge } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/apps/desktop/electron/main/runtime/omp-session.ts');
const { createOmpHostToolAdapter, createHostPlansSubmit } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/apps/desktop/electron/main/runtime/omp-host-tools.ts');
const { createOmpHostTurnLifecycle, resolveEffectivePermissionMode } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/apps/desktop/electron/main/runtime/omp-session-wiring.ts');
const { HostProcess } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/packages/host-runtime/dist/index.js');
const { createPlanRuntime } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/apps/desktop/electron/main/runtime/plans.ts');
const { createSessionCoordination } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/apps/desktop/electron/main/runtime/session-coordination.ts');
const { createEngineRouter } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/apps/desktop/electron/main/runtime/engine-router.ts');
const { ENGINE_ADAPTER_VERSION } = await import('file:///Users/vv/Documents/%E5%AF%B9%E8%AF%9D/omp-desktop-review-m5-r4b/app/packages/shared/dist/index.js');

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

async function buildBridge({ host, dataRoot, project, provider, events = [], onTurnEnd = () => {}, onEvent = () => {} }) {
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
    plans: createHostPlansSubmit(() => host),
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
    },
  });
  return { bridge, supervisors };
}

/** The production plan runtime over the real host and the real OMP bridge. */
function buildPlanRuntime({ host, bridge }) {
  const runtimeState = { host, sidecar: null, agentHostBridge: null };
  const activeTurns = new Map();
  const coordination = createSessionCoordination({
    activeTurns,
    getMainWindow: () => null,
    getViewingSessionId: () => null,
  });
  const engineRouter = createEngineRouter({
    status: (engine) => ({
      engine,
      phase: "running",
      runtimeVersion: "18.3.0",
      protocolVersion: 2,
      reason: null,
      capabilities: {},
    }),
    sessionEngine: async (sessionId) => {
      const { session } = await host.call("session.get", { id: sessionId });
      return session?.engine ?? "pi";
    },
  });
  const planRuntime = createPlanRuntime({
    runtimeState,
    getEngineRouter: () => engineRouter,
    getOmpSessions: () => bridge,
    planState: { approvedExecutionDrain: null },
    logger: { app: () => undefined },
    sendToRenderer: () => undefined,
    coordination,
    scheduledRunsBySession: new Map(),
    activeToolCalls: new Map(),
    planSubmissionTurnIds: new Set(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    approvedExecutionTurns: new Map(),
    startedApprovedExecutions: new Set(),
    finishedApprovedExecutions: new Set(),
    dispatchingApprovedExecutions: new Set(),
    inFlightExecutionFinishes: new Set(),
    pendingExecutionFinishes: new Map(),
    announceTurnEnded: () => undefined,
    emitAgentEvent: () => undefined,
    acquireSessionOperation: coordination.acquireSessionOperation,
    resolveAgentRuntimeLaunch: async () => {
      throw new Error("the Pi launch path must not be used for an OMP session");
    },
    isQuitting: () => false,
  });
  return planRuntime;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function submitArgs(overrides = {}) {
  return {
    title: "E2E approval plan",
    markdown: "# E2E approval plan\n\n1. Write the marker file.\n",
    question: "Approve the E2E plan?",
    ...overrides,
  };
}


// Root review: uses the production bridge/lifecycle/adapter/Main plan dispatcher and actual
// host SQLite. The proper onTurnEnd -> settleOmpTurnEnd wiring mirrors index.ts.
// Negative control deliberately omits ONLY that test composition link, exposing why an
// empty queued list cannot prove that the durable execution completed.
const { execFileSync } = await import('node:child_process');
const repo = '/Users/vv/Documents/对话/omp-desktop-review-m5-r4b';
const report = {candidate:execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim(),layer:'actual host SQLite/production bridge/lifecycle/adapter/Main plan dispatcher/patched OMP/local FakeProvider; permission decisions through real bridge API; no renderer IPC in this fixture',cases:[]};
async function cleanFrom(index) {
  const errors=[];
  for(const entry of scratch.splice(index).reverse()){
    try{
      if(entry?.cleanup)await entry.cleanup();
      else if(entry?.close)await entry.close();
      else if(typeof entry==='string')rmSync(entry,{recursive:true,force:true});
    }catch(error){errors.push(String(error));}
  }
  return errors;
}
try{
  assert.ok(HOST_BINARY&&GATE&&PATCHED_LAUNCHER);
  for(const spec of [
    {kind:'plan',permission:'auto',wired:false},
    {kind:'plan',permission:'ask',wired:true},
    {kind:'plan',permission:'accept-edits',wired:true},
    {kind:'plan',permission:'auto',wired:true},
    {kind:'goal',permission:'auto',wired:true},
  ]){
    const mark=scratch.length,row={...spec,permissionCards:[],ends:[]};report.cases.push(row);
    const project=makeScratch('root-b2-approval-project-'),dataRoot=makeScratch('root-b2-approval-data-');
    const provider=await FakeProvider.start({model:'local-model'});scratch.push({close:()=>provider.close()});
    let bridge,db,host;const runtimes=[];
    try{
      host=await startHost(dataRoot);host.onExit(()=>{row.hostExited=true;});
      const sessionId=await createSession(host,{title:'root '+spec.kind+' '+spec.permission,projectPath:project,mode:spec.kind});
      const built=await buildBridge({host,dataRoot,project,provider,
        onTurnEnd:info=>{row.ends.push({...info});if(spec.wired)for(const r of runtimes)r.settleOmpTurnEnd(info);},
        onEvent:envelope=>{
          if(envelope.event.type!=='tool_permission_request')return;
          const request=envelope.event.request;
          row.permissionCards.push({toolName:request.toolName,risk:request.risk,markerBeforeAnswer:existsSync(join(project,'approved-marker.txt'))});
          row.permissionCards.at(-1).resolution=bridge.resolvePermission(request.requestId,'allow-once');
        },
      });bridge=built.bridge;
      // Two real dispatch instances: the shared host CAS, not one in-memory Set, arbitrates.
      runtimes.push(buildPlanRuntime({host,bridge}),buildPlanRuntime({host,bridge}));
      db=new DatabaseSync(join(dataRoot,'pi.sqlite'),{readOnly:true});
      const turns=()=>db.prepare('SELECT id,status FROM turns WHERE session_id=? ORDER BY rowid').all(sessionId).map(r=>({...r}));
      const args={title:'Root approval '+spec.kind,markdown:'# Goal or plan\n\nReach the marker and verify its exact content.\n',question:'Approve the isolated review?'};
      provider.script([{toolCalls:[{id:'root-submit',name:spec.kind==='plan'?'SubmitPlan':'SubmitGoal',args}],finish:'tool_calls'},{text:'must not run after submission',finish:'stop'}]);
      const submit=await promptThrough(host,bridge,sessionId,'submit '+spec.kind);
      assert.equal(await waitFor(()=>!bridge.status(sessionId).isRunning&&turns().every(t=>t.status!=='running')),true);
      row.submitRequests=provider.requests.filter(r=>r.method==='POST').length;assert.equal(row.submitRequests,1);
      const proposal=(await host.call('plans.pending',{sessionId})).plans[0];assert.equal(proposal.kind,spec.kind);assert.equal(proposal.turnId,submit.hostTurnId);
      assert.ok(proposal.artifact.relativePath.startsWith('.pi/'+spec.kind+'/'));
      const bytes=readFileSync(join(project,proposal.artifact.relativePath));assert.equal(bytes.toString(),args.markdown);assert.equal(sha256(bytes),proposal.artifact.sha256);
      const resolved=await host.call('plans.resolve',{proposalId:proposal.id,sessionId,turnId:proposal.turnId,toolCallId:proposal.toolCallId,version:proposal.version,action:'approve',targetPermissionMode:spec.permission});
      row.executionId=resolved.execution.id;assert.equal(resolved.execution.state,'queued');
      const current=(await host.call('session.get',{id:sessionId})).session;assert.equal(current.mode,'agent');assert.equal(current.permissionMode,spec.permission);
      provider.script([{toolCalls:[{id:'root-approved-bash',name:'bash',args:{command:'printf approved > approved-marker.txt'}}],finish:'tool_calls'},{text:'approved execution complete',finish:'stop'}]);
      const before=provider.requests.filter(r=>r.method==='POST').length;
      await Promise.all(runtimes.map(r=>r.dispatchApprovedPlan(resolved.execution)));
      assert.equal(await waitFor(()=>provider.requests.filter(r=>r.method==='POST').length>before),true);
      assert.equal(await waitFor(()=>!bridge.status(sessionId).isRunning&&turns().every(t=>t.status!=='running')),true);
      row.executionRequests=provider.requests.filter(r=>r.method==='POST').length-before;assert.equal(row.executionRequests,2);
      assert.equal(readFileSync(join(project,'approved-marker.txt'),'utf8'),'approved');
      assert.equal(row.permissionCards.length,spec.permission==='auto'?0:1);
      assert.ok(row.permissionCards.every(c=>c.markerBeforeAnswer===false&&c.toolName==='bash'));
      const executionRow=()=>({...db.prepare('SELECT status,execution_state,error_code FROM plan_approvals WHERE execution_id=?').get(resolved.execution.id)});
      if(spec.wired)assert.equal(await waitFor(()=>executionRow().execution_state==='completed',5000),true,'real durable execution must finish');
      row.executionRow=executionRow();row.turns=turns();row.queued=(await host.call('plans.queuedExecutions',{sessionId})).executions;
      assert.equal(row.executionRow.execution_state,spec.wired?'completed':'running');
      assert.equal(row.queued.length,0);assert.equal(row.turns.length,2);assert.ok(row.turns.every(t=>t.status==='completed'));
      row.messageCount=db.prepare('SELECT COUNT(*) AS count FROM messages WHERE session_id=?').get(sessionId).count;assert.equal(row.messageCount,0);
      const again=provider.requests.filter(r=>r.method==='POST').length;
      await runtimes[0].drainApprovedPlanExecutions();await runtimes[1].dispatchApprovedPlan(resolved.execution);
      assert.equal(provider.requests.filter(r=>r.method==='POST').length,again);
      row.passed=true;
    }catch(error){row.passed=false;row.error=String(error.stack??error);}
    finally{
      if(bridge)row.dispose=await bridge.dispose('root approval review complete');
      if(db)db.close();row.cleanupErrors=await cleanFrom(mark);
      row.scratchRemoved=!existsSync(project)&&!existsSync(dataRoot);
    }
  }
}catch(error){report.error=String(error.stack??error);}
finally{report.finalCleanupErrors=await cleanFrom(0);}
report.passed=!report.error&&report.cases.length===5&&report.cases.every(r=>r.passed&&r.hostExited&&r.dispose?.ok&&r.scratchRemoved&&!r.cleanupErrors.length)&&!report.finalCleanupErrors.length;
writeFileSync('/Users/vv/Documents/对话/omp-t20-b2-review-20261003/production-approval-'+report.candidate.slice(0,8)+'.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));process.exitCode=report.passed?0:1;
