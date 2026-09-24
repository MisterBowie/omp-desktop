import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

/**
 * F7: two real OMP runtimes alive at the same time, each blocked on its own
 * gate approval, with a local fake provider (no paid calls). Answering A's
 * approval must not release B, and each write must land only in its own
 * project. This is the evidence that approval registry, events, side effects
 * and routing are per-session, not just the fake registry tests.
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

test(
  "F7: concurrent OMP sessions each block on their own approval; answering A never releases B",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    assert.ok(GATE, "the shipped tool gate must be present");

    const dataRoot = makeScratch("omp-f7-data-");
    const sessionDir = ensureSessionStateDir(dataRoot);
    const projectA = makeScratch("omp-f7-proja-");
    const projectB = makeScratch("omp-f7-projb-");
    const targetA = join(projectA, "marker.txt");
    const targetB = join(projectB, "marker.txt");
    writeFileSync(targetA, "before-a\n");
    writeFileSync(targetB, "before-b\n");

    const providerA = await FakeProvider.start({ model: "model-a" });
    const providerB = await FakeProvider.start({ model: "model-b" });
    scratch.push({ close: () => providerA.close?.() }, { close: () => providerB.close?.() });
    // Each provider's single turn asks for one write, then stops.
    providerA.script([{ text: "writing A", finish: "tool_calls", toolCalls: [{ id: "wa", name: "write", args: { path: targetA, content: "written-by-a\n" } }] }, { text: "done a", finish: "stop" }]);
    providerB.script([{ text: "writing B", finish: "tool_calls", toolCalls: [{ id: "wb", name: "write", args: { path: targetB, content: "written-by-b\n" } }] }, { text: "done b", finish: "stop" }]);

    const envelopes = [];
    const makeSupervisor = (spec) =>
      new OmpRuntimeSupervisor({
        dataRoot,
        launcherPath: LAUNCHER,
        expectedRuntimeVersion: "18.2.7",
        sessionDir,
        args: ["--trusted-extension", GATE],
        extraEnv: { OMP_DESKTOP_GATE_TOOLS: "write", OMP_DESKTOP_GATE_MODE: "ask", OMP_DESKTOP_GATE_TIMEOUT_MS: "60000" },
        prepareRun: (paths) => {
          const baseUrl = spec.sessionId === "session-b" ? providerB.baseUrl : providerA.baseUrl;
          const modelId = spec.sessionId === "session-b" ? "model-b" : "model-a";
          writeModelsConfig(paths.agentDir, { baseUrl, modelId });
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
    });

    const approvalFor = (sessionId) =>
      envelopes.filter((e) => e.sessionId === sessionId && e.event.type === "tool_permission_request");

    try {
      // Fire both prompts concurrently; neither may wait for the other.
      await Promise.all([
        bridge.prompt({ sessionId: "session-a", content: "write marker", projectPath: projectA }),
        bridge.prompt({ sessionId: "session-b", content: "write marker", projectPath: projectB }),
      ]);

      // Both runtimes must be alive and blocked on their own approval at the
      // same time.
      assert.ok(await waitFor(() => approvalFor("session-a").length > 0 && approvalFor("session-b").length > 0), "both sessions must reach a pending approval");
      const requestA = approvalFor("session-a")[0].event.request;
      const requestB = approvalFor("session-b")[0].event.request;
      assert.notEqual(requestA.requestId, requestB.requestId);
      assert.ok(bridge.hasPendingRequest(requestA.requestId), "A's approval is pending");
      assert.ok(bridge.hasPendingRequest(requestB.requestId), "B's approval is pending");
      assert.equal(readFileSync(targetA, "utf8"), "before-a\n", "no side effect before approval");
      assert.equal(readFileSync(targetB, "utf8"), "before-b\n", "no side effect before approval");

      // Answer A only: B must stay pending and B's write must not have run.
      const answerA = bridge.resolvePermission(requestA.requestId, "allow-once");
      assert.equal(answerA.ok, true);
      assert.ok(await waitFor(() => readFileSync(targetA, "utf8") === "written-by-a\n"), "A's write must run after its approval");
      assert.equal(readFileSync(targetB, "utf8"), "before-b\n", "B's write must not run from A's approval");
      assert.ok(bridge.hasPendingRequest(requestB.requestId), "B's approval must still be pending");

      // Answer B: B's write runs.
      const answerB = bridge.resolvePermission(requestB.requestId, "allow-once");
      assert.equal(answerB.ok, true);
      assert.ok(await waitFor(() => readFileSync(targetB, "utf8") === "written-by-b\n"), "B's write must run after its approval");

      // Stop A: B's runtime and its completed work are untouched.
      await bridge.stop("session-a");
      assert.equal(readFileSync(targetB, "utf8"), "written-by-b\n", "stopping A must not touch B's project");
    } finally {
      await bridge.dispose("test cleanup");
      for (const entry of scratch.splice(0)) {
        if (entry && typeof entry.close === "function") await entry.close();
        else rmSync(entry, { recursive: true, force: true });
      }
    }
  },
);
