/**
 * T19-B probes: the session bridge must register the session's desktop tool
 * catalog through `set_host_tools` before the first prompt, fail closed on a
 * mismatched or refused registration, and route `host_tool_call` frames to the
 * injected executor.
 *
 * These probes run against the bridge as it exists on the T19-B baseline
 * (`93ee82b`): the host-tool options are passed as plain fields the baseline
 * bridge ignores, so every assertion below fails on real, observable behavior —
 * no `set_host_tools` command is ever sent, a refused/mismatched registration
 * is never checked, and a `host_tool_call` is never executed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { OmpSessionRunner } = await import("../../../packages/omp-runtime/src/session/runner.ts");

/** Every temporary directory this file creates, removed in `after`. */
const scratch = [];
after(() => {
  for (const entry of scratch.splice(0)) rmSync(entry, { recursive: true, force: true });
});

function makeProject() {
  const path = mkdtempSync(join(tmpdir(), "omp-host-bridge-project-"));
  scratch.push(path);
  return path;
}

/** A runtime the bridge can write to, with scriptable command answers. */
class FakeRuntime {
  pid = 4321;
  usable = true;
  written = [];
  commands = [];
  /** Scripted answer for `set_host_tools` (set before the prompt). */
  hostToolResponse = undefined;
  #frames = new Set();
  #failures = new Set();

  write(frame) {
    this.written.push(frame);
    return this.usable;
  }

  async request(command) {
    this.commands.push(command);
    if (command.type === "set_host_tools") {
      if (this.hostToolResponse) return this.hostToolResponse;
      return { success: true, data: { toolNames: command.tools.map((tool) => tool.name) } };
    }
    if (command.type === "new_session") return { success: true, data: { cancelled: false } };
    if (command.type === "get_state") {
      return { success: true, data: { sessionId: "native-id", sessionFile: this.nativeSessionPath, sessionName: "session" } };
    }
    if (command.type === "switch_session") return { success: true, data: { cancelled: false } };
    if (command.type === "set_session_name") return { success: true };
    return { success: true };
  }

  onFrame(handler) {
    this.#frames.add(handler);
    return () => this.#frames.delete(handler);
  }

  onFailure(handler) {
    this.#failures.add(handler);
    return () => this.#failures.delete(handler);
  }

