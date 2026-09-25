#!/usr/bin/env node
/**
 * OMP Desktop patch-set tool for the pinned `upstream/oh-my-pi` submodule.
 *
 * The runtime source stays at the pinned submodule commit; everything this
 * project adds to it lives in `patches/oh-my-pi/*.patch` and is applied to a
 * scratch copy, so a developer never edits the submodule by hand and no
 * uncommitted change is left behind in it.
 *
 * Modes:
 *   --check
 *     Validate the manifest (base SHA, expected version, patch checksum) and
 *     prove the patch set applies cleanly to a fresh copy of the pinned
 *     source. Scratch is always removed.
 *   --apply [--out <dir>] [--prepare-build] [--verify]
 *     Produce the patched tree. Without `--out` the tree is a temporary
 *     directory: `--verify` then proves it in place and it is removed again.
 *     With `--out` the tree is kept at that path for a later build; `--out`
 *     must not exist yet (or be an empty directory) and is refused when it is a
 *     symlink, the source checkout, the repository root, or an ancestor of it.
 *     The path is resolved to its canonical form first: the aliases the
 *     platform itself installs directly below the filesystem root (macOS
 *     `/var`, `/tmp`, `/etc` -> `/private/...`) are followed, every other
 *     symlinked parent is refused, and the reported tree is that canonical
 *     path.
 *     `--prepare-build` copies the dependency payload (`node_modules`, built
 *     natives, generated tool views) the same way the per-worktree setup does,
 *     which is what makes the tree runnable without installing anything.
 *
 * Everything is written below the scratch tree; no network access and no paid
 * or remote model is involved. Only paths, hashes, and command names are
 * printed — never environment values.
 *
 * Usage:
 *   node scripts/omp-patch.mjs --check
 *   node scripts/omp-patch.mjs --apply --out /tmp/omp-patched --prepare-build --verify
 *   node scripts/omp-patch.mjs --apply --prepare-build --verify --json
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..");
const defaultManifest = join(appRoot, "patches", "oh-my-pi", "manifest.json");
/** The only manifest schema this tool understands; anything else fails closed. */
const SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;

/** Variables that would steer OMP back to the user's real configuration. */
const STEER_VARS = [
  "OMP_PROFILE",
  "PI_PROFILE",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "PI_CODING_AGENT_SESSION_DIR",
];
/** Never inherited by a probe child: they belong to the user, not to a test. */
const CREDENTIAL_RE =
  /(API_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIAL|_AUTH|AWS_ACCESS|AWS_SECRET|AWS_SESSION|BEDROCK_|GEMINI_|GOOGLE_|OPENAI_|ANTHROPIC_|AZURE_|COHERE_|MISTRAL_|GROQ_|XAI_|DEEPSEEK_|COPILOT_|CODEX_)/i;
/** Untracked payload a prepared tree needs to run without installing again. */
const BUILD_PAYLOAD = [
  "node_modules",
  "packages/natives/native",
  "packages/coding-agent/src/export/html/tool-views.generated.js",
];
/** Ignored/expensive caches that are never part of a build payload. */
const BUILD_PAYLOAD_SKIP = ["node_modules/.cache", "target"];

class PatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "PatchError";
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitRaw(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw new PatchError(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new PatchError(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

function git(args, cwd) {
  return gitRaw(args, cwd).trim();
}

/** Read and validate the manifest; the patch file must sit next to it. */
export function loadManifest(manifestPath = defaultManifest) {
  const resolvedManifest = resolve(manifestPath);
  if (lstatSync(resolvedManifest).isSymbolicLink()) {
    throw new PatchError(`manifest must not be a symlink: ${resolvedManifest}`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(resolvedManifest, "utf8"));
  } catch (error) {
    throw new PatchError(`manifest is not valid JSON: ${error.message}`);
  }
  for (const [field, value] of [
    ["schemaVersion", manifest.schemaVersion],
    ["patchLevel", manifest.patchLevel],
    ["base.sha", manifest.base?.sha],
    ["base.version", manifest.base?.version],
    ["patch.file", manifest.patch?.file],
    ["patch.sha256", manifest.patch?.sha256],
  ]) {
    if (typeof value !== "string" && typeof value !== "number") {
      throw new PatchError(`manifest field ${field} is missing`);
    }
  }
  if (manifest.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA_VERSION) {
    throw new PatchError(
      `unsupported manifest schemaVersion ${JSON.stringify(manifest.schemaVersion)}; this tool supports ${SUPPORTED_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(manifest.capabilities) || manifest.capabilities.length === 0) {
    throw new PatchError("manifest.capabilities must list at least one capability id");
  }
  if (!/^[0-9a-f]{40}$/.test(manifest.base.sha)) {
    throw new PatchError(`manifest.base.sha is not a full commit id: ${manifest.base.sha}`);
  }

  const patchesDir = dirname(resolvedManifest);
  const patchPath = resolve(patchesDir, manifest.patch.file);
  if (patchPath !== join(patchesDir, manifest.patch.file) || !patchPath.startsWith(patchesDir + sep)) {
    throw new PatchError(`patch file must be inside ${patchesDir}`);
  }
  if (!existsSync(patchPath)) throw new PatchError(`patch file is missing: ${patchPath}`);
  if (lstatSync(patchPath).isSymbolicLink()) throw new PatchError(`patch file must not be a symlink: ${patchPath}`);

  const actualSha = sha256File(patchPath);
  if (actualSha !== manifest.patch.sha256) {
    throw new PatchError(`patch checksum mismatch: manifest ${manifest.patch.sha256}, file ${actualSha}`);
  }
  return { manifest, manifestPath: resolvedManifest, patchesDir, patchPath };
}

/** The source checkout must be the exact commit the manifest patches. */
export function validateSource(sourceDir, manifest) {
  const requested = resolve(sourceDir);
  // Canonicalize before anything is compared against the checkout: `--source`
  // may name a symlink to it, and the containment checks downstream must
  // compare against the directory the files actually live in.
  const source = existsSync(requested) ? realpathSync(requested) : requested;
  if (!existsSync(join(source, "packages", "coding-agent", "scripts", "omp"))) {
    throw new PatchError(`source does not look like the OMP checkout: ${source}`);
  }
  const head = git(["rev-parse", "HEAD"], source);
  if (head !== manifest.base.sha) {
    throw new PatchError(`source HEAD is ${head}, manifest patches ${manifest.base.sha}`);
  }
  const packagePath = join(source, "packages", "utils", "package.json");
  let version;
  try {
    version = JSON.parse(readFileSync(packagePath, "utf8")).version;
  } catch (error) {
    throw new PatchError(`cannot read the pinned version from ${packagePath}: ${error.message}`);
  }
  if (version !== manifest.base.version) {
    throw new PatchError(`source version is ${version}, manifest expects ${manifest.base.version}`);
  }
  const dirty = git(["status", "--porcelain"], source);
  if (dirty !== "") {
    throw new PatchError(`source checkout has uncommitted changes; refusing to copy it:\n${dirty}`);
  }
  return { source, head, version };
}

/** The closest existing directory at or above `target`. */
function nearestExistingParent(target) {
  let current = target;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * True when a symlinked path component is one the platform itself installed:
 * a direct child of the filesystem root, owned by root.
 *
 * macOS reaches `/var`, `/tmp`, and `/etc` through root-owned symlinks into
 * `/private`, so `--out /tmp/tree` — and `tmpdir()`, which reports
 * `/var/folders/…` there — always traverses a link. Refusing those would break
 * every ordinary invocation on that platform, while following them is safe: an
 * unprivileged caller cannot create, replace, or delete an entry directly below
 * `/`. Every other link, at any depth or with any other owner, is
 * caller-reachable and stays refused. A platform that does not report an owner
 * is treated as untrusted.
 */
export function isTrustedRootAlias(componentPath, stats) {
  return (
    stats?.isSymbolicLink?.() === true &&
    dirname(componentPath) === parse(componentPath).root &&
    typeof stats.uid === "number" &&
    stats.uid === 0
  );
}

/**
 * Canonicalize the closest existing ancestor of a scratch target one component
 * at a time, asking `trustAlias` about every symlink in the chain.
 *
 * `realpathSync` alone cannot be used here: it erases where the links were, so
 * comparing its result to the caller's spelling cannot tell a platform alias
 * from a link the caller planted. Walking the components keeps that
 * distinction, and the returned canonical path is what `mkdir`, the copy, and
 * the failure cleanup all operate on. A link the policy rejects aborts before
 * anything is created, copied, or deleted — including the platform aliases
 * themselves when the policy does not name them.
 */
export function canonicalizeAncestor(existingParent, trustAlias = isTrustedRootAlias) {
  const root = parse(existingParent).root;
  let canonical = root;
  for (const part of relative(root, existingParent).split(sep).filter((entry) => entry !== "")) {
    const component = join(canonical, part);
    const stats = lstatSync(component);
    if (stats.isSymbolicLink() && !trustAlias(component, stats)) {
      throw new PatchError(`scratch target must not be reached through a symlink: ${component}`);
    }
    canonical = realpathSync(component);
  }
  return canonical;
}

/**
 * Canonical form of one of the paths a scratch target must never be or hold.
 * `source` arrives canonical from `validateSource`; the repository roots and
 * the invoking cwd are resolved here, so a lexically different but physically
 * identical spelling cannot slip past the equality and ancestor checks below.
 * A boundary that cannot be resolved (a deleted cwd) keeps its lexical form,
 * which the same checks still cover.
 */
function canonicalBoundary(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Resolve a caller-provided scratch target and refuse anything this script may
 * not create, fill, or later delete.
 *
 * Everything runs on the canonical path: the nearest existing parent is
 * canonicalized component by component first, so a symlinked parent cannot make
 * `mkdir`, the copy, and the failure cleanup operate on whatever the link
 * points at (the example that motivated this: `--out /tmp/link/new-tree` with
 * `link -> /protected`). A parent reached through an untrusted link is refused
 * outright — the caller must pass the real path or a platform alias — and the
 * protected-path and emptiness checks then apply to the canonical target the
 * script will actually use.
 */
function resolveScratchTarget(target, source) {
  const resolvedTarget = resolve(target);
  if (resolvedTarget === parse(resolvedTarget).root) {
    throw new PatchError("scratch target must not be the filesystem root");
  }
  if (existsSync(resolvedTarget) && lstatSync(resolvedTarget).isSymbolicLink()) {
    throw new PatchError(`scratch target must not be a symlink: ${resolvedTarget}`);
  }
  const existingParent = nearestExistingParent(resolvedTarget);
  let canonicalParent;
  try {
    canonicalParent = canonicalizeAncestor(existingParent);
  } catch (error) {
    if (error instanceof PatchError) throw error;
    throw new PatchError(`cannot resolve ${existingParent}: ${error.message}`);
  }
  const scrubbed = relative(existingParent, resolvedTarget).split(sep);
  if (scrubbed.includes("..")) {
    throw new PatchError(`scratch target escapes its parent: ${resolvedTarget}`);
  }
  const canonicalTarget = join(canonicalParent, ...scrubbed);

  const forbidden = [source, repoRoot, appRoot, process.cwd()].map(canonicalBoundary);
  for (const path of forbidden) {
    if (canonicalTarget === path) throw new PatchError(`scratch target must not be ${path}`);
    if (path.startsWith(canonicalTarget + sep)) {
      throw new PatchError(`scratch target must not contain ${path}`);
    }
  }
  if (canonicalTarget.startsWith(source + sep)) {
    throw new PatchError(`scratch target must not live inside the source checkout: ${canonicalTarget}`);
  }
  if (existsSync(canonicalTarget)) {
    const stats = lstatSync(canonicalTarget);
    if (stats.isSymbolicLink()) throw new PatchError(`scratch target must not be a symlink: ${canonicalTarget}`);
    if (!stats.isDirectory()) throw new PatchError(`scratch target exists and is not a directory: ${canonicalTarget}`);
    if (readdirSync(canonicalTarget).length > 0) {
      throw new PatchError(`scratch target exists and is not empty: ${canonicalTarget}`);
    }
  }
  return canonicalTarget;
}

/** Copy exactly the tracked tree, so the scratch carries no local edits. */
function copyTrackedTree(source, tree) {
  const files = gitRaw(["ls-files", "-z"], source).split("\0").filter(Boolean);
  if (files.length === 0) throw new PatchError(`source tracks no files: ${source}`);
  for (const file of files) {
    const from = join(source, file);
    const to = join(tree, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, force: true });
  }
  return files.length;
}

/**
 * Copy one build-payload entry.
 *
 * `verbatimSymlinks` is load-bearing: without it Node rewrites every symlink
 * into an absolute path pointing back at the *source* checkout, and the copied
 * workspace links (`node_modules/@oh-my-pi/* -> ../../packages/*`) would then
 * resolve to the unpatched packages — a tree that looks patched and runs the
 * old code.
 */
function copyInto(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    force: true,
    filter: (entry) => !BUILD_PAYLOAD_SKIP.some((skip) => entry.endsWith(`/${skip}`)),
  });
}

/** Copy the untracked payload that makes the tree runnable (`--prepare-build`). */
function copyBuildPayload(source, tree) {
  const copied = [];
  const candidates = [...BUILD_PAYLOAD];
  const packagesDir = join(source, "packages");
  if (existsSync(packagesDir)) {
    for (const entry of readdirSync(packagesDir)) {
      candidates.push(`packages/${entry}/node_modules`);
    }
  }
  for (const relativePath of candidates) {
    const from = join(source, relativePath);
    if (!existsSync(from)) continue;
    const stats = lstatSync(from);
    if (stats.isSymbolicLink()) continue;
    if (stats.isDirectory() && readdirSync(from).length === 0) continue;
    copyInto(from, join(tree, relativePath));
    copied.push(relativePath);
  }
  return copied;
}

/** Apply the patch set inside the scratch tree. */
function applyPatchSet(tree, patchPath) {
  git(["apply", "--check", patchPath], tree);
  git(["apply", patchPath], tree);
  // Reversing the exact patch must be possible: that proves the tree carries
  // the patch and nothing else.
  git(["apply", "--check", "--reverse", patchPath], tree);
}

/** Environment for a probe child: isolated config, no credentials, no proxies. */
function isolatedEnv(runRoot) {
  const env = {};
  for (const key of Object.keys(process.env)) {
    if (STEER_VARS.includes(key) || CREDENTIAL_RE.test(key)) continue;
    env[key] = process.env[key];
  }
  env.HOME = join(runRoot, "home");
  env.PI_CONFIG_DIR = `.omp-desktop-patch-${process.pid}`;
  env.PI_CODING_AGENT_DIR = join(runRoot, "agent");
  env.OMP_DEV_LAUNCH_DIR = join(runRoot, "cwd");
  env.PATH = [join(homedir(), ".bun", "bin"), dirname(process.execPath), env.PATH ?? ""]
    .filter(Boolean)
    .join(":");
  mkdirSync(env.HOME, { recursive: true });
  mkdirSync(env.OMP_DEV_LAUNCH_DIR, { recursive: true });
  mkdirSync(env.PI_CODING_AGENT_DIR, { recursive: true });
  return env;
}

/**
 * True when `pid` is safe to use as a process-group target for `kill(2)`.
 *
 * `process.kill(-pid, …)` negates its argument, and the degenerate targets are
 * catastrophic rather than merely useless: `-0` would signal *our own* group
 * (killing this script) and `-1` every process the user is permitted to signal.
 * Both are refused before the negation is applied, exactly as upstream does
 * (`upstream/oh-my-pi/packages/coding-agent/src/eval/kernel-base.ts`).
 */
export function isSignalableProcessGroup(pid) {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1;
}

/**
 * Run a child in its own process group and reap the whole group once it exits
 * or times out.
 *
 * `verifyPatchedTree` runs the OMP launcher and a `bun test` pass, and those
 * spawn fixtures with their own children (MCP servers, kernels). A plain
 * `spawnSync` timeout would kill only the direct child and leave the rest
 * running, so this escalates SIGTERM -> SIGKILL on the group and sweeps the
 * group again after the direct child closes.
 *
 * A spawn failure is the other terminal path: Node reports ENOENT/EACCES as an
 * `error` event with `pid === undefined` (or, if the process could not be
 * killed, for a child that did start), so the group is killed when there is one
 * and skipped otherwise, and either way the timeout is cleared and the call
 * settles at once.
 */
export function runReaped(command, args, options = {}) {
  const { cwd, env, timeoutMs = 0 } = options;
  return new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({ status: null, signal: null, stdout: "", stderr: "", timedOut: false, error });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const killGroup = (signal) => {
      if (!isSignalableProcessGroup(child.pid)) return false;
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        // The group is already empty (or was never created): nothing to reap.
        return false;
      }
    };
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup("SIGTERM");
            setTimeout(() => killGroup("SIGKILL"), 2_000).unref();
          }, timeoutMs)
        : undefined;
    timer?.unref?.();
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const settle = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolvePromise(result);
    };
    child.on("error", (error) => {
      // A child that did start can still report an error (for example when it
      // could not be killed or was aborted): sweep its group before settling.
      // A spawn failure has no pid, so the guard makes this a no-op.
      killGroup("SIGKILL");
      settle({ status: null, signal: null, stdout, stderr, timedOut, error });
    });
    child.on("close", (status, signal) => {
      // The direct child is gone, but its descendants may still hold the group.
      killGroup("SIGKILL");
      settle({ status, signal, stdout, stderr, timedOut, error: null });
    });
  });
}

