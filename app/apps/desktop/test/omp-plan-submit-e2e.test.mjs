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
  OmpRuntimeProcess,
  ensureSessionStateDir,
  findGateExtension,
  findPinnedLauncher,
} = await import("../../../packages/omp-runtime/src/index.ts");
const { turnCommandToken } = await import("../../../packages/omp-runtime/src/session/turn-fence.ts");
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

async function buildBridge({
  host,
  dataRoot,
  project,
  provider,
  events = [],
  onTurnEnd = () => {},
  hostTurns = null,
  runtimeFactory = null,
}) {
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
      ...(runtimeFactory ? { runtimeFactory } : {}),
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
    hostTurns: hostTurns ?? createOmpHostTurnLifecycle(() => host),
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

/**
 * Read one execution's durable row straight from the real database (host-core
 * owns SQLite; the product reads it through `plans.*`). The assertion target is
 * the durable terminal state itself, never a proxy such as an empty queue.
 */
function readExecutionRow(dataRoot, executionId) {
  const db = new DatabaseSync(join(dataRoot, "pi.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT status, execution_state, error_code FROM plan_approvals WHERE execution_id = ?")
      .get(executionId);
  } finally {
    db.close();
  }
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
    // The production composition (`index.ts`): the bridge's turn-end
    // announcement is what settles an approved OMP execution, keyed by the
    // durable host turn. The negative control for a missing link is a
    // separate case below; here the real wiring is exercised.
    let planRuntime = null;
    const { bridge } = await buildBridge({
      host,
      dataRoot,
      project,
      provider,
      onTurnEnd: (info) => planRuntime?.settleOmpTurnEnd(info),
    });
    planRuntime = buildPlanRuntime({ host, bridge });

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

    // The execution row itself completed — read from the real database, never
    // inferred from an empty queue (a running row is not queued either).
    assert.equal(
      await waitFor(() => readExecutionRow(dataRoot, execution.id)?.execution_state === "completed", 10_000),
      true,
      "the durable execution row must be completed, not left running",
    );
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

/** Read one session's durable turn rows (read-only; host-core owns SQLite). */
function readTurnRows(dataRoot, sessionId) {
  const db = new DatabaseSync(join(dataRoot, "pi.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT id, status FROM turns WHERE session_id = ? ORDER BY rowid")
      .all(sessionId)
      .map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

test(
  "T20-B2 Stop during the durable host begin refuses the prompt before it is sent, settles its row aborted, and the next turn recovers",
  { timeout: 600_000, skip: READY ? false : "host-core binary or patched runtime not available" },
  async () => {
    const project = makeScratch("t20b2-stop-begin-project-");
    const dataRoot = makeScratch("t20b2-stop-begin-data-");
    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    const host = await startHost(dataRoot);
    const sessionId = await createSession(host, {
      title: "stop during begin",
      projectPath: project,
      mode: "agent",
    });

    // Controlled public seam: the begin hook creates the real durable row,
    // then performs and awaits the real user Stop, and only then delivers the
    // real id — the async window a Stop can really land in.
    const durableEnds = [];
    const turnEnds = [];
    const lifecycle = createOmpHostTurnLifecycle(() => host);
    let stopOutcome = null;
    let stopArmed = false;
    let triggered = false;
    let bridge = null;
    const built = await buildBridge({
      host,
      dataRoot,
      project,
      provider,
      onTurnEnd: (info) => turnEnds.push(info),
      hostTurns: {
        begin: async (input) => {
          const id = await lifecycle.begin(input);
          // The controlled boundary fires only for the negative attempt; the
          // control turn below must complete through the same seam untouched.
          if (stopArmed && !triggered) {
            triggered = true;
            stopOutcome = await bridge.stop(sessionId);
          }
          return id;
        },
        end: async (input) => {
          durableEnds.push({ ...input });
          return lifecycle.end(input);
        },
      },
    });
    bridge = built.bridge;
    const turns = () => readTurnRows(dataRoot, sessionId);
    const providerCount = () => provider.requests.filter((request) => request.method === "POST").length;

    // Positive control on the same fixture: a normal turn completes.
    provider.script([{ text: "control done", finish: "stop" }]);
    const control = await promptThrough(host, bridge, sessionId, "control turn");
    assert.equal(control.accepted, true);
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
    assert.equal(providerCount(), 1);
    assert.equal(turns().length, 1);
    assert.equal(turns()[0].status, "completed");
    assert.equal(control.hostTurnId, turns()[0].id, "the prompt result names the durable row it opened");

    // Negative: the Stop lands while the begin is in flight. No user content
    // may be written, and the already-created row must settle aborted once.
    const before = providerCount();
    stopArmed = true;
    await assert.rejects(
      () => promptThrough(host, bridge, sessionId, "must not reach the provider"),
      (error) => (error?.code ?? error?.errorCode) === "stopping",
    );
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
    assert.equal(await waitFor(() => turns().every((row) => row.status !== "running")), true);
    assert.equal(providerCount(), before, "the refused prompt must never reach the provider");
    assert.equal(turns().length, 2);
    assert.equal(turns()[1].status, "aborted", "the row created by the refused prompt settles aborted");
    assert.equal(
      durableEnds.filter((end) => end.turnId === turns()[1].id).length,
      1,
      "the aborted row settles exactly once",
    );
    assert.equal(stopOutcome?.converged, true);

    // Recovery on the same native identity: the cancelled generation must not
    // poison the next prompt.
    const { session: recoveredSession } = await host.call("session.get", { id: sessionId });
    const engineRef = (await host.call("session.getEngineRef", { id: sessionId })).engineRef;
    assert.ok(engineRef?.nativeSessionId, "the control turn persisted a native identity");
    provider.script([{ text: "recovered", finish: "stop" }]);
    const recovery = await bridge.prompt({
      sessionId,
      content: "genuine recovery after Stop",
      projectPath: project,
      providerId: recoveredSession.providerId,
      modelId: recoveredSession.modelId,
      thinkingLevel: recoveredSession.thinkingLevel,
      nativeSessionId: engineRef.nativeSessionId,
      nativeSessionPath: engineRef.nativeSessionPath,
      adapterVersion: engineRef.adapterVersion,
      runtimeVersion: engineRef.runtimeVersion,
    });
    assert.equal(recovery.accepted, true);
    assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
    assert.equal(providerCount(), before + 1);
    assert.equal(turns().length, 3);
    assert.equal(turns()[2].status, "completed");
    const engineRefAfter = (await host.call("session.getEngineRef", { id: sessionId })).engineRef;
    assert.equal(engineRefAfter.nativeSessionId, engineRef.nativeSessionId, "recovery keeps the same native session");
  },
);

test(
  "T20-B2 a real terminal delivered before the prompt response still closes its own durable host turn",
  { timeout: 600_000, skip: READY ? false : "host-core binary or patched runtime not available" },
  async () => {
    const run = async (strategy) => {
      const project = makeScratch(`t20b2-terminal-order-${strategy}-project-`);
      const dataRoot = makeScratch(`t20b2-terminal-order-${strategy}-data-`);
      const provider = await FakeProvider.start({ model: "local-model" });
      scratch.push({ close: () => provider.close?.() });
      const host = await startHost(dataRoot);
      const sessionId = await createSession(host, {
        title: `terminal order ${strategy}`,
        projectPath: project,
        mode: "agent",
      });

      // Controlled public seam: hold only the real user-prompt response until
      // the actual terminal frame arrives; no frame, result or row is forged.
      let terminalSeen = false;
      let heldPrompt = false;
      const runtimeFactory = async (options) => {
        const actual = await OmpRuntimeProcess.start(options);
        actual.onFrame((frame) => {
          if (frame.type === "agent_end" && frame.isTerminal !== false) terminalSeen = true;
        });
        return new Proxy(actual, {
          get(target, key) {
            if (key === "request") {
              return (command, requestOptions) => {
                const shouldHold =
                  strategy !== "control" &&
                  !heldPrompt &&
                  command.type === "prompt" &&
                  !turnCommandToken(command.message);
                if (shouldHold) heldPrompt = true;
                const pending = target.request(command, requestOptions);
                if (!shouldHold) return pending;
                return pending.then(async (response) => {
                  assert.equal(
                    await waitFor(() => terminalSeen === true, 30_000),
                    true,
                    "the real terminal frame must have arrived before the held response is delivered",
                  );
                  return response;
                });
              };
            }
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };

      const ends = [];
      const { bridge } = await buildBridge({
        host,
        dataRoot,
        project,
        provider,
        runtimeFactory,
        onTurnEnd: (info) => ends.push(info),
      });
      const turns = () => readTurnRows(dataRoot, sessionId);
      const providerCount = () => provider.requests.filter((request) => request.method === "POST").length;

      provider.script([{ text: "REAL-INITIAL", finish: "stop" }]);
      const prompt = await promptThrough(host, bridge, sessionId, `initial ${strategy}`);
      assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
      assert.equal(prompt.accepted, true);
      assert.equal(providerCount(), 1);
      assert.equal(turns().length, 1);
      assert.equal(
        turns()[0].status,
        "completed",
        "the terminal must close its own durable row even when it precedes the prompt response",
      );
      assert.equal(prompt.hostTurnId, turns()[0].id);
      assert.equal(ends.length, 1);
      assert.equal(ends[0].hostTurnId, turns()[0].id, "the announcement carries the run's own durable id");
      assert.equal(ends[0].reason, "completed");
      if (strategy !== "control") {
        assert.equal(heldPrompt, true, "the controlled seam must have held the real prompt response");
      }

      // The next prompt on the same native identity must run normally.
      const { session: recoveredSession } = await host.call("session.get", { id: sessionId });
      const engineRef = (await host.call("session.getEngineRef", { id: sessionId })).engineRef;
      provider.script([{ text: "REAL-RECOVERY", finish: "stop" }]);
      const recovery = await bridge.prompt({
        sessionId,
        content: "genuine next prompt",
        projectPath: project,
        providerId: recoveredSession.providerId,
        modelId: recoveredSession.modelId,
        thinkingLevel: recoveredSession.thinkingLevel,
        nativeSessionId: engineRef?.nativeSessionId ?? null,
        nativeSessionPath: engineRef?.nativeSessionPath ?? null,
        adapterVersion: engineRef?.adapterVersion ?? null,
        runtimeVersion: engineRef?.runtimeVersion ?? null,
      });
      assert.equal(recovery.accepted, true);
      assert.equal(await waitFor(() => bridge.status(sessionId).isRunning === false), true);
      assert.equal(providerCount(), 2);
      assert.equal(turns().length, 2);
      assert.equal(turns()[1].status, "completed");
      assert.equal(ends.length, 2);
      assert.equal(ends[1].hostTurnId, turns()[1].id);
      return { dataRoot, sessionId };
    };

    await run("control");
    await run("terminal-before-prompt-response-delivery");
  },
);

test(
  "T20-B2 an approved execution settles from a terminal that beats the dispatch prompt return, and a refused begin interrupts it",
  { timeout: 600_000, skip: READY ? false : "host-core binary or patched runtime not available" },
  async () => {
    const project = makeScratch("t20b2-dispatch-order-project-");
    const dataRoot = makeScratch("t20b2-dispatch-order-data-");
    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    const host = await startHost(dataRoot);

    // Controlled begin seam: the dispatch case lets the real row/id through;
    // the refusal case makes the next begin fail before any row exists.
    let failNextBegin = false;
    const lifecycle = createOmpHostTurnLifecycle(() => host);
    const ends = [];
    let planRuntime = null;
    let holdDispatchPrompt = false;
    let endBeforeDispatchReturn = null;
    const built = await buildBridge({
      host,
      dataRoot,
      project,
      provider,
      onTurnEnd: (info) => {
        ends.push(info);
        planRuntime?.settleOmpTurnEnd(info);
      },
      hostTurns: {
        begin: async (input) => {
          if (failNextBegin) {
            failNextBegin = false;
            throw new Error("controlled begin refusal");
          }
          return lifecycle.begin(input);
        },
        end: async (input) => lifecycle.end(input),
      },
    });
    const bridge = built.bridge;
    // The composition seam: the dispatch caller's view of the real
    // `bridge.prompt` result is held until the real terminal with the correct
    // durable id has been delivered — no terminal, result or row is forged.
    const dispatchBridge = new Proxy(bridge, {
      get(target, key) {
        if (key === "prompt") {
          return async (input) => {
            const actual = await target.prompt(input);
            if (holdDispatchPrompt) {
              assert.equal(
                await waitFor(() => ends.some((end) => end.hostTurnId === actual.hostTurnId), 30_000),
                true,
                "the real terminal must arrive while the dispatch prompt result is still held",
              );
              endBeforeDispatchReturn = structuredClone(
                ends.find((end) => end.hostTurnId === actual.hostTurnId),
              );
            }
            return actual;
          };
        }
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    // Two real dispatch instances: the shared host CAS, not one in-memory set,
    // arbitrates which may prompt.
    const runtimes = [
      buildPlanRuntime({ host, bridge: dispatchBridge }),
      buildPlanRuntime({ host, bridge: dispatchBridge }),
    ];
    planRuntime = runtimes[0];
    const turns = (sessionId) => readTurnRows(dataRoot, sessionId);
    const providerCount = () => provider.requests.filter((request) => request.method === "POST").length;

    const submitAndApprove = async (sessionId) => {
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
      assert.equal(resolved.execution.state, "queued");
      return resolved.execution;
    };

    // --- held dispatch: the terminal arrives before the prompt return -------
    const heldSession = await createSession(host, {
      title: "held dispatch",
      projectPath: project,
      mode: "plan",
    });
    const heldExecution = await submitAndApprove(heldSession);
    provider.script([
      {
        toolCalls: [
          { id: "held-approved-bash", name: "bash", args: { command: "printf approved > approved-marker.txt" } },
        ],
        finish: "tool_calls",
      },
      { text: "approved execution complete", finish: "stop" },
    ]);
    const beforeHeld = providerCount();
    holdDispatchPrompt = true;
    await Promise.all(runtimes.map((runtime) => runtime.dispatchApprovedPlan(heldExecution)));
    assert.equal(
      await waitFor(() => readExecutionRow(dataRoot, heldExecution.id)?.execution_state === "completed"),
      true,
      "the execution must complete from the early terminal, not stay running",
    );
    assert.equal(providerCount(), beforeHeld + 2, "one tool round plus the final text");
    assert.equal(existsSync(join(project, "approved-marker.txt")), true);
    assert.equal(endBeforeDispatchReturn?.reason, "completed");
    assert.equal(endBeforeDispatchReturn?.sessionId, heldSession);
    assert.equal(turns(heldSession).every((row) => row.status === "completed"), true);
    assert.equal(turns(heldSession).length, 2, "submit turn plus execution turn");
    assert.equal(
      endBeforeDispatchReturn?.hostTurnId,
      turns(heldSession)[1]?.id,
      "the early terminal names the execution's own durable turn",
    );
    // The execution's durable host turn is the one the early terminal named.
    assert.equal(
      readExecutionRow(dataRoot, heldExecution.id)?.execution_state,
      "completed",
      "the durable terminal state itself",
    );
    const queuedHeld = (await host.call("plans.queuedExecutions", { sessionId: heldSession })).executions;
    assert.equal(queuedHeld.length, 0);
    await runtimes[0].drainApprovedPlanExecutions();
    await runtimes[1].dispatchApprovedPlan(heldExecution);
    assert.equal(providerCount(), beforeHeld + 2, "a completed execution never replays");
    holdDispatchPrompt = false;

    // --- refused begin: the execution is interrupted before any provider ----
    const refusedSession = await createSession(host, {
      title: "refused begin",
      projectPath: project,
      mode: "plan",
    });
    const refusedExecution = await submitAndApprove(refusedSession);
    const beforeRefused = providerCount();
    failNextBegin = true;
    await Promise.all(runtimes.map((runtime) => runtime.dispatchApprovedPlan(refusedExecution)));
    assert.equal(
      await waitFor(() => readExecutionRow(dataRoot, refusedExecution.id)?.execution_state === "interrupted"),
      true,
      "a refused durable begin must leave the execution interrupted, never running",
    );
    assert.equal(providerCount(), beforeRefused, "a refused begin must not reach the provider");
    assert.equal(turns(refusedSession).length, 1, "no durable turn row is left behind by the refusal");
    assert.equal(turns(refusedSession)[0].status, "completed", "only the submit turn exists and it is settled");
    await runtimes[0].drainApprovedPlanExecutions();
    assert.equal(providerCount(), beforeRefused, "an interrupted execution never replays");
  },
);
