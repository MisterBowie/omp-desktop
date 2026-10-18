import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const root = resolve(process.env.OMP_RELEASE_SOURCE ?? process.cwd());
const load = (p) => import(pathToFileURL(join(root, p)));
const { InstalledApplication, until } = await load("scripts/e2e/installed-application.mjs");
const { invoke } = await load("scripts/e2e/installed-workflow.mjs");
const [installer, output] = process.argv.slice(2);
assert(installer && output);
mkdirSync(output, { recursive: true });
const application = InstalledApplication.prepare(resolve(installer), resolve(output), {
  expectedVersion: "0.1.1",
});
const electron =
  'process.getBuiltinModule("module").createRequire(process.resourcesPath+"/app.asar/package.json")("electron")';
const expression = (body) =>
  `(()=>{const {BrowserWindow,screen}=${electron};const window=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('app.asar/out/renderer/index.html')&&!w.webContents.getURL().includes('surface='));if(!window)throw Error('owned window unavailable');${body}})()`;
const main = (body) => application.main.evaluate(expression(body), "Main", { awaitPromise: false });
const report = {
  version: "0.1.1",
  platform: process.platform,
  arch: process.arch,
  checks: [],
  monitorCount: 0,
};
const check = async (id, body) => {
  try {
    const facts = await body();
    report.checks.push({ id, status: "passed", facts });
  } catch (e) {
    report.checks.push({ id, status: "failed", errorType: e.name, errorCode: e.code ?? null });
  }
};
try {
  await application.start();
  report.actualVersion = application.identity.version;
  assert.equal(report.actualVersion, "0.1.1");
  report.monitorCount = await main("return screen.getAllDisplays().length;");
  await check("WIN-FULLSCREEN-MAXIMIZED", async () => {
    if (await main("return window.isFullScreen();"))
      await invoke(application, "nativeMenuAction", [{ action: "toggleFullScreen" }]);
    if (!(await main("return window.isMaximized();")))
      await invoke(application, "nativeMenuAction", [{ action: "toggleMaximize" }]);
    await until(() => main("return window.isMaximized();"), "maximize");
    await invoke(application, "nativeMenuAction", [{ action: "toggleFullScreen" }]);
    await until(() => main("return window.isFullScreen();"), "fullscreen");
    const maximized = await main("return window.isMaximized();");
    const painted = await application.renderer.evaluate(
      'Boolean(document.querySelector(".app-shell")?.getBoundingClientRect().height)',
    );
    const pixels = await application.main.evaluate(
      expression(
        'return window.capturePage().then(image=>{const bytes=image.toBitmap();const colors=new Set();for(let i=0;i<bytes.length;i+=128)colors.add(bytes[i]+","+bytes[i+1]+","+bytes[i+2]);return {colors:colors.size,bytes:bytes.length};});',
      ),
      "Main",
    );
    report.fullscreenObservation = { maximized, painted, ...pixels };
    assert.equal(maximized, false);
    assert.equal(painted, true);
    assert(pixels.colors > 8, "fullscreen must paint app content");
    return pixels;
  });
  if (await main("return window.isFullScreen();")) {
    await invoke(application, "nativeMenuAction", [{ action: "toggleFullScreen" }]);
    await until(async () => !(await main("return window.isFullScreen();")), "leave fullscreen");
  }
  await check("WIN-TASKBAR-RESTORE", async () => {
    if (!(await main("return window.isMaximized();")))
      await invoke(application, "nativeMenuAction", [{ action: "toggleMaximize" }]);
    await until(() => main("return window.isMaximized();"), "maximize");
    await invoke(application, "nativeMenuAction", [{ action: "minimize" }]);
    await until(() => main("return window.isMinimized();"), "minimize");
    await main("window.restore();window.show();window.focus();return true;");
    await until(async () => !(await main("return window.isMinimized();")), "restore");
    const facts = await main(
      "return {bounds:window.getBounds(),workArea:screen.getDisplayMatching(window.getBounds()).workArea,maximized:window.isMaximized()};",
    );
    report.restoreObservation = facts;
    assert(facts.maximized);
    const b = facts.bounds,
      w = facts.workArea;
    assert(b.y + b.height <= w.y + w.height + 12, "restored window covers taskbar");
    return facts;
  });
  const { HostProcess } = await load("packages/host-runtime/dist/host-process.js");
  const probeRoot = join(application.root, "host-probes");
  mkdirSync(probeRoot, { recursive: true });
  const project = join(probeRoot, "project");
  mkdirSync(project);
  const binary = join(
    application.identity.resources,
    "bin",
    "pi-desktop-host-core" + (process.platform === "win32" ? ".exe" : ""),
  );
  const host = new HostProcess({
    binaryPath: binary,
    dataDir: join(probeRoot, "data"),
    onStderr() {},
  });
  try {
    await host.handshake();
    const { session } = await host.call("session.create", {
      projectPath: project,
      engine: "pi",
      mode: "agent",
      providerId: "audit",
      modelId: "audit-model",
    });
    await host.call("session.configure", { id: session.id, mode: "agent", permissionMode: "full" });
    await check("UTF16-HOST-READ", async () => {
      writeFileSync(
        join(project, "utf16.txt"),
        Buffer.concat([Buffer.from([255, 254]), Buffer.from("UTF16_MARKER 中文\n", "utf16le")]),
      );
      const result = await host.call("tools.execute", {
        sessionId: session.id,
        toolCallId: "utf16",
        toolName: "Read",
        args: { path: "utf16.txt" },
        mode: "agent",
      });
      assert.equal(result.ok, true);
      assert.match(JSON.stringify(result.content), /UTF16_MARKER/);
      return { preserved: true };
    });
    if (process.platform === "win32")
      await check("POWERSHELL-OUTPUT-EXIT", async () => {
        const catalog = await host.call("commandShells.list", {});
        const shell = catalog.effective;
        assert(shell && shell.available);
        assert.equal(shell.dialect, "powershell");
        const command = 'Write-Output "PS_OUTPUT_MARKER"; & $env:ComSpec /d /c "exit 7"';
        const result = await host.call("tools.execute", {
          sessionId: session.id,
          toolCallId: "powershell",
          toolName: "Bash",
          args: { command },
          expectedCommandShellId: shell.id,
          expectedCommandShellDialect: shell.dialect,
          mode: "agent",
          timeoutMs: 15000,
        });
        assert.match(JSON.stringify(result.content), /PS_OUTPUT_MARKER/);
        assert.equal(result.content.exitCode, 7);
        return { outputPreserved: true, exitCode: result.content.exitCode, shellId: shell.id };
      });
  } finally {
    await host.dispose();
  }
  await check("ORDERED-EXIT", async () => {
    await application.quit();
    return { noOwnedProcesses: true };
  });
} finally {
  await application.cleanup();
  report.cleaned = application.clean;
  report.dualMonitorQualified = process.platform === "win32" && report.monitorCount > 1;
  writeFileSync(join(output, "public-report.json"), JSON.stringify(report, null, 2) + "\n");
  if (application.clean) application.removeOwnedRoot();
}
console.log(JSON.stringify(report));
if (report.checks.some((c) => c.status === "failed")) process.exitCode = 1;
