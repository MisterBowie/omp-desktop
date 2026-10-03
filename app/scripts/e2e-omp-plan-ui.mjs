#!/usr/bin/env node
/**
 * M5/T20-D (D3): the real user path on the OMP engine.
 *
 * This harness drives the *actual* Electron renderer (real preload IPC, real
 * Main, real host-core over a real SQLite database) against the production OMP
 * bridge/gate, the fixed patched runtime and a local FakeProvider. Nothing but
 * the model endpoint is a fixture:
 *
 *   1. the user switches a live OMP session to Plan with the composer mode
 *      chip, types a prompt and sends it;
 *   2. the model (FakeProvider) submits a plan through the real `SubmitPlan`
 *      host tool; the real `PlanApprovalBar` appears with the immutable
 *      artifact the host published;
 *   3. rejecting returns the composer to an editable state; editing and
 *      resubmitting produces a new proposal and a new artifact while the first
 *      artifact's bytes stay untouched;
 *   4. approving with the `ask` permission mode runs the approved plan as an
 *      agent turn: the real `write` tool raises the real `PermissionCard`, and
 *      allowing it once writes the marker file and completes the execution;
 *   5. a second cycle approves with `accept-edits`; the write runs with no card;
 *   6. a third cycle approves with `auto` through the real approval menu: a
 *      high-risk `bash` call (the tool `accept-edits` does *not* cover and
 *      `ask` cards) runs with no card and its side effects land, and the
 *      durable rows record the selected mode;
 *   7. a fourth cycle holds a real approved execution in `running` — a live
 *      OMP runtime process group with a live `sleep` child — and then restarts
 *      the whole application (Main + host + owned OMP runtime) on the same
 *      data directory: the execution is interrupted by boot maintenance, the
 *      provider sees no replay, the side-effect log keeps exactly one line and
 *      a fresh agent turn proves the UI is usable again;
 *   8. a fifth proposal is left pending and the app is restarted once more: the
 *      pending proposal turns `interrupted`/`PLAN_APPROVAL_INTERRUPTED`, the
 *      completed rows stay completed and nothing is replayed.
 *
 * The harness isolates the child environment: the app and every process it
 * owns run with a dedicated `HOME` plus `XDG_*`/`TMPDIR` under the run's
 * scratch root, so no user configuration, skill or credential file is read or
 * written. The child `PATH` carries only the absolute Node/Bun directories and
 * the system binaries; the display and its `XAUTHORITY` are passed through.
 * Every process the harness spawns is recorded (Electron group, host, OMP
 * runtime group, tool children) and reclamation is verified after each
 * restart and at teardown: a survivor is a hard failure, never a silent
 * timeout, and the scratch root is kept for diagnosis when that happens.
 *
 * The run writes one structured raw report (`omp-plan-ui-raw.json`): every
 * fixture provider request, per-step UI snapshots, the real session/native/
 * live/durable/proposal/execution ids, the read-only SQLite rows, artifact
 * sizes and hashes, the process/pid/pgid evidence and the cleanup report.
 *
 * The OMP runtime is the patched tree (`preparePatchedTree`), never a global
 * `omp`; the model endpoint is `FakeProvider`, so no paid or remote model is
 * ever contacted. Requires a real display (`DISPLAY`/`XAUTHORITY`).
 *
 * Usage:
 *   DISPLAY=:1 XAUTHORITY=... node scripts/e2e-omp-plan-ui.mjs
 *   PI_DESKTOP_E2E_PATCHED_TREE=/tmp/omp-patched node scripts/e2e-omp-plan-ui.mjs
 */
import { createServer } from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

import { FakeProvider } from "../experiments/omp-bridge/lib/provider.mjs";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";
import {
  bunBinary,
  isolatedEnv,
  isSignalableProcessGroup,
  loadManifest,
  preparePatchedTree,
} from "./omp-patch.mjs";

const WAIT_TIMEOUT_MS = 45_000;
const TURN_TIMEOUT_MS = 240_000;
const CDP_TIMEOUT_MS = 15_000;
const CLEANUP_TIMEOUT_MS = 10_000;
/** Grace for the whole owned process tree to exit after the first signal. */
const PROC_GRACE_MS = 8_000;
/** Grace per escalation stage (SIGTERM/SIGKILL of surviving owned groups). */
const PROC_ESCALATION_MS = 4_000;
const POLL_MS = 100;

/** Markers route the FakeProvider turns; they never collide with each other. */
const M1 = "E2E-PLAN-ONE";
const M2 = "E2E-PLAN-TWO";
const M3 = "E2E-PLAN-THREE";
const M4 = "E2E-PLAN-FOUR";
const M5 = "E2E-PLAN-FIVE";
const M6 = "E2E-PLAN-SIX";
const EXEC1 = "E2E-EXEC-ONE";
const EXEC2 = "E2E-EXEC-TWO";
const EXEC3 = "E2E-EXEC-THREE";
const EXEC4 = "E2E-EXEC-FOUR";
const AFTER_RESTART = "E2E-AFTER-RESTART";
/**
 * Two submissions with byte-identical text, sent one after the other after a
 * restart: the transcript must keep both, with distinct message ids (no
 * content-based dedupe can be right here).
 */
const TWICE = "E2E-SAME-TEXT-TWICE";

const results = new Map();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function shortText(value, max = 700) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function jsonText(value, max = 900) {
  return shortText(JSON.stringify(value), max);
}

function record(id, ok, detail = "") {
  results.set(id, { id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} - ${detail}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** Drop credential-shaped fields before anything is persisted as evidence. */
const SENSITIVE_KEY_RE = /(secret|token|password|passwd|api[_-]?key|authorization|cookie|credential)/i;

function sanitizeValue(value, depth = 0) {
  if (depth > 12) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) ? "[redacted]" : sanitizeValue(item, depth + 1);
    }
    return out;
  }
  return value;
}

async function allocatePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function failPending(pending, error) {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  pending.clear();
}

class CdpClient {
  constructor(onFailure) {
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.onFailure = onFailure;
    this.closed = false;
  }

  static async connect(url, onFailure) {
    assert(typeof WebSocket === "function", "Node WebSocket global is unavailable");
    const client = new CdpClient(onFailure);
    await new Promise((resolveOpen, rejectOpen) => {
      const socket = new WebSocket(url);
      client.socket = socket;
      socket.addEventListener("open", resolveOpen, { once: true });
      socket.addEventListener(
        "error",
        () => rejectOpen(new Error(`CDP WebSocket connection failed: ${url}`)),
        { once: true },
      );
    });
    client.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (error) {
        client.fail(new Error(`invalid CDP message: ${errorText(error)}`));
        return;
      }
      if (message.id !== undefined && message.id !== null) {
        const entry = client.pending.get(String(message.id));
        if (!entry) return;
        client.pending.delete(String(message.id));
        clearTimeout(entry.timer);
        if (message.error) {
          const error = new Error(`CDP ${entry.method} failed: ${message.error.message || jsonText(message.error)}`);
          error.cdp = true;
          entry.reject(error);
        } else {
          entry.resolve(message.result);
        }
        return;
      }
      if (message.method) {
        for (const listener of client.handlers.get(message.method) ?? []) {
          listener(message.params ?? {});
        }
      }
    });
    client.socket.addEventListener("close", () => {
      if (client.closed) return;
      client.closed = true;
      const error = new Error("CDP WebSocket closed unexpectedly");
      error.cdp = true;
      failPending(client.pending, error);
      client.onFailure?.(error);
    });
    return client;
  }

  fail(error) {
    if (this.closed) return;
    this.closed = true;
    error.cdp = true;
    failPending(this.pending, error);
    this.onFailure?.(error);
  }

  on(method, listener) {
    const listeners = this.handlers.get(method) ?? [];
    listeners.push(listener);
    this.handlers.set(method, listeners);
    return () => {
      this.handlers.set(
        method,
        (this.handlers.get(method) ?? []).filter((candidate) => candidate !== listener),
      );
    };
  }

  send(method, params = {}, timeoutMs = CDP_TIMEOUT_MS) {
    if (this.closed || !this.socket) {
      const error = new Error(`CDP is unavailable for ${method}`);
      error.cdp = true;
      return Promise.reject(error);
    }
    const id = this.nextId++;
    return new Promise((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(String(id))) return;
        const error = new Error(`CDP timeout ${method} after ${timeoutMs}ms`);
        error.cdp = true;
        rejectResult(error);
      }, timeoutMs);
      this.pending.set(String(id), { method, resolve: resolveResult, reject: rejectResult, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(String(id));
        const cdpError = error instanceof Error ? error : new Error(String(error));
        cdpError.cdp = true;
        rejectResult(cdpError);
      }
    });
  }

  async evaluate(expression, context = "renderer") {
    const response = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (response?.exceptionDetails) {
      const description =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        `${context} evaluation threw`;
      throw new Error(`${context} evaluation failed: ${shortText(description)}`);
    }
    return response?.result?.value;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    failPending(this.pending, new Error("CDP closed by acceptance harness"));
    try {
      this.socket?.close();
    } catch {
      // Already torn down.
    }
  }
}

function ensureHealthy(state) {
  if (state.cdpError) throw state.cdpError;
}

async function waitFor(predicate, label, state, timeoutMs = WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    ensureHealthy(state);
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      if (error?.cdp) throw error;
      lastError = error;
    }
    await delay(POLL_MS);
  }
  ensureHealthy(state);
  throw new Error(
    `timeout waiting for ${label}${lastError ? `; last error: ${shortText(errorText(lastError))}` : ""}`,
  );
}

async function fetchJsonList(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error(`CDP /json/list returned HTTP ${response.status}`);
  return response.json();
}

/* ------------------------------------------------------------------------- */
/* Isolated child environment (R2)                                            */
/* ------------------------------------------------------------------------- */

/**
 * The child environment is assembled from scratch, never `{...process.env}`:
 * a dedicated HOME plus XDG dirs and TMPDIR keep the app and every process it
 * owns away from the user's configuration, skills and credentials. Only the
 * toolchain paths the runtime needs (Node, Bun, system binaries) and the
 * display authentication are passed through.
 */
function prepareIsolatedHome(state) {
  const home = join(state.tempRoot, "home");
  const dirs = {
    home,
    config: join(home, ".config"),
    data: join(home, ".local", "share"),
    state: join(home, ".local", "state"),
    cache: join(home, ".cache"),
    tmp: join(state.tempRoot, "tmp"),
  };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  // The product derives the runtime child's PATH from the *inherited* HOME
  // (`<home>/.bun/bin` first). With an isolated HOME that directory is ours,
  // so the absolute Bun/Node toolchain is linked in — nothing is copied from
  // the user's configuration, and the launcher still resolves `bun`.
  const toolBin = join(home, ".bun", "bin");
  mkdirSync(toolBin, { recursive: true });
  const toolchains = [
    { name: "bun", target: bunBinary() },
    { name: "node", target: process.execPath },
  ];
  state.toolchainLinks = [];
  for (const tool of toolchains) {
    const link = join(toolBin, tool.name);
    if (!existsSync(link)) symlinkSync(tool.target, link);
    state.toolchainLinks.push({ link, target: tool.target });
  }
  state.homeDirs = dirs;
  return dirs;
}

