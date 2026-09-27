import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  LEGACY_PI_DESKTOP_IDENTITY,
  OMP_RUNTIME_BASE_SHA,
  OMP_RUNTIME_FORK_COMMIT,
  OMP_RUNTIME_FORK_REPOSITORY,
  OMP_RUNTIME_PATCH_LEVEL,
  OMP_RUNTIME_VERSION,
  PRODUCT_IDENTITY,
  assertIndependentIdentity,
} from "@pi-desktop/shared";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));
const { PINNED_LAUNCHER_PATH, findPinnedLauncher, resolveRuntimeLauncher } = await import(
  "../electron/main/runtime/omp-runtime.ts"
);

function scratch(label) {
  return mkdtempSync(join(tmpdir(), `omp-launcher-${label}-`));
}

function writeExecutable(root, relative, body) {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

/**
 * A packaged resource tree that passes verification: a stand-in executable plus
 * the provenance manifest a real build would write for it.
 */
function writeBundledRuntime(resourcesPath) {
  const dir = join(resourcesPath, "omp-runtime");
  mkdirSync(dir, { recursive: true });
  const binary = writeExecutable(dir, "omp", "#!/bin/sh\necho omp/18.3.0\n");
  const bytes = readFileSync(binary);
  const manifest = join(dir, "provenance.json");
  writeFileSync(
    manifest,
    JSON.stringify({
      schema: "omp-desktop.bundled-sidecar/1",
      fork: { repository: OMP_RUNTIME_FORK_REPOSITORY, commit: OMP_RUNTIME_FORK_COMMIT },
      upstreamBase: { sha: OMP_RUNTIME_BASE_SHA, version: OMP_RUNTIME_VERSION },
      patchLevel: OMP_RUNTIME_PATCH_LEVEL,
      capabilities: ["rpc-host-tool-concurrency"],
      ompVersion: OMP_RUNTIME_VERSION,
      desktopVersion: "0.15.2",
      platform: process.platform,
      arch: process.arch,
      binary: {
        filename: "omp",
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      build: { tool: "bun" },
    }),
  );
  return { dir, binary, manifest };
}

test("an explicit runtime path wins and is the only candidate considered", () => {
  const root = scratch("explicit");
  try {
    const explicit = writeExecutable(root, "runtime/omp", "#!/bin/sh\nexit 0\n");
    const resolved = resolveRuntimeLauncher({
      env: { OMP_DESKTOP_RUNTIME: explicit },
      isPackaged: false,
      appPath: root,
    });
    assert.equal(resolved.path, explicit);
    assert.equal(resolved.source, "explicit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an unusable explicit path is an error, not a reason to search elsewhere", () => {
  const root = scratch("explicit-missing");
  try {
    const dev = writeExecutable(root, PINNED_LAUNCHER_PATH, "#!/bin/sh\nexit 0\n");
    assert.ok(dev, "the development launcher exists under this root");
    const resolved = resolveRuntimeLauncher({
      env: { OMP_DESKTOP_RUNTIME: join(root, "missing-runtime") },
      isPackaged: false,
      appPath: root,
    });
    // Pointing at a specific runtime and silently using another one would make
    // a broken configuration look like a working one.
    assert.equal(resolved.path, null);
    assert.equal(resolved.source, null);
    assert.match(resolved.tried.join(" "), /explicit:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a packaged build admits only a resource that matches its provenance", () => {
  const root = scratch("packaged");
  try {
    const layout = writeBundledRuntime(root);
    const resolved = resolveRuntimeLauncher({
      env: {},
      isPackaged: true,
      resourcesPath: root,
      appPath: root,
    });
    assert.equal(resolved.path, layout.binary);
    assert.equal(resolved.source, "bundled");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a packaged build ignores every development channel", () => {
  const root = scratch("packaged-overrides");
  const elsewhere = scratch("packaged-elsewhere");
  try {
    // A valid development override, a decoy `omp` earlier on PATH, and a decoy
    // `upstream/oh-my-pi/...` reachable by walking up from the app path: none of
    // them may select the runtime of a shipped application (ADR 0307).
    const decoy = writeExecutable(elsewhere, "runtime/omp", "#!/bin/sh\nexit 0\n");
    writeExecutable(elsewhere, "path/omp", "#!/bin/sh\nexit 0\n");
    writeExecutable(root, PINNED_LAUNCHER_PATH, "#!/bin/sh\nexit 0\n");
    const resolved = resolveRuntimeLauncher({
      env: { OMP_DESKTOP_RUNTIME: decoy, PATH: `${join(elsewhere, "path")}:${process.env.PATH ?? ""}` },
      isPackaged: true,
      resourcesPath: root,
      appPath: root,
    });
    assert.equal(resolved.path, null);
    assert.equal(resolved.source, null);
    assert.match(String(resolved.error), /bundled-runtime-invalid/);
    assert.match(resolved.tried.join(" "), /bundled:/);

    // Without a bundled runtime a packaged app has none: it must not fall back
    // to whatever `omp` a developer happens to have on PATH.
    const empty = scratch("packaged-empty");
    try {
      const missing = resolveRuntimeLauncher({
        env: { OMP_DESKTOP_RUNTIME: decoy },
        isPackaged: true,
        resourcesPath: empty,
        appPath: empty,
      });
      assert.equal(missing.path, null);
      assert.equal(missing.source, null);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("a packaged build refuses a tampered or absent provenance manifest", () => {
  const cases = {
    "missing manifest": (layout) => rmSync(layout.manifest),
    "tampered hash": (layout) => {
      const value = JSON.parse(readFileSync(layout.manifest, "utf8"));
      value.binary.sha256 = "b".repeat(64);
      writeFileSync(layout.manifest, JSON.stringify(value));
    },
    "wrong patch level": (layout) => {
      const value = JSON.parse(readFileSync(layout.manifest, "utf8"));
      value.patchLevel = "d49918f+omp-desktop.1";
      writeFileSync(layout.manifest, JSON.stringify(value));
    },
    "wrong fork commit": (layout) => {
      const value = JSON.parse(readFileSync(layout.manifest, "utf8"));
      value.fork.commit = "f".repeat(40);
      writeFileSync(layout.manifest, JSON.stringify(value));
    },
    "tampered binary": (layout) => {
      writeFileSync(layout.binary, "#!/bin/sh\nexit 1\n");
      chmodSync(layout.binary, 0o755);
    },
  };
  for (const [label, tamper] of Object.entries(cases)) {
    const root = scratch("packaged-tamper");
    const before = resolveRuntimeLauncher({ env: {}, isPackaged: true, resourcesPath: root, appPath: root });
    assert.equal(before.path, null, `${label}: fixture must start with no runtime`);
    try {
      const layout = writeBundledRuntime(root);
      assert.equal(
        resolveRuntimeLauncher({ env: {}, isPackaged: true, resourcesPath: root, appPath: root }).source,
        "bundled",
        `${label}: fixture must be valid before tampering`,
      );
      tamper(layout);
      const after = resolveRuntimeLauncher({ env: {}, isPackaged: true, resourcesPath: root, appPath: root });
      assert.equal(after.path, null, `${label}: tampering must be refused`);
      assert.match(String(after.error), /bundled-runtime-invalid/, label);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an unpackaged build finds the pinned submodule launcher by walking up", () => {
  const root = scratch("dev");
  try {
    const launcher = writeExecutable(root, PINNED_LAUNCHER_PATH, "#!/bin/sh\nexit 0\n");
    const appDir = join(root, "app", "apps", "desktop");
    mkdirSync(appDir, { recursive: true });
    assert.equal(findPinnedLauncher(appDir), launcher);
    const resolved = resolveRuntimeLauncher({ env: {}, isPackaged: false, appPath: appDir });
    assert.equal(resolved.path, launcher);
    assert.equal(resolved.source, "development");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("this worktree resolves its own pinned launcher", () => {
  // The real answer for an unpackaged development run in this repository: the
  // launcher inside the pinned reference checkout that the app directory is
  // nested in, never the globally linked `omp` (which points at another
  // checkout entirely).
  const repoRoot = join(here, "..", "..", "..", "..");
  const found = findPinnedLauncher(join(here, ".."));
  assert.equal(found, join(repoRoot, PINNED_LAUNCHER_PATH));
});

test("the product identity is independent of the fork it came from", async () => {
  assert.doesNotThrow(() => assertIndependentIdentity());
  assert.notEqual(PRODUCT_IDENTITY.dataDirName, LEGACY_PI_DESKTOP_IDENTITY.dataDirName);
  assert.notEqual(PRODUCT_IDENTITY.appId, LEGACY_PI_DESKTOP_IDENTITY.appId);
  // A development profile must not be the shipped one either.
  assert.notEqual(PRODUCT_IDENTITY.developmentDataDirName, PRODUCT_IDENTITY.dataDirName);
  assert.notEqual(PRODUCT_IDENTITY.developmentUserDataName, PRODUCT_IDENTITY.userDataName);
});

test("the data-directory resolver never lands on the fork's directory", async () => {
  const { resolveDataDir, INSTALLATION_DATA_DIR_NAME, DEVELOPMENT_DATA_DIR_NAME } = await import(
    "../electron/main/data-paths.ts"
  );
  const home = "/tmp/someones-home";
  assert.equal(resolveDataDir({ override: undefined, development: false, home }), join(home, ".omp-desktop"));
  assert.equal(resolveDataDir({ override: undefined, development: true, home }), join(home, ".omp-desktop-dev"));
  assert.equal(INSTALLATION_DATA_DIR_NAME, ".omp-desktop");
  assert.equal(DEVELOPMENT_DATA_DIR_NAME, ".omp-desktop-dev");
  // An explicit override still wins, for tests and side-by-side profiles.
  assert.equal(resolveDataDir({ override: "/tmp/explicit", development: false, home }), "/tmp/explicit");
});

test("development builds disable automatic updates and the feed is this product's", async () => {
  // Read as source: `updater.ts` imports Electron, which a plain Node test
  // cannot load, and the existing auto-update contract test asserts the same
  // file the same way.
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(here, "..", "electron", "main", "updater.ts"), "utf8");
  assert.match(source, /if \(!isPackaged\) return "disabled"/);
  assert.match(source, /PRODUCT_IDENTITY\.updateSource/);
  assert.doesNotMatch(source, /vastsa\/PI-Desktop/);
  assert.equal(PRODUCT_IDENTITY.updateSource?.owner, "MisterBowie");
});
