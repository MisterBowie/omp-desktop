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
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..");
const defaultManifest = join(appRoot, "patches", "oh-my-pi", "manifest.json");

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
  const source = resolve(sourceDir);
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

/**
 * A scratch target is refused unless it is a path this script may create or
 * fill: never a symlink, never the source, the repository, their ancestors, or
 * an existing non-empty directory.
 */
function assertSafeScratchTarget(target, source) {
  const resolvedTarget = resolve(target);
  if (resolvedTarget === parse(resolvedTarget).root) {
    throw new PatchError("scratch target must not be the filesystem root");
  }
  const forbidden = [source, repoRoot, appRoot, process.cwd()].map((path) => resolve(path));
  for (const path of forbidden) {
    if (resolvedTarget === path) throw new PatchError(`scratch target must not be ${path}`);
    if (path.startsWith(resolvedTarget + sep)) {
      throw new PatchError(`scratch target must not contain ${path}`);
    }
  }
  if (resolvedTarget.startsWith(source + sep)) {
    throw new PatchError(`scratch target must not live inside the source checkout: ${resolvedTarget}`);
  }
  if (existsSync(resolvedTarget)) {
    const stats = lstatSync(resolvedTarget);
    if (stats.isSymbolicLink()) throw new PatchError(`scratch target must not be a symlink: ${resolvedTarget}`);
    if (!stats.isDirectory()) throw new PatchError(`scratch target exists and is not a directory: ${resolvedTarget}`);
    if (readdirSync(resolvedTarget).length > 0) {
      throw new PatchError(`scratch target exists and is not empty: ${resolvedTarget}`);
    }
  }
  return resolvedTarget;
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
export function verifyPatchedTree(tree, manifest) {
  const runRoot = mkdtempSync(join(tmpdir(), "omp-patch-verify-"));
  try {
    const launcher = join(tree, "packages", "coding-agent", "scripts", "omp");
    const probe = spawnSync(launcher, ["--version"], {
      cwd: join(runRoot, "cwd"),
      env: isolatedEnv(runRoot),
      encoding: "utf8",
      timeout: 180_000,
    });
    const reported = /^omp\/(.+)$/m.exec(probe.stdout ?? "")?.[1] ?? null;
    if (probe.status !== 0 || reported !== manifest.base.version) {
      throw new PatchError(
        `patched launcher reported ${reported ?? `(exit ${probe.status})`}, expected ${manifest.base.version}`,
      );
    }

    const tests = spawnSync(
      bunBinary(),
      ["test", "packages/agent/test/agent-loop.test.ts", "packages/coding-agent/test/rpc-host-tools.test.ts"],
      { cwd: tree, env: isolatedEnv(runRoot), encoding: "utf8", timeout: 900_000 },
    );
    // Bun prints its summary on stderr when stdout is not a TTY; read both and
    // report the tail that carries the counts.
    const output = `${tests.stdout ?? ""}\n${tests.stderr ?? ""}`;
    const lines = output.split("\n").map((line) => line.trim()).filter(Boolean);
    const counts = lines.filter((line) => /^\d+ (pass|fail)$/.test(line) || line.startsWith("Ran ")).join(", ");
    if (tests.status !== 0) {
      throw new PatchError(`patched suites failed (exit ${tests.status}): ${counts || lines.slice(-1)[0] || "no output"}`);
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
export function preparePatchedTree(options = {}) {
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
      tree = assertSafeScratchTarget(options.out, source);
      mkdirSync(tree, { recursive: true });
      ownedScratch = true;
    }

    const files = copyTrackedTree(source, tree);
    applyPatchSet(tree, patchPath);
    const payload = options.prepareBuild === true ? copyBuildPayload(source, tree) : [];
    const verify = options.verify === true ? verifyPatchedTree(tree, manifest) : null;
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
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--manifest") options.manifestPath = argv[++index];
    else if (arg === "--source") options.source = argv[++index];
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

function main(argv) {
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
    const result = preparePatchedTree({
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
  process.exit(main(process.argv.slice(2)));
}

export { BUILD_PAYLOAD, PatchError };
