#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { repositoryRoot, resolveElectronBinary } from "./e2e/boot.mjs";

const root = repositoryRoot();
const evidence = resolve(process.argv[2] ?? ".artifacts/chat-html-open-with");
await mkdir(join(evidence, "project/pages"), { recursive: true });
await writeFile(join(evidence, "project/pages/page.html"), "<!doctype html><title>HTML open-with fixture</title>");
await build({
  entryPoints: [join(root, "scripts/e2e/chat-html-open-with.tsx")],
  outfile: join(evidence, "renderer.js"), bundle: true, platform: "browser", format: "iife", jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' }, loader: { ".css": "empty" },
  alias: {
    "@pi-desktop/i18n": join(root, "packages/i18n/src/index.ts"),
    react: join(root, "apps/desktop/node_modules/react"),
    "react-dom": join(root, "apps/desktop/node_modules/react-dom"),
  },
  nodePaths: [join(root, "apps/desktop/node_modules")],
});
await build({
  entryPoints: [join(root, "apps/desktop/electron/main/browser-view.ts")],
  outfile: join(evidence, "browser-preview.cjs"), bundle: true, platform: "node", format: "cjs", external: ["electron"],
});
for (const name of ["project", "sibling", "scratch", "outside"]) {
  await mkdir(join(evidence, name), { recursive: true });
  await writeFile(join(evidence, name, "page.html"), `<!doctype html><title>${name}</title><h1>${name}</h1>`);
}
const css = (await Promise.all(["tokens", "base", "ui-kit", "chat-links"].map((name) => readFile(join(root, `apps/desktop/src/styles/${name}.css`), "utf8")))).join("\n");
await writeFile(join(evidence, "index.html"), `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:"><title>OMP HTML menu fixture</title><style>${css}</style><script src="renderer.js"></script>`);
await writeFile(join(evidence, "main.cjs"), `
const { app, BrowserWindow } = require("electron");
const { join } = require("node:path");
const { writeFileSync, realpathSync } = require("node:fs");
const { fileURLToPath } = require("node:url");
const { BrowserPane, resolveLocalFile, selectBrowserFileRoot } = require("./browser-preview.cjs");
app.setPath("userData", join(__dirname, "profile"));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: true, width: 1000, height: 740, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.show(); window.focus();
  window.webContents.on("console-message", (event) => console.error(event.message));
  try {
    const primary = join(__dirname, "project");
    const allowed = [join(__dirname, "sibling"), join(__dirname, "scratch")];
    const previews = [];
    const pane = new BrowserPane(() => {});
    pane.setWindow(window);
    for (const name of ["project", "sibling", "scratch"]) {
      const file = join(__dirname, name, "page.html");
      const selected = selectBrowserFileRoot(file, primary, allowed);
      const loaded = await pane.navigateAndWait(file, selected);
      if (!loaded || fileURLToPath(loaded.url) !== realpathSync(file)) throw Error("native preview failed: " + name);
      previews.push(name);
    }
    if (selectBrowserFileRoot(join(__dirname, "outside/page.html"), primary, allowed) !== null) throw Error("outside root accepted");
    if (resolveLocalFile(join(__dirname, "scratch/page.html"), primary) !== null) throw Error("Agent preview scope expanded");
    pane.dispose();
    await window.loadFile(join(__dirname, "index.html"));
    const project = JSON.stringify(join(__dirname, "project"));
    const report = await window.webContents.executeJavaScript("globalThis.htmlOpenWithProbe(" + project + ")");
    report.electron = process.versions.electron;
    report.nativeFilePreviews = previews;
    writeFileSync(join(__dirname, "report.json"), JSON.stringify(report, null, 2) + "\\n");
    writeFileSync(join(__dirname, "menu.png"), (await window.webContents.capturePage()).toPNG());
    app.quit();
  } catch (error) { console.error(error); app.exit(1); }
});
`);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(resolveElectronBinary().electronBinary, [join(evidence, "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (chunk) => { output += chunk; });
child.stderr.on("data", (chunk) => { output += chunk; });
const timeout = setTimeout(() => child.kill(), 45_000);
try {
  const [code, signal] = await once(child, "exit");
  await writeFile(join(evidence, "electron.txt"), output);
  assert.equal(code, 0, `HTML menu fixture failed (${signal ?? code}): ${output}`);
  const report = JSON.parse(await readFile(join(evidence, "report.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.checks.length, 9);
  assert.deepEqual(report.nativeFilePreviews, ["project", "sibling", "scratch"]);
  console.log(JSON.stringify(report, null, 2));
} finally { clearTimeout(timeout); }
