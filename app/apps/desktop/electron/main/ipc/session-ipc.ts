import { shell } from "electron";
import { isAbsolute, join, relative, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import {
  ErrorCodes,
  IPC,
  modelConfigImportKey,
  publicModelConfigCandidate,
  draftMatchesExisting,
  providerCreateInputFromDraft,
  isModelConfigImportSource,
  type ActivationScope,
  type ModelConfigImportDraft,
  type Mode,
  type SessionThinkingLevel,
} from "@pi-desktop/shared";
import {
  convertSession,
  scanAllSources,
  scanModelConfigs,
  type ExternalSessionSummary,
  type ExternalSource,
} from "../importers";
import type { AgentSidecar } from "../agent-sidecar";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { PersistenceOutbox } from "../persistence-outbox";
import type { PluginRuntime } from "../plugin-runtime";
import { readSessionCollaboration } from "../services/session-collaboration";
import { searchSessionsAcrossSources } from "../services/session-search";
import type { IpcRegistrar } from "./types";

type RuntimeSession = {
  id?: string;
  projectPath?: string | null;
  providerId?: string;
  modelId?: string;
  thinkingLevel?: SessionThinkingLevel;
  [key: string]: unknown;
};

type ImportableModelConfig = ModelConfigImportDraft & {
  id?: string;
  secretValue?: string;
};

let scannedImportSessions = new Map<string, ExternalSessionSummary>();
let scannedModelConfigs = new Map<string, ModelConfigImportDraft>();

const IMPORT_SOURCES = new Set<ExternalSource>([
  "claude-code",
  "opencode",
  "codex",
  "pi",
]);

function importSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    typeof source !== "string" ||
    !IMPORT_SOURCES.has(source as ExternalSource) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return `${source}:${externalId}`;
}

function rejectNativeMutation(sessionId: unknown, action: string): void {
  if (typeof sessionId === "string" && sessionId.startsWith("native-pi:")) {
    throw Object.assign(new Error(`Native Pi session ${action} is not supported`), {
      errorCode: ErrorCodes.INVALID_ARGUMENT,
    });
  }
}

/**
 * Refuse an OMP session from a host-only mutation that this build cannot map
 * onto the OMP runtime. The pinned runtime exposes no dynamic working-directory
 * RPC and no transcript rewrite/revision RPC — the native transcript is its
 * sole writer — so forwarding one of these to the host would fork the desktop
 * row from the native state. Pi sessions keep their existing path.
 */
function refuseOmpSessionAction(engine: string, action: string): void {
  if (engine !== "omp") return;
  throw Object.assign(new Error(`${action} is not available for OMP sessions in this build`), {
    errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
    engine: "omp",
    area: action,
  });
}

function modelConfigSelectionKey(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const source = Reflect.get(value, "source");
  const externalId = Reflect.get(value, "externalId");
  if (
    !isModelConfigImportSource(source) ||
    typeof externalId !== "string" ||
    !externalId
  ) {
    return null;
  }
  return modelConfigImportKey(source, externalId);
}

export type SessionIpcDependencies = {
  registrar: IpcRegistrar;
  getHost: () => HostProcess | null;
  getSidecar: () => AgentSidecar | null;
  dataDir: string;
  activeTurns: ReadonlyMap<string, string>;
  sessionProjects: Map<string, string | null>;
  persistenceOutbox: PersistenceOutbox;
  logger: Pick<Logger, "app">;
  plugins: Pick<PluginRuntime, "broadcastEvent">;
  sessionCapabilityContext: () => Promise<{ providers: any; defaults: any }>;
  enrichSession: (session: any, providers: any, defaults: any) => any;
  acquireSessionOperation: (sessionId: string) => Promise<() => void>;
  stripWinLongPrefix: (path: string) => string;
  engineRouter?: {
    engineForSession(sessionId: string): Promise<string>;
    requireForSession(sessionId: string, capability: "prompt" | "stop" | "branch" | "modelSwitch"): Promise<string>;
  };
  ompSessions?: {
    rename(sessionId: string, title: string, context?: unknown): Promise<{ ok: boolean; reason?: string; inconsistent?: boolean }>;
    configure(
      sessionId: string,
      config: { mode?: string | null; providerId?: string | null; modelId?: string | null; thinkingLevel?: string | null; permissionMode?: string | null },
    ): Promise<{ ok: boolean; reason?: string; inconsistent?: boolean }>;
    disposeSession(sessionId: string, reason?: string): Promise<{ ok: boolean; failures: Array<{ sessionId: string; detail: string }> }>;
  } | null;
};

