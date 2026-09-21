/**
 * Targeted verification of the M0 RPC harness (docs/validation/M0-rpc/verify-rpc.mjs)
 * using controlled fake processes. Run with:
 *   node --test docs/validation/M0-rpc/verify-rpc.test.mjs
 *
 * `harness` is imported as a namespace so a test for a not-yet-existing export
 * fails at the assertion (reproducing the gap) instead of failing the whole file
 * to load.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as harness from "./verify-rpc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const __filename = fileURLToPath(import.meta.url);
const FAKE = join(__dirname, "fake-omp.mjs");
const NODE = process.execPath;

/** Environment variables this test file sets; compared by presence, never by value. */
const ENV_KEYS = [
  "OMP_PROFILE", "PI_PROFILE",
  "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME",
  "PI_CODING_AGENT_SESSION_DIR", "OPENAI_API_KEY",
];

/** Synthetic-only values; never derived from the ambient environment. */
const SYNTHETIC_ENV = {
  OMP_PROFILE: "m0-synthetic-profile",
  PI_PROFILE: "m0-synthetic-profile-2",
  XDG_DATA_HOME: "/tmp/m0-xdg-data",
  XDG_STATE_HOME: "/tmp/m0-xdg-state",
  XDG_CACHE_HOME: "/tmp/m0-xdg-cache",
  XDG_CONFIG_HOME: "/tmp/m0-xdg-config",
  PI_CODING_AGENT_SESSION_DIR: "/tmp/m0-session-dir",
  OPENAI_API_KEY: "m0-synthetic-not-a-real-key",
};

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

function fakeEnv(scenario) {
  return { ...process.env, FAKE_SCENARIO: scenario };
}

async function fake(scenario, extra = {}) {
  return harness.runProtocolCheck({
    command: NODE,
    args: [FAKE],
    env: fakeEnv(scenario),
    cwd: tmpdir(),
    readyTimeoutMs: 4000,
    stepTimeoutMs: 600,
    termTimeoutMs: 300,
    ...extra,
  });
}

function isAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Run fn with the given env overrides, restoring every touched key afterwards. */
function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const k of Object.keys(vars)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

// --- core transport -------------------------------------------------------

test("normal transport: ready + negotiate v2 + models pass", async () => {
  const r = await fake("normal");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.ready.type, "ready");
  assert.equal(r.negotiate.data.protocolVersion, 2);
  assert.deepEqual(r.models.data.models.map((m) => m.id), ["local-model"]);
  assert.equal(isAlive(r.pid), false, "child must be reaped");
});

test("framing: split frames, merged frames, and UTF-8 cross-chunk reassemble", async () => {
  const r = await fake("split");
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.ready.label, "假就绪·中文跨块测试");
  assert.equal(r.negotiate.success, true);
  assert.deepEqual(r.models.data.models.map((m) => m.id), ["local-model"]);
  assert.equal(isAlive(r.pid), false);
});

test("error response: negotiate success=false yields non-zero result", async () => {
  const r = await fake("error-response");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "negotiate_protocol");
  assert.equal(isAlive(r.pid), false);
});

test("start failure: immediate exit yields non-zero result and no residual", async () => {
  const r = await fake("crash");
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 1);
  assert.equal(isAlive(r.pid), false);
});

