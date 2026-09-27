#!/usr/bin/env node
/**
 * Bundled OMP sidecar build entry (M5/T20-R4B, ADR 0307).
 *
 * Produces the one runtime a packaged build may execute, plus the provenance
 * manifest a packaged build verifies it against. Everything is derived from the
 * controlled OMP fork checkout and the controlled patch manifest — nothing is
 * hand-recorded, and a checkout that does not match the manifest is refused
 * before any compiler runs:
 *
 *   - the `origin` remote must normalize to `manifest.fork.repository`
 *     (SSH, `ssh://`, and HTTPS spellings compare equal),
 *   - HEAD must be exactly `manifest.fork.commit`,
 *   - the worktree must be clean (tracked files; build output is ignored),
 *   - `packages/utils/package.json` must report `manifest.base.version`,
 *   - `git diff --name-only <base.sha> HEAD` must be exactly the manifest's file
 *     list, and `git apply --check --reverse` must accept the controlled patch
 *     — together, that proves HEAD is `base + patch level` and nothing else,
 *   - the built binary must report `omp/<base.version>` when probed.
 *
 * The compile itself is OMP's own `packages/coding-agent/scripts/build-binary.ts`
 * (Bun single-file compile), so the artifact is the official one for this
 * checkout rather than a desktop-side reimplementation.
 *
 * Modes:
 *   --check      Validate the manifest and the fork checkout; build nothing.
 *   --build      Validate, compile, copy the artifact and the tool gate into the
 *                output directory, probe the artifact's version, and write
 *                `provenance.json` next to it.
 *   --preflight  The release gate every packaging command runs. Validates the
 *                controlled checkout, then makes the artifact for the release
 *                target current: it builds when the target is this host, and
 *                otherwise requires an artifact staged for exactly that
 *                platform/architecture to pass the packaged application's own
 *                verification. A non-host target never reuses the host binary.
 *
 * Usage:
 *   node scripts/omp-sidecar.mjs --check [--source <dir>] [--json]
 *   node scripts/omp-sidecar.mjs --build [--source <dir>] [--out <dir>] [--json]
 *   node scripts/omp-sidecar.mjs --preflight [--platform <p>] [--arch <a>] [--source <dir>] [--json]
 *
 * Never writes a credential, and never contacts a model. The output directory
 * is not committed (see `apps/desktop/resources/omp-runtime/.gitignore`).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  PatchError,
  bunBinary,
  isolatedEnv,
  loadManifest,
  runReaped,
} from "./omp-patch.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "..");
const defaultManifest = join(appRoot, "patches", "oh-my-pi", "manifest.json");
const defaultOut = join(appRoot, "apps", "desktop", "resources", "omp-runtime");
const gateSource = join(appRoot, "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts");

/** The only provenance schema this entry point writes. */
export const PROVENANCE_SCHEMA = "omp-desktop.bundled-sidecar/3";

/**
 * Precompiled bytecode stays on for the shipped sidecar.
 *
 * It is the upstream release behavior and the fast boot path (`--version`
 * 256 ms -> 30 ms), and it is *not* what made earlier builds differ: once the
 * native-addon archive was made deterministic, builds of one fork commit with
 * bytecode on are bit-identical — while with the archive left alone they differ
 * with bytecode on and off alike (control builds in
 * `docs/validation/M6-r4-3-reproducible-sidecar.md`). The mode is still stated
 * explicitly instead of inherited from a default, so the artifact's build mode
 * is a property of this entry, and `build.bytecode` records it.
 */
export const SIDECAR_BYTECODE = true;

/**
 * The fork build entry's switches for one compile mode.
 *
 * The fork's `build-binary.ts` accepts exactly `--bytecode`/`--no-bytecode` and
 * refuses anything else, so a spelling drift fails the build instead of
 * silently shipping the default.
 */
export function buildBinaryArgs(bytecode) {
  return ["scripts/build-binary.ts", bytecode ? "--bytecode" : "--no-bytecode"];
}

/** The tool gate's path inside the output directory (mirrors the app's resolver). */
const GATE_RELATIVE_PATH = join("extensions", "omp-desktop-gate.js");

const HASH_CHUNK_BYTES = 1024 * 1024;