export function registerSessionIpc({
  registrar,
  getHost,
  getSidecar,
  dataDir,
  activeTurns,
  sessionProjects,
  persistenceOutbox,
  logger,
  plugins,
  sessionCapabilityContext,
  enrichSession,
  acquireSessionOperation,
  stripWinLongPrefix,
  engineRouter,
  ompSessions,
}: SessionIpcDependencies): void {
  let host: HostProcess | null = null;
  let sidecar: AgentSidecar | null = null;
  const handle = (channel: string, fn: (...args: any[]) => Promise<any>) => {
    registrar.handle(channel, async (...args) => {
      host = getHost();
      sidecar = getSidecar();
      return fn(...args);
    });
  };

  handle(IPC.invoke.sessionSearch, async (input) => {
    if (!host) throw new Error("host unavailable");
    return searchSessionsAcrossSources(host, sidecar, input);
  });
  handle(IPC.invoke.sessionSearchContext, async (input) => {
    if (!host) throw new Error("host unavailable");
    return host.call("search.context", input);
  });
  handle(IPC.invoke.sessionList, async () => {
    if (!host) throw new Error("host unavailable");
    const [result, native, { providers, defaults }] = await Promise.all([
      host.call<{ sessions: RuntimeSession[] }>("session.list"),
      sidecar
        ? sidecar.call<{ sessions: RuntimeSession[] }>("native.session.list").catch(() => ({ sessions: [] }))
        : Promise.resolve({ sessions: [] }),
      sessionCapabilityContext(),
    ]);
    return {
      ...result,
      sessions: [
        ...result.sessions.map((session) => ({
          ...enrichSession(session, providers, defaults),
          source: "desktop",
        })),
        ...native.sessions,
      ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
    };
  });
  handle(IPC.invoke.sessionCreate, async (input = {}) => {
    if (!host) throw new Error("host unavailable");
    const capabilityPromise = sessionCapabilityContext();
    const res = await host.call<{ session?: (RuntimeSession & { id?: string }) | null }>(
      "session.create",
      input,
    );
    logger.app("session", "info", "session created", { sessionId: res.session?.id });
    if (!res.session) return res;
    const { providers, defaults } = await capabilityPromise;
    return { ...res, session: enrichSession(res.session, providers, defaults) };
  });
  handle(
    IPC.invoke.sessionFork,
    async (
      input: { sessionId?: string; title?: string; throughMessageId?: string } = {},
    ) => {
      const sessionId = String(input.sessionId ?? "").trim();
      if (sessionId.startsWith("native-pi:")) {
        // Native forks read the canonical JSONL and publish a new child file in
        // the sidecar; the Rust host and the Desktop queue are never involved.
        if (!sidecar) throw new Error("sidecar unavailable");
        const title = typeof input.title === "string" ? input.title.trim().replace(/\s+/g, " ").slice(0, 200) : "";
        const throughMessageId =
          typeof input.throughMessageId === "string" ? input.throughMessageId.trim() : "";
        if (throughMessageId.length > 256) {
          throw Object.assign(new Error("throughMessageId is too long"), {
            errorCode: ErrorCodes.INVALID_ARGUMENT,
          });
        }
        const result = await sidecar.call<{ session?: RuntimeSession | null }>(
          "native.session.fork",
          {
            id: sessionId,
            ...(title ? { title } : {}),
            ...(throughMessageId ? { throughMessageId } : {}),
          },
        );
        logger.app("session", "info", "native session forked", {
          sessionId: (result.session as { id?: string } | null)?.id,
          data: { sourceSessionId: sessionId },
        });
        return result;
      }
      if (!host) throw new Error("host unavailable");
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      // An OMP fork is gated on the `branch` capability, which this build keeps
      // closed (see OMP_ENGINE_CAPABILITIES): the pinned runtime's `branch` is a
      // redo-from-user fork, not PI's copy-through-message fork, and the desktop
      // cannot yet map a renderer message to an OMP entry id. The gate refuses an
      // OMP fork here with ENGINE_CAPABILITY_UNAVAILABLE rather than silently
      // producing a wrong child.
      const forkEngine = engineRouter ? await engineRouter.requireForSession(sessionId, "branch") : "pi";
      if (forkEngine === "omp") {
        throw Object.assign(new Error("branching is not available for OMP sessions in this build"), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          engine: "omp",
          capability: "branch",
        });
      }
      if (activeTurns.has(sessionId)) {
        throw Object.assign(new Error("Cannot fork a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      // Resolve enrichment before the mutation so a provider-list failure
      // cannot report a failed IPC after the child has already been committed.
      const { providers, defaults } = await sessionCapabilityContext();
      let result: { session?: RuntimeSession | null };
      try {
        result = await host.call("session.fork", {
          sessionId,
          title: String(input.title ?? "").trim() || undefined,
          throughMessageId:
            String(input.throughMessageId ?? "").trim() || undefined,
        });
      } catch (error: any) {
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot fork a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      logger.app("session", "info", "session forked", {
        sessionId: (result.session as { id?: string }).id,
        data: { sourceSessionId: sessionId },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
    },
  );
  handle(
    IPC.invoke.sessionGet,
    async (
      input:
        | string
        | {
            id?: string;
            messageBefore?: number;
            messageAround?: string;
            messageLimit?: number;
            contentLimit?: number;
          },
    ) => {
      if (!host) throw new Error("host unavailable");
      const request = typeof input === "string" ? { id: input } : input ?? {};
      const id = String(request.id ?? "").trim();
      if (!id) throw new Error("session id required");
      if (id.startsWith("native-pi:")) {
        if (!sidecar) throw new Error("sidecar unavailable");
        return sidecar.call("native.session.get", { id, ...request });
      }
      const [result, { providers, defaults }] = await Promise.all([
        host.call<{ session?: RuntimeSession | null }>("session.get", {
          id,
          ...(typeof request.messageAround === "string" && request.messageAround.trim()
            ? { messageAround: request.messageAround }
            : {}),
          ...(Number.isInteger(request.messageBefore) && request.messageBefore! >= 0
            ? { messageBefore: request.messageBefore }
            : {}),
          ...(Number.isInteger(request.messageLimit) && request.messageLimit! > 0
            ? { messageLimit: request.messageLimit }
            : {}),
          ...(Number.isInteger(request.contentLimit) && request.contentLimit! > 0
            ? { contentLimit: request.contentLimit }
            : {}),
        }),
        sessionCapabilityContext(),
      ]);
      return result.session
        ? { ...result, session: enrichSession(result.session, providers, defaults) }
        : result;
    },
  );
  handle(IPC.invoke.sessionCollaboration, async (input?: { sessionId?: unknown }) => {
    if (!host) throw new Error("host unavailable");
    const sessionId = typeof input?.sessionId === "string" ? input.sessionId.trim() : "";
    rejectNativeMutation(sessionId, "collaboration");
    if (!sessionId || sessionId.length > 256) {
      throw Object.assign(new Error("sessionId must be a non-empty string of at most 256 characters"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    return readSessionCollaboration(host, sidecar, sessionId);
  });
  handle(IPC.invoke.sessionOpen, async (rawSessionId: string) => {
    if (!host) throw new Error("host unavailable");
    const sessionId = String(rawSessionId ?? "").trim();
    if (!sessionId) throw new Error("session id required");
    if (sessionId.startsWith("native-pi:")) {
      if (!sidecar) throw new Error("sidecar unavailable");
      return sidecar.call("native.session.get", { id: sessionId, messageLimit: 1 });
    }
    const [result, { providers, defaults }] = await Promise.all([
      host.call<{ session?: RuntimeSession | null }>("session.get", {
        id: sessionId,
        messageLimit: 1,
      }),
      sessionCapabilityContext(),
    ]);
    if (!result.session) {
      throw Object.assign(new Error("Session not found"), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return { ...result, session: enrichSession(result.session, providers, defaults) };
  });
  handle(IPC.invoke.sessionDelete, async (id: string) => {
    if (id.startsWith("native-pi:")) {
      throw Object.assign(new Error("Native Pi sessions cannot be deleted from PI-Desktop"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!host) throw new Error("host unavailable");
    // The engine must be resolved BEFORE the host row is deleted: a row that is
    // gone can no longer tell the router it is OMP. Resolution failure is fail
    // closed — an unidentified session must not be deleted as if it were Pi.
    let isOmp = false;
    if (engineRouter) {
      isOmp = (await engineRouter.requireForSession(id, "stop")) === "omp";
    }
    // An OMP session must be reclaimed through the wired bridge before the
    // delete commits. A session that is OMP but has no bridge wired must fail
    // closed: deleting its host row without reclaiming its runtime would leave
    // a live process with no durable record to reach it.
    if (isOmp) {
      if (!ompSessions) {
        throw Object.assign(new Error("this build has no OMP runtime to reclaim this session"), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
        });
      }
      const outcome = await ompSessions.disposeSession(id, "session deleted");
      if (!outcome.ok) {
        throw Object.assign(
          new Error(`the OMP session's runtime could not be reclaimed, so it was not deleted: ${outcome.failures.map((failure) => failure.detail).join("; ")}`),
          { errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE },
        );
      }
    }
    const res = await host.call<{ ok?: boolean }>("session.delete", { id });
    await persistenceOutbox.dropSession(id);
    // Drop the session's pi-agent so a later session with the same id (or a
    // stale runtime) can't answer with this session's context.
    if (sidecar) {
      sidecar.clearProjectInstructionRoot(id);
      sidecar.clearVendorAuthBindings(id);
      await sidecar
        .call("agent.disposeSession", { sessionId: id })
        .catch(() => undefined);
    }
    sessionProjects.delete(id);
    logger.app("session", "info", "session deleted", { sessionId: id });
    return res;
  });
  handle(IPC.invoke.sessionArchive, async (id: string) => {
    // Archive is a product-visible state change. For an OMP session it must
    // reclaim the runtime first; a failed reclaim is a failed archive (the
    // renderer keeps the session unarchived and surfaces the error). Unarchive
    // is a separate no-op path that never starts a runtime.
    if (id.startsWith("native-pi:")) return { ok: true };
    if (!host) throw new Error("host unavailable");
    if (engineRouter) {
      const engine = await engineRouter.requireForSession(id, "stop");
      if (engine === "omp") {
        if (!ompSessions) {
          throw Object.assign(new Error("this build has no OMP runtime to reclaim this session"), {
            errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          });
        }
        const outcome = await ompSessions.disposeSession(id, "session archived");
        if (!outcome.ok) {
          throw Object.assign(
            new Error(`the OMP session's runtime could not be reclaimed, so it was not archived: ${outcome.failures.map((failure) => failure.detail).join("; ")}`),
            { errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE },
          );
        }
      }
    }
    return { ok: true };
  });
  handle(IPC.invoke.sessionRename, async (id: string, title: string) => {
    if (id.startsWith("native-pi:")) {
      throw Object.assign(new Error("Native Pi session rename is not supported"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    if (!host) throw new Error("host unavailable");
    // An OMP session's name lives in its native transcript; the desktop row
    // must not fork from it. The runtime's `set_session_name` is the authority,
    // and only on its success is the desktop title persisted. Rename works in
    // every state (active, idle, restart): the bridge briefly restores the
    // native session when needed and disposes it again afterwards.
    const engine = engineRouter ? await engineRouter.requireForSession(id, "prompt") : "pi";
    if (engine === "omp") {
      // A session that is OMP but has no wired bridge must fail closed: its
      // name lives in the native transcript, and renaming the desktop row
      // alone would fork the two.
      if (!ompSessions) {
        throw Object.assign(new Error("this build has no OMP runtime to rename this session"), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
        });
      }
      const session = await host.call<{ session?: { projectPath?: string | null; providerId?: string | null; modelId?: string | null; thinkingLevel?: string | null } | null }>(
        "session.get",
        { id, messageLimit: 1 },
      );
      const ref = await host.call<{ engineRef?: { nativeSessionId?: string | null; nativeSessionPath?: string | null; adapterVersion?: number | null; runtimeVersion?: string | null } | null }>(
        "session.getEngineRef",
        { id },
      );
      const result = await ompSessions.rename(id, title, {
        projectPath: session?.session?.projectPath ?? null,
        providerId: session?.session?.providerId ?? null,
        modelId: session?.session?.modelId ?? null,
        thinkingLevel: session?.session?.thinkingLevel ?? null,
        nativeSessionId: ref?.engineRef?.nativeSessionId ?? null,
        nativeSessionPath: ref?.engineRef?.nativeSessionPath ?? null,
        adapterVersion: ref?.engineRef?.adapterVersion ?? null,
        runtimeVersion: ref?.engineRef?.runtimeVersion ?? null,
      });
      if (!result.ok) {
        throw Object.assign(new Error(result.reason ?? "the OMP runtime refused the rename"), {
          errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          ...(result.inconsistent ? { data: { inconsistent: true } } : {}),
        });
      }
      return { ok: true };
    }
    return host.call("session.rename", { id, title });
  });
  handle(
    IPC.invoke.sessionMoveProject,
    async (input: { sessionId?: string; projectPath?: string } = {}) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input.sessionId ?? "").trim();
      rejectNativeMutation(sessionId, "project move");
      const projectPath = String(input.projectPath ?? "").trim();
      if (!sessionId) {
        throw Object.assign(new Error("sessionId required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      if (!projectPath) {
        throw Object.assign(new Error("projectPath required"), {
          errorCode: ErrorCodes.INVALID_ARGUMENT,
        });
      }
      // An OMP session's working directory is fixed when its runtime first
      // starts (the pinned runtime exposes no dynamic cwd RPC, and a restored
      // native header retains the original cwd). Moving the desktop row alone
      // would fork the host projectPath from the runtime's actual cwd.
      refuseOmpSessionAction(
        engineRouter ? await engineRouter.engineForSession(sessionId) : "pi",
        "moving a session between projects",
      );
      const releaseSessionOperation = await acquireSessionOperation(sessionId);
      try {
      if (activeTurns.has(sessionId)) {
        throw Object.assign(new Error("Cannot move a running session"), {
          errorCode: ErrorCodes.AGENT_BUSY,
        });
      }
      let result: { session?: (RuntimeSession & { projectPath?: string | null }) | null };
      try {
        result = await host.call("session.moveProject", { sessionId, projectPath });
      } catch (error: any) {
        // The durable running-turn guard can still reject a session whose turn
        // began between the check above and the host call.
        if (error?.data?.errorCode === ErrorCodes.CONFLICT) {
          throw Object.assign(new Error("Cannot move a running session"), {
            errorCode: ErrorCodes.AGENT_BUSY,
          });
        }
        throw error;
      }
      if (!result.session) return result;
      const movedProjectPath = result.session.projectPath?.trim() || null;
      sessionProjects.set(sessionId, movedProjectPath);
      // The live pi-agent caches the project instruction root and vendor auth
      // bindings. Drop it after a successful move so the next turn is rebuilt
      // from the moved session's own project instead of the previous one.
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
        if (movedProjectPath) {
          sidecar.setProjectInstructionRoot(sessionId, movedProjectPath);
        }
      }
      const { providers, defaults } = await sessionCapabilityContext();
      logger.app("session", "info", "session project moved", {
        sessionId,
        data: { projectPath: movedProjectPath },
      });
      return {
        ...result,
        session: enrichSession(result.session, providers, defaults),
      };
      } finally {
        releaseSessionOperation();
      }
    },
  );
  handle(
    IPC.invoke.sessionReplaceMessages,
    async (input: { sessionId: string; messages: unknown[] }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      if (!sessionId) throw new Error("sessionId required");
      rejectNativeMutation(sessionId, "transcript replacement");
      // The OMP native transcript is the sole writer of its history; the host
      // transcript is a Pi projection. Replacing messages in the host row for
      // an OMP session would fork the two.
      refuseOmpSessionAction(
        engineRouter ? await engineRouter.engineForSession(sessionId) : "pi",
        "transcript replacement",
      );
      // Drop the live pi-agent so the next prompt reseeds from the truncated
      // transcript instead of replaying the discarded branch in memory.
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
      }
      return host.call("session.replaceMessages", {
        sessionId,
        messages: input.messages ?? [],
      });
    },
  );
  handle(
    IPC.invoke.sessionSaveRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      messages: unknown[];
      makeActive?: boolean;
    }) => {
      if (!host) throw new Error("host unavailable");
      rejectNativeMutation(input?.sessionId, "revision save");
      // OMP revisions live inside its native transcript, which the desktop
      // never rewrites; a host-side revision save would create a second,
      // divergent history.
      refuseOmpSessionAction(
        engineRouter ? await engineRouter.engineForSession(String(input?.sessionId || "")) : "pi",
        "saving a transcript revision",
      );
      return host.call("session.saveRevision", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
        messages: input?.messages ?? [],
        makeActive: input?.makeActive === true,
      });
    },
  );
  handle(
    IPC.invoke.sessionListRevisions,
    async (input: { sessionId: string; rootUserId: string }) => {
      if (!host) throw new Error("host unavailable");
      rejectNativeMutation(input?.sessionId, "revision listing");
      // The host revision family is a Pi transcript projection; an OMP session
      // has no host-side revision list to read, and masquerading an empty one
      // would hide the native history.
      refuseOmpSessionAction(
        engineRouter ? await engineRouter.engineForSession(String(input?.sessionId || "")) : "pi",
        "listing transcript revisions",
      );
      return host.call("session.listRevisions", {
        sessionId: String(input?.sessionId || ""),
        rootUserId: String(input?.rootUserId || ""),
      });
    },
  );
  handle(
    IPC.invoke.sessionActivateRevision,
    async (input: {
      sessionId: string;
      rootUserId: string;
      revisionIndex: number;
      prefix?: unknown[];
    }) => {
      if (!host) throw new Error("host unavailable");
      const sessionId = String(input?.sessionId || "");
      rejectNativeMutation(sessionId, "revision activation");
      // Activating a Pi revision rewrites the host transcript; OMP has no
      // corresponding native operation, so the desktop must not masquerade a
      // host-only activation for it.
      refuseOmpSessionAction(
        engineRouter ? await engineRouter.engineForSession(sessionId) : "pi",
        "activating a transcript revision",
      );
      if (sidecar) {
        sidecar.clearProjectInstructionRoot(sessionId);
        sidecar.clearVendorAuthBindings(sessionId);
        await sidecar
          .call("agent.disposeSession", { sessionId })
          .catch(() => undefined);
      }
      return host.call("session.activateRevision", {
        sessionId,
        rootUserId: String(input?.rootUserId || ""),
        revisionIndex: Number(input?.revisionIndex || 0),
        prefix: input?.prefix ?? [],
      });
    },
  );
  handle(IPC.invoke.sessionGetScratchPath, async (input: { sessionId: string }) => {
    // The scratch directory is host-owned (`<dataDir>/scratch/<sessionId>`)
    // and is not the native transcript: it holds renderer-originated
    // attachments, pasted files, screenshots and speech/image material for any
    // session, independent of which engine serves it. It is deliberately NOT
    // gated by engine — an OMP session still gets a desktop scratch store.
    rejectNativeMutation(input?.sessionId, "scratch access");
    if (!host) throw new Error("host unavailable");
    return host.call<{ path: string }>("session.getScratchPath", {
      sessionId: String(input?.sessionId || ""),
    });
  });
  handle(IPC.invoke.sessionOpenScratchPath, async (input: { sessionId: string }) => {
    rejectNativeMutation(input?.sessionId, "scratch access");
    if (!host) throw new Error("host unavailable");
    const sessionId = String(input?.sessionId || "").trim();
    const result = await host.call<{ path: string }>("session.getScratchPath", {
      sessionId,
    });
    const scratchPath = resolve(String(result?.path ?? ""));
    const scratchRoot = resolve(join(dataDir, "scratch"));
    const rel = relative(scratchRoot, scratchPath);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
      throw Object.assign(new Error("invalid session id"), {
        errorCode: ErrorCodes.INVALID_ARGUMENT,
      });
    }
    mkdirSync(scratchPath, { recursive: true });
    const openError = await shell.openPath(stripWinLongPrefix(scratchPath));
    if (openError) throw new Error(openError);
    return { ok: true, path: scratchPath };
  });
  handle(
    IPC.invoke.sessionConfigure,
    async (
      id: string,
      config: {
        mode: Mode;
        providerId?: string;
        modelId?: string;
        thinkingLevel?: SessionThinkingLevel;
        permissionMode?: "inherit" | "ask" | "accept-edits" | "auto";
      },
    ) => {
      rejectNativeMutation(id, "configuration");
      if (!host) throw new Error("host unavailable");
      // An OMP session's model/thinking binding must stay consistent across the
      // runtime projection and the host DB. The bridge applies the change to the
      // runtime (re-projects for model, applies for thinking) and persists it
      // through its own callbacks; a failed persist is reverted rather than left
      // forked. The Pi path below is the plain host write.
      const engine = engineRouter ? await engineRouter.requireForSession(id, "modelSwitch") : "pi";
      let result: { session?: RuntimeSession | null };
      if (engine === "omp") {
        // A session that is OMP but has no wired bridge must fail closed: its
        // model/thinking binding spans the runtime projection and the host DB,
        // so a host-only write would fork the two.
        if (!ompSessions) {
          throw Object.assign(new Error("this build has no OMP runtime to configure this session"), {
            errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
          });
        }
        const outcome = await ompSessions.configure(id, {
          mode: config.mode ?? null,
          providerId: config.providerId ?? null,
          modelId: config.modelId ?? null,
          thinkingLevel: config.thinkingLevel ?? null,
          permissionMode: config.permissionMode ?? null,
        });
        if (!outcome.ok) {
          // An inconsistent outcome means the runtime and the host DB have
          // forked (a revert failed); that fact must reach the caller, not be
          // flattened into a generic capability error. It travels in `data`
          // because the IPC wrapper forwards only `error.data` into the
          // renderer-facing `error.details`.
          throw Object.assign(new Error(outcome.reason ?? "the OMP runtime refused the configuration"), {
            errorCode: ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE,
            ...(outcome.inconsistent ? { data: { inconsistent: true } } : {}),
          });
        }
        result = await host.call<{ session?: RuntimeSession | null }>("session.get", {
          id,
          messageLimit: 1,
        });
      } else {
        result = await host.call<{ session?: RuntimeSession | null }>(
          "session.configure",
          { id, ...config },
        );
      }
      if (!result.session) return result;
      const { providers, defaults } = await sessionCapabilityContext();
      const session = enrichSession(result.session, providers, defaults);
      if (
        config.providerId !== undefined ||
        config.modelId !== undefined ||
        config.thinkingLevel !== undefined
      ) {
        const modelKey =
          session.providerId && session.modelId
            ? `${session.providerId}/${session.modelId}`
            : null;
        plugins.broadcastEvent("session:modelChanged", [
          {
            sessionId: id,
            modelKey,
            thinkingLevel: session.thinkingLevel,
          },
        ]);
      }
      return { ...result, session };
    },
  );

  handle(IPC.invoke.sessionImportScan, async () => {
    const { sessions, truncated } = await scanAllSources();
    scannedImportSessions = new Map(
      sessions.map((session) => [`${session.source}:${session.externalId}`, session]),
    );
    return {
      sessions: sessions.map(({ filePath: _filePath, ...candidate }) => candidate),
      ...(Object.keys(truncated).length > 0 ? { truncated } : {}),
    };
  });

  handle(
    IPC.invoke.sessionImportRun,
    async (selections: unknown) => {
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      for (const selection of items) {
        const key = importSelectionKey(selection);
        const item = key ? scannedImportSessions.get(key) : undefined;
        if (!item) {
          failed += 1;
          logger.app("session", "warn", "session import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        try {
          const converted = await convertSession(item);
          const res = await host.call<{ imported?: boolean }>("session.import", {
            session: converted.session,
            messages: converted.messages,
          });
          if (res.imported) imported += 1;
          else skipped += 1;
        } catch (e) {
          failed += 1;
          logger.app("session", "warn", "session import failed", {
            data: { source: item?.source, externalId: item?.externalId, error: String(e) },
          });
        }
      }
      logger.app("session", "info", "session import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

  handle(IPC.invoke.modelConfigImportScan, async () => {
    const drafts = await scanModelConfigs();
    scannedModelConfigs = new Map(
      drafts.map((draft) => [modelConfigImportKey(draft.source, draft.externalId), draft]),
    );
    return { providers: drafts.map(publicModelConfigCandidate) };
  });
  handle(
    IPC.invoke.modelConfigImportRun,
    async (selections: unknown) => {
      if (!host) throw new Error("host unavailable");
      let imported = 0;
      let skipped = 0;
      let failed = 0;
      const items = Array.isArray(selections) ? selections : [];
      const existing = await host.call<{
        providers: Array<{
          id: string;
          baseUrl?: string | null;
          apiStyle?: string | null;
          vendorKey?: string | null;
          hasSecret?: boolean;
        }>;
      }>("providers.list", { includeDisabled: true });
      // Matching an import by endpoint alone collapses distinct credentials.
      // Resolve existing API keys in Electron main so same-endpoint profiles
      // remain independent without exposing secrets to the renderer.
      const known = await Promise.all(
        (existing.providers ?? []).map(async (provider) => {
          let secretValue: string | undefined;
          if (provider.hasSecret) {
            try {
              secretValue = (
                await host!.call<{ value?: string }>("providers.getSecret", {
                  id: provider.id,
                })
              ).value;
            } catch {
              // A provider may only have an OAuth credential, or its secret
              // backend may be temporarily unavailable. In either case,
              // failing closed here avoids collapsing a new profile.
            }
          }
          return { ...provider, secretValue };
        }),
      );
      let firstImported:
        | { id: string; defaultModelId?: string; models?: Array<{ id: string }> }
        | undefined;
      for (const selection of items) {
        const key = modelConfigSelectionKey(selection);
        const draft = key ? scannedModelConfigs.get(key) : undefined;
        if (!draft) {
          failed += 1;
          logger.app("provider", "warn", "model config import selection rejected", {
            data: { reason: "candidate was not returned by the latest scan" },
          });
          continue;
        }
        if (draftMatchesExisting(draft, known)) {
          skipped += 1;
          continue;
        }
        try {
          const created = await host.call<{
            provider: { id: string; defaultModelId?: string; models?: Array<{ id: string }> };
          }>("providers.create", providerCreateInputFromDraft(draft));
          imported += 1;
          known.push({
            ...draft,
            id: created.provider.id,
            secretValue: draft.secretValue,
          });
          firstImported ??= created.provider;
        } catch (e) {
          failed += 1;
          logger.app("provider", "warn", "model config import failed", {
            data: {
              source: draft.source,
              externalId: draft.externalId,
              name: draft.name,
              hasSecret: draft.hasSecret,
              error: String(e),
            },
          });
        }
      }
      if (firstImported) {
        try {
          const settings = await host.call<{ defaultProviderId?: string }>("settings.get");
          if (!settings?.defaultProviderId) {
            await host.call("settings.set", {
              defaultProviderId: firstImported.id,
              defaultModelId:
                firstImported.models?.[0]?.id ?? firstImported.defaultModelId,
            });
          }
        } catch (e) {
          logger.app("provider", "warn", "model config import default not set", {
            data: { error: String(e) },
          });
        }
      }
      logger.app("provider", "info", "model config import finished", {
        data: { imported, skipped, failed },
      });
      return { imported, skipped, failed };
    },
  );

}
