import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { register } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  APP_VERSION,
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
const { PINNED_LAUNCHER_PATH, createOmpRuntimeAdapter, findPinnedLauncher, resolveRuntimeLauncher } =
  await import("../electron/main/runtime/omp-runtime.ts");
const { resolveGateExtension } = await import("../electron/main/runtime/engine-runtime.ts");
const { bundledBinaryFilename } = await import("../../../packages/omp-runtime/src/bundled.ts");

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
 * A packaged resource tree that passes verification: a stand-in executable, the
 * tool gate beside it, and the provenance manifest a real build would write.
 *
 * The tree is written and reported in canonical form (`realpath`) and with the
 * host platform's executable name, because that is what
 * `verifyBundledRuntime` resolves and checks: an aliased ancestor (macOS
 * `/var` → `/private/var`) or a Windows `.exe` name would otherwise turn the
 * fixture itself into the failure under test.
 */
function writeBundledRuntime(resourcesPath, options = {}) {
  const canonicalRoot = realpathSync(resourcesPath);
  const dir = join(canonicalRoot, "omp-runtime");
  const filename = bundledBinaryFilename(process.platform);
  mkdirSync(join(dir, "extensions"), { recursive: true });
  const binary = writeExecutable(dir, filename, "#!/bin/sh\necho omp/18.3.0\n");
  const gate = join(dir, "extensions", "omp-desktop-gate.js");
  writeFileSync(gate, "// fixture gate\nexport const gate = true;\n");
  const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const manifest = {
    schema: "omp-desktop.bundled-sidecar/2",
    fork: { repository: OMP_RUNTIME_FORK_REPOSITORY, commit: OMP_RUNTIME_FORK_COMMIT },
    upstreamBase: { sha: OMP_RUNTIME_BASE_SHA, version: OMP_RUNTIME_VERSION },
    patchLevel: OMP_RUNTIME_PATCH_LEVEL,
    capabilities: ["rpc-host-tool-concurrency"],
    ompVersion: OMP_RUNTIME_VERSION,
    desktopVersion: APP_VERSION,
    platform: process.platform,
    arch: process.arch,
    binary: {
      filename,
      bytes: readFileSync(binary).length,
      sha256: digest(binary),
    },
    extensions: [
      {
        path: "extensions/omp-desktop-gate.js",
        bytes: readFileSync(gate).length,
        sha256: digest(gate),
      },
    ],
    build: { tool: "bun" },
  };
  options.mutateManifest?.(manifest);
  const manifestPath = join(dir, "provenance.json");
  writeFileSync(manifestPath, JSON.stringify(manifest));
  if (options.tamperGate) writeFileSync(gate, options.tamperGate);
  return { dir, binary, gate, manifestPath };
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
    "missing manifest": (layout) => rmSync(layout.manifestPath),
    "tampered hash": (layout) => {
      const value = JSON.parse(readFileSync(layout.manifestPath, "utf8"));
      value.binary.sha256 = "b".repeat(64);
      writeFileSync(layout.manifestPath, JSON.stringify(value));
    },
    "wrong patch level": (layout) => {
      const value = JSON.parse(readFileSync(layout.manifestPath, "utf8"));
      value.patchLevel = "d49918f+omp-desktop.1";
      writeFileSync(layout.manifestPath, JSON.stringify(value));
    },
    "wrong fork commit": (layout) => {
      const value = JSON.parse(readFileSync(layout.manifestPath, "utf8"));
      value.fork.commit = "f".repeat(40);
      writeFileSync(layout.manifestPath, JSON.stringify(value));
    },
    "wrong desktop version": (layout) => {
      const value = JSON.parse(readFileSync(layout.manifestPath, "utf8"));
      value.desktopVersion = "0.0.1";
      writeFileSync(layout.manifestPath, JSON.stringify(value));
    },
    "tampered binary": (layout) => {
      writeFileSync(layout.binary, "#!/bin/sh\nexit 1\n");
      chmodSync(layout.binary, 0o755);
    },
    "tampered gate": (layout) => {
      writeFileSync(layout.gate, "// swapped gate\n");
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

test("a refused bundled resource keeps its reason instead of a generic missing runtime", () => {
  const root = scratch("diagnosable");
  try {
    const layout = writeBundledRuntime(root);
    writeFileSync(layout.binary, "#!/bin/sh\nexit 1\n");
    chmodSync(layout.binary, 0o755);
    const adapter = createOmpRuntimeAdapter({
      dataRoot: join(root, "data"),
      isPackaged: true,
      resourcesPath: root,
      appPath: root,
      env: {},
    });
    assert.equal(adapter.launcher, null);
    assert.match(String(adapter.launcherError), /bundled-runtime-invalid/);
    const status = adapter.status();
    assert.equal(status.phase, "failed");
    assert.equal(status.reason, "start-failed");
    // The operator must see which file disagreed and how, not just "no runtime".
    assert.match(String(status.detail), /bundled-runtime-invalid/);
    assert.match(String(status.detail), /SHA-256|bytes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a packaged build resolves the gate only from verified resources", () => {
  const root = scratch("gate-packaged");
  const decoyRoot = scratch("gate-decoy");
  const pathDecoy = scratch("gate-path");
  try {
    // Everything a packaged build must ignore: a development gate reachable by
    // walking up from the app path, and a same-named file on PATH.
    const devGate = writeExecutable(
      decoyRoot,
      join("app", "packages", "omp-runtime", "extensions", "omp-desktop-gate.ts"),
      "// dev gate\n",
    );
    writeExecutable(pathDecoy, "omp-desktop-gate.ts", "// path gate\n");

    const layout = writeBundledRuntime(root);
    assert.equal(resolveGateExtension({ isPackaged: true, resourcesPath: root, appPath: decoyRoot }), layout.gate);

    // No resources path: a refusal, never the development search.
    const previousPath = process.env.PATH;
    process.env.PATH = `${pathDecoy}:${previousPath ?? ""}`;
    process.env.OMP_DESKTOP_RUNTIME = devGate;
    try {
      assert.equal(resolveGateExtension({ isPackaged: true, resourcesPath: null, appPath: decoyRoot }), null);
      assert.equal(
        resolveGateExtension({ isPackaged: true, resourcesPath: join(root, "missing"), appPath: decoyRoot }),
        null,
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      delete process.env.OMP_DESKTOP_RUNTIME;
    }

    // A tampered gate is refused even though the development gate exists.
    writeFileSync(layout.gate, "// swapped gate\n");
    assert.equal(resolveGateExtension({ isPackaged: true, resourcesPath: root, appPath: decoyRoot }), null);

    // Development keeps the walk-up behaviour it always had.
    assert.equal(resolveGateExtension({ isPackaged: false, appPath: decoyRoot }), devGate);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(decoyRoot, { recursive: true, force: true });
    rmSync(pathDecoy, { recursive: true, force: true });
  }
});
