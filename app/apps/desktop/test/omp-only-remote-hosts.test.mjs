import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import { ErrorCodes, IPC } from "@pi-desktop/shared";

const source = new URL("../electron/main/ipc/remote-host-ipc.ts", import.meta.url);
const { outputText } = ts.transpileModule(readFileSync(source, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  fileName: source.pathname,
});
const module = { exports: {} };
const imports = {
  "@pi-desktop/shared": { ErrorCodes, IPC },
  electron: { app: { getName: () => "OMP Desktop", getVersion: () => "0.1.3" } },
  "../bootstrap/remote-hosts": { getActiveRemoteHostsBoot: () => null },
  "../remote/racp-remote-host-client": {
    exchangePairingToken: () => { throw new Error("retired pairing must never reach the network"); },
  },
};
new Function("require", "exports", "module", outputText)((id) => {
  assert.ok(Object.hasOwn(imports, id), `unexpected dependency: ${id}`);
  return imports[id];
}, module.exports, module);

test("the OMP product lists no remote Pi hosts and refuses remote mutations", async () => {
  const handlers = new Map();
  module.exports.registerRemoteHostIpc({
    registrar: { handle: (channel, handler) => handlers.set(channel, handler) },
  });
  assert.deepEqual(await handlers.get(IPC.invoke.remoteHostList)(), { hosts: [] });
  for (const channel of [
    IPC.invoke.remoteHostPair,
    IPC.invoke.remoteHostBootstrap,
    IPC.invoke.remoteHostRemove,
  ]) {
    await assert.rejects(handlers.get(channel)({}), {
      errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
    });
  }
});
