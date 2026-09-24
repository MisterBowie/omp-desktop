/**
 * T19-C probes: the session bridge must refresh the run-scoped
 * desktop-capability state before every prompt (the single file the trusted
 * gate reads), and register the on-demand `Skill` host tool exactly when the
 * desktop catalog is non-empty — never when the state could not be written.
 *
 * These probes run against the bridge as it exists on the T19-C baseline
 * (`df49b84`): the capabilities option is passed as a plain field the baseline
 * bridge ignores, so every assertion below fails on real, observable behavior
 * — no state file is written, no `Skill` tool is registered.
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
const { OmpSessionRunner } = await import("../../../packages/omp-runtime/src/session/runner.ts");
let DESKTOP_STATE_FILE = "desktop-state.json";
try {
  ({ DESKTOP_STATE_FILE } = await import("../../../packages/omp-runtime/src/desktop-state.ts"));
} catch {
  // The T19-C baseline lacks the module; the probes still run and fail on the
  // absent state write, using the file name the implementation will use.
}

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
    runRoot: () => runRoot,
    async reclaimAll() {
      return [];
    },
  };
}

/**
 * A harness with a mutable capabilities snapshot, a real temp run root per
 * session, and a host-tools provider that records its catalog requests.
 */
function skillBridgeHarness({ skills = [], memory, perSession = {} } = {}) {
  const live = { skills, memory };
  const snapshots = [];
  const catalogRequests = [];
  const warnings = [];
  const provider = {
    snapshots,
    catalogRequests,
    warnings,
    live,
    capabilities: {
      snapshot: async (projectPath) => {
        const source = perSession[projectPath] ?? live;
        const snapshot = { skills: [...source.skills], memory: source.memory };
        snapshots.push({ projectPath, ...snapshot });
        return snapshot;
      },
    },
    hostTools: {
      catalog: async (projectPath) => {
        catalogRequests.push(projectPath);
        return [];
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
        if (level === "warn") warnings.push({ scope, message });
      },
    },
    gateResolver: () => "/repo/app/packages/omp-runtime/extensions/omp-desktop-gate.ts",
    ...provider.capabilities ? { capabilities: provider.capabilities } : {},
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

test("the bridge writes the run-scoped state before the first prompt", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({
    skills: [{ id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes." }],
    memory: "Use the staging database.",
  });
  const { bridge, snapshots } = harness;
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const runtime = harness.runtime;

  assert.equal(snapshots.length, 1, "the snapshot must be assembled once per prompt");
  const { path } = stateFileOf(harness, "session-omp");
  const raw = readFileSync(path, "utf8");
  const state = JSON.parse(raw);
  assert.equal(state.sessionId, "native-id", "the state must name the owning native session");
  assert.equal(typeof state.writtenAt, "number", "the state must carry its write time");
  assert.equal(state.memory, "Use the staging database.");
  assert.deepEqual(state.skills, [{ id: "demo.hello/release-notes", name: "Release notes", description: "Draft release notes." }]);
  const mode = statSync(path).mode & 0o777;
  assert.equal(mode, 0o600, "the state file must be 0600");

  const commands = runtime.commands;
  const prompt = commands.find((command) => command.type === "prompt");
  assert.ok(prompt, "the prompt must run after the state refresh");
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

test("memory and skill edits reach the rewritten state on the next prompt", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({ skills: [], memory: "first notes" });
  const { bridge } = harness;
  await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
  const runtime = harness.runtime;
  const { path } = stateFileOf(harness, "session-omp");
  assert.ok(readFileSync(path, "utf8").includes("first notes"));

  harness.live.memory = "second notes";
  runtime.push({ type: "agent_end", messages: [] });
  await new Promise((resolve) => setImmediate(resolve));
  await bridge.prompt({ sessionId: "session-omp", content: "again", projectPath: project });
  const rewritten = readFileSync(path, "utf8");
  assert.ok(rewritten.includes("second notes"), "the edit must be visible on the next prompt");
  assert.ok(!rewritten.includes("first notes"), "the old memory must not linger in the state");
});

test("a state write failure degrades consistently: no injection surface, prompt proceeds", async () => {
  const project = makeProject();
  const harness = skillBridgeHarness({
    skills: [{ id: "demo.hello/release-notes", name: "Release notes", description: "" }],
  });
  const { bridge, warnings } = harness;
  // Make the run root unwritable after the bridge builds it: the state writer's
  // exclusive create fails and the bridge must not register the Skill tool.
  // The bridge writes before the prompt, so the directory must be unwritable
  // before the first prompt — plant the failure by wrapping the first prompt
  // with a chmod performed from a mutated harness: the run root is created
  // lazily, so pre-seed it.
  const runRoot = mkdtempSync(join(tmpdir(), "omp-skill-bridge-runroot-"));
  scratch.push(runRoot);
  harness.runRootsBySession.set("session-omp", runRoot);
  chmodSync(runRoot, 0o500);
  try {
    await bridge.prompt({ sessionId: "session-omp", content: "hello", projectPath: project });
    const runtime = harness.runtime;
    const registrations = runtime.commands.filter((command) => command.type === "set_host_tools");
    assert.equal(registrations.length, 1);
    assert.ok(
      !registrations[0].tools.some((tool) => tool.name === "Skill"),
      "a failed state write must not register the Skill tool",
    );
    assert.ok(runtime.commands.some((command) => command.type === "prompt"), "the prompt must still run");
    assert.ok(warnings.length >= 1, "the failure must be logged");
  } finally {
    chmodSync(runRoot, 0o700);
  }
});

test("two sessions keep isolated state files and isolated catalogs", async () => {
  const projectA = makeProject();
  const projectB = makeProject();
  const harness = skillBridgeHarness({
    perSession: {
      [projectA]: { skills: [{ id: "skill-a", name: "A", description: "" }], memory: "memory-a" },
      [projectB]: { skills: [{ id: "skill-b", name: "B", description: "" }], memory: "memory-b" },
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
  assert.notEqual(stateFileOf(harness, "session-a").runRoot, stateFileOf(harness, "session-b").runRoot);
});
