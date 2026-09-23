import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
import * as protocol from "../../../packages/shared/src/protocol.ts";

/**
 * T17 subagent surface: the bridge's list/read/stop methods, and the IPC paths
 * that reach them. The runtime is a scripted fake; the real runtime is
 * exercised in `omp-subagent-e2e.test.mjs`.
 *
 * Two ownership boundaries are proven here without a live runtime:
 *
 *   - `get_subagent_messages` reads a child's transcript by opaque id and
 *     returns only the cursor plus mapped rows: the native `sessionFile` is
 *     consumed inside the bridge and never crosses back out.
 *   - The OMP subagent IPC channels are OMP-only: a Pi session is refused with
 *     a typed capability error before anything is called, so the Pi subagent
 *     catalog channels (`subagentList` etc.) stay owned by the Pi path.
 */
const { IPC } = protocol;

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { registerAgentIpc } = await import("../electron/main/ipc/agent-ipc.ts");
const { createEngineRouter } = await import("../electron/main/runtime/engine-router.ts");

const OMP_SESSION = "session-omp-subagent";
const NATIVE_PATH = "/abs/native/child-session.jsonl";

const scratch = [];
after(() => {
  for (const entry of scratch.splice(0)) rmSync(entry, { recursive: true, force: true });
});

function makeProject() {
  const path = mkdtempSync(join(tmpdir(), "omp-subagent-project-"));
  scratch.push(path);
  return path;
}

class SubagentRuntime {
  pid = 4321;
  usable = true;
  commands = [];
  frames = new Set();
  /** Scripted `get_subagents` response. */
  snapshots = [];
  /** Scripted `get_subagent_messages` response. */
  transcript = null;
  /** Native session path the `get_state` response reports (inside the session dir). */
  statePath = "/tmp/native.jsonl";
  /** When true, `set_subagent_subscription` is refused (R7 fail-closed path). */
  refuseSubscription = false;

  async request(command) {
    this.commands.push(command.type);
    if (command.type === "set_subagent_subscription") {
      if (this.refuseSubscription) return { success: false, error: "subscription refused" };
      return { success: true, data: { level: command.level } };
    }
    if (command.type === "prompt") {
      return { success: true, data: { agentInvoked: true } };
    }
    if (command.type === "new_session") {
      return { success: true, data: { cancelled: false } };
    }
    if (command.type === "get_state") {
      return { success: true, data: { sessionId: "native-id", sessionFile: this.statePath, sessionName: "session" } };
    }
    if (command.type === "switch_session") {
      return { success: true, data: { cancelled: false } };
    }
    if (command.type === "get_subagents") {
      return { success: true, data: { subagents: this.snapshots } };
    }
    if (command.type === "get_subagent_messages") {
      return { success: true, data: this.transcript };
    }
    return { success: true };
  }

  write() {
    return this.usable;
  }

  onFrame(handler) {
    this.frames.add(handler);
    return () => this.frames.delete(handler);
  }

  onFailure() {
    return () => undefined;
  }

  push(frame) {
    for (const handler of [...this.frames]) handler(frame);
  }
}

function fakeSupervisor(runtime) {
  return {
    started: 0,
    calls: [],
    setWorkingDirectory(path) {
      this.calls.push(`setWorkingDirectory:${path}`);
    },
    status() {
      return {
        engine: "omp",
        phase: this.started > 0 ? "idle" : "stopped",
        runtimeVersion: this.started > 0 ? "18.2.7" : null,
        protocolVersion: this.started > 0 ? 2 : null,
        reason: this.started > 0 ? null : "not-started",
        capabilities: {},
      };
    },
    async start() {
      this.calls.push("start");
      this.started += 1;
      return this.status();
    },
    async stop() {
      return { reaped: true, cleaned: true };
    },
    currentRuntime: () => (runtime.usable ? runtime : null),
    async reclaimAll() {
      return [];
    },
  };
}

