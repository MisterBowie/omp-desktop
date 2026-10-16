import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/dist/index.js";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../electron/main");

function fixture() {
  const engine = new EventEmitter();
  const installs = [], opened = [], states = [];
  let signature = { status: 1, stderr: "code object is not signed at all" };
  engine.checkForUpdates = async () => {
    engine.emit("checking-for-update");
    engine.emit("update-available", { version: "0.1.1" });
  };
  engine.downloadUpdate = async () => engine.emit("update-downloaded", { version: "0.1.1" });
  engine.quitAndInstall = (...args) => installs.push(args);
  const external = {
    electron: { app: { isPackaged: true }, shell: { openExternal: async url => opened.push(url) } },
    "electron-updater": { default: { autoUpdater: engine } },
    "node:child_process": { spawnSync: () => signature },
    "@pi-desktop/shared": shared,
  };
  const cache = new Map();
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(readFileSync(file, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    new Function("require", "exports", "module", code)(id => {
      if (Object.hasOwn(external, id)) return external[id];
      if (!id.startsWith(".")) return require(id);
      const path = resolve(dirname(file), id);
      return load(existsSync(path) ? path : path.replace(/\.js$/, "") + ".ts");
    }, module.exports, module);
    return module.exports;
  }
  const api = load(resolve(root, "updater.ts"));
  const controller = options => new api.AppUpdaterController({
    currentVersion: "0.1.0", logger: { app() {} }, send: (_, value) => states.push(value),
    platform: "win32", isPackaged: true, ...options,
  });
  return { api, controller, engine, installs, opened, states, signature: value => { signature = value; } };
}

test("unsigned macOS checks GitHub without downloading or installing", async () => {
  const f = fixture();
  const updater = f.controller({ platform: "darwin", macosSigned: false });
  assert.equal(updater.getState().mode, "manual");
  assert.equal(f.engine.autoDownload, false);
  assert.equal(f.engine.autoInstallOnAppQuit, false);
  await updater.check({ manual: true });
  assert.equal(updater.getState().status, "available");
  await updater.openReleases();
  assert.deepEqual(f.opened, ["https://github.com/MisterBowie/omp-desktop/releases/latest"]);
  await assert.rejects(updater.download(), /not supported/);
  assert.throws(() => updater.install(), /no downloaded update/);
  assert.equal(f.installs.length, 0);
  updater.dispose();
});

test("signed macOS completes check, progress, download and restart handoff", async () => {
  const f = fixture();
  const updater = f.controller({ platform: "darwin", macosSigned: true });
  assert.equal(updater.getState().mode, "in-app");
  assert.equal(f.engine.autoDownload, true);
  assert.equal(f.engine.autoInstallOnAppQuit, true);
  assert.equal(f.engine.allowPrerelease, false);
  assert.equal(f.engine.allowDowngrade, false);
  await updater.check({ manual: true });
  f.engine.emit("download-progress", { percent: 42.4 });
  assert.equal(updater.getState().progressPercent, 42);
  await updater.download();
  f.engine.emit("update-downloaded", { version: "0.1.1" });
  assert.equal(updater.getState().status, "downloaded");
  f.engine.quitAndInstall = (...args) => {
    assert.equal(updater.isInstallingUpdate(), true);
    f.installs.push(args);
  };
  updater.install();
  assert.deepEqual(f.installs, [[false, true]]);
  updater.dispose();
});

test("delivery policy keeps dev, portable and package-manager installs distinct", () => {
  const { resolveUpdateMode } = fixture().api;
  assert.equal(resolveUpdateMode("win32", false, {}), "disabled");
  assert.equal(resolveUpdateMode("win32", true, { PORTABLE_EXECUTABLE_FILE: "/portable.exe" }), "manual");
  assert.equal(resolveUpdateMode("win32", true, {}), "in-app");
  assert.equal(resolveUpdateMode("linux", true, { APPIMAGE: "/app.AppImage" }), "in-app");
  assert.equal(resolveUpdateMode("linux", true, {}), "manual");
  assert.equal(resolveUpdateMode("darwin", true, {}, false), "manual");
  assert.equal(resolveUpdateMode("darwin", true, {}, true), "in-app");
});

test("Developer ID probe refuses missing, adhoc and failed signatures", () => {
  const f = fixture();
  assert.equal(typeof f.api.hasDeveloperIdSignature, "function");
  assert.equal(f.api.hasDeveloperIdSignature("/owned/OMP Desktop"), false);
  f.signature({ status: 0, stderr: "Signature=adhoc\nTeamIdentifier=not set\n" });
  assert.equal(f.api.hasDeveloperIdSignature("/owned/OMP Desktop"), false);
  f.signature({ status: 0, stderr: "Authority=Developer ID Application: Fixture (ABCDE12345)\nTeamIdentifier=ABCDE12345\n" });
  assert.equal(f.api.hasDeveloperIdSignature("/owned/OMP Desktop"), true);
  f.signature({ status: null, error: new Error("timeout"), stderr: "" });
  assert.equal(f.api.hasDeveloperIdSignature("/owned/OMP Desktop"), false);
});

test("check failures remain visible and a retry can recover", async () => {
  const f = fixture();
  const updater = f.controller();
  f.engine.checkForUpdates = async () => {
    const error = new Error("fixture offline");
    f.engine.emit("error", error);
    throw error;
  };
  await assert.rejects(updater.check({ manual: true }), /offline/);
  assert.equal(updater.getState().status, "error");
  f.engine.checkForUpdates = async () => f.engine.emit("update-not-available");
  await updater.check({ manual: true });
  assert.equal(updater.getState().status, "up-to-date");
  updater.dispose();
});
