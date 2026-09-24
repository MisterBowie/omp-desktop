/**
 * T19-B probes for the desktop host-tool adapter (the module that turns the
 * PI Desktop plugin/MCP registries into the pinned runtime's host-tool
 * catalog and executes the model's calls with re-checks).
 *
 * On the T19-B baseline (`93ee82b`) this module does not exist, so the file
 * fails to load (module-not-found) — that is a gap fact, but it is not the
 * red evidence: the behavioral reds live in `host-tool-runner.test.ts`
 * (frames never served), `omp-host-tool-bridge.test.mjs` (no set_host_tools,
 * no echo validation) and `omp-host-tool-e2e.test.mjs` (no real execution).
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpHostToolAdapter } = await import("../electron/main/runtime/omp-host-tools.ts");
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");

function pluginTool(overrides = {}) {
  return {
    fullName: "plugin_demo_echo",
    pluginId: "demo",
    name: "echo",
    description: "Echo text back to the model",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    execute: async () => ({ ok: true }),
    ...overrides,
  };
}

function adapter({ tools = [], records = [], activeInProject = () => true } = {}) {
  const userMcp = new UserMcpRuntime({
    createClient: () => ({
      connect: async () => [],
      callTool: async () => ({}),
      getTools: () => [],
      isConnected: () => false,
      close: () => undefined,
    }),
  });
  if (records.length > 0) userMcp.setRecords(records);
  return createOmpHostToolAdapter({
    plugins: { getTools: () => tools },
    userMcp,
    pluginActiveInProject: activeInProject,
  });
}

const RUN = { sessionId: "s1", turnId: "turn-1", generation: 1 };
const SIGNAL = () => new AbortController().signal;

/** A default binding; `overrides` can supply live getters. */
function binding(overrides = {}) {
  return {
    sessionId: "s1",
    projectPath: "/repo",
    modelKey: () => null,
    thinkingLevel: () => null,
    dispatchable: () => true,
    ...overrides,
  };
}

test("the catalog maps plugin agent tools to plugin_* names with verbatim schema and description", async () => {
  const tools = [
    pluginTool(),
    pluginTool({
      fullName: "plugin_demo_mcp_tool",
      name: "mcp_tool",
      description: "A plugin MCP tool",
      schema: { type: "object", properties: { q: { type: "number" } }, required: ["q"] },
    }),
  ];
  const { catalog } = adapter({ tools });

  const definitions = await catalog("/repo");
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ["plugin_demo_echo", "plugin_demo_mcp_tool"],
  );
  assert.equal(definitions[0].description, "Echo text back to the model");
  assert.deepEqual(definitions[0].parameters, tools[0].schema, "the schema must pass through verbatim");
  assert.equal(definitions[0].loadMode, "essential", "desktop tools must be exposed as top-level tools");
});

test("the desktop forwards a description verbatim; the runtime's own trim is OMP's", async () => {
  const { catalog } = adapter({
    tools: [pluginTool({ description: "  Spaced description  " })],
  });
  const definitions = await catalog("/repo");
  // The desktop never normalizes a description — the pinned runtime's
  // `normalizeHostToolDefinitions` trims it at registration, which is OMP's
  // own behavior and not re-implemented here.
  assert.equal(definitions[0].description, "  Spaced description  ");
});

test("plugins inactive for the project are invisible to its catalog", async () => {
  const tools = [pluginTool(), pluginTool({ fullName: "plugin_other_echo", pluginId: "other" })];
  const { catalog } = adapter({
    tools,
    activeInProject: (pluginId) => pluginId === "demo",
  });

  const definitions = await catalog("/repo");
  assert.deepEqual(definitions.map((definition) => definition.name), ["plugin_demo_echo"]);
});

test("a duplicate tool name fails the catalog closed instead of overwriting", async () => {
  const tools = [
    pluginTool(),
    pluginTool({ fullName: "plugin_demo_echo", name: "echo2" }),
  ];
  const { catalog } = adapter({ tools });

  await assert.rejects(() => catalog("/repo"), /duplicate|already/i);
});

test("an undeliverable definition fails the catalog closed and names the tool", async () => {
  const { catalog } = adapter({
    tools: [pluginTool({ description: "   " })],
  });
  await assert.rejects(() => catalog("/repo"), /plugin_demo_echo/);

  const badSchema = adapter({ tools: [pluginTool({ schema: "not-an-object" })] });
  await assert.rejects(() => badSchema.catalog("/repo"), /plugin_demo_echo/);
});