function harness() {
  const sessionDir = mkdtempSync(join(tmpdir(), "omp-subagent-sessions-"));
  scratch.push(sessionDir);
  const nativePath = join(sessionDir, "native-session.jsonl");
  writeFileSync(nativePath, JSON.stringify({ type: "session", id: "native-id", cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  const runtime = new SubagentRuntime();
  runtime.statePath = nativePath;
  const supervisor = fakeSupervisor(runtime);
  const envelopes = [];
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
    isPackaged: false,
    appPath: here,
    sessionDir,
    emitAgentEvent: (envelope) => envelopes.push(envelope),
    logger: { app: () => undefined },
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
  });
  return { bridge, runtime, supervisor, envelopes, sessionDir, nativePath };
}

function ipcHarness({ bridge, sessionEngine }) {
  const handlers = new Map();
  registerAgentIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
    getHost: () => ({ async call() { return {}; } }),
    getSidecar: () => null,
    getAgentHostBridge: () => null,
    ompSessions: bridge,
    logger: { app: () => undefined },
    vendorOAuth: {},
    agentExtensions: { cancelPrompts: () => undefined },
    cancelSessionTools: () => undefined,
    persistenceOutbox: {},
    dataDir: "/tmp",
    activeTurns: new Map(),
    isTurnDispatchable: () => true,
    activeTurnUsages: new Map(),
    approvedExecutionIdsBySession: new Map(),
    claimedExecutionSessions: new Map(),
    resolveAgentRuntimeLaunch: async () => ({ projectPath: "/tmp", sidecarParams: {} }),
    engineRouter: createEngineRouter({
      status: (engine) => ({ engine, phase: "idle", runtimeVersion: null, protocolVersion: null, reason: null, capabilities: {} }),
      sessionEngine: async () => sessionEngine,
    }),
    acquireSessionOperation: async () => () => undefined,
    finishTurn: async () => undefined,
    lockAbortReason: () => undefined,
    finishApprovedExecution: async () => undefined,
    dispatchApprovedPlan: async () => undefined,
    dispatchExecutionForProposal: async () => undefined,
    emitAgentEvent: () => undefined,
    setNotificationViewingSessionId: () => undefined,
    optionalWorkspaceRoot: async () => null,
    composerCommandService: { buildComposerCommands: async () => [] },
    loadComposerTemplatesCached: async () => [],
  });
  return handlers;
}

test("listSubagents returns the live snapshot, reconciled into the registry", async () => {
  const { bridge, runtime } = harness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "delegate", projectPath: project });
  // Ownership is fail-closed: the child's parent must name an observed task call.
  runtime.push({ type: "tool_execution_start", toolCallId: "call-task-1", toolName: "task", args: { task: "t" } });

  runtime.snapshots = [
    { id: "child-1", index: 0, agent: "scout", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" },
  ];
  const list = await bridge.listSubagents(OMP_SESSION);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "child-1");
  assert.equal(list[0].agent, "scout");
  // No native path may leak into the list.
  assert.equal("sessionFile" in list[0], false);
  assert.ok(runtime.commands.includes("get_subagents"));
});

test("readSubagentTranscript maps messages and never discloses the sessionFile", async () => {
  const { bridge, runtime } = harness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "delegate", projectPath: project });
  runtime.push({ type: "tool_execution_start", toolCallId: "call-task-1", toolName: "task", args: { task: "t" } });

  // Register the child so the read can resolve its attribution.
  runtime.snapshots = [
    { id: "child-1", index: 0, agent: "scout", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" },
  ];
  await bridge.listSubagents(OMP_SESSION);

  runtime.transcript = {
    sessionFile: NATIVE_PATH,
    fromByte: 0,
    nextByte: 42,
    reset: false,
    entries: [
      { type: "message", id: "entry-1", parentId: null, timestamp: "2026-09-23T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "report ALPHA" }], timestamp: 1 } },
    ],
    messages: [
      { role: "assistant", content: [{ type: "text", text: "report ALPHA" }], timestamp: 1 },
    ],
  };
  const result = await bridge.readSubagentTranscript(OMP_SESSION, "child-1");
  assert.equal(result.cursor.fromByte, 0);
  assert.equal(result.cursor.nextByte, 42);
  assert.equal(result.cursor.reset, false);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].content, "report ALPHA");
  assert.equal(JSON.stringify(result).includes(NATIVE_PATH), false, "the native session path must not cross the bridge");
});

