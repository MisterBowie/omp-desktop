/**
 * Wiring between the OMP session registry and the desktop's host/services.
 *
 * The registry owns runtime lifecycle and dialogs; this module owns the two
 * product integrations it must not know about:
 *
 *   1. **Model projection** — the session's provider/model binding and its
 *      credential are read here (the host secret store is the only authority),
 *      projected into the minimal `models.yml` the runtime understands, and
 *      written into the transient agent directory inside `prepareRun`. The key
 *      never crosses back out: it is not returned to the renderer, not logged,
 *      and not written anywhere persistent.
 *   2. **Durable session coordination** — a native session's validated handles
 *      are persisted through `session.bindEngine`; renames, model switches and
 *      branches go through the host so a restart restores the same identity.
 */
import { join } from "node:path";
import { lstatSync, unlinkSync, writeFileSync } from "node:fs";

import { ENGINE_ADAPTER_VERSION, type AgentEventEnvelope } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { DesktopEngineRuntime } from "./engine-runtime";
import {
  ensureSessionStateDir,
  type OmpRunPaths,
} from "@pi-desktop/omp-runtime";
import {
  createOmpSessionBridge,
  isPathWithin,
  type OmpSessionBridge,
  type OmpSessionRuntimeSpec,
} from "./omp-session";
import {
  projectionError,
  projectModelsYaml,
  resolveProviderProjection,
} from "./omp-model-projection";

/** A provider row with the fields the projection resolver needs. */
type ProjectionProvider = {
  id: string;
  enabled?: boolean | null;
  type?: string | null;
  baseUrl?: string | null;
  apiStyle?: string | null;
  authKind?: string | null;
  hasSecret?: boolean | null;
  hasOauth?: boolean | null;
  headers?: Record<string, string> | null;
  models?: Array<{ id: string; contextWindow?: number | null; maxTokens?: number | null; thinkingLevels?: string[] }>;
  defaultModelId?: string | null;
};

/** Host surface for model projection and durable session coordination. */
export type OmpSessionWiringDeps = {
  host: () => HostProcess | null;
  engineRuntime: DesktopEngineRuntime;
  logger?: Logger;
  dataRoot: string;
  isPackaged: boolean;
  appPath: string;
  resourcesPath?: string | null;
  emitAgentEvent: (envelope: AgentEventEnvelope) => void;
};

function hostOrThrow(host: () => HostProcess | null): HostProcess {
  const value = host();
  if (!value) throw Object.assign(new Error("host unavailable"), { errorCode: "HOST_UNAVAILABLE" });
  return value;
}

/**
 * Read one provider and its model binding, project them fail-closed, and write
 * the minimal `models.yml` into the runtime's transient agent directory.
 *
 * The provider id and model id come from the session's durable binding, never
 * from the renderer; the secret is read at this boundary and written only into
 * `paths.agentDir/models.yml`, which the stop path deletes. A disabled provider,
 * an unknown model, a missing key, an unsupported auth kind, or an incompatible
 * thinking level is refused here, before any prompt is sent.
 */
export async function projectSessionModels(
  host: () => HostProcess | null,
  spec: OmpSessionRuntimeSpec,
  paths: OmpRunPaths,
): Promise<void> {
  const client = hostOrThrow(host);
  if (!spec.providerId || !spec.modelId) {
    // A session with no binding has nothing to project; the runtime will report
    // "no model available", which is the fail-closed answer rather than a
    // guessed provider.
    return;
  }
  const provider = await client.call<{ provider?: ProjectionProvider | null }>("providers.get", {
    id: spec.providerId,
  });
  const row = provider?.provider;
  if (!row) {
    throw Object.assign(new Error(`provider ${spec.providerId} does not exist`), {
      errorCode: "OMP_PROJECTION_FAILED",
    });
  }
  const resolved = resolveProviderProjection(row, spec.modelId, spec.thinkingLevel);
  if (!resolved.ok) {
    throw Object.assign(new Error(resolved.error.message), { errorCode: resolved.error.errorCode });
  }
  // The credential is read only after the source is validated, and only lands
  // in the transient models.yml.
  const secret = await client.call<{ value?: string | null }>("providers.getSecret", {
    id: spec.providerId,
  });
  const projection = { ...resolved.projection, apiKey: secret?.value ?? null };
  const error = projectionError(projection);
  if (error) {
    throw Object.assign(new Error(error.message), { errorCode: error.errorCode });
  }
  writeFileSync(join(paths.agentDir, "models.yml"), projectModelsYaml(projection), "utf8");
}