  push(frame) {
    for (const handler of [...this.#frames]) handler(frame);
  }

  fail() {
    this.usable = false;
    for (const handler of [...this.#failures]) handler({ code: "transport-failed", message: "stream broken" });
  }
}

function fakeSupervisor(runtime) {
  return {
    started: 0,
    setWorkingDirectory() {},
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
      this.started += 1;
      return this.status();
    },
    async stop() {
      return { reaped: true, cleaned: true, escalated: "none", steps: ["fake stop"], abortAcknowledged: true, errors: [] };
    },
    currentRuntime: () => (runtime.usable ? runtime : null),
    async reclaimAll() {
      return [];
    },
  };
}

/** The T19-B seam, shaped the way the bridge consumes it. */
function hostToolsFixture({ toolsByProject = {} } = {}) {
  const catalogsRequested = [];
  const executions = [];
  const bindings = [];
  return {
    catalogsRequested,
    executions,
    bindings,
    hostTools: {
      catalog: async (projectPath) => {
        catalogsRequested.push(projectPath);
        return toolsByProject[projectPath] ?? [];
      },
      executor: (binding) => {
        bindings.push(binding);
        return {
          execute: async (call) => {
            executions.push(call);
            return { content: [{ type: "text", text: `echo:${String(call.arguments?.text ?? "")}` }] };
          },
        };
      },
    },
  };
}

function bridgeHarness({ toolsByProject, persistConfigFailure } = {}) {
  const hostTools = hostToolsFixture({ toolsByProject });
  const turnEnds = [];
  const persistedConfigs = [];
  const runtimes = [];
  const sessionDir = mkdtempSync(join(tmpdir(), "omp-host-bridge-sessions-"));
  scratch.push(sessionDir);
  const nativeSessionId = "native-id";
  const nativeSessionPath = join(sessionDir, "native-session.jsonl");
  writeFileSync(nativeSessionPath, JSON.stringify({ type: "session", id: nativeSessionId, cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");
  const firstRuntime = new FakeRuntime();
  firstRuntime.nativeSessionPath = nativeSessionPath;
  const firstSupervisor = fakeSupervisor(firstRuntime);
  runtimes.push(firstRuntime);
  let created = 1;
  const bridge = createOmpSessionBridge({
    createSupervisor: () => {
      if (created === 1) {
        created += 1;
        return firstSupervisor;
      }
      const runtime = new FakeRuntime();
      runtime.nativeSessionPath = nativeSessionPath;
      const supervisor = fakeSupervisor(runtime);
      runtimes.push(runtime);
      created += 1;
      return supervisor;
    },
    launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    // A fast convergence window keeps the stop-shaped probes off wall-clock.
    runnerFactory: (options) =>
      new OmpSessionRunner({ ...options, convergeTimeoutMs: 200, abortTimeoutMs: 100 }),
    emitAgentEvent: () => undefined,
    logger: { app: () => undefined },
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
    persistConfig: async (info) => {
      if (persistConfigFailure) throw new Error(persistConfigFailure);
      persistedConfigs.push(info);
    },
    onTurnEnd: (info) => turnEnds.push(info),
    ...hostTools,
  });
  return { bridge, runtime: firstRuntime, runtimes, sessionDir, turnEnds, persistedConfigs, ...hostTools };
}

const ECHO_TOOL = {
  name: "plugin_demo_echo",
  description: "Echo text back to the model",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

test("the bridge registers the project's catalog through set_host_tools before the first prompt", async () => {
  const project = makeProject();
  const { bridge, runtime, catalogsRequested } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });

  const setTools = runtime.commands.find((command) => command.type === "set_host_tools");
  const prompt = runtime.commands.find((command) => command.type === "prompt");
  assert.ok(setTools, "set_host_tools must be sent before any prompt");
  assert.ok(prompt, "the prompt must run");
  assert.ok(
    runtime.commands.indexOf(setTools) < runtime.commands.indexOf(prompt),
    "set_host_tools must precede the prompt",
  );
  assert.deepEqual(setTools.tools, [ECHO_TOOL]);
  assert.deepEqual(catalogsRequested, [project]);

  // An unchanged catalog across prompts is skipped by fingerprint: the
  // runtime already holds exactly this set, so nothing is re-sent.
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });
  assert.equal(runtime.commands.filter((command) => command.type === "set_host_tools").length, 1);
});

test("a catalog change between turns re-registers the new tool set on the same runner", async () => {
  const project = makeProject();
  const toolsByProject = { [project]: [ECHO_TOOL] };
  const { bridge, runtime } = bridgeHarness({ toolsByProject });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));

  // The Pi host reassembles the catalog per launch: a newly installed tool is
  // visible to the very next turn on the same runner and native session.
  const added = {
    name: "mcp_newserver_ping",
    description: "A newly added MCP tool",
    parameters: { type: "object", properties: {} },
  };
  toolsByProject[project] = [ECHO_TOOL, added];
  await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });

  const registrations = runtime.commands.filter((command) => command.type === "set_host_tools");
  assert.equal(registrations.length, 2, "the changed catalog must be registered again");
  assert.deepEqual(
    registrations[1].tools.map((tool) => tool.name),
    ["plugin_demo_echo", "mcp_newserver_ping"],
    "the second registration must carry the replaced tool set",
  );
  assert.equal(
    new Set(registrations[1].tools.map((tool) => tool.name)).size,
    registrations[1].tools.length,
    "no tool may be exposed twice within one catalog",
  );
});