function bunBinary() {
  const override = process.env.BUN_BINARY;
  if (override) return override;
  const candidate = join(homedir(), ".bun", "bin", "bun");
  return existsSync(candidate) ? candidate : "bun";
}

/**
 * Prove the prepared tree is the patched runtime: the pinned launcher reports
 * the pinned version and the agent + RPC host-tool suites pass inside it.
 */
export async function verifyPatchedTree(tree, manifest) {
  const runRoot = mkdtempSync(join(tmpdir(), "omp-patch-verify-"));
  try {
    const launcher = join(tree, "packages", "coding-agent", "scripts", "omp");
    const probe = await runReaped(launcher, ["--version"], {
      cwd: join(runRoot, "cwd"),
      env: isolatedEnv(runRoot),
      timeoutMs: 180_000,
    });
    const reported = /^omp\/(.+)$/m.exec(probe.stdout)?.[1] ?? null;
    if (probe.status !== 0 || reported !== manifest.base.version) {
      throw new PatchError(
        `patched launcher reported ${reported ?? `(exit ${probe.status}${probe.timedOut ? ", timed out" : ""})`}, expected ${manifest.base.version}`,
      );
    }

    const tests = await runReaped(
      bunBinary(),
      ["test", "packages/agent/test/agent-loop.test.ts", "packages/coding-agent/test/rpc-host-tools.test.ts"],
      { cwd: tree, env: isolatedEnv(runRoot), timeoutMs: 900_000 },
    );
    // Bun prints its summary on stderr when stdout is not a TTY; read both and
    // report the tail that carries the counts.
    const output = `${tests.stdout}\n${tests.stderr}`;
    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
    const counts = lines.filter((line) => /^\d+ (pass|fail)$/.test(line) || line.startsWith("Ran ")).join(", ");
    if (tests.status !== 0) {
      throw new PatchError(
        `patched suites failed (exit ${tests.status}${tests.timedOut ? ", timed out" : ""}): ${counts || lines.slice(-1)[0] || "no output"}`,
      );
    }
    return { version: reported, testsSummary: counts };
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

/**
 * Prepare a patched tree.
 *
 * Returns `{ tree, manifest, files, payload, applied, verify, cleanup }`;
 * `cleanup()` is idempotent and is the caller's responsibility when `keep` is
 * true. With `keep: false` the tree is removed before returning.
 */
export async function preparePatchedTree(options = {}) {
  const { manifest, manifestPath, patchPath } = loadManifest(options.manifestPath ?? defaultManifest);
  const { source } = validateSource(options.source ?? join(repoRoot, "upstream", "oh-my-pi"), manifest);

  const keep = options.keep === true;
  let tree = null;
  let ownedScratch = true;
  const cleanup = () => {
    if (tree && existsSync(tree)) rmSync(tree, { recursive: true, force: true });
    tree = null;
  };
  try {
    if (options.out === undefined) {
      tree = mkdtempSync(join(tmpdir(), "omp-patch-"));
      ownedScratch = true;
    } else {
      tree = resolveScratchTarget(options.out, source);
      mkdirSync(tree, { recursive: true });
      ownedScratch = true;
    }

    const files = copyTrackedTree(source, tree);
    applyPatchSet(tree, patchPath);
    const payload = options.prepareBuild === true ? copyBuildPayload(source, tree) : [];
    const verify = options.verify === true ? await verifyPatchedTree(tree, manifest) : null;
    if (!keep) {
      cleanup();
      return { tree: null, manifest, manifestPath, patchPath, files, payload, verify, cleanup };
    }
    const prepared = tree;
    ownedScratch = false;
    return { tree: prepared, manifest, manifestPath, patchPath, files, payload, verify, cleanup };
  } catch (error) {
    // Failure paths never leave a half-applied tree behind, whether the target
    // was ours or a caller-provided `--out` we created.
    if (ownedScratch) cleanup();
    throw error;
  }
}

function parseArgs(argv) {
  const options = { mode: null, out: undefined, prepareBuild: false, verify: false, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.mode = "check";
    else if (arg === "--apply") options.mode = "apply";
    else if (arg === "--prepare-build") options.prepareBuild = true;
    else if (arg === "--verify") options.verify = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--out" || arg === "--manifest" || arg === "--source") {
      const value = argv[index + 1];
      // A value is a path; a following flag is a missing value, not a path that
      // happens to start with a dash (`./-name` spells such a path). Consuming
      // the flag made `--out --json` create `$PWD/--json` and fill it with the
      // whole tree, and reported the wrong argument for `--out --source foo`.
      if (value === undefined || value.startsWith("-")) throw new PatchError(`${arg} requires a value`);
      index += 1;
      if (arg === "--out") options.out = value;
      else if (arg === "--manifest") options.manifestPath = value;
      else options.source = value;
    }
    else if (arg === "--help" || arg === "-h") options.mode = "help";
    else throw new PatchError(`unknown argument: ${arg}`);
  }
  if (!options.mode) throw new PatchError("expected --check or --apply");
  if (options.mode === "check" && (options.out !== undefined || options.prepareBuild || options.verify)) {
    throw new PatchError("--check takes no --out/--prepare-build/--verify");
  }
  if (options.verify && !options.prepareBuild) {
    throw new PatchError("--verify needs --prepare-build (the patched suites run against the copied payload)");
  }
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`OMP-PATCH-FAIL ${error.message}`);
    return 2;
  }
  if (options.mode === "help") {
    const header = readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 30);
    console.log(header.map((line) => line.replace(/^\s*\/?\*+\s?/, "").trimEnd()).join("\n").trim());
    return 0;
  }

  const keep = options.mode === "apply" && options.out !== undefined;
  try {
    const result = await preparePatchedTree({
      manifestPath: options.manifestPath,
      source: options.source,
      out: options.out,
      prepareBuild: options.prepareBuild,
      verify: options.mode === "apply" && options.verify,
      keep,
    });
    const report = {
      mode: options.mode,
      patchLevel: result.manifest.patchLevel,
      baseSha: result.manifest.base.sha,
      patch: relative(repoRoot, result.patchPath),
      patchSha256: result.manifest.patch.sha256,
      capabilities: result.manifest.capabilities,
      files: result.files,
      payload: result.payload,
      verify: result.verify,
      tree: result.tree,
    };
    if (options.json) {
      console.log(JSON.stringify(report));
    } else {
      console.log(`OMP-PATCH-OK ${report.patchLevel} (base ${report.baseSha})`);
      console.log(`  patch      : ${report.patch} (sha256 ${report.patchSha256})`);
      console.log(`  capabilities: ${report.capabilities.join(", ")}`);
      console.log(`  tracked files copied: ${report.files}`);
      if (result.payload.length > 0) console.log(`  build payload: ${result.payload.join(", ")}`);
      if (result.verify) console.log(`  verify     : launcher ${result.verify.version}, ${result.verify.testsSummary}`);
      if (result.tree) console.log(`  tree       : ${result.tree}`);
    }
    return 0;
  } catch (error) {
    console.error(`OMP-PATCH-FAIL ${error.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`OMP-PATCH-FAIL ${error?.message ?? error}`);
      process.exit(1);
    },
  );
}

export { BUILD_PAYLOAD, PatchError };