test("readSubagentTranscript forwards the reset flag and cursor from a malformed-looking but valid result", async () => {
  const { bridge, runtime } = harness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "delegate", projectPath: project });
  runtime.push({ type: "tool_execution_start", toolCallId: "call-task-1", toolName: "task", args: { task: "t" } });

  runtime.snapshots = [
    { id: "child-1", index: 0, agent: "scout", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" },
  ];
  await bridge.listSubagents(OMP_SESSION);

  // `reset: true` means the cursor was ahead of the file; the caller must see it.
  runtime.transcript = { sessionFile: NATIVE_PATH, fromByte: 0, nextByte: 10, reset: true, entries: [], messages: [] };
  const result = await bridge.readSubagentTranscript(OMP_SESSION, "child-1", 999);
  assert.equal(result.cursor.reset, true);
  assert.equal(result.cursor.fromByte, 0);
});

test("stopSubagent is refused with an accurate capability-unavailable reason", async () => {
  const { bridge } = harness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "delegate", projectPath: project });

  const result = bridge.stopSubagent(OMP_SESSION, "child-1");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "capability-unavailable");
  assert.match(result.detail, /no per-child stop command/);
});

test("the OMP subagent IPC channels serve an OMP session", async () => {
  const { bridge, runtime } = harness();
  const project = makeProject();
  await bridge.prompt({ sessionId: OMP_SESSION, content: "delegate", projectPath: project });
  runtime.push({ type: "tool_execution_start", toolCallId: "call-task-1", toolName: "task", args: { task: "t" } });

  runtime.snapshots = [
    { id: "child-1", index: 0, agent: "scout", agentSource: "bundled", status: "running", lastUpdate: 1, parentToolCallId: "call-task-1" },
  ];
  const handlers = ipcHarness({ bridge, sessionEngine: "omp" });

  const list = await handlers.get(IPC.invoke.ompSubagentList)(OMP_SESSION);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, "child-1");

  const stop = await handlers.get(IPC.invoke.ompSubagentStop)({ sessionId: OMP_SESSION, subagentId: "child-1" });
  assert.equal(stop.ok, false);
  assert.equal(stop.reason, "capability-unavailable");
});

test("the OMP subagent IPC channels refuse a Pi session without touching Pi", async () => {
  const { bridge } = harness();
  const handlers = ipcHarness({ bridge, sessionEngine: "pi" });

  await assert.rejects(
    () => handlers.get(IPC.invoke.ompSubagentList)("session-pi"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && error.capability === "subagentEvents",
  );
});

test("a refused subscription makes list/read fail closed with a typed capability error", async () => {
  const { bridge, runtime } = harness();
  const project = makeProject();
  // The prompt still succeeds (only the child surface is unavailable), but the
  // subscription is refused by the runtime.
  runtime.refuseSubscription = true;
  await bridge.prompt({ sessionId: OMP_SESSION, content: "delegate", projectPath: project });

  await assert.rejects(
    () => bridge.listSubagents(OMP_SESSION),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && error.capability === "subagentEvents",
  );
  await assert.rejects(
    () => bridge.readSubagentTranscript(OMP_SESSION, "child-1"),
    (error) => error.errorCode === ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE && error.capability === "subagentEvents",
  );
});

test("the Pi subagent catalog channel is untouched by the OMP surface", async () => {
  // The Pi catalog channel (`subagentList`) is a different surface. Registering
  // the OMP handlers must not have claimed or shadowed it.
  const handlers = ipcHarness({ bridge: null, sessionEngine: "omp" });
  assert.equal(handlers.has(IPC.invoke.ompSubagentList), true);
  assert.equal(handlers.has(IPC.invoke.subagentList), false, "the Pi subagent catalog channel stays in the Pi IPC module");
});
