/**
 * T19-B probes against the *pinned* OMP 18.2.7 runtime: the three desktop tool
 * classes must be registered once per session through `set_host_tools`,
 * execute exactly once when the model calls them, and feed their real results
 * back into the model context — while a cancelled call leaves no late side
 * effect and the workspace MCP decoy stays undiscovered (T19-A regression).
 *
 * On the T19-B baseline (`93ee82b`) the bridge ignores the host-tool seams, so
 * the scenarios below fail on observable behavior: the model's tool calls
 * never execute, no result ever reaches the provider, and the decoy scenario's
 * bounded run never registers a single desktop tool.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const {
  OmpRuntimeSupervisor,
  ensureSessionStateDir,
  findGateExtension,
  findPinnedLauncher,
} = await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");
// The production adapter only exists once T19-B lands. On a clean baseline
// the load guard leaves the provider absent — the bridge then never registers
// anything, which is the observable red — instead of substituting a test-only
// mapping. On every real build the production adapter below is what runs.
let createOmpHostToolAdapter = null;
try {
  ({ createOmpHostToolAdapter } = await import("../electron/main/runtime/omp-host-tools.ts"));
} catch {
  createOmpHostToolAdapter = null;
}

const LAUNCHER = findPinnedLauncher(here);
const GATE = findGateExtension(here);

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

/** A stdio MCP server that counts every tools/call and echoes a tag. */
const MCP_STUB = `
import { appendFileSync, writeFileSync } from "node:fs";
if (process.env.STUB_PID_FILE) writeFileSync(process.env.STUB_PID_FILE, String(process.pid));
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\\n");
process.stdin.setEncoding("utf8");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\\n");
  }
});
function handle(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} } } });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "lookup", description: "Look something up" }, { name: "ping" }] } });
    return;
  }
  if (msg.method === "tools/call") {
    appendFileSync(process.env.STUB_CALL_FILE, "1");
    const tag = process.env.STUB_TAG ?? "untagged";
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: tag + ":" + msg.params.name }] } });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
}
`;

function writeMcpStub(dir, tag) {
  const script = join(dir, "server.mjs");
  writeFileSync(script, MCP_STUB);
  return {
    script,
    callFile: join(dir, `${tag}.calls`),
    pidFile: join(dir, `${tag}.pid`),
    env: { STUB_TAG: tag, STUB_CALL_FILE: join(dir, `${tag}.calls`), STUB_PID_FILE: join(dir, `${tag}.pid`) },
  };
}

function mcpRecord(id, label, stub) {
  return {
    id,
    label,
    transport: "stdio",
    command: process.execPath,
    args: [stub.script],
    env: stub.env,
    enabled: true,
    scope: { mode: "global", projects: [] },
  };
}

/** The pinned-launcher supervisor the product drives, with the fake provider. */
function hostToolSupervisor({ dataRoot, project, provider, sessionDir }) {
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot,
    launcherPath: LAUNCHER,
    expectedRuntimeVersion: "18.2.7",
    sessionDir,
    args: ["--trusted-extension", GATE],
    prepareRun: (paths) => {
      writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" });
    },
    readyTimeoutMs: 60_000,
  });
  supervisor.setWorkingDirectory(project);
  return supervisor;
}

/** A fake plugin registry: `getTools()` returns the scripted plugin tools. */
function fakePlugins(tools) {
  return { getTools: () => tools };
}

function pluginTool({ fullName, pluginId = "demo", name, description, schema, execute }) {
  return { fullName, pluginId, name, description, schema, execute };
}

/**
 * The T19-B seam, assembled the way the product assembles it: the *production*
 * `createOmpHostToolAdapter` over the fake plugin registry and the real user
 * MCP runtime — no test-only copy of the catalog/executor mapping. The
 * approval scenarios run through the same adapter, so the real routing, scope
 * re-checks, live thinking, toast drain and content/isError mapping are what
 * the pinned runtime actually executes. The baseline bridge ignores the whole
 * object.
 */
function hostToolProvider({ project, plugins, userMcp, pluginActiveInProject = () => true, toastRecorder }) {
  if (!createOmpHostToolAdapter) return {};
  return {
    hostTools: createOmpHostToolAdapter({
      plugins,
      userMcp,
      pluginActiveInProject,
      ...(toastRecorder
        ? {
            drainToasts: () => ["e2e-toast"],
            emitToast: (message) => toastRecorder.push(message),
          }
        : {}),
    }),
  };
}

