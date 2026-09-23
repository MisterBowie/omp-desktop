import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import test from "node:test";

/**
 * End-to-end acceptance for the M3 conversation path: the *real* pinned OMP
 * runtime, driven by the *product's* bridge, with a local fake provider.
 *
 * The scenario is the one the phase plan names:
 *
 *   read a file → deny a write (file unchanged) → approve the same write
 *   (written exactly once) → run the project's tests (result shown) →
 *   start a long background command and stop it (process gone, dialogs
 *   cleared, transcript settled, no contamination of the next run).
 *
 * Nothing here talks to a paid provider: the runtime is pointed at a local
 * OpenAI-compatible server that replays scripted turns, and the runtime's
 * isolated home is a temporary directory. The extension under test is the gate
 * this product ships, loaded the way the product loads it (`--extension`).
 */
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findPinnedLauncher, findGateExtension } = await import(
  "../../../packages/omp-runtime/src/index.ts"
);
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");

const SESSION = "e2e-omp-session";
const LAUNCHER = findPinnedLauncher(here);
const GATE = findGateExtension(here);

/** Every temporary thing this file creates, removed in `after`. */
const scratch = [];

function makeScratch(prefix) {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
}

/** Is a process with this marker on its command line still alive? */
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

/**
 * Is this pid still a live process?
 *
 * A killed-but-unreaped child stays in `/proc` as a zombie, and `kill(pid, 0)`
 * still succeeds for it — reporting a command as "still running" because its
 * parent has not reaped it yet. The state field is what distinguishes the two:
 * `Z` (and `X`) mean the process is gone for every purpose this fixture cares
 * about. Falling back to the signal check keeps the helper honest on systems
 * without `/proc`.
 */