function childEnvironment(state) {
  const dirs = state.homeDirs;
  const display = process.env.DISPLAY?.trim();
  const xauthority = process.env.XAUTHORITY?.trim();
  if (!display) throw new Error("DISPLAY is required for the real Electron run");
  if (!xauthority) {
    throw new Error(
      "XAUTHORITY is required: the child runs with an isolated HOME, so the user's ~/.Xauthority is intentionally not reachable",
    );
  }
  const env = {
    PATH: [
      dirname(process.execPath),
      dirname(bunBinary()),
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
    ].join(":"),
    HOME: dirs.home,
    XDG_CONFIG_HOME: dirs.config,
    XDG_DATA_HOME: dirs.data,
    XDG_STATE_HOME: dirs.state,
    XDG_CACHE_HOME: dirs.cache,
    TMPDIR: dirs.tmp,
    LANG: process.env.LANG || "C.UTF-8",
    DISPLAY: display,
    XAUTHORITY: xauthority,
    PI_DESKTOP_DATA_DIR: state.dataDir,
    PI_DESKTOP_HOST_BIN: state.hostBinary,
    // The product must run the patched runtime; a global `omp` is never
    // consulted (launcher resolution refuses PATH).
    OMP_DESKTOP_RUNTIME: state.patchedLauncher,
    ELECTRON_RENDERER_URL: "",
    PI_DESKTOP_START_MAXIMIZED: "0",
  };
  return env;
}

function startElectron(state) {
  const child = spawn(
    state.electronBinary,
    [
      "--no-sandbox",
      `--remote-debugging-port=${state.cdpPort}`,
      `--user-data-dir=${state.profileDir}`,
      ".",
    ],
    {
      cwd: state.appDir,
      env: childEnvironment(state),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: false,
      detached: process.platform !== "win32",
    },
  );
  state.electron = child;
  state.electronStartedAt = new Date().toISOString();
  state.processReports.push({
    label: "spawn",
    at: state.electronStartedAt,
    electronPid: child.pid ?? null,
    electronPgid: child.pid ?? null,
  });
  child.stdout?.on("data", (chunk) => {
    state.electronOutput += `[stdout] ${chunk}`;
  });
  child.stderr?.on("data", (chunk) => {
    state.electronOutput += `[stderr] ${chunk}`;
  });
  child.once("exit", (code, signal) => {
    if (state.stopping) return;
    state.cdpError = new Error(
      `Electron exited before acceptance completed (code=${code}, signal=${signal || "none"})\n${shortText(state.electronOutput, 3_000)}`,
    );
    state.cdp?.fail(state.cdpError);
  });
}

/* ------------------------------------------------------------------------- */
/* Owned-process evidence and reclamation (R2)                                */
/* ------------------------------------------------------------------------- */

/** One /proc snapshot: pid, ppid, pgid, comm, start time and command line. */
function readProcSnapshot() {
  const entries = new Map();
  if (process.platform !== "linux" || !existsSync("/proc")) return entries;
  let names;
  try {
    names = readdirSync("/proc");
  } catch {
    return entries;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let statText = "";
    try {
      statText = readFileSync(`/proc/${name}/stat`, "utf8");
    } catch {
      continue;
    }
    const open = statText.indexOf("(");
    const close = statText.lastIndexOf(")");
    if (open < 0 || close < 0) continue;
    const comm = statText.slice(open + 1, close);
    const fields = statText.slice(close + 2).trim().split(/\s+/);
    let cmdline = "";
    try {
      cmdline = readFileSync(`/proc/${name}/cmdline`, "utf8");
    } catch {
      // Kernel threads and exited races have no readable command line.
    }
    entries.set(pid, {
      pid,
      ppid: Number(fields[1] ?? 0),
      pgid: Number(fields[2] ?? 0),
      comm,
      starttime: fields[19] ?? "",
      cmdline: cmdline.split("\0").filter(Boolean).join(" ").trim(),
    });
  }
  return entries;
}

function describeProcess(entry) {
  return {
    pid: entry.pid,
    ppid: entry.ppid,
    pgid: entry.pgid,
    comm: entry.comm,
    starttime: entry.starttime,
    cmdline: entry.cmdline.length > 700 ? `${entry.cmdline.slice(0, 700)}…` : entry.cmdline,
  };
}

/**
 * The processes this run owns: every descendant of the roots (Electron and,
 * while it lives, the spawned children) plus anything whose command line still
 * names this run's unique scratch root — a detached OMP runtime survives
 * reparenting, so the ppid walk alone is not enough.
 */
function ownedProcessSnapshot(state, roots) {
  const table = readProcSnapshot();
  if (table.size === 0) return { supported: false, processes: [] };
  const children = new Map();
  for (const entry of table.values()) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const owned = new Map();
  const queue = roots.filter((pid) => typeof pid === "number" && pid > 1);
  while (queue.length > 0) {
    const pid = queue.shift();
    if (owned.has(pid)) continue;
    const entry = table.get(pid);
    if (!entry) continue;
    owned.set(pid, entry);
    for (const childPid of children.get(pid) ?? []) queue.push(childPid);
  }
  const markers = [state.tempRoot, state.patchedTree].filter(Boolean);
  for (const entry of table.values()) {
    if (owned.has(entry.pid) || entry.pid === process.pid) continue;
    if (markers.some((marker) => entry.cmdline.includes(marker))) owned.set(entry.pid, entry);
  }
  return {
    supported: true,
    processes: [...owned.values()].map(describeProcess).sort((a, b) => a.pid - b.pid),
  };
}

/** True when the pid still exists with the same identity (start time). */
function processStillOwned(entry) {
  if (process.platform !== "linux") return false;
  let statText = "";
  try {
    statText = readFileSync(`/proc/${entry.pid}/stat`, "utf8");
  } catch {
    return false;
  }
  const close = statText.lastIndexOf(")");
  if (close < 0) return false;
  const fields = statText.slice(close + 2).trim().split(/\s+/);
  return String(fields[19] ?? "") === String(entry.starttime ?? "");
}

async function waitForProcessesGone(entries, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = entries.filter(processStillOwned);
  while (remaining.length > 0 && Date.now() < deadline) {
    await delay(POLL_MS);
    remaining = remaining.filter(processStillOwned);
  }
  return remaining;
}

function electronHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForElectronExit(child, timeoutMs) {
  if (electronHasExited(child)) return true;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  return Promise.race([exited.then(() => true), delay(timeoutMs).then(() => false)]);
}

/**
 * Terminate the app and every process it owns, and *verify* the reclamation.
 *
 * The Electron child is its own process group (the host shares it); the OMP
 * runtime is detached into its own group; tool children live inside that
 * group. A process that survives the escalation is a hard failure: the caller
 * fails the run and keeps the scratch root for diagnosis instead of deleting
 * it and claiming success.
 */
async function terminateOwnedApp(state, label) {
  const report = {
    label,
    at: new Date().toISOString(),
    electronPid: state.electron?.pid ?? null,
    processScanSupported: true,
    before: [],
    stages: [],
    leftover: [],
    ok: false,
  };
  if (state.cdp) await state.cdp.close();
  const child = state.electron;
  if (!child) {
    report.ok = true;
    report.note = "no Electron process to terminate";
    state.cdp = null;
    state.processReports.push(report);
    return report;
  }
  const snapshot = ownedProcessSnapshot(state, [child.pid]);
  report.processScanSupported = snapshot.supported;
  report.before = snapshot.processes;
  state.stopping = true;
  try {
    if (electronHasExited(child)) {
      report.stages.push({ action: "already-exited", at: new Date().toISOString() });
    } else {
      report.stages.push({ action: "SIGTERM", target: `process-group -${child.pid}`, at: new Date().toISOString() });
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    const exited = await waitForElectronExit(child, CLEANUP_TIMEOUT_MS);
    if (!exited) {
      report.stages.push({ action: "SIGKILL", target: `process-group -${child.pid}`, at: new Date().toISOString() });
      try {
        if (process.platform === "win32") child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        // Best effort; the verification below decides.
      }
      await waitForElectronExit(child, PROC_ESCALATION_MS);
    }
    report.electronExited = electronHasExited(child);

    let remaining = snapshot.supported
      ? await waitForProcessesGone(report.before, PROC_GRACE_MS)
      : [];
    if (remaining.length > 0) {
      const ownGroup = typeof process.getpgrp === "function" ? process.getpgrp() : null;
      const groups = [...new Set(remaining.map((entry) => entry.pgid))].filter(
        (pgid) => isSignalableProcessGroup(pgid) && pgid !== ownGroup && pgid !== child.pid,
      );
      report.stages.push({ action: "SIGTERM-owned-groups", groups, at: new Date().toISOString() });
      for (const pgid of groups) {
        try {
          process.kill(-pgid, "SIGTERM");
        } catch {
          // Group may have exited between the scan and the signal.
        }
      }
      remaining = await waitForProcessesGone(remaining, PROC_ESCALATION_MS);
      if (remaining.length > 0) {
        report.stages.push({ action: "SIGKILL-owned-groups", groups, at: new Date().toISOString() });
        for (const pgid of groups) {
          try {
            process.kill(-pgid, "SIGKILL");
          } catch {
            // Same race as above.
          }
        }
        remaining = await waitForProcessesGone(remaining, PROC_ESCALATION_MS);
      }
    }
    report.leftover = remaining;
    if (!snapshot.supported) {
      report.ok = report.electronExited === true;
      report.limitation = "process table unavailable on this platform; verified the Electron child only";
    } else {
      report.ok = report.electronExited === true && remaining.length === 0;
    }
    if (!report.ok) {
      report.failure = report.electronExited
        ? `${remaining.length} owned process(es) survived SIGKILL: ${remaining
            .map((entry) => `${entry.pid}:${entry.comm}`)
            .join(", ")}`
        : "the Electron process did not exit";
    }
  } finally {
    state.electron = null;
    state.cdp = null;
    state.stopping = false;
    state.processReports.push(report);
  }
  if (!report.ok) {
    throw new Error(`process reclamation failed for ${label}: ${report.failure}`);
  }
  return report;
}

/* ------------------------------------------------------------------------- */
/* Renderer inspection                                                         */
/* ------------------------------------------------------------------------- */

async function connectRenderer(state) {
  const target = await waitFor(
    async () => {
      try {
        const targets = await fetchJsonList(state.cdpPort);
        // Two file: pages exist in this app (the main shell and a hidden
        // plugin-launcher surface); only the main shell carries the app UI.
        return targets.find(
          (candidate) =>
            candidate.type === "page" &&
            candidate.webSocketDebuggerUrl &&
            candidate.url.includes("/out/renderer/index.html") &&
            !candidate.url.includes("surface="),
        );
      } catch {
        return null;
      }
    },
    "/json/list renderer target",
    state,
  );
  state.cdp = await CdpClient.connect(target.webSocketDebuggerUrl, (error) => {
    if (state.stopping) return;
    state.cdpError = new Error(
      `${errorText(error)}${state.electronOutput ? `\nElectron output:\n${shortText(state.electronOutput, 3_000)}` : ""}`,
    );
  });
  await state.cdp.send("Runtime.enable");
  await state.cdp.send("Page.enable");
  state.cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args ?? [])
      .map((argument) => argument.value ?? argument.description ?? argument.type ?? "")
      .join(" ");
    state.consoleDiagnostics.push({ level: params.type || "log", text });
  });
  state.cdp.on("Runtime.exceptionThrown", (params) => {
    state.consoleDiagnostics.push({
      level: "exception",
      text: params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "renderer exception",
    });
  });
}

