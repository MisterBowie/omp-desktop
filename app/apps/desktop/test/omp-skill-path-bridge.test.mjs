/**
 * M5/T19-C + T20-B1 probes: the session bridge must refresh the run-scoped
 * desktop runtime state before every prompt (the single file the trusted gate
 * reads) — the mandatory mode/mode-block/effective-permission policy plus the
 * PI-best-effort skill catalog and project memory and the host-tool policy
 * table — and register the on-demand `Skill` host tool exactly when the
 * desktop catalog is non-empty.
 *
 * The B1 contract these probes pin:
 *   - state is written once per prompt, 0600, naming the owning native session;
 *   - mode and effective permission mode are read from the session policy
 *     provider every prompt and a failure to read/validate/write/self-validate
 *     them refuses the prompt before the runtime sees anything;
 *   - skills/memory are best-effort: a failed or malformed snapshot becomes an
 *     empty capability part while the mode/policy half stays exact;
 *   - the host-tool policy table (risk/planSafeActions/origin) rides the same
 *     catalog assembly and its changes participate in the registration
 *     fingerprint.
 */
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { serveTurnFenceCommand } = await import(
  "../../../packages/omp-runtime/src/session/turn-fence-testkit.ts"
);
const { OmpSessionRunner } = await import("../../../packages/omp-runtime/src/session/runner.ts");
const { DESKTOP_STATE_FILE } = await import("../../../packages/omp-runtime/src/desktop-state.ts");
const { composeModeSystemPrompt } = await import("../../../packages/agent-runtime/src/mode-prompts.ts");

/** Every temporary directory this file creates, removed in `after`. */
const scratch = [];
after(() => {
  for (const entry of scratch.splice(0)) rmSync(entry, { recursive: true, force: true });
});

function makeProject() {
  const path = mkdtempSync(join(tmpdir(), "omp-skill-bridge-project-"));
  scratch.push(path);
  return path;
}

/** A runtime the bridge can write to, with scriptable command answers. */
class FakeRuntime {
  pid = 4321;
  usable = true;
  written = [];
  commands = [];
  #frames = new Set();
  #failures = new Set();

  write(frame) {
    this.written.push(frame);
    return this.usable;
  }

