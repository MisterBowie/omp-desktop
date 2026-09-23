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
import { writeFileSync } from "node:fs";

import type { AgentEventEnvelope } from "@pi-desktop/shared";
import type { HostProcess } from "../host-process";
import type { Logger } from "../logger";
import type { DesktopEngineRuntime } from "./engine-runtime";
import {
  ensureSessionStateDir,
  type OmpRunPaths,
} from "@pi-desktop/omp-runtime";
import {
  createOmpSessionBridge,
  type OmpSessionBridge,
  type OmpSessionRuntimeSpec,
} from "./omp-session";
import {
  ompApiForStyle,
  projectionError,
  projectModelsYaml,
  type OmpModelProjection,
} from "./omp-model-projection";

/** A provider row with just the fields the projection needs. */
type ProjectionProvider = {
  id: string;
  baseUrl?: string | null;
  apiStyle?: string | null;
  type?: string;
  models?: Array<{ id: string; contextWindow?: number; maxTokens?: number }>;
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
 * Read one provider and its model binding, project them, and write the minimal
 * `models.yml` into the runtime's transient agent directory.
 *
 * The provider id and model id come from the session's durable binding, never
 * from the renderer; the secret is read at this boundary and written only into
 * `paths.agentDir/models.yml`, which the stop path deletes.
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
    throw Object.assign(new Error(`provider ${spec.providerId} does not exist or is disabled`), {
      errorCode: "OMP_PROJECTION_FAILED",
    });
  }
  const api = ompApiForStyle(row.apiStyle);
  const baseUrl = typeof row.baseUrl === "string" ? row.baseUrl.trim() : "";
  const secret = await client.call<{ value?: string | null }>("providers.getSecret", {
    id: spec.providerId,
  });
  const model = row.models?.find((entry) => entry.id === spec.modelId);
  const projection: OmpModelProjection = {
    providerId: row.id,
    modelId: spec.modelId,
    api: api ?? "",
    baseUrl,
    apiKey: secret?.value ?? null,
    ...(model?.contextWindow ? { contextWindow: model.contextWindow } : {}),
    ...(model?.maxTokens ? { maxTokens: model.maxTokens } : {}),
  };
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
        adapterVersion: 1,
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
      await client.call("session.bindEngine", {
        id: sessionId,
        adapterVersion: 1,
        runtimeVersion: info.runtimeVersion,
        nativeSessionId: info.nativeSessionId,
        nativeSessionPath: info.nativeSessionPath,
      });
      return sessionId;
    },
  });

  return { bridge, sessionDir };
}
