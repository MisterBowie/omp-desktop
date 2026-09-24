/**
 * Real-runtime probes for the run-scoped capability-source boundary (M5/T19-A).
 *
 * Every probe drives the *pinned* OMP 18.2.7 runtime through the product
 * supervisor/bridge and asserts observable behavior — files the runtime would
 * load, processes it would spawn, and prompts it would assemble — never source
 * text. The launch arguments are captured from the production constructor
 * (`createDesktopEngineRuntime`), so the probes exercise the same flag set the
 * product passes, including the switch from `--extension` to the trusted
 * `--trusted-extension` allowlist.
 *
 * The consumer-visible failures each probe prevents:
 *
 *   1. A workspace `.mcp.json` / `.omp/mcp.json` / `.claude/.mcp.json` would
 *      connect and register MCP tools inside the desktop session.
 *   2. A workspace (`.claude/settings.json`) or the runtime's own global
 *      `config.yml` could re-enable the OMP memory backend, so memory files
 *      from disk would be injected into the model prompt.
 *   3. An ambient extension (the agent dir's `extensions/`) would load and
 *      execute beside the desktop gate.
 *   4. A duplicate copy of the gate in an ambient discovery path would run a
 *      second policy over the same tool calls.
 *   5. Run paths containing spaces and non-ASCII characters must launch,
 *      converse, and clean up without owned residue.
 */
import assert from "node:assert/strict";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
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
  buildOmpRuntimeEnv,
  defaultPathEntries,
  ensureSessionStateDir,
  findGateExtension,
  findPinnedLauncher,
  terminateProcessTree,
} = await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { createDesktopEngineRuntime } = await import("../electron/main/runtime/engine-runtime.ts");

const LAUNCHER = findPinnedLauncher(here);
const GATE = findGateExtension(here);

/** Every temporary thing this file creates, removed in `after`. */
const scratch = [];

function makeScratch(prefix) {
  const path = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  scratch.push(path);
  return path;
}

function waitFor(predicate, timeoutMs = 30_000, intervalMs = 100) {
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

/** The exact launch arguments the production wiring passes for the gate. */
function productionArgs() {
  let capturedArgs = null;
  createDesktopEngineRuntime({
    dataRoot: "/tmp/omp-e2e-boundary-wiring",
    isPackaged: false,
    appPath: here,
    piRuntimeLive: () => true,
    ompAdapterFactory: (options) => {
      capturedArgs = [...(options.args ?? [])];
      return {
        launcher: "/nonexistent/omp",
        status: () => ({ engine: "omp", phase: "stopped", reason: "not-started", capabilities: {} }),
        reclaim: async () => [],
      };
    },
  });
  return capturedArgs;
}

/** A supervisor over the real pinned runtime, launched like the product does. */
function boundarySupervisor({ dataRoot, project, provider, prepareExtra, sessionDir, extraEnv = {} }) {
  const args = productionArgs();
  const stderrLog = join(dataRoot, "runtime-stderr.log");
  const supervisor = new OmpRuntimeSupervisor({
    dataRoot,
    launcherPath: LAUNCHER,
    expectedRuntimeVersion: "18.2.7",
    sessionDir: sessionDir ?? ensureSessionStateDir(dataRoot),
    args,
    extraEnv,
    spawnImpl: (options) => {
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });
      child.stderr.pipe(createWriteStream(stderrLog, { flags: "a" }));
      return child;
    },
    prepareRun: async (paths) => {
      if (provider) writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" });
      await prepareExtra?.(paths);
    },
    readyTimeoutMs: 60_000,
  });
  if (project) supervisor.setWorkingDirectory(project);
  return { supervisor, stderrLog };
}

/** The last lines of the runtime's stderr, for failure diagnostics. */
function stderrTail(stderrLog) {
  if (!existsSync(stderrLog)) return "(no stderr captured)";
  const lines = readFileSync(stderrLog, "utf8").split("\n").filter(Boolean);
  return lines.slice(-25).join("\n");
}