test("a tool removed from the catalog is removed from the next registration too", async () => {
  const project = makeProject();
  const added = {
    name: "mcp_newserver_ping",
    description: "A newly added MCP tool",
    parameters: { type: "object", properties: {} },
  };
  const toolsByProject = { [project]: [ECHO_TOOL, added] };
  const { bridge, runtime } = bridgeHarness({ toolsByProject });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));

  // Uninstall the MCP server: the next turn must register only what remains.
  toolsByProject[project] = [ECHO_TOOL];
  await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });

  const registrations = runtime.commands.filter((command) => command.type === "set_host_tools");
  assert.equal(registrations.length, 2);
  assert.deepEqual(
    registrations[1].tools.map((tool) => tool.name),
    ["plugin_demo_echo"],
    "the removed tool must be gone from the replaced tool set",
  );

  // And an emptied catalog registers an empty set, removing every host tool.
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  toolsByProject[project] = [];
  await bridge.prompt({ sessionId: "session-omp", content: "once more", projectPath: project });
  const registrationsAfter = runtime.commands.filter((command) => command.type === "set_host_tools");
  assert.equal(registrationsAfter.length, 3);
  assert.deepEqual(registrationsAfter[2].tools, [], "an empty catalog must replace every host tool with nothing");
});

test("a registration whose echoed names differ from the request fails the prompt closed", async () => {
  const project = makeProject();
  const { bridge, runtime } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  runtime.hostToolResponse = { success: true, data: { toolNames: ["something-else"] } };

  await assert.rejects(
    () => bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project }),
    (error) => /host tool|registration|set_host_tools/i.test(String(error?.message ?? error)),
  );
  assert.equal(runtime.commands.some((command) => command.type === "prompt"), false, "no prompt may run after a mismatched registration");
});

test("a runtime refusal of set_host_tools fails the prompt closed", async () => {
  const project = makeProject();
  const { bridge, runtime } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  runtime.hostToolResponse = {
    success: false,
    error: 'RPC host tool "plugin_demo_echo" conflicts with an existing tool',
  };

  await assert.rejects(
    () => bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project }),
    (error) => /conflicts|refused/i.test(String(error?.message ?? error)),
  );
  assert.equal(runtime.commands.some((command) => command.type === "prompt"), false, "no prompt may run after a refused registration");
});

test("a host_tool_call during a prompt is executed exactly once and its result written", async () => {
  const project = makeProject();
  const { bridge, runtime, executions } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  await bridge.prompt({ sessionId: "session-omp", content: "call the desktop tool", projectPath: project });

  const frame = {
    type: "host_tool_call",
    id: "host-1",
    toolCallId: "tc-1",
    toolName: "plugin_demo_echo",
    arguments: { text: "from-model" },
  };
  runtime.push(frame);
  runtime.push({ ...frame });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(executions.length, 1, "the call must execute exactly once");
  const results = runtime.written.filter((written) => written.type === "host_tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "host-1");
  assert.equal(results[0].result.content[0].text, "echo:from-model");
});

test("two sessions on different projects get different catalogs and cannot share them", async () => {
  const first = makeProject();
  const second = makeProject();
  const otherTool = {
    name: "mcp_other_ping",
    description: "Another project's tool",
    parameters: { type: "object", properties: {} },
  };
  const { bridge, runtimes, catalogsRequested } = bridgeHarness({
    toolsByProject: { [first]: [ECHO_TOOL], [second]: [otherTool] },
  });
  await bridge.prompt({ sessionId: "session-a", content: "hello", projectPath: first });
  await bridge.prompt({ sessionId: "session-b", content: "hi", projectPath: second });

  assert.equal(runtimes.length, 2);
  const setTools = runtimes.map((runtime) => runtime.commands.find((command) => command.type === "set_host_tools"));
  assert.ok(setTools.every(Boolean), "each session's runtime must receive set_host_tools");
  assert.deepEqual(setTools[0].tools, [ECHO_TOOL]);
  assert.deepEqual(setTools[1].tools, [otherTool]);
  assert.deepEqual(catalogsRequested.sort(), [first, second].sort());
});

test("a host_tool_call with no active run is answered isError and never executed", async () => {
  const project = makeProject();
  const { bridge, runtime, executions } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  // A live runtime with an idle runner: the bridge exists, but no run is in
  // flight when the call arrives.
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  runtime.push({
    type: "host_tool_call",
    id: "host-idle",
    toolCallId: "tc-idle",
    toolName: "plugin_demo_echo",
    arguments: {},
  });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(executions.length, 0);
  const results = runtime.written.filter((written) => written.type === "host_tool_result");
  assert.equal(results.length, 1);
  assert.equal(results[0].id, "host-idle");
  assert.equal(results[0].isError, true);
});

test("a normal agent_end announces the turn completed exactly once", async () => {
  const project = makeProject();
  const { bridge, runtime, turnEnds } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  const started = await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  runtime.push({ type: "agent_end", messages: [] });
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(turnEnds, [
    { sessionId: "session-omp", turnId: started.turnId, reason: "completed" },
  ]);
});

test("a stop whose run settles with agent_end announces aborted, never completed", async () => {
  const project = makeProject();
  const { bridge, runtime, turnEnds } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const stopping = bridge.stop("session-omp");
  runtime.push({ type: "agent_end", messages: [] });
  await stopping;

  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].reason, "aborted");
});

