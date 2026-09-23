import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

/**
 * T17 end-to-end acceptance: the *real* pinned OMP runtime, driven by the
 * *product's* bridge, spawns a real `task` child through a local fake provider.
 *
 * Nothing talks to a paid provider. The parent scripts a `task` call that
 * spawns one detached `scout`; the child's own turns are routed by assignment
 * marker. The scenario proves every obtainable fact about the child:
 *
 *   - the three frame families reach the desktop (lifecycle/progress/event);
 *   - the child has a distinct identity and the exact parent tool call;
 *   - the child's tool call is attributed to that parent (`parentToolCallId`);
 *   - a gated child tool (write) fails closed with no side effect (hasUI=false);
 *   - the live `get_subagents` snapshot reconciles the child;
 *   - the child transcript reads back through `get_subagent_messages`;
 *   - parent stop + dispose reclaim the runtime with no residual process.
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findPinnedLauncher, findGateExtension } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");

const SESSION = "e2e-omp-subagent-session";
const LAUNCHER = findPinnedLauncher(here);
const GATE = findGateExtension(here);

const scratch = [];
function makeScratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

function processAlive(marker) {
  try {
    for (const entry of readdirSync("/proc").filter((name) => /^\d+$/.test(name))) {
      try {
        if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker)) return true;
      } catch {
        // The process exited between listing and reading.
      }
    }
    return false;
  } catch {
    return false;
  }
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
  "M5 subagent end-to-end: spawn, frames, attribution, deny no side effect, snapshot, stop",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    assert.ok(GATE, "the shipped tool gate must be present");

    const project = makeScratch("omp-subagent-e2e-project-");
    const dataRoot = makeScratch("omp-subagent-e2e-data-");
    const markerPath = join(project, "child-marker.txt");
    const taskCallId = "call_task_1";
    const childToolId = "call_write_child";

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    // Route the parent and the child deterministically: the child's assignment
    // carries the marker, the parent's does not.
    provider.routeBySession({
      parent: [
        {
          text: "delegating",
          finish: "tool_calls",
          toolCalls: [{
            id: taskCallId,
            name: "task",
            args: {
              context: "subagent evidence",
              tasks: [{ task: "report ALPHA and touch the marker", agent: "task", name: "Scout1" }],
            },
          }],
        },
        { text: "subagent finished", finish: "stop" },
      ],
      subagents: [
        {
          marker: "report ALPHA",
          turns: [
            {
              text: "I will write the marker first.",
              finish: "tool_calls",
              toolCalls: [{ id: childToolId, name: "write", args: { path: markerPath, content: "child wrote\n" } }],
            },
            { text: "ALPHA reported. The write was attempted.", finish: "stop" },
          ],
        },
      ],
    });

    const envelopes = [];
    const rawFrames = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: LAUNCHER,
      expectedRuntimeVersion: "18.2.7",
      sessionDir,
      // `--model` is required for the runtime to forward the child's
      // `subagent_event` frames (discovery alone leaves the child stream
      // unwired); it names the same provider/model the projection writes.
      args: ["--model", "m1fake/local-model", "--extension", GATE],
      extraEnv: {
        OMP_DESKTOP_GATE_TOOLS: "write,bash",
        OMP_DESKTOP_GATE_MODE: "ask",
        OMP_DESKTOP_GATE_TIMEOUT_MS: "60000",
      },
      prepareRun: (paths) => {
        writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" });
        writeFileSync(join(paths.agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
      },
      readyTimeoutMs: 60_000,
    });

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

    try {
      const first = await bridge.prompt({ sessionId: SESSION, content: "delegate a scout", projectPath: project });
      assert.equal(first.accepted, true);
      assert.equal(bridge.workingDirectory(SESSION), project);

      // Capture the raw runtime frames so the three frame families are proven
      // directly, not only through their converted envelopes.
      const runtime = supervisor.currentRuntime();
      assert.ok(runtime, "the runtime must be live after the prompt");
      runtime.onFrame((frame) => rawFrames.push(frame));

      // --- the child spawns and its frames arrive ----------------------------
      const sawLifecycle = await waitFor(() => rawFrames.some((f) => f.type === "subagent_lifecycle"));
      assert.equal(sawLifecycle, true, "a subagent_lifecycle frame must arrive");
      const lifecycle = rawFrames.find((f) => f.type === "subagent_lifecycle");
      assert.equal(lifecycle.payload.parentToolCallId, taskCallId, "the child must name its exact parent task call");
      assert.equal(lifecycle.payload.agent, "task");
      const childId = lifecycle.payload.id;
      assert.ok(typeof childId === "string" && childId.length > 0, "the child must have a distinct identity");

      const sawProgress = await waitFor(() => rawFrames.some((f) => f.type === "subagent_progress"));
      const sawEvent = await waitFor(() => rawFrames.some((f) => f.type === "subagent_event"));
      assert.equal(sawProgress, true, "a subagent_progress frame must arrive");
      assert.equal(sawEvent, true, "a subagent_event frame must arrive");
      const frameFamilies = [...new Set(rawFrames.filter((f) => f.type.startsWith("subagent_")).map((f) => f.type))];
      for (const family of ["subagent_lifecycle", "subagent_progress", "subagent_event"]) {
        assert.ok(frameFamilies.includes(family), `${family} must be among the observed families (${frameFamilies.join(",")})`);
      }

      // --- live snapshot reconciles the child ---------------------------------
      const list = await bridge.listSubagents(SESSION);
      const listed = list.find((entry) => entry.id === childId);
      assert.ok(listed, "the live snapshot must list the child");
      assert.equal(listed.parentToolCallId, taskCallId);

      // --- the child's tool is attributed to the parent, and deny has no side effect
      const childToolEnd = await waitFor(() => envelopes.some((e) => e.event.type === "tool_end" && e.event.toolCallId === childToolId));
      assert.equal(childToolEnd, true, "the child's write call must end");
      const childTool = envelopes.find((e) => e.event.type === "tool_end" && e.event.toolCallId === childToolId);
      assert.equal(childTool.parentToolCallId, taskCallId, "the child's tool must be attributed to the parent task call");
      assert.equal(childTool.agentName, "task");
      assert.equal(childTool.event.isError, true, "a gated child tool (hasUI=false) must fail closed");
      assert.equal(existsSync(markerPath), false, "a denied child write must not touch the filesystem");

      // --- the child's answer streams into the parent transcript ----------------
      const childAnswer = await waitFor(() => envelopes.some((e) => e.parentToolCallId === taskCallId && e.event.type === "message_end" && (e.event.message?.content ?? "").includes("ALPHA")));
      assert.equal(childAnswer, true, "the child's answer must stream into the transcript with parent attribution");
      const childRows = envelopes.filter((e) => e.parentToolCallId === taskCallId);
      assert.ok(childRows.length > 0, "the child must produce rows attributed to its parent");
      assert.ok(childRows.every((e) => e.parentToolCallId === taskCallId));

      // --- bounded transcript read (sessionFile never disclosed) ---------------
      const read = await bridge.readSubagentTranscript(SESSION, childId);
      assert.equal(JSON.stringify(read).includes(sessionDir), false, "the read result must not disclose any native path");
      assert.ok(Array.isArray(read.messages));

      // --- parent stop + dispose reclaim the runtime with no residual process --
      const stop = await bridge.stop(SESSION);
      assert.equal(stop.converged || stop.toreDown, true, "the run must stop");

      await bridge.dispose("e2e finished");
      const reclaimed = await supervisor.reclaimAll();
      assert.ok(reclaimed.every((entry) => entry.reaped && entry.cleaned), "every run must be reclaimed");

      // --- evidence -----------------------------------------------------------
      const childEnvelopes = envelopes.filter((e) => e.parentToolCallId);
      console.log(`subagent E2E frames: ${frameFamilies.join(", ")}`);
      console.log(`subagent E2E child id: ${childId}, parent: ${taskCallId}`);
      console.log(`subagent E2E child rows: ${childRows.length} (${childRows.map((e) => e.event.type).join(", ")})`);
      console.log(`subagent E2E child envelopes: ${childEnvelopes.length}`);
      console.log(`subagent E2E task result delegated: ${envelopes.some((e) => e.event.type === "tool_end" && e.event.toolCallId === taskCallId)}`);
    } finally {
      await bridge.dispose("e2e finished").catch(() => undefined);
      await supervisor.reclaimAll().catch(() => undefined);
      for (const entry of scratch.splice(0)) {
        if (entry && typeof entry.close === "function") entry.close();
        else rmSync(entry, { recursive: true, force: true });
      }
    }
  },
);

test(
  "M5 subagent end-to-end: a policy-allowed child tool executes exactly once",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    assert.ok(GATE, "the shipped tool gate must be present");

    const project = makeScratch("omp-subagent-allow-project-");
    const dataRoot = makeScratch("omp-subagent-allow-data-");
    const markerPath = join(project, "child-marker.txt");
    const taskCallId = "call_task_allow";
    const childToolId = "call_write_allow";

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.routeBySession({
      parent: [
        {
          text: "delegating",
          finish: "tool_calls",
          toolCalls: [{
            id: taskCallId,
            name: "task",
            args: { context: "subagent evidence", tasks: [{ task: "write the marker", agent: "task", name: "ScoutAllow" }] },
          }],
        },
        { text: "subagent finished", finish: "stop" },
      ],
      subagents: [
        {
          marker: "write the marker",
          turns: [
            {
              text: "writing the marker.",
              finish: "tool_calls",
              toolCalls: [{ id: childToolId, name: "write", args: { path: markerPath, content: "written once\n" } }],
            },
            { text: "done", finish: "stop" },
          ],
        },
      ],
    });

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: LAUNCHER,
      expectedRuntimeVersion: "18.2.7",
      sessionDir,
      args: ["--model", "m1fake/local-model", "--extension", GATE],
      extraEnv: {
        OMP_DESKTOP_GATE_TOOLS: "write,bash",
        OMP_DESKTOP_GATE_MODE: "allow",
      },
      prepareRun: (paths) => {
        writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl, modelId: "local-model" });
        writeFileSync(join(paths.agentDir, "config.yml"), "tools:\n  approvalMode: yolo\n");
      },
      readyTimeoutMs: 60_000,
    });

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

    try {
      await bridge.prompt({ sessionId: "e2e-omp-subagent-allow", content: "delegate a scout", projectPath: project });

      const wrote = await waitFor(() => existsSync(markerPath));
      assert.equal(wrote, true, "a policy-allowed child write must execute");
      assert.equal(readFileSync(markerPath, "utf8"), "written once\n");

      // Exactly one result for that tool call: the allow must not re-execute.
      const ends = await waitFor(() => envelopes.filter((e) => e.event.type === "tool_end" && e.event.toolCallId === childToolId).length === 1);
      assert.equal(ends, true, "the child write must publish exactly one result");
      const writeEnds = envelopes.filter((e) => e.event.type === "tool_end" && e.event.toolCallId === childToolId);
      assert.equal(writeEnds.length, 1);
      assert.equal(writeEnds[0].parentToolCallId, taskCallId, "the allowed child write stays attributed to its parent");
      assert.equal(writeEnds[0].agentName, "task");
    } finally {
      await bridge.dispose("e2e finished").catch(() => undefined);
      await supervisor.reclaimAll().catch(() => undefined);
      for (const entry of scratch.splice(0)) {
        if (entry && typeof entry.close === "function") entry.close();
        else rmSync(entry, { recursive: true, force: true });
      }
    }
  },
);
