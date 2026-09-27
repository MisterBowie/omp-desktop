/**
 * Fixtures shared by the bundled-sidecar build and release-gate tests.
 *
 * Three things are provided: a tiny git repository that looks like the
 * controlled OMP fork checkout (its HEAD is `base + one patch`, its origin is
 * the fork URL), the manifest the build entry loads for it, and a staged
 * runtime artifact for one release target. Everything is created under
 * `mkdtemp`; call `cleanupScratch()` when the test file finishes.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  APP_VERSION,
  OMP_RUNTIME_BASE_SHA,
  OMP_RUNTIME_FORK_COMMIT,
  OMP_RUNTIME_FORK_REPOSITORY,
  OMP_RUNTIME_PATCH_LEVEL,
  OMP_RUNTIME_VERSION,
} from "@pi-desktop/shared";

/** Version the fixture checkout reports; deliberately not a real OMP version. */
export const FIXTURE_VERSION = "9.9.9";

/** The gate content a staged fixture artifact carries. */
export const FIXTURE_GATE = "// fixture gate\nexport const gate = true;\n";

const created = [];

export function scratch(label) {
  const root = mkdtempSync(join(tmpdir(), `omp-sidecar-${label}-`));
  created.push(root);
  return root;
}

export function cleanupScratch() {
  for (const root of created.splice(0)) rmSync(root, { recursive: true, force: true });
}

export function gitRaw(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr ?? "").trim()}`);
  }
  return result.stdout ?? "";
}

export function git(args, cwd) {
  return gitRaw(args, cwd).trim();
}

export function digestOfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * A minimal OMP-shaped checkout whose HEAD is `base + one patch`, with a
 * manifest that describes exactly that. Returns `{ root, manifest, patchPath }`.
 */
export function fixtureRepo({ remote = "git@github.com:MisterBowie/oh-my-pi.git" } = {}) {
  const root = scratch("repo");
  git(["init", "-q"], root);
  git(["config", "user.email", "fixture@example.invalid"], root);
  git(["config", "user.name", "Fixture"], root);
  git(["remote", "add", "origin", remote], root);
  mkdirSync(join(root, "packages", "utils"), { recursive: true });
  mkdirSync(join(root, "packages", "coding-agent", "scripts"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "packages", "utils", "package.json"), JSON.stringify({ version: FIXTURE_VERSION }));
  writeFileSync(join(root, "packages", "coding-agent", "scripts", "build-binary.ts"), "// fixture build entry\n");
  writeFileSync(join(root, "src", "tool.ts"), "export const value = 'base';\n");
  git(["add", "-A"], root);
  git(["commit", "-q", "-m", "base"], root);
  const baseSha = git(["rev-parse", "HEAD"], root);

  writeFileSync(join(root, "src", "tool.ts"), "export const value = 'patched';\n");
  git(["commit", "-q", "-am", "patch"], root);
  const headSha = git(["rev-parse", "HEAD"], root);

  const patchDir = scratch("patch");
  const patchPath = join(patchDir, "0001-fixture.patch");
  writeFileSync(patchPath, gitRaw(["diff", baseSha, headSha], root));

  const manifest = {
    fork: { repository: OMP_RUNTIME_FORK_REPOSITORY, branch: "fixture", commit: headSha },
    base: { sha: baseSha, version: FIXTURE_VERSION },
    files: ["src/tool.ts"],
  };
  return { root, manifest, patchDir, patchPath, baseSha, headSha };
}

/**
 * The same fixture as a manifest the CLI can load: the patch next to
 * `manifest.json`, with its checksum and byte count, so `--check` and
 * `--preflight` exercise the real manifest validation rather than a mock.
 */
export function writeFixtureManifest(fixture, mutate = () => {}) {
  const dir = scratch("manifest");
  const patchFile = "0001-fixture.patch";
  writeFileSync(join(dir, patchFile), readFileSync(fixture.patchPath));
  const manifest = {
    schemaVersion: 1,
    patchLevel: `${fixture.baseSha.slice(0, 7)}+fixture.1`,
    base: { sha: fixture.baseSha, version: FIXTURE_VERSION },
    fork: { repository: OMP_RUNTIME_FORK_REPOSITORY, branch: "fixture", commit: fixture.headSha },
    patch: {
      file: patchFile,
      sha256: digestOfFile(join(dir, patchFile)),
      bytes: statSync(join(dir, patchFile)).size,
    },
    capabilities: ["fixture-capability"],
    files: ["src/tool.ts"],
  };
  mutate(manifest);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return join(dir, "manifest.json");
}

/**
 * Stage a runtime artifact for one release target in `outDir`, exactly as a
 * build for that target would lay it out: the platform's executable name, the
 * tool gate beside it, and a provenance manifest whose digests match.
 */
export function stageArtifact(
  outDir,
  { platform, arch, patchLevel, baseSha, forkCommit, ompVersion, mutateProvenance } = {},
) {
  const runtimeVersion = ompVersion ?? OMP_RUNTIME_VERSION;
  const filename = platform === "win32" ? "omp.exe" : "omp";
  const gateRelative = "extensions/omp-desktop-gate.js";
  mkdirSync(join(outDir, "extensions"), { recursive: true });
  const binary = join(outDir, filename);
  writeFileSync(binary, `#!/bin/sh\necho omp/${runtimeVersion}\n`, { mode: 0o755 });
  chmodSync(binary, 0o755);
  const gate = join(outDir, gateRelative);
  writeFileSync(gate, FIXTURE_GATE);
  const provenance = {
    schema: "omp-desktop.bundled-sidecar/3",
    fork: {
      repository: OMP_RUNTIME_FORK_REPOSITORY,
      commit: forkCommit ?? OMP_RUNTIME_FORK_COMMIT,
      tree: "1".repeat(40),
    },
    upstreamBase: { sha: baseSha ?? OMP_RUNTIME_BASE_SHA, version: runtimeVersion },
    patchLevel: patchLevel ?? OMP_RUNTIME_PATCH_LEVEL,
    capabilities: ["rpc-host-tool-concurrency"],
    ompVersion: runtimeVersion,
    desktopVersion: APP_VERSION,
    platform,
    arch,
    binary: { filename, bytes: statSync(binary).size, sha256: digestOfFile(binary) },
    extensions: [{ path: gateRelative, bytes: statSync(gate).size, sha256: digestOfFile(gate) }],
    build: { tool: "bun", bytecode: true },
  };
  mutateProvenance?.(provenance);
  writeFileSync(join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  return { binary, gate, provenance };
}
