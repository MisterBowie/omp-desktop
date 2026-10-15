/** Own one actual installed payload, isolated profile, inspectors and process tree. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { CdpClient } from "./cdp.mjs";
import { createInstalledRunRoot, installedFilesystemPath } from "./installed-paths.mjs";
import { digest, inspectInstalledProduct } from "./installed-product.mjs";
import { readNativeProcessTable, ownershipPath, reclaimWindowsProcesses } from "./native-processes.mjs";
import { collectOwnedProcesses, planSignalTargets, signalProcessPlan } from "./process-ownership.mjs";

async function port() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
export async function until(predicate, label, timeout = 45_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await predicate(); if (value) return value; }
    catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out: ${label}${lastError ? `: ${lastError.message}` : ""}`);
}
async function targets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_500) });
  assert(response.ok);
  return response.json();
}
const electronExpression = `process.getBuiltinModule("module").createRequire(process.resourcesPath + "/app.asar/package.json")("electron")`;

export class InstalledApplication {
  static prepare(installer, evidenceDirectory, { expectedVersion } = {}) {
    const root = createInstalledRunRoot();
    const state = new InstalledApplication(root, evidenceDirectory);
    installNativePayload(state, installer, expectedVersion);
    return state;
  }
  async replace(installer, { expectedVersion } = {}) {
    assert(this.child && (this.child.exitCode !== null || this.child.signalCode !== null), "close the installed application before replacement");
    assert.equal(this.snapshot("before-installer-replacement").processes.length, 0, "installer replacement requires zero owned processes");
    const oldDirectory = installedFilesystemPath(this.appDirectory);
    const part = relative(installedFilesystemPath(this.root), oldDirectory);
    assert(part && !part.startsWith("..") && !isAbsolute(part), "installer replacement escaped its owned root");
    // NSIS performs its own in-place replacement. Directory payloads start
    // empty, retaining the previous actual bundle inside the owned run root.
    if (process.platform !== "win32") {
      const retained = join(this.root, `previous-payload-${this.launches.length}`);
      assert(!existsSync(retained)); renameSync(this.appDirectory, retained);
    }
    installNativePayload(this, installer, expectedVersion);
    this.clean = false;
    return this.payload;
  }
  constructor(root, evidenceDirectory) {
    this.root = root;
    this.evidenceDirectory = evidenceDirectory;
    this.roots = new Map(); this.reports = []; this.output = ""; this.launches = [];
    this.environment = {};
    for (const name of ["home", "profile", "tmp", "empty-bin", "workspace 中文 with spaces 'quoted'"]) mkdirSync(join(root, name));
    this.home = join(root, "home"); this.profile = join(root, "profile");
    this.data = join(this.home, ".omp-desktop"); this.workspace = join(root, "workspace 中文 with spaces 'quoted'");
    this.sentinels = [];
    for (const file of [".pi-desktop/pi.sqlite", ".pi-desktop/secrets/.machine-key", ".omp/agent/settings.json", ".agents/AGENTS.md"]) {
      const path = join(this.home, file);
      const content = file.endsWith(".json") ? '{"defaultProvider":"OMP_E2E_IGNORED_HOME_SENTINEL"}\n' : "OMP_E2E_IGNORED_HOME_SENTINEL\n";
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
      this.sentinels.push({ path, sha256: digest(Buffer.from(content)) });
    }
    this.ownerRoots = [ownershipPath(root)];
    mkdirSync(evidenceDirectory, { recursive: true });
  }
  progress(label) {
    writeFileSync(join(this.evidenceDirectory, "progress.json"), `${JSON.stringify({ label, root: this.root, mainPort: this.mainPort, rendererPort: this.rendererPort, at: new Date().toISOString() }, null, 2)}\n`);
  }
  childEnvironment() {
    const home = this.home;
    const env = {
      PATH: join(this.root, "empty-bin"), HOME: home, USERPROFILE: home,
      APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
      XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
      XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
      TMPDIR: join(this.root, "tmp"), TEMP: join(this.root, "tmp"), TMP: join(this.root, "tmp"),
      LANG: "en_US.UTF-8", LC_ALL: "en_US.UTF-8", USER: "omp-e2e",
      PI_DESKTOP_START_MAXIMIZED: "0",
    };
    for (const key of ["APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) mkdirSync(env[key], { recursive: true });
    for (const key of ["SystemRoot", "WINDIR", "windir"]) if (process.env[key]) env[key] = process.env[key];
    if (process.platform === "linux") {
      assert(process.env.DISPLAY, "native Linux UI requires a display");
      env.DISPLAY = process.env.DISPLAY;
      if (process.env.XAUTHORITY) env.XAUTHORITY = process.env.XAUTHORITY;
    }
    return env;
  }
  verifySentinels() {
    for (const file of this.sentinels) assert.equal(digest(readFileSync(file.path)), file.sha256, "existing PI/OMP fixture was modified");
    return { defaultProductDataRoot: this.data, dataOverrideAtLaunch: this.environment.PI_DESKTOP_DATA_DIR ?? null, unchanged: this.sentinels };
  }
  snapshot(label) {
    const table = readNativeProcessTable();
    const collected = collectOwnedProcesses({ table, selfPid: process.pid, roots: [...this.roots.values()], runRoots: this.ownerRoots });
    for (const entry of collected.processes) {
      if (entry.starttime) this.roots.set(`${entry.pid}@${entry.starttime}`, entry);
    }
    const report = { label, processes: collected.processes, ignored: collected.ignored, protectedAncestors: collected.protectedAncestors };
    this.reports.push(report);
    return { table, ...report };
  }
  async start() {
    this.mainPort = await port(); this.rendererPort = await port(); this.stopping = false;
    this.environment = this.childEnvironment();
    this.progress("spawn");
    this.child = spawn(this.payload.executable, [
      `--inspect=127.0.0.1:${this.mainPort}`, `--remote-debugging-port=${this.rendererPort}`,
      `--user-data-dir=${this.profile}`, "--no-first-run",
    ], { cwd: this.workspace, env: this.environment, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    this.child.stdout.on("data", (bytes) => { this.output += bytes; });
    this.child.stderr.on("data", (bytes) => { this.output += bytes; });
    const initial = readNativeProcessTable().get(this.child.pid);
    assert(initial?.starttime, "spawned Electron identity could not be observed");
    this.roots.set(`${initial.pid}@${initial.starttime}`, initial);
    const mainTarget = await until(async () => (await targets(this.mainPort)).find((t) => t.webSocketDebuggerUrl), "owned Main inspector");
    this.main = await CdpClient.connect(mainTarget.webSocketDebuggerUrl);
    this.progress("Main inspector connected");
    await until(() => this.main.evaluate(`${electronExpression}.app.isReady() && ${electronExpression}.app.getName() === "OMP Desktop" && Boolean(process.env.PI_DESKTOP_DATA_DIR)`, "Main", { awaitPromise: false }), "installed Electron/product initialization ready");
    this.identity = await this.main.evaluate(`(() => { const { app } = ${electronExpression}; return {
      isPackaged: app.isPackaged, name: app.getName(), version: app.getVersion(),
      resources: process.resourcesPath, executable: process.execPath, arch: process.arch,
      userData: app.getPath("userData"), home: process.getBuiltinModule("os").homedir(),
      dataRoot: process.env.PI_DESKTOP_DATA_DIR, electron: process.versions.electron
    }; })()`, "Main", { awaitPromise: false });
    assert(this.identity.isPackaged, "a development Electron launch is not installed acceptance");
    assert.equal(installedFilesystemPath(this.identity.resources), installedFilesystemPath(this.payload.resources));
    assert.equal(installedFilesystemPath(this.identity.executable), installedFilesystemPath(this.payload.executable));
    assert.equal(installedFilesystemPath(this.identity.userData), installedFilesystemPath(this.profile));
    assert.equal(installedFilesystemPath(this.identity.dataRoot), installedFilesystemPath(this.data));
    assert.equal(installedFilesystemPath(this.identity.home), installedFilesystemPath(this.home));
    assert.equal(this.identity.name, "OMP Desktop"); assert.equal(this.identity.arch, process.arch);
    this.progress("installed Main identity verified");
    const page = await until(async () => {
      const urls = await this.main.evaluate(`Array.from(${electronExpression}.webContents.getAllWebContents(), w => w.getURL())`, "Main", { awaitPromise: false });
      return (await targets(this.rendererPort)).find((t) => t.type === "page" && urls.includes(t.url) && t.url.includes("app.asar/out/renderer/index.html") && !t.url.includes("surface="));
    }, "renderer belonging to the verified Main process");
    this.renderer = await CdpClient.connect(page.webSocketDebuggerUrl);
    this.progress("owned renderer connected");
    await this.renderer.send("Runtime.enable"); await this.renderer.send("Page.enable");
    // DOM assertions need the owned window to paint, just as it does when a
    // user opens it. An occluded macOS window can pause animation frames.
    const windowActivation = await this.main.evaluate(`(() => {
      const { BrowserWindow } = ${electronExpression};
      const window = BrowserWindow.getAllWindows().find(window => window.webContents.getURL() === ${JSON.stringify(page.url)});
      if (!window) throw new Error("Verified installed window missing");
      window.show(); window.focus();
      return { visible: window.isVisible(), rendererUrl: window.webContents.getURL() };
    })()`, "Main", { awaitPromise: false });
    assert(windowActivation.visible, "installed UI acceptance requires a visible owned window");
    await until(() => this.renderer.evaluate('document.visibilityState === "visible"'), "owned installed window visible");
    await until(() => this.renderer.evaluate('Boolean(document.querySelector(".app-shell:not(.is-booting)")) && typeof window.piDesktop?.invoke === "function"'), "actual installed renderer ready");
    this.launches.push({ identity: this.identity, rendererUrl: page.url, windowActivation });
    this.snapshot("ready");
    this.progress("ready");
    return this;
  }
  async screenshot(name) {
    const result = await this.renderer.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(this.evidenceDirectory, `${name}.png`), Buffer.from(result.data, "base64"));
  }
  async waitGone(timeout = 15_000) {
    return until(() => this.snapshot("wait-exit").processes.length === 0, "all owned processes reaped", timeout);
  }
  async quit() {
    this.snapshot("before-ordered-quit"); this.stopping = true;
    // Enable the existing automated confirmation bypass only at teardown.
    // Startup and the whole user workflow ran with normal packaged behaviour;
    // no capture data was seeded and no native quit dialog coverage is claimed.
    await this.main.evaluate(`(() => { process.env.PI_DESKTOP_CAPTURE = "1"; const { app } = ${electronExpression}; setTimeout(() => app.quit(), 100); return true; })()`, "Main", { awaitPromise: false });
    await this.renderer.close(); await this.main.close();
    await until(() => this.child.exitCode !== null || this.child.signalCode !== null, "ordered application exit", 20_000);
    await this.waitGone();
    this.reports.push({ label: "ordered-quit", nativeConfirmationBypassedOnlyAtTeardown: true, noOwnedProcessesRemain: true });
  }
  async cleanup() {
    // Even a failed assertion should first use the actual ordered shutdown.
    // Hard cleanup remains a fallback; it never relaxes executable boundaries.
    if (this.main && this.child && this.child.exitCode === null && this.child.signalCode === null) {
      try { await this.quit(); }
      catch (error) { this.reports.push({ label: "cleanup-ordered-quit-failed", error: String(error) }); }
    }
    await this.renderer?.close(); await this.main?.close();
    let snapshot = this.snapshot("cleanup-before");
    if (process.platform === "win32" && snapshot.processes.length) {
      for (let attempt = 0; attempt < 3 && snapshot.processes.length; attempt++) {
        this.reports.push({ label: "cleanup-pinned-Windows-handles", result: reclaimWindowsProcesses(snapshot.processes, this.root) });
        try { await this.waitGone(2_000); } catch { /* Re-observe before escalation. */ }
        snapshot = this.snapshot("after-Windows-handle-reclaim");
      }
    }
    for (const signal of process.platform === "win32" ? [] : ["SIGTERM", "SIGKILL"]) {
      if (!snapshot.processes.length) break;
      const plan = planSignalTargets({ table: snapshot.table, owned: snapshot.processes, selfPid: process.pid });
      this.reports.push({ label: `cleanup-${signal}`, plan, results: signalProcessPlan(plan, signal) });
      try { await this.waitGone(5_000); } catch { /* Next owned escalation, never a foreign group. */ }
      snapshot = this.snapshot(`after-${signal}`);
    }
    assert.equal(snapshot.processes.length, 0, `owned process survivors; retained ${this.root}`);
    this.clean = true;
  }
  removeOwnedRoot() { assert(this.clean, "retain an unreclaimed run root"); rmSync(this.root, { recursive: true, force: true }); }
}