/**
 * Drive the gate's approvals for a turn: every `tool_permission_request` whose
 * tool matches `prefix` is answered once with `decision`, and each answered
 * request is recorded so the test can prove the approval preceded execution.
 *
 * The pinned gate blocks host tools before the `host_tool_call` frame exists
 * (M1: `set_host_tools` tools reach the trusted gate's `tool_call` hook), so
 * an approval must be observed before the executor can possibly run.
 */
function answerApprovals(bridge, envelopes, records, decision, prefix) {
  const answered = new Set();
  const tick = () => {
    for (const entry of envelopes) {
      if (entry.event.type !== "tool_permission_request") continue;
      const request = entry.event.request;
      if (!request.toolName.startsWith(prefix)) continue;
      if (answered.has(request.requestId) || !bridge.hasPendingRequest(request.requestId)) continue;
      answered.add(request.requestId);
      records.push({ toolName: request.toolName, toolCallId: request.toolCallId });
      bridge.resolvePermission(request.requestId, decision);
    }
  };
  const timer = setInterval(tick, 50);
  return () => clearInterval(timer);
}

function envelopeTimeline(envelopes) {
  return envelopes
    .map((entry) => {
      const event = entry.event;
      const id = event.toolCallId ? ` ${event.toolCallId}` : "";
      return `${entry.turnId ?? "-"} ${event.type}${id}`;
    })
    .join("\n");
}

/**
 * Prove a tool's RESULT reached the model context, not just its arguments.
 *
 * The first request carries the tool schemas and the assistant's own tool_call
 * arguments — the canary must be absent there. The OpenAI wire format renders
 * tool results as `role: "tool"` messages (`pi-ai` openai-completions.ts), so
 * the canary must appear inside a `tool` message of a later request.
 */
function assertToolResultCanary(provider, canary, label) {
  assert.ok(provider.requests.length >= 2, `${label}: the tool result needs a follow-up model request`);
  const first = provider.requests[0];
  assert.ok(
    !JSON.stringify(first.body).includes(canary),
    `${label}: the first request (schemas and arguments) must not carry the result canary`,
  );
  const found = provider.requests.slice(1).some((request) => {
    const messages = request.body?.messages ?? [];
    return messages.some(
      (message) =>
        message &&
        typeof message === "object" &&
        message.role === "tool" &&
        JSON.stringify(message.content ?? "").includes(canary),
    );
  });
  assert.ok(found, `${label}: the result canary must reach a tool-result message in the model context`);
}

test(
  "plugin agent tool executes exactly once and its result reaches the model",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-plugin-project-");
    const dataRoot = makeScratch("omp-e2e-plugin-data-");

    let executions = 0;
    // A canary that can only exist in the tool RESULT: the model's arguments
    // are `{text: "from-model"}`, so any request carrying the canary proves
    // the result — not the call itself — crossed back into the model context.
    const canary = `plugin-result-canary-${process.pid}`;
    const approvals = [];
    const toasts = [];
    const echo = pluginTool({
      fullName: "plugin_demo_echo",
      name: "echo",
      description: "Echo text back to the model",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async (args) => {
        executions += 1;
        return { ok: true, echo: String(args?.text ?? ""), canary };
      },
    });
    const plugins = fakePlugins([echo]);
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    scratch.push({ close: () => userMcp.disposeAll() });

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      {
        text: "calling the desktop echo tool",
        finish: "tool_calls",
        toolCalls: [{ id: "call_echo", name: "plugin_demo_echo", args: { text: "from-model" } }],
      },
      { text: "the echo answered", finish: "stop" },
    ]);

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = hostToolSupervisor({ dataRoot, project, provider, sessionDir });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...hostToolProvider({ project, plugins, userMcp, toastRecorder: toasts }),
    });

    let stopApprovals = () => undefined;
    try {
      // The pinned gate blocks the host tool before the `host_tool_call` frame
      // exists; answer its approval with "allow once".
      stopApprovals = answerApprovals(bridge, envelopes, approvals, "allow-once", "plugin_");
      const started = await bridge.prompt({ sessionId: "e2e-plugin-session", content: "call the desktop tool", projectPath: project });
      assert.equal(started.accepted, true);
      const answered = await waitFor(() =>
        envelopes.some(
          (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("the echo answered"),
        ),
      );
      assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);
      assert.ok(approvals.length >= 1, "the gate must ask before the host tool runs");
      assert.equal(executions, 1, "the plugin tool must execute exactly once");
      assertToolResultCanary(provider, canary, "plugin agent tool");
      assert.deepEqual(toasts, ["e2e-toast"], "the production adapter must drain plugin toasts after the call");
    } finally {
      stopApprovals();
      await bridge.dispose("e2e finished").catch(() => undefined);
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch {
          /* best-effort scratch cleanup */
        }
      }
    }
  },
);

