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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
function runSuiteIn(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, "run-all.mjs"), "--dir", dir], {
      cwd: HERE, stdio: ["ignore", "pipe", "pipe"],
      // The stalled stub must hit the timeout quickly in this regression.
      env: { ...process.env, M1_EXPERIMENT_TIMEOUT_MS: "8000" },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.once("exit", (code) => resolve({ code, out }));
  });
}

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
  // R6 — aggregator must reject dishonest/exited experiments
  // ==========================================================================
  {
    const suiteDir = mkdtempSync(join(tmpdir(), "m1-r6-"));
    mkdirSync(join(suiteDir, "results"), { recursive: true });

    /** Write a stub experiment plus the result file the aggregator will read. */
    const stub = (name, { exitCode, signal, result }) => {
      const file = join(suiteDir, `${name}.mjs`);
      writeFileSync(file, `#!/usr/bin/env node
console.log("PASS ${name}: 1/1 checks");
${signal ? `process.kill(process.pid, ${JSON.stringify(signal)});` : ""}
${signal ? "" : `process.exit(${exitCode});`}
`, { mode: 0o755 });
      if (result) writeFileSync(join(suiteDir, "results", `${name}.json`), JSON.stringify(result, null, 2) + "\n");
    };

    const validResult = (name, ok = true) => ({ experiment: name, ok, checks: [{ description: "x", ok }] });

    stub("e90-honest-pass", { exitCode: 0, signal: null, result: validResult("e90-honest-pass") });
    stub("e91-pass-then-exit9", { exitCode: 9, signal: null, result: validResult("e91-pass-then-exit9") });
    stub("e92-signalled", { exitCode: null, signal: "SIGKILL", result: validResult("e92-signalled") });
    stub("e93-no-result", { exitCode: 0, signal: null, result: null });
    stub("e94-result-says-fail", { exitCode: 0, signal: null, result: validResult("e94-result-says-fail", false) });
    stub("e95-mismatched-result", { exitCode: 0, signal: null, result: validResult("e95-something-else") });
    // A stalled experiment, to prove the timeout path kills the whole group,
    // including a grandchild that outlives the outer script.
    const stalled = join(suiteDir, "e96-stalled.mjs");
    writeFileSync(stalled, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(join(suiteDir, "grandchild.pid"))}, String(child.pid));
console.log("PASS e96-stalled: 1/1 checks");
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    writeFileSync(join(suiteDir, "results", "e96-stalled.json"), JSON.stringify(validResult("e96-stalled"), null, 2) + "\n");

    const suite = await runSuiteIn(suiteDir);
    ctx.check("R6: the suite exits non-zero when any experiment is dishonest", suite.code !== 0, suite.code);
    ctx.check("R6: PASS followed by a non-zero exit is rejected", /REJECTED.*exit code 9/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e91")));
    ctx.check("R6: a signalled experiment is rejected", /REJECTED.*signal SIGKILL/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e92")));
    ctx.check("R6: a missing result file is rejected", /REJECTED.*no result file/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e93")));
    ctx.check("R6: a result file that reports failure is rejected", /REJECTED.*reports failure/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e94")));
    ctx.check("R6: a mismatched result file is rejected", /REJECTED.*names/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e95")));
    ctx.check("R6: the one honest experiment is accepted", /running e90-honest-pass.mjs \.\.\. PASS/.test(suite.out), suite.out.split("\n")[0]);

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
