/**
 * Minimal OMP RPC client for the M1 experiments.
 *
 * Frames stdout with readline (complete lines only), matches responses by
 * parsed `type`/`command`/`id`, installs stream error handlers before any
 * write, and reaps the whole process group on stop (bounded SIGTERM → SIGKILL).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  resolveRepoRoot,
  findPinnedLauncher,
  buildIsolatedEnv,
  makeConfigDirName,
  terminateTree,
  safeRmConfigRoot,
  safeRmSyntheticHome,
  experimentDataRoot,
} from "./base.mjs";
import { registerRuntime, unregisterRuntime } from "./runtime-registry.mjs";
import { RpcChunkDecoder } from "./ndjson.mjs";

export class OmpRpc {
  #child = null;
  #chunkDecoder = new RpcChunkDecoder();
  /** Physical `rpc_chunk` lines seen (protocol v2 framing). */
  chunkFramesSeen = 0;
  /** Logical frames that only became available after reassembly. */
  chunksAssembled = 0;
  dataRoot = null;
  #rl = null;
  #streamError = null;
  #exit = null;

  /** Every frame received, in order. */
  frames = [];
  /** stderr text (bounded by the caller's own use). */
  stderr = "";
  pid = null;
  configRoot = null;
  agentDir = null;
  launchDir = null;

  static async start({
    repoRoot = resolveRepoRoot(),
    runRoot,
    mode = "rpc-ui",
    args = [],
    cwd,
    extraEnv = {},
    readyTimeoutMs = 30_000,
    /** Test seam: launch this executable instead of the pinned source launcher. */
    launcher: launcherOverride = null,
  }) {
    const rpc = new OmpRpc();
    await rpc.#start({ repoRoot, runRoot, mode, args, cwd, extraEnv, readyTimeoutMs, launcherOverride });
    return rpc;
  }

  async #start({ repoRoot, runRoot, mode, args, cwd, extraEnv, readyTimeoutMs, launcherOverride }) {
    const launcher = launcherOverride ?? findPinnedLauncher(repoRoot);
    const configDirName = makeConfigDirName();
    const { env, configRoot, home } = buildIsolatedEnv({ repoRoot, runRoot, configDirName });
    this.configRoot = configRoot;
    this.home = home;
    this.runRoot = runRoot;
    this.agentDir = join(runRoot, "agent");
    this.launchDir = join(runRoot, "dev-cwd");

    this.#child = spawn(launcher, ["--mode", mode, ...args], {
      cwd: cwd ?? this.launchDir,
      env: { ...env, ...extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    });
    this.pid = this.#child.pid;

    const onErr = (where) => (e) => {
      if (!this.#streamError) this.#streamError = `${where}: ${e?.message ?? e}`;
    };
    this.#rl = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
    this.#rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let parsed;
      try {
        parsed = JSON.parse(t);
      } catch {
        this.frames.push({ type: "__unparsed__", raw: t.slice(0, 400) });
        return;
      }
      // Structural validation: a JSON `null`/scalar has no `.type`, and any
      // predicate touching `f.type` would throw inside this handler, which
      // would escape the await in #start and skip process cleanup.
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.type !== "string") {
        this.frames.push({ type: "__invalid__", raw: t.slice(0, 400) });
        return;
      }
      // Protocol v2 chunking: a logical frame larger than the 1 MiB line limit
      // arrives as a strictly ordered `rpc_chunk` sequence. Decoding has to
      // happen HERE, before response matching and event dispatch, or a large
      // response never reaches the caller that is waiting for it.
      let frame;
      try {
        frame = this.#chunkDecoder.push(parsed);
      } catch (error) {
        const message = String(error?.message ?? error).slice(0, 200);
        this.frames.push({ type: "__chunk_error__", error: message });
        // The pinned decoder has no resynchronisation path: once a sequence is
        // corrupted, every later frame is rejected against the stuck pending
        // state, and OMP's own client treats a decoder throw as fatal (it is
        // not caught around the read loop). Record the stream as failed so
        // pending and future requests fail fast instead of timing out.
        if (!this.#streamError) this.#streamError = `chunk decode failed: ${message}`;
        return;
      }
      if (frame === undefined) {
        this.chunkFramesSeen++;
        return;
      }
      if (parsed.type === "rpc_chunk") this.chunksAssembled++;
      this.frames.push(frame);
    });
    this.#rl.on("error", onErr("readline"));
    this.#child.stdout.on("error", onErr("stdout"));
    this.#child.stderr.on("error", onErr("stderr"));
    this.#child.stdin.on("error", onErr("stdin"));
    this.#child.stderr.on("data", (d) => {
      this.stderr += d.toString();
      if (this.stderr.length > 64_000) this.stderr = this.stderr.slice(-32_000);
    });
    this.#exit = new Promise((res) => this.#child.once("exit", (code, signal) => res({ code, signal })));
    this.#child.on("error", onErr("child"));

    // Register with the suite's reaper: the runtime is detached, so a killed
    // experiment cannot clean it up from a `finally`.
    this.configDirName = configDirName;
    this.runId = process.env.M1_RUN_ID ?? null;
    this.dataRoot = experimentDataRoot(repoRoot);
    registerRuntime(this.dataRoot, {
      pid: this.pid,
      pgrp: this.pid,
      agentDir: this.agentDir,
      configDirName,
      configRoot: this.configRoot,
      home: this.home,
      runRoot,
      runId: this.runId,
      ownerPid: process.pid,
      owner: process.argv[1] ? basename(process.argv[1]) : null,
    });

    // Every failure path below (spawn error, stream error, malformed frames,
    // timeout, predicate throw) must end in bounded teardown: the child runs
    // detached, so an escaping exception would leave it alive.
    try {
      const ready = await this.waitFor((f) => f.type === "ready", readyTimeoutMs);
      if (!ready) {
        const reason = this.#streamError ?? (this.stderr ? this.stderr.slice(-300) : "no ready frame");
        throw new Error(`OMP did not become ready: ${reason}`);
      }
      this.readyFrame = ready;
      return ready;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  get streamError() {
    return this.#streamError;
  }

  /** Raw write; returns false when a stream error already occurred. */
  write(frame) {
    if (this.#streamError) return false;
    try {
      this.#child.stdin.write(JSON.stringify(frame) + "\n");
      return true;
    } catch (e) {
      if (!this.#streamError) this.#streamError = `stdin: ${e?.message ?? e}`;
      return false;
    }
  }

  /** Wait for a frame matching `pred` (already-received frames included). */
  async waitFor(pred, timeoutMs = 10_000, fromIndex = 0) {
    const start = Date.now();
    for (;;) {
      for (let i = fromIndex; i < this.frames.length; i++) {
        if (pred(this.frames[i])) return this.frames[i];
      }
      if (this.#streamError) return null;
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /** Send a command and wait for its `response` frame. */
  async request(command, { timeoutMs = 15_000, id } = {}) {
    const cmdId = id ?? `req-${randomBytes(4).toString("hex")}`;
    const payload = { id: cmdId, ...command };
    const from = this.frames.length;
    if (!this.write(payload)) return { id: cmdId, type: "response", success: false, error: this.#streamError };
    const res = await this.waitFor(
      (f) => f.type === "response" && f.id === cmdId,
      timeoutMs,
      from,
    );
    return res ?? { id: cmdId, type: "response", success: false, error: "timeout", command: command.type };
  }

  /** Answer an `extension_ui_request`. */
  respondUi(id, payload) {
    return this.write({ type: "extension_ui_response", id, ...payload });
  }

  framesOfType(type) {
    return this.frames.filter((f) => f.type === type);
  }

  /** Stop the process group; resolves true when the group is fully reaped. */
  async stop(timeoutMs = 3_000) {
    if (!this.#child) return true;
    this.#rl?.close();
    const reaped = await terminateTree(this.#child, timeoutMs);
    this.reaped = reaped;
    this.#child = null;
    // Remove what this client created (never the user's ~/.omp or real home).
    if (!this.keepIsolation) {
      safeRmConfigRoot(this.configRoot);
      safeRmSyntheticHome(this.home, this.runRoot);
    }
    // Clean stop: forget the runtime so the reaper does not chase a dead pid.
    if (this.dataRoot) unregisterRuntime(this.dataRoot, this.pid);
    return reaped;
  }

  /**
   * Drop one side of the bridge the way a crashing or exiting desktop would:
   * `stdin` closes OMP's command channel (EOF), `stdout` removes its output
   * consumer (OMP's next write fails with EPIPE). Returns the child pid.
   */
  dropBridge(side = "stdin") {
    const child = this.#child;
    if (!child) return null;
    if (side === "stdin") child.stdin.destroy();
    else if (side === "stdout") {
      this.#rl?.close();
      child.stdout.destroy();
    } else throw new Error(`unknown bridge side: ${side}`);
    return child.pid;
  }

  /** True when the OMP process itself has exited within `timeoutMs`. */
  async waitForSelfExit(timeoutMs = 8_000) {
    if (!this.#child) return true;
    return await Promise.race([
      this.#exit.then(() => true),
      new Promise((r) => setTimeout(() => r(false), timeoutMs)),
    ]);
  }
}