test(
  "a denied plugin tool executes zero times and its denial reaches the model",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-deny-project-");
    const dataRoot = makeScratch("omp-e2e-deny-data-");
    const sideEffect = join(project, "side-effect.marker");

    let executions = 0;
    const echo = pluginTool({
      fullName: "plugin_demo_echo",
      name: "echo",
      description: "Echo text back to the model",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async () => {
        executions += 1;
        writeFileSync(sideEffect, "ran\n");
        return "should-never-run";
      },
    });
    const plugins = fakePlugins([echo]);
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    scratch.push({ close: () => userMcp.disposeAll() });

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      {
        text: "calling the desktop echo tool",
        finish: "tool_calls",
        toolCalls: [{ id: "call_echo", name: "plugin_demo_echo", args: { text: "denied" } }],
      },
      { text: "the tool was refused", finish: "stop" },
    ]);

    const envelopes = [];
    const approvals = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = hostToolSupervisor({ dataRoot, project, provider, sessionDir });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...hostToolProvider({ project, plugins, userMcp }),
    });

    const stopApprovals = answerApprovals(bridge, envelopes, approvals, "deny", "plugin_");
    try {
      const started = await bridge.prompt({ sessionId: "e2e-deny-session", content: "call the desktop tool", projectPath: project });
      assert.equal(started.accepted, true);
      const answered = await waitFor(() =>
        envelopes.some(
          (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("the tool was refused"),
        ),
      );
      assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);
      assert.ok(approvals.length >= 1, "the gate must ask before anything runs");
      assert.equal(executions, 0, "a denied plugin tool must never execute");
      assert.equal(existsSync(sideEffect), false, "a denied plugin tool must leave no side effect");
    } finally {
      stopApprovals();
      await bridge.dispose("e2e finished").catch(() => undefined);
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch {
          /* best-effort scratch cleanup */
        }
      }
    }
  },
);

test(
  "desktop user MCP tool executes exactly once against the real server",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-mcp-project-");
    const dataRoot = makeScratch("omp-e2e-mcp-data-");
    // The stub's answer tag is a result-only canary: the model calls the tool
    // with empty arguments, so the tag can only cross via the tool result.
    const canary = `usermcp-result-${process.pid}`;
    const stub = writeMcpStub(project, canary);

    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    userMcp.setRecords([mcpRecord("stub", "Stub", stub)]);
    scratch.push({ close: () => userMcp.disposeAll() });
    const plugins = fakePlugins([]);

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      {
        text: "calling the desktop MCP tool",
        finish: "tool_calls",
        toolCalls: [{ id: "call_ping", name: "mcp_stub_ping", args: {} }],
      },
      { text: "the mcp tool answered", finish: "stop" },
    ]);

    const envelopes = [];
    const approvals = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = hostToolSupervisor({ dataRoot, project, provider, sessionDir });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...hostToolProvider({ project, plugins, userMcp }),
    });

    const stopApprovals = answerApprovals(bridge, envelopes, approvals, "allow-once", "mcp_");
    try {
      const started = await bridge.prompt({ sessionId: "e2e-usermcp-session", content: "call the mcp tool", projectPath: project });
      assert.equal(started.accepted, true);
      const answered = await waitFor(() =>
        envelopes.some(
          (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("the mcp tool answered"),
        ),
      );
      assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);
      assert.ok(approvals.length >= 1, "the gate must ask before the MCP tool runs");
      assert.equal(readFileSync(stub.callFile, "utf8").length, 1, "the MCP server must serve exactly one call");
      assertToolResultCanary(provider, `${canary}:ping`, "user MCP tool");
    } finally {
      stopApprovals();
      await bridge.dispose("e2e finished").catch(() => undefined);
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch {
          /* best-effort scratch cleanup */
        }
      }
    }
  },
);

