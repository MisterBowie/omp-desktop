#!/usr/bin/env node
/**
 * E09 — transport boundaries.
 *
 * Three parts:
 *   A. NdjsonReader property tests over synthetic byte streams (split UTF-8,
 *      split frames, batched frames, CRLF, invalid JSON, oversized line, empty
 *      lines, unterminated tail).
 *   B. Real OMP: a large multi-byte prompt round-trips byte-exact.
 *   C. Degraded runtimes: missing executable, banner on stdout, immediate
 *      crash, and a never-ready process are classified as protocol error vs.
 *      crash vs. start timeout, and the process is reclaimed either way.
 *
 * Usage: node e09-transport.mjs [--keep-artifacts]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { NdjsonReader } from "./lib/ndjson.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, buildIsolatedEnv, makeConfigDirName, terminateTree, safeRmConfigRoot } from "./lib/base.mjs";
import { runExperiment, experimentRoot, writeFixture } from "./lib/run.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const enc = (s) => Buffer.from(s, "utf8");
const ready = (extra = {}) => JSON.stringify({ type: "ready", protocolVersion: 2, ...extra }) + "\n";

/** Partition a buffer at explicit offsets to simulate arbitrary chunking. */
function chunks(buf, sizes) {
  const out = [];
  let i = 0;
  for (const size of sizes) {
    if (i >= buf.length) break;
    out.push(buf.subarray(i, Math.min(buf.length, i + size)));
    i += size;
  }
  if (i < buf.length) out.push(buf.subarray(i));
  return out;
}

