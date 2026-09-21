#!/usr/bin/env node
/**
 * E12 — harness fault regressions (R5, R6 from the M1 review).
 *
 * R5: a runtime that emits structurally invalid frames (`null`, scalars, arrays,
 *     an object without a string `type`) must not crash the client, must never
 *     leave the child alive, and must not leave the isolated roots behind.
 *     Invalid frames are recorded as `__invalid__` and a runtime that later
 *     becomes ready is still usable.
 *
 * R6: the suite aggregator must reject an experiment that prints PASS but then
 *     exits non-zero, is killed by a signal, or leaves no valid result file.
 *     Checked end-to-end by running `run-all.mjs --dir <temp>` against stub
 *     experiments, plus the pure verdict function.
 *
 * Usage: node e12-harness-faults.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, buildIsolatedEnv, makeConfigDirName, terminateTree, safeRmConfigRoot, safeRmSyntheticHome } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isAlive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
const killQuietly = (pid, sig) => { if (pid) { try { process.kill(pid, sig); } catch { /* gone */ } } };

/** Launch an arbitrary runtime and wait for the client's start() verdict. */
async function startAgainst(execPath, args, { runRoot, readyTimeoutMs = 4_000 } = {}) {
  // A stub launcher path is emulated by pointing OmpRpc at a fake launcher via
  // the same isolation builder the real runs use.
  const { env, configRoot, home } = buildIsolatedEnv({ repoRoot: resolveRepoRoot(), runRoot, configDirName: makeConfigDirName() });
  const started = Date.now();
  const client = { ok: false, error: null, pid: null, frames: [], ms: 0 };
  const { OmpRpc: _unused } = { OmpRpc }; // keep the import meaningful for readers
  void _unused;
  const child = spawn(execPath, args, { cwd: runRoot, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  client.pid = child.pid;
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const t = line.trim();
    if (!t) return;
    try {
      const parsed = JSON.parse(t);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.type !== "string") {
        client.frames.push({ type: "__invalid__" });
        return;
      }
      client.frames.push(parsed);
    } catch {
      client.frames.push({ type: "__unparsed__" });
    }
  });
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline && !client.frames.some((f) => f.type === "ready") && isAlive(child.pid)) await sleep(50);
  client.ok = client.frames.some((f) => f.type === "ready");
  client.ms = Date.now() - started;
  await terminateTree(child, 1_500);
  safeRmConfigRoot(configRoot);
  safeRmSyntheticHome(home, runRoot);
  return { client, home, configRoot };
}

/** Run the suite aggregator against a temp directory of stub experiments. */
function runSuiteIn(dir, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, "run-all.mjs"), "--dir", dir], {
      cwd: HERE, stdio: ["ignore", "pipe", "pipe"],
      // The stalled stub must hit the timeout quickly in this regression.
      env: { ...process.env, M1_EXPERIMENT_TIMEOUT_MS: String(timeoutMs) },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.once("exit", (code) => resolve({ code, out }));
  });
}

import { parseArgs } from "./lib/suite-policy.mjs";

