/**
 * T19-C probes against the *pinned* OMP 18.2.7 runtime: the desktop skill
 * catalog and project memory reach the provider-visible system prompt through
 * the trusted gate's `before_agent_start`, skill bodies stay out until the
 * model calls the on-demand `Skill` host tool (whose body then reaches a
 * `role:"tool"` message exactly once), edits/removals land on the next prompt
 * without transcript duplication, scope/delete changes fail closed at
 * execution, and OMP-native project skills stay discoverable beside the
 * desktop catalog. No paid provider is used: every run is driven by the local
 * fake provider.
 *
 * On the T19-C baseline (`df49b84`) the bridge ignores the capabilities seam
 * and the gate has no `before_agent_start` handler, so no catalog or memory
 * ever reaches the model and the `Skill` host tool does not exist — every
 * behavioral assertion below fails on that observable absence.
 *
 * Cleanup discipline: every resource (bridge, provider, user-MCP runtime,
 * scratch root) is registered in `t.after` the moment it is created, and the
 * disposers swallow their own errors, so a failing assertion can never leave a
 * runtime process, an HTTP server or a temp root behind — the run must exit
 * with a plain nonzero test result and no orphans.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const ompRuntime = await import("../../../packages/omp-runtime/src/index.ts");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, findPinnedLauncher } = ompRuntime;
// The state-file name is a T19-C export; the baseline lacks it, in which case
// the probes still run and fail on the absent behavior.
const DESKTOP_STATE_FILE = ompRuntime.DESKTOP_STATE_FILE ?? "desktop-state.json";
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { UserMcpRuntime } = await import("../electron/main/user-mcp.ts");
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");
// The production adapter only gains its Skill branch in T19-C. On the T19-C
// baseline it exists (T19-B) but serves no Skill execution, so a Skill call
// fails with the plugin-tool error — the observable red.
let createOmpHostToolAdapter = null;
try {
  ({ createOmpHostToolAdapter } = await import("../electron/main/runtime/omp-host-tools.ts"));
} catch {
  createOmpHostToolAdapter = null;
}
// The capability snapshot module is T19-C itself: absent on the baseline, the
// bridge receives no capabilities and writes no state — the observable red.
let createOmpDesktopCapabilities = null;
try {
  ({ createOmpDesktopCapabilities } = await import("../electron/main/runtime/omp-desktop-capabilities.ts"));
} catch {
  createOmpDesktopCapabilities = null;
}

const LAUNCHER = findPinnedLauncher(here);
const GATE = findGateExtension(here);

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
 * Per-test resource ledger: `t.after` runs the disposers in reverse order,
 * each error isolated, so no child process, server or temp root survives a
 * failed assertion.
 */
function ledger(t) {
  const disposers = [];
  t.after(async () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        await dispose();
      } catch {
        /* cleanup is best-effort and must never hang the run */
      }
    }
  });
  return {
    push(dispose) {
      disposers.push(dispose);
    },
    scratch(prefix) {
      const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
      this.push(() => rmSync(path, { recursive: true, force: true }));
      return path;
    },
  };
}

