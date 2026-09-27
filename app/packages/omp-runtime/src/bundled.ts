/**
 * The bundled OMP sidecar: the one runtime a packaged build may execute.
 *
 * A packaged build ships a self-contained `omp` executable plus the provenance
 * manifest that the build produced from the OMP fork checkout (ADR 0307). Both
 * live under `process.resourcesPath/omp-runtime/`, and this module is the only
 * place that decides whether they may be used. Three rules it enforces:
 *
 *  1. **Fixed locations only.** The directory and file names below are the
 *     whole search space. There is no PATH lookup, no upward scan, and no
 *     environment override: a packaged build that cannot find exactly these is
 *     a build that has no runtime, and it must say so rather than run something
 *     else (contrast `resolveOmpLauncher`'s development candidates).
 *  2. **No symlinks, no escapes.** The directory and the binary are checked
 *     with `lstat`, and the resolved directory must stay inside the resources
 *     root, so a resource tree cannot redirect the runtime at a file outside
 *     it.
 *  3. **The manifest is a claim that must be re-proven.** Every field the
 *     desktop can check is checked against the binary on disk (byte count and
 *     SHA-256) or against this build's own pins (fork repository/commit, patch
 *     level, OMP version, platform, architecture). A mismatch is refused; the
 *     verification never degrades into "close enough".
 *
 * `platform`/`arch` are parameters rather than reads of `process`, so the
 * macOS and Windows naming and mismatch paths are testable on any host.
 */
import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readFileSync, readSync, realpathSync } from "node:fs";
import type { Stats } from "node:fs";
import { join, resolve, sep } from "node:path";
import Type from "typebox";
import * as Value from "typebox/value";

import {
  OMP_RUNTIME_BASE_SHA,
  OMP_RUNTIME_FORK_COMMIT,
  OMP_RUNTIME_FORK_REPOSITORY,
  OMP_RUNTIME_PATCH_LEVEL,
  OMP_RUNTIME_VERSION,
} from "@pi-desktop/shared";

import { OmpRuntimeError } from "./errors.js";
import { isExecutableAt } from "./launcher.js";

/** Resources subdirectory that holds the sidecar and its provenance manifest. */
export const BUNDLED_RUNTIME_DIR = "omp-runtime";

/** The provenance manifest's fixed file name inside that directory. */
export const BUNDLED_PROVENANCE_FILENAME = "provenance.json";

/** The only provenance schema this build understands; anything else fails closed. */
export const BUNDLED_PROVENANCE_SCHEMA = "omp-desktop.bundled-sidecar/1";

/** Read buffer for hashing; the binary is hundreds of megabytes. */
const HASH_CHUNK_BYTES = 1024 * 1024;

/** The executable file name for a platform (Bun appends `.exe` on Windows). */
export function bundledBinaryFilename(platform: NodeJS.Platform | string): string {
  return platform === "win32" ? "omp.exe" : "omp";
}

/**
 * Canonical form of a git remote for comparison.
 *
 * `git remote get-url` returns whatever the clone was configured with —
 * `git@github.com:Owner/Repo.git`, `ssh://git@github.com/Owner/Repo.git`, or
 * `https://github.com/Owner/Repo` — so equality has to be decided on a
 * normalized form. Returns `null` for anything that is not one of those shapes,
 * which the callers treat as "not the expected remote".
 */