test("a stop whose run is torn down announces aborted exactly once", async () => {
  const project = makeProject();
  const { bridge, turnEnds } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  await bridge.stop("session-omp");

  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].reason, "aborted");
});

test("a transport failure announces error exactly once", async () => {
  const project = makeProject();
  const { bridge, runtime, turnEnds } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  runtime.fail();
  await new Promise((resolve) => setImmediate(resolve));
  runtime.fail();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].reason, "error");
});

test("a dispose with a live turn announces aborted exactly once", async () => {
  const project = makeProject();
  const { bridge, turnEnds } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  await bridge.disposeSession("session-omp", "test teardown");
  await bridge.disposeSession("session-omp", "test teardown again");

  assert.equal(turnEnds.length, 1);
  assert.equal(turnEnds[0].reason, "aborted");
});

test("the entry's dispatch gate reads the live runner state", async () => {
  const project = makeProject();
  const { bridge, bindings } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });

  const started = await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const binding = bindings[0];
  assert.ok(binding, "the executor binding must be captured when the entry is built");
  assert.equal(binding.dispatchable(started.turnId), true, "the live turn must be dispatchable");
  assert.equal(binding.dispatchable("wrong-turn"), false, "a wrong turn id must not be dispatchable");

  await bridge.stop("session-omp");
  assert.equal(binding.dispatchable(started.turnId), false, "a stopped turn must not be dispatchable");
});

test("the executor binding reads the live thinking level after an online configure", async () => {
  const project = makeProject();
  const { bridge, bindings } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
  });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const binding = bindings[0];
  assert.equal(binding.thinkingLevel(), null);

  const changed = await bridge.configure("session-omp", { thinkingLevel: "high" });
  assert.equal(changed.ok, true);
  assert.equal(binding.thinkingLevel(), "high", "the same entry's executor must see the new level");

  const back = await bridge.configure("session-omp", { thinkingLevel: "off" });
  assert.equal(back.ok, true);
  assert.equal(binding.thinkingLevel(), "off", "the getter must track the reverted level too");
});

test("a failed thinking persist keeps the binding on the old level", async () => {
  const project = makeProject();
  const { bridge, bindings } = bridgeHarness({
    toolsByProject: { [project]: [ECHO_TOOL] },
    persistConfigFailure: "host write failed",
  });
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const binding = bindings[0];

  // The persist fails, so configure reverts the runtime level and never
  // mutates the entry's binding: the getter must still answer the old level.
  const changed = await bridge.configure("session-omp", { thinkingLevel: "high" });
  assert.equal(changed.ok, false);
  assert.equal(binding.thinkingLevel(), null, "a rolled-back configure must not leak the new level");
});