/** A compact envelope timeline, for failure diagnostics. */
function envelopeTimeline(envelopes) {
  return envelopes
    .map((entry) => {
      const event = entry.event;
      const id = event.toolCallId ? ` ${event.toolCallId}` : "";
      return `${entry.turnId ?? "-"} ${event.type}${id}`;
    })
    .join("\n");
}

function bridgeFor({ supervisor, sessionDir, project, provider }) {
  const envelopes = [];
  const bridge = createOmpSessionBridge({
    createSupervisor: () => supervisor,
    launcher: LAUNCHER,
    isPackaged: false,
    appPath: here,
    sessionDir,
    gateResolver: () => GATE,
    emitAgentEvent: (envelope) => envelopes.push(envelope),
    logger: { app: () => undefined },
  });
  return { bridge, envelopes, provider };
}

/** Raw pinned runtime without the product boundary — the positive control. */
function rawLaunch({ home, agentDir, launchDir, cwd, stderrLog, args = ["--mode", "rpc-ui"] }) {
  const { env } = buildOmpRuntimeEnv({
    home,
    codingAgentDir: agentDir,
    launchDir,
    pathEntries: defaultPathEntries(),
  });
  const child = spawn(LAUNCHER, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });
  if (stderrLog) child.stderr.pipe(createWriteStream(stderrLog, { flags: "a" }));
  else child.stderr.resume();
  return child;
}

/** Resolve when the raw runtime emits its ready frame. */
function waitForRawReady(child, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout });
    const timer = setTimeout(() => reject(new Error("the control runtime never reported ready")), timeoutMs);
    const failed = (error) => {
      clearTimeout(timer);
      lines.close();
      reject(error);
    };
    lines.on("line", (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame && frame.type === "ready") {
          clearTimeout(timer);
          lines.close();
          resolve(frame);
        }
      } catch {
        /* partial line */
      }
    });
    child.on("exit", (code) => failed(new Error(`the control runtime exited before ready (code ${code})`)));
  });
}

