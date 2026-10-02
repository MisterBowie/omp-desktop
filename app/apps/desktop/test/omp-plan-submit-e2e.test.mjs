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

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { preparePatchedTree } = await import("../../../scripts/omp-patch.mjs");
const {
  OmpRuntimeSupervisor,
  ensureSessionStateDir,
  findGateExtension,
  findPinnedLauncher,
} = await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { createOmpHostToolAdapter, createHostPlansSubmit } = await import(
  "../electron/main/runtime/omp-host-tools.ts"
);
const { createOmpHostTurnLifecycle, resolveEffectivePermissionMode } = await import(
  "../electron/main/runtime/omp-session-wiring.ts"
);
const { HostProcess } = await import("@pi-desktop/host-runtime");
const { createPlanRuntime } = await import("../electron/main/runtime/plans.ts");
const { createSessionCoordination } = await import("../electron/main/runtime/session-coordination.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");
const { ENGINE_ADAPTER_VERSION } = await import("@pi-desktop/shared");

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

test.after(() => {
  for (const entry of scratch.splice(0).reverse()) {
    if (entry && typeof entry.cleanup === "function") entry.cleanup();
    else if (entry && typeof entry.close === "function") entry.close();
    else if (typeof entry === "string") rmSync(entry, { recursive: true, force: true });
  }
});

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