test(
  "plugin-declared MCP tool executes exactly once under its plugin_* name",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-plugmcp-project-");
    const dataRoot = makeScratch("omp-e2e-plugmcp-data-");
    // The stub's answer tag is a result-only canary, like the user MCP case.
    const canary = `plugmcp-result-${process.pid}`;
    const stub = writeMcpStub(project, canary);

    // The plugin-declared MCP server: a real MCP client owned by the plugin,
    // published under `plugin_<plugin>_<server>_<tool>`. `values` is the env
    // channel the client crosses to the stdio child (like the user MCP path).
    // Plugin-declared commands resolve under the *confined* policy — anything
    // with a path separator must live inside the plugin directory — so the
    // stub ships as an executable script inside a plugin subdirectory.
    mkdirSync(join(project, "plugin"), { recursive: true });
    const pluginScript = join(project, "plugin", "server.mjs");
    writeFileSync(pluginScript, `#!/usr/bin/env node\n${MCP_STUB}`);
    chmodSync(pluginScript, 0o755);
    const mcpClient = new McpServerClient({
      pluginId: "demo",
      rootPath: join(project, "plugin"),
      server: {
        id: "serv",
        label: "Serv",
        transport: "stdio",
        command: "./server.mjs",
        args: [],
        env: {},
      },
      values: stub.env,
    });
    scratch.push({ close: () => mcpClient.close() });
    const pluginMcpTool = pluginTool({
      fullName: "plugin_demo_serv_ping",
      name: "serv_ping",
      description: 'Serv tool "ping" (MCP)',
      schema: { type: "object", properties: {} },
      execute: async (args) => mcpClient.callTool("ping", args),
    });
    const plugins = fakePlugins([pluginMcpTool]);
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    scratch.push({ close: () => userMcp.disposeAll() });

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      {
        text: "calling the plugin mcp tool",
        finish: "tool_calls",
        toolCalls: [{ id: "call_plugmcp", name: "plugin_demo_serv_ping", args: {} }],
      },
      { text: "the plugin mcp tool answered", finish: "stop" },
    ]);

    const envelopes = [];
    const approvals = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = hostToolSupervisor({ dataRoot, project, provider, sessionDir });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...hostToolProvider({ project, plugins, userMcp }),
    });

    const stopApprovals = answerApprovals(bridge, envelopes, approvals, "allow-once", "plugin_");
    try {
      const started = await bridge.prompt({ sessionId: "e2e-plugmcp-session", content: "call the plugin mcp tool", projectPath: project });
      assert.equal(started.accepted, true);
      const answered = await waitFor(() =>
        envelopes.some(
          (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("the plugin mcp tool answered"),
        ),
      );
      assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);
      assert.ok(approvals.length >= 1, "the gate must ask before the plugin MCP tool runs");
      assert.equal(readFileSync(stub.callFile, "utf8").length, 1, "the plugin MCP server must serve exactly one call");
      assertToolResultCanary(provider, `${canary}:ping`, "plugin-declared MCP tool");
    } finally {
      stopApprovals();
      await bridge.dispose("e2e finished").catch(() => undefined);
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch {
          /* best-effort scratch cleanup */
        }
      }
    }
  },
);