/** SHA-256 of a file, read in bounded chunks so a large binary is never buffered whole. */
export function sha256OfFile(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** The executable name for a platform; Bun appends `.exe` on Windows. */
export function sidecarFilename(platform) {
  return platform === "win32" ? "omp.exe" : "omp";
}

/**
 * Canonical form of a git remote for comparison.
 *
 * Kept in step with the runtime package's copy by
 * `apps/desktop/test/omp-sidecar.test.mjs`, which compares both over the same
 * spellings.
 */
export function normalizeRepositoryUrl(url) {
  const trimmed = String(url ?? "").trim();
  const match =
    /^git@([^:/]+):(.+)$/.exec(trimmed) ??
    /^ssh:\/\/git@([^:/]+)\/(.+)$/.exec(trimmed) ??
    /^https?:\/\/([^/]+)\/(.+)$/.exec(trimmed);
  if (!match) return null;
  const host = match[1];
  const path = match[2].replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !path) return null;
  return `${host.toLowerCase()}/${path.toLowerCase()}`;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw new PatchError(`git ${args.join(" ")} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new PatchError(`git ${args.join(" ")} exited ${result.status}: ${(result.stderr ?? "").trim()}`);
  }
  return (result.stdout ?? "").trim();
}

/**
 * Prove the fork checkout is exactly the manifest's `base + patch level`.
 *
 * Returns `{ source, head, version, remote }`; throws `PatchError` otherwise.
 */
export function validateForkCheckout(sourceDir, manifest, patchPath) {
  const requested = resolve(sourceDir);
  if (!existsSync(requested)) throw new PatchError(`source checkout does not exist: ${requested}`);
  const source = realpathSync(requested);
  if (!existsSync(join(source, "packages", "coding-agent", "scripts", "build-binary.ts"))) {
    throw new PatchError(`source does not look like the OMP checkout: ${source}`);
  }

  const expectedRemote = normalizeRepositoryUrl(manifest.fork.repository);
  if (expectedRemote === null) {
    throw new PatchError(`manifest.fork.repository is not a usable git URL: ${manifest.fork.repository}`);
  }
  let remote;
  try {
    remote = git(["remote", "get-url", "origin"], source);
  } catch (error) {
    throw new PatchError(`source has no usable origin remote: ${error.message}`);
  }
  const actualRemote = normalizeRepositoryUrl(remote);
  if (actualRemote !== expectedRemote) {
    throw new PatchError(
      `source origin is ${actualRemote ?? remote}, expected ${expectedRemote} (${manifest.fork.repository})`,
    );
  }

  const head = git(["rev-parse", "HEAD"], source);
  if (head !== manifest.fork.commit) {
    throw new PatchError(
      `source HEAD is ${head}, the manifest pins fork commit ${manifest.fork.commit}`,
    );
  }

  const dirty = git(["status", "--porcelain"], source);
  if (dirty !== "") {
    throw new PatchError(`source checkout has uncommitted changes; refusing to build it:\n${dirty}`);
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

  git(["cat-file", "-e", `${manifest.base.sha}^{commit}`], source);
  const changed = git(["diff", "--name-only", manifest.base.sha, "HEAD"], source)
    .split("\n")
    .filter(Boolean)
    .sort();
  const declared = [...manifest.files].sort();
  if (JSON.stringify(changed) !== JSON.stringify(declared)) {
    throw new PatchError(
      `source differs from base ${manifest.base.sha} in ${changed.length} file(s), the manifest declares ${declared.length}`,
    );
  }
  // Reversing the controlled patch inside this checkout proves the tree is the
  // patch's result and not some other edit set that happens to touch the same
  // files.
  git(["apply", "--check", "--reverse", patchPath], source);

  return { source, head, version, remote: actualRemote };
}

/** Resolve and create the output directory, refusing unsafe targets. */
function resolveOutDir(target, source) {
  const out = resolve(target);
  if (out === resolve("/")) throw new PatchError("output directory must not be the filesystem root");
  if (existsSync(out) && lstatSync(out).isSymbolicLink()) {
    throw new PatchError(`output directory must not be a symlink: ${out}`);
  }
  if (existsSync(out) && !lstatSync(out).isDirectory()) {
    throw new PatchError(`output path exists and is not a directory: ${out}`);
  }
  if (out === source || out.startsWith(source + sep)) {
    throw new PatchError(`output directory must not live inside the source checkout: ${out}`);
  }
  for (const boundary of [repoRoot, appRoot]) {
    if (out === boundary || boundary.startsWith(out + sep)) {
      throw new PatchError(`output directory must not be or contain ${boundary}`);
    }
  }
  mkdirSync(out, { recursive: true });
  return out;
}

/** The desktop version the provenance manifest records. */
function desktopVersion() {
  return JSON.parse(readFileSync(join(appRoot, "apps", "desktop", "package.json"), "utf8")).version;
}

/**
 * Build the sidecar from a validated fork checkout.
 *
 * Returns `{ out, provenance, files }`; the provenance document is also written
 * to `<out>/provenance.json`.
 */
export async function buildSidecar(options = {}) {
  const { manifest, patchPath } = loadManifest(options.manifestPath ?? defaultManifest);
  const sourceDir = options.source ?? process.env.OMP_SIDECAR_SOURCE ?? join(repoRoot, "..", "oh-my-pi");
  const info = validateForkCheckout(sourceDir, manifest, patchPath);
  const out = resolveOutDir(options.out ?? defaultOut, info.source);

  const filename = sidecarFilename(process.platform);
  const packageDir = join(info.source, "packages", "coding-agent");
  const runRoot = mkdtempSync(join(tmpdir(), "omp-sidecar-"));
  try {
    const env = isolatedEnv(runRoot);
    const build = await runReaped(bunBinary(), buildBinaryArgs(SIDECAR_BYTECODE), {
      cwd: packageDir,
      env,
      timeoutMs: 1_800_000,
    });
    if (build.status !== 0) {
      const tail = `${build.stdout}\n${build.stderr}`.trim().split("\n").slice(-4).join(" | ");
      throw new PatchError(
        `sidecar build failed (exit ${build.status}${build.timedOut ? ", timed out" : ""}): ${tail}`,
      );
    }
    const produced = [join(packageDir, "dist", "omp"), join(packageDir, "dist", "omp.exe")].find(
      (candidate) => existsSync(candidate),
    );
    if (!produced) {
      throw new PatchError("the OMP build did not produce packages/coding-agent/dist/omp");
    }

    const binaryPath = join(out, filename);
    cpSync(produced, binaryPath, { force: true, dereference: false });
    chmodSync(binaryPath, 0o755);
    if (!existsSync(gateSource)) throw new PatchError(`the tool gate is missing: ${gateSource}`);
    // The runtime imports the gate as a module. A plain copy of the source would
    // still import `../src/...`, which does not exist beside the sidecar in
    // Resources, and the runtime refuses to start with a gate it cannot load —
    // measured: "Trusted extension failed to load: Cannot find module
    // '../src/session/approval-protocol.ts'". So the gate is bundled into one
    // self-contained file, and the bundle is proven to have no relative imports
    // left before it is recorded.
    const gatePath = join(out, GATE_RELATIVE_PATH);
    // The extensions directory is entirely build-owned: clear it first so a
    // stale file from an earlier build (for example the pre-bundle `.ts` copy)
    // can never be shipped beside the runtime.
    rmSync(join(out, "extensions"), { recursive: true, force: true });
    mkdirSync(dirname(gatePath), { recursive: true });
    const gateBuild = await runReaped(
      bunBinary(),
      ["build", gateSource, "--target=bun", "--outfile", gatePath],
      { cwd: runRoot, env, timeoutMs: 300_000 },
    );
    if (gateBuild.status !== 0) {
      const tail = `${gateBuild.stdout}\n${gateBuild.stderr}`.trim().split("\n").slice(-4).join(" | ");
      throw new PatchError(
        `the tool gate bundle failed (exit ${gateBuild.status}${gateBuild.timedOut ? ", timed out" : ""}): ${tail}`,
      );
    }
    if (/(?:from|import)\s*\(?\s*["'][.]{1,2}\//.test(readFileSync(gatePath, "utf8"))) {
      throw new PatchError("the bundled tool gate still contains relative imports; it must be self-contained");
    }

    const probe = await runReaped(binaryPath, ["--version"], {
      cwd: runRoot,
      env,
      timeoutMs: 120_000,
    });
    const reported = /^omp\/(.+)$/m.exec(probe.stdout)?.[1] ?? null;
    if (probe.status !== 0 || reported !== manifest.base.version) {
      throw new PatchError(
        `built sidecar reported ${reported ?? `(exit ${probe.status}${probe.timedOut ? ", timed out" : ""})`}, expected ${manifest.base.version}`,
      );
    }

    const bunProbe = await runReaped(bunBinary(), ["--version"], { cwd: runRoot, env, timeoutMs: 60_000 });
    const bunVersion = bunProbe.status === 0 ? bunProbe.stdout.trim().split("\n")[0] : null;

    const provenance = {
      schema: PROVENANCE_SCHEMA,
      fork: {
        repository: manifest.fork.repository,
        commit: manifest.fork.commit,
        ...(manifest.fork.tree ? { tree: manifest.fork.tree } : {}),
      },
      upstreamBase: { sha: manifest.base.sha, version: manifest.base.version },
      patchLevel: manifest.patchLevel,
      capabilities: [...manifest.capabilities],
      ompVersion: reported,
      desktopVersion: desktopVersion(),
      platform: process.platform,
      arch: process.arch,
      binary: {
        filename,
        bytes: statSync(binaryPath).size,
        sha256: sha256OfFile(binaryPath),
      },
      // The gate is loaded from Resources by `--trusted-extension`, so it is
      // part of the artifact: recording its digest is what lets the packaged
      // application refuse a swapped gate instead of trusting its presence.
      extensions: [
        {
          path: GATE_RELATIVE_PATH.split(/[\\/]/).join("/"),
          bytes: statSync(gatePath).size,
          sha256: sha256OfFile(gatePath),
        },
      ],
      build: {
        tool: "bun",
        ...(bunVersion ? { bunVersion } : {}),
        // The compile mode that changes the artifact's bytes, recorded beside
        // the Bun version that produced them: a manifest without it cannot say
        // what was built.
        bytecode: SIDECAR_BYTECODE,
      },
    };

    writeFileSync(join(out, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, "utf8");
    return { out, provenance, files: [...manifest.files] };
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
}

/**
 * Load the built runtime verifier.
 *
 * The preflight must apply exactly the checks a packaged application applies,
 * so it uses the runtime package's own compiled verifier instead of a second
 * implementation. `build:deps` (the first step of every release command) builds
 * it; a missing build is a hard failure rather than a skipped check.
 */
async function loadRuntimeVerifier() {
  const dist = join(appRoot, "packages", "omp-runtime", "dist", "bundled.js");
  if (!existsSync(dist)) {
    throw new PatchError(`the runtime verifier is not built (${dist}); run \`pnpm run build:deps\` first`);
  }
  return import(pathToFileURL(dist).href);
}