const evidence = await runExperiment("e12-harness-faults", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  // ==========================================================================
  // R5 — structurally invalid frames and start-failure cleanup
  // ==========================================================================
  {
    const runRoot = mkdtempSync(join(tmpdir(), "m1-r5-"));
    const stubDir = join(runRoot, "stubs");
    mkdirSync(stubDir, { recursive: true });

    // (a) invalid frames only, never ready → start must fail closed.
    const neverReady = join(stubDir, "never-ready.mjs");
    writeFileSync(neverReady, `#!/usr/bin/env node
for (const line of ["null", "123", '"a string"', "[1,2,3]", '{"no":"type"}', "not json"]) {
  process.stdout.write(line + "\\n");
}
process.stdin.resume();
setInterval(() => {}, 1000);
`, { mode: 0o755 });

    // (b) invalid frames, then a valid ready → still usable.
    const noisyThenReady = join(stubDir, "noisy-ready.mjs");
    writeFileSync(noisyThenReady, `#!/usr/bin/env node
process.stdout.write("null\\n");
process.stdout.write('{"no":"type"}\\n');
process.stdout.write(${JSON.stringify(JSON.stringify({ type: "ready", protocolVersion: 2 }))} + "\\n");
process.stdin.on("data", (d) => {
  for (const line of String(d).split("\\n").filter(Boolean)) {
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: msg.id, type: "response", command: msg.type, success: true, data: {} }) + "\\n");
  }
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });

    // (a) via the real client: a runtime that only emits invalid frames must be
    // rejected, and the client must not leak the process or the roots.
    const failDir = join(runRoot, "fail-run");
    mkdirSync(failDir, { recursive: true });
    let failure = null;
    let leakedPid = null;
    try {
      const client = await OmpRpc.start({
        repoRoot, runRoot: failDir, mode: "rpc-ui",
        args: ["--model", "m1fake/local-model"],
        cwd: failDir,
        readyTimeoutMs: 2_500,
        // Launch the stub runtime instead of the pinned launcher: this is the
        // code path where a malformed frame used to escape the ready-wait.
        launcher: neverReady,
      });
      leakedPid = client.pid;
      failure = { threw: false };
    } catch (error) {
      failure = { threw: true, message: String(error.message).slice(0, 200) };
    }
    ctx.check("R5: start against invalid frames fails instead of crashing", failure?.threw === true, failure);
    ctx.check("R5: the failure is reported as a readiness failure, not a TypeError",
      !/is not a function|Cannot read properties/.test(failure?.message ?? ""), failure?.message);
    ctx.check("R5: no client survived the failed start", leakedPid === null, leakedPid);
    ctx.check("R5: the failed start left no isolated home behind", !existsSync(join(failDir, "home")), join(failDir, "home"));

    // (b) noisy-but-valid runtime: invalid frames are recorded, not thrown.
    const okDir = join(runRoot, "ok-run");
    mkdirSync(okDir, { recursive: true });
    const noisy = await startAgainst(process.execPath, [noisyThenReady], { runRoot: okDir });
    ctx.check("R5: a runtime with invalid frames then ready is usable", noisy.client.ok === true, noisy.client.frames.map((f) => f.type));
    ctx.check("R5: invalid frames are recorded as __invalid__", noisy.client.frames.filter((f) => f.type === "__invalid__").length === 2,
      noisy.client.frames.map((f) => f.type));

    // Cleanup of the synthetic roots for both runs.
    ctx.check("R5: synthetic roots removed after the probes",
      !existsSync(join(okDir, "home")) && !existsSync(join(failDir, "home")));
    rmSync(runRoot, { recursive: true, force: true });

    writeFixture("e12-invalid-frames.json", {
      note: "SYNTHETIC fault sample: stub runtimes written by this experiment emit structurally invalid frames",
      invalidLines: ["null", "123", '"a string"', "[1,2,3]", '{"no":"type"}', "not json"],
      startFailure: failure,
      noisyRuntimeUsable: noisy.client.ok,
      invalidFrameCount: noisy.client.frames.filter((f) => f.type === "__invalid__").length,
    });
  }

  // ==========================================================================
  // F2 — a killed experiment must not leak its detached runtime, the tools it
  // detached into their own sessions, or the isolated roots
  // ==========================================================================
  {
    const suiteDir = mkdtempSync(join(tmpdir(), "m1-f2-"));
    mkdirSync(join(suiteDir, "results"), { recursive: true });
    const report = join(suiteDir, "runtime-report.json");

    // A stub that really uses OmpRpc.start, spawns a detached process with the
    // runtime's own environment (what an OMP tool does), then hangs until the
    // suite's timeout kills it — so its `finally` never runs.
    writeFileSync(join(suiteDir, "e96-leaky.mjs"), `#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
const BASE = ${JSON.stringify(HERE)};
const { OmpRpc } = await import(join(BASE, "lib/rpc.mjs"));
const { writeModelsConfig } = await import(join(BASE, "lib/models-config.mjs"));
const runRoot = ${JSON.stringify(join(suiteDir, "run"))};
mkdirSync(join(runRoot, "agent"), { recursive: true });
mkdirSync(join(runRoot, "dev-cwd"), { recursive: true });
const selector = writeModelsConfig(join(runRoot, "agent"), { baseUrl: "http://127.0.0.1:9" });
const rpc = await OmpRpc.start({ runRoot, mode: "rpc-ui", args: ["--model", selector], cwd: runRoot, readyTimeoutMs: 30_000 });
// Inherit the runtime's exact environment, like an OMP-spawned tool does.
const envText = readFileSync("/proc/" + rpc.pid + "/environ", "utf8");
const env = Object.fromEntries(envText.split("\\0").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", detached: true, env });
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ runtimePid: rpc.pid, descendantPid: descendant.pid, home: rpc.home, configRoot: rpc.configRoot, runRoot }));
console.log("PASS e96-leaky: 1/1 checks");
setInterval(() => {}, 1000);
`, { mode: 0o755 });

    // A real runtime needs a cold start before the stub can park on it.
    // A decoy that looks similar but belongs to no run of ours: it must survive,
    // proving the reaper is scoped by attribution and not by process name.
    const decoy = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, PI_CONFIG_DIR: ".omp-decoy-not-ours", PI_CODING_AGENT_DIR: join(suiteDir, "decoy-agent") },
    });

    const suite = await runSuiteIn(suiteDir, { timeoutMs: 30_000 });
    ctx.check("F2: the leaking experiment is rejected on timeout", /e96-leaky.*REJECTED.*timed out/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e96")));

    if (!existsSync(report)) {
      ctx.check("F2: the stub reported the resources it started", false, "no report file");
    } else {
      const info = JSON.parse(readFileSync(report, "utf8"));
      const gone = async (pid) => {
        for (let i = 0; i < 30; i++) {
          if (!isAlive(pid)) return true;
          await sleep(150);
        }
        return !isAlive(pid);
      };
      const runtimeGone = await gone(info.runtimePid);
      const descendantGone = await gone(info.descendantPid);
      // The reaper only touches this run: the harness process must survive.
      ctx.check("F2: the suite reclaimed the killed experiment's detached runtime", runtimeGone, `runtime ${info.runtimePid}`);
      ctx.check("F2: the suite reclaimed the tool process the runtime detached", descendantGone, `descendant ${info.descendantPid}`);
      ctx.check("F2: the synthetic home was removed", !existsSync(info.home), info.home);
      ctx.check("F2: the isolated config root was removed", !existsSync(info.configRoot), info.configRoot);
      ctx.check("F2: the reaper did not touch this test process", isAlive(process.pid));
      ctx.check("F2: the reaper did not touch a decoy outside this run", isAlive(decoy.pid), `decoy ${decoy.pid}`);
      killQuietly(decoy.pid, "SIGKILL");
      writeFixture("e12-runtime-reaping.json", {
        note: "SYNTHETIC fault sample: a stub experiment starts a real OmpRpc runtime plus a detached tool-like process, then is killed by the suite timeout",
        runtimeGone, descendantGone,
        homeRemoved: !existsSync(info.home),
        configRootRemoved: !existsSync(info.configRoot),
        suiteExitCode: suite.code,
      });
    }
    rmSync(suiteDir, { recursive: true, force: true });
  }

  // ==========================================================================
  // F3 — the client must decode chunk frames itself, and survive bad sequences
  // ==========================================================================
  {
    const runRoot = mkdtempSync(join(tmpdir(), "m1-f3-"));
    const stubDir = join(runRoot, "stubs");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "chunked.mjs");
    // Emits ready, then a corrupted chunk sequence, then a normal frame: the
    // client must report the chunk error and keep delivering the stream.
    writeFileSync(stub, `#!/usr/bin/env node
const payload = Buffer.from(JSON.stringify({ type: "notice", text: "payload" }), "utf8");
const chunk = (index, count, byteLength, data, chunkId) => JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength, data });
const write = (line) => process.stdout.write(line + "\\n");
write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }));
write(chunk(0, 2, 1500000, payload.subarray(0, 4).toString("base64"), "seq-a"));
write(chunk(1, 2, 1500000, payload.subarray(4).toString("base64"), "seq-b"));
// A well-formed sequence after the fault: the decoder must recover on it.
write(chunk(0, 2, 1100000, payload.subarray(0, 3).toString("base64"), "seq-c"));
write(chunk(1, 2, 1100000, payload.subarray(3).toString("base64"), "seq-c"));
write(JSON.stringify({ type: "notice", text: "after-the-broken-sequence" }));
process.stdin.resume();
setInterval(() => {}, 1000);
`, { mode: 0o755 });

    const client = await OmpRpc.start({
      repoRoot, runRoot, mode: "rpc-ui", args: [], cwd: runRoot,
      readyTimeoutMs: 8_000, launcher: stub,
    });
    ctx.check("F3: the client starts even when the stream later contains bad chunks",
      client.readyFrame?.type === "ready");
    await sleep(500);
    ctx.check("F3: a corrupted chunk sequence is reported as a chunk error",
      client.frames.some((f) => f.type === "__chunk_error__"),
      client.frames.filter((f) => f.type === "__chunk_error__").map((f) => f.error));
    ctx.check("F3: the corrupted sequence yields no logical frame",
      !client.frames.some((f) => f.type === "notice" && JSON.stringify(f).includes("payload")));
    // Measured contract: the pinned decoder cannot resynchronise, so a chunk
    // fault desynchronises the stream for good and requests must fail fast.
    ctx.check("F3: a chunk fault is fatal to the stream, not silently recoverable",
      client.chunksAssembled === 0, { assembled: client.chunksAssembled, physical: client.chunkFramesSeen });
    const afterFault = await client.request({ type: "get_state" }, { timeoutMs: 2_000 });
    ctx.check("F3: requests fail fast after a chunk fault instead of timing out",
      afterFault.success === false && /chunk decode failed/.test(afterFault.error ?? ""), afterFault.error ?? afterFault);
    ctx.check("F3: the stream error is queryable by the caller",
      /chunk decode failed/.test(client.streamError ?? ""), client.streamError);
    ctx.check("F3: stop() still reaps the runtime after a chunk error",
      (await client.stop()) === true);
    ctx.check("F3: the failed client left no isolated home behind", !existsSync(join(runRoot, "home")));
    writeFixture("e12-chunk-error-handling.json", {
      note: "SYNTHETIC fault sample: a stub runtime emits a corrupted rpc_chunk sequence followed by a normal frame",
      chunkErrors: client.frames.filter((f) => f.type === "__chunk_error__").map((f) => f.error),
      streamRecovered: client.frames.some((f) => f.type === "notice" && f.text === "after-the-broken-sequence"),
      requestAfterFault: { success: afterFault.success, error: afterFault.error ?? null },
      finding: "The pinned decoder has no resynchronisation: after one chunk fault every later frame is rejected, and OMP's own client treats a decoder throw as fatal (rpc-client.ts has no try/catch around frameDecoder.push). A desktop must restart the runtime on a chunk fault.",
      note: "SYNTHETIC fault sample: a corrupted chunk sequence, then a well-formed one, then a normal frame",
    });
    rmSync(runRoot, { recursive: true, force: true });
  }

  // ==========================================================================
  // F5 — argument parsing must select exactly the requested experiments
  // ==========================================================================
  {
    const parsed = [
      { args: [], expect: { selectors: [], keep: false } },
      { args: ["e04", "e05"], expect: { selectors: ["e04", "e05"], keep: false } },
      { args: ["e04"], expect: { selectors: ["e04"], keep: false } },
      { args: ["--dir", "/tmp/one", "e04", "e05"], expect: { selectors: ["e04", "e05"], dir: "/tmp/one" } },
      { args: ["e04", "--dir", "/tmp/two", "e05"], expect: { selectors: ["e04", "e05"], dir: "/tmp/two" } },
      { args: ["--keep-artifacts", "e04"], expect: { selectors: ["e04"], keep: true } },
      { args: ["e04", "--keep-artifacts"], expect: { selectors: ["e04"], keep: true } },
    ].map(({ args, expect }) => {
      const got = parseArgs(args, "/default");
      const ok = got.selectors.join(",") === (expect.selectors ?? []).join(",") &&
        (expect.dir === undefined || got.dir === expect.dir) &&
        (expect.keep === undefined || got.keep === expect.keep);
      return { args, got: { selectors: got.selectors, dir: got.dir, keep: got.keep }, ok };
    });
    ctx.check("F5: selectors survive every --dir / flag arrangement", parsed.every((p) => p.ok),
      parsed.filter((p) => !p.ok));
    ctx.check("F5: a single selector is not dropped", parseArgs(["e04"], "/d").selectors.join(",") === "e04");
    ctx.check("F5: multiple selectors are all kept", parseArgs(["e04", "e05"], "/d").selectors.join(",") === "e04,e05");
    ctx.check("F5: --dir without a value is rejected", (() => {
      try { parseArgs(["--dir"], "/d"); return false; } catch { return true; }
    })());

    // End to end: only the selected stubs may run.
    const suiteDir = mkdtempSync(join(tmpdir(), "m1-f5-"));
    mkdirSync(join(suiteDir, "results"), { recursive: true });
    for (const name of ["e04-alpha", "e05-beta", "e06-gamma"]) {
      writeFileSync(join(suiteDir, `${name}.mjs`), `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(${JSON.stringify(suiteDir)}, "results");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, ${JSON.stringify(name)} + ".json"), JSON.stringify({ experiment: ${JSON.stringify(name)}, ok: true, runId: process.env.M1_RUN_ID, checks: [] }) + "\\n");
