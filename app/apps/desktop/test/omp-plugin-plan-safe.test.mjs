/**
 * M5/T20-C: the plugin execution context carries the admitted turn's real
 * mode, and the PI plugin-runtime guard enforces the declared plan-safe
 * actions with it. These probes run a real `PluginRuntime` child process (not
 * a stub), so `ctx.mode` is observed by actual plugin execution — the same
 * seam the production bridge feeds.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "..", "electron/main/plugin-host-process.mjs");

register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");
const { createOmpHostToolAdapter } = await import("../electron/main/runtime/omp-host-tools.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin(main) {
  const dir = mkdtempSync(join(tmpdir(), "t20c-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "demo.plansafe",
      name: "Plan safe",
      version: "0.0.1",
      main: "main.js",
      permissions: ["agent.tool.register"],
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), main, "utf8");
  return dir;
}

const MAIN = `
  module.exports = {
    async onLoad() {
      await pi.agent.registerTool({
        name: "inspect",
        description: "Inspect one action",
        risk: "low",
        planSafeActions: ["inspect"],
        schema: { type: "object", properties: { action: { type: "string" } } },
        execute: async (args, ctx) => ({ mode: ctx.mode, action: args.action }),
      });
      await pi.agent.registerTool({
        name: "plain",
        description: "No plan-safe declaration",
        risk: "medium",
        schema: { type: "object", properties: {} },
        execute: async (args, ctx) => ({ mode: ctx.mode }),
      });
    },
  };
`;

const RUN = { sessionId: "s1", turnId: "turn-1", generation: 1 };

function binding(modeForTurn) {
  return {
    sessionId: "s1",
    projectPath: "/repo",
    modelKey: () => null,
    thinkingLevel: () => null,
    dispatchable: () => true,
    modeForTurn,
  };
}

test("a plugin tool executes under the admitted turn's real mode and per-action guard", async (t) => {
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    listModels: async () => [],
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  await runtime.loadFromPath(writePlugin(MAIN), ["agent.tool.register"]);

  const adapter = createOmpHostToolAdapter({
    plugins: {
      getTools: () => runtime.getTools(),
      getSkills: () => [],
      loadSkillBody: () => {
        throw new Error("no skill bodies in this probe");
      },
    },
    userMcp: { toolsForProject: async () => [], callTool: async () => ({}) },
    pluginActiveInProject: () => true,
  });
  const entries = await adapter.catalog("/repo");
  const inspect = entries.find((entry) => entry.definition.name.endsWith("_inspect"));
  const plain = entries.find((entry) => entry.definition.name.endsWith("_plain"));
  assert.ok(inspect && plain, "both registered tools must reach the catalog");
  assert.equal(inspect.risk, "low");
  assert.deepEqual(inspect.planSafeActions, ["inspect"]);
  assert.equal(plain.risk, "medium");
  assert.deepEqual(plain.planSafeActions, []);

  const signal = () => new AbortController().signal;
  const agent = adapter.executor(binding(() => "agent"));
  const agentResult = await agent.execute(
    { toolCallId: "c1", toolName: inspect.definition.name, arguments: { action: "inspect" } },
    RUN,
    signal(),
  );
  assert.match(agentResult.content[0].text, /"mode": "agent"/);

  const plan = adapter.executor(binding(() => "plan"));
  const allowed = await plan.execute(
    { toolCallId: "c2", toolName: inspect.definition.name, arguments: { action: "inspect" } },
    RUN,
    signal(),
  );
  assert.match(allowed.content[0].text, /"mode": "plan"/, "the plugin must observe the real Plan mode");
  await assert.rejects(
    plan.execute(
      { toolCallId: "c3", toolName: inspect.definition.name, arguments: { action: "write" } },
      RUN,
      signal(),
    ),
    /not allowed in plan mode/,
    "an undeclared action must be denied by the PI per-action guard",
  );
  await assert.rejects(
    plan.execute({ toolCallId: "c4", toolName: plain.definition.name, arguments: {} }, RUN, signal()),
    /not available in plan mode/,
    "a plugin tool without a non-empty planSafeActions list must be denied in Plan",
  );

  const goal = adapter.executor(binding(() => "goal"));
  await assert.rejects(
    goal.execute(
      { toolCallId: "c5", toolName: inspect.definition.name, arguments: { action: "run" } },
      RUN,
      signal(),
    ),
    /not allowed in goal mode/,
  );

  const unknown = adapter.executor(binding(() => null));
  await assert.rejects(
    unknown.execute(
      { toolCallId: "c6", toolName: inspect.definition.name, arguments: { action: "inspect" } },
      RUN,
      signal(),
    ),
    /no admitted session policy exists/,
    "an unknown turn mode must refuse before the plugin runs",
  );
  assert.equal(runtime.getTools().length, 2, "the registry stays live and unchanged");
});

test("user MCP tools are refused outside Agent mode before any remote call", async () => {
  const calls = [];
  const adapter = createOmpHostToolAdapter({
    plugins: { getTools: () => [], getSkills: () => [], loadSkillBody: () => null },
    userMcp: {
      toolsForProject: async () => [
        { fullName: "mcp_alpha_lookup", serverId: "alpha", toolName: "lookup", description: "Lookup", schema: { type: "object" } },
      ],
      callTool: async (name) => {
        calls.push(name);
        return "mcp result";
      },
    },
    pluginActiveInProject: () => true,
  });
  const signal = () => new AbortController().signal;
  const plan = adapter.executor(binding(() => "plan"));
  await assert.rejects(
    plan.execute({ toolCallId: "m1", toolName: "mcp_alpha_lookup", arguments: {} }, RUN, signal()),
    (error) => error.errorCode === "PERMISSION_DENIED" && /TOOL_DISABLED_IN_PLAN/.test(error.message),
  );
  assert.equal(calls.length, 0, "the MCP call path must not be entered in Plan");
  const agent = adapter.executor(binding(() => "agent"));
  const result = await agent.execute({ toolCallId: "m2", toolName: "mcp_alpha_lookup", arguments: {} }, RUN, signal());
  assert.equal(calls.length, 1, "Agent mode still executes the MCP call exactly once");
  assert.match(result.content[0].text, /mcp result/);
});