/**
 * Prove the staged artifact for one release target.
 *
 * Cross-target releases cannot compile here — the sidecar is a native
 * executable — so a non-host target may only proceed with an artifact that was
 * staged for exactly that target and that verifies against *the controlled
 * manifest being released*, not against a compiled-in constant: the artifact's
 * platform, architecture, digests, patch level, fork commit, base and desktop
 * version must all agree with the checkout in hand.
 */
async function verifyStagedArtifact(outDir, platform, arch, manifest) {
  if (basename(outDir) !== "omp-runtime") {
    throw new PatchError(`the runtime directory must be named omp-runtime, got ${outDir}`);
  }
  const { verifyBundledRuntime } = await loadRuntimeVerifier();
  try {
    return verifyBundledRuntime({
      resourcesPath: dirname(outDir),
      platform,
      arch,
      expected: {
        ompVersion: manifest.base.version,
        patchLevel: manifest.patchLevel,
        baseSha: manifest.base.sha,
        forkRepository: manifest.fork.repository,
        forkCommit: manifest.fork.commit,
        desktopVersion: desktopVersion(),
      },
    });
  } catch (error) {
    const detail = typeof error?.detail === "string" ? ` (${error.detail})` : "";
    throw new PatchError(
      `the staged bundled runtime for ${platform}/${arch} does not match the controlled manifest: ${error?.message ?? error}${detail}`,
    );
  }
}