function installNativePayload(state, installer, expectedVersion) {
  const installDirectory = join(state.root, "应用 with spaces 'quoted'");
  mkdirSync(installDirectory, { recursive: true });
  if (process.platform === "darwin" && installer.endsWith(".dmg")) {
    const mount = join(state.root, "mount"); mkdirSync(mount, { recursive: true });
    let mounted = false;
    try {
      execFileSync("/usr/bin/hdiutil", ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, installer]);
      mounted = true;
      state.appDirectory = join(installDirectory, "OMP Desktop.app");
      execFileSync("/usr/bin/ditto", [join(mount, "OMP Desktop.app"), state.appDirectory]);
      state.installerMethod = "read-only DMG mount and actual bundle copy into the owned Applications directory";
    } finally {
      if (mounted) execFileSync("/usr/bin/hdiutil", ["detach", mount]);
    }
  } else if (process.platform === "win32" && installer.endsWith(".exe")) {
    state.appDirectory = join(installDirectory, "OMP Desktop");
    execFileSync(installer, ["/S", "/currentuser", `/D=${state.appDirectory}`], { timeout: 120_000 });
    state.installerMethod = "native NSIS silent current-user install to the owned directory";
  } else if (process.platform === "linux" && installer.endsWith(".AppImage")) {
    execFileSync(installer, ["--appimage-extract"], { cwd: installDirectory, timeout: 120_000, stdio: "ignore" });
    state.appDirectory = join(installDirectory, "squashfs-root");
    state.installerMethod = "actual AppImage extraction; no system package/desktop registration claimed";
  } else {
    // Other native lanes pass a directory extracted/installed from their real
    // installer. The caller records and validates that preparation separately.
    state.appDirectory = join(installDirectory, basename(installer));
    cpSync(installer, state.appDirectory, { recursive: true, verbatimSymlinks: true });
  }
  state.payload = inspectInstalledProduct(state.appDirectory, process.platform, expectedVersion);
}