export function normalizeRepositoryUrl(url: string): string | null {
  const trimmed = url.trim();
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

/** The provenance manifest a build writes next to the sidecar. */
export type BundledSidecarProvenance = {
  schema: string;
  fork: { repository: string; commit: string; tree?: string };
  upstreamBase: { sha: string; version: string };
  patchLevel: string;
  capabilities: string[];
  ompVersion: string;
  desktopVersion: string;
  platform: string;
  arch: string;
  binary: { filename: string; bytes: number; sha256: string };
  build: { tool: string; bunVersion?: string };
};

const DIGEST = Type.String({ pattern: "^[0-9a-f]{64}$" });
const COMMIT = Type.String({ pattern: "^[0-9a-f]{40}$" });

/** Shape check only; every *value* is compared in `verifyBundledRuntime`. */
export const BundledProvenanceSchema = Type.Object({
  schema: Type.String(),
  fork: Type.Object({
    repository: Type.String(),
    commit: COMMIT,
    tree: Type.Optional(COMMIT),
  }),
  upstreamBase: Type.Object({
    sha: COMMIT,
    version: Type.String(),
  }),
  patchLevel: Type.String(),
  capabilities: Type.Array(Type.String()),
  ompVersion: Type.String(),
  desktopVersion: Type.String(),
  platform: Type.String(),
  arch: Type.String(),
  binary: Type.Object({
    filename: Type.String(),
    bytes: Type.Integer({ minimum: 1 }),
    sha256: DIGEST,
  }),
  build: Type.Object({
    tool: Type.String(),
    bunVersion: Type.Optional(Type.String()),
  }),
});

/** Pins a packaged build checks the manifest against. */
export type BundledExpectation = {
  ompVersion: string;
  patchLevel: string;
  baseSha: string;
  forkRepository: string;
  forkCommit: string;
};

/** The pins this build ships; tests override them to exercise each refusal. */
export const BUNDLED_EXPECTATION: BundledExpectation = {
  ompVersion: OMP_RUNTIME_VERSION,
  patchLevel: OMP_RUNTIME_PATCH_LEVEL,
  baseSha: OMP_RUNTIME_BASE_SHA,
  forkRepository: OMP_RUNTIME_FORK_REPOSITORY,
  forkCommit: OMP_RUNTIME_FORK_COMMIT,
};

export type BundledVerification = {
  /** Absolute path of the verified executable. */
  path: string;
  /** The verified manifest, so callers can report the build identity. */
  provenance: BundledSidecarProvenance;
};

function refuse(detail: string): never {
  throw new OmpRuntimeError(
    "bundled-runtime-invalid",
    "the bundled OMP runtime is not usable",
    detail,
  );
}

/** SHA-256 of a file, read in bounded chunks so a large binary is not buffered whole. */
export function sha256File(path: string): string {
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

/**
 * Verify the packaged sidecar and its provenance manifest.
 *
 * Throws `OmpRuntimeError("bundled-runtime-invalid")` with a stable detail on
 * every refusal: missing directory, symlinked or escaping path, unreadable or
 * malformed manifest, any pin mismatch, and any binary/manifest hash or byte
 * disagreement.
 */
export function verifyBundledRuntime(options: {
  /** `process.resourcesPath` of the packaged application. */
  resourcesPath: string;
  platform?: NodeJS.Platform | string;
  arch?: string;
  expected?: BundledExpectation;
}): BundledVerification {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const expected = options.expected ?? BUNDLED_EXPECTATION;
  const resourcesRoot = resolve(options.resourcesPath);
  const dir = join(resourcesRoot, BUNDLED_RUNTIME_DIR);

  const dirStats = lstatSyncOrNull(dir);
  if (!dirStats) refuse(`missing ${BUNDLED_RUNTIME_DIR}/ under the resources root`);
  if (dirStats.isSymbolicLink()) refuse(`${BUNDLED_RUNTIME_DIR} must not be a symlink`);
  if (!dirStats.isDirectory()) refuse(`${BUNDLED_RUNTIME_DIR} is not a directory`);
  const canonicalDir = realpathSync(dir);
  const canonicalRoot = resourcesRoot.endsWith(sep) ? resourcesRoot : resourcesRoot + sep;
  if (canonicalDir !== resourcesRoot && !canonicalDir.startsWith(canonicalRoot)) {
    refuse(`${BUNDLED_RUNTIME_DIR} resolves outside the resources root`);
  }

  const filename = bundledBinaryFilename(platform);
  const binaryPath = join(canonicalDir, filename);
  const binaryStats = lstatSyncOrNull(binaryPath);
  if (!binaryStats) refuse(`missing the bundled ${filename}`);
  if (binaryStats.isSymbolicLink()) refuse(`the bundled ${filename} must not be a symlink`);
  if (!binaryStats.isFile()) refuse(`the bundled ${filename} is not a regular file`);
  if (!isExecutableAt(binaryPath)) refuse(`the bundled ${filename} is not executable`);

  const manifestPath = join(canonicalDir, BUNDLED_PROVENANCE_FILENAME);
  const manifestStats = lstatSyncOrNull(manifestPath);
  if (!manifestStats) refuse(`missing ${BUNDLED_PROVENANCE_FILENAME}`);
  if (manifestStats.isSymbolicLink()) refuse(`${BUNDLED_PROVENANCE_FILENAME} must not be a symlink`);
  if (!manifestStats.isFile()) refuse(`${BUNDLED_PROVENANCE_FILENAME} is not a regular file`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    refuse(`${BUNDLED_PROVENANCE_FILENAME} is not valid JSON: ${(error as Error).message}`);
  }
  if (!Value.Check(BundledProvenanceSchema, parsed)) {
    refuse(`${BUNDLED_PROVENANCE_FILENAME} does not match ${BUNDLED_PROVENANCE_SCHEMA}`);
  }
  const provenance = parsed as BundledSidecarProvenance;

  if (provenance.schema !== BUNDLED_PROVENANCE_SCHEMA) {
    refuse(`provenance schema is ${provenance.schema}, expected ${BUNDLED_PROVENANCE_SCHEMA}`);
  }
  if (provenance.platform !== platform) {
    refuse(`provenance platform is ${provenance.platform}, this host is ${platform}`);
  }
  if (provenance.arch !== arch) {
    refuse(`provenance arch is ${provenance.arch}, this host is ${arch}`);
  }
  if (provenance.ompVersion !== expected.ompVersion) {
    refuse(`provenance OMP version is ${provenance.ompVersion}, this build pins ${expected.ompVersion}`);
  }
  if (provenance.upstreamBase.version !== provenance.ompVersion) {
    refuse(
      `provenance upstream base version is ${provenance.upstreamBase.version} but the runtime version is ${provenance.ompVersion}`,
    );
  }
  if (provenance.patchLevel !== expected.patchLevel) {
    refuse(`provenance patch level is ${provenance.patchLevel}, this build pins ${expected.patchLevel}`);
  }
  if (provenance.upstreamBase.sha !== expected.baseSha) {
    refuse(`provenance upstream base is ${provenance.upstreamBase.sha}, this build pins ${expected.baseSha}`);
  }
  const expectedRemote = normalizeRepositoryUrl(expected.forkRepository);
  const manifestRemote = normalizeRepositoryUrl(provenance.fork.repository);
  if (expectedRemote === null || manifestRemote !== expectedRemote) {
    refuse(`provenance fork repository ${provenance.fork.repository} is not ${expected.forkRepository}`);
  }
  if (provenance.fork.commit !== expected.forkCommit) {
    refuse(`provenance fork commit is ${provenance.fork.commit}, this build pins ${expected.forkCommit}`);
  }
  if (provenance.binary.filename !== filename) {
    refuse(`provenance binary name is ${provenance.binary.filename}, this host needs ${filename}`);
  }

  const actualBytes = binaryStats.size;
  if (provenance.binary.bytes !== actualBytes) {
    refuse(`binary is ${actualBytes} bytes, provenance declares ${provenance.binary.bytes}`);
  }
  const actualSha = sha256File(binaryPath);
  if (provenance.binary.sha256 !== actualSha) {
    refuse("binary SHA-256 does not match the provenance manifest");
  }

  return { path: binaryPath, provenance };
}

function lstatSyncOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