  async request(command) {
    // The turn fence is answered transparently and never logged: the command
    // sequences asserted in this file describe the desktop's own protocol.
    const fence = serveTurnFenceCommand(command, (frame) => this.push(frame));
    if (fence) return fence;
    this.commands.push(command);
    if (command.type === "set_host_tools") {
      return { success: true, data: { toolNames: command.tools.map((tool) => tool.name) } };
    }
    if (command.type === "new_session") return { success: true, data: { cancelled: false } };
    if (command.type === "get_state") {
      return { success: true, data: { sessionId: "native-id", sessionFile: this.nativeSessionPath, sessionName: "session" } };
    }
    if (command.type === "switch_session") return { success: true, data: { cancelled: false } };
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
}

function fakeSupervisor(runtime, runRoot) {
  return {
    started: 0,
    setWorkingDirectory() {},
    status() {
      return {
        engine: "omp",
        phase: this.started > 0 ? "idle" : "stopped",
        runtimeVersion: this.started > 0 ? "18.3.0" : null,
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
    runRoot: () => runRoot,
    async reclaimAll() {
      return [];
    },
  };
}

/**
 * A harness with a mutable capabilities snapshot, a mutable session policy, a
 * real temp run root per session, and a host-tools provider that records its
 * catalog requests.
 */
function skillBridgeHarness({ skills = [], memory, perSession = {}, policy, hostToolsByProject = {} } = {}) {
  const live = { skills, memory };
  const snapshots = [];
  const catalogRequests = [];
  const policyReads = [];
  const warnings = [];
  const livePolicy = policy ?? {};
  const provider = {
    snapshots,
    catalogRequests,
    policyReads,
    warnings,
    live,
    livePolicy,
    hostToolsByProject,
    capabilities: {
      snapshot: async (projectPath) => {
        const source = perSession[projectPath] ?? live;
        const snapshot = { skills: [...source.skills], memory: source.memory };
        snapshots.push({ projectPath, ...snapshot });
        return snapshot;
      },
    },
    sessionPolicy: {
      policy: async (sessionId) => {
        policyReads.push(sessionId);
        const current = livePolicy[sessionId] ?? { mode: "agent", permissionMode: "ask" };
        if (current.throw) throw new Error("host policy read failed");
        if (current.missing) return null;
        return { mode: current.mode ?? "agent", permissionMode: current.permissionMode ?? "ask" };
      },
    },
    hostTools: {
      catalog: async (projectPath) => {
        catalogRequests.push(projectPath);
        return hostToolsByProject[projectPath] ?? [];
      },
      executor: () => ({
        execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
      }),
    },
  };
  const runRootsBySession = new Map();
  const runtimes = [];
  const sessionDir = mkdtempSync(join(tmpdir(), "omp-skill-bridge-sessions-"));
  scratch.push(sessionDir);
  const nativeSessionId = "native-id";
  const nativeSessionPath = join(sessionDir, "native-session.jsonl");
  writeFileSync(nativeSessionPath, JSON.stringify({ type: "session", id: nativeSessionId, cwd: "/tmp", timestamp: "2026-01-01T00:00:00.000Z" }) + "\n");

  const bridge = createOmpSessionBridge({
    createSupervisor: (spec) => {
      // A pre-seeded entry (the write-failure probe chmods it first) is kept.
      let runRoot = runRootsBySession.get(spec.sessionId);
      if (!runRoot) {
        runRoot = mkdtempSync(join(tmpdir(), "omp-skill-bridge-runroot-"));
        scratch.push(runRoot);
        runRootsBySession.set(spec.sessionId, runRoot);
      }
      const runtime = new FakeRuntime();
      runtime.nativeSessionPath = nativeSessionPath;
      runtimes.push(runtime);
      return fakeSupervisor(runtime, runRoot);
    },
    launcher: "/repo/upstream/oh-my-pi/packages/coding-agent/scripts/omp",
    isPackaged: false,
    appPath: "/repo/app",
    sessionDir,
    runnerFactory: (options) =>
      new OmpSessionRunner({ ...options, convergeTimeoutMs: 200, abortTimeoutMs: 100 }),
    emitAgentEvent: () => undefined,
    logger: {
      app: (scope, level, message, fields) => {
        if (level === "warn" || level === "error") warnings.push({ scope, level, message, fields });
      },
    },
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
    capabilities: provider.capabilities,
    sessionPolicy: provider.sessionPolicy,
    hostTools: provider.hostTools,
  });
  return {
    bridge,
    get runtime() {
      return runtimes[0];
    },
    runtimes,
    runRootsBySession,
    sessionDir,
    warnings,
    ...provider,
  };
}

function stateFileOf(harness, sessionId) {
  const runRoot = harness.runRootsBySession.get(sessionId);
  return { runRoot, path: join(runRoot, DESKTOP_STATE_FILE) };
}

test("the bridge writes the v2 run-scoped state before the first prompt", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({
    skills: [{ id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes." }],
    memory: "Use the staging database.",
    policy: { "session-omp": { mode: "plan", permissionMode: "accept-edits" } },
  });
  const { bridge, snapshots, policyReads } = harness;
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const runtime = harness.runtime;

  assert.equal(snapshots.length, 1, "the snapshot must be assembled once per prompt");
  assert.deepEqual(policyReads, ["session-omp"], "the host policy must be read once per prompt");
  const { path } = stateFileOf(harness, "session-omp");
  const raw = readFileSync(path, "utf8");
  const state = JSON.parse(raw);
  assert.equal(state.sessionId, "native-id", "the state must name the owning native session");
  assert.equal(typeof state.writtenAt, "number", "the state must carry its write time");
  assert.equal(state.v, 2, "the state must carry the current schema version");
  assert.equal(state.mode, "plan");
  assert.equal(state.modeBlock, composeModeSystemPrompt("plan", ""), "the block must be the production composer output");
  assert.equal(state.permissionMode, "accept-edits", "the effective permission mode rides the same snapshot");
  assert.equal(state.memory, "Use the staging database.");
  assert.deepEqual(state.skills, [{ id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes." }]);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, "the state file must be 0600");

  const commands = runtime.commands;
  const prompt = commands.find((command) => command.type === "prompt");
  assert.ok(prompt, "the prompt must run after the state refresh");
});

test("the mode block follows a host mode change on the very next prompt", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({
    skills: [],
    policy: { "session-omp": { mode: "agent", permissionMode: "ask" } },
  });
  const { bridge } = harness;
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const { path } = stateFileOf(harness, "session-omp");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).modeBlock, composeModeSystemPrompt("agent", ""));

  harness.livePolicy["session-omp"] = { mode: "goal", permissionMode: "auto" };
  harness.runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });
  const rewritten = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(rewritten.mode, "goal");
  assert.equal(rewritten.modeBlock, composeModeSystemPrompt("goal", ""));
  assert.equal(rewritten.permissionMode, "auto");
  assert.ok(!readFileSync(path, "utf8").includes(composeModeSystemPrompt("agent", "")), "the old block must not linger");
});

test("the Skill host tool rides the catalog exactly when the desktop catalog is non-empty", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({ skills: [] });
  const { bridge } = harness;
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const runtime = harness.runtime;

  const registrations = runtime.commands.filter((command) => command.type === "set_host_tools");
  assert.equal(registrations.length, 1);
  assert.ok(
    !registrations[0].tools.some((tool) => tool.name === "Skill"),
    "an empty skill catalog must not register the Skill tool (the PI gate)",
  );

  // Skills appear between prompts: the next registration carries the tool and
  // the state file now lists the catalog.
  harness.live.skills = [{ id: "demo.hello/release-notes", name: "Release notes", description: "" }];
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });

  const after = runtime.commands.filter((command) => command.type === "set_host_tools");
  assert.equal(after.length, 2, "the changed catalog must re-register");
  const skillTool = after[1].tools.find((tool) => tool.name === "Skill");
  assert.ok(skillTool, "a non-empty catalog must register the Skill tool");
  assert.equal(skillTool.loadMode, "essential");
  assert.match(skillTool.description, /load the full instructions of one skill/i);
  const { path } = stateFileOf(harness, "session-omp");
  assert.ok(readFileSync(path, "utf8").includes("demo.hello/release-notes"));
});

test("a policy read failure, a missing row or an unknown policy refuses the prompt before submission", async () => {
  const project = makeProject();
  for (const broken of [{ throw: true }, { missing: true }, { mode: "chat" }, { permissionMode: "inherit" }]) {
    const harness = skillBridgeHarness({ skills: [], policy: { "session-omp": broken } });
    const { bridge, warnings } = harness;
    await assert.rejects(
      () => bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project }),
      (error) => error?.errorCode === "OMP_CAPABILITY_STATE_FAILED",
      `policy ${JSON.stringify(broken)} must refuse the prompt`,
    );
    assert.equal(
      harness.runtime.commands.some((command) => command.type === "prompt"),
      false,
      "no prompt may reach the runtime without a validated policy",
    );
    assert.ok(warnings.length >= 1, "the failure must be logged");
  }
});

