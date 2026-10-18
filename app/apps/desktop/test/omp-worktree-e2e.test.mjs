import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { FakeProvider } = await import("../../../experiments/omp-bridge/lib/provider.mjs");
const { writeModelsConfig } = await import("../../../experiments/omp-bridge/lib/models-config.mjs");
const { HostProcess } = await import("../../../packages/host-runtime/src/host-process.ts");
const { OmpRuntimeSupervisor, ensureSessionStateDir, findGateExtension, verifyBundledRuntime } = await import("../../../packages/omp-runtime/src/index.ts");
const { createOmpSessionBridge } = await import("../electron/main/runtime/omp-session.ts");
const { createOmpHostTurnLifecycle, createOmpExecutionRootResolver } = await import("../electron/main/runtime/omp-session-wiring.ts");
const { pidAlive, shellQuote } = await import("./helpers/omp-e2e-process.mjs");
const binary = join(here, "../../../target/debug/pi-desktop-host-core");
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
test("isolated OMP: approval, project switch, cancellation, native restore, reviewed merge and deletion", {
    timeout: 120000,
    skip: !process.env.OMP_BUNDLED_RESOURCES && "requires verified native resources and a built host",
}, async (t) => {
    assert.ok(existsSync(binary), "build the current host before running this acceptance test");
    const runtime = verifyBundledRuntime({ resourcesPath: process.env.OMP_BUNDLED_RESOURCES });
    const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-worktree-native-")));
    const repo = join(root, "project"), data = join(root, "data"), other = join(root, "other");
    mkdirSync(repo);
    mkdirSync(other);
    const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Worktree Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "README.md"), "project original\n");
    git("add", "README.md");
    git("commit", "-qm", "initial");
    const provider = await FakeProvider.start();
    let host, bridge, ended = deferred(), approvals = 0;
    const supervisors = [];
    t.after(async () => {
        await bridge?.dispose();
        for (const supervisor of supervisors) {
            const stopped = await supervisor.stop();
            assert.equal(stopped.reaped, true);
            assert.equal(stopped.cleaned, true);
        }
        await host?.dispose();
        await provider.close();
        rmSync(root, { recursive: true, force: true });
    });
    const startHost = async () => { host = new HostProcess({ binaryPath: binary, dataDir: data, onStderr() { } }); await host.handshake(); };
    await startHost();
    const { session } = await host.call("session.create", { engine: "omp", isolated: true, projectPath: repo, providerId: "m1fake", modelId: "local-model", mode: "agent" });
    const id = session.id;
    const { path: worktree } = await host.call("session.executionRoot", { sessionId: id });
    const originalBranch = git("rev-parse", "HEAD");
    const createBridge = () => createOmpSessionBridge({
        launcher: runtime.path, isPackaged: false, appPath: here, sessionDir: ensureSessionStateDir(data), gateResolver: () => findGateExtension(here),
        resolveExecutionRoot: createOmpExecutionRootResolver(() => host),
        createSupervisor: () => {
            const supervisor = new OmpRuntimeSupervisor({ dataRoot: data, launcherPath: runtime.path, expectedRuntimeVersion: "18.3.0", sessionDir: ensureSessionStateDir(data),
                args: ["--model", "m1fake/local-model", "--trusted-extension", findGateExtension(here)],
                prepareRun: (paths) => writeModelsConfig(paths.agentDir, { baseUrl: provider.baseUrl }) });
            supervisors.push(supervisor);
            return supervisor;
        },
        persistNativeSession: (info) => host.call("session.bindEngine", { id, adapterVersion: 1, runtimeVersion: info.runtimeVersion, nativeSessionId: info.nativeSessionId, nativeSessionPath: info.nativeSessionPath }),
        hostTurns: createOmpHostTurnLifecycle(() => host),
        sessionPolicy: { policy: async () => ({ mode: "agent", permissionMode: "ask" }) },
        capabilities: { snapshot: async (project) => { assert.equal(project, repo, "capabilities retain the owning project"); return { skills: [], memory: "fixture project memory" }; } },
        emitAgentEvent: ({ event }) => {
            if (event.type === "tool_permission_request") {
                approvals++;
                if (approvals === 1) {
                    assert.equal(existsSync(join(worktree, "result.txt")), false);
                    bridge.resolvePermission(event.request.requestId, "deny");
                }
                else {
                    if (approvals === 2)
                        assert.equal(existsSync(join(worktree, "result.txt")), false, "denied Write has no side effect");
                    bridge.resolvePermission(event.request.requestId, "allow-once");
                }
            }
            if (event.type === "agent_end")
                ended.resolve();
        },
    });
    bridge = createBridge();
    const prompt = async (content) => {
        const { engineRef } = await host.call("session.getEngineRef", { id });
        return bridge.prompt({ sessionId: id, content, projectPath: repo, providerId: "m1fake", modelId: "local-model", ...engineRef });
    };
    provider.script([
        { toolCalls: [{ id: "denied", name: "write", args: { path: "result.txt", content: "must not run" } }], finish: "tool_calls" },
        { toolCalls: [{ id: "allowed", name: "write", args: { path: "result.txt", content: "native isolated result\n" } }], finish: "tool_calls" },
        { text: "isolation finished", finish: "stop" },
    ]);
    await prompt("write the fixture");
    await host.call("workspace.set", { path: other });
    await ended.promise;
    assert.equal(approvals, 2, "denial and approval use the real gate");
    assert.equal(bridge.workingDirectory(id), worktree);
    assert.equal(bridge.projectDirectory(id), repo);
    assert.equal(readFileSync(join(worktree, "result.txt"), "utf8"), "native isolated result\n");
    assert.equal(existsSync(join(repo, "result.txt")), false);
    assert.equal(existsSync(join(other, "result.txt")), false);
    assert.equal(git("rev-parse", "HEAD"), originalBranch);
    // Observe the real child starting, then stop it through the same runner.
    const marker = join(worktree, "child-started");
    const started = deferred();
    const watcher = watch(worktree, (_event, name) => { if (String(name) === "child-started" && existsSync(marker))
        started.resolve(); });
    t.after(() => watcher.close());
    const childCode = "const fs=require('node:fs');fs.writeFileSync('child.tmp',String(process.pid));fs.renameSync('child.tmp','child-started');setInterval(()=>{},1000)";
    provider.script([{ toolCalls: [{ id: "long-command", name: "bash", args: { command: `${shellQuote(process.execPath)} -e ${shellQuote(childCode)}` } }], finish: "tool_calls" }]);
    ended = deferred();
    await prompt("start cancellable child");
    await started.promise;
    watcher.close();
    const pid = Number(readFileSync(marker, "utf8"));
    assert.equal(pidAlive(pid), true);
    const stopped = await bridge.stop(id);
    assert.equal(stopped.converged || stopped.toreDown, true);
    assert.equal(pidAlive(pid), false);
    await bridge.dispose();
    await host.dispose();
    await startHost();
    bridge = createBridge();
    const ref = (await host.call("session.getEngineRef", { id })).engineRef;
    const processCount = supervisors.length;
    renameSync(worktree, `${worktree}.parked`);
    try {
        await assert.rejects(() => prompt("must not fall back"), (error) => error.errorCode === "WORKTREE_MISSING" || error.data?.errorCode === "WORKTREE_MISSING");
        assert.equal(supervisors.length, processCount, "a missing worktree never starts a runtime in the project");
    } finally {
        renameSync(`${worktree}.parked`, worktree);
    }
    const history = await bridge.readHistory({ sessionId: id, projectPath: repo, ...ref });
    assert.ok(history.messages.some((m) => m.content.includes("isolation finished")), "native history survives host and runtime restart");
    ended = deferred();
    provider.script([
        { toolCalls: [{ id: "restored-write", name: "write", args: { path: "resumed.txt", content: "restored write" } }], finish: "tool_calls" },
        { text: "continued in original worktree", finish: "stop" },
    ]);
    await prompt("resume");
    await ended.promise;
    assert.equal(bridge.workingDirectory(id), worktree);
    assert.equal(readFileSync(join(worktree, "resumed.txt"), "utf8"), "restored write");
    assert.equal(existsSync(join(repo, "resumed.txt")), false);
    await bridge.dispose();
    const preview = (await host.call("worktree.preview", { sessionId: id })).preview;
    assert.equal(existsSync(join(repo, "result.txt")), false, "preview does not merge");
    const outcome = (await host.call("worktree.merge", { sessionId: id, previewToken: preview.previewToken })).outcome;
    assert.equal(outcome.result, "merged");
    assert.equal(readFileSync(join(repo, "result.txt"), "utf8"), "native isolated result\n");
    await host.call("session.delete", { id });
    assert.equal(existsSync(worktree), false);
    assert.equal(existsSync(join(repo, "README.md")), true);
});