/** The memory root OMP derives for a project (encodeProjectPath). */
function memoryRootFor(agentDir, project) {
  const canonical = realpathSync(project);
  const encoded = `--${canonical.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "memories", encoded);
}

/** Wait for an approval envelope for one tool call. */
function approvalFor(envelopes, toolCallId) {
  return envelopes
    .filter((entry) => entry.event.type === "tool_permission_request")
    .map((entry) => entry.event.request)
    .find((request) => request.toolCallId === toolCallId);
}

async function waitForApproval(bridge, envelopes, toolCallId) {
  const ok = await waitFor(() => {
    const request = approvalFor(envelopes, toolCallId);
    return request !== undefined && bridge.hasPendingRequest(request.requestId);
  });
  return { ok, request: approvalFor(envelopes, toolCallId) };
}

test(
  "a workspace MCP config stays undiscovered under the run boundary",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-mcp-project-");
    const dataRoot = makeScratch("omp-e2e-mcp-data-");
    const marker = join(project, "mcp-decoy.loaded");

    const serverScript = join(project, "decoy-server.mjs");
    writeFileSync(
      serverScript,
      [
        'import { writeFileSync } from "node:fs";',
        `writeFileSync(${JSON.stringify(marker)}, "loaded\\n");`,
        "process.stdin.resume();",
        "process.stdin.on('end', () => process.exit(0));",
        "process.on('SIGTERM', () => process.exit(0));",
      ].join("\n"),
    );
    const mcpJson = {
      mcpServers: { decoy: { command: process.execPath, args: [serverScript] } },
    };
    // Three project-level MCP sources OMP discovers from the workspace.
    writeFileSync(join(project, "mcp.json"), JSON.stringify(mcpJson));
    mkdirSync(join(project, ".omp"), { recursive: true });
    writeFileSync(join(project, ".omp", "mcp.json"), JSON.stringify(mcpJson));
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(join(project, ".claude", ".mcp.json"), JSON.stringify(mcpJson));

    try {
      // Positive control: the same pinned runtime WITHOUT the product boundary
      // does discover and connect the decoy server, so an absent marker in the
      // bounded run is a boundary fact, not a broken fixture. The control still
      // needs a configured model: `rpc-ui` exits when none is available.
      const controlProvider = await FakeProvider.start({ model: "local-model" });
      scratch.push({ close: () => controlProvider.close?.() });
      const controlHome = makeScratch("omp-e2e-mcp-home-");
      const controlAgent = join(controlHome, "agent");
      mkdirSync(controlAgent, { recursive: true });
      writeModelsConfig(controlAgent, { baseUrl: controlProvider.baseUrl, modelId: "local-model" });
      const controlCwd = makeScratch("omp-e2e-mcp-cwd-");
      const controlMarker = join(controlCwd, "mcp-decoy.loaded");
      const controlScript = join(controlCwd, "decoy-server.mjs");
      writeFileSync(
        controlScript,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(controlMarker)}, "loaded\\n");`,
          "process.stdin.resume();",
          "process.stdin.on('end', () => process.exit(0));",
          "process.on('SIGTERM', () => process.exit(0));",
        ].join("\n"),
      );
      writeFileSync(
        join(controlCwd, ".mcp.json"),
        JSON.stringify({ mcpServers: { decoy: { command: process.execPath, args: [controlScript] } } }),
      );
      const controlLaunchDir = join(controlHome, "cwd");
      mkdirSync(controlLaunchDir, { recursive: true });
      const control = rawLaunch({
        home: controlHome,
        agentDir: controlAgent,
        launchDir: controlLaunchDir,
        cwd: controlCwd,
        stderrLog: join(controlHome, "control-stderr.log"),
      });
      try {
        await waitForRawReady(control);
        assert.equal(await waitFor(() => existsSync(controlMarker), 30_000), true, "the decoy MCP server must load without the boundary");
      } catch (error) {
        error.message += `\n--- control stderr ---\n${stderrTail(join(controlHome, "control-stderr.log"))}`;
        throw error;
      } finally {
        await terminateProcessTree(null, control.pid, { graceMs: 1_000 }).catch(() => undefined);
      }

      // Bounded run: the product supervisor adds the run-scoped `--config`
      // overlay, so none of the workspace MCP sources may connect. The run
      // carries a fake provider too: `rpc-ui` exits without a configured model.
      const boundedProvider = await FakeProvider.start({ model: "local-model" });
      scratch.push({ close: () => boundedProvider.close?.() });
      const { supervisor } = boundarySupervisor({ dataRoot, project, provider: boundedProvider });
      try {
        await supervisor.start();
        assert.equal(
          await waitFor(() => existsSync(marker), 15_000),
          false,
          "the workspace MCP server must never be spawned under the run boundary",
        );
      } finally {
        const reclaimed = await supervisor.reclaimAll();
        assert.ok(reclaimed.every((entry) => entry.reaped && entry.cleaned), "the bounded run must be reclaimed");
      }
    } finally {
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
  "workspace and global config cannot re-enable the OMP memory backend",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-memory-project-");
    const dataRoot = makeScratch("omp-e2e-memory-data-");
    const canary = `CANARY-M5T19A-MEMORY-${process.pid}`;

    // Lower-priority sources that reopen memory: the workspace's Claude
    // settings (project layer) and the runtime's own global config (which the
    // isolation admits from the run's agent dir).
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "settings.json"),
      JSON.stringify({ memory: { backend: "local" }, mcp: { enableProjectConfig: true } }),
    );

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([{ text: "a fresh answer", finish: "stop" }]);

    const sessionDir = ensureSessionStateDir(dataRoot);
    const { supervisor } = boundarySupervisor({
      dataRoot,
      project,
      provider,
      sessionDir,
      prepareExtra: (paths) => {
        // The global config layer the isolated run admits; the canary memory
        // file the local backend would read back into the model prompt.
        writeFileSync(
          join(paths.agentDir, "config.yml"),
          ["memory:", "  backend: local", "mcp:", "  enableProjectConfig: true"].join("\n"),
        );
        const memoryRoot = memoryRootFor(paths.agentDir, project);
        mkdirSync(memoryRoot, { recursive: true });
        writeFileSync(join(memoryRoot, "memory_summary.md"), `${canary}\n`);
      },
    });
    const { bridge, envelopes } = bridgeFor({ supervisor, sessionDir, project, provider });

    try {
      const first = await bridge.prompt({ sessionId: "e2e-memory-session", content: "say hello", projectPath: project });
      assert.equal(first.accepted, true);
      const answered = await waitFor(() =>
        envelopes.some(
          (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("a fresh answer"),
        ),
      );
      assert.equal(
        answered,
        true,
        `the runtime must answer; timeline:\n${envelopeTimeline(envelopes)}\n--- stderr ---\n${stderrTail(join(dataRoot, "runtime-stderr.log"))}`,
      );
      const bodies = provider.requests.map((request) => JSON.stringify(request.body));
      assert.ok(
        bodies.every((body) => !body.includes(canary)),
        "no request may carry the workspace memory canary: the memory backend must stay off",
      );
    } finally {
      const cleanupErrors = [];
      try {
        await bridge.dispose("e2e finished");
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "E2E cleanup failed");
    }
  },
);