test("a state write failure refuses the prompt before submission", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({
    skills: [{ id: "demo.hello/release-notes", name: "Release notes", description: "" }],
  });
  const { bridge, warnings } = harness;
  // Make the run root unwritable after the bridge builds it: the state
  // writer's exclusive create fails, and the prompt must fail before reaching
  // the runtime — the gate would otherwise read whatever previous state the
  // run root still held.
  const runRoot = mkdtempSync(join(tmpdir(), "omp-skill-bridge-runroot-"));
  scratch.push(runRoot);
  harness.runRootsBySession.set("session-omp", runRoot);
  chmodSync(runRoot, 0o500);
  try {
    await assert.rejects(
      () => bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project }),
      (error) => error?.errorCode === "OMP_CAPABILITY_STATE_FAILED" && /could not be written/i.test(String(error?.message)),
    );
    const runtime = harness.runtime;
    assert.equal(
      runtime.commands.some((command) => command.type === "prompt"),
      false,
      "no prompt may reach the runtime while the state could not be written",
    );
    assert.equal(
      runtime.commands.some((command) => command.type === "set_host_tools"),
      false,
      "no host tools may be registered either: the prompt failed before submission",
    );
    assert.ok(warnings.length >= 1, "the failure must be logged");
  } finally {
    chmodSync(runRoot, 0o700);
  }
});

test("a capability snapshot failure keeps the exact mode/policy and only empties the capability part", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({
    skills: [{ id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes." }],
    memory: "first-turn memory",
    policy: { "session-omp": { mode: "plan", permissionMode: "auto" } },
  });
  const { bridge, warnings } = harness;
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const runtime = harness.runtime;
  const { path } = stateFileOf(harness, "session-omp");
  const first = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(first.memory, "first-turn memory");

  // The second turn's snapshot fails. The previous state must not survive,
  // but the mode/policy half must stay exact — the prompt keeps the PI
  // best-effort experience.
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  harness.capabilities.snapshot = async () => {
    throw new Error("host unavailable during the second snapshot");
  };
  const second = await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });
  assert.equal(second.accepted, true, "a snapshot failure keeps the PI best-effort prompt experience");

  const after = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(after.sessionId, "native-id");
  assert.equal(after.mode, "plan", "the mode must survive a capability failure");
  assert.equal(after.modeBlock, composeModeSystemPrompt("plan", ""));
  assert.equal(after.permissionMode, "auto", "the effective permission mode must survive a capability failure");
  assert.deepEqual(after.skills, [], "the stale catalog must be gone");
  assert.equal(after.memory, null, "the stale memory must be gone");
  assert.ok(!readFileSync(path, "utf8").includes("first-turn memory"), "no stale memory text may remain");

  const registrations = runtime.commands.filter((command) => command.type === "set_host_tools");
  const lastRegistration = registrations[registrations.length - 1];
  assert.ok(
    !lastRegistration.tools.some((tool) => tool.name === "Skill"),
    "the Skill tool must be withdrawn with the emptied catalog",
  );
  assert.ok(warnings.some((entry) => /snapshot failed/i.test(entry.message)), "the snapshot failure must be logged");
});

test("a malformed skill entry degrades to a smaller catalog instead of poisoning the state", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({
    skills: [
      { id: "", name: "Gate rejects empty ids", description: "" },
      { id: "keep-me", name: "Keep", description: "" },
    ],
  });
  const { bridge, warnings } = harness;
  const accepted = await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  assert.equal(accepted.accepted, true, "a bad catalog line is best-effort, not a refused prompt");

  const runtime = harness.runtime;
  const registrations = runtime.commands.filter((command) => command.type === "set_host_tools");
  assert.equal(registrations.length, 1);
  assert.ok(
    registrations[0].tools.some((tool) => tool.name === "Skill"),
    "the surviving skill still registers the Skill tool",
  );
  const { path } = stateFileOf(harness, "session-omp");
  const state = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(state.skills, [{ id: "keep-me", name: "Keep", description: "" }]);
  assert.ok(warnings.some((entry) => /invalid skill/i.test(entry.message)), "the drop must be logged");
});

