import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const hostProcessEntry = join(desktopRoot, "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

function forkPluginProcess({ entry }) {
  const child = fork(entry, [], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  return {
    postMessage: (message) => {
      if (child.connected) child.send(message);
    },
    onMessage: (handler) => child.on("message", handler),
    onExit: (handler) => child.on("exit", (code) => handler(code ?? 0)),
    kill: () => child.kill(),
  };
}

function writePlugin(id, permissions) {
  const dir = mkdtempSync(join(tmpdir(), "pi-clipboard-history-plugin-"));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id,
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(
    join(dir, "main.js"),
    `module.exports = {
      async onLoad() {
        await pi.commands.register({
          id: "${id}.read",
          title: "Read clipboard history",
          run: async () => {
            const entries = await pi.clipboard.getHistory();
            await pi.ui.showToast(String(entries.length) + ":" + String(entries[0]?.data instanceof Uint8Array));
          },
        });
      },
    };`,
    "utf8",
  );
  return dir;
}

function createRuntime(t) {
  const audits = [];
  const toasts = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    readClipboardHistory: async () => [
      {
        type: "image",
        format: "png",
        data: new Uint8Array([7, 8]),
        width: 1,
        height: 2,
        capturedAt: "2026-08-21T00:00:00.000Z",
      },
    ],
    audit: (entry) => audits.push(entry),
    showToast: (message) => toasts.push(message),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits, toasts };
}

test("clipboard.getHistory is brokered, permission-gated, and audited", async (t) => {
  const { runtime, audits, toasts } = createRuntime(t);
  const dir = writePlugin("clipboard.allowed", ["clipboard.read"]);
  await runtime.loadFromPath(dir);

  const history = await runtime.invokePanelBridge("clipboard.allowed", "clipboard.getHistory");
  assert.equal(history[0].type, "image");
  assert.deepEqual([...history[0].data], [7, 8]);
  assert.ok(
    audits.some((entry) => entry.api === "clipboard.getHistory" && entry.ok && entry.entryCount === 1),
  );

  await runtime.getCommands()[0].run();
  assert.deepEqual(toasts, ["1:true"]);
});

test("clipboard history is denied without clipboard.read", async (t) => {
  const { runtime, audits } = createRuntime(t);
  const dir = writePlugin("clipboard.denied", []);
  await runtime.loadFromPath(dir);

  await assert.rejects(
    () => runtime.invokePanelBridge("clipboard.denied", "clipboard.getHistory"),
    (error) => {
      assert.equal(error.code, "PERMISSION_DENIED");
      return true;
    },
  );
  assert.ok(audits.some((entry) => entry.api === "clipboard.read" && entry.errorCode === "PERMISSION_DENIED"));
});