async function inspectUi(state) {
  return state.cdp.evaluate(`(() => {
    const visible = (node) => {
      if (!node) return false;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    };
    const text = (node) => (node?.innerText || node?.textContent || "").replace(/\\s+/g, " ").trim();
    const modeChip = document.querySelector(".composer-shell button.mode-chip.composer-mode-chip");
    const stop = document.querySelector(".composer-shell .stop-btn");
    const bar = document.querySelector('[data-testid="plan-approval-bar"]');
    const permission = document.querySelector(".permission-card");
    const prompt = document.querySelector(".composer-input");
    const activeRow = [...document.querySelectorAll("[data-sidebar-session-row]")]
      .find((node) => node.getAttribute("aria-current") === "page" || node.classList.contains("active"));
    const approveMenu = document.querySelector(".plan-approval-menu.is-open");
    const send = document.querySelector(".composer-shell .send-btn");
    return {
      ready: Boolean(document.querySelector(".app-shell") && prompt),
      booting: Boolean(document.querySelector(".app-shell.is-booting")),
      lang: document.documentElement.lang || "",
      activeSessionId: activeRow?.getAttribute("data-sidebar-session-row") || null,
      bodyText: document.body?.innerText || "",
      modeChip: modeChip
        ? {
            visible: visible(modeChip),
            dataMode: modeChip.getAttribute("data-mode"),
            label: text(modeChip),
            disabled: Boolean(modeChip.disabled),
          }
        : null,
      approval: bar && visible(bar)
        ? {
            status: bar.getAttribute("data-status") || "",
            kind: bar.getAttribute("data-kind") || "",
            executionState: bar.getAttribute("data-execution-state") || "",
            title: text(bar.querySelector(".plan-approval-title")),
            question: text(bar.querySelector(".plan-approval-question")),
            artifactPath: text(bar.querySelector(".plan-approval-artifact-path")),
            rejectVisible: visible(bar.querySelector(".plan-approval-reject")),
            approveLabel: text(bar.querySelector(".plan-approval-approve-main")),
            menuVisible: Boolean(approveMenu),
          }
        : null,
      permission: permission && visible(permission)
        ? {
            tool: permission.getAttribute("data-tool") || null,
            title: text(permission.querySelector(".permission-card-title")),
            prompt: text(permission.querySelector(".permission-card-prompt")),
            risk: text(permission.querySelector(".permission-risk")),
          }
        : null,
      promptReadOnly:
        prompt?.getAttribute("aria-readonly") === "true" ||
        prompt?.getAttribute("contenteditable") === "false",
      stopVisible: visible(stop),
      sendDisabled: send ? Boolean(send.disabled) : null,
    };
  })()`);
}

async function waitForRendererReady(state) {
  return waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.ready && !snapshot.booting ? snapshot : null;
    },
    "renderer shell ready",
    state,
  );
}

async function reloadRenderer(state) {
  const loadEvent = new Promise((resolveLoad) => {
    const off = state.cdp.on("Page.loadEventFired", () => {
      off();
      resolveLoad();
    });
    setTimeout(() => {
      off();
      resolveLoad();
    }, WAIT_TIMEOUT_MS).unref?.();
  });
  await state.cdp.send("Page.reload", { ignoreCache: false });
  await loadEvent;
  await waitForRendererReady(state);
}

async function clickSelector(state, selector, description) {
  const result = await state.cdp.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { clicked: false };
    if (node instanceof HTMLElement && node.offsetParent === null) return { clicked: false, hidden: true };
    node.click();
    return { clicked: true };
  })()`);
  assert(result?.clicked, `could not click ${description || selector}`);
}

async function selectSession(state, sessionId) {
  const selection = await state.cdp.evaluate(`(async () => {
    const wanted = ${JSON.stringify(sessionId)};
    const findRow = () => [...document.querySelectorAll("[data-sidebar-session-row]")]
      .find((node) => node.getAttribute("data-sidebar-session-row") === wanted);
    let row = findRow();
    if (!row) {
      for (const toggle of document.querySelectorAll('[data-action="toggle-project-collapse"][aria-expanded="false"]')) {
        toggle.click();
      }
      for (const more of document.querySelectorAll(".sidebar-load-more")) more.click();
      await new Promise((resolveWait) => requestAnimationFrame(() => resolveWait()));
      row = findRow();
    }
    if (row) {
      row.querySelector("button.thread-item-main")?.click();
      return { method: "dom", found: true };
    }
    if (typeof window.__PI_DESKTOP__?.selectSession === "function") {
      await window.__PI_DESKTOP__.selectSession(wanted);
      return { method: "renderer-session-api", found: false };
    }
    return { method: "none", found: false };
  })()`);
  assert(selection?.method !== "none", `session row ${sessionId} was not found: ${jsonText(selection)}`);
  await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.activeSessionId === sessionId && !snapshot.booting;
    },
    `active session ${sessionId}`,
    state,
  );
}

async function fillComposer(state, prompt) {
  const result = await state.cdp.evaluate(`(() => {
    const input = document.querySelector(".composer-input");
    if (!(input instanceof HTMLElement)) return { filled: false, reason: "composer editor missing" };
    if (input.getAttribute("contenteditable") === "false") return { filled: false, reason: "composer editor is read-only" };
    input.focus();
    input.textContent = ${JSON.stringify(prompt)};
    input.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: "insertText",
      data: ${JSON.stringify(prompt)},
    }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return { filled: true };
  })()`);
  assert(result?.filled === true, `real Composer fill failed: ${jsonText(result)}`);
  await waitFor(
    async () => (await inspectUi(state)).sendDisabled === false,
    "filled live Composer Send enabled",
    state,
    WAIT_TIMEOUT_MS,
  );
  await clickSelector(state, ".composer-shell .send-btn", "live Composer Send");
}

async function switchMode(state, mode) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await inspectUi(state);
    if (snapshot.modeChip?.dataMode === mode) return snapshot;
    await clickSelector(state, ".composer-shell button.mode-chip.composer-mode-chip", `composer mode chip → ${mode}`);
    await delay(150);
  }
  return waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.modeChip?.dataMode === mode ? snapshot : null;
    },
    `composer chip shows ${mode}`,
    state,
  );
}

async function getPreloadResult(state, channelName, args = []) {
  const result = await state.cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    if (!bridge?.invoke || !bridge.channels?.invoke?.${channelName}) {
      throw new Error("required preload channel is unavailable: ${channelName}");
    }
    return bridge.invoke(bridge.channels.invoke.${channelName}, ...${JSON.stringify(args)});
  })()`);
  assert(result?.ok === true, `preload ${channelName} failed: ${jsonText(result)}`);
  return result.data;
}

async function getSession(state, sessionId) {
  const result = await getPreloadResult(state, "sessionGet", [sessionId]);
  return result?.session ?? null;
}

async function getPendingPlan(state, sessionId) {
  const result = await getPreloadResult(state, "plansPending", [{ sessionId }]);
  return Array.isArray(result?.plans)
    ? result.plans.find((proposal) => proposal?.status === "pending") || null
    : null;
}

/* ------------------------------------------------------------------------- */
/* Read-only durable facts and evidence                                        */
/* ------------------------------------------------------------------------- */

function readDatabase(state) {
  return new DatabaseSync(join(state.dataDir, "pi.sqlite"), { readOnly: true });
}