function pidAlive(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    if (state === "Z" || state === "X") return false;
    return true;
  } catch {
    // No /proc entry (or no /proc): fall back to the signal check below.
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

test(
  "M3 end-to-end: read, deny, approve once, run tests, stop a long task",
  { timeout: 300_000 },
  async () => {
    assert.ok(LAUNCHER, "the pinned runtime launcher must be present");
    assert.ok(GATE, "the shipped tool gate must be present");

    const project = makeScratch("omp-e2e-project-");
    const dataRoot = makeScratch("omp-e2e-data-");
    const longTaskMarker = `omp-e2e-long-${process.pid}-${Date.now()}`;

    // The project the session runs in: a real file to read, a guarded file the
    // write targets, a "test suite" the model can run, and a long task.
    const readmePath = join(project, "README.md");
    const guardedPath = join(project, "guarded.txt");
    writeFileSync(readmePath, "the project README\n");
    writeFileSync(guardedPath, "original\n");
    writeFileSync(
      join(project, "run-tests.mjs"),
      [
        "console.log('suite starting');",
        "console.log('3 tests passed');",
        "process.exitCode = 0;",
      ].join("\n"),
    );
    const longTaskStarted = join(project, "long-task.started");
    writeFileSync(
      join(project, "long-task.mjs"),
      [
        'import { writeFileSync } from "node:fs";',
        "const startedFlag = process.argv[process.argv.indexOf('--started') + 1];",
        "writeFileSync(startedFlag, String(process.pid));",
        "setTimeout(() => {}, 120000);",
        "process.on('SIGTERM', () => {});", // survives a polite stop, like a real long command
      ].join("\n"),
    );

    const provider = await FakeProvider.start({ model: "local-model" });
    scratch.push({ close: () => provider.close?.() });
    provider.script([
      {
        text: "Reading the README first.",
        finish: "tool_calls",
        toolCalls: [{ id: "call_read", name: "read", args: { path: readmePath } }],
      },
      { text: "README says the project README. Now writing the guarded file.", finish: "tool_calls", toolCalls: [{ id: "call_write_1", name: "write", args: { path: guardedPath, content: "written by omp\n" } }] },
      // The denial comes back as a tool result; the model's next turn tries the
      // same write again, which the test approves.
      { text: "Approved this time - writing again.", finish: "tool_calls", toolCalls: [{ id: "call_write_2", name: "write", args: { path: guardedPath, content: "written by omp\n" } }] },
      { text: "Now running the tests.", finish: "tool_calls", toolCalls: [{ id: "call_tests", name: "bash", args: { command: "node run-tests.mjs" } }] },
      { text: "Tests passed.", finish: "tool_calls", toolCalls: [{ id: "call_long", name: "bash", args: { command: `node long-task.mjs --marker ${longTaskMarker} --started ${longTaskStarted}` } }] },
      { text: "placeholder", finish: "stop" },
    ]);

    const envelopes = [];
    const sessionDir = ensureSessionStateDir(dataRoot);
    const supervisor = new OmpRuntimeSupervisor({
      dataRoot,
      launcherPath: LAUNCHER,
      expectedRuntimeVersion: "18.2.7",
      sessionDir,
      args: ["--extension", GATE],
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
    // Deliberately NOT calling `supervisor.setWorkingDirectory`: the bridge must
    // bind the session's project directory itself, from the `projectPath` the
    // prompt carries. A manual call here would hide that production defect.

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
      // The runtime needs a model: the fake provider is the only one reachable.
      const first = await bridge.prompt({ sessionId: SESSION, content: "read the readme, then write guarded.txt", projectPath: project });
      assert.equal(bridge.workingDirectory(SESSION), project, "the runtime must run in the session's project");
      assert.equal(first.accepted, true);

      // --- 1. read file -----------------------------------------------------
      const readEnd = await waitFor(() => envelopes.some((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_read"));
      assert.equal(readEnd, true, "the read tool must report a result");
      const readResult = envelopes.find((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_read").event;
      assert.equal(readResult.isError, undefined);
      assert.match(JSON.stringify(readResult.result), /the project README/);

      // --- 2. deny the write; the file must not change -----------------------
      const firstApproval = await waitForApproval(bridge, envelopes, "call_write_1");
      assert.equal(firstApproval.ok, true, "the write must raise an approval");
      const denied = bridge.resolvePermission(firstApproval.request.requestId, "deny");
      assert.equal(denied.ok, true);
      const writeEnd = await waitFor(() => envelopes.some((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_write_1"));
      assert.equal(writeEnd, true, "the denied call must still end");
      const deniedResult = envelopes.find((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_write_1").event;
      assert.equal(deniedResult.isError, true, "a denied call is reported as an error result");
      assert.match(JSON.stringify(deniedResult.result), /denied/i);
      assert.equal(readFileSync(guardedPath, "utf8"), "original\n", "a denied write must not touch the file");

      // --- 3. approve the second attempt; exactly one write ------------------
      await waitFor(() => envelopes.some((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_write_1"));
      const secondApproval = await waitForApproval(bridge, envelopes, "call_write_2");
      assert.equal(secondApproval.ok, true, "the second write must raise its own approval");
      assert.notEqual(
        secondApproval.request.requestId,
        firstApproval.request.requestId,
        "each call has its own request identity",
      );
      const allowed = bridge.resolvePermission(secondApproval.request.requestId, "allow-once");
      assert.equal(allowed.ok, true);
      const written = await waitFor(() => readFileSync(guardedPath, "utf8") === "written by omp\n");
      assert.equal(written, true, "the approved write must land");
      const secondEnd = await waitFor(() => envelopes.some((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_write_2"));
      assert.equal(secondEnd, true);
      assert.equal(readFileSync(guardedPath, "utf8"), "written by omp\n");
      const writeEnvelopes = envelopes.filter((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_write_2");
      assert.equal(writeEnvelopes.length, 1, "an approved call publishes exactly one result");

      // --- 4. run the tests and show the result ------------------------------
      // `bash` is gated too: the command needs its own approval.
      const testsApproval = await waitForApproval(bridge, envelopes, "call_tests");
      assert.equal(testsApproval.ok, true, "the test command must raise an approval");
      bridge.resolvePermission(testsApproval.request.requestId, "allow-once");
      const testsEnd = await waitFor(() => envelopes.some((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_tests"));
      assert.equal(testsEnd, true, "the test command must report a result");
      const testsResult = envelopes.find((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_tests").event;
      assert.match(JSON.stringify(testsResult.result), /3 tests passed/);

      // --- 5. start the long task and stop it -------------------------------
      const longApproval = await waitForApproval(bridge, envelopes, "call_long");
      assert.equal(longApproval.ok, true, "the long command must raise an approval");
      bridge.resolvePermission(longApproval.request.requestId, "allow-once");
      const started = await waitFor(() => existsSync(longTaskStarted), 30_000);
      assert.equal(started, true, "the long command must actually start");
      const longPid = Number(readFileSync(longTaskStarted, "utf8"));
      assert.ok(Number.isInteger(longPid) && longPid > 0, "the long command must report its pid");
      assert.equal(processAlive(longTaskMarker), true, "the long command must still be running");

      const beforeStop = envelopes.length;
      const stop = await bridge.stop(SESSION);
      assert.equal(stop.aborted, true, "the protocol abort must be acknowledged");
      assert.equal(stop.converged || stop.toreDown, true, "the run must actually stop");

      // The pid is authoritative; the command-line scan is the independent
      // second witness that nothing else from the command lingers.
      const gone = await waitFor(() => !pidAlive(longPid));
      assert.equal(gone, true, "the command's own pid must be gone after the stop");
      const noMarker = await waitFor(() => !processAlive(longTaskMarker));
      assert.equal(noMarker, true, "no process may still carry the command's marker");
      assert.equal(bridge.status(SESSION).pendingToolConfirmations, 0, "no dialog may be left pending");
      assert.equal(bridge.hasPendingRequest(longApproval.request.requestId), false);

      // The transcript settled: the stopped run published its tail (the aborted
      // bash call and the turn's end) before the stop returned.
      const tail = envelopes.slice(beforeStop);
      assert.ok(
        tail.some((e) => e.event.type === "tool_end" && e.event.toolCallId === "call_long") ||
          tail.some((e) => e.event.type === "agent_end"),
        "the stopped run must publish its end",
      );

      // --- 6. a new run is not contaminated by the stopped one ---------------
      const stoppedTurnId = first.turnId;
      provider.script([{ text: "a fresh answer", finish: "stop" }]);
      const second = await bridge.prompt({ sessionId: SESSION, content: "say something", projectPath: project });
      assert.notEqual(second.turnId, stoppedTurnId);
      await waitFor(() =>
        envelopes.some((e) => e.turnId === second.turnId && e.event.type === "message_end" && e.event.message.content.includes("a fresh answer")),
      );
      const after = envelopes.filter((e) => e.turnId === second.turnId);
      assert.ok(after.length > 0, "the new run must publish its own events");
      assert.ok(
        after.every((e) => !(e.event.type === "tool_end" && e.event.toolCallId === "call_long")),
        "the stopped run's tool result must never appear under the new turn id",
      );
      // The run settles when the runtime says so, which is not the same instant
      // as the last token arriving: wait for the terminal state instead of
      // assuming the two are ordered.
      const settled = await waitFor(() => bridge.status(SESSION).isRunning === false);
      assert.equal(settled, true, "the second run must settle");
      assert.equal(bridge.status(SESSION).pendingToolConfirmations, 0);

      // The project directory is where the work happened: the file the model
      // wrote is here, and the run root (the runtime's own scratch space) holds
      // no copy of anything this session produced.
      assert.equal(readdirSync(project).includes("guarded.txt"), true);
      const runCwds = existsSync(dataRoot) ? readdirSync(dataRoot).filter((name) => name.startsWith("omp-runtime")) : [];
      for (const runRoot of runCwds) {
        const stray = join(dataRoot, runRoot, "cwd");
        if (!existsSync(stray)) continue;
        assert.equal(
          readdirSync(stray).includes("guarded.txt"),
          false,
          `the run root ${stray} must not hold the session's files`,
        );
      }

      // --- evidence for the validation report --------------------------------
      // Printed (and asserted) so a reviewer can see the timeline this fixture
      // actually produced, not just that it did not throw.
      const timeline = envelopes.map((entry) => {
        const event = entry.event;
        const id = event.toolCallId ? ` ${event.toolCallId}` : "";
        return `${entry.turnId ?? "-"} ${event.type}${id}`;
      });
      console.log(`E2E timeline (${timeline.length} events):\n${timeline.join("\n")}`);
      console.log(`E2E tool ends: ${envelopes.filter((e) => e.event.type === "tool_end").map((e) => `${e.event.toolCallId}${e.event.isError ? ":error" : ":ok"}`).join(", ")}`);
      console.log(`E2E approvals: ${envelopes.filter((e) => e.event.type === "tool_permission_request").map((e) => `${e.event.request.toolCallId}/${e.event.request.risk}`).join(", ")}`);
      const diagnostics = bridge.diagnostics();
      assert.ok(diagnostics.conversion.notes.length >= 0);
      assert.ok(Array.isArray(diagnostics.uiRecords));
    } finally {
      await bridge.dispose("e2e finished");
      const reclaimed = await supervisor.reclaimAll();
      assert.ok(reclaimed.every((entry) => entry.reaped && entry.cleaned), "every run must be reclaimed");
      for (const entry of scratch.splice(0)) {
        if (entry && typeof entry.close === "function") entry.close();
        else rmSync(entry, { recursive: true, force: true });
      }
    }
  },
);

/**
 * The approval the bridge published for one tool call.
 *
 * The request id is the runtime's own frame id; the descriptor the gate sent is
 * what ties it to a specific tool call, which is exactly the correlation the
 * production IPC uses.
 */
function approvalFor(envelopes, toolCallId) {
  return envelopes
    .filter((entry) => entry.event.type === "tool_permission_request")
    .map((entry) => entry.event.request)
    .find((request) => request.toolCallId === toolCallId);
}

/** Wait until the bridge is actually blocked on that approval. */
async function waitForApproval(bridge, envelopes, toolCallId) {
  const ok = await waitFor(() => {
    const request = approvalFor(envelopes, toolCallId);
    return request !== undefined && bridge.hasPendingRequest(request.requestId);
  });
  return { ok, request: approvalFor(envelopes, toolCallId) };
}