async function buildBridge({ host, dataRoot, project, provider, events = [] }) {
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
    scratch.push({ close: () => supervisor.reclaimAll().catch(() => undefined) });
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
    emitAgentEvent: (envelope) => events.push(envelope),
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

const READY = HOST_BINARY && GATE && PATCHED_LAUNCHER;

test(
  `T20-B2 plan submission (${UNPATCHED ? "unpatched RED" : "patched"}): valid, schema-rejected, mixed-batch, duplicate and revision`,
  { timeout: 600_000, skip: READY ? false : "host-core binary or patched runtime not available" },
  async () => {
    const project = makeScratch("t20b2-project-");
    const dataRoot = makeScratch("t20b2-data-");
    const marker = join(project, "sibling-effect.txt");
    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    const host = await startHost(dataRoot);

    // The patched runtime really carries the settlement declaration (the RED
    // track deliberately runs the bare submodule, which does not).
    if (!UNPATCHED) {
      const typesSource = readFileSync(join(dirname(PATCHED_LAUNCHER), "..", "..", "agent", "src", "types.ts"), "utf8");
      assert.match(typesSource, /terminateOnSettle\?: boolean/);
    }

    const sessionId = await createSession(host, {
      title: "plan submit e2e",
      projectPath: project,
      mode: "plan",
    });
    const events = [];
    const { bridge } = await buildBridge({ host, dataRoot, project, provider, events });

    // --- 1. valid submission terminates, publishes the artifact ------------
    provider.script([
      {
        text: "submitting the plan",
        finish: "tool_calls",
        toolCalls: [{ id: "call_submit_1", name: "SubmitPlan", args: submitArgs() }],
      },
      {
        text: "this turn must never run",
        finish: "tool_calls",
        toolCalls: [{ id: "call_sibling", name: "bash", args: { command: `touch ${marker}` } }],
      },
    ]);
    const first = await promptThrough(host, bridge, sessionId, "write me a plan");
    assert.equal(first.accepted, true);
    assert.ok(first.hostTurnId, "the accepted prompt must be bound to a durable host turn");
    assert.notEqual(first.hostTurnId, first.turnId, "the durable turn id is not the live generation id");
    const settled = await waitFor(() => bridge.status(sessionId).isRunning === false);
    assert.equal(settled, true, "the submit turn must settle");

    assert.equal(provider.requests.length, 1, "a successful submit ends the run: exactly one provider request");
    assert.equal(existsSync(marker), false, "no sibling tool may run after a submit");

    const pending = await host.call("plans.pending", { sessionId });
    assert.equal(pending.plans.length, 1, "one pending proposal");
    const proposal = pending.plans[0];
    assert.equal(proposal.kind, "plan");
    assert.equal(proposal.title, submitArgs().title);
    assert.equal(proposal.question, submitArgs().question);
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.turnId, first.hostTurnId, "the proposal is bound to the durable host turn");
    assert.equal(proposal.toolCallId, "call_submit_1", "the proposal carries the real tool call id");
    const artifactPath = join(project, proposal.artifact.relativePath);
    assert.equal(proposal.artifact.relativePath.startsWith(".pi/plan/"), true);
    const artifactBytes = readFileSync(artifactPath);
    assert.equal(proposal.artifact.sha256, sha256(artifactBytes), "the recorded sha256 is the artifact's");
    assert.equal(proposal.artifact.sizeBytes, artifactBytes.length, "the recorded size is the artifact's");
    assert.equal(artifactBytes.toString("utf8"), submitArgs().markdown, "the markdown bytes are preserved exactly");
    assert.equal(statSync(artifactPath).isFile(), true);

    // The durable turn really closed: a fresh beginTurn is accepted (a running
    // row would refuse it), then settled so later prompts are unaffected. The
    // bridge's endTurn is dispatched from the runner's synchronous close, so
    // give the RPC a bounded retry window before calling it a leak.
    let probeTurn;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        probeTurn = await host.call("session.beginTurn", { sessionId });
        break;
      } catch (error) {
        if (error?.errorCode !== "AGENT_BUSY" || attempt === 49) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    assert.ok(probeTurn.turnId, "the submit turn must have settled in the database");
    await host.call("session.endTurn", { turnId: probeTurn.turnId, status: "completed" });

    // --- 2. schema rejection terminates without reaching the host ----------
    provider.script([
      {
        text: "submitting an incomplete plan",
        finish: "tool_calls",
        toolCalls: [{ id: "call_submit_schema", name: "SubmitPlan", args: { title: "Missing fields" } }],
      },
      {
        text: "must never run",
        finish: "tool_calls",
        toolCalls: [{ id: "call_schema_sibling", name: "bash", args: { command: `touch ${marker}` } }],
      },
    ]);
    const beforeSchema = provider.requests.length;
    const second = await promptThrough(host, bridge, sessionId, "submit an incomplete plan");
    assert.equal(second.accepted, true);
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
    assert.equal(
      provider.requests.length,
      beforeSchema + 1,
      "a schema-rejected submit must terminate: no follow-up provider request",
    );
    assert.equal(existsSync(marker), false, "the schema rejection must not execute the sibling");
    const afterSchema = await host.call("plans.pending", { sessionId });
    assert.equal(afterSchema.plans.length, 1, "the schema rejection created no proposal");

    // --- 3. duplicate pending: PLAN_ALREADY_PENDING, still terminating -----
    provider.script([
      {
        text: "submitting again",
        finish: "tool_calls",
        toolCalls: [{ id: "call_submit_dup", name: "SubmitPlan", args: submitArgs({ title: "Duplicate" }) }],
      },
      {
        text: "must never run",
        finish: "tool_calls",
        toolCalls: [{ id: "call_dup_sibling", name: "bash", args: { command: `touch ${marker}` } }],
      },
    ]);
    const beforeDuplicate = provider.requests.length;
    await promptThrough(host, bridge, sessionId, "submit again");
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
    assert.equal(provider.requests.length, beforeDuplicate + 1, "a failed submit still terminates");
    const stillOne = await host.call("plans.pending", { sessionId });
    assert.equal(stillOne.plans.length, 1, "the duplicate was refused by the host");
    assert.equal(stillOne.plans[0].id, proposal.id, "the original proposal is untouched");

    // --- 4. reject, then resubmit: a new artifact, the old bytes intact ----
    const rejected = await host.call("plans.resolve", {
      proposalId: proposal.id,
      sessionId,
      turnId: proposal.turnId,
      toolCallId: proposal.toolCallId,
      action: "reject",
      version: proposal.version,
    });
    assert.equal(rejected.action, "reject");
    assert.equal(rejected.execution ?? null, null, "a reject queues no execution");

    const revised = submitArgs({ title: "E2E approval plan v2", markdown: "# v2\n\nRevised.\n" });
    provider.script([
      {
        text: "submitting the revision",
        finish: "tool_calls",
        toolCalls: [{ id: "call_submit_v2", name: "SubmitPlan", args: revised }],
      },
      { text: "must never run", finish: "stop" },
    ]);
    const beforeRevision = provider.requests.length;
    await promptThrough(host, bridge, sessionId, "revise the plan");
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
    assert.equal(provider.requests.length, beforeRevision + 1, "the revision submit terminates");
    const revision = (await host.call("plans.pending", { sessionId })).plans[0];
    assert.ok(revision && revision.id !== proposal.id, "the revision is a new proposal");
    assert.notEqual(revision.artifact.relativePath, proposal.artifact.relativePath, "a new immutable artifact");
    assert.equal(readFileSync(artifactPath).toString("utf8"), submitArgs().markdown, "the old artifact is unchanged");
    assert.equal(
      readFileSync(join(project, revision.artifact.relativePath), "utf8"),
      revised.markdown,
      "the revision artifact carries the new bytes",
    );
  },
);