console.log("PASS ${name}: 1/1 checks");
`, { mode: 0o755 });
    }
    const suite = await new Promise((resolve) => {
      const child = spawn(process.execPath, [join(HERE, "run-all.mjs"), "--dir", suiteDir, "e04", "e05"], { cwd: HERE, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => { out += d.toString(); });
      child.stderr.on("data", (d) => { out += d.toString(); });
      child.once("exit", (code) => resolve({ code, out }));
    });
    const ran = [...suite.out.matchAll(/running (\S+\.mjs)/g)].map((m) => m[1]);
    ctx.check("F5: exactly the requested experiments ran", ran.join(",") === "e04-alpha.mjs,e05-beta.mjs", ran);
    ctx.check("F5: the unselected experiment did not run", !ran.includes("e06-gamma.mjs"), ran);
    ctx.check("F5: the selected run exits zero", suite.code === 0, suite.code);
    writeFixture("e12-arg-parsing.json", {
      note: "SYNTHETIC regression: stub experiments plus argument-arrangement cases",
      cases: parsed,
      endToEndRan: ran,
    });
    rmSync(suiteDir, { recursive: true, force: true });
  }

  // ==========================================================================
  // R6 — aggregator must reject dishonest/exited experiments
  // ==========================================================================
  {
    const suiteDir = mkdtempSync(join(tmpdir(), "m1-r6-"));
    mkdirSync(join(suiteDir, "results"), { recursive: true });

    /**
     * Write a stub experiment that produces its own result file during this run
     * (the parent must never pre-write it), then exits however the case needs.
     * `resultRunId` lets a case forge, omit or stale-stamp the run id.
     */
    const stub = (name, { exitCode = 0, signal = null, writeResult = true, resultOk = true, resultName = null, resultRunId = "current" } = {}) => {
      const file = join(suiteDir, `${name}.mjs`);
      writeFileSync(file, `#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = join(${JSON.stringify(suiteDir)}, "results");