test("host-tool policy rides the state and a risk/plan-safe change alone re-registers", async () => {
  const project = makeProject();
  const entry = (overrides = {}) => ({
    definition: {
      name: "plugin_demo_run",
      description: "Run something",
      parameters: { type: "object" },
      loadMode: "essential",
    },
    risk: "low",
    planSafeActions: [],
    origin: "plugin",
    ...overrides,
  });
  // The Agent catalogue also carries the desktop's two model-side mode entries
  // (M5/T20-D-Enter), so their policies ride every Agent state.
  const desktopEntries = [
    { name: "EnterPlanMode", risk: "low", planSafeActions: [], origin: "desktop" },
    { name: "EnterGoalMode", risk: "low", planSafeActions: [], origin: "desktop" },
  ];
  const harness = skillBridgeHarness({ skills: [], hostToolsByProject: { [project]: [entry()] } });
  const { bridge } = harness;
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const runtime = harness.runtime;
  const { path } = stateFileOf(harness, "session-omp");
  const first = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(first.hostTools, [
    { name: "plugin_demo_run", risk: "low", planSafeActions: [], origin: "plugin" },
    ...desktopEntries,
  ]);

  // Only the policy changes: names and schemas are identical. It must still
  // re-register and land in the state.
  harness.hostToolsByProject[project] = [entry({ risk: "high", planSafeActions: ["inspect"] })];
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });

  assert.equal(runtime.commands.filter((command) => command.type === "set_host_tools").length, 2);
  const rewritten = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(rewritten.hostTools, [
    { name: "plugin_demo_run", risk: "high", planSafeActions: ["inspect"], origin: "plugin" },
    ...desktopEntries,
  ]);
});

test("capability failure logs carry no error text, only a stable classification", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({ skills: [], memory: "first notes" });
  const { bridge, warnings } = harness;
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const runtime = harness.runtime;

  // Every channel an exception exposes — message, name, code, errorCode —
  // carries a distinct secret sentinel: none of them may reach a log line.
  const sentinels = ["MSG-CANARY", "NAME-CANARY", "CODE-CANARY", "ERRCODE-CANARY"].map(
    (part) => `${part}-${process.pid}`,
  );
  harness.capabilities.snapshot = async () => {
    throw Object.assign(new Error(sentinels[0]), {
      name: sentinels[1],
      code: sentinels[2],
      errorCode: sentinels[3],
    });
  };
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });
  assert.equal(second.accepted, true);

  const warning = warnings.find((entry) => /snapshot failed/i.test(entry.message));
  assert.ok(warning, "the snapshot failure must be logged");
  const serialized = JSON.stringify(warning.fields ?? {});
  for (const sentinel of sentinels) {
    assert.ok(
      !serialized.includes(sentinel),
      `log fields must never carry the error's ${sentinel.split("-")[0]} text`,
    );
  }
});

test("two sessions keep isolated state files, policies and catalogs", async () => {
  const projectA = makeProject();
  const projectB = makeProject();
  const harness = skillBridgeHarness({
    perSession: {
      [projectA]: { skills: [{ id: "skill-a", name: "A", description: "" }], memory: "memory-a" },
      [projectB]: { skills: [{ id: "skill-b", name: "B", description: "" }], memory: "memory-b" },
    },
    policy: {
      "session-a": { mode: "plan", permissionMode: "accept-edits" },
      "session-b": { mode: "goal", permissionMode: "auto" },
    },
  });
  const { bridge } = harness;
  await bridge.prompt({ sessionId: "session-a", content: "hello", projectPath: projectA });
  await bridge.prompt({ sessionId: "session-b", content: "hello", projectPath: projectB });

  const stateA = JSON.parse(readFileSync(stateFileOf(harness, "session-a").path, "utf8"));
  const stateB = JSON.parse(readFileSync(stateFileOf(harness, "session-b").path, "utf8"));
  assert.deepEqual(stateA.skills, [{ id: "skill-a", name: "A", description: "" }]);
  assert.deepEqual(stateB.skills, [{ id: "skill-b", name: "B", description: "" }]);
  assert.equal(stateA.memory, "memory-a");
  assert.equal(stateB.memory, "memory-b");
  assert.equal(stateA.mode, "plan");
  assert.equal(stateB.mode, "goal");
  assert.equal(stateA.permissionMode, "accept-edits");
  assert.equal(stateB.permissionMode, "auto");
  assert.notEqual(stateFileOf(harness, "session-a").runRoot, stateFileOf(harness, "session-b").runRoot);
});