/** The pinned-launcher supervisor the product drives, with the fake provider. */
function skillSupervisor({ dataRoot, project, provider, sessionDir }) {
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

/** A fake plugin registry carrying one skill whose body lives in a file. */
function skillPlugins({ skillId = "demo.hello/release-notes", name = "Release notes", description = "Draft release notes.", body = "PLUGIN-BODY" } = {}) {
  const state = { body, loaded: true };
  return {
    state,
    plugins: {
      getTools: () => [],
      getSkills: () =>
        state.loaded
          ? [{ id: skillId, pluginId: skillId.split("/")[0], name, description, body: state.body }]
          : [],
      loadSkillBody: (id) => {
        if (!state.loaded || id !== skillId) {
          throw Object.assign(new Error(`unknown skill: ${id}`), { code: "NOT_FOUND" });
        }
        return { id, name, body: state.body };
      },
      listLoaded: () => [{ path: "/nonexistent/plugin" }],
      unload: () => {
        state.loaded = false;
      },
    },
  };
}

/** A fake host-core serving scriptable memory, per the PI read semantics. */
function fakeHost(memoryStore) {
  return {
    call: async (method) => {
      if (method === "project.group.context") {
        const memory = memoryStore.current;
        return { context: memory ? { memory: { content: memory } } : null };
      }
      if (method === "project.memory.get") {
        const memory = memoryStore.current;
        return memory ? { memory: { content: memory } } : { memory: null };
      }
      return {};
    },
  };
}

/**
 * The T19-C seams, assembled the way the product assembles them: the
 * *production* capability snapshot provider and adapter over the fake
 * registries. Absent modules degrade to "no seam", which is the baseline's
 * observable absence.
 */
function skillProvider({ host, plugins, activeUserSkills = async () => [] }) {
  const capabilities = createOmpDesktopCapabilities
    ? createOmpDesktopCapabilities({
        host: () => host,
        plugins,
        pluginActiveInProject: () => true,
        activeUserSkills,
        log: () => undefined,
      })
    : null;
  const adapter = createOmpHostToolAdapter
    ? createOmpHostToolAdapter({
        plugins,
        userMcp: { toolsForProject: async () => [], callTool: async () => "unused" },
        pluginActiveInProject: () => true,
        loadBuiltinSkillBody: () => null,
        loadUserSkillBody: async () => null,
        activeUserSkills,
      })
    : null;
  return { capabilities, hostTools: adapter };
}

function systemMessages(provider) {
  const out = [];
  for (const request of provider.requests) {
    const messages = request.body?.messages ?? [];
    for (const message of messages) {
      if (message && typeof message === "object" && message.role === "system") {
        out.push({ request, text: String(message.content ?? "") });
      }
    }
  }
  return out;
}

function nonSystemBodies(provider) {
  const out = [];
  for (const request of provider.requests) {
    const messages = request.body?.messages ?? [];
    for (const message of messages) {
      if (message && typeof message === "object" && message.role !== "system") {
        out.push(JSON.stringify(message));
      }
    }
  }
  return out;
}

test(
  "the desktop catalog and project memory reach the system prompt; skill bodies stay out",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const cleanup = ledger(t);
    const project = cleanup.scratch("omp-e2e-skill-project-");
    const dataRoot = cleanup.scratch("omp-e2e-skill-data-");
    const memoryCanary = `memory-canary-${process.pid}`;
    const bodyCanary = `BODY-CANARY-${process.pid}`;
    const skill = skillPlugins({ body: `${bodyCanary}\nDo the release notes.` });
    const memoryStore = { current: `Use the staging database. ${memoryCanary}` };
    const host = fakeHost(memoryStore);
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    cleanup.push(() => userMcp.disposeAll());

    const provider = await FakeProvider.start({ model: "local-model" });
    cleanup.push(() => provider.close?.());
    provider.script([{ text: "catalog acknowledged", finish: "stop" }]);

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = skillSupervisor({ dataRoot, project, provider, sessionDir });
    const { capabilities, hostTools } = skillProvider({ host, plugins: skill.plugins });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...(capabilities ? { capabilities } : {}),
      ...(hostTools ? { hostTools } : {}),
    });
    cleanup.push(() => bridge.dispose("e2e finished").catch(() => undefined));

    const started = await bridge.prompt({ sessionId: "e2e-skill-session", content: "what can you do?", projectPath: project });
    assert.equal(started.accepted, true);
    const answered = await waitFor(() =>
      envelopes.some((entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("catalog acknowledged")),
    );
    assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);

    const systems = systemMessages(provider);
    assert.ok(systems.length >= 1, "the provider must receive at least one request");
    const block = systems[systems.length - 1].text;
    assert.ok(block.includes("# Skills"), "the PI skills block must be in the system prompt");
    assert.ok(
      block.includes("- `demo.hello/release-notes` — Release notes: Draft release notes."),
      "the catalog line must carry id, name and description",
    );
    assert.ok(block.includes("# Project memory"), "the PI memory block must be in the system prompt");
    assert.ok(block.includes(memoryCanary), "the memory content must reach the provider-visible prompt");
    assert.ok(block.includes("user-provided context"), "the memory wrapper must mark it durable user context");
    assert.ok(
      provider.requests.every((request) => !JSON.stringify(request.body).includes(bodyCanary)),
      "the skill body must never appear until the model calls the on-demand path",
    );
    assert.ok(
      nonSystemBodies(provider).every((body) => !body.includes(memoryCanary)),
      "the memory must not be duplicated into any non-system message",
    );
  },
);