export type WiredOmpSessions = {
  bridge: OmpSessionBridge;
  /** Persistent native-session directory (survives stop/reclaim). */
  sessionDir: string;
};

/**
 * Build the OMP session registry wired to the host and the runtime adapter.
 */
export function wireOmpSessions(deps: OmpSessionWiringDeps): WiredOmpSessions {
  const { engineRuntime, dataRoot } = deps;
  const sessionDir = ensureSessionStateDir(dataRoot);

  const bridge = createOmpSessionBridge({
    launcher: engineRuntime.ompRuntime.launcher,
    isPackaged: deps.isPackaged,
    resourcesPath: deps.resourcesPath ?? null,
    appPath: deps.appPath,
    sessionDir,
    createSupervisor: (spec: OmpSessionRuntimeSpec) =>
      engineRuntime.ompRuntime.createSupervisor({
        sessionDir,
        prepareRun: async (paths) => {
          await projectSessionModels(deps.host, spec, paths);
        },
      }),
    emitAgentEvent: deps.emitAgentEvent,
    gateResolver: () => engineRuntime.gateExtension,
    persistNativeSession: async (info) => {
      const client = hostOrThrow(deps.host);
      await client.call("session.bindEngine", {
        id: info.sessionId,
        adapterVersion: ENGINE_ADAPTER_VERSION,
        runtimeVersion: info.runtimeVersion,
        nativeSessionId: info.nativeSessionId,
        nativeSessionPath: info.nativeSessionPath,
      });
    },
    persistRename: async (info) => {
      const client = hostOrThrow(deps.host);
      await client.call("session.rename", { id: info.sessionId, title: info.title });
    },
    persistModelBinding: async (info) => {
      const client = hostOrThrow(deps.host);
      await client.call("session.configure", {
        id: info.sessionId,
        mode: "agent",
        providerId: info.providerId,
        modelId: info.modelId,
      });
    },
    persistThinkingLevel: async (info) => {
      const client = hostOrThrow(deps.host);
      await client.call("session.configure", {
        id: info.sessionId,
        mode: "agent",
        thinkingLevel: info.level,
      });
    },
    createBranchSession: async (info) => {
      const client = hostOrThrow(deps.host);
      const parent = await client.call<{ session?: { projectPath?: string | null; providerId?: string | null; modelId?: string | null } | null }>(
        "session.get",
        { id: info.parentSessionId, messageLimit: 1 },
      );
      const created = await client.call<{ session?: { id: string } | null }>("session.create", {
        engine: "omp",
        title: "Branched session",
        mode: "agent",
        projectPath: parent?.session?.projectPath ?? null,
        providerId: parent?.session?.providerId ?? null,
        modelId: parent?.session?.modelId ?? null,
      });
      const sessionId = created?.session?.id;
      if (!sessionId) throw Object.assign(new Error("branch session creation failed"), { errorCode: "OMP_BRANCH_FAILED" });
      try {
        await client.call("session.bindEngine", {
          id: sessionId,
          adapterVersion: ENGINE_ADAPTER_VERSION,
          runtimeVersion: info.runtimeVersion,
          nativeSessionId: info.nativeSessionId,
          nativeSessionPath: info.nativeSessionPath,
        });
      } catch (error) {
        // Compensation: the child row exists but has no engine reference; delete
        // it so a half-created child is never visible. The native file is
        // removed by the caller's `persistBranchCleanup`.
        await client.call("session.delete", { id: sessionId }).catch(() => undefined);
        throw error;
      }
      return sessionId;
    },
    persistBranchCleanup: async (info) => {
      // The native file this branch created lives in the app-owned session
      // directory and is unreferenced; removing it restores the pre-branch state
      // after a failed bind. Containment and file type are re-checked first.
      try {
        if (isPathWithin(info.nativeSessionPath, sessionDir) && lstatSync(info.nativeSessionPath).isFile()) {
          unlinkSync(info.nativeSessionPath);
        }
      } catch {
        // Best effort: a file we cannot remove is left for manual recovery.
      }
    },
  });

  return { bridge, sessionDir };
}