mkdirSync(dir, { recursive: true });
${
  writeResult
    ? `const runId = ${JSON.stringify(resultRunId)} === "current" ? process.env.M1_RUN_ID : (${JSON.stringify(resultRunId)} === "none" ? undefined : ${JSON.stringify(resultRunId)});
writeFileSync(join(dir, ${JSON.stringify(name)} + ".json"), JSON.stringify({ experiment: ${JSON.stringify(resultName ?? name)}, ok: ${resultOk}, runId, checks: [{ description: "x", ok: ${resultOk} }] }, null, 2) + "\\n");`
    : ""
}
console.log("PASS ${name}: 1/1 checks");
${signal ? `process.kill(process.pid, ${JSON.stringify(signal)});` : ""}
${signal ? "" : `process.exit(${exitCode});`}
`, { mode: 0o755 });
    };

    stub("e90-honest-pass", {});
    stub("e91-pass-then-exit9", { exitCode: 9 });
    stub("e92-signalled", { signal: "SIGKILL" });
    stub("e93-no-result", { writeResult: false });
    stub("e94-result-says-fail", { resultOk: false });
    stub("e95-mismatched-result", { resultName: "e95-something-else" });
    // F4: a *stale* result file from an earlier run is present, this run writes
    // none. Pre-seeded by the parent precisely because this is the historical
    // file the aggregator used to trust.
    stub("e97-stale-result", { writeResult: false });
    writeFileSync(join(suiteDir, "results", "e97-stale-result.json"),
      JSON.stringify({ experiment: "e97-stale-result", ok: true, runId: "run-from-an-earlier-suite", checks: [{ description: "x", ok: true }] }, null, 2) + "\n");
    // F4: a result file without any run id must not count either.
    stub("e98-unstamped-result", { resultRunId: "none" });
    // A stalled experiment, to prove the timeout path kills the whole group,
    // including a grandchild that outlives the outer script.
    const stalled = join(suiteDir, "e96-stalled.mjs");
    writeFileSync(stalled, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(join(suiteDir, "grandchild.pid"))}, String(child.pid));
const dir = join(${JSON.stringify(suiteDir)}, "results");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "e96-stalled.json"), JSON.stringify({ experiment: "e96-stalled", ok: true, runId: process.env.M1_RUN_ID, checks: [{ description: "x", ok: true }] }, null, 2) + "\\n");
console.log("PASS e96-stalled: 1/1 checks");
// Also start a real OMP runtime so the suite's reaper has something to reclaim.
process.env.F2_RUN_ROOT = ${JSON.stringify(join(suiteDir, "run"))};
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    // (the stalled stub writes its own result below, including the run id)

    const suite = await runSuiteIn(suiteDir);
    ctx.check("R6: the suite exits non-zero when any experiment is dishonest", suite.code !== 0, suite.code);
    ctx.check("R6: PASS followed by a non-zero exit is rejected", /REJECTED.*exit code 9/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e91")));
    ctx.check("R6: a signalled experiment is rejected", /REJECTED.*signal SIGKILL/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e92")));
    ctx.check("R6: a missing result file is rejected", /REJECTED.*no result file/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e93")));
    ctx.check("R6: a result file that reports failure is rejected", /REJECTED.*reports failure/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e94")));
    ctx.check("R6: a mismatched result file is rejected", /REJECTED.*names/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e95")));
    ctx.check("R6: the one honest experiment is accepted", /running e90-honest-pass.mjs \.\.\. PASS/.test(suite.out), suite.out.split("\n")[0]);
    ctx.check("F4: a stale result file from an earlier run is rejected", /REJECTED.*(belongs to run|no run id)/.test(suite.out.split("\n").find((l) => l.includes("e97")) ?? ""), suite.out.split("\n").find((l) => l.includes("e97")));
    ctx.check("F4: a result file without a run id is rejected", /REJECTED.*no run id/.test(suite.out.split("\n").find((l) => l.includes("e98")) ?? ""), suite.out.split("\n").find((l) => l.includes("e98")));

    // Timeout path: the stalled experiment must be reported as timed out and its
    // grandchild must not survive.
    const stalledLine = suite.out.split("\n").find((l) => l.includes("e96") && l.includes("REJECTED"));
    ctx.check("R6: a stalled experiment is rejected as timed out", /timed out/.test(stalledLine ?? ""), stalledLine);
    const grandchildPidFile = join(suiteDir, "grandchild.pid");
    if (existsSync(grandchildPidFile)) {
      const { readFileSync } = await import("node:fs");
      const grandchildPid = Number(readFileSync(grandchildPidFile, "utf8").trim());
      let alive = isAlive(grandchildPid);
      for (let i = 0; i < 20 && alive; i++) { await sleep(150); alive = isAlive(grandchildPid); }
      ctx.check("R6: the timeout path reclaims the experiment's own child processes", alive === false, `grandchild ${grandchildPid}`);
    } else {
      ctx.check("R6: the stalled stub recorded its grandchild", false, "no pid file");
    }

    writeFixture("e12-aggregator-verdicts.json", {
      note: "SYNTHETIC fault sample: stub experiments with dishonest exits, signals and result files",
      suiteExitCode: suite.code,
      rejectedLines: suite.out.split("\n").filter((l) => l.includes("REJECTED")),
    });
    rmSync(suiteDir, { recursive: true, force: true });
  }
});

process.exit(evidence.ok ? 0 : 1);
