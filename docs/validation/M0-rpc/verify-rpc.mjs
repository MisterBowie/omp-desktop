#!/usr/bin/env node
/**
 * Reproducible OMP protocol startup verification (M0), third rework.
 *
 * Hardened against the third-review findings:
 *   - run-root creation makes its parent directory first (clean worktree);
 *   - the whole protocol lifecycle runs inside one try/catch/finally, so the
 *     process tree is reaped on success, assertion failure, malformed data,
 *     stream error, timeout, and start failure alike;
 *   - cleanup reaps the whole process group, not just the direct child: after
 *     SIGTERM it waits for the group to empty and escalates to SIGKILL, and it
 *     reports failure when the group cannot be emptied;
 *   - resolved-path checks are an acceptance condition: required artifacts must
 *     exist and every isolation path must stay inside this run's scope, or the
 *     run exits non-zero;
 *   - every temporary directory this run creates (version probe + protocol run,
 *     including the isolated config root) is removed in a finally unless
 *     `--keep` is given.
 *
 * It never inherits `OMP_PROFILE`/`PI_PROFILE`/`XDG_*`/credential variables, and
 * each run uses a run-unique isolation scope. It only ever removes directories
 * it created itself.
 *
 * Usage:
 *   node verify-rpc.mjs            # real pinned-source RPC startup (no paid model)
 *   node verify-rpc.mjs --keep     # keep this run's isolation dirs for inspection
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve, basename, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

// ---------------------------------------------------------------------------
// 1. Pin the source entry
// ---------------------------------------------------------------------------

export function resolveRepoRoot() {
  return resolve(__dirname, "..", "..", "..");
}

/** The launcher inside the pinned upstream checkout (not the global link). */
export function findPinnedLauncher(repoRoot = resolveRepoRoot()) {
  return join(repoRoot, "upstream", "oh-my-pi", "packages", "coding-agent", "scripts", "omp");
}

export function readGitlinkSha(repoRoot = resolveRepoRoot()) {
  const r = spawnSync("git", ["ls-tree", "HEAD", "upstream/oh-my-pi"], { cwd: repoRoot, encoding: "utf8" });
  const m = /\b([0-9a-f]{40})\b/.exec(r.stdout ?? "");
  return m ? m[1] : null;
}