test("the executor runs a plugin tool with the bound session identity and arguments", async () => {
  const seen = [];
  const tools = [
    pluginTool({
      execute: async (args, ctx) => {
        seen.push({ args, ctx });
        return `echo:${String(args?.text ?? "")}`;
      },
    }),
  ];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding({ modelKey: () => "p/m", thinkingLevel: () => "off" }));

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: { text: "hi" } },
    RUN,
    SIGNAL(),
  );
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args, { text: "hi" });
  assert.equal(seen[0].ctx.sessionId, "s1");
  assert.equal(seen[0].ctx.turnId, "turn-1");
  assert.equal(seen[0].ctx.thinkingLevel, "off");
  assert.equal(outcome.content[0].text, "echo:hi");
});

test("the executor reads the live thinking level at each execution, never a stale snapshot", async () => {
  const seen = [];
  let level = "off";
  const tools = [
    pluginTool({
      execute: async (_args, ctx) => {
        seen.push(ctx.thinkingLevel);
        return "ok";
      },
    }),
  ];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding({ thinkingLevel: () => level }));

  await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  // The configure() thinking-only path mutates the entry's binding in place
  // after a successful persist; the next execution must see the new level.
  level = "high";
  await execute(
    { id: "h2", toolCallId: "tc2", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  level = "off";
  await execute(
    { id: "h3", toolCallId: "tc3", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );

  assert.deepEqual(seen, ["off", "high", "off"]);
});

test("the executor refuses a plugin tool that is no longer loaded or no longer active", async () => {
  const provider = adapter({ tools: [] });
  const { execute } = provider.executor(binding());

  await assert.rejects(
    () => execute(
      { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
      RUN,
      SIGNAL(),
    ),
    /not loaded|unknown/i,
  );

  const scoped = adapter({
    tools: [pluginTool()],
    activeInProject: () => false,
  });
  const { execute: scopedExecute } = scoped.executor(binding());
  await assert.rejects(
    () => scopedExecute(
      { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
      RUN,
      SIGNAL(),
    ),
    /scope|project/i,
  );
});

test("a turn that is no longer dispatchable never starts a plugin tool", async () => {
  let started = 0;
  const tools = [pluginTool({ execute: async () => { started += 1; return "ok"; } })];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding({ dispatchable: () => false }));

  await assert.rejects(
    () => execute(
      { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
      RUN,
      SIGNAL(),
    ),
    (error) => error.errorCode === "TOOL_TURN_CANCELLED" && /dispatchable/.test(error.message),
  );
  assert.equal(started, 0, "the plugin side effect must not start");
});

test("a turn that is no longer dispatchable never starts an MCP call", async () => {
  const calls = [];
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => [] },
    userMcp: {
      toolsForProject: async () => [],
      callTool: async () => { calls.push(1); return "ok"; },
    },
    pluginActiveInProject: () => true,
  });
  const { execute } = provider.executor(binding({ dispatchable: () => false }));

  await assert.rejects(
    () => execute(
      { id: "h1", toolCallId: "tc1", toolName: "mcp_stub_ping", arguments: {} },
      RUN,
      SIGNAL(),
    ),
    (error) => error.errorCode === "TOOL_TURN_CANCELLED",
  );
  assert.equal(calls.length, 0, "the MCP dispatch must not start");
});

test("an already-aborted signal never starts a plugin tool", async () => {
  let started = 0;
  const tools = [pluginTool({ execute: async () => { started += 1; return "ok"; } })];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => execute(
      { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
      RUN,
      controller.signal,
    ),
    (error) => error.errorCode === "TOOL_CANCELLED",
  );
  assert.equal(started, 0);
});

test("the executor honours the abort signal for a plugin tool", async () => {
  let aborted = false;
  const tools = [
    pluginTool({
      execute: async (_args, ctx) => {
        const { promise, resolve } = Promise.withResolvers();
        ctx.signal.addEventListener("abort", () => {
          aborted = true;
          resolve("done");
        }, { once: true });
        return promise;
      },
    }),
  ];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());
  const controller = new AbortController();
  const running = execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    controller.signal,
  );
  controller.abort();
  await running;
  assert.equal(aborted, true);
});

test("an mcp_* call routes through the user MCP runtime against the bound project", async () => {
  const calls = [];
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => [] },
    userMcp: {
      toolsForProject: async () => [],
      callTool: async (name, args, projectPath) => {
        calls.push({ name, args, projectPath });
        return { content: [{ type: "text", text: "mcp-answer" }] };
      },
    },
    pluginActiveInProject: () => true,
  });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "mcp_stub_ping", arguments: { force: true } },
    RUN,
    SIGNAL(),
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "mcp_stub_ping");
  assert.deepEqual(calls[0].args, { force: true });
  assert.equal(calls[0].projectPath, "/repo", "the executor must only reach its bound project");
  assert.equal(outcome.content[0].text, "mcp-answer");
});