test(
  "ambient extensions are not loaded under the trusted boundary",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const dataRoot = makeScratch("omp-e2e-ambient-data-");
    const marker = join(dataRoot, "ambient-decoy.loaded");

    // `rpc-ui` exits without a configured model, so every probe carries a fake
    // local provider even when no turn is scripted.
    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });

    const { supervisor } = boundarySupervisor({
      dataRoot,
      provider,
      prepareExtra: (paths) => {
        // The runtime's own agent dir is where OMP discovers ambient extension
        // modules; the shipped gate must be the only module that runs.
        mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
        writeFileSync(
          join(paths.agentDir, "extensions", "decoy.ts"),
          [
            'import { writeFileSync } from "node:fs";',
            `writeFileSync(${JSON.stringify(marker)}, "ambient decoy loaded\\n");`,
            "export default function decoy() {}",
          ].join("\n"),
        );
      },
    });

    try {
      await supervisor.start();
      assert.equal(
        await waitFor(() => existsSync(marker), 15_000),
        false,
        "an extension dropped into the agent dir must never load beside the gate",
      );
    } finally {
      const reclaimed = await supervisor.reclaimAll();
      assert.ok(reclaimed.every((entry) => entry.reaped && entry.cleaned), "the ambient run must be reclaimed");
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
  "the desktop gate is the only policy over a tool call",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const project = makeScratch("omp-e2e-gate-project-");
    const dataRoot = makeScratch("omp-e2e-gate-data-");
    const guardedPath = join(project, "guarded.txt");
    writeFileSync(guardedPath, "original\n");

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      {
        text: "Writing the guarded file.",
        finish: "tool_calls",
        toolCalls: [{ id: "call_write", name: "write", args: { path: guardedPath, content: "written by omp\n" } }],
      },
      { text: "done", finish: "stop" },
    ]);

    const sessionDir = ensureSessionStateDir(dataRoot);
    const { supervisor } = boundarySupervisor({
      dataRoot,
      project,
      provider,
      sessionDir,
      extraEnv: {
        OMP_DESKTOP_GATE_TOOLS: "write",
        OMP_DESKTOP_GATE_MODE: "ask",
        OMP_DESKTOP_GATE_TIMEOUT_MS: "60000",
      },
      prepareExtra: (paths) => {
        // A duplicate copy of a gate in an ambient discovery path. Under the
        // old `--extension` loading, this ran a second policy over the same
        // calls; the trusted allowlist must prevent it from loading.
        mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
        writeFileSync(
          join(paths.agentDir, "extensions", "gate-copy.ts"),
          [
            "export default function gateCopy(pi) {",
            "  pi.on('tool_call', (event) => {",
            "    if (event.toolName === 'write') return { block: true, reason: 'blocked by the duplicate gate copy' };",
            "    return undefined;",
            "  });",
            "}",
          ].join("\n"),
        );
      },
    });
    const { bridge, envelopes } = bridgeFor({ supervisor, sessionDir, project, provider });

    try {
      const first = await bridge.prompt({ sessionId: "e2e-gate-session", content: "write the guarded file", projectPath: project });
      assert.equal(first.accepted, true);

      const approval = await waitForApproval(bridge, envelopes, "call_write");
      assert.equal(
        approval.ok,
        true,
        `the shipped gate must raise an approval; timeline:\n${envelopeTimeline(envelopes)}\n--- stderr ---\n${stderrTail(join(dataRoot, "runtime-stderr.log"))}`,
      );
      const approved = bridge.resolvePermission(approval.request.requestId, "allow-once");
      assert.equal(approved.ok, true);

      const written = await waitFor(() => readFileSync(guardedPath, "utf8") === "written by omp\n");
      assert.equal(written, true, "the approved write must land: no second policy may block it");
      const ended = await waitFor(() =>
        envelopes.some((entry) => entry.event.type === "tool_end" && entry.event.toolCallId === "call_write"),
      );
      assert.equal(ended, true);
      const results = envelopes.filter((entry) => entry.event.type === "tool_end" && entry.event.toolCallId === "call_write");
      assert.equal(results.length, 1, "the call must end exactly once");
      assert.ok(
        !JSON.stringify(results[0].event.result).includes("duplicate gate copy"),
        "the duplicate gate copy must never run",
      );
      // Exactly one approval for the call: the gate is loaded exactly once.
      const approvals = envelopes.filter(
        (entry) => entry.event.type === "tool_permission_request" && entry.event.request.toolCallId === "call_write",
      );
      assert.equal(approvals.length, 1, "one gate load means exactly one approval per call");
      assert.equal(bridge.hasPendingRequest(approval.request.requestId), false, "no dialog may be left pending");
    } finally {
      const cleanupErrors = [];
      try {
        await bridge.dispose("e2e finished");
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "E2E cleanup failed");
    }
  },
);

