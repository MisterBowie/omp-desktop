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
import { MAX_SESSION_RECORD_BYTES, ompMemoryDirectory } from "@pi-desktop/omp-runtime";
import { parseOmpMemorySettings, type OmpMemorySettings } from "@pi-desktop/shared";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { readGlobalInstructions, writeOmpGlobalInstructions } from "./omp-global-instructions";

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
  type OmpCapabilityProvider,
  type OmpHostToolProvider,
  type OmpHostTurnLifecycle,
  type OmpSessionBridge,
  type OmpSessionRuntimeSpec,
  type OmpTurnEndInfo,
} from "./omp-session";
import {
  projectionError,
  projectModelsYaml,
  resolveProviderProjection,
  type ProviderProjectionSource,
  type OmpModelProjection,
} from "./omp-model-projection";
import { loadOmpUserSubagents, ompSubagentModels, writeOmpUserSubagents, type OmpUserSubagentSnapshot } from "./omp-user-subagents";
import { ensureAttachmentBlob } from "../prompt-attachments";

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
  models?: ProviderProjectionSource["models"];
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
  /** The desktop's host-tool seam (M5/T19-B), assembled from the plugin/MCP registries. */
  hostTools?: OmpHostToolProvider;
  /** The desktop's capability snapshot loader (M5/T19-C): skills + memory. */
  capabilities?: OmpCapabilityProvider;
  /** The desktop's `session:turnEnded` broadcast (plugin lifecycle, M5/T19-B). */
  onTurnEnd?: (info: OmpTurnEndInfo) => void;
  onIdle?: (sessionId: string) => void;
  onMemoryMaintenanceIdle?: () => void;
};

function hostOrThrow(host: () => HostProcess | null): HostProcess {
  const value = host();
  if (!value) throw Object.assign(new Error("host unavailable"), { errorCode: "HOST_UNAVAILABLE" });
  return value;
}

/**
 * The durable host turn lifecycle the OMP bridge consumes (M5/T20-B2):
 * `session.beginTurn` opens the row and returns its id, `session.endTurn`
 * settles exactly that row. `recoverInflight` stays false — OMP's native JSONL
 * is the only transcript source (M2), so there is no Pi in-flight assistant row
 * to promote — and no task notification is created (the OMP path had none
 * before this phase). Exported so the E2E can wire the production
 * implementation instead of re-deriving the RPC calls.
 */
export function createOmpHostTurnLifecycle(host: () => HostProcess | null): OmpHostTurnLifecycle {
  return {
    begin: async (input: { sessionId: string; providerId: string | null; modelId: string | null }) => {
      const client = hostOrThrow(host);
      const turn = await client.call<{ turnId?: unknown }>("session.beginTurn", {
        sessionId: input.sessionId,
        ...(input.providerId ? { providerId: input.providerId } : {}),
        ...(input.modelId ? { modelId: input.modelId } : {}),
      });
      const turnId = typeof turn?.turnId === "string" ? turn.turnId.trim() : "";
      if (!turnId) throw new Error("session.beginTurn returned no turn id");
      return turnId;
    },
    end: async (input: { turnId: string; status: "completed" | "aborted" | "error" }) => {
      const client = hostOrThrow(host);
      await client.call("session.endTurn", {
        turnId: input.turnId,
        status: input.status,
        recoverInflight: false,
        createNotification: false,
      });
    },
  };
}

/**
 * Resolve the host session row's `permission_mode` to the effective mode the
 * gate may consume, with PI host-core's exact semantics
 * (`session_collaboration/permissions.rs` `effective_mode`): a concrete mode
 * passes through; `inherit` resolves to the app's current
 * `defaultPermissionMode` when that is a legal non-inherit value, and to `ask`
 * otherwise. Never `null`-coerced to a friendlier value: an unreadable value
 * stays `null` and the bridge refuses the prompt.
 */
export function resolveEffectivePermissionMode(
  permissionMode: string | null,
  defaultPermissionMode: string | null,
): string | null {
  if (permissionMode !== "inherit") return permissionMode;
  if (
    defaultPermissionMode === "ask" ||
    defaultPermissionMode === "accept-edits" ||
    defaultPermissionMode === "auto"
  ) {
    return defaultPermissionMode;
  }
  return "ask";
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
  additionalModels: readonly OmpModelProjection[] = [],
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
  // in the transient models.yml. A key-auth provider whose stored secret reads
  // back empty (a race, corruption, or a stale `hasSecret`) is refused here:
  // an empty key must never be downgraded to `auth: none`.
  let apiKey: string | null = null;
  if (resolved.needsKey) {
    const secret = await client.call<{ value?: string | null }>("providers.getSecret", {
      id: spec.providerId,
    });
    const value = typeof secret?.value === "string" ? secret.value.trim() : "";
    if (!value) {
      throw Object.assign(new Error(`provider ${spec.providerId} requires an API key but its stored secret is empty`), {
        errorCode: "OMP_PROJECTION_INVALID",
      });
    }
    apiKey = value;
  }
  const projection = { ...resolved.projection, apiKey };
  const error = projectionError(projection);
  if (error) {
    throw Object.assign(new Error(error.message), { errorCode: error.errorCode });
  }
  writeFileSync(join(paths.agentDir, "models.yml"), projectModelsYaml(projection, additionalModels), { encoding: "utf8", mode: 0o600 });
}