/**
 * The release gate: validate the controlled checkout, then make the artifact
 * for the release target current.
 *
 * Host target: build it here (so a stale or missing artifact can never be
 * packaged). Non-host target: refuse unless an artifact staged for exactly that
 * platform and architecture verifies — never reuse the host binary for another
 * platform, and never fall back to "whatever is in Resources".
 */
export async function runPreflight(options = {}) {
  const { manifest, patchPath } = loadManifest(options.manifestPath ?? defaultManifest);
  const sourceDir = options.source ?? process.env.OMP_SIDECAR_SOURCE ?? join(repoRoot, "..", "oh-my-pi");
  const info = validateForkCheckout(sourceDir, manifest, patchPath);

  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? (platform === process.platform ? process.arch : null);
  if (arch === null) {
    throw new PatchError(
      `--arch is required for a ${platform} release from a ${process.platform} host: a cross-target package needs an artifact staged for that target`,
    );
  }
  const outDir = resolveOutDir(options.out ?? defaultOut, info.source);

  if (platform === process.platform && arch === process.arch) {
    const built = await buildSidecar({ ...options, source: sourceDir, out: outDir });
    return { action: "built", platform, arch, out: outDir, provenance: built.provenance };
  }
  const verified = await verifyStagedArtifact(outDir, platform, arch, manifest);
  return { action: "verified", platform, arch, out: outDir, provenance: verified.provenance };
}

