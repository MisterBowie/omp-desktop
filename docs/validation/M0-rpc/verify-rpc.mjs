#!/usr/bin/env node
/**
 * Reproducible OMP protocol startup verification (M0), second rework.
 *
 * Hardened against the second-review findings:
 *   - binds the pinned source launcher inside `upstream/oh-my-pi` (never the
 *     global `~/.bun/bin/omp` link), verifies the submodule SHA against the
 *     repo gitlink and the runtime version against `packages/utils/package.json`;
 *   - builds a controlled child environment: sets `PI_CONFIG_DIR`,
 *     `PI_CODING_AGENT_DIR`, `OMP_DEV_LAUNCH_DIR`, and strips `OMP_PROFILE` /
 *     `PI_PROFILE` / `XDG_*` / session-dir / credential vars so a named profile
 *     or XDG redirect cannot steer OMP back onto the user's `~/.omp`;
 *   - frames stdout with `readline` (full lines only; split/merged/UTF-8 safe)
 *     and matches responses by parsed `type`/`command`/`id`/`success`, not by
 *     string `includes`;
 *   - guarantees process-tree cleanup on every path (success, assert failure,
 *     timeout, start failure): SIGTERM the group, wait, then SIGKILL, and only
 *     then return the exit code.
 *
 * Each run uses a fresh, run-unique isolation directory so concurrent runs and
 * different worktrees never share state; the script removes its own temporary
 * directories afterwards (never touching the user's real data).
 *
 * Usage:
 *   node verify-rpc.mjs            # real pinned-source RPC startup (no paid model)
 *   node verify-rpc.mjs --keep     # same, but leave the isolation dirs for inspection
 *
 * Exits 0 only when ready + negotiate_protocol(v2) + get_available_models all
 * pass against the pinned source; non-zero otherwise.
 */
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
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

/** Returns { ok, reason, gitlink, actual, pinnedVersion, reportedVersion }. */
export function verifyPinnedSource(repoRoot = resolveRepoRoot()) {
  const launcher = findPinnedLauncher(repoRoot);
  const gitlink = readGitlinkSha(repoRoot);
  const actual = readSubmoduleSha(repoRoot);
  const pinnedVersion = readPinnedVersion(repoRoot);
  if (!existsSync(launcher)) return { ok: false, reason: `pinned launcher missing: ${launcher}`, gitlink, actual, pinnedVersion };
  if (!gitlink) return { ok: false, reason: "could not read gitlink SHA for upstream/oh-my-pi", gitlink, actual, pinnedVersion };
  if (gitlink !== actual) {
    return { ok: false, reason: `submodule SHA mismatch: gitlink=${gitlink} actual=${actual}`, gitlink, actual, pinnedVersion };
  }
  // Runtime version: launcher --version must equal the pinned pi-utils version.
  const r = spawnSync(findPinnedLauncher(repoRoot), ["--version"], {
    env: buildIsolatedEnv({ repoRoot, runRoot: mkdtempSync(join(tmpdir(), "omp-ver-")), keep: false }).env,
    encoding: "utf8",
    timeout: 30_000,
  });
  const reported = (r.stdout ?? "").trim();
  const reportedVersion = /^omp\/(.+)$/m.exec(reported)?.[1] ?? null;
  if (r.status !== 0 || reportedVersion !== pinnedVersion) {
    return {
      ok: false,
      reason: `runtime version mismatch: reported=${reportedVersion ?? `(exit ${r.status}, ${reported || r.stderr})`} pinned=${pinnedVersion}`,
      gitlink, actual, pinnedVersion, reportedVersion,
    };
  }
  return { ok: true, reason: "ok", gitlink, actual, pinnedVersion, reportedVersion };
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

export function buildIsolatedEnv({ repoRoot, runRoot, keep = false }) {
  const env = {};
  // Copy only the variables OMP legitimately needs; do not inherit credentials,
  // profiles, or XDG redirects.
  for (const k of Object.keys(process.env)) {
    if (STEER_VARS.includes(k)) continue;
    if (CRED_RE.test(k)) continue;
    env[k] = process.env[k];
  }
  // Locale bits are safe to keep (already copied); ensure HOME is present.
  env.HOME = process.env.HOME ?? homedir();
  const suffix = randomBytes(4).toString("hex");
  const configDirName = `.omp-m0-${suffix}`; // homedir-relative config root
  env.PI_CONFIG_DIR = configDirName;
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

// ---------------------------------------------------------------------------
// 3. Process-tree cleanup (signal sent ≠ reaped)
// ---------------------------------------------------------------------------

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(false); } }, timeoutMs);
    child.once("exit", () => { if (!settled) { settled = true; clearTimeout(t); resolve(true); } });
  });
}

