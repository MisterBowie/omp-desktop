import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
const root = resolve(process.env.OMP_RELEASE_SOURCE ?? process.cwd());
register(pathToFileURL(join(root, "apps/desktop/test/helpers/ts-import-hooks.mjs")));
const load = (p) => import(pathToFileURL(join(root, p)));
const { DesktopAgentRuntime } = await load("packages/agent-runtime/dist/runtime.js");
const { loadInstructionChain } = await load("packages/agent-runtime/dist/project-instructions.js");
const { BrowserHost } = await load("apps/desktop/electron/main/browser-host.ts");
const { McpServerClient } = await load("apps/desktop/electron/main/plugin-mcp.ts");
const { NativePiSessionService } = await load("packages/agent-runtime/dist/native-pi-session.js");
const auditRoots = [];
test.after(async () => {
  for (const p of auditRoots) await rm(p, { recursive: true, force: true });
});
const scratch = async () => {
  const p = await realpath(await mkdtemp(join(tmpdir(), "omp-011-bug-")));
  auditRoots.push(p);
  return p;
};
const provider = {
  id: "audit",
  name: "Audit",
  baseUrl: "http://127.0.0.1:1/v1",
  modelId: "audit-model",
  apiKey: "",
  authKind: "none",
  supportsReasoning: false,
  supportedThinkingLevels: ["off"],
};
test("B01 Pi: loop context mutations must not mutate durable agent state", async (t) => {
  const dir = await scratch(t);
  const runtime = new DesktopAgentRuntime({
    host: {
      call: async () => {
        throw Error("unexpected host call");
      },
      onNotification: () => () => {},
    },
    sessionId: "audit",
    mode: "agent",
    provider,
    commandShell: { id: "bash", label: "Bash", dialect: "posix", available: true, isDefault: true },
    thinkingLevel: "off",
    projectPath: dir,
    scratchDir: dir,
    onEvent() {},
  });
  t.after(() => runtime.dispose());
  const context = runtime.rebuiltAgentContext();
  const before = runtime.agent.state.messages.length;
  context.messages.push({ role: "user", content: "LOOP_PROBE", timestamp: 1 });
  assert.equal(
    runtime.agent.state.messages.length,
    before,
    "loop owns a separate message array; shared arrays duplicate tool results",
  );
});
test("B02 Pi: a full global instruction budget must retain project rules", async (t) => {
  const dir = await scratch(t);
  const global = join(dir, "global.md");
  await writeFile(global, "g".repeat(32768));
  await writeFile(join(dir, "AGENTS.md"), "PROJECT_RULE_MARKER");
  const chain = await loadInstructionChain(dir, undefined, global);
  assert.ok(
    chain.entries.some((e) => e.content.includes("PROJECT_RULE_MARKER")),
    "global AGENTS must not starve project instructions",
  );
});
test("B03 Browser: public host CDP operations have a bounded wait", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let commandCount = 0;
  const wc = {
    id: 91,
    isDestroyed: () => false,
    debugger: {
      isAttached: () => true,
      attach() {},
      detach() {},
      on() {},
      off() {},
      sendCommand: (method) => {
        if (method.endsWith(".enable")) return Promise.resolve({});
        commandCount += 1;
        return new Promise(() => {});
      },
    },
  };
  const host = new BrowserHost({
    pane: { getWebContents: () => wc },
    isPluginLoaded: () => true,
    getFileRoot: async () => null,
    onState() {},
  });
  let outcome = "pending";
  host.cdpCommand("Runtime.evaluate", { expression: "1" }).then(
    () => (outcome = "resolved"),
    () => (outcome = "rejected"),
  );
  for (let n = 0; n < 30; n++) await Promise.resolve();
  assert.equal(commandCount, 1, "the public host must reach the CDP command");
  t.mock.timers.tick(300000);
  for (let n = 0; n < 30; n++) await Promise.resolve();
  wc.debugger.detach();
  assert.equal(outcome, "rejected", "CDP call must settle after five simulated minutes");
});
const json = (id, result) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });
function client(fetchImpl, options = {}) {
  return new McpServerClient({
    rootPath: tmpdir(),
    server: { id: "audit", transport: "http", url: "http://127.0.0.1:1/mcp" },
    values: {},
    connectTimeoutMs: 250,
    callTimeoutMs: 35,
    fetchImpl,
    ...options,
  });
}
test("B04 MCP: consume a complete SSE reply before the stream closes", async (t) => {
  const instance = client(async (_url, request) => {
    const message = JSON.parse(request.body);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === "initialize"
        ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
        : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            "data: " + JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n\n",
          ),
        );
        request.signal.addEventListener(
          "abort",
          () => controller.error(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  });
  t.after(() => instance.close());
  const tools = await instance.connect();
  assert.equal(tools[0].name, "echo");
});
test("B05 MCP: tool timeout notifies the server to cancel the request", async (t) => {
  let aborted = false;
  let toolRequestId;
  const sent = [];
  const instance = client(
    async (_url, request) => {
      const message = JSON.parse(request.body);
      sent.push(message);
      if (message.id === undefined) return new Response(null, { status: 202 });
      if (message.method === "initialize")
        return json(message.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} } });
      if (message.method === "tools/list")
        return json(message.id, { tools: [{ name: "echo", inputSchema: { type: "object" } }] });
      toolRequestId = message.id;
      return new Promise((_, reject) =>
        request.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        ),
      );
    },
    { connectTimeoutMs: 2000 },
  );
  t.after(() => instance.close());
  await instance.connect();
  await assert.rejects(instance.callTool("echo", {}), (error) => error.code === "TIMEOUT");
  await new Promise(setImmediate);
  const cancellations = sent.filter((message) => message.method === "notifications/cancelled");
  t.diagnostic(JSON.stringify({ toolRequestId, cancellations, transportAborted: aborted }));
  assert.ok(
    cancellations.some(
      (message) => message.params?.requestId === toolRequestId && message.params?.reason === "timeout",
    ),
    "the timeout must notify the server with the matching request id",
  );
});
test("B06 Pi history: torn non-UTF8 tail must preserve preceding valid messages", async (t) => {
  const dir = await scratch(t);
  const sessions = join(dir, "sessions");
  await mkdir(sessions);
  const file = join(sessions, "fixture.jsonl");
  const header = {
    type: "session",
    version: 3,
    id: "audit-native",
    timestamp: "2026-10-19T00:00:00.000Z",
    cwd: dir,
  };
  const message = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp: "2026-10-19T00:00:01.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "SAFE_HISTORY_MARKER" }],
      timestamp: 1,
    },
  };
  await writeFile(
    file,
    Buffer.concat([
      Buffer.from(JSON.stringify(header) + "\n" + JSON.stringify(message) + "\n"),
      Buffer.from([0xff, 0xfe, 0x7b]),
    ]),
  );
  const service = new NativePiSessionService({ agentDir: dir, sessionRoot: sessions });
  const list = await service.list();
  assert.equal(list.length, 1);
  const detail = service.detail(list[0].id);
  assert.ok(detail.messages.some((m) => m.content.includes("SAFE_HISTORY_MARKER")));
});
test("B07 Pi provider: DeepSeek reasoning does not send unsupported reasoning_effort", async () => {
  const { buildProviderModel, createProviderModels } = await load(
    "packages/agent-runtime/dist/provider-binding.js",
  );
  const config = {
    ...provider,
    apiKey: "AUDIT_DUMMY_KEY",
    authKind: "api_key_and_base_url",
    id: "deepseek",
    vendorKey: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    modelId: "deepseek-reasoner",
    apiStyle: "openai-completions",
    supportsReasoning: true,
    supportedThinkingLevels: ["off", "high"],
  };
  const model = buildProviderModel(config);
  let body;
  const fakeFetch = async (_url, options) => {
    body = JSON.parse(options.body);
    return new Response(
      "data: " +
        JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] }) +
        "\n\ndata: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch;
  try {
    await createProviderModels(config, model)
      .streamSimple(
        model,
        {
          systemPrompt: "audit",
          messages: [{ role: "user", content: "audit", timestamp: 1 }],
          tools: [],
        },
        { reasoning: "high", fetch: fakeFetch },
      )
      .result();
  } finally {
    globalThis.fetch = previousFetch;
  }
  assert.ok(body, "the real adapter must reach the controlled fetch boundary");
  assert.equal(
    Object.hasOwn(body, "reasoning_effort"),
    false,
    "unsupported effort must be omitted for this DeepSeek endpoint",
  );
});
test("B08 Host Read: preserve BOM UTF-16 text instead of treating it as binary", {
  skip: !process.env.OMP_RELEASE_HOST_BINARY && "requires the published installed host",
}, async (t) => {
  const dir = await scratch(t);
  const project = join(dir, "project");
  await mkdir(project);
  const file = join(project, "utf16.txt");
  await writeFile(
    file,
    Buffer.concat([Buffer.from([255, 254]), Buffer.from("UTF16_MARKER 中文\n", "utf16le")]),
  );
  const { HostProcess } = await load("packages/host-runtime/dist/host-process.js");
  const host = new HostProcess({
    binaryPath: process.env.OMP_RELEASE_HOST_BINARY,
    dataDir: join(dir, "data"),
    onStderr() {},
  });
  t.after(() => host.dispose());
  await host.handshake();
  const { session } = await host.call("session.create", {
    projectPath: project,
    engine: "pi",
    mode: "agent",
    providerId: "audit",
    modelId: "audit-model",
  });
  const result = await host.call("tools.execute", {
    sessionId: session.id,
    toolCallId: "utf16",
    toolName: "Read",
    args: { path: "utf16.txt" },
    mode: "agent",
  });
  assert.equal(result.ok, true, `Read must accept BOM UTF-16 text: ${JSON.stringify(result)}`);
  assert.match(JSON.stringify(result.content), /UTF16_MARKER/);
});
test("B09 Context: output tokens already include reasoning tokens", async () => {
  const { contextOccupancyTokens } = await load("apps/desktop/src/lib/context-usage.ts");
  assert.equal(
    contextOccupancyTokens({
      inputTokens: 100,
      outputTokens: 30,
      reasoningTokens: 10,
      totalTokens: 130,
    }),
    130,
    "reasoning must not be counted twice",
  );
});
test("B10 Host Edit: moving to a normalized alias preserves the source bytes", {
  skip: !process.env.OMP_RELEASE_HOST_BINARY && "requires the published installed host",
}, async (t) => {
  const dir = await scratch(t);
  const project = join(dir, "project");
  await mkdir(project);
  const file = join(project, "source.txt");
  await writeFile(file, "SOURCE_MUST_SURVIVE\n");
  const { HostProcess } = await load("packages/host-runtime/dist/host-process.js");
  const host = new HostProcess({
    binaryPath: process.env.OMP_RELEASE_HOST_BINARY,
    dataDir: join(dir, "data"),
    onStderr() {},
  });
  t.after(() => host.dispose());
  await host.handshake();
  const { session } = await host.call("session.create", {
    projectPath: project,
    engine: "pi",
    mode: "agent",
    providerId: "audit",
    modelId: "audit-model",
  });
  await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "auto" });
  const read = await host.call("tools.execute", {
    sessionId: session.id,
    toolCallId: "read-move",
    toolName: "Read",
    args: { path: "source.txt" },
    mode: "agent",
  });
  assert(read.ok);
  assert(read.content.tag);
  const moved = await host.call("tools.execute", {
    sessionId: session.id,
    toolCallId: "same-move",
    toolName: "Edit",
    args: { path: "source.txt", tag: read.content.tag, ops: "MV ./source.txt" },
    mode: "agent",
  });
  assert.equal(moved.ok, false, "an alias of the source must be rejected before mutation");
  assert.equal(moved.errorCode, "EDIT_NO_CHANGE");
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(file, "utf8"), "SOURCE_MUST_SURVIVE\n");
  const edited = await host.call("tools.execute", {
    sessionId: session.id,
    toolCallId: "edit-after-rejected-move",
    toolName: "Edit",
    args: { path: "source.txt", tag: read.content.tag, ops: "PUT 1.=1:\n+ORIGINAL_TAG_STILL_VALID\n" },
    mode: "agent",
  });
  assert.equal(edited.ok, true, "refusal must preserve the original Read provenance");
  assert.equal(await readFile(file, "utf8"), "ORIGINAL_TAG_STILL_VALID\n");
});
test("B11 OMP native Read: BOM UTF-16 reaches the model correctly", {
  timeout: 90000,
  skip: !process.env.OMP_BUNDLED_RESOURCES && "requires the published OMP resources",
}, async (t) => {
  const dir = await scratch(t);
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(
    join(project, "utf16.txt"),
    Buffer.concat([Buffer.from([255, 254]), Buffer.from("UTF16_MARKER 中文\n", "utf16le")]),
  );
  const { FakeProvider } = await load("experiments/omp-bridge/lib/provider.mjs");
  const { writeModelsConfig } = await load("experiments/omp-bridge/lib/models-config.mjs");
  const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime } =
    await load("packages/omp-runtime/dist/index.js");
  const { createOmpSessionBridge } = await load(
    "apps/desktop/electron/main/runtime/omp-session.ts",
  );
  const runtime = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
  const provider = await FakeProvider.start();
  let ended;
  const finished = new Promise((r) => (ended = r));
  const sessionDir = ensureSessionStateDir(dir);
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot: dir,
    launcherPath: runtime.path,
    expectedRuntimeVersion: "18.3.0",
    sessionDir,
    args: ["--model", "m1fake/local-model", "--trusted-extension", findGateExtension(root)],
    prepareRun: (p) => writeModelsConfig(p.agentDir, { baseUrl: provider.baseUrl }),
  });
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: runtime.path,
    isPackaged: false,
    appPath: root,
    sessionDir,
    gateResolver: () => findGateExtension(root),
    sessionPolicy: { policy: async () => ({ mode: "agent", permissionMode: "auto" }) },
    emitAgentEvent: (e) => {
      if (e.event.type === "agent_end") ended();
    },
  });
  t.after(async () => {
    await bridge.dispose();
    const result = await supervisor.stop();
    assert(result.reaped);
    await provider.close();
  });
  provider.script([
    {
      toolCalls: [{ id: "read-encoding", name: "read", args: { path: "utf16.txt" } }],
      finish: "tool_calls",
    },
    { text: "AUDIT_READ_DONE", finish: "stop" },
  ]);
  await bridge.prompt({
    sessionId: "audit-encoding",
    content: "Read the encoding fixture.",
    projectPath: project,
    providerId: "m1fake",
    modelId: "local-model",
  });
  await finished;
  assert.equal(bridge.workingDirectory("audit-encoding"), project);
  const toolMessages = provider.requests.flatMap(
    (r) => r.body?.messages?.filter((m) => m.role === "tool") ?? [],
  );
  assert.ok(
    provider.requests.some((r) => JSON.stringify(r.body).includes("UTF16_MARKER")),
    `native Read result must decode UTF-16: ${JSON.stringify(toolMessages)}`,
  );
});
test("B12 Review diff: never execute a project-configured Git textconv helper", async (t) => {
  const dir = await scratch(t);
  const { execFileSync } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Audit Fixture");
  git("config", "user.email", "audit@example.invalid");
  git("config", "commit.gpgsign", "false");
  const hooks = join(dir, ".git", "empty-hooks");
  await mkdir(hooks);
  git("config", "core.hooksPath", hooks);
  await writeFile(join(dir, ".gitattributes"), "tracked.txt diff=audit\n");
  await writeFile(join(dir, "tracked.txt"), "before\n");
  const helper = join(dir, ".git", "textconv.cjs");
  await writeFile(
    helper,
    'const fs=require("node:fs");fs.appendFileSync(".textconv-ran","ran\\n");process.stdout.write(fs.readFileSync(process.argv[2]));\n',
  );
  const quote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
  git("config", "diff.audit.textconv", quote(process.execPath) + " " + quote(helper));
  git("add", "tracked.txt", ".gitattributes");
  git("commit", "-qm", "fixture baseline");
  await writeFile(join(dir, "tracked.txt"), "after\n");
  assert.equal(existsSync(join(dir, ".textconv-ran")), false);
  const { collectWorkspaceDiff } = await load("packages/host-runtime/dist/workspace-diff.js");
  const result = await collectWorkspaceDiff(dir);
  assert.equal(result.repo, true);
  assert.equal(
    existsSync(join(dir, ".textconv-ran")),
    false,
    "opening the review diff must not execute a repository-configured converter",
  );
});
test("B13 Queue: retain attachment metadata and bytes after a real host restart", {
  skip: !process.env.OMP_RELEASE_HOST_BINARY && "requires the published installed host",
}, async (t) => {
  const dir = await scratch(t);
  const project = join(dir, "project");
  await mkdir(project);
  const file = join(project, "queued.txt");
  await writeFile(file, "QUEUED_ATTACHMENT_BYTES\n");
  const { HostProcess } = await load("packages/host-runtime/dist/host-process.js");
  let host;
  const start = async () => {
    host = new HostProcess({
      binaryPath: process.env.OMP_RELEASE_HOST_BINARY,
      dataDir: join(dir, "data"),
      onStderr() {},
    });
    await host.handshake();
  };
  t.after(() => host?.dispose());
  await start();
  const { session } = await host.call("session.create", {
    projectPath: project,
    engine: "omp",
    mode: "agent",
  });
  const attachments = [
    { path: file, name: "queued.txt", kind: "file", mimeType: "text/plain", size: 24 },
  ];
  await host.call("session.queuePush", {
    id: "audit-queued-attachment",
    sessionId: session.id,
    principal: "audit",
    inputHash: "audit-attachment-input",
    content: "Queued fixture",
    attachments,
    permissionMode: "ask",
  });
  const before = (await host.call("session.queueList", { sessionId: session.id })).entries;
  assert.equal(before.length, 1);
  assert.deepEqual(before[0].attachments, attachments);
  await host.dispose();
  await start();
  const after = (await host.call("session.queueList", { sessionId: session.id })).entries;
  assert.deepEqual(after, before);
  const { readFile } = await import("node:fs/promises");
  assert.equal(await readFile(file, "utf8"), "QUEUED_ATTACHMENT_BYTES\n");
});
