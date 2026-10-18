import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";
import * as shared from "../../../packages/shared/src/protocol.ts";
import { ErrorCodes } from "../../../packages/shared/src/errors.ts";
const module = { exports: {} };
const code = ts.transpileModule(readFileSync(new URL("../electron/main/ipc/worktree-ipc.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const opened = [];
new Function("require", "module", "exports", code)((id) => id === "electron" ? { shell: { openPath: async (path) => { opened.push(path); return ""; } } } : { ...shared, ErrorCodes }, module, module.exports);
const { registerWorktreeIpc } = module.exports;
const { IPC } = shared;
function fixture({ busy = false, clean = true, engine = "omp" } = {}) {
    const handlers = new Map(), calls = [];
    let holds = 0;
    registerWorktreeIpc({ registrar: { handle: (key, value) => handlers.set(key, value) }, getHost: () => ({ call: async (method, input) => {
                calls.push({ method, input });
                if (method === "session.get")
                    return { session: { engine } };
                if (method === "worktree.location")
                    return { path: "/private/owned/worktree" };
                if (method === "worktree.merge")
                    return { outcome: { result: "merged" } };
                return {};
            } }), acquireSessionOperation: async () => { holds++; return () => holds--; }, ompSessions: { isBusy: () => busy, disposeSession: async () => { calls.push({ method: "dispose" }); return { ok: clean }; } } });
    return { handlers, calls, holds: () => holds };
}
test("worktree merge serializes, reclaims the runtime, then enters the host", async () => {
    const f = fixture();
    assert.deepEqual(await f.handlers.get(IPC.invoke.worktreeMerge)({ sessionId: "s", previewToken: "reviewed" }), { result: "merged" });
    assert.deepEqual(f.calls.map((call) => call.method), ["session.get", "dispose", "worktree.merge"]);
    assert.equal(f.holds(), 0);
});
test("busy, unreclaimed and foreign-engine sessions never reach merge", async () => {
    for (const options of [{ busy: true }, { clean: false }, { engine: "pi" }]) {
        const f = fixture(options);
        await assert.rejects(() => f.handlers.get(IPC.invoke.worktreeMerge)({ sessionId: "s", previewToken: "t" }));
        assert.equal(f.calls.some((call) => call.method === "worktree.merge"), false);
        assert.equal(f.holds(), 0);
    }
});
test("missing preview token refuses before runtime cleanup", async () => {
    const f = fixture();
    await assert.rejects(() => f.handlers.get(IPC.invoke.worktreeMerge)({ sessionId: "s" }), /previewToken required/);
    assert.deepEqual(f.calls, []);
});
test("reveal gives the host-owned path to the OS and returns no path", async () => {
    const f = fixture();
    assert.deepEqual(await f.handlers.get(IPC.invoke.worktreeReveal)({ sessionId: "s", path: "/untrusted" }), { ok: true });
    assert.equal(opened.at(-1), "/private/owned/worktree");
});