test("a throwing user MCP client surfaces as an executor failure with the code's text", async () => {
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => [] },
    userMcp: {
      toolsForProject: async () => [],
      callTool: async () => {
        throw Object.assign(new Error("mcp tool failed"), { code: "TOOL_FAILED" });
      },
    },
    pluginActiveInProject: () => true,
  });
  const { execute } = provider.executor(binding());

  await assert.rejects(
    () => execute(
      { id: "h1", toolCallId: "tc1", toolName: "mcp_stub_ping", arguments: {} },
      RUN,
      SIGNAL(),
    ),
    (error) => error.code === "TOOL_FAILED" && /mcp tool failed/.test(error.message),
  );
});

test("an AgentToolResult-shaped plugin value with inner isError becomes an outer failure", async () => {
  const tools = [
    pluginTool({
      execute: async () => ({ content: [{ type: "text", text: "inner boom" }], isError: true }),
    }),
  ];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.equal(outcome.isError, true, "an inner failure must not be rendered as success");
  assert.equal(outcome.content[0].text, "inner boom");
});

test("MCP image blocks pass through faithfully as OMP ImageContent", async () => {
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => [] },
    userMcp: {
      toolsForProject: async () => [],
      callTool: async () => ({
        content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
      }),
    },
    pluginActiveInProject: () => true,
  });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "mcp_stub_ping", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.deepEqual(outcome.content, [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
});

test("non-text blocks and structuredContent are preserved as deterministic text beside text blocks", async () => {
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => [] },
    userMcp: {
      toolsForProject: async () => [],
      callTool: async () => ({
        content: [
          { type: "text", text: "readable text" },
          { type: "audio", data: "AAAA", mimeType: "audio/wav" },
          { type: "resource", resource: { uri: "file:///notes.md", mimeType: "text/markdown" } },
        ],
        structuredContent: { rows: 2 },
      }),
    },
    pluginActiveInProject: () => true,
  });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "mcp_stub_ping", arguments: {} },
    RUN,
    SIGNAL(),
  );
  const text = outcome.content.map((block) => block.text).join("\n");
  assert.match(text, /readable text/, "the text block must survive");
  assert.match(text, /"type": "audio"/, "the audio block's metadata must be represented");
  assert.doesNotMatch(text, /AAAA/, "raw base64 payloads must never cross");
  assert.match(text, /file:\/\/\/notes\.md/, "the resource block's uri must be represented");
  assert.match(text, /"rows": 2/, "structuredContent must not be lost beside a text block");
});

test("a huge multibyte result is bounded on its serialized content and marked truncated", async () => {
  const tools = [pluginTool({ execute: async () => "中".repeat(400_000) })];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  const text = outcome.content[0].text;
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.content), "utf8") <= 768 * 1024,
    "the serialized content array must fit the budget exactly",
  );
  assert.ok(text.endsWith("\u2026"), "the truncation marker must be present");
});

test("a result full of JSON escapes is bounded on its serialized bytes, not its raw text", async () => {
  // Quotes and backslashes double under JSON.stringify; a budget measured on
  // raw text would let the serialized frame blow past the 1 MiB line limit.
  const tools = [pluginTool({ execute: async () => '"\\'.repeat(400_000) })];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.content), "utf8") <= 768 * 1024,
    "the serialized content array must fit the budget exactly",
  );
  assert.ok(outcome.content[0].text.endsWith("\u2026"), "the truncation marker must be present");
});

test("a plain string result that fits is returned untouched", async () => {
  const tools = [pluginTool({ execute: async () => "short answer" })];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.deepEqual(outcome.content, [{ type: "text", text: "short answer" }]);
});

test("an over-budget multi-block result keeps its head and marks the cut exactly", async () => {
  const tools = [
    pluginTool({
      execute: async () => ({
        content: [
          { type: "text", text: "keep-this-head" },
          { type: "text", text: "中".repeat(400_000) },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      }),
    }),
  ];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.content), "utf8") <= 768 * 1024,
    "the serialized content array must fit the budget exactly",
  );
  assert.equal(outcome.content[0].text, "keep-this-head", "the head block must survive intact");
  assert.ok(outcome.content[1].text.startsWith("中"), "the second block is truncated, not dropped");
  assert.ok(outcome.content[1].text.endsWith("\u2026"), "the cut carries the truncation marker");
  assert.equal(outcome.content.length, 2, "blocks after the cut are dropped deterministically");
});