test(
  "the model loads a skill body through the Skill host tool exactly once, unapproved",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const cleanup = ledger(t);
    const project = cleanup.scratch("omp-e2e-skillbody-project-");
    const dataRoot = cleanup.scratch("omp-e2e-skillbody-data-");
    const bodyCanary = `SKILL-BODY-REACHED-${process.pid}`;
    const skill = skillPlugins({ body: `${bodyCanary}\nFollow me.` });
    const host = fakeHost({ current: null });
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    cleanup.push(() => userMcp.disposeAll());

    const provider = await FakeProvider.start({ model: "local-model" });
    cleanup.push(() => provider.close?.());
    provider.script([
      {
        text: "loading the skill",
        finish: "tool_calls",
        toolCalls: [{ id: "call_skill", name: "Skill", args: { id: "demo.hello/release-notes" } }],
      },
      { text: "the skill answered", finish: "stop" },
    ]);

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = skillSupervisor({ dataRoot, project, provider, sessionDir });
    const { capabilities, hostTools } = skillProvider({ host, plugins: skill.plugins });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...(capabilities ? { capabilities } : {}),
      ...(hostTools ? { hostTools } : {}),
    });
    cleanup.push(() => bridge.dispose("e2e finished").catch(() => undefined));

    const started = await bridge.prompt({ sessionId: "e2e-skillbody-session", content: "load the release-notes skill", projectPath: project });
    assert.equal(started.accepted, true);
    const answered = await waitFor(() =>
      envelopes.some((entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("the skill answered")),
    );
    assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);
    assert.ok(
      envelopes.every((entry) => entry.event.type !== "tool_permission_request"),
      "the read-only Skill path must never raise an approval",
    );

    assert.ok(provider.requests.length >= 2, "the body needs a follow-up model request");
    const first = provider.requests[0];
    assert.ok(
      !JSON.stringify(first.body).includes(bodyCanary),
      "the first request (catalog and arguments) must not carry the body",
    );
    const toolMessages = provider.requests
      .slice(1)
      .flatMap((request) => (request.body?.messages ?? []))
      .filter((message) => message && typeof message === "object" && message.role === "tool");
    const carrying = toolMessages.filter((message) => JSON.stringify(message.content ?? "").includes(bodyCanary));
    assert.equal(carrying.length, 1, "exactly one tool-result message must carry the skill body");
  },
);

