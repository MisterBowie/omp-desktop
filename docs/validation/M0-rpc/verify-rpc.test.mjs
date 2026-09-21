/**
 * Targeted verification of the M0 RPC harness (docs/validation/M0-rpc/verify-rpc.mjs)
 * using controlled fake processes. Run with:
 *   node --test docs/validation/M0-rpc/verify-rpc.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runProtocolCheck,
  buildIsolatedEnv,
  findPinnedLauncher,
  verifyPinnedSource,
  resolveRepoRoot,
} from "./verify-rpc.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FAKE = join(__dirname, "fake-omp.mjs");
const NODE = process.execPath;

function fakeEnv(scenario) {
  return { ...process.env, FAKE_SCENARIO: scenario };
}

async function fake(scenario, extra = {}) {
  return runProtocolCheck({
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

test("env isolation: profile / XDG / credential vars are stripped", () => {
  const prev = { OMP_PROFILE: process.env.OMP_PROFILE, XDG_DATA_HOME: process.env.XDG_DATA_HOME, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  process.env.OMP_PROFILE = "work";
  process.env.PI_PROFILE = "work2";
  process.env.XDG_DATA_HOME = "/tmp/xdg";
  process.env.OPENAI_API_KEY = "sk-not-real";
  try {
    const runRoot = mkdtempSync(join(tmpdir(), "env-"));
    const { env } = buildIsolatedEnv({ repoRoot: resolveRepoRoot(), runRoot });
    assert.equal(env.OMP_PROFILE, undefined);
    assert.equal(env.PI_PROFILE, undefined);
    assert.equal(env.XDG_DATA_HOME, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.ok(env.PI_CONFIG_DIR && env.PI_CONFIG_DIR.startsWith(".omp-m0-"));
    assert.ok(env.PI_CODING_AGENT_DIR.endsWith(join("agent")));
    assert.ok(env.OMP_DEV_LAUNCH_DIR);
    rmSync(runRoot, { recursive: true, force: true });
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

test("pinned entry: launcher is the repo path, not the global link", () => {
  const launcher = findPinnedLauncher(resolveRepoRoot());
  assert.ok(launcher.endsWith(join("upstream", "oh-my-pi", "packages", "coding-agent", "scripts", "omp")));
  assert.ok(!launcher.startsWith(join(process.env.HOME ?? "", ".bun")));
});

test("pinned entry: missing/mismatched checkout fails clearly", () => {
  const empty = mkdtempSync(join(tmpdir(), "no-submodule-"));
  try {
    const r = verifyPinnedSource(empty);
    assert.equal(r.ok, false);
    assert.match(r.reason, /missing|SHA/i);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
