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
 *  3. **The manifest is a claim that must be re-proven.** Every field this build
 *     can check is checked against the binary on disk (byte count and SHA-256),
 *     the extensions on disk (byte count and SHA-256), or against this build's
 *     own pins (fork repository/commit, patch level, OMP version, desktop
 *     version, platform, architecture). A mismatch is refused; the verification
 *     never degrades into "close enough".
 *
 * Which fields are *verified* and which are *recorded* is a deliberate line
 * (ADR 0307): `fork.tree`, `capabilities` and `build.*` are provenance/audit
 * records the running application cannot re-derive, so they are informational
 * and are never presented as checked. The trust anchors are the pinned
 * constants plus the digests, not the descriptive fields.
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
  APP_VERSION,
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

/**
 * The tool gate's path inside the runtime directory.
 *
 * The desktop loads it with the runtime's `--trusted-extension` allowlist, so
 * its location is part of the runtime contract rather than a desktop detail.
 * The shipped file is a **bundle**, not a copy of the source: the source gate
 * imports `../src/...`, which does not exist beside the sidecar in Resources,
 * and the runtime fails to load an extension whose imports do not resolve. The
 * build bundles it and records its digest, and the desktop verifies both.
 */
export const BUNDLED_GATE_RELATIVE_PATH = join("extensions", "omp-desktop-gate.js");

/** The only provenance schema this build understands; anything else fails closed. */
export const BUNDLED_PROVENANCE_SCHEMA = "omp-desktop.bundled-sidecar/2";

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
  /**
   * Files the build copied beside the binary and the desktop loads from there
   * (today: the tool gate). Each is verified against its recorded bytes and
   * digest before use, so a swapped gate cannot ride on a valid binary.
   */
  extensions: Array<{ path: string; bytes: number; sha256: string }>;
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
  extensions: Type.Array(
    Type.Object({
      path: Type.String(),
      bytes: Type.Integer({ minimum: 1 }),
      sha256: DIGEST,
    }),
    { minItems: 1 },
  ),
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
  /**
   * The desktop release the artifact was built for. A packaged application
   * ships one release and its runtime together, so an artifact built for
   * another release is refused rather than quietly reused.
   */
  desktopVersion: string;
};

/** The pins this build ships; tests override them to exercise each refusal. */
export const BUNDLED_EXPECTATION: BundledExpectation = {
  ompVersion: OMP_RUNTIME_VERSION,
  patchLevel: OMP_RUNTIME_PATCH_LEVEL,
  baseSha: OMP_RUNTIME_BASE_SHA,
  forkRepository: OMP_RUNTIME_FORK_REPOSITORY,
  forkCommit: OMP_RUNTIME_FORK_COMMIT,
  desktopVersion: APP_VERSION,
};

export type BundledVerification = {
  /** Absolute path of the verified executable. */
  path: string;
  /** The verified manifest, so callers can report the build identity. */
  provenance: BundledSidecarProvenance;
  /** Every declared extension, at the absolute path it was verified at. */
  extensions: Array<{ path: string; absolutePath: string; bytes: number; sha256: string }>;
};

function refuse(detail: string): never {
  throw new OmpRuntimeError(
    "bundled-runtime-invalid",
    "the bundled OMP runtime is not usable",
    detail,
  );
}

/**
 * Normalize an extension path to a relative POSIX path inside the runtime
 * directory, or `null` when it is not one.
 *
 * The manifest claims where the runtime loads a module from, so the accepted
 * forms are deliberately narrow: no absolute path (POSIX, a Windows drive, or a
 * UNC share), no empty/`.`/`..` segment, and no spelling that could name the
 * same file twice.
 */
