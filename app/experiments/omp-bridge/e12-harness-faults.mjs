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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, buildIsolatedEnv, makeConfigDirName, terminateTree, safeRmConfigRoot, safeRmSyntheticHome, makeScratch } from "./lib/base.mjs";
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
function runSuiteIn(dir, { timeoutMs = 8000, extraArgs = [], env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, "run-all.mjs"), "--dir", dir, ...extraArgs], {
      cwd: HERE, stdio: ["ignore", "pipe", "pipe"],
      // The stalled stub must hit the timeout quickly in this regression.
      env: { ...process.env, M1_EXPERIMENT_TIMEOUT_MS: String(timeoutMs), ...env },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { out += d.toString(); });
    child.once("exit", (code) => resolve({ code, out }));
  });
}

import { parseArgs } from "./lib/suite-policy.mjs";
import { reapRunResources } from "./lib/runtime-registry.mjs";

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
    const report = join(suiteDir, "runtime-report-reclaimed.json");
    const keptReport = join(suiteDir, "runtime-report-kept.json");

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
const { makeScratch } = await import(join(BASE, "lib/base.mjs"));
const runRoot = process.env.F2_RUN_ROOT_OVERRIDE || makeScratch("review-timeout");
mkdirSync(join(runRoot, "agent"), { recursive: true });
mkdirSync(join(runRoot, "dev-cwd"), { recursive: true });
const selector = writeModelsConfig(join(runRoot, "agent"), { baseUrl: "http://127.0.0.1:9" });
const rpc = await OmpRpc.start({ runRoot, mode: "rpc-ui", args: ["--model", selector], cwd: runRoot, readyTimeoutMs: 30_000 });
// Inherit the runtime's exact environment, like an OMP-spawned tool does.
const envText = readFileSync("/proc/" + rpc.pid + "/environ", "utf8");
const env = Object.fromEntries(envText.split("\\0").filter(Boolean).map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), kv.slice(i + 1)]; }));
const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore", detached: true, env });
writeFileSync(process.env.F2_REPORT || ${JSON.stringify(report)}, JSON.stringify({ runtimePid: rpc.pid, descendantPid: descendant.pid, home: rpc.home, configRoot: rpc.configRoot, runRoot }));
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

    const suite = await runSuiteIn(suiteDir, { timeoutMs: 30_000, env: { F2_REPORT: report } });
    // R3: with --keep-artifacts the scratch root must be preserved.
    const keepSuite = await runSuiteIn(suiteDir, { timeoutMs: 30_000, extraArgs: ["--keep-artifacts"], env: { F2_REPORT: keptReport } });
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
      // R3: the killed experiment's whole scratch root must be reclaimed, not
      // just HOME/config. The stub allocates its root under .dev-data/m1, like a
      // real experiment, so this exercises the ownership-scoped removal.
      ctx.check("R3: the killed experiment's scratch run root is reclaimed",
        !existsSync(info.runRoot), info.runRoot);
      ctx.check("R3: the killed experiment's agent data is reclaimed",
        !existsSync(join(info.runRoot, "agent")), join(info.runRoot, "agent"));
      ctx.check("R3: the suite reports the cleanup as clean",
        suite.out.includes("experiments: 0/1 passed") && !/cleanup:.*stillAlive":\[[^\]]/.test(suite.out),
        suite.out.split("\n").filter((l) => l.includes("cleanup")).slice(0, 2));
      // The kept run must survive, the reclaimed run must not.
      const keptInfo = existsSync(keptReport) ? JSON.parse(readFileSync(keptReport, "utf8")) : null;
      ctx.check("R3: --keep-artifacts preserves that run's scratch root",
        keepSuite.code !== 0 && Boolean(keptInfo) && existsSync(keptInfo.runRoot),
        { keepExit: keepSuite.code, keptRunRoot: keptInfo?.runRoot ?? null, exists: keptInfo ? existsSync(keptInfo.runRoot) : null });
      ctx.check("R3: the reclaimed and kept runs used different roots",
        Boolean(keptInfo) && keptInfo.runRoot !== info.runRoot, { reclaimed: info.runRoot, kept: keptInfo?.runRoot ?? null });
      if (keptInfo?.runRoot) rmSync(keptInfo.runRoot, { recursive: true, force: true });
      writeFixture("e12-runtime-reaping.json", {
        note: "SYNTHETIC fault sample: a stub experiment starts a real OmpRpc runtime plus a detached tool-like process, then is killed by the suite timeout",
        runtimeGone, descendantGone,
        homeRemoved: !existsSync(info.home),
        configRootRemoved: !existsSync(info.configRoot),
        runRootRemoved: !existsSync(info.runRoot),
        agentDataRemoved: !existsSync(join(info.runRoot, "agent")),
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
  // F2 — inherited proxy configuration (either case, plus wildcard bypass) must
  // not survive into the isolated child
  //
  // PI-Desktop reference (source facts): `network-proxy.ts` lists the proxy
  // variables it manages — HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY in both
  // cases plus NODE_USE_ENV_PROXY — and `stripProxyEnv` deletes all of them;
  // `host-process.ts` builds a child env as `stripProxyEnv(process.env)` first
  // and only then overlays explicit values. Overriding the uppercase names alone
  // leaves an inherited lowercase proxy in place (measured: Bun's fetch issued
  // both an HTTP request and a CONNECT through an inherited lowercase proxy).
  // ==========================================================================
  {
    const { createServer } = await import("node:http");
    const { buildIsolatedEnv: buildEnv } = await import(join(HERE, "..", "..", "..", "docs", "validation", "M0-rpc", "verify-rpc.mjs"));

    const runRoot = makeScratch("review-proxy");
    mkdirSync(join(runRoot, "agent"), { recursive: true });
    const loopback = createServer((req, res) => res.end("ok"));
    await new Promise((r) => loopback.listen(0, "127.0.0.1", r));
    const loopbackPort = loopback.address().port;

    // A loopback fake proxy: it must receive nothing for outbound hosts.
    let httpRequests = 0;
    let connectRequests = 0;
    const fakeProxy = createServer((req, res) => { httpRequests++; res.end("synthetic-proxy"); });
    fakeProxy.on("connect", (req, socket) => { connectRequests++; socket.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); });
    await new Promise((r) => fakeProxy.listen(0, "127.0.0.1", r));
    const sentinel = `http://127.0.0.1:${fakeProxy.address().port}`;

    const keys = ["http_proxy", "https_proxy", "all_proxy", "no_proxy", "NODE_USE_ENV_PROXY"];
    const previous = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    try {
      // Parent-side inheritance the child must NOT keep: lowercase proxies plus a
      // wildcard bypass, exactly the shape the review measured.
      process.env.http_proxy = sentinel;
      process.env.https_proxy = sentinel;
      process.env.all_proxy = sentinel;
      process.env.no_proxy = "*";
      process.env.NODE_USE_ENV_PROXY = "1";

      const { env } = buildEnv({ repoRoot, runRoot });
      ctx.check("F2: no inherited lowercase proxy survives into the child env",
        env.http_proxy !== sentinel && env.https_proxy !== sentinel && env.all_proxy !== sentinel,
        { http_proxy: env.http_proxy, https_proxy: env.https_proxy, all_proxy: env.all_proxy });
      ctx.check("F2: a wildcard inherited no_proxy is replaced by the loopback-only bypass",
        env.no_proxy !== "*" && /127\.0\.0\.1/.test(env.no_proxy ?? ""), env.no_proxy);
      ctx.check("F2: NODE_USE_ENV_PROXY is not inherited",
        env.NODE_USE_ENV_PROXY === undefined, env.NODE_USE_ENV_PROXY);
      ctx.check("F2: the harness policy is expressed in both cases",
        env.HTTP_PROXY && env.http_proxy === env.HTTP_PROXY && env.HTTPS_PROXY === env.https_proxy,
        { upper: env.HTTP_PROXY, lower: env.http_proxy });

      // Run a real runtime against this env: outbound must not reach the proxy,
      // loopback must still be direct.
      const bunPath = join(homedir(), ".bun", "bin", "bun");
      const childRuntime = existsSync(bunPath) ? bunPath : process.execPath;
      const childScript = `
const out = { http: null, https: null, loopback: null };
try { await fetch("http://outside.invalid/probe", { signal: AbortSignal.timeout(1500) }); out.http = "completed"; } catch (e) { out.http = e?.name ?? "error"; }
try { await fetch("https://outside.invalid/probe", { signal: AbortSignal.timeout(1500) }); out.https = "completed"; } catch (e) { out.https = e?.name ?? "error"; }
try { const r = await fetch("http://127.0.0.1:${loopbackPort}/ok"); out.loopback = r.ok ? "ok" : String(r.status); } catch (e) { out.loopback = "error"; }
console.log(JSON.stringify(out));
`;
      const child = await new Promise((resolve) => {
        const c = spawn(childRuntime, ["-e", childScript], { env, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        c.stdout.on("data", (d) => { stdout += d.toString(); });
        c.once("close", (code) => resolve({ code, stdout: stdout.trim() }));
      });
      const childResult = (() => { try { return JSON.parse(child.stdout); } catch { return null; } })();
      ctx.check("F2: a real child runtime could run under the isolated env", child.code === 0 && childResult !== null, { code: child.code, stdout: child.stdout.slice(0, 120) });
      ctx.check("F2: the fake proxy receives no outbound request from the child",
        httpRequests === 0 && connectRequests === 0, { httpRequests, connectRequests });
      ctx.check("F2: the child does not report a completed outbound fetch",
        childResult?.http !== "completed" && childResult?.https !== "completed", childResult);
      ctx.check("F2: the loopback fixture path is still reachable",
        childResult?.loopback === "ok", childResult);

      writeFixture("e12-proxy-normalization.json", {
        note: "SYNTHETIC environment probe with a loopback fake proxy; no external service is contacted",
        childRuntime: childRuntime === process.execPath ? "node" : "bun",
        inheritedLowercaseProxy: env.http_proxy === sentinel,
        wildcardNoProxyInherited: env.no_proxy === "*",
        nodeUseEnvProxyInherited: env.NODE_USE_ENV_PROXY !== undefined,
        fakeProxyRequests: { httpRequests, connectRequests },
        child: childResult,
      });
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
      await new Promise((r) => fakeProxy.close(r));
      await new Promise((r) => loopback.close(r));
      rmSync(runRoot, { recursive: true, force: true });
    }
  }

  // ==========================================================================
  // F1 — a decision that cannot be consumed (or read) must not admit the call
  //
  // PI-Desktop reference (source fact): `permissions.resolve` removes the pending
  // request *before* it answers, so a duplicate/late request finds nothing
  // (NOT_FOUND). OMP's own `emitToolCall` is fail-closed on hook errors and
  // timeouts. Swallowing a consumption failure would let one `allow` authorise
  // every later call, which is exactly what was reproduced here.
  // ==========================================================================
  {
    const gateSource = join(HERE, "extensions", "approval-gate.ts");
    const { default: approvalGate } = await import(gateSource);
    const gateRoot = mkdtempSync(join(tmpdir(), "m1-consume-"));

    let handler = null;
    approvalGate({ on: (_event, h) => { handler = h; } });

    const childCtx = { hasUI: false, sessionManager: { getSessionId: () => "consume-child" } };

    /** Drive two calls against one decision file with the given mode. */
    const runPair = async (name, { mode }) => {
      const dir = join(gateRoot, name);
      mkdirSync(dir, { recursive: true });
      const decisionPath = join(dir, "decision");
      const audit = join(dir, "audit.jsonl");
      writeFileSync(decisionPath, "allow");
      writeFileSync(audit, "");
      if (mode === "readonly") chmodSync(decisionPath, 0o444);
      if (mode === "unreadable") chmodSync(decisionPath, 0o000);
      process.env.M1_CHILD_POLICY = "defer";
      process.env.M1_CHILD_DEFER_MS = "600";
      process.env.M1_CHILD_DECISION = decisionPath;
      process.env.M1_CHILD_CANCEL = join(dir, "cancel");
      process.env.M1_UI_LOG = audit;
      process.env.M1_UI_LOG_ALL = "1";

      const call = (toolCallId, target) => handler({ toolName: "write", toolCallId, input: { path: join(dir, target) } }, childCtx);
      const first = await call("call-one", "one.txt");
      const second = await call("call-two", "two.txt");
      const entries = readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      const decisions = entries.filter((e) => e.event === "gate-decision");
      // Restore permissions before anything tries to clean the directory up.
      if (mode === "readonly") chmodSync(decisionPath, 0o600);
      if (mode === "unreadable") chmodSync(decisionPath, 0o600);
      return {
        firstBlocked: first?.block === true,
        secondBlocked: second?.block === true,
        routes: [...new Set(decisions.map((d) => d.route))],
        reasons: [first?.reason ?? null, second?.reason ?? null],
      };
    };

    const readOnly = await runPair("readonly", { mode: "readonly" });
    ctx.check("F1: an unconsumable decision denies the call instead of admitting it",
      readOnly.firstBlocked && readOnly.routes.includes("child-consume-failed"), readOnly);
    ctx.check("F1: the same unconsumable decision cannot admit a second call either",
      readOnly.secondBlocked, readOnly);
    ctx.check("F1: the refusal reason is explicit, not a silent allow",
      (readOnly.reasons[0] ?? "").includes("could not be applied"), readOnly.reasons);

    const unreadable = await runPair("unreadable", { mode: "unreadable" });
    ctx.check("F1: an unreadable decision denies rather than allowing",
      unreadable.firstBlocked && unreadable.routes.includes("child-decision-unreadable"), unreadable);
    ctx.check("F1: an unreadable decision cannot admit a later call either", unreadable.secondBlocked, unreadable);

    const writable = await runPair("writable", { mode: "ok" });
    ctx.check("F1: an ordinary writable decision still admits exactly one call",
      !writable.firstBlocked && writable.secondBlocked, writable);

    rmSync(gateRoot, { recursive: true, force: true });
  }

  // ==========================================================================
  // F1 (real OMP) — one read-only allow must not produce any subagent file
  // ==========================================================================
  {
    const { writeModelsConfig } = await import("./lib/models-config.mjs");
    const runRoot = makeScratch("review-consume");
    mkdirSync(join(runRoot, "agent"), { recursive: true });
    mkdirSync(join(runRoot, "dev-cwd"), { recursive: true });
    const projectDir = join(runRoot, "project");
    mkdirSync(projectDir, { recursive: true });
    const uiLog = join(runRoot, "audit.jsonl");
    const decisionPath = join(runRoot, "decision");
    const targetA = join(projectDir, "target-a.txt");
    const targetB = join(projectDir, "target-b.txt");
    const marker = "REVIEW-CONSUME-FAIL";

    let provider;
    let rpc;
    try {
      provider = await FakeProvider.start({ model: "local-model" });
      const selector = writeModelsConfig(join(runRoot, "agent"), { baseUrl: provider.baseUrl });
      provider.routeBySession({
        parent: [
          { toolCalls: [{ name: "task", args: { i: "delegate", context: "consume", tasks: [{ task: `${marker} write both targets`, agent: "task", name: "ConsumeChild" }] } }], finish: "tool_calls" },
          { text: "parent done", finish: "stop" },
        ],
        subagents: [{
          marker,
          turns: [
            { toolCalls: [{ name: "write", args: { path: targetA, content: "A\n" } }], finish: "tool_calls" },
            { toolCalls: [{ name: "write", args: { path: targetB, content: "B\n" } }], finish: "tool_calls" },
            { text: "child done", finish: "stop" },
          ],
        }],
      });

      // One decision that cannot be consumed: read-only for the child process.
      writeFileSync(decisionPath, "allow");
      chmodSync(decisionPath, 0o444);

      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--extension", join(HERE, "extensions", "approval-gate.ts")],
        cwd: projectDir,
        extraEnv: {
          M1_UI_LOG: uiLog, M1_UI_LOG_ALL: "1",
          M1_CHILD_POLICY: "defer", M1_CHILD_DECISION: decisionPath, M1_CHILD_DEFER_MS: "1500",
        },
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      await rpc.request({ type: "prompt", message: "delegate two writes to the child" }, { timeoutMs: 60_000 });
      await sleep(2_500);

      const entries = existsSync(uiLog) ? readFileSync(uiLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const childGates = entries.filter((e) => e.event === "gate" && e.hasUI === false);
      const childCallIds = [...new Set(childGates.map((e) => e.toolCallId))];
      ctx.check("F1: the real subagent issued two distinct tool calls", childCallIds.length >= 2, childCallIds);
      ctx.check("F1: neither call produced a file side effect",
        !existsSync(targetA) && !existsSync(targetB), { targetA: existsSync(targetA), targetB: existsSync(targetB) });
      ctx.check("F1: both refusals are classified as consume failures",
        entries.filter((e) => e.route === "child-consume-failed").length >= 2,
        entries.filter((e) => e.route === "child-consume-failed").map((e) => e.toolCallId));

      chmodSync(decisionPath, 0o600);
      writeFixture("e12-consume-failure.json", {
        note: "SYNTHETIC fault sample (read-only decision file) driven through the real OMP subagent path",
        childCallIds,
        targetAWritten: existsSync(targetA),
        targetBWritten: existsSync(targetB),
        consumeFailures: entries.filter((e) => e.route === "child-consume-failed").map((e) => e.toolCallId),
      });
    } finally {
      if (existsSync(decisionPath)) chmodSync(decisionPath, 0o600);
      if (rpc?.pid) await rpc.stop();
      if (provider) await provider.close();
      rmSync(runRoot, { recursive: true, force: true });
    }
  }

  // ==========================================================================
  // R2 — a cleanup failure must fail the run, not be reported as success
  //
  // PI-Desktop reference: it has no equivalent aggregator, so the requirement
  // here is M1's own acceptance rule — its descendant test asserts the process
  // is actually gone, and a product-side `warn` on scratch deletion is product
  // cleanup behaviour, not evidence that "no residue" was verified.
  // ==========================================================================
  {
    const suiteDir = mkdtempSync(join(tmpdir(), "m1-r2-cleanup-"));
    mkdirSync(join(suiteDir, "results"), { recursive: true });
    const report = join(suiteDir, "stub-report.json");

    // A stub that looks fully successful (valid result, PASS, exit 0) but leaves
    // its own scratch root behind with an undeletable inner directory.
    const stubSource = (targetDir, reportPath) => `#!/usr/bin/env node
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const BASE = ${JSON.stringify(HERE)};
const { makeScratch } = await import(join(BASE, "lib/base.mjs"));
const { registerRuntime } = await import(join(BASE, "lib/runtime-registry.mjs"));
const runRoot = makeScratch("review-cleanup-fail");
const protectedDir = join(runRoot, "agent", "protected");
mkdirSync(protectedDir, { recursive: true });
writeFileSync(join(protectedDir, "x"), "x");
// Register a runtime that has already exited: the process side is clean, only
// the directory removal will fail.
registerRuntime(join(BASE, "..", "..", "..", ".dev-data", "m1"), {
  pid: 999999, pgrp: 999999, agentDir: join(runRoot, "agent"), configDirName: ".omp-m0-review",
  configRoot: join(runRoot, "home", ".omp-m0-review"), home: join(runRoot, "home"),
  runRoot, runId: process.env.M1_RUN_ID, ownerPid: process.pid, owner: "e97",
});
chmodSync(protectedDir, 0o500);
const dir = join(${JSON.stringify("__TARGET_DIR__")}, "results");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "e97-cleanup-fails.json"), JSON.stringify({ experiment: "e97-cleanup-fails", ok: true, runId: process.env.M1_RUN_ID, checks: [] }) + "\\n");
writeFileSync(${JSON.stringify("__REPORT__")}, JSON.stringify({ runRoot, protectedDir, runId: process.env.M1_RUN_ID }));
console.log("PASS e97-cleanup-fails: 1/1 checks");
process.exit(0);
`.replace("__TARGET_DIR__", targetDir).replace("__REPORT__", reportPath);

    writeFileSync(join(suiteDir, "e97-cleanup-fails.mjs"), stubSource(suiteDir, report), { mode: 0o755 });

    const suite = await runSuiteIn(suiteDir, { timeoutMs: 20_000 });
    ctx.check("R2: the run fails when cleanup cannot reclaim what the experiment left", suite.code !== 0, suite.code);
    ctx.check("R2: the failure is reported as a cleanup failure, not hidden behind PASS",
      /REJECTED.*cleanup/.test(suite.out), suite.out.split("\n").find((l) => l.includes("e97")));
    const summary = existsSync(join(suiteDir, "results", "summary.json"))
      ? JSON.parse(readFileSync(join(suiteDir, "results", "summary.json"), "utf8"))
      : null;
    const row = summary?.experiments?.find((e) => e.file === "e97-cleanup-fails.mjs");
    ctx.check("R2: summary keeps the reason and structured diagnostics",
      row?.passed === false && /cleanup/.test(row?.verdict ?? "") && (row?.cleanup?.errors?.length ?? 0) > 0,
      { passed: row?.passed, verdict: row?.verdict, errors: row?.cleanup?.errors });
    const info = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
    ctx.check("R2: the undeletable root is still reported as leftover", Boolean(info) && existsSync(info.runRoot), info?.runRoot);

    // Ownership evidence must survive a failed cleanup so a retry is possible.
    const dataRoot = join(HERE, "..", "..", "..", ".dev-data", "m1");
    const registrations = existsSync(join(dataRoot, ".runtimes")) ? readdirSync(join(dataRoot, ".runtimes")).length : 0;
    ctx.check("R2: the failed cleanup keeps its retryable registration", registrations >= 1, registrations);

    // Retry after the obstruction is gone: it must now succeed and clean up.
    if (info) {
      chmodSync(info.protectedDir, 0o700);
      const retry = await reapRunResources({ dataRoot, runId: info.runId, keepArtifacts: false, sweep: false });
      ctx.check("R2: a retry reclaims the leftover root once the obstruction is gone",
        !existsSync(info.runRoot) && retry.errors.length === 0, { errors: retry.errors, exists: existsSync(info.runRoot) });
    }

    // --keep-artifacts intentionally preserves the scratch root: not a failure.
    const keepDir = mkdtempSync(join(tmpdir(), "m1-r2-keep-"));
    mkdirSync(join(keepDir, "results"), { recursive: true });
    const keepReport = join(keepDir, "stub-report.json");
    writeFileSync(join(keepDir, "e97-cleanup-fails.mjs"), stubSource(keepDir, keepReport), { mode: 0o755 });
    const keepSuite = await runSuiteIn(keepDir, { timeoutMs: 20_000, extraArgs: ["--keep-artifacts"] });
    const keepInfo = existsSync(keepReport) ? JSON.parse(readFileSync(keepReport, "utf8")) : null;
    ctx.check("R2: --keep-artifacts is not reported as a cleanup failure",
      keepSuite.code === 0 && /PASS e97/.test(keepSuite.out), { exit: keepSuite.code, out: keepSuite.out.split("\n").slice(0, 2) });
    ctx.check("R2: --keep-artifacts really keeps the run root", Boolean(keepInfo) && existsSync(keepInfo.runRoot), keepInfo?.runRoot);
    if (keepInfo?.protectedDir) chmodSync(keepInfo.protectedDir, 0o700);
    if (keepInfo?.runRoot) rmSync(keepInfo.runRoot, { recursive: true, force: true });
    // The kept run leaves its own registration (pid 999999): drop it explicitly.
    for (const file of readdirSync(join(dataRoot, ".runtimes"))) {
      if (file === "999999.json") rmSync(join(dataRoot, ".runtimes", file), { force: true });
    }

    writeFixture("e12-cleanup-verdict.json", {
      note: "SYNTHETIC fault sample: an experiment that passes but leaves an undeletable scratch root",
      failingRun: { exitCode: suite.code, verdict: row?.verdict ?? null, cleanupErrors: row?.cleanup?.errors ?? [] },
      registrationsAfterFailure: registrations,
      keepArtifactsRun: { exitCode: keepSuite.code, rootKept: Boolean(keepInfo) && existsSync(keepInfo.runRoot) },
    });
    rmSync(suiteDir, { recursive: true, force: true });
    rmSync(keepDir, { recursive: true, force: true });
  }

  // ==========================================================================
  // R1 — cancellation is authoritative for a call that has not executed, and a
  // decision is request-scoped and single-use
  //
  // PI-Desktop reference (source facts): `permissions.cancel()` removes the
  // pending request and answers Deny to wake a racing waiter, and a late
  // `permissions.resolve` returns NOT_FOUND. The governing property is that a
  // not-yet-executed call cannot be admitted once its cancellation is known —
  // the write order of the decision and cancel files says nothing about that.
  // ==========================================================================
  {
    const gateSource = join(HERE, "extensions", "approval-gate.ts");
    const { default: approvalGate } = await import(gateSource);
    const gateRoot = mkdtempSync(join(tmpdir(), "m1-gate-"));

    let handler = null;
    approvalGate({ on: (_event, h) => { handler = h; } });
    ctx.check("R1: the gate exposes a tool_call handler", typeof handler === "function");

    const childCtx = { hasUI: false, sessionManager: { getSessionId: () => "review-child" } };
    const callWrite = (dir, toolCallId) =>
      handler({ toolName: "write", toolCallId, input: { path: join(dir, "side-effect.txt") } }, childCtx);

    /** Run one case in its own directory with fresh decision/cancel files. */
    const runCase = async (name, { decision, cancel, order = [], toolCallId = `call-${name}`, deferMs = 800 }) => {
      const dir = join(gateRoot, name);
      mkdirSync(dir, { recursive: true });
      const decisionPath = join(dir, "decision");
      const cancelPath = join(dir, "cancel");
      const audit = join(dir, "audit.jsonl");
      writeFileSync(audit, "");
      process.env.M1_CHILD_POLICY = "defer";
      process.env.M1_CHILD_DEFER_MS = String(deferMs);
      process.env.M1_CHILD_DECISION = decisionPath;
      process.env.M1_CHILD_CANCEL = cancelPath;
      process.env.M1_UI_LOG = audit;
      process.env.M1_UI_LOG_ALL = "1";

      // `order` lets a case stage files before the waiter starts, which is the
      // deterministic form of "the waiter was frozen while both were written".
      for (const step of order) {
        if (step === "decision") writeFileSync(decisionPath, decision);
        if (step === "cancel") writeFileSync(cancelPath, cancel);
        await sleep(5);
      }
      const started = Date.now();
      const result = await callWrite(dir, toolCallId);
      const entries = readFileSync(audit, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return {
        name,
        blocked: result?.block === true,
        reason: result?.reason ?? null,
        elapsed: Date.now() - started,
        decision: entries.find((e) => e.event === "gate-decision") ?? null,
        ignored: entries.filter((e) => e.event === "gate-decision-ignored"),
        decisionFileContent: existsSync(decisionPath) ? readFileSync(decisionPath, "utf8").trim() : null,
      };
    };

    // The reviewer's case: an allow that was written BEFORE the cancel must not
    // outrank a cancellation that is already visible when the waiter resumes.
    const earlierAllow = await runCase("earlier-allow-then-cancel", { decision: "allow", cancel: "cancel", order: ["decision", "cancel"] });
    ctx.check("R1: an earlier allow cannot outrank an already-published cancellation",
      earlierAllow.blocked && earlierAllow.decision?.route === "child-cancelled",
      earlierAllow);
    ctx.check("R1: that cancellation is classified as cancelled, not as a timeout or a defer timeout",
      earlierAllow.decision?.cancelled === true && earlierAllow.elapsed < 800,
      { decision: earlierAllow.decision, elapsed: earlierAllow.elapsed });

    const cancelFirst = await runCase("cancel-first", { decision: "allow", cancel: "cancel", order: ["cancel"] });
    ctx.check("R1: a cancel published before any decision blocks the call", cancelFirst.blocked && cancelFirst.decision?.route === "child-cancelled", cancelFirst);

    const plainAllow = await runCase("allow", { decision: "allow", cancel: null, order: ["decision"] });
    ctx.check("R1: without cancellation an allow still admits the call", plainAllow.blocked === false, plainAllow);
    ctx.check("R1: an applied decision is consumed so it cannot authorise another call",
      plainAllow.decisionFileContent?.startsWith("consumed"), plainAllow.decisionFileContent);

    const plainDeny = await runCase("deny", { decision: "deny", cancel: null, order: ["decision"] });
    ctx.check("R1: an explicit deny blocks the call", plainDeny.blocked && plainDeny.decision?.decision === "deny", plainDeny);

    const noDecision = await runCase("no-decision", { decision: null, cancel: null, order: [], deferMs: 400 });
    ctx.check("R1: a real timeout stays a distinct outcome",
      noDecision.blocked && noDecision.decision?.outcome === "timeout" && noDecision.elapsed >= 400,
      { decision: noDecision.decision, elapsed: noDecision.elapsed });

    // A decision addressed to another call is neither applied nor consumed.
    const scopedAway = await runCase("scoped-away", { decision: "allow someone-else", cancel: null, order: ["decision"], toolCallId: "call-mine", deferMs: 400 });
    ctx.check("R1: a decision addressed to another call is not reused",
      scopedAway.blocked && scopedAway.ignored.some((e) => e.reason === "scope-mismatch"),
      { blocked: scopedAway.blocked, ignored: scopedAway.ignored });

    // One approval must not authorise two calls.
    const sharedDir = join(gateRoot, "shared-decision");
    mkdirSync(sharedDir, { recursive: true });
    process.env.M1_CHILD_POLICY = "defer";
    process.env.M1_CHILD_DEFER_MS = "300";
    process.env.M1_CHILD_DECISION = join(sharedDir, "decision");
    process.env.M1_CHILD_CANCEL = join(sharedDir, "cancel");
    process.env.M1_UI_LOG = join(sharedDir, "audit.jsonl");
    writeFileSync(process.env.M1_UI_LOG, "");
    writeFileSync(process.env.M1_CHILD_DECISION, "allow");
    const first = await handler({ toolName: "write", toolCallId: "call-one", input: { path: join(sharedDir, "one.txt") } }, childCtx);
    const second = await handler({ toolName: "write", toolCallId: "call-two", input: { path: join(sharedDir, "two.txt") } }, childCtx);
    ctx.check("R1: one approval admits exactly one call",
      first === undefined && second?.block === true, { first: first ?? null, second: second ?? null });

    writeFixture("e12-cancel-decision-semantics.json", {
      note: "SYNTHETIC fault sample: the real gate module driven directly for cancellation/decision ordering",
      earlierAllow, cancelFirst, plainAllow, plainDeny, noDecision, scopedAway,
      oneApprovalOneCall: { first: first ?? null, second: second?.block === true },
    });
    rmSync(gateRoot, { recursive: true, force: true });
  }

  // ==========================================================================
  // R2 — a same-group descendant that survives SIGTERM and carries no
  // attribution env must still be reclaimed after its group leader exits
  //
  // PI-Desktop reference (source fact): apps/desktop/electron/main/npm-executable.ts
  // sends SIGKILL to the remaining process group on settle, precisely because
  // "the leader may exit on SIGTERM while a descendant with ignored stdio
  // survives"; its test `timeout kills resistant descendants after their group
  // leader exits with ignored stdio` covers the same shape.
  // ==========================================================================
  {
    const { makeScratch } = await import("./lib/base.mjs");
    const { reapRunResources: reap, listRuntimes: list } = await import("./lib/runtime-registry.mjs");
    const dataRoot = join(HERE, "..", "..", "..", ".dev-data", "m1");
    const runId = `r2-${Date.now().toString(36)}`;
    const runRoot = makeScratch("review-r2");
    mkdirSync(join(runRoot, "agent"), { recursive: true });
    mkdirSync(join(runRoot, "dev-cwd"), { recursive: true });
    const { writeModelsConfig } = await import("./lib/models-config.mjs");
    writeModelsConfig(join(runRoot, "agent"), { baseUrl: "http://127.0.0.1:9" });

    const report = join(runRoot, "r2-report.json");
    const leader = join(runRoot, "leader.mjs");
    // The survivor ignores SIGTERM, stays in the leader's group, and drops the
    // PI_* attribution env so the environment sweep cannot mask a group bug.
    writeFileSync(leader, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const survivor = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PI_") && k !== "M1_RUN_ID" && k !== "OMP_DEV_LAUNCH_DIR"));
const child = spawn(process.execPath, ["-e", survivor], { stdio: "ignore", env });
writeFileSync(${JSON.stringify(report)}, JSON.stringify({ leaderPid: process.pid, survivorPid: child.pid, runRoot: process.env.R2_RUN_ROOT }));
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");
setTimeout(() => process.exit(0), 300);
`, { mode: 0o755 });

    process.env.M1_RUN_ID = runId;
    process.env.R2_RUN_ROOT = runRoot;
    const client = await OmpRpc.start({ repoRoot, runRoot, mode: "rpc-ui", args: [], cwd: runRoot, readyTimeoutMs: 8_000, launcher: leader });
    const leaderPid = client.pid;
    await sleep(700);
    const info = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;

    ctx.check("R2: the leader exited while its same-group descendant stayed alive",
      Boolean(info) && !isAlive(leaderPid) && isAlive(info.survivorPid),
      { leader: leaderPid, leaderAlive: isAlive(leaderPid), survivor: info?.survivorPid, survivorAlive: info ? isAlive(info.survivorPid) : null });
    ctx.check("R2: the survivor carries no PI attribution env (group handling alone must reclaim it)",
      Boolean(info) && !existsSync(`/proc/${info.survivorPid}/environ`) === false &&
      !readFileSync(`/proc/${info.survivorPid}/environ`, "utf8").split("\0").some((kv) => kv.startsWith("PI_CODING_AGENT_DIR=") || kv.startsWith("PI_CONFIG_DIR=")),
      { survivor: info?.survivorPid });

    const reaped = await reap({ dataRoot, runId, ownerPids: [process.pid] });
    let survivorGone = false;
    for (let i = 0; i < 40 && !survivorGone; i++) { survivorGone = !isAlive(info?.survivorPid); await sleep(100); }
    ctx.check("R2: the survivor is reclaimed even though its leader had already exited", survivorGone, `survivor ${info?.survivorPid}`);
    ctx.check("R2: the group is gone after reaping", !(() => { try { process.kill(-leaderPid, 0); return true; } catch { return false; } })());
    ctx.check("R2: the reaper reports no survivors", reaped.stillAlive.length === 0 && reaped.clean === true, reaped);
    ctx.check("R2: the registration is dropped only after the group is gone", list(dataRoot, { runId }).length === 0);
    ctx.check("R2: the reclaimed run root is removed", !existsSync(runRoot), runRoot);

    // Boundary: a tool that left the group AND dropped attribution cannot be
    // attributed at all. Recorded as a limitation rather than claimed as covered.
    const detachedRunRoot = makeScratch("review-r2-detached");
    const orphanReport = join(detachedRunRoot, "orphan.json");
    const orphanMaker = join(detachedRunRoot, "maker.mjs");
    writeFileSync(orphanMaker, `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("PI_") && k !== "M1_RUN_ID"));
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore", detached: true, env });
writeFileSync(${JSON.stringify(orphanReport)}, JSON.stringify({ orphanPid: child.pid, runRoot: ${JSON.stringify(detachedRunRoot)} }));
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");
setTimeout(() => process.exit(0), 300);
`, { mode: 0o755 });
    process.env.R2_RUN_ROOT = detachedRunRoot;
    const orphanClient = await OmpRpc.start({ repoRoot, runRoot: detachedRunRoot, mode: "rpc-ui", args: [], cwd: detachedRunRoot, readyTimeoutMs: 8_000, launcher: orphanMaker });
    await sleep(800);
    const orphanInfo = existsSync(orphanReport) ? JSON.parse(readFileSync(orphanReport, "utf8")) : null;
    const orphanReap = await reap({ dataRoot, runId, ownerPids: [process.pid] });
    ctx.check("R2: a tool that left the group and dropped attribution is NOT claimed as reclaimed",
      Boolean(orphanInfo) && isAlive(orphanInfo.orphanPid),
      { orphan: orphanInfo?.orphanPid, note: "documented limitation: only its own group or its own isolation env can attribute a process" });
    ctx.note("R2-detachedOrphan", { pid: orphanInfo?.orphanPid ?? null, stillAlive: orphanInfo ? isAlive(orphanInfo.orphanPid) : null, reapClean: orphanReap.clean });
    if (orphanInfo?.orphanPid) {
      try { process.kill(-orphanInfo.orphanPid, "SIGKILL"); } catch { killQuietly(orphanInfo.orphanPid, "SIGKILL"); }
    }
    await orphanClient.stop();
    rmSync(detachedRunRoot, { recursive: true, force: true });
    rmSync(runRoot, { recursive: true, force: true });
  }

  // ==========================================================================
  // R4 — a stream fault while a request is in flight must be reported as the
  // real error, not as a timeout
  // ==========================================================================
  {
    const runRoot = mkdtempSync(join(tmpdir(), "m1-r4-"));
    const stubDir = join(runRoot, "stubs");
    mkdirSync(stubDir, { recursive: true });
    const stub = join(stubDir, "faulty.mjs");
    // Ready first; the corruption is sent only after the client asks for
    // something, so the request is waiting when the stream breaks.
    writeFileSync(stub, `#!/usr/bin/env node
const payload = Buffer.from(JSON.stringify({ type: "notice", text: "x" }), "utf8");
const chunk = (index, count, byteLength, data, chunkId) => JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength, data });
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    // Out-of-order chunks: index 1 before index 0.
    process.stdout.write(chunk(1, 2, 1100000, payload.subarray(3).toString("base64"), "seq-x") + "\\n");
    process.stdout.write(chunk(0, 2, 1100000, payload.subarray(0, 3).toString("base64"), "seq-x") + "\\n");
  }
});
setInterval(() => {}, 1000);
`, { mode: 0o755 });

    const client = await OmpRpc.start({
      repoRoot, runRoot, mode: "rpc-ui", args: [], cwd: runRoot,
      readyTimeoutMs: 8_000, launcher: stub,
    });
    const started = Date.now();
    const res = await client.request({ type: "get_state" }, { timeoutMs: 2_000 });
    const elapsed = Date.now() - started;
    ctx.check("R4: a request waiting when the stream faults does not report a timeout",
      res.errorKind === "transport" && /chunk decode failed/.test(res.error ?? ""),
      { errorKind: res.errorKind, error: res.error, elapsed });
    ctx.check("R4: the failure is reported promptly, not after the timeout elapsed",
      elapsed < 2_000, `${elapsed} ms (timeout was 2000 ms)`);
    ctx.check("R4: a genuine timeout keeps its own classification", await (async () => {
      // A stub that never answers keeps the request unanswered → must be "timeout".
      const silent = join(stubDir, "silent.mjs");
      writeFileSync(silent, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 2, supportedProtocolVersions: [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 }) + "\\n");
process.stdin.resume();
setInterval(() => {}, 1000);
`, { mode: 0o755 });
      const quietRoot = join(runRoot, "quiet");
      mkdirSync(quietRoot, { recursive: true });
      const quiet = await OmpRpc.start({ repoRoot, runRoot: quietRoot, mode: "rpc-ui", args: [], cwd: quietRoot, readyTimeoutMs: 8_000, launcher: silent });
      const timed = await quiet.request({ type: "get_state" }, { timeoutMs: 400 });
      const ok = timed.errorKind === "timeout" && /timeout after 400 ms/.test(timed.error ?? "");
      await quiet.stop();
      return ok;
    })(), "expected errorKind=timeout for an unanswered request");
    ctx.check("R4: the faulted client still stops cleanly", (await client.stop()) === true);
    ctx.check("R4: the faulted client left no isolated home behind", !existsSync(join(runRoot, "home")));
    writeFixture("e12-stream-error-vs-timeout.json", {
      note: "SYNTHETIC fault sample: a stub corrupts the chunk stream only after a request is in flight",
      waitingRequestError: { errorKind: res.errorKind, error: res.error, elapsedMs: elapsed },
      timeoutMs: 2000,
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