test(
  "memory edits and removal reach the next prompt; nothing is duplicated into the transcript",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const cleanup = ledger(t);
    const project = cleanup.scratch("omp-e2e-memory-edit-project-");
    const dataRoot = cleanup.scratch("omp-e2e-memory-edit-data-");
    const firstMemory = `first-notes-${process.pid}`;
    const secondMemory = `second-notes-${process.pid}`;
    const memoryStore = { current: firstMemory };
    const host = fakeHost(memoryStore);
    const skill = skillPlugins();
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    cleanup.push(() => userMcp.disposeAll());

    const provider = await FakeProvider.start({ model: "local-model" });
    cleanup.push(() => provider.close?.());
    provider.script([{ text: "first answer", finish: "stop" }]);

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = skillSupervisor({ dataRoot, project, provider, sessionDir });
    const { capabilities, hostTools } = skillProvider({ host, plugins: skill.plugins });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...(capabilities ? { capabilities } : {}),
      ...(hostTools ? { hostTools } : {}),
    });
    cleanup.push(() => bridge.dispose("e2e finished").catch(() => undefined));

    const first = await bridge.prompt({ sessionId: "e2e-memory-edit-session", content: "hello", projectPath: project });
    assert.equal(first.accepted, true);
    const firstDone = await waitFor(() =>
      envelopes.some((entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("first answer")),
    );
    assert.equal(firstDone, true, "the first turn must complete");

    // The edit is visible on the very next prompt — the state is rewritten
    // per prompt from live host-core reads.
    memoryStore.current = secondMemory;
    provider.script([{ text: "second answer", finish: "stop" }]);
    const second = await bridge.prompt({ sessionId: "e2e-memory-edit-session", content: "again", projectPath: project });
    assert.equal(second.accepted, true);
    const secondDone = await waitFor(() =>
      envelopes.some((entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("second answer")),
    );
    assert.equal(secondDone, true, "the second turn must complete");

    const systems = systemMessages(provider).map((entry) => entry.text);
    assert.equal(systems.filter((text) => text.includes(firstMemory)).length, 1, "the first prompt carries the first memory");
    assert.equal(systems.filter((text) => text.includes(secondMemory)).length, 1, "the second prompt carries the edited memory");
    const last = systems[systems.length - 1];
    assert.ok(last.includes(secondMemory) && !last.includes(firstMemory), "the edited prompt must not carry stale memory");

    // Removal: no `# Project memory` block on the next prompt.
    memoryStore.current = null;
    provider.script([{ text: "third answer", finish: "stop" }]);
    await bridge.prompt({ sessionId: "e2e-memory-edit-session", content: "once more", projectPath: project });
    const thirdDone = await waitFor(() =>
      envelopes.some((entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("third answer")),
    );
    assert.equal(thirdDone, true, "the third turn must complete");
    const afterRemoval = systemMessages(provider).map((entry) => entry.text);
    assert.ok(
      afterRemoval[afterRemoval.length - 1] && !afterRemoval[afterRemoval.length - 1].includes("# Project memory"),
      "removed memory must disappear from the next prompt",
    );
    assert.ok(
      nonSystemBodies(provider).every((body) => !body.includes(firstMemory) && !body.includes(secondMemory)),
      "memory must never be duplicated into non-system transcript messages",
    );
  },
);

test(
  "a plugin unloaded between catalog and execution fails closed with the PI error",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const cleanup = ledger(t);
    const project = cleanup.scratch("omp-e2e-unload-project-");
    const dataRoot = cleanup.scratch("omp-e2e-unload-data-");
    const skill = skillPlugins();
    const host = fakeHost({ current: null });
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    cleanup.push(() => userMcp.disposeAll());

    const provider = await FakeProvider.start({ model: "local-model" });
    cleanup.push(() => provider.close?.());
    provider.script([
      {
        text: "loading the skill",
        finish: "tool_calls",
        toolCalls: [{ id: "call_skill", name: "Skill", args: { id: "demo.hello/release-notes" } }],
        // The delay hands the test a deterministic window: the request is
        // recorded before the response streams, so the unload below provably
        // lands after the catalog was assembled and before the runtime
        // dispatches the Skill call.
        delayMs: 1500,
      },
      { text: "the error was observed", finish: "stop" },
    ]);

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = skillSupervisor({ dataRoot, project, provider, sessionDir });
    const { capabilities, hostTools } = skillProvider({ host, plugins: skill.plugins });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...(capabilities ? { capabilities } : {}),
      ...(hostTools ? { hostTools } : {}),
    });
    cleanup.push(() => bridge.dispose("e2e finished").catch(() => undefined));

    const started = await bridge.prompt({ sessionId: "e2e-unload-session", content: "load the skill", projectPath: project });
    assert.equal(started.accepted, true);
    // Unload the plugin after the catalog was assembled (the prompt is in
    // flight): the live body read at execution must refuse it.
    await waitFor(() => provider.requests.length >= 1);
    skill.plugins.unload();
    const answered = await waitFor(() =>
      envelopes.some((entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("the error was observed")),
    );
    assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);

    const toolMessages = provider.requests
      .flatMap((request) => (request.body?.messages ?? []))
      .filter((message) => message && typeof message === "object" && message.role === "tool");
    assert.ok(
      toolMessages.some((message) => /Skill: unknown skill: demo\.hello\/release-notes/.test(JSON.stringify(message.content ?? ""))),
      "the model must read the PI-shaped refusal for an unloaded skill",
    );
  },
);