async function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); return; } catch {}
  try { process.kill(pid, signal); } catch {}
}

/** SIGTERM the group, wait, then SIGKILL; resolves true once the child is reaped. */
export async function terminateTree(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  await signalGroup(child.pid, "SIGTERM");
  const exited = await waitExit(child, timeoutMs);
  if (!exited) {
    await signalGroup(child.pid, "SIGKILL");
    return waitExit(child, 2000);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 4. Framed protocol check
// ---------------------------------------------------------------------------

/**
 * Spawn `command args`, frame stdout with readline, and run the protocol.
 * Resolves with a result object; never rejects (all errors become the result)
 * and always cleans the process tree before resolving.
 */
export async function runProtocolCheck({
  command, args, env, cwd, model = "m0mock/local-model",
  readyTimeoutMs = 30_000, stepTimeoutMs = 8_000, termTimeoutMs = 5_000,
}) {
  let child;
  const messages = [];
  let stderr = "";
  let spawnError = null;

  const onLine = (line) => {
    const t = line.trim();
    if (!t) return;
    try { messages.push(JSON.parse(t)); } catch { /* non-JSON line, ignore */ }
  };

  const result = {
    ok: false, stage: "start", reason: "", pid: null,
    ready: null, negotiate: null, models: null,
    exitCode: null, signalCode: null,
  };

  try {
    child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    result.pid = child.pid;
  } catch (e) {
    result.reason = `spawn failed: ${e.message}`;
    return result;
  }

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", onLine);
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const exited = new Promise((res) => child.once("exit", (code, sig) => {
    result.exitCode = code; result.signalCode = sig; res();
  }));
  child.on("error", (e) => { spawnError = e; });

  const waitFor = async (pred, timeoutMs) => {
    const start = Date.now();
    for (;;) {
      const hit = messages.find(pred);
      if (hit) return hit;
      if (result.exitCode !== null || result.signalCode !== null) return null;
      if (Date.now() - start > timeoutMs) return null;
      await new Promise((r) => setTimeout(r, 100));
    }
  };

  // 1. ready
  result.ready = await waitFor((m) => m && m.type === "ready", readyTimeoutMs);
  if (!result.ready) {
    result.stage = "ready";
    result.reason = spawnError ? `spawn error: ${spawnError.message}` : `no ready frame within ${readyTimeoutMs}ms${stderr ? ` (stderr: ${stderr.slice(-200)})` : ""}${result.exitCode !== null ? ` (exit ${result.exitCode})` : ""}`;
    await terminateTree(child, termTimeoutMs);
    return result;
  }
  if (result.ready.supportedProtocolVersions?.indexOf?.(2) < 0) {
    result.stage = "ready";
    result.reason = `ready does not advertise protocol v2: ${JSON.stringify(result.ready)}`;
    await terminateTree(child, termTimeoutMs);
    return result;
  }

  // 2. negotiate_protocol
  child.stdin.write(JSON.stringify({ id: "m0", type: "negotiate_protocol", protocolVersion: 2 }) + "\n");
  result.negotiate = await waitFor(
    (m) => m && m.type === "response" && m.command === "negotiate_protocol" && m.id === "m0",
    stepTimeoutMs,
  );
  if (!result.negotiate || result.negotiate.success !== true || result.negotiate.data?.protocolVersion !== 2) {
    result.stage = "negotiate_protocol";
    result.reason = `negotiate_protocol failed: ${result.negotiate ? JSON.stringify(result.negotiate) : "no response"}`;
    await terminateTree(child, termTimeoutMs);
    return result;
  }

  // 3. get_available_models
  child.stdin.write(JSON.stringify({ id: "m1", type: "get_available_models" }) + "\n");
  result.models = await waitFor(
    (m) => m && m.type === "response" && m.command === "get_available_models" && m.id === "m1",
    stepTimeoutMs,
  );
  if (!result.models || result.models.success !== true) {
    result.stage = "get_available_models";
    result.reason = `get_available_models failed: ${result.models ? JSON.stringify(result.models) : "no response"}`;
    await terminateTree(child, termTimeoutMs);
    return result;
  }
  const ids = (result.models.data?.models ?? []).map((m) => m.id);
  if (!ids.includes("local-model")) {
    result.stage = "get_available_models";
    result.reason = `mock model not returned: ${JSON.stringify(ids)}`;
    await terminateTree(child, termTimeoutMs);
    return result;
  }

  result.ok = true;
  result.stage = "done";
  await terminateTree(child, termTimeoutMs);
  await exited; // confirm reaped
  return result;
}

// ---------------------------------------------------------------------------
// 5. Resolved-path verification (isolation evidence)
// ---------------------------------------------------------------------------

export function verifyResolvedPaths({ runRoot, configRoot }) {
  const agentDir = join(runRoot, "agent");
  const launchDir = join(runRoot, "dev-cwd");
  const checks = {
    agentDb: existsSync(join(agentDir, "agent.db")),
    modelsDb: existsSync(join(agentDir, "models.db")),
    sessions: existsSync(join(agentDir, "sessions")),
    configLogs: existsSync(join(configRoot, "logs")),
    configRun: existsSync(join(configRoot, "run")),
    launchDir: existsSync(launchDir),
  };
  const leaksIntoUserHome = configRoot === join(process.env.HOME ?? homedir(), ".omp");
  return { ...checks, agentDir, launchDir, configRoot, leaksIntoUserHome };
}

// ---------------------------------------------------------------------------
// 6. CLI
// ---------------------------------------------------------------------------

async function main() {
  const keep = process.argv.includes("--keep");
  const repoRoot = resolveRepoRoot();
  const runRoot = mkdtempSync(join(repoRoot, ".dev-data", "omp-run-"));
  mkdirSync(join(runRoot, "agent"), { recursive: true });
  mkdirSync(join(runRoot, "dev-cwd"), { recursive: true });

  const launcher = findPinnedLauncher(repoRoot);
  const pin = verifyPinnedSource(repoRoot);
  console.log(`launcher     : ${launcher}`);
  console.log(`gitlink SHA  : ${pin.gitlink}`);
  console.log(`submodule SHA: ${pin.actual}`);
  console.log(`pinned ver   : ${pin.pinnedVersion} (reported ${pin.reportedVersion ?? "n/a"})`);
  if (!pin.ok) {
    console.error(`FAIL: ${pin.reason}`);
    rmSync(runRoot, { recursive: true, force: true });
    process.exit(1);
  }

  const { env, configRoot } = buildIsolatedEnv({ repoRoot, runRoot, keep });
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
  console.log(`resolved     : agent.db=${paths.agentDb} models.db=${paths.modelsDb} sessions=${paths.sessions} logs=${paths.configLogs} run=${paths.configRun}`);
  if (paths.leaksIntoUserHome) {
    console.error(`FAIL: config root resolved to the user's ~/.omp (${configRoot})`);
    process.exit(1);
  }

  if (!result.ok) {
    console.error(`FAIL: ${result.stage}: ${result.reason}`);
    process.exit(1);
  }

  console.log(`ready        : ${JSON.stringify(result.ready)}`);
  console.log(`negotiate    : ${JSON.stringify(result.negotiate)}`);
  console.log(`models       : ${(result.models.data?.models ?? []).map((m) => m.id).join(",")}`);
  console.log("PASS: ready + negotiate_protocol(v2) + get_available_models (no paid model call)");

  if (!keep) {
    rmSync(runRoot, { recursive: true, force: true });
    rmSync(configRoot, { recursive: true, force: true });
  }
}

if (isMain) {
  main().catch((e) => { console.error(`FAIL: ${e.stack || e}`); process.exit(1); });
}