test(
  "run paths with spaces and non-ASCII characters launch, converse, and clean up",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    const base = join(tmpdir(), `omp t19 ü中-${process.pid}`);
    mkdirSync(base, { recursive: true });
    scratch.push(base);
    const project = realpathSync(mkdtempSync(join(base, "project 空格 ")));
    const dataRoot = realpathSync(mkdtempSync(join(base, "data 中文 ")));

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([{ text: "a unicode-path answer", finish: "stop" }]);

    const sessionDir = ensureSessionStateDir(dataRoot);
    const { supervisor } = boundarySupervisor({ dataRoot, project, provider, sessionDir });
    const { bridge, envelopes } = bridgeFor({ supervisor, sessionDir, project, provider });

    try {
      const first = await bridge.prompt({ sessionId: "e2e-unicode-session", content: "say something", projectPath: project });
      assert.equal(first.accepted, true);
      const answered = await waitFor(() =>
        envelopes.some(
          (entry) => entry.event.type === "message_end" && JSON.stringify(entry.event.message).includes("a unicode-path answer"),
        ),
      );
      assert.equal(answered, true, "the runtime must answer on a path with spaces and non-ASCII characters");
      assert.equal(bridge.workingDirectory("e2e-unicode-session"), project);
    } finally {
      const cleanupErrors = [];
      try {
        await bridge.dispose("e2e finished");
      } catch (error) {
        cleanupErrors.push(error);
      }
      // The owned run root (with its config overlay) must be gone; only the
      // persistent native-session directory survives by design.
      const runtimeDir = join(dataRoot, "omp-runtime");
      if (existsSync(runtimeDir)) {
        try {
          assert.deepEqual(readdirSync(runtimeDir), [], "no run root may survive the stop");
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      for (const entry of scratch.splice(0)) {
        try {
          if (entry && typeof entry.close === "function") await entry.close();
          else rmSync(entry, { recursive: true, force: true });
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "E2E cleanup failed");
    }
  },
);
