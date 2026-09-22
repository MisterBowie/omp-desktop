import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LEGACY_PI_DESKTOP_IDENTITY, PRODUCT_IDENTITY, assertIndependentIdentity } from "@pi-desktop/shared";

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

test("a packaged build uses its bundled runtime and never a global one", () => {
  const root = scratch("packaged");
  try {
    const bundled = writeExecutable(root, "omp-runtime/omp", "#!/bin/sh\nexit 0\n");
    const resolved = resolveRuntimeLauncher({
      env: {},
      isPackaged: true,
      resourcesPath: root,
      appPath: root,
    });
    assert.equal(resolved.path, bundled);
    assert.equal(resolved.source, "bundled");

    // Without a bundled runtime a packaged app has none: it must not fall back
    // to whatever `omp` a developer happens to have on PATH.
    const empty = scratch("packaged-empty");
    try {
      const missing = resolveRuntimeLauncher({
        env: {},
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