test("the truncation marker itself is budgeted when a later block no longer fits", async () => {
  // A prefix that fills the budget almost entirely, then a small image: the
  // marker that replaces the image must still leave the serialized content
  // within CONTENT_BYTES — its envelope and bytes are part of the budget —
  // and the near-full head text must be preserved, not dropped to make room
  // for the marker.
  const tools = [
    pluginTool({
      execute: async () => ({
        content: [
          { type: "text", text: "x".repeat(786_400) },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
      }),
    }),
  ];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  const serialized = Buffer.byteLength(JSON.stringify(outcome.content), "utf8");
  assert.ok(serialized <= 768 * 1024, `the serialized content must stay within the budget, got ${serialized}`);
  assert.equal(outcome.content.length, 2, "the head text plus the standalone marker");
  assert.ok(
    outcome.content[0].text.startsWith("x".repeat(1_000)),
    "the near-full head text must be preserved, not dropped for the marker",
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(outcome.content[0].text), "utf8") > 700 * 1024,
    "most of the head text must survive the cut",
  );
  assert.equal(outcome.content[1].text, "\u2026", "the dropped block is marked by the standalone marker");
});

test("a whitespace-only tool name fails the catalog closed, like the pinned runtime", async () => {
  // The pinned runtime's `normalizeHostToolDefinitions` trims names and
  // rejects a blank one; the desktop must refuse before registration instead
  // of sending a definition the runtime would reject.
  const { catalog } = adapter({
    tools: [pluginTool({ fullName: "   ", name: "echo" })],
  });
  await assert.rejects(() => catalog("/repo"), /must provide a non-empty name/);
});

test("a plugin's details/useless keys ride along as text, never mapped onto OMP metadata", async () => {
  const tools = [
    pluginTool({
      execute: async () => ({
        content: [{ type: "text", text: "answer" }],
        details: { rows: 3 },
        useless: true,
      }),
    }),
  ];
  const provider = adapter({ tools });
  const { execute } = provider.executor(binding());

  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.equal(outcome.isError, undefined);
  assert.equal(outcome.details, undefined, "the OMP result's own details field must never be invented");
  const text = outcome.content.map((block) => block.text).join("\n");
  assert.match(text, /"rows": 3/, "the plugin's details must stay visible to the model as text");
  assert.match(text, /"useless": true/, "the plugin's useless flag must stay visible to the model as text");
});

test("toast drain and delivery run after a plugin tool and never change its result", async () => {
  const toasts = [];
  const delivered = [];
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => [pluginTool({ execute: async () => "tool-ok" })] },
    userMcp: { toolsForProject: async () => [], callTool: async () => "ok" },
    pluginActiveInProject: () => true,
    drainToasts: () => toasts.splice(0),
    emitToast: (message) => delivered.push(message),
  });
  toasts.push("saved!");

  const { execute } = provider.executor(binding());
  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.equal(outcome.isError, undefined);
  assert.equal(outcome.content[0].text, "tool-ok");
  assert.deepEqual(delivered, ["saved!"]);
});

test("a throwing toast delivery never changes a successful tool result", async () => {
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => [pluginTool({ execute: async () => "tool-ok" })] },
    userMcp: { toolsForProject: async () => [], callTool: async () => "ok" },
    pluginActiveInProject: () => true,
    drainToasts: () => ["saved!"],
    emitToast: () => {
      throw new Error("renderer gone");
    },
  });

  const { execute } = provider.executor(binding());
  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.equal(outcome.isError, undefined, "the toast failure must not turn success into an error");
  assert.equal(outcome.content[0].text, "tool-ok");
});

test("a throwing toast drain never changes a successful tool result", async () => {
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => [pluginTool({ execute: async () => "tool-ok" })] },
    userMcp: { toolsForProject: async () => [], callTool: async () => "ok" },
    pluginActiveInProject: () => true,
    drainToasts: () => {
      throw new Error("queue broken");
    },
    emitToast: () => undefined,
  });

  const { execute } = provider.executor(binding());
  const outcome = await execute(
    { id: "h1", toolCallId: "tc1", toolName: "plugin_demo_echo", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.equal(outcome.isError, undefined);
  assert.equal(outcome.content[0].text, "tool-ok");
});

test("an executor bound to one project never reaches another project's scoped tools", async () => {
  const tools = [pluginTool()];
  const calls = [];
  const provider = createOmpHostToolAdapter({
    plugins: { getTools: () => tools },
    userMcp: {
      toolsForProject: async () => [],
      callTool: async (_name, _args, projectPath) => {
        calls.push(projectPath);
        return "ok";
      },
    },
    pluginActiveInProject: () => true,
  });
  const { execute } = provider.executor(binding({ projectPath: "/repo-a" }));
  await execute(
    { id: "h1", toolCallId: "tc1", toolName: "mcp_stub_ping", arguments: {} },
    RUN,
    SIGNAL(),
  );
  assert.deepEqual(calls, ["/repo-a"]);
});