function queryAll(state, sql, ...params) {
  const db = readDatabase(state);
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

function queryOne(state, sql, ...params) {
  const db = readDatabase(state);
  try {
    return db.prepare(sql).get(...params) ?? null;
  } finally {
    db.close();
  }
}

const SESSION_COLUMNS =
  "id, title, mode, permission_mode, engine, engine_adapter_version, engine_runtime_version, " +
  "native_session_id, native_session_path, project_id, provider_id, model_id, created_at, updated_at";

function proposalRow(state, requestId) {
  return queryOne(
    state,
    "SELECT request_id, session_id, turn_id, tool_call_id, kind, title, question, status, action, " +
      "target_permission_mode, feedback, error_code, artifact_relative_path, artifact_sha256, " +
      "artifact_size_bytes, version, execution_id, execution_state, created_at, resolved_at, updated_at " +
      "FROM plan_approvals WHERE request_id = ?",
    requestId,
  );
}

function captureDurableState(state, label, sessionId) {
  state.evidence.durable[label] = {
    at: new Date().toISOString(),
    session: queryOne(state, `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, sessionId),
    proposals: queryAll(
      state,
      "SELECT request_id, session_id, turn_id, tool_call_id, kind, title, question, status, action, " +
        "target_permission_mode, error_code, artifact_relative_path, artifact_sha256, artifact_size_bytes, " +
        "version, execution_id, execution_state, created_at, resolved_at, updated_at " +
        "FROM plan_approvals WHERE session_id = ? ORDER BY created_at",
      sessionId,
    ),
    turns: queryAll(
      state,
      "SELECT id, status, provider_id, model_id, error_code, started_at, ended_at " +
        "FROM turns WHERE session_id = ? ORDER BY started_at",
      sessionId,
    ),
    audit: queryAll(
      state,
      "SELECT id, ts, kind, session_id, payload_json FROM audit_log WHERE session_id = ? ORDER BY id",
      sessionId,
    ),
  };
  return state.evidence.durable[label];
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fileFacts(path) {
  const stats = statSync(path);
  return { path, sizeBytes: stats.size, sha256: sha256File(path) };
}

async function captureScreenshot(state, name) {
  const response = await state.cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: false,
  });
  const path = join(state.artifactDir, `${name}.png`);
  writeFileSync(path, Buffer.from(response.data, "base64"));
  state.screenshots.push(path);
  state.evidence.artifacts.push({ name, ...fileFacts(path) });
  console.log(`ARTIFACT ${path}`);
  return path;
}

/**
 * Install the page-global agent-event recorder. Every application restart
 * creates a fresh renderer page, so the callers reinstall it after each
 * relaunch and read it back before the next restart.
 */
async function installAgentEventRecorder(state, sessionId) {
  const installed = await state.cdp.evaluate(`(() => {
    window.__E2E_AGENT_EVENTS__ = [];
    window.__E2E_SESSION__ = ${JSON.stringify(sessionId)};
    const bridge = window.piDesktop;
    const channel = bridge?.channels?.event?.agentMessage;
    if (bridge?.on && channel) {
      bridge.on(channel, (envelope) => {
        try {
          window.__E2E_AGENT_EVENTS__.push({
            sessionId: envelope?.sessionId ?? "",
            turnId: envelope?.turnId ?? "",
            type: envelope?.event?.type ?? "",
            ts: envelope?.ts ?? 0,
          });
        } catch {
          // Recording must never affect the app under test.
        }
      });
    }
    return Boolean(channel);
  })()`);
  assert(installed === true, "the renderer has no agentMessage channel to record");
  return installed;
}

/**
 * The agent envelopes the renderer recorded (session id, live turn id, type).
 * The page-global recorder does not survive an application restart, so the
 * callers snapshot it before every restart.
 */
async function readUiAgentEvents(state) {
  return JSON.parse(
    await state.cdp.evaluate(`JSON.stringify(window.__E2E_AGENT_EVENTS__ ?? [])`),
  );
}

/** One named UI snapshot plus the provider/request counters at that moment. */
async function captureStep(state, name, extra = {}) {
  const step = {
    name,
    at: new Date().toISOString(),
    providerRequests: state.provider.requests.length,
    ui: await inspectUi(state),
    ...extra,
  };
  state.evidence.steps.push(step);
  return step;
}

/**
 * The user bubbles the transcript actually renders, with their row ids.
 *
 * The rendered rows are the user-visible surface, so counting them is the
 * honest check for "one row per submission": the renderer paints a bubble per
 * transcript row, and this reads the very ids it keyed them by.
 */
async function transcriptUserRows(state) {
  // `textContent`, not `innerText`: message rows use `content-visibility: auto`,
  // so a row scrolled out of the viewport renders no text and would read as an
  // empty string even though the transcript holds it.
  return state.cdp.evaluate(`(() => {
    const rows = [...document.querySelectorAll("[data-row-role='user'][data-message-id]")];
    return rows.map((node) => ({
      id: node.getAttribute("data-message-id"),
      // Long enough to keep the whole approved-plan instruction: its marker
      // (the execution marker inside the plan markdown) sits past 400 chars.
      text: (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 4000),
    }));
  })()`);
}

/**
 * The rendered transcript's structure by role: the assistant turns and tool
 * rows a recovered panel must show before the user sends anything new.
 */
async function transcriptRoleCounts(state) {
  return state.cdp.evaluate(`(() => ({
    userRows: document.querySelectorAll("[data-row-role='user'][data-message-id]").length,
    assistantTurns: document.querySelectorAll("[data-row-role='assistant']").length,
    toolRows: document.querySelectorAll(".tool-row[data-message-id]").length,
    // A collapsed process group still renders its header; the tool rows inside
    // may be hidden by the disclosure, so both are counted.
    processSections: document.querySelectorAll(".turn-process").length,
    assistantMessages: document.querySelectorAll("[data-row-role='assistant'] [data-message-id]").length,
  }))()`);
}

/** Which E2E markers the given user rows carry (each prompt starts with one). */
function markerOf(text) {
  for (const marker of [M1, M2, M3, M4, M5, M6, EXEC1, EXEC2, EXEC3, EXEC4, AFTER_RESTART, TWICE]) {
    if (text.includes(marker)) return marker;
  }
  return text.slice(0, 60);
}

/**
 * The promises a rendered transcript makes regardless of how much of it is
 * mounted: no prompt appears twice, and a row that is present in both captures
 * keeps the same id (a reselect or a durable read never re-keys a message).
 *
 * `assertTranscriptStable(before, after, label, requiredTexts)` also requires
 * every text in `requiredTexts` to be present, so an empty or truncated window
 * cannot make the comparison vacuous.
 */
function assertTranscriptStable(beforeRows, afterRows, label, requiredTexts = []) {
  for (const [stage, rows] of [["before", beforeRows], ["after", afterRows]]) {
    const duplicates = rows
      .map((row) => row.text)
      .filter((text, index) => rows.findIndex((row) => row.text === text) !== index);
    assert(
      duplicates.length === 0,
      `${label}: a prompt rendered twice in the ${stage} capture: ${jsonText(duplicates.map((text) => text.slice(0, 60)))}`,
    );
  }
  const idByText = new Map(beforeRows.map((row) => [row.text, row.id]));
  const overlap = afterRows.filter((row) => idByText.has(row.text));
  // A live row becoming its durable entry row is the intended re-key (the
  // runtime's live frames carry no entry id); a durable row changing its
  // durable id is not — entry ids are stable across reads.
  const rekeyed = overlap.filter((row) => {
    const beforeId = idByText.get(row.text);
    return beforeId.includes(":entry:") && row.id.includes(":entry:") && beforeId !== row.id;
  });
  assert(
    rekeyed.length === 0,
    `${label}: a durable message changed its entry id: ${jsonText(
      rekeyed.map((row) => [row.text.slice(0, 40), idByText.get(row.text), row.id]),
    )}`,
  );
  for (const text of requiredTexts) {
    assert(
      afterRows.some((row) => row.text.includes(text)),
      `${label}: the recovered transcript does not show ${text}: ${jsonText(afterRows.map((row) => [row.id, markerOf(row.text)]))}`,
    );
  }
  return overlap.length;
}

/**
 * A panel that read its transcript from storage renders durable rows only.
 *
 * This is the difference between showing history and showing whatever the
 * renderer happened to keep in memory: an id minted from a live frame means the
 * row never came from the native transcript.
 */
function assertDurableRows(rows, label) {
  const live = rows.filter((row) => !row.id.includes(":entry:"));
  assert(
    live.length === 0,
    `${label}: the rendered transcript still shows live rows: ${jsonText(live.map((row) => [row.id, markerOf(row.text)]))}`,
  );
}

/**
 * Wait until the rendered user rows satisfy a predicate.
 *
 * A recovered panel reads its transcript asynchronously — and, for an OMP
 * session with no live runtime, by starting a read-only runtime — so the rows
 * appear seconds after the session becomes active. Asserting before they land
 * would test the loading state, not the history.
 */
async function waitForUserRows(state, predicate, label, timeoutMs = WAIT_TIMEOUT_MS) {
  return waitFor(
    async () => {
      const rows = await transcriptUserRows(state);
      return predicate(rows) ? rows : null;
    },
    label,
    state,
    timeoutMs,
  );
}

/** How many rendered user rows carry this submission (the whole prompt text). */
function countUserRows(rows, text) {
  return rows.filter((row) => row.text.includes(text)).length;
}

function writeRawEvidence(state) {
  const evidence = state.evidence;
  evidence.generatedAt = new Date().toISOString();
  evidence.runtime = {
    patchedTree: state.patchedTree,
    launcher: state.patchedLauncher,
    launcherSha256: existsSync(state.patchedLauncher) ? sha256File(state.patchedLauncher) : null,
    ...(state.runtimeProvenance ?? {}),
  };
  evidence.provider = {
    baseUrl: state.provider.baseUrl,
    requestCount: state.provider.requests.length,
    requests: state.provider.requests.map((entry, index) => ({
      seq: index,
      method: entry.method,
      url: entry.url,
      at: entry.at,
      body: entry.body,
    })),
  };
  evidence.processes = { reports: state.processReports };
  evidence.console = state.consoleDiagnostics;
  evidence.electronOutputTail = state.electronOutput ? shortText(state.electronOutput, 8_000) : "";
  evidence.cleanup = state.cleanupReport;
  evidence.result = {
    summary: summarizeResults(),
    results: [...results.values()],
    primaryError: state.primaryError ? errorText(state.primaryError) : null,
  };
  const path = join(state.artifactDir, "omp-plan-ui-raw.json");
  writeFileSync(path, `${JSON.stringify(sanitizeValue(evidence), null, 2)}\n`);
  console.log(`EVIDENCE ${path}`);
  return path;
}

function summarizeResults() {
  const failed = [...results.values()].filter((result) => !result.ok);
  return `${results.size - failed.length} passed, ${failed.length} failed`;
}

/* ------------------------------------------------------------------------- */
/* Acceptance flow                                                             */
/* ------------------------------------------------------------------------- */

async function launchApp(state) {
  state.cdpPort = await allocatePort();
  state.cdpError = null;
  startElectron(state);
  await connectRenderer(state);
  await waitForRendererReady(state);
  state.evidence.launches.push({
    at: new Date().toISOString(),
    electronPid: state.electron?.pid ?? null,
    cdpPort: state.cdpPort,
  });
}

/** Create the local provider and one OMP session, then reveal it in the UI. */
async function seedSession(state, { title, marker }) {
  const provider = state.provider;
  const createdProvider = await getPreloadResult(state, "providersCreate", [
    {
      name: `OMP UI fake provider ${marker}`,
      vendorKey: "custom",
      type: "openai_compatible",
      protocol: "openai_compatible",
      baseUrl: provider.baseUrl,
      authKind: "api_key_and_base_url",
      defaultModelId: "local-model",
      secretValue: "e2e-fake-key",
      apiStyle: "chat_completions",
    },
  ]);
  const providerId = createdProvider?.provider?.id;
  assert(providerId, `fake provider creation returned no id: ${jsonText(createdProvider)}`);
  const created = await getPreloadResult(state, "sessionCreate", [
    {
      title,
      mode: "agent",
      engine: "omp",
      projectPath: state.workspace,
      providerId,
      modelId: "local-model",
    },
  ]);
  const session = created?.session;
  assert(session?.id, `OMP session creation returned no id: ${jsonText(created)}`);
  assert(session.engine === "omp", `session is not OMP: ${jsonText(session)}`);
  await reloadRenderer(state);
  await selectSession(state, session.id);
  return session;
}

/** Script answers by marker in the newest user message. */
function scriptProvider(provider, state) {
  const autoLog = join(state.workspace, "auto-exec.log");
  const holdLog = join(state.workspace, "held-exec.log");
  state.autoLog = autoLog;
  state.holdLog = holdLog;
  const writeMarker = (path, content) => ({
    toolCalls: [{ name: "write", args: { path, content } }],
    finish: "tool_calls",
  });
  const bash = (command) => ({
    toolCalls: [{ name: "bash", args: { command } }],
    finish: "tool_calls",
  });
  provider.routeBySession({
    parent: [{ text: "no scripted route", finish: "stop" }],
    subagents: [
      // Exec prompts must be matched before their own submission markers.
      // The pinned runtime's shell is brush-core: a bare `sleep` would be a
      // builtin inside the runtime process, not a child process. The absolute
      // path forces a real external process, which is the live identity the
      // harness holds across the restart.
      { marker: EXEC4, turns: [bash(`printf 'held-run\\n' >> ${shellQuote(holdLog)}`), bash("/bin/sleep 600"), { text: "hold released", finish: "stop" }] },
      { marker: EXEC3, turns: [bash(`printf 'auto-bash-one\\n' >> ${shellQuote(autoLog)}`), bash(`printf 'auto-bash-two\\n' >> ${shellQuote(autoLog)}`), { text: "auto execution done", finish: "stop" }] },
      { marker: EXEC2, turns: [writeMarker("marker-two.txt", "two\n"), { text: "execution two done", finish: "stop" }] },
      { marker: EXEC1, turns: [writeMarker("marker-one.txt", "one\n"), { text: "execution one done", finish: "stop" }] },
      { marker: AFTER_RESTART, turns: [{ text: "post-restart agent turn", finish: "stop" }] },
      {
        marker: TWICE,
        // Two identical submissions, two answers: the second prompt must reach
        // the provider (nothing was swallowed as a duplicate).
        turns: [
          { text: "first same-text answer", finish: "stop" },
          { text: "second same-text answer", finish: "stop" },
        ],
      },
      {
        marker: M6,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan six",
                  markdown: `# E2E plan six\n\nHold a real execution across a restart.\n\n${EXEC4}\n`,
                  question: "Approve plan six?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
      {
        marker: M5,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan five",
                  markdown: `# E2E plan five\n\nRun two high-risk bash commands.\n\n${EXEC3}\n`,
                  question: "Approve plan five?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
      {
        marker: M4,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan four",
                  markdown: "# E2E plan four\n\nPending across a restart.\n",
                  question: "Approve plan four?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
      {
        marker: M3,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan three",
                  markdown: `# E2E plan three\n\nWrite marker two.\n\n${EXEC2}\n`,
                  question: "Approve plan three?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
      {
        marker: M2,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan two",
                  markdown: `# E2E plan two\n\nWrite marker one.\n\n${EXEC1}\n`,
                  question: "Approve plan two?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
      {
        marker: M1,
        turns: [
          {
            toolCalls: [
              {
                name: "SubmitPlan",
                args: {
                  title: "E2E plan one",
                  markdown: "# E2E plan one\n\nDraft only; this one is rejected.\n",
                  question: "Approve plan one?",
                },
              },
            ],
            finish: "tool_calls",
          },
        ],
      },
    ],
  });
}

async function main() {
  const appDirInfo = resolveElectronBinary(repositoryRoot());
  const hostBinary = resolveHostBinary();
  const patchedLauncher = process.env.PI_DESKTOP_E2E_PATCHED_TREE
    ? join(
        resolve(process.env.PI_DESKTOP_E2E_PATCHED_TREE),
        "packages",
        "coding-agent",
        "scripts",
        "omp",
      )
    : null;
  const prepared = patchedLauncher
    ? null
    : await preparePatchedTree({ prepareBuild: true, keep: true });
  const launcher = patchedLauncher ?? join(prepared.tree, "packages", "coding-agent", "scripts", "omp");
  if (!existsSync(launcher)) throw new Error(`patched launcher missing: ${launcher}`);
  const patchedTree = patchedLauncher
    ? resolve(process.env.PI_DESKTOP_E2E_PATCHED_TREE)
    : prepared.tree;
  // The runtime build identity every run must carry: the controlled manifest
  // it was patched from and a `--version` probe executed in an isolated HOME,
  // so no probe can read or write the user's configuration.
  const runtimeProvenance = (() => {
    const probeHome = mkdtempSync(join(tmpdir(), "omp-plan-ui-probe-"));
    try {
      const { manifest, patchPath } = loadManifest();
      const probe = spawnSync(launcher, ["--version"], {
        env: isolatedEnv(probeHome),
        cwd: probeHome,
        encoding: "utf8",
        timeout: 60_000,
      });
      return {
        manifest: {
          base: manifest.base ?? null,
          patchLevel: manifest.patchLevel ?? null,
          fork: manifest.fork ?? null,
        },
        patch: patchPath
          ? { path: patchPath, sizeBytes: statSync(patchPath).size, sha256: sha256File(patchPath) }
          : null,
        versionProbe: {
          command: `${launcher} --version`,
          isolatedHome: probeHome,
          exitCode: probe.status,
          stdout: (probe.stdout ?? "").trim(),
          stderrTail: (probe.stderr ?? "").trim().slice(-500),
          timedOut: probe.error?.code === "ETIMEDOUT" || false,
        },
      };
    } catch (error) {
      return { error: errorText(error) };
    } finally {
      rmSync(probeHome, { recursive: true, force: true });
    }
  })();

  const provider = await FakeProvider.start();

  const state = {
    appDir: appDirInfo.appDir,
    electronBinary: appDirInfo.electronBinary,
    hostBinary,
    patchedLauncher: launcher,
    patchedTree,
    runtimeProvenance,
    provider,
    tempRoot: realpathSync(mkdtempSync(join(tmpdir(), `omp-plan-ui-${process.pid}-`))),
    dataDir: null,
    profileDir: null,
    workspace: null,
    artifactDir: null,
    homeDirs: null,
    cdpPort: null,
    electron: null,
    electronStartedAt: null,
    cdp: null,
    screenshots: [],
    consoleDiagnostics: [],
    electronOutput: "",
    cdpError: null,
    stopping: false,
    primaryError: null,
    processReports: [],
    cleanupReport: null,
    evidence: {
      schemaVersion: 1,
      harness: {
        script: "app/scripts/e2e-omp-plan-ui.mjs",
        pid: process.pid,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      isolation: {
        tempRoot: null,
        home: null,
        xdg: null,
        childEnv: null,
      },
      runtime: null,
      provider: null,
      launches: [],
      steps: [],
      artifacts: [],
      uiAgentEvents: {},
      durable: {},
      scenarios: {},
      processes: null,
      console: [],
      cleanup: null,
      result: null,
    },
  };
  state.dataDir = join(state.tempRoot, "data");
  state.profileDir = join(state.tempRoot, "profile");
  state.workspace = join(state.tempRoot, "workspace");
  scriptProvider(provider, state);
  await Promise.all([
    mkdirSync(state.dataDir, { recursive: true }),
    mkdirSync(state.profileDir, { recursive: true }),
    mkdirSync(state.workspace, { recursive: true }),
  ]);
  const callerArtifactDir = process.env.PI_DESKTOP_E2E_ARTIFACT_DIR?.trim();
  state.artifactDir = callerArtifactDir ? resolve(callerArtifactDir) : join(state.tempRoot, "artifacts");
  mkdirSync(state.artifactDir, { recursive: true });
  const homeDirs = prepareIsolatedHome(state);
  state.evidence.isolation = {
    tempRoot: state.tempRoot,
    home: homeDirs.home,
    xdg: {
      configHome: homeDirs.config,
      dataHome: homeDirs.data,
      stateHome: homeDirs.state,
      cacheHome: homeDirs.cache,
      tmpdir: homeDirs.tmp,
    },
    childEnv: sanitizeValue(childEnvironment(state)),
    toolchainLinks: state.toolchainLinks,
    note: "the child environment is built from scratch; only DISPLAY/XAUTHORITY and the absolute Node/Bun/system PATHs come from the caller",
  };
  console.log(`Temp data ${state.dataDir}`);
  console.log(`Temp profile ${state.profileDir}`);
  console.log(`Temp workspace ${state.workspace}`);
  console.log(`Temp HOME ${homeDirs.home}`);
  console.log(`Artifacts ${state.artifactDir}`);
  console.log(`Patched runtime ${launcher}`);

  const cleanup = [];
  try {
    await launchApp(state);
    const detail = await runAcceptance(state);
    record("E2E-OMP-PLAN-UI", true, detail);
  } catch (error) {
    state.primaryError = error instanceof Error ? error : new Error(String(error));
    console.error(`FATAL ${state.primaryError.message}`);
    if (state.electronOutput) {
      console.error(`ELECTRON OUTPUT\n${shortText(state.electronOutput, 4_000)}`);
    }
    if (state.cdp && !state.cdp.closed) {
      try {
        await captureScreenshot(state, "omp-plan-ui-failure");
      } catch (screenshotError) {
        console.error(`FAILURE SCREENSHOT unavailable: ${errorText(screenshotError)}`);
      }
    }
    record("E2E-OMP-PLAN-UI", false, state.primaryError.message);
  } finally {
    const cleanupErrors = [];
    try {
      state.stopping = true;
      await terminateOwnedApp(state, "final");
    } catch (error) {
      cleanupErrors.push(error);
      console.error(`FAIL final process reclamation: ${errorText(error)}`);
    }
    try {
      await provider.close();
    } catch (error) {
      cleanupErrors.push(error);
      console.error(`FAIL provider close: ${errorText(error)}`);
    }
    for (const entry of cleanup.reverse()) {
      try {
        await entry();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (prepared?.cleanup) {
      try {
        await prepared.cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const surviving = state.processReports
      .filter((report) => report.ok === false && Array.isArray(report.leftover) && report.leftover.length > 0)
      .flatMap((report) => report.leftover.map((entry) => `${entry.pid}:${entry.comm}`));
    const mayRemoveScratch = surviving.length === 0;
    let scratchRemoved = false;
    if (mayRemoveScratch) {
      try {
        rmSync(state.tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        scratchRemoved = !existsSync(state.tempRoot);
        if (!scratchRemoved) {
          cleanupErrors.push(new Error(`scratch root survived rmSync: ${state.tempRoot}`));
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    } else {
      console.error(`FAIL scratch root kept for diagnosis; surviving owned processes: ${surviving.join(", ")}`);
    }
    state.cleanupReport = {
      at: new Date().toISOString(),
      scratchRoot: state.tempRoot,
      scratchRemoved,
      survivingOwnedProcesses: surviving,
      errors: cleanupErrors.map((error) => errorText(error)),
      processReports: state.processReports,
    };
    state.evidence.cleanup = state.cleanupReport;
    console.log(
      `CLEANUP scratchRemoved=${scratchRemoved} survivingOwnedProcesses=${surviving.length} errors=${cleanupErrors.length}`,
    );
    for (const error of cleanupErrors) {
      console.error(`FAIL cleanup: ${errorText(error)}`);
      state.primaryError ||= error instanceof Error ? error : new Error(String(error));
    }
    try {
      writeRawEvidence(state);
    } catch (error) {
      console.error(`FAIL raw evidence write: ${errorText(error)}`);
      state.primaryError ||= error instanceof Error ? error : new Error(String(error));
    }
  }

  if (state.consoleDiagnostics.length > 0) {
    console.log(`CONSOLE ${state.consoleDiagnostics.length} diagnostic(s)`);
    for (const entry of state.consoleDiagnostics.slice(0, 20)) {
      console.log(`  [${entry.level}] ${shortText(entry.text, 300)}`);
    }
  }
  if (state.screenshots.length > 0) {
    console.log("SCREENSHOTS");
    for (const path of state.screenshots) console.log(path);
  }
  console.log(`SUMMARY ${summarizeResults()}`);
  if (state.primaryError || [...results.values()].some((result) => !result.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`FATAL ${errorText(error)}`);
  console.log("SUMMARY 0 passed, 1 failed");
  process.exitCode = 1;
});

export { runAcceptance };

/* ------------------------------------------------------------------------- */
/* Acceptance flow (exported for readability; the harness above owns the env) */
/* ------------------------------------------------------------------------- */

async function runAcceptance(state) {
  const { provider } = state;

  // 1. Real OMP session through the real preload/Main/host boundary.
  const session = await seedSession(state, { title: "OMP plan UI acceptance", marker: M1 });
  const sessionId = session.id;
  // Record every agent event the renderer receives (installed after the seed
  // reload, which would drop a page-global recorder), so the acceptance can
  // reconstruct the terminal sequence without a second fixture.
  await installAgentEventRecorder(state, sessionId);
  const providerRequestsAtBoot = provider.requests.length;

  const before = await inspectUi(state);
  assert(before.modeChip?.visible === true, `mode chip is not visible: ${jsonText(before.modeChip)}`);
  assert(before.modeChip.dataMode === "agent", `session did not start in Agent: ${jsonText(before.modeChip)}`);
  assert(before.modeChip.disabled === false, "mode chip is disabled on a live OMP session");

  // 2. Switch to Plan with the real chip.
  await switchMode(state, "plan");
  const planSession = await getSession(state, sessionId);
  assert(planSession.mode === "plan", `mode chip did not persist Plan: ${jsonText(planSession)}`);
  const planRow = queryOne(state, "SELECT mode FROM sessions WHERE id = ?", sessionId);
  assert(planRow?.mode === "plan", `durable session row is not Plan: ${jsonText(planRow)}`);
  await captureScreenshot(state, "omp-plan-ui-01-plan-mode");

  // 3. First submission: the model produces a real proposal.
  await fillComposer(state, `${M1}: draft the first plan, do not execute anything.`);
  const pendingOne = await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.approval?.status === "pending" ? snapshot : null;
    },
    "real pending Plan approval card",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(pendingOne.approval.kind === "plan", `proposal kind is not plan: ${jsonText(pendingOne.approval)}`);
  assert(
    pendingOne.approval.title.includes("E2E plan one"),
    `approval card title did not come from the model: ${jsonText(pendingOne.approval.title)}`,
  );
  assert(pendingOne.promptReadOnly === true, "composer is editable while an approval is pending");
  await captureScreenshot(state, "omp-plan-ui-02-pending");

  const proposalOne = await getPendingPlan(state, sessionId);
  assert(proposalOne, "no durable pending proposal after the card appeared");
  assert(
    proposalOne.question === "Approve plan one?" && proposalOne.markdown.includes("Draft only"),
    `the durable proposal is not the model's submission: ${jsonText({ question: proposalOne.question, markdown: proposalOne.markdown })}`,
  );
  const artifactOne = join(state.workspace, proposalOne.artifact.relativePath);
  assert(existsSync(artifactOne), `artifact one was not published: ${artifactOne}`);
  const artifactOneBytes = readFileSync(artifactOne);
  const artifactOneSha = createHash("sha256").update(artifactOneBytes).digest("hex");
  assert(artifactOneSha === proposalOne.artifact.sha256, "artifact one sha does not match its durable row");
  assert(artifactOneBytes.length === proposalOne.artifact.sizeBytes, "artifact one size does not match its durable row");
  state.evidence.scenarios.planOne = {
    proposal: proposalRow(state, proposalOne.id),
    artifact: { relativePath: proposalOne.artifact.relativePath, ...fileFacts(artifactOne) },
  };

  // The model request really carried the Plan mode block and the contract
  // catalogue (SubmitPlan present, write/edit absent).
  const planRequests = provider.requests.slice(providerRequestsAtBoot);
  assert(planRequests.length > 0, "the plan submission never reached the fake provider");
  const planRequest = planRequests[planRequests.length - 1];
  const planSystem = (planRequest.body?.messages ?? [])
    .filter((message) => message.role === "system")
    .map((message) => (typeof message.content === "string" ? message.content : JSON.stringify(message.content)))
    .join("\n");
  assert(planSystem.includes("Plan mode"), "the plan turn's system prompt has no Plan mode block");
  assert(planRequest.body?.tools?.some?.((tool) => JSON.stringify(tool).includes("SubmitPlan")), "plan turn has no SubmitPlan tool");

  // 4. Reject, edit, resubmit: new proposal, new artifact, old bytes intact.
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-reject', "Plan Reject");
  await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.approval === null && snapshot.promptReadOnly === false ? snapshot : null;
    },
    "rejected proposal cleared and composer editable",
    state,
  );
  const afterReject = await inspectUi(state);
  // The submit turn really ended in the renderer: its terminal envelope must
  // have arrived, or the composer would treat the session as running and queue
  // the resubmission behind a phantom turn instead of sending it.
  const recordedTypes = JSON.parse(
    await state.cdp.evaluate(
      `JSON.stringify((window.__E2E_AGENT_EVENTS__ ?? [])
        .filter((entry) => entry.sessionId === ${JSON.stringify(sessionId)})
        .map((entry) => entry.type))`,
    ),
  );
  assert(
    recordedTypes.includes("agent_end"),
    `the renderer never saw the submit turn's terminal event: ${jsonText(recordedTypes)}`,
  );
  assert(afterReject.promptReadOnly === false, "composer is not editable after rejection");
  assert(afterReject.stopVisible === false, "the renderer still shows a running turn after rejection");
  const agentStatus = await state.cdp.evaluate(`(async () => {
    const bridge = window.piDesktop;
    const result = await bridge.invoke(bridge.channels.invoke.agentGetStatus, ${JSON.stringify(sessionId)});
    return JSON.stringify(result?.data ?? result);
  })()`);
  const agentStatusState = JSON.parse(agentStatus)?.status ?? JSON.parse(agentStatus);
  assert(agentStatusState?.isRunning === false, `main still reports running: ${shortText(agentStatus, 300)}`);
  await fillComposer(state, `${M2}: revised plan, still no execution.`);
  const pendingTwo = await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.approval?.status === "pending" ? snapshot : null;
    },
    "second pending Plan approval card",
    state,
    60_000,
  );
  assert(
    pendingTwo.approval.title.includes("E2E plan two"),
    `second approval card title did not come from the model: ${jsonText(pendingTwo.approval.title)}`,
  );
  const proposalTwo = await getPendingPlan(state, sessionId);
  assert(proposalTwo && proposalTwo.id !== proposalOne.id, "resubmission reused the first proposal");
  assert(
    proposalTwo.question === "Approve plan two?" && proposalTwo.markdown.includes("E2E-EXEC-ONE"),
    `the revised durable proposal is not the model's: ${jsonText({ question: proposalTwo.question })}`,
  );
  const artifactTwo = join(state.workspace, proposalTwo.artifact.relativePath);
  assert(artifactTwo !== artifactOne, "resubmission reused the first artifact path");
  assert(existsSync(artifactTwo), "artifact two was not published");
  assert(
    readFileSync(artifactOne).equals(artifactOneBytes),
    "the rejected proposal's artifact bytes changed",
  );
  const rejectedRow = queryOne(
    state,
    "SELECT status, artifact_sha256 FROM plan_approvals WHERE request_id = ?",
    proposalOne.id,
  );
  assert(rejectedRow?.status === "rejected", `first proposal is not rejected: ${jsonText(rejectedRow)}`);
  state.evidence.scenarios.planTwo = {
    rejectedProposal: proposalRow(state, proposalOne.id),
    proposal: proposalRow(state, proposalTwo.id),
    artifact: { relativePath: proposalTwo.artifact.relativePath, ...fileFacts(artifactTwo) },
  };

  // The pending approval belongs to this session only: an unrelated session
  // must not inherit the card, and returning to the session restores it.
  const other = await getPreloadResult(state, "sessionCreate", [
    { title: "OMP unrelated session", mode: "agent", engine: "omp", projectPath: state.workspace },
  ]);
  const otherId = other?.session?.id;
  assert(otherId && otherId !== sessionId, `unrelated session creation failed: ${jsonText(other)}`);
  await reloadRenderer(state);
  await selectSession(state, otherId);
  const otherView = await inspectUi(state);
  assert(otherView.approval === null, `pending approval leaked into another session: ${jsonText(otherView.approval)}`);
  assert(otherView.modeChip?.dataMode === "agent", "unrelated session is not in Agent mode");
  await selectSession(state, sessionId);
  // The reload above replaced the page; reinstall the recorder so the live
  // turn ids of the following cycles are captured for the raw evidence.
  await installAgentEventRecorder(state, sessionId);
  await waitFor(
    async () => ((await inspectUi(state)).approval?.status === "pending" ? true : null),
    "pending approval returns when its own session is reselected",
    state,
  );
  const unrelatedRows = queryOne(
    state,
    "SELECT COUNT(*) AS n FROM plan_approvals WHERE session_id = ?",
    otherId,
  );
  assert(unrelatedRows?.n === 0, `unrelated session gained approval rows: ${jsonText(unrelatedRows)}`);
  await captureScreenshot(state, "omp-plan-ui-03-resubmitted");

  // 5. Approve with `ask` and execute: the real write tool raises a real
  // permission card, and allowing it once runs the tool for real.
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-main', "Plan Approve (ask)");
  const permissionCard = await waitFor(
    async () => {
      const snapshot = await inspectUi(state);
      return snapshot.permission ? snapshot : null;
    },
    "real tool permission card for the approved plan's write",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(
    JSON.stringify(permissionCard.permission).toLowerCase().includes("write") ||
      JSON.stringify(permissionCard.permission).includes("write"),
    `permission card is not for write: ${jsonText(permissionCard.permission)}`,
  );
  await captureScreenshot(state, "omp-plan-ui-04-permission");
  await clickSelector(state, ".permission-card-actions button:last-child", "Allow once");
  const markerOne = join(state.workspace, "marker-one.txt");
  await waitFor(() => existsSync(markerOne), "approved execution wrote marker one", state, TURN_TIMEOUT_MS);
  assert(readFileSync(markerOne, "utf8") === "one\n", "marker one has the wrong content");
  const executionOne = await waitFor(
    async () => {
      const row = queryOne(
        state,
        "SELECT request_id, execution_id, status, execution_state, target_permission_mode FROM plan_approvals WHERE request_id = ?",
        proposalTwo.id,
      );
      return row?.execution_state === "completed" ? row : null;
    },
    "approved execution completed in the durable row",
    state,
    TURN_TIMEOUT_MS,
  );
  const statusOne = await getPreloadResult(state, "agentGetStatus", [sessionId]);
  const statusOneState = statusOne?.status ?? statusOne;
  assert(statusOneState?.isRunning === false, `session still reports running: ${jsonText(statusOne)}`);
  await waitFor(
    async () => (await inspectUi(state)).approval === null,
    "approval surface cleared after completion",
    state,
  );
  state.evidence.scenarios.ask = {
    proposal: proposalRow(state, proposalTwo.id),
    permissionCard: permissionCard.permission,
    execution: executionOne,
    marker: fileFacts(markerOne),
  };
  await captureScreenshot(state, "omp-plan-ui-05-executed");

  // 6. Second cycle: approve with `accept-edits`; the write needs no card.
  const afterFirstCycle = provider.requests.length;
  await switchMode(state, "plan");
  await fillComposer(state, `${M3}: second plan, accept-edits execution.`);
  await waitFor(
    async () => ((await inspectUi(state)).approval?.status === "pending" ? true : null),
    "third pending Plan approval card",
    state,
    TURN_TIMEOUT_MS,
  );
  const proposalThree = await getPendingPlan(state, sessionId);
  assert(proposalThree, "third proposal is not pending");
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-menu', "approval mode menu");
  await clickSelector(state, '[data-approval-mode="accept-edits"]', "approve with accept-edits");
  const markerTwo = join(state.workspace, "marker-two.txt");
  await waitFor(() => existsSync(markerTwo), "accept-edits execution wrote marker two", state, TURN_TIMEOUT_MS);
  const duringSecondCycle = await inspectUi(state);
  assert(
    duringSecondCycle.permission === null,
    `accept-edits execution raised a permission card: ${jsonText(duringSecondCycle.permission)}`,
  );
  const executionTwo = await waitFor(
    async () => {
      const row = queryOne(
        state,
        "SELECT request_id, execution_id, execution_state, target_permission_mode FROM plan_approvals WHERE request_id = ?",
        proposalThree.id,
      );
      return row?.execution_state === "completed" ? row : null;
    },
    "accept-edits execution completed",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(executionTwo.execution_state === "completed", "accept-edits execution did not complete");
  assert(executionTwo.execution_id, "accept-edits execution row has no execution id");
  assert(provider.requests.length > afterFirstCycle, "second cycle produced no provider request");
  state.evidence.scenarios.acceptEdits = {
    proposal: proposalRow(state, proposalThree.id),
    execution: executionTwo,
    marker: fileFacts(markerTwo),
  };
  await captureScreenshot(state, "omp-plan-ui-06-accept-edits");

  // 7. Third cycle: approve with `auto` through the real menu. `bash` is a
  // high-risk tool that `accept-edits` does not cover and `ask` cards; under
  // `auto` both calls must run with no card and their side effects must land.
  const requestsBeforeAuto = provider.requests.length;
  await switchMode(state, "plan");
  await fillComposer(state, `${M5}: third plan, auto execution with bash.`);
  await waitFor(
    async () => ((await inspectUi(state)).approval?.status === "pending" ? true : null),
    "fifth pending Plan approval card",
    state,
    TURN_TIMEOUT_MS,
  );
  const proposalFive = await getPendingPlan(state, sessionId);
  assert(proposalFive, "fifth proposal is not pending");
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-menu', "approval mode menu (auto)");
  await clickSelector(state, '[data-approval-mode="auto"]', "approve with auto");
  await waitFor(
    async () => {
      if (!existsSync(state.autoLog)) return null;
      const text = readFileSync(state.autoLog, "utf8");
      return text.includes("auto-bash-one") && text.includes("auto-bash-two") ? text : null;
    },
    "auto-approved bash calls wrote their side effects without a card",
    state,
    TURN_TIMEOUT_MS,
  );
  const autoUi = await inspectUi(state);
  assert(
    autoUi.permission === null,
    `auto execution raised a permission card: ${jsonText(autoUi.permission)}`,
  );
  const executionAuto = await waitFor(
    async () => {
      const row = queryOne(
        state,
        "SELECT request_id, execution_id, execution_state, target_permission_mode FROM plan_approvals WHERE request_id = ?",
        proposalFive.id,
      );
      return row?.execution_state === "completed" ? row : null;
    },
    "auto execution completed in the durable row",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(executionAuto.target_permission_mode === "auto", `auto execution mode is wrong: ${jsonText(executionAuto)}`);
  const autoSession = queryOne(state, "SELECT mode, permission_mode FROM sessions WHERE id = ?", sessionId);
  assert(
    autoSession?.mode === "agent" && autoSession.permission_mode === "auto",
    `the execution turn did not run under auto: ${jsonText(autoSession)}`,
  );
  const autoLogText = readFileSync(state.autoLog, "utf8");
  assert(
    autoLogText === "auto-bash-one\nauto-bash-two\n",
    `auto side-effect log is wrong: ${jsonText(autoLogText)}`,
  );
  assert(provider.requests.length > requestsBeforeAuto, "auto cycle produced no provider request");
  state.evidence.scenarios.auto = {
    proposal: proposalRow(state, proposalFive.id),
    execution: executionAuto,
    sessionAtExecution: autoSession,
    sideEffectLog: fileFacts(state.autoLog),
    sideEffectText: autoLogText,
    permissionCard: null,
  };
  state.evidence.uiAgentEvents.throughAuto = await readUiAgentEvents(state);
  await captureScreenshot(state, "omp-plan-ui-07-auto");

  // 8. Hold a real approved execution in `running` — a live OMP runtime
  // process group with a live `sleep` child — then restart the whole app.
  await switchMode(state, "plan");
  await fillComposer(state, `${M6}: fourth plan, held execution across a restart.`);
  await waitFor(
    async () => ((await inspectUi(state)).approval?.status === "pending" ? true : null),
    "sixth pending Plan approval card",
    state,
    TURN_TIMEOUT_MS,
  );
  const proposalSix = await getPendingPlan(state, sessionId);
  assert(proposalSix, "sixth proposal is not pending");
  await clickSelector(state, '[data-testid="plan-approval-bar"] .plan-approval-approve-menu', "approval mode menu (held)");
  await clickSelector(state, '[data-approval-mode="auto"]', "approve held execution with auto");
  await waitFor(
    async () => {
      if (!existsSync(state.holdLog)) return null;
      return readFileSync(state.holdLog, "utf8") === "held-run\n" ? true : null;
    },
    "held execution's first bash command landed",
    state,
    TURN_TIMEOUT_MS,
  );
  const executionHeld = await waitFor(
    async () => {
      const row = queryOne(
        state,
        "SELECT request_id, execution_id, execution_state, target_permission_mode FROM plan_approvals WHERE request_id = ?",
        proposalSix.id,
      );
      return row?.execution_state === "running" ? row : null;
    },
    "durable execution state is running",
    state,
    TURN_TIMEOUT_MS,
  );
  const runningTurn = queryOne(
    state,
    "SELECT id, status, provider_id, model_id FROM turns WHERE session_id = ? AND status = 'running'",
    sessionId,
  );
  assert(runningTurn?.id, `no durable running turn for the held execution: ${jsonText(runningTurn)}`);
  const held = await waitFor(
    async () => {
      const snapshot = ownedProcessSnapshot(state, [state.electron?.pid]);
      if (!snapshot.supported) return { snapshot, runtime: null, sleeper: null };
      const runtimeProcess = snapshot.processes.find((entry) =>
        entry.cmdline.includes(state.patchedLauncher),
      );
      const sleeper = snapshot.processes.find(
        (entry) => entry.comm === "sleep" || /(^|\/|\s)sleep\s+600$/.test(entry.cmdline),
      );
      return runtimeProcess && sleeper ? { snapshot, runtime: runtimeProcess, sleeper } : null;
    },
    "live OMP runtime holding a sleep child",
    state,
    30_000,
  );
  const heldUi = await inspectUi(state);
  assert(heldUi.permission === null, `held execution raised a permission card: ${jsonText(heldUi.permission)}`);
  assert(
    held.snapshot.supported,
    "the held-execution proof needs the Linux process table",
  );
  const sessionBeforeHeldRestart = queryOne(state, `SELECT ${SESSION_COLUMNS} FROM sessions WHERE id = ?`, sessionId);
  const requestsBeforeHeldRestart = provider.requests.length;
  state.evidence.scenarios.runningHold = {
    proposal: proposalRow(state, proposalSix.id),
    execution: executionHeld,
    runningTurn,
    session: sessionBeforeHeldRestart,
    processes: held.snapshot,
    runtimeProcess: held.runtime,
    sleepProcess: held.sleeper,
    providerRequests: requestsBeforeHeldRestart,
    sideEffectLog: fileFacts(state.holdLog),
  };
  // The transcript the UI has painted so far, captured before the restart so
  // the recovered panel can be compared with it (M5/T20-R2).
  const userRowsBeforeHeldRestart = await transcriptUserRows(state);
  assert(
    userRowsBeforeHeldRestart.length >= 4,
    `the live transcript must show the session's prompts before the restart: ${jsonText(userRowsBeforeHeldRestart)}`,
  );
  const nativeFilePath =
    queryOne(state, "SELECT native_session_path FROM sessions WHERE id = ?", sessionId)
      ?.native_session_path ?? null;
  await captureStep(state, "running-held", {
    scenario: "running-restart",
    executionId: executionHeld.execution_id,
    turnId: runningTurn.id,
  });
  state.evidence.uiAgentEvents.throughRunningHold = await readUiAgentEvents(state);
  await captureScreenshot(state, "omp-plan-ui-08-running-before-restart");

  const runningReclaim = await terminateOwnedApp(state, "running-restart");
  state.evidence.scenarios.runningHold.reclaim = runningReclaim;
  assert(runningReclaim.ok === true, `running-restart reclamation failed: ${jsonText(runningReclaim)}`);
  await launchApp(state);
  await selectSession(state, sessionId);
  await waitForRendererReady(state);
  await installAgentEventRecorder(state, sessionId);

  const interruptedHeld = queryOne(
    state,
    "SELECT request_id, status, execution_id, execution_state, error_code FROM plan_approvals WHERE request_id = ?",
    proposalSix.id,
  );
  assert(
    interruptedHeld?.execution_state === "interrupted",
    `held execution survived the restart as running: ${jsonText(interruptedHeld)}`,
  );
  assert(
    interruptedHeld.error_code === "PLAN_EXECUTION_INTERRUPTED",
    `held execution used the wrong interruption code: ${jsonText(interruptedHeld)}`,
  );
  const turnsAfterHeldRestart = queryAll(
    state,
    "SELECT id, status, error_code FROM turns WHERE session_id = ? AND id = ?",
    sessionId,
    runningTurn.id,
  );
  assert(
    turnsAfterHeldRestart.length === 1 && turnsAfterHeldRestart[0].status !== "running",
    `the durable turn survived the restart as running: ${jsonText(turnsAfterHeldRestart)}`,
  );
  assert(
    provider.requests.length === requestsBeforeHeldRestart,
    `the held-execution restart replayed provider traffic (${requestsBeforeHeldRestart} -> ${provider.requests.length})`,
  );
  assert(
    readFileSync(state.holdLog, "utf8") === "held-run\n",
    "the held execution's side-effect log was replayed or lost",
  );
  const heldRestartUi = await inspectUi(state);
  assert(
    heldRestartUi.approval === null || heldRestartUi.approval.status === "interrupted",
    `the held execution still offers a decision after restart: ${jsonText(heldRestartUi.approval)}`,
  );
  const interruptAudit = queryAll(
    state,
    "SELECT id, ts, kind, payload_json FROM audit_log WHERE session_id = ? AND kind = 'plan_execution_interrupted'",
    sessionId,
  );
  assert(
    interruptAudit.some((row) => String(row.payload_json).includes(String(executionHeld.execution_id))),
    `no plan_execution_interrupted audit row for the held execution: ${jsonText(interruptAudit)}`,
  );
  state.evidence.scenarios.runningRestart = {
    before: {
      providerRequests: requestsBeforeHeldRestart,
      execution: executionHeld,
      turn: runningTurn,
      sideEffectText: "held-run\n",
    },
    after: {
      proposal: interruptedHeld,
      turn: turnsAfterHeldRestart[0] ?? null,
      providerRequests: provider.requests.length,
      sideEffectText: readFileSync(state.holdLog, "utf8"),
      audit: interruptAudit,
    },
    reclaim: runningReclaim,
  };
  await captureScreenshot(state, "omp-plan-ui-09-running-after-restart");

  // R6: the recovered panel shows the pre-restart transcript *before* any new
  // prompt — the durable read, not a replay and not an empty session. The
  // resident provider request count is unchanged by the read (asserted above).
  const heldBeforeMarkers = userRowsBeforeHeldRestart.map((row) => markerOf(row.text));
  const newestPreRestartMarker = heldBeforeMarkers.at(-1);
  assert(
    heldBeforeMarkers.length > 0 && heldBeforeMarkers.every((marker) => marker.length > 0),
    `every rendered prompt must carry its marker before the restart: ${jsonText(heldBeforeMarkers)}`,
  );
  const userRowsAfterHeldRestart = await waitForUserRows(
    state,
    (rows) => rows.length > 0 && rows.some((row) => markerOf(row.text) === newestPreRestartMarker),
    `recovered transcript shows the pre-restart history (${newestPreRestartMarker})`,
    TURN_TIMEOUT_MS,
  );
  const heldRestartMarkers = userRowsAfterHeldRestart.map((row) => markerOf(row.text));
  // The pre-restart transcript is back, one row per submission, with every
  // overlapping row under its original id. The newest pre-restart prompt must
  // be visible, so a truncated or empty window cannot pass.
  const heldRestartOverlap = assertTranscriptStable(
    userRowsBeforeHeldRestart,
    userRowsAfterHeldRestart,
    "after the running restart",
    [userRowsBeforeHeldRestart.at(-1).text],
  );
  assert(heldRestartOverlap >= 1, "the recovered transcript must overlap the pre-restart transcript");
  assertDurableRows(userRowsAfterHeldRestart, "after the running restart");
  const nativeFactsAfterHeldRestart = nativeFilePath ? fileFacts(nativeFilePath) : null;
  // Assistant turns and tool rows produced before the restart are on screen
  // again, so the recovered panel is the transcript, not just the new turn.
  const heldRestartRoles = await transcriptRoleCounts(state);
  assert(
    heldRestartRoles.assistantMessages >= 2 &&
      (heldRestartRoles.toolRows >= 1 || heldRestartRoles.processSections >= 1),
    `the recovered transcript must render the durable assistant/tool history: ${jsonText(heldRestartRoles)}`,
  );
  state.evidence.scenarios.history = {
    beforeHeldRestart: userRowsBeforeHeldRestart,
    afterHeldRestart: userRowsAfterHeldRestart,
    afterHeldRestartMarkers: heldRestartMarkers,
    afterHeldRestartOverlap: heldRestartOverlap,
    afterHeldRestartRoles: heldRestartRoles,
    nativeTranscriptAfterHeldRestart: nativeFactsAfterHeldRestart,
  };

  // The recovered app must be usable: a fresh agent turn completes in the same
  // session and produces exactly one new provider request.
  const requestsBeforeRecoveryTurn = provider.requests.length;
  await fillComposer(state, `${AFTER_RESTART}: confirm the session still works.`);
  await waitFor(
    async () => ((await inspectUi(state)).bodyText.includes("post-restart agent turn") ? true : null),
    "post-restart agent turn reply rendered",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(
    provider.requests.length === requestsBeforeRecoveryTurn + 1,
    `the recovery turn produced ${provider.requests.length - requestsBeforeRecoveryTurn} provider requests`,
  );
  // R5: the prompt the user actually submitted appears exactly once. Before the
  // repair the panel showed it twice (the desktop's own echo plus the native
  // user frame), while the provider saw a single request.
  const recoveryText = `${AFTER_RESTART}: confirm the session still works.`;
  const rowsAfterRecovery = await transcriptUserRows(state);
  assert(
    countUserRows(rowsAfterRecovery, recoveryText) === 1,
    `the recovery prompt must render one bubble: ${jsonText(rowsAfterRecovery.filter((row) => row.text.includes(AFTER_RESTART)))}`,
  );
  assert(
    rowsAfterRecovery.filter((row) => markerOf(row.text) === AFTER_RESTART).length === 1,
    "the recovery prompt must appear once in the rendered transcript",
  );
  // No earlier prompt was duplicated by the recovery turn either.
  assertTranscriptStable(rowsAfterRecovery, rowsAfterRecovery, "after the recovery turn", [recoveryText]);
  state.evidence.scenarios.runningRestart.recovery = {
    providerRequests: provider.requests.length,
    providerRequestsDelta: provider.requests.length - requestsBeforeRecoveryTurn,
    ui: await inspectUi(state),
    userRows: rowsAfterRecovery,
  };
  await captureScreenshot(state, "omp-plan-ui-10-running-recovered");

  // 9. Leave a proposal pending, then restart the application once more.
  await switchMode(state, "plan");
  await fillComposer(state, `${M4}: plan four, left pending across a restart.`);
  await waitFor(
    async () => ((await inspectUi(state)).approval?.status === "pending" ? true : null),
    "seventh pending Plan approval card",
    state,
    TURN_TIMEOUT_MS,
  );
  const proposalFour = await getPendingPlan(state, sessionId);
  assert(proposalFour, "seventh proposal is not pending");
  const requestsBeforePendingRestart = provider.requests.length;
  await captureScreenshot(state, "omp-plan-ui-11-pending-before-restart");
  captureDurableState(state, "beforePendingRestart", sessionId);

  const pendingReclaim = await terminateOwnedApp(state, "pending-restart");
  state.evidence.scenarios.pendingRestart = { reclaim: pendingReclaim };
  await launchApp(state);
  await selectSession(state, sessionId);
  await installAgentEventRecorder(state, sessionId);
  state.evidence.uiAgentEvents.afterPendingRestart = await readUiAgentEvents(state);

  const interrupted = queryOne(
    state,
    "SELECT status, error_code FROM plan_approvals WHERE request_id = ?",
    proposalFour.id,
  );
  assert(interrupted?.status === "interrupted", `pending proposal survived restart: ${jsonText(interrupted)}`);
  assert(
    interrupted.error_code === "PLAN_APPROVAL_INTERRUPTED",
    `restart used the wrong interruption code: ${jsonText(interrupted)}`,
  );
  const restarted = await inspectUi(state);
  assert(
    restarted.approval === null || restarted.approval.status === "interrupted",
    `approval card still offers a decision after restart: ${jsonText(restarted.approval)}`,
  );
  const executionOneAfterRestart = queryOne(
    state,
    "SELECT execution_state FROM plan_approvals WHERE request_id = ?",
    proposalTwo.id,
  );
  assert(
    executionOneAfterRestart?.execution_state === "completed",
    `completed execution was rewritten by restart: ${jsonText(executionOneAfterRestart)}`,
  );
  const requestsAfterRestart = provider.requests.length;
  assert(
    requestsAfterRestart === requestsBeforePendingRestart,
    `restart replayed provider traffic (${requestsBeforePendingRestart} -> ${requestsAfterRestart})`,
  );
  state.evidence.scenarios.pendingRestart.before = {
    proposal: proposalRow(state, proposalFour.id),
    providerRequests: requestsBeforePendingRestart,
  };
  state.evidence.scenarios.pendingRestart.after = {
    proposal: interrupted,
    providerRequests: requestsAfterRestart,
    ui: restarted,
  };
  await captureScreenshot(state, "omp-plan-ui-12-after-pending-restart");

  // R6: the second restart also shows the transcript before any new prompt —
  // including the Plan prompt that was submitted just before the restart — and
  // every prompt remains exactly one bubble.
  const pendingRestartRows = await waitForUserRows(
    state,
    (rows) => rows.some((row) => markerOf(row.text) === M4),
    "recovered transcript shows the pre-restart Plan prompt",
    TURN_TIMEOUT_MS,
  );
  // The second restart re-read the same transcript: no row may be duplicated,
  // and every row that is in both captures keeps its id.
  assertTranscriptStable(userRowsAfterHeldRestart, pendingRestartRows, "after the pending restart", [
    pendingRestartRows.at(-1).text,
    recoveryText,
  ]);
  assertDurableRows(pendingRestartRows, "after the pending restart");
  const nativeFactsAfterPendingRestart = nativeFilePath ? fileFacts(nativeFilePath) : null;

  // Reselecting the session — through another session and back — must keep the
  // same rows with the same ids, and must not rewrite the native transcript.
  const reselectTarget = await getPreloadResult(state, "sessionCreate", [
    { title: "E2E reselect target", mode: "agent", engine: "pi", projectPath: state.workspace },
  ]);
  const reselectSessionId = reselectTarget?.session?.id;
  assert(reselectSessionId, `reselect target session creation returned no id: ${jsonText(reselectTarget)}`);
  await reloadRenderer(state);
  await selectSession(state, reselectSessionId);
  await selectSession(state, sessionId);
  await waitForRendererReady(state);
  const reselectedRows = await waitForUserRows(
    state,
    (rows) => rows.some((row) => markerOf(row.text) === M4),
    "reselect renders the durable transcript",
    TURN_TIMEOUT_MS,
  );
  state.evidence.scenarios.historyRows = { pendingRestart: pendingRestartRows, reselected: reselectedRows };
  // The reselect re-reads the session: every row stays a single row and the
  // overlapping rows keep their ids (the mounted window may grow or shrink, so
  // only the overlap is comparable). The pre-restart Plan prompt must be there.
  state.evidence.scenarios.historyRows = { pendingRestart: pendingRestartRows, reselected: reselectedRows };
  const reselectOverlap = assertTranscriptStable(
    pendingRestartRows,
    reselectedRows,
    "after a reselect",
    [pendingRestartRows.at(-1).text],
  );
  assert(reselectOverlap >= 1, "a reselect must overlap the transcript it replaces");
  assertDurableRows(reselectedRows, "after a reselect");
  const nativeFactsAfterReselect = nativeFilePath ? fileFacts(nativeFilePath) : null;
  if (nativeFilePath) {
    assert(
      nativeFactsAfterReselect.sha256 === nativeFactsAfterPendingRestart.sha256,
      `a history read/reselect must not rewrite the native transcript (${nativeFactsAfterPendingRestart.sha256} -> ${nativeFactsAfterReselect.sha256})`,
    );
  }

  // R5: two submissions with byte-identical text both survive, with distinct
  // ids, and both reach the provider.
  const requestsBeforeTwice = provider.requests.length;
  const twiceText = `${TWICE}: submit this exact text twice.`;
  await fillComposer(state, twiceText);
  await waitFor(
    async () => ((await inspectUi(state)).bodyText.includes("first same-text answer") ? true : null),
    "first identical submission answered",
    state,
    TURN_TIMEOUT_MS,
  );
  await fillComposer(state, twiceText);
  await waitFor(
    async () => ((await inspectUi(state)).bodyText.includes("second same-text answer") ? true : null),
    "second identical submission answered",
    state,
    TURN_TIMEOUT_MS,
  );
  assert(
    provider.requests.length === requestsBeforeTwice + 2,
    `the two identical submissions produced ${provider.requests.length - requestsBeforeTwice} provider requests`,
  );
  const twiceRows = await transcriptUserRows(state);
  const sameTextRows = twiceRows.filter((row) => row.text.includes(twiceText));
  assert(
    sameTextRows.length === 2,
    `two identical submissions must render two bubbles: ${jsonText(twiceRows.map((row) => [row.id, markerOf(row.text)]))}`,
  );
  assert(sameTextRows[0].id !== sameTextRows[1].id, "the two bubbles must have distinct ids");
  assert(
    twiceRows.filter((row) => markerOf(row.text) === TWICE).length === 2,
    "no identical submission may be swallowed",
  );

  // The same two rows survive another reselect — and the durable read replaces
  // the live rows by identity, never by matching text: exactly two rows remain
  // (never four), and they now carry the durable entry ids.
  await selectSession(state, reselectSessionId);
  await selectSession(state, sessionId);
  const twiceRowsAfterReselect = await waitForUserRows(
    state,
    (rows) => {
      const rowsForText = rows.filter((row) => row.text.includes(twiceText));
      return rowsForText.length === 2 && rowsForText.every((row) => row.id.includes(":entry:"));
    },
    "reselect replaces both identical live rows with their durable entry rows",
    TURN_TIMEOUT_MS,
  );
  const twiceRowsForText = twiceRowsAfterReselect.filter((row) => row.text.includes(twiceText));
  assert(
    twiceRowsForText.length === 2 && twiceRowsForText.every((row) => row.id.includes(":entry:")),
    `identical prompts must survive the merge as exactly two durable rows: ${jsonText(twiceRowsForText.map((row) => [row.id, markerOf(row.text)]))}`,
  );
  assert(
    twiceRowsForText[0].id !== twiceRowsForText[1].id,
    "the two durable rows must keep distinct ids",
  );
  // A second reselect keeps the same durable identity (entry ids are stable).
  await selectSession(state, reselectSessionId);
  await selectSession(state, sessionId);
  const twiceRowsAfterSecondReselect = await waitForUserRows(
    state,
    (rows) => rows.filter((row) => row.text.includes(twiceText) && row.id.includes(":entry:")).length === 2,
    "a second reselect keeps both durable rows",
    TURN_TIMEOUT_MS,
  );
  const twiceIdsAfterSecondReselect = twiceRowsAfterSecondReselect
    .filter((row) => row.text.includes(twiceText))
    .map((row) => row.id);
  assert(
    JSON.stringify(twiceIdsAfterSecondReselect) === JSON.stringify(twiceRowsForText.map((row) => row.id)),
    `identical prompts must keep their durable ids across reselects: ${jsonText({ before: twiceRowsForText.map((row) => row.id), after: twiceIdsAfterSecondReselect })}`,
  );
  state.evidence.scenarios.history.afterPendingRestart = pendingRestartRows;
  state.evidence.scenarios.history.afterReselect = reselectedRows;
  state.evidence.scenarios.history.nativeTranscriptAfterPendingRestart = nativeFactsAfterPendingRestart;
  state.evidence.scenarios.history.nativeTranscriptAfterReselect = nativeFactsAfterReselect;
  state.evidence.scenarios.history.identicalPrompts = {
    text: twiceText,
    rows: sameTextRows,
    rowsAfterReselect: twiceRowsForText,
    rowsAfterSecondReselect: twiceRowsAfterSecondReselect.filter((row) => row.text.includes(twiceText)),
    providerRequestsBefore: requestsBeforeTwice,
    providerRequestsAfter: provider.requests.length,
    reselectSessionId,
  };
  await captureScreenshot(state, "omp-plan-ui-13-history-reselect");
  await installAgentEventRecorder(state, sessionId);

  // The renderer received the submit turn's terminal events; record the full
  // identity sequence the UI saw (live turn ids included).
  state.evidence.uiAgentEvents.final = await readUiAgentEvents(state);
  captureDurableState(state, "final", sessionId);
  state.evidence.scenarios.session = {
    sessionId,
    native: queryOne(
      state,
      "SELECT engine, engine_adapter_version, engine_runtime_version, native_session_id, native_session_path FROM sessions WHERE id = ?",
      sessionId,
    ),
  };
  state.evidence.artifacts.push(
    ...[
      proposalRow(state, proposalOne.id),
      proposalRow(state, proposalTwo.id),
      proposalRow(state, proposalThree.id),
      proposalRow(state, proposalFive.id),
      proposalRow(state, proposalSix.id),
    ]
      .filter(Boolean)
      .map((row) => {
        const path = join(state.workspace, row.artifact_relative_path);
        return existsSync(path) ? { name: `plan-artifact-${row.request_id}`, ...fileFacts(path) } : null;
      })
      .filter(Boolean),
  );

  return [
    `session ${sessionId}`,
    `artifacts ${proposalOne.artifact.relativePath} -> ${proposalTwo.artifact.relativePath} -> ${proposalThree.artifact.relativePath} -> ${proposalFive.artifact.relativePath} -> ${proposalSix.artifact.relativePath}`,
    `executions ask=${executionOne.execution_id} accept-edits=${executionTwo.execution_id} auto=${executionAuto.execution_id} held=${executionHeld.execution_id} (interrupted after restart)`,
    `held turn ${runningTurn.id} interrupted; provider requests ${requestsAfterRestart}, no replay`,
  ].join("; ");
}
