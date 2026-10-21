import { shell } from "electron";
import { IPC, ErrorCodes } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { OmpSessionBridge } from "../runtime/omp-session";
import type { IpcRegistrar } from "./types";
/** Host owns Git and paths. Main serializes against prompt/configure/delete. */
export function registerWorktreeIpc(deps: {
    registrar: IpcRegistrar;
    getHost: () => HostProcess | null;
    ompSessions?: OmpSessionBridge | null;
    acquireSessionOperation: (sessionId: string) => Promise<() => void>;
}) {
    const text = (input: unknown, key: string): string => {
        const value = input && typeof input === "object" ? Reflect.get(input, key) : null;
        if (typeof value !== "string" || !value.trim())
            throw Object.assign(new Error(`${key} required`), { errorCode: ErrorCodes.INVALID_ARGUMENT });
        return value.trim();
    };
    const host = () => { const current = deps.getHost(); if (!current)
        throw new Error("host unavailable"); return current; };
    deps.registrar.handle(IPC.invoke.worktreeProbe, (input) => host().call("worktree.probe", { projectPath: text(input, "projectPath") }));
    for (const [channel, method, field] of [
        [IPC.invoke.worktreePreview, "worktree.preview", "preview"],
        [IPC.invoke.worktreeMerge, "worktree.merge", "outcome"],
        [IPC.invoke.worktreeSync, "worktree.sync", "outcome"],
        [IPC.invoke.worktreePendingWork, "worktree.pendingWork", "pending"],
        [IPC.invoke.worktreeReveal, "worktree.location", "path"],
    ]) {
        deps.registrar.handle(channel, async (input: unknown) => {
            const sessionId = text(input, "sessionId");
            const previewToken = method === "worktree.merge" ? text(input, "previewToken") : undefined;
            const client = host();
            const release = await deps.acquireSessionOperation(sessionId);
            try {
                const { session } = await client.call<{
                    session?: {
                        engine?: string;
                    };
                }>("session.get", { id: sessionId, messageLimit: 1 });
                if (session?.engine !== "omp")
                    throw Object.assign(new Error("Worktree controls require a local OMP session"), { errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE });
                if (deps.ompSessions?.isBusy(sessionId))
                    throw Object.assign(new Error("The session is still running"), { errorCode: "WORKTREE_BUSY" });
                if (method === "worktree.merge" || method === "worktree.sync") {
                    if (!deps.ompSessions)
                        throw new Error("OMP runtime unavailable");
                    const outcome = await deps.ompSessions.disposeSession(sessionId, "worktree operation");
                    if (!outcome.ok)
                        throw Object.assign(new Error("Runtime cleanup incomplete"), { errorCode: "WORKTREE_BUSY" });
                }
                const result = await client.call<Record<string, unknown>>(method, {
                    sessionId, ...(method === "worktree.merge" ? { previewToken } : {}),
                }, 150000);
                if (method === "worktree.location") {
                    const error = await shell.openPath(String(result.path));
                    if (error)
                        throw new Error(error);
                    return { ok: true };
                }
                return result[field];
            }
            finally {
                release();
            }
        });
    }
}
