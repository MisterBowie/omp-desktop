#!/usr/bin/env node
/** Memory settings through the real React page, IPC, native OMP and an isolated Rust host. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveElectronBinary } from "./e2e/boot.mjs";
import { resolveHostBinary } from "./e2e/host.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "packages/agent-runtime/package.json"));
const { build } = require("esbuild");
const { electronBinary } = resolveElectronBinary(root);
const binary = resolveHostBinary();
const temp = await mkdtemp(join(tmpdir(), "omp-memory-ui-"));
try {
  await build({
    entryPoints: [join(root, "scripts/e2e/memory-settings.tsx")],
    outfile: join(temp, "renderer.js"),
    bundle: true,
    platform: "browser",
    format: "iife",
    jsx: "automatic",
    define: { "process.env.NODE_ENV": '"production"' },
    loader: { ".woff": "file", ".woff2": "file", ".ttf": "file" },
    alias: {
      "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
      react: join(root, "apps/desktop/node_modules/react"),
      "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
    },
    nodePaths: [join(root, "apps/desktop/node_modules")],
  });
  await build({
    entryPoints: [join(root, "apps/desktop/electron/main/ipc/memory-ipc.ts")],
    outfile: join(temp, "memory-ipc.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
  });
  await build({
    entryPoints: [join(root, "apps/desktop/electron/main/runtime/omp-memory.ts")],
    outfile: join(temp, "memory-service.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
  });
  // ESM workspace dependencies resolve from the application, not the temporary profile.
  await writeFile(
    join(temp, "tokens.css"),
    (await readFile(join(root, "apps/desktop/src/styles/tokens.css"), "utf8")).replace(
      /@theme(?: inline)?/g,
      ":root",
    ),
  );
  await writeFile(
    join(temp, "index.html"),
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'"><link rel="stylesheet" href="tokens.css"><link rel="stylesheet" href="renderer.css"><body><script src="renderer.js"></script>`,
  );
  await writeFile(
    join(temp, "main.cjs"),
    `
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("node:path");
const { registerMemoryIpc } = require("./memory-ipc.cjs");
app.setPath("userData", path.join(__dirname, "profile"));
app.whenReady().then(async () => {
  const { Host } = await import(${JSON.stringify(pathToFileURL(join(root, "scripts/e2e/host.mjs")).href)});
  const { IPC } = await import(${JSON.stringify(pathToFileURL(join(root, "packages/shared/dist/protocol.js")).href)});
  const host = new Host(${JSON.stringify(binary)}, path.join(__dirname, "data"));
  let window;
  let service;
  let failure;
  try {
    await host.start();
    const project = path.join(__dirname, "project");
    require("node:fs").mkdirSync(project);
    await host.call("project.memory.set", { path: project, content: "Manual project notes stay intact" });
    const registrar = { handle(channel, handler) {
      ipcMain.handle(channel, async (_event, input) => {
        try { return { ok: true, data: await handler(input) }; }
        catch (error) { return { ok: false, error: { code: error.errorCode || "INTERNAL", message: error.message } }; }
      });
    } };
    const { createOmpMemoryService } = require("./memory-service.cjs");
    const { OmpRuntimeSupervisor } = await import(${JSON.stringify(pathToFileURL(join(root, "packages/omp-runtime/dist/index.js")).href)});
    service = createOmpMemoryService({
      dataRoot: path.join(__dirname, "data"), host: () => host,
      sessions: { withIdleRuntimes: async operation => operation() },
      createSupervisor: options => new OmpRuntimeSupervisor({ dataRoot: path.join(__dirname, "data"), launcherPath: process.env.OMP_MEMORY_TEST_RUNTIME, ...options }),
    });
    registerMemoryIpc(registrar, service);
    registrar.handle(IPC.invoke.projectList, () => host.call("projects.list"));
    window = new BrowserWindow({ show: false, width: 1000, height: 1000, webPreferences: {
      preload: ${JSON.stringify(join(root, "apps/desktop/out/preload/index.cjs"))},
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    window.webContents.on("console-message", (event) => console.error(event.message));
    await window.loadFile(path.join(__dirname, "index.html"));
    const interactions = await window.webContents.executeJavaScript("globalThis.memorySettingsProbe()");
    await service.dispose();
    await host.restart();
    await window.loadFile(path.join(__dirname, "index.html"));
    const restart = await window.webContents.executeJavaScript("globalThis.memorySettingsProbe(true)");
    console.log("MEMORY_SETTINGS_PROBE " + JSON.stringify({ ...interactions, restart: restart.ok }));
  } catch (error) {
    failure = error;
    console.error("MEMORY_SETTINGS_PROBE " + JSON.stringify({ ok: false, error: String(error) }));
  } finally {
    window?.destroy();
    await service?.dispose();
    await host.stop();
    app.exit(failure ? 1 : 0);
  }
});
`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electronBinary, [join(temp, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (data) => {
      output += data;
    });
  const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
  let code;
  try {
    code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
  } finally {
    clearTimeout(timer);
  }
  const line = output.split(/\r?\n/).find((line) => line.startsWith("MEMORY_SETTINGS_PROBE "));
  assert(line, `no result (exit=${code}): ${output.slice(-4000)}`);
  console.log(line);
  assert.equal(code, 0, output.slice(-6000));
  assert.equal(JSON.parse(line.slice("MEMORY_SETTINGS_PROBE ".length)).ok, true);
} finally {
  await rm(temp, { recursive: true, force: true });
}