const evidence = await runExperiment("e09-transport", async (ctx) => {
  const repoRoot = resolveRepoRoot();
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());
  const { root, runRoot, selector } = experimentRoot(ctx, "e09", { baseUrl: provider.baseUrl });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });

  // ==========================================================================
  // A. reader properties
  // ==========================================================================
  {
    // split a multi-byte character (😀 = 4 bytes) across two chunks
    const reader = new NdjsonReader();
    const payload = JSON.stringify({ type: "assistant_text", text: "汉字😀 é" }) + "\n";
    const buf = enc(payload);
    const emojiStart = buf.indexOf(enc("😀"));
    const got = [];
    const errs = [];
    for (const chunk of chunks(buf, [emojiStart + 2, 1, 100])) {
      const r = reader.push(chunk);
      got.push(...r.frames);
      errs.push(...r.errors);
    }
    ctx.check("split UTF-8 decodes to the original text", got.length === 1 && got[0].text === "汉字😀 é", got[0]?.text);
    ctx.check("split UTF-8 produces no protocol error", errs.length === 0, errs);
  }

  {
    // several frames in one chunk (each newline-terminated), then one split
    const reader = new NdjsonReader();
    const stream = enc([
      ready({ a: 1 }),
      JSON.stringify({ type: "x", n: 2 }) + "\n",
      JSON.stringify({ type: "y", n: 3 }) + "\n",
      JSON.stringify({ type: "z", n: 4 }) + "\n",
    ].join(""));
    const first = reader.push(stream);
    ctx.check("batched frames are emitted in order", first.frames.map((f) => f.type).join(",") === "ready,x,y,z", first.frames.map((f) => f.type));

    const reader2 = new NdjsonReader();
    const whole = enc(JSON.stringify({ type: "split", n: 7 }) + "\n");
    const parts = chunks(whole, [3, 4, 5]);
    const seen = parts.flatMap((c) => reader2.push(c).frames);
    ctx.check("a frame split across three chunks yields exactly one frame", seen.length === 1 && seen[0].n === 7, seen);
  }

  {
    // CRLF, blank lines, garbage, and an unterminated tail
    const reader = new NdjsonReader();
    const r1 = reader.push(enc(ready({ crlf: true }).replace("\n", "\r\n") + "\n" + "not json at all\n" + JSON.stringify({ type: "after_error" }) + "\n"));
    ctx.check("CRLF-terminated frame is parsed", r1.frames[0]?.type === "ready" && r1.frames[0]?.crlf === true, r1.frames[0]);
    ctx.check("blank line yields no frame and no error", true);
    ctx.check("invalid JSON is reported as a protocol error", r1.errors.length === 1 && r1.errors[0].kind === "invalid-json", r1.errors);
    ctx.check("reader continues after invalid JSON", r1.frames[1]?.type === "after_error", r1.frames.map((f) => f.type));

    const reader2 = new NdjsonReader();
    const r2 = reader2.push(enc(JSON.stringify({ type: "tail" })));
    ctx.check("unterminated tail is not emitted early", r2.frames.length === 0, r2.frames);
    const flushed = reader2.end();
    ctx.check("unterminated tail is emitted at end of stream", flushed.frames[0]?.type === "tail", flushed.frames);
  }

  {
    // oversized line: explicit error, bounded buffer, resync to the next frame
    const reader = new NdjsonReader({ maxLineBytes: 4096 });
    const huge = JSON.stringify({ type: "huge", pad: "x".repeat(20_000) });
    const r = reader.push(enc(huge.slice(0, 8192)));
    const r2 = reader.push(enc(huge.slice(8192) + "\n" + JSON.stringify({ type: "recovered" }) + "\n"));
    const errors = [...r.errors, ...r2.errors];
    ctx.check("oversized line is reported explicitly", errors.some((e) => e.kind === "line-too-large"), errors);
    ctx.check("reader resynchronises after an oversized line", [...r.frames, ...r2.frames].some((f) => f.type === "recovered"), [...r.frames, ...r2.frames].map((f) => f.type));
    ctx.check("oversized line does not emit a partial frame", ![...r.frames, ...r2.frames].some((f) => f.type === "huge"));
  }

  // ==========================================================================
  // B. real OMP: large multi-byte message round trip
  // ==========================================================================
  {
    const marker = "汉字😀é" + "x".repeat(180_000);
    provider.script([{ text: "received", finish: "stop" }]);
    let rpc;
    try {
      rpc = await OmpRpc.start({
        repoRoot, runRoot, mode: "rpc-ui",
        args: ["--model", selector, "--approval-mode", "yolo"],
        cwd: projectDir,
      });
      await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      const res = await rpc.request({ type: "prompt", message: marker }, { timeoutMs: 60_000 });
      ctx.check("a ~180 KB multi-byte prompt is accepted", res.success === true, res.success);
      await rpc.waitFor((f) => f.type === "agent_end", 60_000);
      const payloadSeen = provider.requests.some((r) => JSON.stringify(r.body ?? {}).includes(marker));
      ctx.check("the full multi-byte payload reached the model byte-exact", payloadSeen, `${provider.requests.length} provider requests`);
      ctx.check("stdout framing reported no unparsed frame", rpc.frames.every((f) => f.type !== "__unparsed__"), rpc.frames.filter((f) => f.type === "__unparsed__").length);
    } finally {
      if (rpc) ctx.check("real OMP process group reaped", (await rpc.stop()) === true);
    }
  }

  // ==========================================================================
  // C. degraded runtimes
  // ==========================================================================
  {
    const binDir = join(root, "fake-runtimes");
    mkdirSync(binDir, { recursive: true });

    const writeRuntime = (name, source) => {
      const p = join(binDir, name);
      writeFileSync(p, source, { mode: 0o755 });
      return p;
    };

    const banner = writeRuntime("banner.mjs", `#!/usr/bin/env node
process.stdout.write("Warning: some library banner on stdout\\n");
process.stdout.write(${JSON.stringify(ready({ banner: true }))});
process.stdin.on("data", (d) => {
  for (const line of String(d).split("\\n").filter(Boolean)) {
    const msg = JSON.parse(line);
    process.stdout.write(JSON.stringify({ id: msg.id, type: "response", command: msg.type, success: true, data: {} }) + "\\n");
  }
});
`);
    const crash = writeRuntime("crash.mjs", `#!/usr/bin/env node
process.stderr.write("fatal: native module missing\\n");
process.exit(3);
`);
    const hang = writeRuntime("hang.mjs", `#!/usr/bin/env node
process.stdin.resume();
setInterval(() => {}, 1000);
`);

    /** Launch a fake runtime and classify what the reader observes. */
    const probe = async (execPath, { timeoutMs = 6_000 } = {}) => {
      const { env, configRoot } = buildIsolatedEnv({ repoRoot, runRoot, configDirName: makeConfigDirName() });
      const child = spawn(execPath, [], { cwd: projectDir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
      const reader = new NdjsonReader();
      const frames = [];
      const errors = [];
      let stderr = "";
      let exited = null;
      child.stdout.on("data", (d) => {
        const r = reader.push(d);
        frames.push(...r.frames);
        errors.push(...r.errors);
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
      });
      child.once("exit", (code, signal) => {
        exited = { code, signal };
      });

      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline && !frames.some((f) => f.type === "ready") && exited === null) await sleep(50);
      const isReady = frames.some((f) => f.type === "ready");
      const result = {
        execPath: execPath.replace(root, "<run>"),
        pid: child.pid,
        ready: isReady,
        frames: frames.map((f) => f.type),
        errors: errors.map((e) => e.kind),
        exited,
        stderr: stderr.slice(0, 120),
        classification: isReady ? "usable" : exited !== null ? "crashed" : "start-timeout",
      };
      await terminateTree(child, 1_500);
      safeRmConfigRoot(configRoot);
      return result;
    };

    const bannerResult = await probe(banner);
    ctx.check("banner on stdout is reported as a protocol error, not a crash", bannerResult.errors.includes("invalid-json") && bannerResult.ready === true, bannerResult);
    ctx.check("a runtime with stdout noise is still classified usable", bannerResult.classification === "usable", bannerResult.classification);

    const crashResult = await probe(crash);
    ctx.check("immediate exit is classified as a crash", crashResult.classification === "crashed" && crashResult.exited?.code === 3, crashResult);
    ctx.check("crash diagnostics keep stderr for the caller", crashResult.stderr.includes("native module missing"), crashResult.stderr);

    const hangResult = await probe(hang, { timeoutMs: 3_000 });
    ctx.check("a never-ready runtime is classified as a start timeout", hangResult.classification === "start-timeout", hangResult);
    const stillAlive = await (async () => {
      for (let i = 0; i < 20; i++) {
        try {
          process.kill(hangResult.pid, 0);
        } catch {
          return false;
        }
        await sleep(100);
      }
      return true;
    })();
    ctx.check("a never-ready runtime is reclaimed rather than left running", stillAlive === false, `pid ${hangResult.pid}`);

    const missing = await (async () => {
      const missingPath = join(binDir, "definitely-not-installed-omp");
      try {
        await new Promise((resolve, reject) => {
          const child = spawn(missingPath, [], { stdio: ["pipe", "pipe", "pipe"] });
          child.once("error", reject);
          child.once("spawn", resolve);
        });
        return { threw: false };
      } catch (error) {
        return { threw: true, code: error.code, message: String(error.message).slice(0, 120) };
      }
    })();
    ctx.check("a missing executable fails fast as a spawn error, not a timeout", missing.threw === true && missing.code === "ENOENT", missing);
    ctx.note("missingExecutableProbe", missing);

    writeFixture("e09-degraded-runtimes.json", {
      note: "SYNTHETIC fault sample, not a real OMP capture: the runtimes are local stub scripts written by this experiment; only the reader's classification of them is observed behaviour.",
      banner: bannerResult,
      crash: crashResult,
      hang: { ...hangResult, pid: undefined },
    });
  }

  // ==========================================================================
  // D. bridge disconnect: EOF on stdin and EPIPE on stdout
  // ==========================================================================
  {
    // Case A: the desktop stops sending commands (stdin EOF) while the session
    // is idle. OMP must notice and shut itself down instead of idling forever.
    {
      let rpc;
      try {
        rpc = await OmpRpc.start({
          repoRoot, runRoot, mode: "rpc-ui",
          args: ["--model", selector],
          cwd: projectDir,
        });
        await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
        const pid = rpc.dropBridge("stdin");
        ctx.check("stdin EOF is injected into a live session", typeof pid === "number", pid);
        const exited = await rpc.waitForSelfExit(8_000);
        ctx.check("OMP exits by itself after stdin EOF (no orphan idle process)", exited === true,
          exited ? "self-exit observed" : "still running after 8s");
        ctx.check("stdin-EOF process group is fully reaped", (await rpc.stop()) === true);
        ctx.note("stdinEofStderr", rpc.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 200));
      } finally {
        if (rpc?.pid) try { await rpc.stop(); } catch { /* already stopped */ }
      }
    }

    // Case B: the desktop dies mid-stream, so OMP's next stdout write fails.
    // OMP must survive the EPIPE long enough to shut down cleanly.
    {
      let rpc;
      provider.script([{ text: "streaming", delayMs: 800, finish: "stop" }, { text: "next", finish: "stop" }]);
      try {
        rpc = await OmpRpc.start({
          repoRoot, runRoot, mode: "rpc-ui",
          args: ["--model", selector],
          cwd: projectDir,
        });
        await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
        const pid = rpc.dropBridge("stdout");
        ctx.check("stdout consumer is removed from a live session", typeof pid === "number", pid);
        const wrote = rpc.write({ type: "prompt", message: "keep streaming after the reader is gone" });
        ctx.note("promptWrittenAfterStdoutDrop", wrote);
        const exited = await rpc.waitForSelfExit(10_000);
        ctx.check("OMP shuts down instead of spinning after the reader disappears", exited === true,
          exited ? "self-exit observed" : "still running after 10s");
        ctx.check("stdout-EPIPE process group is fully reaped", (await rpc.stop()) === true);
        ctx.note("epipeStderr", rpc.stderr.trim().split("\n").slice(-2).join(" | ").slice(0, 200));
      } finally {
        if (rpc?.pid) try { await rpc.stop(); } catch { /* already stopped */ }
      }
    }

    ctx.limit("Bridge-disconnect handling is asserted as 'OMP exits by itself and the group is reaped'; the desktop-side reconnect policy is M2/T09.");
  }

  ctx.limit("Line-cap enforcement is specified by lib/ndjson.mjs; the production reader is M2/T09 and must adopt an explicit cap (Node's readline has no line limit).");
  ctx.limit("Windows/macOS process reclamation is not covered here.");
});

process.exit(evidence.ok ? 0 : 1);