/**
 * Inline image bytes one OMP input may carry. The runtime stores the whole user
 * message as one native record, base64 inflates it by a third, and the history
 * reader refuses a record above `MAX_SESSION_RECORD_BYTES`; half that ceiling
 * keeps the record readable. Images past the budget go as file references.
 */
export const OMP_INLINE_IMAGE_BUDGET_BYTES = Math.floor(MAX_SESSION_RECORD_BYTES / 2);

/** Whether the session's model is projected to OMP with image input. */
export async function ompModelAcceptsImages(
  client: Pick<HostProcess, "call">,
  providerId: string | null | undefined,
  modelId: string | null | undefined,
): Promise<boolean> {
  if (!providerId || !modelId) return false;
  const provider = await client.call<{ provider?: ProjectionProvider | null }>("providers.get", { id: providerId });
  if (!provider?.provider) return false;
  const resolved = resolveProviderProjection(provider.provider, modelId, null);
  return resolved.ok && resolved.projection.input?.includes("image") === true;
}

export type WiredOmpSessions = {
  bridge: OmpSessionBridge;
  /** Persistent native-session directory (survives stop/reclaim). */
  sessionDir: string;
};

/** Project identity stays with capabilities; only the host resolves execution paths. */
export function createOmpExecutionRootResolver(host: () => HostProcess | null) {
  return async (sessionId: string): Promise<string> => {
    const result = await hostOrThrow(host).call<{path?: string}>("session.executionRoot", {sessionId});
    if (!result.path) throw Object.assign(new Error("session execution root unavailable"), {errorCode: "WORKTREE_MISSING"});
    return result.path;
  };
}

/**
 * Build the OMP session registry wired to the host and the runtime adapter.
 */
