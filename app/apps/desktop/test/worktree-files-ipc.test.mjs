import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";
register(pathToFileURL(path.join(import.meta.dirname, "helpers/ts-import-hooks.mjs")));
const { IPC } = await import("../../../packages/shared/src/protocol.ts");
const { ErrorCodes } = await import("../../../packages/shared/src/errors.ts");
const files = await import("../../../packages/host-runtime/src/workspace-files.ts");
const roots = await import("../electron/main/workspace-roots.ts");
const refs = await import("../electron/main/chat-ref-resolve.ts");
const imports = { electron: { shell: {}, BrowserWindow: {}, dialog: {} }, "node:path": path, "node:os": await import("node:os"), "node:fs": fs,
    "@pi-desktop/shared": { IPC, ErrorCodes }, "@pi-desktop/agent-runtime": {}, "@pi-desktop/host-runtime": files,
    "../git-clone": {}, "../composer-paste": {}, "../composer-picker": {}, "../safe-open-external": {}, "../chat-ref-resolve": refs, "../fs-index": {}, "../workspace-roots": roots, "../browser-host": { BROWSER_PLUGIN_ID: "browser" } };
const module = { exports: {} };
const source = ts.transpileModule(fs.readFileSync(new URL("../electron/main/ipc/workspace-ipc.ts", import.meta.url), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
new Function("require", "module", "exports", source)((id) => { assert.ok(id in imports, id); return imports[id]; }, module, module.exports);
test("file list, preview and chat refs use the isolated root; a missing root never falls back", async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "omp-worktree-files-")));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const project = path.join(dir, "project"), isolated = path.join(dir, "isolated");
    fs.mkdirSync(project);
    fs.mkdirSync(isolated);
    fs.writeFileSync(path.join(project, "choice.txt"), "project version");
    fs.writeFileSync(path.join(isolated, "choice.txt"), "isolated version");
    fs.writeFileSync(path.join(isolated, "isolated-only.txt"), "only isolated");
    const handlers = new Map();
    const host = { call: async (method, input) => {
            if (method === "workspace.get")
                return { workspace: { path: project } };
            if (method === "session.get")
                return { session: { worktree: { status: "active" }, projectPath: project } };
            if (method === "session.getScratchPath")
                return { path: path.join(dir, "scratch") };
            if (method === "session.executionRoot") {
                if (input.sessionId === "missing")
                    throw Object.assign(new Error("worktree missing"), { errorCode: "WORKTREE_MISSING" });
                return { path: isolated };
            }
            throw new Error(method);
        } };
    module.exports.registerWorkspaceIpc({ registrar: { handle: (channel, fn) => handlers.set(channel, fn), handleWithEvent() { } }, getHost: () => host, getSidecar: () => null, dataDir: dir, plugins: {}, logger: { app() { } }, stripWinLongPrefix: (v) => v });
    const listed = await handlers.get(IPC.invoke.fsList)({ path: "", sessionId: "isolated" });
    assert.ok(listed.entries.some((entry) => entry.name === "isolated-only.txt"));
    const preview = await handlers.get(IPC.invoke.fsRead)({ path: "choice.txt", sessionId: "isolated" });
    assert.match(JSON.stringify(preview), /isolated version/);
    assert.doesNotMatch(JSON.stringify(preview), /project version/);
    const ref = await handlers.get(IPC.invoke.fsResolveRef)({ ref: "choice.txt", sessionId: "isolated" });
    assert.equal(ref.match.absolutePath, path.join(isolated, "choice.txt"));
    await assert.rejects(() => handlers.get(IPC.invoke.fsRead)({ path: path.join(project, "choice.txt"), sessionId: "missing" }), (error) => error.errorCode === "WORKTREE_MISSING");
});