test("timeout: silent child yields non-zero result and no residual", async () => {
  const r = await fake("silent", { readyTimeoutMs: 600 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "ready");
  assert.equal(isAlive(r.pid), false);
});

test("cleanup: SIGTERM-ignoring child is force-reaped with SIGKILL", async () => {
  const r = await fake("ignore-sigterm", { stepTimeoutMs: 400, termTimeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.equal(r.signalCode, "SIGKILL", `expected SIGKILL, got ${r.signalCode}`);
  assert.equal(isAlive(r.pid), false, "child must be reaped");
});

// --- new/reproduced issues ------------------------------------------------

test("first run: run root is created even when its parent dir is missing", () => {
  const tmp = mkdtempSync(join(tmpdir(), "base-"));
  try {
    const base = join(tmp, "missing-a", "missing-b");
    const root = harness.prepareRunRoot(base);
    assert.ok(root && existsSync(root), "prepareRunRoot must create parents and a run root");
    rmSync(root, { recursive: true, force: true });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("malformed models response fails explicitly and reaps the child", async () => {
  const r = await fake("malformed-models");
  assert.equal(r.ok, false);
  assert.equal(r.stage, "get_available_models");
  assert.match(String(r.reason), /array|models/i);
  assert.equal(isAlive(r.pid), false, "child must be reaped even on malformed data");
});

test("stubborn same-group grandchild is force-reaped", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "gc-"));
  const pidFile = join(cwd, "grandchild.pid");
  let gpid = null;
  try {
    const r = await fake("stubborn-grandchild", { cwd });
    assert.ok(existsSync(pidFile), "grandchild pid file missing");
    gpid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isFinite(gpid) && gpid > 0, `bad grandchild pid: ${gpid}`);
    await new Promise((res) => setTimeout(res, 250));
    assert.equal(isAlive(gpid), false, `grandchild ${gpid} still alive after cleanup`);
    assert.notEqual(r.reaped, false, "harness must report the group reaped");
  } finally {
    // Fallback: the test must not leak the grandchild either.
    if (gpid && isAlive(gpid)) { try { process.kill(gpid, "SIGKILL"); } catch {} }
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("verifyResolvedPaths: missing required artifact ⇒ ok=false", () => {
  const runRoot = mkdtempSync(join(tmpdir(), "vrp-"));
  const configRoot = join(homedir(), ".omp-m0-testfixture");
  try {
    const r = harness.verifyResolvedPaths({ runRoot, configRoot });
    assert.equal(r.ok, false);
    assert.equal(r.required.agentDb, false);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("verifyResolvedPaths: config root inside the user's ~/.omp ⇒ ok=false", () => {
  const runRoot = mkdtempSync(join(tmpdir(), "vrp2-"));
  const configRoot = join(process.env.HOME ?? homedir(), ".omp");
  try {
    const r = harness.verifyResolvedPaths({ runRoot, configRoot });
    assert.equal(r.ok, false);
    assert.equal(r.scope.configRootNotUserOmp, false);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("verifyPinnedSource leaves no omp-ver-* temp directory behind", () => {
  const before = readdirSync(tmpdir()).filter((n) => n.startsWith("omp-ver-"));
  const r = harness.verifyPinnedSource(harness.resolveRepoRoot());
  const after = readdirSync(tmpdir()).filter((n) => n.startsWith("omp-ver-"));
  const leaked = after.filter((n) => !before.includes(n));
  assert.deepEqual(leaked, [], `verifyPinnedSource leaked temp dir(s): ${leaked}`);
  assert.ok(r.ok, r.reason);
});

// --- environment isolation -------------------------------------------------

test("env restore probe: presence is restored after an isolation cycle", () => {
  const before = Object.fromEntries(ENV_KEYS.map((k) => [k, has(process.env, k)]));
  const runRoot = mkdtempSync(join(tmpdir(), "env-probe-"));
  try {
    withEnv(SYNTHETIC_ENV, () => {
      const { env } = harness.buildIsolatedEnv({ repoRoot: harness.resolveRepoRoot(), runRoot });
      for (const k of ENV_KEYS) assert.ok(!has(env, k), `${k} must be stripped from the child env`);
      assert.ok(env.PI_CONFIG_DIR && env.PI_CONFIG_DIR.startsWith(".omp-m0-"));
      assert.ok(env.PI_CODING_AGENT_DIR.endsWith("agent"));
      assert.ok(env.OMP_DEV_LAUNCH_DIR);
    });
    for (const k of ENV_KEYS) {
      // Boolean-only assertion: a failure message must never echo a credential value.
      assert.equal(has(process.env, k), before[k], `${k} presence must be restored`);
    }
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});

/** Run only the probe above in a subprocess with a controlled environment. */
function runEnvProbeProbe(env) {
  return spawnSync(NODE, ["--test", "--test-name-pattern=env restore probe", __filename], {
    env, encoding: "utf8", timeout: 60_000,
  });
}

test("env restore: variables that started absent come back absent", () => {
  const env = { ...process.env };
  for (const k of ENV_KEYS) delete env[k];
  const r = runEnvProbeProbe(env);
  assert.equal(r.status, 0, `probe must pass with the variables absent (status ${r.status})`);
});

test("env restore: variables that started set come back set", () => {
  const env = { ...process.env, ...SYNTHETIC_ENV };
  const r = runEnvProbeProbe(env);
  assert.equal(r.status, 0, `probe must pass with the variables set (status ${r.status})`);
});

test("stream error: closed stdin fails explicitly, without an unhandled EPIPE", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "epipe-"));
  const pidFile = join(cwd, "self.pid");
  let pid = null;
  try {
    const r = await fake("closed-stdin", { cwd, stepTimeoutMs: 1500, termTimeoutMs: 500 });
    assert.equal(r.ok, false, "a stream error must not be reported as success");
    assert.match(String(r.reason), /stream|EPIPE|write|stdin/i, `unexpected reason: ${r.reason}`);
    assert.equal(r.reaped, true, "the process group must be reaped");
    assert.ok(existsSync(pidFile), "fake must record its pid");
    pid = Number(readFileSync(pidFile, "utf8").trim());
    assert.ok(Number.isFinite(pid) && pid > 0);
    await new Promise((res) => setTimeout(res, 200));
    assert.equal(isAlive(pid), false, `fake ${pid} must be dead after cleanup`);
  } finally {
    if (pid && isAlive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("pinned entry: launcher is the repo path, not the global link", () => {
  const launcher = harness.findPinnedLauncher(harness.resolveRepoRoot());
  assert.ok(launcher.endsWith(join("upstream", "oh-my-pi", "packages", "coding-agent", "scripts", "omp")));
  assert.ok(!launcher.startsWith(join(process.env.HOME ?? "", ".bun")));
});

test("pinned entry: missing/mismatched checkout fails clearly", () => {
  const empty = mkdtempSync(join(tmpdir(), "no-submodule-"));
  try {
    const r = harness.verifyPinnedSource(empty);
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing|SHA/i);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
