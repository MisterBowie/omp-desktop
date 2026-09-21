/**
 * Minimal OMP RPC client for the M1 experiments.
 *
 * Frames stdout with readline (complete lines only), matches responses by
 * parsed `type`/`command`/`id`, installs stream error handlers before any
 * write, and reaps the whole process group on stop (bounded SIGTERM → SIGKILL).
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  resolveRepoRoot,
  findPinnedLauncher,
  buildIsolatedEnv,
  makeConfigDirName,
  terminateTree,
  safeRmConfigRoot,
  safeRmSyntheticHome,
} from "./base.mjs";

export class OmpRpc {
  #child = null;
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
      try {
        const parsed = JSON.parse(t);
        // Structural validation: a JSON `null`/scalar has no `.type`, and any
        // predicate touching `f.type` would throw inside this handler, which
        // would escape the await in #start and skip process cleanup.
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.type !== "string") {
          this.frames.push({ type: "__invalid__", raw: t.slice(0, 400) });
          return;
        }
        this.frames.push(parsed);
      } catch {
        this.frames.push({ type: "__unparsed__", raw: t.slice(0, 400) });
      }
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
