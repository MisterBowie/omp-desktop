#!/usr/bin/env node
/**
 * Reproducible OMP protocol startup verification (M0).
 *
 * Spawns the pinned-source OMP launcher (`~/.bun/bin/omp` -> the fixed
 * `upstream/oh-my-pi` checkout) in RPC mode, with every OMP state directory
 * redirected off the user's real `~/.omp`:
 *
 *   PI_CONFIG_DIR          config root dirname under home (default ".omp")
 *   PI_CODING_AGENT_DIR    full agent-dir override (db/sessions/models)
 *   OMP_DEV_LAUNCH_DIR     launcher working dir (default ~/.omp/.dev-cwd)
 *
 * Asserts the `ready` frame, `negotiate_protocol` -> v2, and
 * `get_available_models` returning the fixture's mock model. No prompt is
 * sent and no API key is configured, so no paid model call can occur.
 *
 * Exit 0 on all assertions passing; non-zero otherwise.
 *
 * Usage: node verify-rpc.mjs [--root DIR]
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const argRoot = process.argv.indexOf("--root");
const defaultRoot = join(__dirname, "..", "..", "..", ".dev-data", "omp-dev");
const ROOT = argRoot >= 0 ? process.argv[argRoot + 1] : defaultRoot;

const OMP = join(homedir(), ".bun", "bin", "omp");
const CONFIG_DIR_NAME = ".omp-m0-dev"; // relative to home
const AGENT_DIR = join(ROOT, "agent");
const LAUNCH_DIR = join(ROOT, "dev-cwd");
const FIXTURE = join(__dirname, "models.yml");

const PATH = [
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".pyenv", "shims"),
  join(homedir(), ".local", "bin"),
  join(homedir(), ".cargo", "bin"),
  join(homedir(), ".nvm", "versions", "node", "v24.14.0", "bin"),
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
].join(":");

const MODEL = "m0mock/local-model";
const READY_TIMEOUT_MS = 30_000;
const STEP_TIMEOUT_MS = 5_000;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (!existsSync(OMP)) fail(`omp launcher not found at ${OMP} (run bun setup in upstream/oh-my-pi)`);
if (!existsSync(FIXTURE)) fail(`models.yml fixture not found at ${FIXTURE}`);

mkdirSync(AGENT_DIR, { recursive: true });
mkdirSync(LAUNCH_DIR, { recursive: true });
writeFileSync(join(AGENT_DIR, "models.yml"), readFileSync(FIXTURE));

const env = {
  ...process.env,
  PATH,
  PI_CONFIG_DIR: CONFIG_DIR_NAME,
  PI_CODING_AGENT_DIR: AGENT_DIR,
  OMP_DEV_LAUNCH_DIR: LAUNCH_DIR,
};
// Ensure no real API key leaks into the child.
for (const k of Object.keys(env)) {
  if (/^(ANTHROPIC|OPENAI|GEMINI|GOOGLE|AWS|AZURE|COHERE|MISTRAL|GROQ|XAI|DEEPSEEK|PI_.*API).*(_API_KEY|KEY|TOKEN)/i.test(k)) {
    delete env[k];
  }
}

console.log(`omp launcher : ${OMP}`);
console.log(`agent dir    : ${AGENT_DIR}`);
console.log(`launch dir   : ${LAUNCH_DIR}`);
console.log(`config root  : ${join(homedir(), CONFIG_DIR_NAME)}`);
console.log(`model        : ${MODEL}`);

const child = spawn(OMP, ["--mode", "rpc", "--model", MODEL], {
  cwd: LAUNCH_DIR,
  env,
  stdio: ["pipe", "pipe", "pipe"],
});

const lines = [];
let stderr = "";
let settled = false;

const cleanup = () => {
  if (!child.killed) {
    child.kill("SIGTERM");
    setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 2000).unref();
  }
};
process.on("exit", cleanup);

child.stdout.on("data", (d) => {
  for (const p of d.toString().split("\n")) if (p.trim()) lines.push(p.trim());
});
child.stderr.on("data", (d) => { stderr += d.toString(); });

const waitFor = (pred, timeoutMs) =>
  new Promise((resolve) => {
    const start = Date.now();
    const poll = () => {
      const hit = lines.find(pred);
      if (hit) return resolve(hit);
      if (settled) return resolve(null);
      if (Date.now() - start > timeoutMs) return resolve(null);
      setTimeout(poll, 200);
    };
    poll();
  });

child.on("exit", (code) => { settled = true; });

try {
  const ready = await waitFor((l) => l.includes('"ready"'), READY_TIMEOUT_MS);
  if (!ready) fail(`no ready frame (stderr: ${stderr.slice(-300)})`);
  const readyObj = JSON.parse(ready);
  console.log(`ready        : ${ready}`);
  if (readyObj.type !== "ready") fail(`ready frame type mismatch: ${readyObj.type}`);
  if (!readyObj.supportedProtocolVersions?.includes(2)) fail("ready does not advertise protocol v2");

  child.stdin.write(JSON.stringify({ id: "m0", type: "negotiate_protocol", protocolVersion: 2 }) + "\n");
  const neg = await waitFor((l) => l.includes('"negotiate_protocol"') && l.includes('"response"'), STEP_TIMEOUT_MS);
  if (!neg) fail("no negotiate_protocol response");
  const negObj = JSON.parse(neg);
  console.log(`negotiate    : ${neg}`);
  if (negObj.command !== "negotiate_protocol" || negObj.success !== true) fail(`negotiate failed: ${neg}`);
  if (negObj.data?.protocolVersion !== 2) fail(`negotiate version != 2: ${neg}`);

  child.stdin.write(JSON.stringify({ id: "m1", type: "get_available_models" }) + "\n");
  const models = await waitFor((l) => l.includes('"get_available_models"'), STEP_TIMEOUT_MS);
  if (!models) fail("no get_available_models response");
  const modelsObj = JSON.parse(models);
  console.log(`models       : ${models.slice(0, 200)}...`);
  const ids = modelsObj.data?.models?.map((m) => m.id) ?? [];
  if (!ids.includes("local-model")) fail(`mock model not returned: ${JSON.stringify(ids)}`);

  console.log("PASS: ready + negotiate_protocol(v2) + get_available_models (no paid model call)");
  process.exit(0);
} catch (e) {
  fail(`exception: ${e.stack || e}`);
} finally {
  cleanup();
}