function parseArgs(argv) {
  const options = { mode: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.mode = "check";
    else if (arg === "--build") options.mode = "build";
    else if (arg === "--preflight") options.mode = "preflight";
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") options.mode = "help";
    else if (arg === "--source" || arg === "--out" || arg === "--manifest" || arg === "--platform" || arg === "--arch") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("-")) throw new PatchError(`${arg} requires a value`);
      index += 1;
      if (arg === "--source") options.source = value;
      else if (arg === "--out") options.out = value;
      else if (arg === "--manifest") options.manifestPath = value;
      else if (arg === "--platform") options.platform = value;
      else options.arch = value;
    } else throw new PatchError(`unknown argument: ${arg}`);
  }
  if (!options.mode) throw new PatchError("expected --check, --build or --preflight");
  return options;
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`OMP-SIDECAR-FAIL ${error.message}`);
    return 2;
  }
  if (options.mode === "help") {
    console.log(readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 12).join("\n"));
    return 0;
  }
  try {
    if (options.mode === "check") {
      const { manifest, patchPath } = loadManifest(options.manifestPath ?? defaultManifest);
      const sourceDir =
        options.source ?? process.env.OMP_SIDECAR_SOURCE ?? join(repoRoot, "..", "oh-my-pi");
      const info = validateForkCheckout(sourceDir, manifest, patchPath);
      const report = {
        mode: "check",
        patchLevel: manifest.patchLevel,
        baseSha: manifest.base.sha,
        forkCommit: manifest.fork.commit,
        repository: info.remote,
        head: info.head,
        version: info.version,
        files: manifest.files.length,
      };
      console.log(
        options.json ? JSON.stringify(report) : `OMP-SIDECAR-OK ${manifest.patchLevel} (fork ${report.forkCommit})`,
      );
      return 0;
    }
    if (options.mode === "preflight") {
      const result = await runPreflight(options);
      if (options.json) {
        console.log(JSON.stringify(result.provenance));
      } else {
        console.log(
          `OMP-SIDECAR-PREFLIGHT ${result.action} ${result.platform}/${result.arch} in ${relative(repoRoot, result.out)}`,
        );
        console.log(`  fork commit: ${result.provenance.fork.commit}`);
        console.log(`  sha256     : ${result.provenance.binary.sha256}`);
      }
      return 0;
    }
    const result = await buildSidecar(options);
    if (options.json) {
      console.log(JSON.stringify(result.provenance));
    } else {
      console.log(`OMP-SIDECAR-BUILT ${result.provenance.binary.filename} in ${relative(repoRoot, result.out)}`);
      console.log(`  sha256     : ${result.provenance.binary.sha256}`);
      console.log(`  bytes      : ${result.provenance.binary.bytes}`);
      console.log(`  fork commit: ${result.provenance.fork.commit}`);
    }
    return 0;
  } catch (error) {
    console.error(`OMP-SIDECAR-FAIL ${error?.message ?? error}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`OMP-SIDECAR-FAIL ${error?.message ?? error}`);
      process.exit(1);
    },
  );
}