export function wireOmpSessions(deps: OmpSessionWiringDeps): WiredOmpSessions {
  const { engineRuntime, dataRoot } = deps;
  const sessionDir = ensureSessionStateDir(dataRoot);
  // Launch-owned inputs: a change replaces an idle runtime before the next prompt.
  type LaunchInputs = { subagents: OmpUserSubagentSnapshot; instructions: string | null; fingerprint: string };
  const configurations = new WeakMap<object, { pending: LaunchInputs | null; fingerprint: string | null }>();
  const loadLaunchInputs = async (spec: OmpSessionRuntimeSpec): Promise<LaunchInputs> => {
    const catalog = deps.hostTools ? await deps.hostTools.catalog(spec.projectDirectory) : [];
    const subagents = await loadOmpUserSubagents(hostOrThrow(deps.host), spec, catalog.map(tool => tool.definition.name));
    for (const diagnostic of subagents.diagnostics) deps.logger?.app("runtime", "warn", "subagent unavailable", { data: diagnostic });
    const instructions = await readGlobalInstructions(dataRoot);
    const fingerprint = createHash("sha256").update(JSON.stringify([subagents.fingerprint, instructions])).digest("hex");
    return { subagents, instructions, fingerprint };
  };

  const bridge = createOmpSessionBridge({
    launcher: engineRuntime.ompRuntime.launcher,
    launcherError: engineRuntime.ompRuntime.launcherError,
    isPackaged: deps.isPackaged,
    resourcesPath: deps.resourcesPath ?? null,
    appPath: deps.appPath,
    sessionDir,
    // Restored and live user rows name the image bytes the runtime kept.
    storeImage: (bytes) => ensureAttachmentBlob(dataRoot, bytes),
    onMemoryMaintenanceIdle: deps.onMemoryMaintenanceIdle,
    resolveExecutionRoot: createOmpExecutionRootResolver(deps.host),
    // The session's mode and effective permission mode, read from the host
    // session row on every prompt (M5/T20-B1). `inherit` is resolved here,
    // desktop-side, with the app's *current* default — never a startup
    // environment value — and the bridge validates the enums strictly.
    // A missing row, a failed read or a read-only value the bridge cannot
    // classify refuses the prompt rather than running it as Agent.
    sessionPolicy: {
      policy: async (sessionId: string) => {
        const client = hostOrThrow(deps.host);
        const { session } = await client.call<{
          session?: { mode?: unknown; permissionMode?: unknown } | null;
        }>("session.get", { id: sessionId });
        if (!session) return null;
        const mode = typeof session.mode === "string" ? session.mode : null;
        const permissionMode = typeof session.permissionMode === "string" ? session.permissionMode : null;
        let defaultPermissionMode: string | null = null;
        if (permissionMode === "inherit") {
          const settings = await client.call<{ defaultPermissionMode?: unknown }>("settings.get");
          defaultPermissionMode =
            typeof settings?.defaultPermissionMode === "string" ? settings.defaultPermissionMode : null;
        }
        return { mode, permissionMode: resolveEffectivePermissionMode(permissionMode, defaultPermissionMode) };
      },
    },
    refreshRuntimeConfiguration: async (supervisor, spec) => {
      const state = configurations.get(supervisor);
      if (!state) throw new Error("OMP runtime configuration is unavailable");
      const inputs = await loadLaunchInputs(spec);
      state.pending = inputs;
      return state.fingerprint !== null && state.fingerprint !== inputs.fingerprint;
    },
    createSupervisor: (spec: OmpSessionRuntimeSpec) => {
      const state: { pending: LaunchInputs | null; fingerprint: string | null } = { pending: null, fingerprint: null };
      const supervisor = engineRuntime.ompRuntime.createSupervisor({
        sessionDir,
        memory: async () => {
          const settings = await hostOrThrow(deps.host).call<OmpMemorySettings>("memory.settings.get");
          return { ...parseOmpMemorySettings(settings), dbPath: join(ompMemoryDirectory(dataRoot, spec.executionDirectory ?? spec.projectDirectory), "memory.db"), modelSelector: spec.providerId && spec.modelId ? `${spec.providerId}/${spec.modelId}` : undefined };
        },
        // This bridge always wires a session policy and writes a valid state
        // before every prompt, so the runtime carries the mandatory channel:
        // the gate refuses a turn whose state cannot be read back as
        // owned-and-valid instead of running it unclamped. The switch is
        // launch-scoped — a deleted state file can never disable it.
        desktopStateRequired: true,
        // The pinned runtime only forwards a child's `subagent_event` frames
        // when its model is selected explicitly (`--model provider/model`);
        // discovery from `models.yml` alone leaves the child's event stream
        // unwired. The projection already pins one provider/model, so pass the
        // same binding the projection writes.
        ...(spec.providerId && spec.modelId
          ? { modelSelector: `${spec.providerId}/${spec.modelId}` }
          : {}),
        prepareRun: async (paths) => {
          const inputs = state.pending ?? await loadLaunchInputs(spec);
          await projectSessionModels(deps.host, spec, paths, await ompSubagentModels(hostOrThrow(deps.host), inputs.subagents));
          // OMP task discovery uses HOME/PI_CONFIG_DIR/agent, independently
          // of PI_CODING_AGENT_DIR (which owns models.yml and session state).
          await writeOmpUserSubagents(join(paths.configRoot, "agent"), inputs.subagents);
          // The desktop's global instructions become the run's user-level AGENTS.md.
          await writeOmpGlobalInstructions(paths.home, inputs.instructions);
          state.fingerprint = inputs.fingerprint;
          state.pending = null;
        },
      });
      configurations.set(supervisor, state);
      return supervisor;
    },
    emitAgentEvent: deps.emitAgentEvent,
    gateResolver: () => engineRuntime.gateExtension,
    // The durable host turn lifecycle (M5/T20-B2): the bridge opens one host
    // turn per accepted OMP prompt and settles exactly that turn when the
    // runner closes its generation.
    hostTurns: createOmpHostTurnLifecycle(deps.host),
    ...(deps.hostTools ? { hostTools: deps.hostTools } : {}),
    ...(deps.capabilities ? { capabilities: deps.capabilities } : {}),
    ...(deps.onTurnEnd ? { onTurnEnd: deps.onTurnEnd } : {}),
    ...(deps.onIdle ? { onIdle: deps.onIdle } : {}),
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
    persistConfig: async (info) => {
      const client = hostOrThrow(deps.host);
      // One host `session.configure` call carries every field, so mode and
      // permissionMode are never dropped and the write is atomic on the host.
      await client.call("session.configure", {
        id: info.sessionId,
        ...(info.mode !== null && info.mode !== undefined ? { mode: info.mode } : {}),
        ...(info.providerId !== null && info.providerId !== undefined ? { providerId: info.providerId } : {}),
        ...(info.modelId !== null && info.modelId !== undefined ? { modelId: info.modelId } : {}),
        ...(info.thinkingLevel !== null && info.thinkingLevel !== undefined ? { thinkingLevel: info.thinkingLevel } : {}),
        ...(info.permissionMode !== null && info.permissionMode !== undefined ? { permissionMode: info.permissionMode } : {}),
      });
    },
  });

  return { bridge, sessionDir };
}