function normalizeExtensionPath(raw: string): string | null {
  if (raw.length === 0) return null;
  if (raw.startsWith("/") || raw.startsWith("\\")) return null;
  if (/^[A-Za-z]:/.test(raw)) return null;
  const parts = raw.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) return null;
  return parts.join("/");
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
  // Compare the root and its child in the same canonical form. A lexical root
  // comparison is wrong on any path with an aliased ancestor — macOS resolves
  // the default temp root `/var/...` to `/private/var/...` — and would report
  // a false escape for a resource tree that is entirely inside the root.
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(resourcesRoot);
  } catch {
    refuse(`the resources root ${resourcesRoot} does not exist`);
  }
  const dir = join(canonicalRoot, BUNDLED_RUNTIME_DIR);

  const dirStats = lstatSyncOrNull(dir);
  if (!dirStats) refuse(`missing ${BUNDLED_RUNTIME_DIR}/ under the resources root`);
  if (dirStats.isSymbolicLink()) refuse(`${BUNDLED_RUNTIME_DIR} must not be a symlink`);
  if (!dirStats.isDirectory()) refuse(`${BUNDLED_RUNTIME_DIR} is not a directory`);
  const canonicalDir = realpathSync(dir);
  const canonicalPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep;
  if (canonicalDir !== canonicalRoot && !canonicalDir.startsWith(canonicalPrefix)) {
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
  if (provenance.desktopVersion !== expected.desktopVersion) {
    refuse(
      `provenance desktop version is ${provenance.desktopVersion}, this build is ${expected.desktopVersion}`,
    );
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

  // Extensions are loaded by the runtime from the same directory, so they must
  // be inside it, be plain files, and match the digest the build recorded —
  // otherwise a valid binary could carry a swapped tool gate.
  const extensions: BundledVerification["extensions"] = [];
  const seenExtensionPaths = new Set<string>();
  for (const extension of provenance.extensions) {
    const relative = normalizeExtensionPath(extension.path);
    if (relative === null) {
      refuse(`extension path is not a relative path inside the runtime directory: ${extension.path}`);
    }
    if (seenExtensionPaths.has(relative)) {
      refuse(`duplicate extension path in the provenance manifest: ${relative}`);
    }
    seenExtensionPaths.add(relative);
    const extensionPath = join(canonicalDir, ...relative.split("/"));
    const extensionRoot = canonicalDir.endsWith(sep) ? canonicalDir : canonicalDir + sep;
    if (!extensionPath.startsWith(extensionRoot)) {
      refuse(`extension path escapes the runtime directory: ${extension.path}`);
    }
    const extensionStats = lstatSyncOrNull(extensionPath);
    if (!extensionStats) refuse(`missing extension ${extension.path}`);
    if (extensionStats.isSymbolicLink()) refuse(`extension ${extension.path} must not be a symlink`);
    if (!extensionStats.isFile()) refuse(`extension ${extension.path} is not a regular file`);
    if (extensionStats.size !== extension.bytes) {
      refuse(`extension ${extension.path} is ${extensionStats.size} bytes, provenance declares ${extension.bytes}`);
    }
    if (sha256File(extensionPath) !== extension.sha256) {
      refuse(`extension ${extension.path} does not match the provenance manifest`);
    }
    extensions.push({
      path: relative,
      absolutePath: extensionPath,
      bytes: extensionStats.size,
      sha256: extension.sha256,
    });
  }
  const gatePath = BUNDLED_GATE_RELATIVE_PATH.split(sep).join("/");
  // The manifest declares the trusted gate and nothing else. A second shipped
  // extension is a product decision that needs its own ADR; until one exists an
  // extra entry is refused rather than loaded unreviewed.
  if (extensions.length !== 1 || extensions[0].path !== gatePath) {
    refuse(
      `the provenance manifest must declare exactly the tool gate (${gatePath}); it declares ${
        extensions.map((extension) => extension.path).join(", ") || "nothing"
      }`,
    );
  }

  return { path: binaryPath, provenance, extensions };
}

/**
 * Resolve the packaged tool gate through the same verification as the sidecar.
 *
 * Returns the absolute path of the verified gate, or `null` when the resources
 * do not verify. A packaged build must never fall back to a source-tree gate:
 * the gate is what makes a native tool call wait for the desktop, so an
 * unverified one is the same as none.
 */
export function resolveBundledGate(options: {
  resourcesPath: string;
  platform?: NodeJS.Platform | string;
  arch?: string;
  expected?: BundledExpectation;
}): { path: string; provenance: BundledSidecarProvenance } | null {
  const result = inspectBundledGate(options);
  return result.ok ? { path: result.path, provenance: result.provenance } : null;
}

/**
 * The reason a packaged gate could not be resolved.
 *
 * `resolveBundledGate` answers "usable or not"; a packaged application that has
 * no runtime must also be able to say *why* (missing file, tampered digest,
 * schema mismatch). This keeps the stable `bundled-runtime-invalid` code and
 * the concrete detail — which is the same string every `verifyBundledRuntime`
 * refusal produces — so the session bridge can surface it instead of a generic
 * "gate not found".
 */
export type BundledGateInspection =
  | { ok: true; path: string; provenance: BundledSidecarProvenance }
  | { ok: false; code: "bundled-runtime-invalid"; detail: string };

/** Resolve the packaged tool gate, preserving the verification refusal reason. */
export function inspectBundledGate(options: {
  resourcesPath: string;
  platform?: NodeJS.Platform | string;
  arch?: string;
  expected?: BundledExpectation;
}): BundledGateInspection {
  let verified: BundledVerification;
  try {
    verified = verifyBundledRuntime(options);
  } catch (error) {
    const typed = error as { detail?: unknown; message?: unknown };
    const detail =
      typeof typed.detail === "string" && typed.detail.length > 0
        ? typed.detail
        : String(typed.message ?? error);
    return { ok: false, code: "bundled-runtime-invalid", detail };
  }
  const gatePath = BUNDLED_GATE_RELATIVE_PATH.split(sep).join("/");
  const gate = verified.extensions.find((extension) => extension.path === gatePath);
  if (!gate) {
    return {
      ok: false,
      code: "bundled-runtime-invalid",
      detail: `the provenance manifest does not declare ${gatePath}`,
    };
  }
  return { ok: true, path: gate.absolutePath, provenance: verified.provenance };
}

function lstatSyncOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}