test(
  "an OMP-native project skill stays discoverable beside the desktop catalog",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const cleanup = ledger(t);
    const project = cleanup.scratch("omp-e2e-native-skill-project-");
    const dataRoot = cleanup.scratch("omp-e2e-native-skill-data-");
    // The pinned runtime discovers project skills at <cwd>/.omp/skills/<name>/SKILL.md
    // (frontmatter name/description; the walk-up stops at the repo root).
    const nativeBodyCanary = `NATIVE-BODY-${process.pid}`;
    mkdirSync(join(project, ".omp", "skills", "native-skill"), { recursive: true });
    writeFileSync(
      join(project, ".omp", "skills", "native-skill", "SKILL.md"),
      `---\nname: native-skill\ndescription: Native project skill kept enabled\n---\n\n# Native\n\n${nativeBodyCanary}\n`,
    );
    const skill = skillPlugins();
    const host = fakeHost({ current: null });
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    cleanup.push(() => userMcp.disposeAll());

    const provider = await FakeProvider.start({ model: "local-model" });
    cleanup.push(() => provider.close?.());
    provider.script([
      {
        text: "reading the native skill",
        finish: "tool_calls",
        toolCalls: [{ id: "call_native_read", name: "read", args: { path: "skill://native-skill" } }],
      },
      { text: "native acknowledged", finish: "stop" },
    ]);

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = skillSupervisor({ dataRoot, project, provider, sessionDir });
    const { capabilities, hostTools } = skillProvider({ host, plugins: skill.plugins });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...(capabilities ? { capabilities } : {}),
      ...(hostTools ? { hostTools } : {}),
    });
    cleanup.push(() => bridge.dispose("e2e finished").catch(() => undefined));

    const started = await bridge.prompt({ sessionId: "e2e-native-session", content: "list your skills", projectPath: project });
    assert.equal(started.accepted, true);
    const answered = await waitFor(() =>
      envelopes.some((entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("native acknowledged")),
    );
    assert.equal(answered, true, `the turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);

    const systems = systemMessages(provider);
    assert.ok(systems.length >= 1);
    const text = systems[systems.length - 1].text;
    assert.ok(
      text.includes("native-skill"),
      "the native project skill must remain in the runtime's own skill block",
    );
    assert.ok(text.includes("demo.hello/release-notes"), "the desktop catalog must ride beside it");
    // The native skill is loadable on demand through OMP's own `skill://`
    // path: its body reaches a tool-result message and stays out of the
    // catalog request.
    const first = provider.requests[0];
    assert.ok(
      !JSON.stringify(first.body).includes(nativeBodyCanary),
      "the native body must stay out until the read happens",
    );
    const nativeReads = provider.requests
      .slice(1)
      .flatMap((request) => (request.body?.messages ?? []))
      .filter((message) => message && typeof message === "object" && message.role === "tool")
      .filter((message) => JSON.stringify(message.content ?? "").includes(nativeBodyCanary));
    assert.ok(nativeReads.length >= 1, "the native skill body must reach a tool-result message");
  },
);