test(
  "a cancelled host tool leaves no late side effect in the model context",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-cancel-project-");
    const dataRoot = makeScratch("omp-e2e-cancel-data-");
    const lateMarker = `LATE-RESULT-${process.pid}`;

    let invocations = 0;
    const slow = pluginTool({
      fullName: "plugin_demo_slow",
      name: "slow",
      description: "A slow desktop tool",
      schema: { type: "object", properties: {} },
      execute: async (_args, ctx) => {
        invocations += 1;
        // Resolves only after the signal fires — then "completes late" with a
        // result the model must never see.
        const { promise, resolve, reject } = Promise.withResolvers();
        ctx.signal.addEventListener("abort", () => {
          setTimeout(() => resolve({ ok: false, late: lateMarker }), 250);
        }, { once: true });
        return promise;
      },
    });
    const plugins = fakePlugins([slow]);
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    scratch.push({ close: () => userMcp.disposeAll() });

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      {
        text: "calling the slow desktop tool",
        finish: "tool_calls",
        toolCalls: [{ id: "call_slow", name: "plugin_demo_slow", args: {} }],
      },
      { text: "placeholder", finish: "stop" },
    ]);

    const envelopes = [];
    const approvals = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = hostToolSupervisor({ dataRoot, project, provider, sessionDir });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...hostToolProvider({ project, plugins, userMcp }),
    });

    const stopApprovals = answerApprovals(bridge, envelopes, approvals, "allow-once", "plugin_demo_slow");
    try {
      const started = await bridge.prompt({ sessionId: "e2e-cancel-session", content: "call the slow tool", projectPath: project });
      assert.equal(started.accepted, true);
      assert.equal(
        await waitFor(() => invocations === 1, 30_000),
        true,
        "the slow tool must be invoked exactly once before the stop",
      );
      const stopped = await bridge.stop("e2e-cancel-session");
      assert.equal(stopped.converged || stopped.toreDown, true, `the stop must finish: ${JSON.stringify(stopped)}`);

      // The late completion fires 250 ms after the abort; give it time to
      // arrive, then prove it never reached the model or the transcript.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const bodies = provider.requests.map((request) => JSON.stringify(request.body));
      assert.ok(
        bodies.every((body) => !body.includes(lateMarker)),
        "the late result must never reach the model context",
      );
      // OMP reports the aborted call itself (`tool_execution_end` for the
      // cancelled tool), so a tool_end row may exist — but none of what the
      // transcript shows may carry the late completion's marker.
      assert.ok(approvals.length >= 1, "the gate must have asked before the slow tool ran");
      const toolEnds = envelopes.filter((entry) => entry.event.type === "tool_end" && entry.event.toolCallId === "call_slow");
      assert.ok(
        toolEnds.every((entry) => !JSON.stringify(entry.event).includes(lateMarker)),
        "no tool result may carry the late completion of the cancelled call",
      );
    } finally {
      stopApprovals();
      await bridge.dispose("e2e finished").catch(() => undefined);
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch {
          /* best-effort scratch cleanup */
        }
      }
    }
  },
);

test(
  "a project MCP decoy is still never loaded by native discovery while desktop tools run",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-decoy-project-");
    const dataRoot = makeScratch("omp-e2e-decoy-data-");
    const marker = join(project, "mcp-decoy.loaded");

    // A project-level MCP source OMP would discover without the T19-A boundary.
    // The decoy advertises a tool that must never be served by native discovery.
    writeFileSync(
      join(project, "decoy-server.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "loaded\\n");`,
        "process.stdin.resume();",
        "process.stdin.on('end', () => process.exit(0));",
        "process.on('SIGTERM', () => process.exit(0));",
      ].join("\n"),
    );
    const mcpJson = {
      mcpServers: { decoy: { command: process.execPath, args: [join(project, "decoy-server.mjs")] } },
    };
    writeFileSync(join(project, "mcp.json"), JSON.stringify(mcpJson));
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify(mcpJson));

    let executions = 0;
    const echo = pluginTool({
      fullName: "plugin_demo_echo",
      name: "echo",
      description: "Echo text back to the model",
      schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: async (args) => {
        executions += 1;
        return `echo:${String(args?.text ?? "")}`;
      },
    });
    const plugins = fakePlugins([echo]);
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    scratch.push({ close: () => userMcp.disposeAll() });

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      {
        text: "calling the desktop tool over the decoy project",
        finish: "tool_calls",
        toolCalls: [{ id: "call_echo", name: "plugin_demo_echo", args: { text: "decoy-run" } }],
      },
      { text: "done", finish: "stop" },
    ]);

    const envelopes = [];
    const approvals = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = hostToolSupervisor({ dataRoot, project, provider, sessionDir });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...hostToolProvider({ project, plugins, userMcp }),
    });

    const stopApprovals = answerApprovals(bridge, envelopes, approvals, "allow-once", "plugin_");
    try {
      const started = await bridge.prompt({ sessionId: "e2e-decoy-session", content: "call the desktop tool", projectPath: project });
      assert.equal(started.accepted, true);
      const answered = await waitFor(() =>
        envelopes.some(
          (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("done"),
        ),
      );
      assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);
      assert.equal(executions, 1, "the desktop tool must execute while the decoy stays dormant");
      assert.equal(existsSync(marker), false, "the workspace MCP decoy must never be spawned");
    } finally {
      stopApprovals();
      await bridge.dispose("e2e finished").catch(() => undefined);
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch {
          /* best-effort scratch cleanup */
        }
      }
    }
  },
);
