/**
 * The declared-but-unimplemented audio surface must fail closed with a code.
 *
 * `pi.audio` is part of the SDK contract, so a call has to be answerable: the
 * permission gate runs first, and a granted call is refused with an audited
 * `UNSUPPORTED` instead of the bare `TypeError` a missing namespace produced.
 * These cases pin that contract so the audio service can land behind it.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostProcessEntry = join(here, "..", "electron/main/plugin-host-process.mjs");
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

// Set before the runtime is imported so nothing a host call touches can land in
// the developer's real data directory.
const dataDir = mkdtempSync(join(tmpdir(), "pi-audio-data-"));
process.env.PI_DESKTOP_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { PluginRuntime } = await import("../electron/main/plugin-runtime.ts");

const PLUGIN_ID = "com.example.audio";

/** Real host process, forked instead of Electron's utilityProcess. */
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

/** Every audio method, so a missing one fails a test rather than hiding. */
const AUDIO_METHODS = [
  "getInputDevices",
  "openInput",
  "closeInput",
  "getCaptureState",
  "onInputFrame",
  "offInputFrame",
  "openOutput",
  "writeOutput",
  "stopOutput",
  "closeOutput",
];

const PLUGIN_MAIN = `
  async function attempt(fn) {
    try {
      return { ok: true, value: (await fn()) ?? null };
    } catch (error) {
      return { ok: false, code: error?.code ?? null, name: error?.name ?? null, message: String(error?.message ?? error) };
    }
  }
  module.exports = {
    async onPanelInvoke(channel, payload) {
      if (channel === "shape") {
        return {
          type: typeof pi.audio,
          methods: Object.keys(pi.audio ?? {}).sort(),
          callable: Object.entries(pi.audio ?? {}).every(([, value]) => typeof value === "function"),
        };
      }
      if (channel === "call") {
        const name = payload.method;
        const args = Array.isArray(payload.args) ? payload.args : [];
        return attempt(() => pi.audio[name](...args));
      }
      throw new Error("unknown channel: " + channel);
    },
  };
`;

function writePlugin(t, { permissions = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pi-audio-plugin-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: PLUGIN_ID,
      name: "Audio Plugin",
      version: "0.0.1",
      main: "main.js",
      permissions,
    }),
    "utf8",
  );
  writeFileSync(join(dir, "main.js"), PLUGIN_MAIN, "utf8");
  return dir;
}

function createRuntime(t) {
  const audits = [];
  const runtime = new PluginRuntime({
    hostEntry: hostProcessEntry,
    spawnProcess: forkPluginProcess,
    audit: (entry) => audits.push(entry),
  });
  t.after(async () => {
    for (const loaded of runtime.listLoaded()) await runtime.unload(loaded.manifest.id);
  });
  return { runtime, audits };
}

const ALL_AUDIO_PERMISSIONS = ["audio.capture.background", "audio.playback.background"];

test("the audio namespace exists and exposes the SDK's ten methods", async (t) => {
  const { runtime } = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ALL_AUDIO_PERMISSIONS }));

  const shape = await runtime.invokePanelBridge(PLUGIN_ID, "shape");
  assert.equal(shape.type, "object");
  assert.equal(shape.callable, true);
  assert.deepEqual(shape.methods, [...AUDIO_METHODS].sort());
});

test("a granted capture method is refused with a coded, audited UNSUPPORTED", async (t) => {
  const { runtime, audits } = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ALL_AUDIO_PERMISSIONS }));

  for (const method of ["getInputDevices", "openInput", "getCaptureState"]) {
    const answer = await runtime.invokePanelBridge(PLUGIN_ID, "call", { method, args: [] });
    assert.equal(answer.ok, false, `${method} should refuse`);
    assert.equal(answer.name, "Error", `${method} should not fail as a TypeError`);
    assert.equal(answer.code, "UNSUPPORTED");
    assert.match(answer.message, new RegExp(`host api not available: audio\\.${method}`));
  }

  assert.deepEqual(
    audits
      .filter((entry) => String(entry.api).startsWith("audio."))
      .map((entry) => [entry.api, entry.errorCode]),
    [
      ["audio.getInputDevices", "UNSUPPORTED"],
      ["audio.openInput", "UNSUPPORTED"],
      ["audio.getCaptureState", "UNSUPPORTED"],
    ],
  );
});

test("playback methods are refused the same way and name their own permission", async (t) => {
  const { runtime, audits } = createRuntime(t);
  // Capture is granted, playback is not: the refusal must be the missing
  // permission, not the missing service, because the gate runs first.
  await runtime.loadFromPath(writePlugin(t, { permissions: ["audio.capture.background"] }));

  const denied = await runtime.invokePanelBridge(PLUGIN_ID, "call", {
    method: "openOutput",
    args: [{ sampleRate: 24000 }],
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "PERMISSION_DENIED");
  assert.deepEqual(
    audits
      .filter((entry) => entry.api === "audio.playback.background")
      .map((entry) => entry.errorCode),
    ["PERMISSION_DENIED"],
  );

  // With the grant, the same call answers the coded service refusal.
  const { runtime: granted, audits: grantedAudits } = createRuntime(t);
  await granted.loadFromPath(
    writePlugin(t, { permissions: ALL_AUDIO_PERMISSIONS, id: PLUGIN_ID }),
  );
  const refused = await granted.invokePanelBridge(PLUGIN_ID, "call", {
    method: "openOutput",
    args: [{ sampleRate: 24000 }],
  });
  assert.equal(refused.code, "UNSUPPORTED");
  assert.deepEqual(
    grantedAudits
      .filter((entry) => entry.api === "audio.openOutput")
      .map((entry) => [entry.ok, entry.errorCode]),
    [[false, "UNSUPPORTED"]],
  );
});

test("the synchronous registration helpers throw the same code", async (t) => {
  const { runtime } = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: ALL_AUDIO_PERMISSIONS }));

  // They are typed as `void` and cannot reject, so a refusal they cannot
  // deliver would be a handler that never fires.
  for (const method of ["onInputFrame", "offInputFrame"]) {
    const answer = await runtime.invokePanelBridge(PLUGIN_ID, "call", {
      method,
      args: [() => {}],
    });
    assert.equal(answer.ok, false, `${method} should throw`);
    assert.equal(answer.code, "UNSUPPORTED");
    assert.match(answer.message, new RegExp(`host api not available: audio\\.${method}`));
  }
});

test("without the permission nothing reaches the service, not even the refusal", async (t) => {
  const { runtime, audits } = createRuntime(t);
  await runtime.loadFromPath(writePlugin(t, { permissions: [] }));

  for (const method of ["getInputDevices", "openInput", "openOutput"]) {
    const answer = await runtime.invokePanelBridge(PLUGIN_ID, "call", { method, args: [] });
    assert.equal(answer.code, "PERMISSION_DENIED", `${method} should be denied`);
  }

  // The gateway audits the refusal under the permission it asked for, and the
  // service-level UNSUPPORTED entry is never produced: the gate runs first.
  assert.deepEqual(
    audits
      .filter((entry) => String(entry.api).startsWith("audio."))
      .map((entry) => [entry.api, entry.errorCode]),
    [
      ["audio.capture.background", "PERMISSION_DENIED"],
      ["audio.capture.background", "PERMISSION_DENIED"],
      ["audio.playback.background", "PERMISSION_DENIED"],
    ],
  );
});
