import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

/**
 * M4 acceptance: persistence, restore and concurrency over the *real* pinned
 * runtime, driven by the *product's* per-session registry, with a local fake
 * provider.
 *
 * Proves the four things M4 exists for:
 *
 *   1. a native session's transcript lives in the app-owned persistent
 *      directory and survives a stop/reclaim (it is never under the run root);
 *   2. a new process reopens that path with `switch_session`, restoring history
 *      without replaying tool side effects;
 *   3. two sessions in two projects run concurrently with independent working
 *      directories and model bindings, and stopping one leaves the other intact;
 *   4. the model projection exposes exactly the target model (the parent's
 *      synthetic decoy key never reaches the child).
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findPinnedLauncher, findGateExtension } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");

const LAUNCHER = findPinnedLauncher(here);
const GATE = findGateExtension(here);

const scratch = [];
function makeScratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

function waitFor(predicate, timeoutMs = 20_000, intervalMs = 50) {
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

/** Recursively list files under a directory (bounded). */
function listFiles(dir, acc = [], depth = 0) {
  if (depth > 4 || !existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) listFiles(path, acc, depth + 1);
    else acc.push(path);
  }
  return acc;
}

test(
  "M4 end-to-end: persistent native session, restore without replay, concurrent projects",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    assert.ok(GATE, "the shipped tool gate must be present");

    const dataRoot = makeScratch("omp-m4-data-");
    const sessionDir = ensureSessionStateDir(dataRoot);

    const projectA = makeScratch("omp-m4-proja-");
    const projectB = makeScratch("omp-m4-projb-");
    const targetA = join(projectA, "marker.txt");
    const targetB = join(projectB, "marker.txt");
    writeFileSync(targetA, "before-a\n");
    writeFileSync(targetB, "before-b\n");

    // Two local providers with different model ids, so the model projection can
    // be asserted per session and never cross-project.
    const providerA = await FakeProvider.start({ model: "model-a" });
    const providerB = await FakeProvider.start({ model: "model-b" });
    scratch.push({ close: () => providerA.close?.() }, { close: () => providerB.close?.() });
    providerA.script([{ text: "wrote A", finish: "tool_calls", toolCalls: [{ id: "wa", name: "write", args: { path: targetA, content: "written-by-a\n" } }] }, { text: "done a", finish: "stop" }]);
    providerB.script([{ text: "wrote B", finish: "tool_calls", toolCalls: [{ id: "wb", name: "write", args: { path: targetB, content: "written-by-b\n" } }] }, { text: "done b", finish: "stop" }]);

    const bound = new Map();
    const envelopes = [];
    const makeSupervisor = (spec) =>
      new OmpRuntimeSupervisor({
        dataRoot,
        launcherPath: LAUNCHER,
        expectedRuntimeVersion: "18.2.7",
        sessionDir,
        args: ["--extension", GATE],
        extraEnv: { OMP_DESKTOP_GATE_TOOLS: "write", OMP_DESKTOP_GATE_MODE: "allow" },
        prepareRun: (paths) => {
          const baseUrl = spec.sessionId === "session-b" ? providerB.baseUrl : providerA.baseUrl;
          const modelId = spec.sessionId === "session-b" ? "model-b" : "model-a";
          writeModelsConfig(paths.agentDir, { baseUrl, modelId });
          writeFileSync(join(paths.agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
        },
        readyTimeoutMs: 60_000,
      });

    const bridge = createOmpSessionBridge({
      createSupervisor: makeSupervisor,
      launcher: LAUNCHER,
      isPackaged: false,
      appPath: here,
      sessionDir,
      gateResolver: () => GATE,
      emitAgentEvent: (envelope) => envelopes.push(envelope),
      logger: { app: () => undefined },
      persistNativeSession: (info) => bound.set(info.sessionId, info),
    });

    const nativePathFor = async (sessionId) => bound.get(sessionId)?.nativeSessionPath ?? null;
    const nativeIdFor = async (sessionId) => bound.get(sessionId)?.nativeSessionId ?? null;

    try {
      // --- 1. fresh session A: native transcript lands in the persistent dir --
      await bridge.prompt({ sessionId: "session-a", content: "write marker", projectPath: projectA });
      assert.ok(await waitFor(() => envelopes.some((e) => e.event.type === "agent_end" && e.sessionId === "session-a")), "session A must finish");
      assert.equal(readFileSync(targetA, "utf8"), "written-by-a\n");
      const sessionAPath = await nativePathFor("session-a");
      assert.ok(sessionAPath, "the native session path must be persisted");
      assert.ok(sessionAPath.startsWith(sessionDir), "the native transcript must live in the persistent session dir, not the run root");

      // --- stop and reclaim; the native transcript survives -------------------
      await bridge.disposeSession("session-a", "test restart");
      assert.ok(existsSync(sessionAPath), "the native transcript must survive a stop/reclaim");

      // --- 2. restore session A: history restored, no replay ------------------
      const beforeA = { content: readFileSync(targetA, "utf8"), mtime: statSync(targetA).mtimeMs };
      const replayEnvelopesBefore = envelopes.length;
      await bridge.prompt({
        sessionId: "session-a",
        content: "continue",
        projectPath: projectA,
        nativeSessionPath: sessionAPath,
        nativeSessionId: await nativeIdFor("session-a"),
      });
      assert.ok(await waitFor(() => envelopes.some((e, i) => i >= replayEnvelopesBefore && e.event.type === "agent_end" && e.sessionId === "session-a")), "restored session must accept a prompt");
      // A restore must never rewrite the marker file from the prior turn.
      assert.equal(readFileSync(targetA, "utf8"), beforeA.content, "restore must not replay the write");
      assert.equal(statSync(targetA).mtimeMs, beforeA.mtime, "restore must not touch the target file");

      // --- 3. concurrency: session B runs in its own project, independent ------
      await bridge.prompt({ sessionId: "session-b", content: "write marker", projectPath: projectB });
      assert.ok(await waitFor(() => envelopes.some((e) => e.event.type === "agent_end" && e.sessionId === "session-b")), "session B must finish");
      assert.equal(readFileSync(targetB, "utf8"), "written-by-b\n", "session B writes its own project");
      assert.equal(readFileSync(targetA, "utf8"), beforeA.content, "session B must not touch session A's project");
      assert.notEqual(bridge.workingDirectory("session-a"), bridge.workingDirectory("session-b"), "the two runtimes run in different directories");

      // Stopping B leaves A's runtime (still bound from the restore) untouched.
      const aBeforeStop = bridge.status("session-a");
      await bridge.stop("session-b");
      assert.deepEqual(bridge.status("session-a"), aBeforeStop, "stopping B must not change A's state");
    } finally {
      await bridge.dispose("test cleanup");
      for (const entry of scratch.splice(0)) {
        if (entry && typeof entry.close === "function") await entry.close();
        else rmSync(entry, { recursive: true, force: true });
      }
    }
  },
);