test(
  "a planted symlink cannot redirect the state write; spaces/non-ASCII paths work; dispose removes the state",
  { timeout: 300_000 },
  async (t) => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const cleanup = ledger(t);
    // A project path with spaces and non-ASCII characters, with its own
    // catalog and memory — the bound project's state, nothing else.
    const project = cleanup.scratch("omp-e2e-space-project-with-中文-");
    const dataRoot = cleanup.scratch("omp-e2e-space-data-with-中文-");
    const memoryCanary = `space-memory-${process.pid}`;
    const skill = skillPlugins({ skillId: "space.project/spaced skill", name: "Spaced skill", description: "skill in a spaced path" });
    const host = fakeHost({ current: memoryCanary });
    const userMcp = new UserMcpRuntime({ createClient: (config) => new McpServerClient(config) });
    cleanup.push(() => userMcp.disposeAll());

    const provider = await FakeProvider.start({ model: "local-model" });
    cleanup.push(() => provider.close?.());
    provider.script([{ text: "spaced answer", finish: "stop" }]);

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = skillSupervisor({ dataRoot, project, provider, sessionDir });
    const { capabilities, hostTools } = skillProvider({ host, plugins: skill.plugins });
    const bridge = createOmpSessionBridge({
      createSupervisor: () => supervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      gateResolver: () => GATE,
      ...(capabilities ? { capabilities } : {}),
      ...(hostTools ? { hostTools } : {}),
    });
    cleanup.push(() => bridge.dispose("e2e finished").catch(() => undefined));

    const started = await bridge.prompt({ sessionId: "e2e-space-session", content: "hello", projectPath: project });
    assert.equal(started.accepted, true);
    const firstDone = await waitFor(() =>
      envelopes.some((entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("spaced answer")),
    );
    assert.equal(firstDone, true, `the first turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);
    const endsAfterFirst = envelopes.filter((entry) => entry.event.type === "message_end").length;

    // The run-root getter is a T19-C supervisor surface: on the baseline it is
    // absent, which is itself the observable red — guarded so the absence
    // cannot break the cleanup that proves the run exits.
    const runRoot = typeof supervisor.runRoot === "function" ? supervisor.runRoot() : null;
    assert.ok(runRoot, "the supervisor must report its run root");
    const statePath = join(runRoot, DESKTOP_STATE_FILE);
    // Plant a symlink at the final state path pointing outside the run root:
    // the per-prompt rewrite must remove the entry itself and never write
    // through it. The first prompt's real state file is removed first so the
    // alias occupies the exact path the next write targets.
    const sentinel = join(dataRoot, "outside-sentinel.txt");
    writeFileSync(sentinel, "untouched\n");
    rmSync(statePath, { force: true });
    symlinkSync(sentinel, statePath);
    const second = await bridge.prompt({ sessionId: "e2e-space-session", content: "once more", projectPath: project });
    assert.equal(second.accepted, true);
    const answered = await waitFor(
      () => envelopes.filter((entry) => entry.event.type === "message_end").length > endsAfterFirst,
    );
    assert.equal(answered, true, `the second turn must complete; timeline:\n${envelopeTimeline(envelopes)}`);
    assert.equal(readFileSync(sentinel, "utf8"), "untouched\n", "the planted symlink target must stay untouched");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.deepEqual(
      state.skills.find((skill) => skill.id === "space.project/spaced skill"),
      { id: "space.project/spaced skill", name: "Spaced skill", description: "skill in a spaced path" },
      "the spaced project's catalog must be in the state file",
    );
    assert.equal(state.memory, memoryCanary);
    const systems = systemMessages(provider);
    const text = systems[systems.length - 1].text;
    assert.ok(text.includes(memoryCanary), "the spaced project's memory must reach the prompt");
    assert.ok(text.includes("space.project/spaced skill"), "the spaced project's catalog must reach the prompt");

    // Dispose inside the test (idempotent — t.after repeats it safely) so the
    // run-root removal can be observed: the state file must die with it.
    await bridge.dispose("e2e finished");
    assert.ok(!existsSync(statePath), "dispose must remove the state file with the run root");
  },
);