export function readSubmoduleSha(repoRoot = resolveRepoRoot()) {
  const r = spawnSync("git", ["-C", join(repoRoot, "upstream", "oh-my-pi"), "rev-parse", "HEAD"], { encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

export function readPinnedVersion(repoRoot = resolveRepoRoot()) {
  const pkg = join(repoRoot, "upstream", "oh-my-pi", "packages", "utils", "package.json");
  try {
    return JSON.parse(readFileSync(pkg, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify launcher present, submodule SHA == gitlink, and the launcher's
 * `--version` == the pinned `packages/utils/package.json` version. The version
 * probe uses its own throwaway directories, removed before returning.
 * Returns { ok, reason, gitlink, actual, pinnedVersion, reportedVersion }.
 */
export function verifyPinnedSource(repoRoot = resolveRepoRoot()) {
  const launcher = findPinnedLauncher(repoRoot);
  const gitlink = readGitlinkSha(repoRoot);
  const actual = readSubmoduleSha(repoRoot);
  const pinnedVersion = readPinnedVersion(repoRoot);
  const fail = (reason, reportedVersion = null) => ({ ok: false, reason, gitlink, actual, pinnedVersion, reportedVersion });

  if (!existsSync(launcher)) return fail(`pinned launcher missing: ${launcher}`);
  if (!gitlink) return fail("could not read gitlink SHA for upstream/oh-my-pi");
  if (gitlink !== actual) return fail(`submodule SHA mismatch: gitlink=${gitlink} actual=${actual}`);

  const probeRoot = mkdtempSync(join(tmpdir(), "omp-ver-"));
  const configDirName = makeConfigDirName();
  const { env } = buildIsolatedEnv({ repoRoot, runRoot: probeRoot, configDirName });
  try {
    const r = spawnSync(launcher, ["--version"], { env, encoding: "utf8", timeout: 30_000 });
    const reported = (r.stdout ?? "").trim();
    const reportedVersion = /^omp\/(.+)$/m.exec(reported)?.[1] ?? null;
    if (r.status !== 0 || reportedVersion !== pinnedVersion) {
      return fail(
        `runtime version mismatch: reported=${reportedVersion ?? `(exit ${r.status}, ${reported || r.stderr})`} pinned=${pinnedVersion}`,
        reportedVersion,
      );
    }
    return { ok: true, reason: "ok", gitlink, actual, pinnedVersion, reportedVersion };
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
    safeRmConfigRoot(join(env.HOME, configDirName));
  }
}

// ---------------------------------------------------------------------------
// 2. Controlled environment
// ---------------------------------------------------------------------------

/** Environment variable names that could steer OMP off the isolated dirs. */
const STEER_VARS = [
  "OMP_PROFILE", "PI_PROFILE",
  "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
  "PI_CODING_AGENT_SESSION_DIR",
];

/** Name patterns for credentials that must never reach the child. */
const CRED_RE = /(API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL|_AUTH|AWS_ACCESS|AWS_SECRET|AWS_SESSION|BEDROCK_|GEMINI_|GOOGLE_|OPENAI_|ANTHROPIC_|AZURE_|COHERE_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_|COPILOT_|CODEX_)/i;

/** A run-unique, home-relative config root name (never the user's `.omp`). */
export function makeConfigDirName() {
  return `.omp-m0-${randomBytes(4).toString("hex")}`;
}

/**
 * Point the child's HTTP clients at a closed local port so any *outbound*
 * discovery attempt fails immediately instead of hanging until its own budget.
 *
 * Measured cause (C1): `get_available_models` awaits `awaitBackgroundRefresh()`
 * (rpc-mode.ts:1423) and that background pass performs online discovery against
 * remote catalog/provider hosts (observed CONNECT targets:
 * catalog.stencil.so, hyper.charm.land, api.kilo.ai, api.venice.ai, zenmux.ai,
 * api.commandcode.ai, coding-intl.dashscope.aliyuncs.com). On a machine where
 * those connections blackhole rather than refuse, the call waits out
 * REMOTE_DISCOVERY_TIMEOUT_MS = 10_000 (model-discovery.ts:67), which exceeds
 * this harness's 8 s step bound. With the same discovery pointed at a refused
 * port the call returns in ~24 ms.
 *
 * So the smoke test is made explicitly offline: the fixture provider is on
 * loopback (exempted via NO_PROXY), nothing about it needs the network, and the
 * result no longer depends on the host's reachability. This bounds the
 * environment's influence on the test; it is not a claim about why any given
 * provider's discovery is slow.
 */
const OFFLINE_PROXY_URL = "http://127.0.0.1:9";

export function buildIsolatedEnv({ repoRoot, runRoot, configDirName = makeConfigDirName() }) {
  const env = {};
  // Copy only what OMP legitimately needs; never inherit credentials, profiles,
  // or XDG redirects that could steer it back onto the user's real dirs.
  for (const k of Object.keys(process.env)) {
    if (STEER_VARS.includes(k)) continue;
    if (CRED_RE.test(k)) continue;
    env[k] = process.env[k];
  }
  env.HOME = process.env.HOME ?? homedir();
  // See OFFLINE_PROXY_URL: any outbound attempt fails fast, loopback stays direct.
  env.HTTP_PROXY = OFFLINE_PROXY_URL;
  env.HTTPS_PROXY = OFFLINE_PROXY_URL;
  env.ALL_PROXY = OFFLINE_PROXY_URL;
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  env.PI_CONFIG_DIR = configDirName; // homedir-relative config root
  env.PI_CODING_AGENT_DIR = join(runRoot, "agent");
  env.OMP_DEV_LAUNCH_DIR = join(runRoot, "dev-cwd");
  env.PATH = [
    join(homedir(), ".bun", "bin"), // bun runtime (the launcher `exec bun`)
    join(homedir(), ".pyenv", "shims"),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".cargo", "bin"),
    join(homedir(), ".nvm", "versions", "node", "v24.14.0", "bin"),
    "/usr/local/bin", "/usr/bin", "/bin",
  ].join(":");
  return { env, configDirName, configRoot: join(env.HOME, configDirName) };
}

/** Create (if needed) `baseDir`, then a run-unique directory inside it. */
export function prepareRunRoot(baseDir) {
  mkdirSync(baseDir, { recursive: true });
  return mkdtempSync(join(baseDir, "omp-run-"));
}

/** Remove a config root only when it is one of our own isolated roots. */
function safeRmConfigRoot(configRoot) {
  if (!configRoot) return;
  const abs = resolve(configRoot);
  const home = resolve(process.env.HOME ?? homedir());
  if (!basename(abs).startsWith(".omp-m0-")) return;
  if (abs === home || !abs.startsWith(home + sep)) return;
  rmSync(abs, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 3. Process-tree cleanup (signal sent ≠ reaped, and child exit ≠ group empty)
// ---------------------------------------------------------------------------

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, timeoutMs);
    child.once("exit", () => { if (!settled) { settled = true; clearTimeout(t); resolve(true); } });
  });
}

/** True while any process remains in the verification process group. */
function groupAlive(pgid) {
  try { process.kill(-pgid, 0); return true; }
  catch (e) { return e.code !== "ESRCH"; } // EPERM ⇒ it exists but is not ours to signal
}

async function waitGroupEmpty(pgid, timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (!groupAlive(pgid)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function signalGroup(pgid, signal) {
  try { process.kill(-pgid, signal); return; } catch {}
  try { process.kill(pgid, signal); } catch {}
}

/**
 * Reap the whole verification process group: SIGTERM, wait for the direct child,
 * wait for the group to empty, then SIGKILL the group and wait again. Resolves
 * true only when no process remains in the group. Only ever signals `-child.pid`
 * (the group this harness created), never an unrelated group.
 */
export async function terminateTree(child, timeoutMs = 5000) {
  const pgid = child.pid;
  if (!pgid) return true;
  if (groupAlive(pgid)) await signalGroup(pgid, "SIGTERM");
  await waitExit(child, timeoutMs);
  if (await waitGroupEmpty(pgid, timeoutMs)) return true;
  await signalGroup(pgid, "SIGKILL");
  return waitGroupEmpty(pgid, 2000);
}

// ---------------------------------------------------------------------------
// 4. Framed protocol check
// ---------------------------------------------------------------------------

/**
 * Spawn `command args`, frame stdout with readline, and run the protocol.
 * Never rejects: any spawn error, malformed response, thrown exception, timeout,
 * or stream error becomes an explicit failure result. The process group is
 * always reaped before resolving; `result.reaped === false` means cleanup failed.
 */
export async function runProtocolCheck({
  command, args, env, cwd, model = "m0mock/local-model",
  readyTimeoutMs = 30_000, stepTimeoutMs = 8_000, termTimeoutMs = 5_000,
}) {
  let child = null;
  const messages = [];
  let stderr = "";
  let spawnError = null;
  let streamError = null;

  const result = {
    ok: false, stage: "start", reason: "", pid: null,
    ready: null, negotiate: null, models: null,
    exitCode: null, signalCode: null, reaped: null,
  };

  const fail = (stage, reason) => { result.ok = false; result.stage = stage; result.reason = reason; };
  const noteStreamError = (where) => (e) => {
    if (!streamError) streamError = `${where}: ${e?.message ?? e}`;
  };

  try {
    child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    result.pid = child.pid;

    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try { messages.push(JSON.parse(t)); } catch { /* non-JSON line, ignore */ }
    });
    // Install stream error handlers before any read/write: an async 'error' event
    // (e.g. EPIPE from a child that closed stdin) is not caught by try/catch.
    child.stdin.on("error", noteStreamError("stdin"));
    child.stdout.on("error", noteStreamError("stdout"));
    child.stderr.on("error", noteStreamError("stderr"));
    rl.on("error", noteStreamError("readline"));
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("exit", (code, sig) => { result.exitCode = code; result.signalCode = sig; });
    child.on("error", (e) => { spawnError = e; });

    /** Write one command; a stream failure is recorded and reported, never thrown. */
    const writeCommand = (obj) => {
      if (streamError) return false;
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
        return true;
      } catch (e) {
        noteStreamError("stdin")(e);
        return false;
      }
    };

    const waitFor = async (pred, timeoutMs) => {
      const start = Date.now();
      for (;;) {
        const hit = messages.find(pred);
        if (hit) return hit;
        if (streamError) return null; // stop waiting immediately on a stream failure
        if (result.exitCode !== null || result.signalCode !== null) return null;
        if (Date.now() - start > timeoutMs) return null;
        await new Promise((r) => setTimeout(r, 100));
      }
    };

    // 1. ready
    result.ready = await waitFor((m) => m && m.type === "ready", readyTimeoutMs);
    if (!result.ready) {
      const reason = spawnError
        ? `spawn error: ${spawnError.message}`
        : streamError
          ? `stream error before ready: ${streamError}`
          : `no ready frame within ${readyTimeoutMs}ms${stderr ? ` (stderr: ${stderr.slice(-200)})` : ""}${result.exitCode !== null ? ` (exit ${result.exitCode})` : ""}`;
      fail("ready", reason);
      return result;
    }
    if (!Array.isArray(result.ready.supportedProtocolVersions) || !result.ready.supportedProtocolVersions.includes(2)) {
      fail("ready", `ready does not advertise protocol v2: ${JSON.stringify(result.ready)}`);
      return result;
    }

    // 2. negotiate_protocol
    if (!writeCommand({ id: "m0", type: "negotiate_protocol", protocolVersion: 2 })) {
      fail("negotiate_protocol", `could not send negotiate_protocol: ${streamError}`);
      return result;
    }
    result.negotiate = await waitFor(
      (m) => m && m.type === "response" && m.command === "negotiate_protocol" && m.id === "m0",
      stepTimeoutMs,
    );
    if (!result.negotiate || result.negotiate.success !== true || result.negotiate.data?.protocolVersion !== 2) {
      const reason = streamError
        ? `stream error: ${streamError}`
        : `negotiate_protocol failed: ${result.negotiate ? JSON.stringify(result.negotiate) : "no response"}`;
      fail("negotiate_protocol", reason);
      return result;
    }

    // 3. get_available_models
    if (!writeCommand({ id: "m1", type: "get_available_models" })) {
      fail("get_available_models", `could not send get_available_models: ${streamError}`);
      return result;
    }
    result.models = await waitFor(
      (m) => m && m.type === "response" && m.command === "get_available_models" && m.id === "m1",
      stepTimeoutMs,
    );
    if (!result.models || result.models.success !== true) {
      const reason = streamError
        ? `stream error: ${streamError}`
        : `get_available_models failed: ${result.models ? JSON.stringify(result.models) : "no response"}`;
      fail("get_available_models", reason);
      return result;
    }
    const models = result.models.data?.models;
    if (!Array.isArray(models)) {
      fail("get_available_models", `models response is not an array: ${JSON.stringify(result.models.data)}`);
      return result;
    }
    const ids = models.map((m) => (m && typeof m === "object" ? m.id : undefined));
    if (!ids.includes("local-model")) {
      fail("get_available_models", `mock model not returned: ${JSON.stringify(ids)}`);
      return result;
    }

    result.ok = true;
    result.stage = "done";
    return result;
  } catch (e) {
    fail(result.stage === "start" ? "error" : result.stage, `exception: ${e?.message ?? e}`);
    return result;
  } finally {
    if (child) {
      let reaped = false;
      try { reaped = await terminateTree(child, termTimeoutMs); } catch { reaped = false; }
      result.reaped = reaped;
      if (!reaped) {
        result.ok = false;
        result.stage = "cleanup";
        result.reason = `verification process group was not fully reaped${result.reason ? ` (${result.reason})` : ""}`;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 5. Resolved-path verification (isolation acceptance condition)
// ---------------------------------------------------------------------------

/** True when `p` is `base` or lies inside it. */
function inside(p, base) {
  const a = resolve(p);
  const b = resolve(base);
  return a === b || a.startsWith(b + sep);
}

/**
 * Required artifacts must exist and every isolation path must stay inside this
 * run's scope. `ok` is the acceptance condition the CLI enforces.
 */
export function verifyResolvedPaths({ runRoot, configRoot, home = process.env.HOME ?? homedir() }) {
  const agentDir = join(runRoot, "agent");
  const launchDir = join(runRoot, "dev-cwd");
  const required = {
    agentDb: existsSync(join(agentDir, "agent.db")),
    modelsDb: existsSync(join(agentDir, "models.db")),
    sessions: existsSync(join(agentDir, "sessions")),
  };
  const optional = {
    configLogs: existsSync(join(configRoot, "logs")),
    configRun: existsSync(join(configRoot, "run")),
    launchDir: existsSync(launchDir),
  };
  const scope = {
    agentDirInRunRoot: inside(agentDir, runRoot),
    launchDirInRunRoot: inside(launchDir, runRoot),
    configRootNotUserOmp: resolve(configRoot) !== resolve(join(home, ".omp")),
    configRootIsolatedName: basename(resolve(configRoot)).startsWith(".omp-m0-"),
  };
  const requiredOk = Object.values(required).every(Boolean);
  const scopeOk = Object.values(scope).every(Boolean);
  return { required, optional, scope, ok: requiredOk && scopeOk, agentDir, launchDir, configRoot };
}

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

async function performChecks({ repoRoot, runRoot }) {
  const launcher = findPinnedLauncher(repoRoot);
  const pin = verifyPinnedSource(repoRoot);
  console.log(`launcher     : ${launcher}`);
  console.log(`gitlink SHA  : ${pin.gitlink}`);
  console.log(`submodule SHA: ${pin.actual}`);
  console.log(`pinned ver   : ${pin.pinnedVersion} (reported ${pin.reportedVersion ?? "n/a"})`);
  if (!pin.ok) {
    console.error(`FAIL: ${pin.reason}`);
    return { exitCode: 1, configRoot: null };
  }

  const configDirName = makeConfigDirName();
  const { env } = buildIsolatedEnv({ repoRoot, runRoot, configDirName });
  const configRoot = join(env.HOME, configDirName);
  writeFileSync(join(runRoot, "agent", "models.yml"), readFileSync(join(__dirname, "models.yml")));
  console.log(`config root  : ${configRoot}`);
  console.log(`agent dir    : ${join(runRoot, "agent")}`);
  console.log(`launch dir   : ${join(runRoot, "dev-cwd")}`);

  const result = await runProtocolCheck({
    command: launcher,
    args: ["--mode", "rpc", "--model", "m0mock/local-model"],
    env,
    cwd: join(runRoot, "dev-cwd"),
  });

  const paths = verifyResolvedPaths({ runRoot, configRoot });
  console.log(`resolved     : agent.db=${paths.required.agentDb} models.db=${paths.required.modelsDb} sessions=${paths.required.sessions} logs=${paths.optional.configLogs} run=${paths.optional.configRun}`);
  console.log(`scope        : ${JSON.stringify(paths.scope)}`);

  if (!paths.ok) {
    console.error(`FAIL: isolation path checks failed: required=${JSON.stringify(paths.required)} scope=${JSON.stringify(paths.scope)}`);
    return { exitCode: 1, configRoot };
  }
  if (!result.ok) {
    console.error(`FAIL: ${result.stage}: ${result.reason}`);
    return { exitCode: 1, configRoot };
  }
  if (result.reaped === false) {
    console.error("FAIL: verification process group was not fully reaped");
    return { exitCode: 1, configRoot };
  }

  console.log(`ready        : ${JSON.stringify(result.ready)}`);
  console.log(`negotiate    : ${JSON.stringify(result.negotiate)}`);
  console.log(`models       : ${result.models.data.models.map((m) => m.id).join(",")}`);
  console.log("PASS: ready + negotiate_protocol(v2) + get_available_models (no paid model call)");
  return { exitCode: 0, configRoot };
}

async function main() {
  const keep = process.argv.includes("--keep");
  const repoRoot = resolveRepoRoot();
  let runRoot = null;
  let configRoot = null;
  let exitCode = 1;
  try {
    runRoot = prepareRunRoot(join(repoRoot, ".dev-data"));
    mkdirSync(join(runRoot, "agent"), { recursive: true });
    mkdirSync(join(runRoot, "dev-cwd"), { recursive: true });
    const outcome = await performChecks({ repoRoot, runRoot });
    configRoot = outcome.configRoot;
    exitCode = outcome.exitCode;
  } catch (e) {
    console.error(`FAIL: ${e.stack || e}`);
    exitCode = 1;
  } finally {
    if (keep) {
      if (runRoot) console.log(`kept run root    : ${runRoot}`);
      if (configRoot) console.log(`kept config root : ${configRoot}`);
    } else {
      if (runRoot) rmSync(runRoot, { recursive: true, force: true });
      safeRmConfigRoot(configRoot);
    }
  }
  process.exit(exitCode);
}

if (isMain) {
  main().catch((e) => { console.error(`FAIL: ${e.stack || e}`); process.exit(1); });
}