test(
  "T20-B2 mixed batch [bash, SubmitPlan] is rejected whole, does not terminate, and ordinary tools still run",
  { timeout: 600_000, skip: READY ? false : "host-core binary or patched runtime not available" },
  async () => {
    const project = makeScratch("t20b2-mixed-project-");
    const dataRoot = makeScratch("t20b2-mixed-data-");
    const mixedMarker = join(project, "mixed-sibling.txt");
    const controlMarker = join(project, "control.txt");
    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    const host = await startHost(dataRoot);
    const sessionId = await createSession(host, {
      title: "mixed batch e2e",
      projectPath: project,
      mode: "plan",
      permissionMode: "auto",
    });
    const { bridge } = await buildBridge({ host, dataRoot, project, provider });

    provider.script([
      {
        text: "running both",
        finish: "tool_calls",
        toolCalls: [
          { id: "call_mixed_bash", name: "bash", args: { command: `touch ${mixedMarker}` } },
          { id: "call_mixed_submit", name: "SubmitPlan", args: submitArgs() },
        ],
      },
      // The batch was rejected with terminate false, so the model keeps its
      // turn and issues a corrected, ordinary call.
      {
        text: "correcting with a normal command",
        finish: "tool_calls",
        toolCalls: [{ id: "call_control", name: "bash", args: { command: `touch ${controlMarker}` } }],
      },
      { text: "done", finish: "stop" },
    ]);
    await promptThrough(host, bridge, sessionId, "run both");
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);

    assert.equal(existsSync(mixedMarker), false, "the rejected batch's sibling must not run");
    assert.equal(
      (await host.call("plans.pending", { sessionId })).plans.length,
      0,
      "the rejected batch submitted nothing",
    );
    assert.equal(await waitFor(() => existsSync(controlMarker)), true, "ordinary tools still execute after a rejection");
    assert.ok(provider.requests.length >= 2, "the model got the blocked results and corrected");
  },
);

test(
  "T20-B2 approval dispatch: queued execution runs in OMP with the approved instruction, exactly once",
  { timeout: 600_000, skip: READY ? false : "host-core binary or patched runtime not available" },
  async () => {
    const project = makeScratch("t20b2-dispatch-project-");
    const dataRoot = makeScratch("t20b2-dispatch-data-");
    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    const host = await startHost(dataRoot);
    const sessionId = await createSession(host, {
      title: "dispatch e2e",
      projectPath: project,
      mode: "plan",
    });
    const { bridge } = await buildBridge({ host, dataRoot, project, provider });
    const planRuntime = buildPlanRuntime({ host, bridge });

    // Submit the plan through the runtime, then approve it in the real DB.
    provider.script([
      {
        text: "submitting",
        finish: "tool_calls",
        toolCalls: [{ id: "call_submit_1", name: "SubmitPlan", args: submitArgs() }],
      },
      { text: "never", finish: "stop" },
    ]);
    await promptThrough(host, bridge, sessionId, "plan it");
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
    const proposal = (await host.call("plans.pending", { sessionId })).plans[0];
    assert.ok(proposal);

    const resolved = await host.call("plans.resolve", {
      proposalId: proposal.id,
      sessionId,
      turnId: proposal.turnId,
      toolCallId: proposal.toolCallId,
      action: "approve",
      version: proposal.version,
      targetPermissionMode: "auto",
    });
    assert.equal(resolved.action, "approve");
    const execution = resolved.execution;
    assert.equal(execution.state, "queued", "approval queues the execution");
    const sessionAfterApproval = (await host.call("session.get", { id: sessionId })).session;
    assert.equal(sessionAfterApproval.mode, "agent", "approval flips the durable mode to agent");
    assert.equal(sessionAfterApproval.permissionMode, "auto");

    // The execution prompt carries the shared instruction; assert it on the
    // wire by having the provider answer normally and then checking requests.
    provider.script([{ text: "executed the approved plan", finish: "stop" }]);
    const beforeDispatch = provider.requests.length;

    // Two concurrent dispatchers: the host claim CAS admits exactly one prompt.
    // Wait for the execution request to be served, then for the run to settle
    // (the presentation reset after leaving Plan mode restarts the process, so
    // idle is not reached before the prompt exists).
    await Promise.all([
      planRuntime.dispatchApprovedPlan(execution),
      planRuntime.dispatchApprovedPlan(execution),
    ]);
    assert.equal(
      await waitFor(() => provider.requests.length > beforeDispatch, 60_000),
      true,
      "the approved execution must reach the provider",
    );
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
    assert.equal(provider.requests.length, beforeDispatch + 1, "exactly one execution prompt");

    const instructionBody = JSON.stringify(provider.requests.at(-1).body);
    assert.match(instructionBody, /<approved-plan-markdown>/);
    assert.match(instructionBody, /E2E approval plan/);
    assert.match(instructionBody, new RegExp(proposal.artifact.relativePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // The execution row completed and is not replayable.
    const executions = (await host.call("plans.queuedExecutions", { sessionId })).executions;
    assert.equal(executions.length, 0, "no queued execution remains");
    await planRuntime.drainApprovedPlanExecutions();
    await planRuntime.dispatchApprovedPlan(execution);
    assert.equal(provider.requests.length, beforeDispatch + 1, "a completed execution never replays");
  },
);

test(
  "T20-B2 rejected approval never executes, and a restart does not replay a queued one",
  { timeout: 600_000, skip: READY ? false : "host-core binary or patched runtime not available" },
  async () => {
    const project = makeScratch("t20b2-restart-project-");
    const dataRoot = makeScratch("t20b2-restart-data-");
    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    let host = await startHost(dataRoot);
    const rejectSession = await createSession(host, {
      title: "reject e2e",
      projectPath: project,
      mode: "plan",
    });
    const { bridge } = await buildBridge({ host, dataRoot, project, provider });
    const planRuntime = buildPlanRuntime({ host, bridge });

    const submitOne = async (sessionId) => {
      provider.script([
        {
          text: "submitting",
          finish: "tool_calls",
          toolCalls: [{ id: `call_submit_${sessionId}`, name: "SubmitPlan", args: submitArgs() }],
        },
        { text: "never", finish: "stop" },
      ]);
      await promptThrough(host, bridge, sessionId, "plan it");
      assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
      return (await host.call("plans.pending", { sessionId })).plans[0];
    };

    // Reject: nothing runs, nothing is queued.
    const rejectedProposal = await submitOne(rejectSession);
    const rejected = await host.call("plans.resolve", {
      proposalId: rejectedProposal.id,
      sessionId: rejectSession,
      turnId: rejectedProposal.turnId,
      toolCallId: rejectedProposal.toolCallId,
      action: "reject",
      version: rejectedProposal.version,
    });
    assert.equal(rejected.execution ?? null, null);
    const beforeRejectDrain = provider.requests.length;
    await planRuntime.drainApprovedPlanExecutions();
    assert.equal(provider.requests.length, beforeRejectDrain, "a rejected approval never dispatches");

    // Approve a second proposal, but do not dispatch; restart the host. Boot
    // maintenance interrupts the queued row, so the drain must not run it.
    const queuedSession = await createSession(host, {
      title: "queued e2e",
      projectPath: project,
      mode: "plan",
    });
    const queuedProposal = await submitOne(queuedSession);
    const queued = await host.call("plans.resolve", {
      proposalId: queuedProposal.id,
      sessionId: queuedSession,
      turnId: queuedProposal.turnId,
      toolCallId: queuedProposal.toolCallId,
      action: "approve",
      version: queuedProposal.version,
      targetPermissionMode: "ask",
    });
    assert.equal(queued.execution.state, "queued");

    // Restart host-core on the same data directory (new connection + boot
    // maintenance), then let the production drain look at the row.
    await host.dispose();
    host = await startHost(dataRoot);
    provider.script([{ text: "must not run", finish: "stop" }]);
    const beforeRestartDrain = provider.requests.length;
    // The runtime state object both modules captured still points at the old
    // host; the production dispatch reads `runtimeState.host` lazily, so point
    // it at the restarted process the way the app's supervision does.
    const rebuilt = buildPlanRuntime({ host, bridge });
    await rebuilt.drainApprovedPlanExecutions();
    assert.equal(provider.requests.length, beforeRestartDrain, "an interrupted queued execution must not replay");
    const rowsAfterRestart = (await host.call("plans.queuedExecutions", { sessionId: queuedSession })).executions;
    assert.equal(rowsAfterRestart.length, 0, "the queued row is no longer dispatchable");
    // Read the durable row the way the product cannot (host-core owns SQLite):
    // boot maintenance must have interrupted it, not left it running.
    const db = new DatabaseSync(join(dataRoot, "pi.sqlite"), { readOnly: true });
    try {
      const row = db
        .prepare("SELECT execution_state FROM plan_approvals WHERE execution_id = ?")
        .get(queued.execution.id);
      assert.equal(row?.execution_state, "interrupted", "the restarted host interrupted the queued execution");
    } finally {
      db.close();
    }
  },
);
