/**
 * The desktop's engine wiring: one place that answers "what can this engine do
 * right now", for both engines, plus the OMP runtime this process owns.
 *
 * It exists as its own module for two reasons. `main/index.ts` is a boot
 * sequence, not a home for runtime policy (the architecture check enforces
 * that), and the mapping from process liveness to engine status is exactly the
 * kind of thing that needs a test — the gate lets a prompt through when it
 * should not if this says "idle" for a runtime that is not up.
 *
 * The OMP runtime is constructed here but started only on request: this release
 * ships the boundary, not a conversation surface, so nothing is spawned at boot.
 */
import {
  APP_VERSION,
  OMP_RUNTIME_VERSION,
  PROTOCOL_VERSION,
  PI_ENGINE_CAPABILITIES,
  closedEngineCapabilities,
  type EngineId,
  type EngineRuntimeStatus,
} from "@pi-desktop/shared";
import { ErrorCodes } from "@pi-desktop/shared";
import type { EngineRouter, EngineSessionLookup } from "./engine-router";
import { createEngineRouter } from "./engine-router";
import { createOmpRuntimeAdapter, type OmpRuntimeAdapter } from "./omp-runtime";

export type EngineRuntimeDependencies = {
  /** Product data root; the OMP supervisor owns everything below it. */
  dataRoot: string;
  isPackaged: boolean;
  /** Electron's app path, used to find a development runtime. */
  appPath: string;
  resourcesPath?: string | null;
  env?: NodeJS.ProcessEnv;
  /** Version the built-in runtime must report, or null to accept any. */
  expectedRuntimeVersion?: string | null;
  /** Whether the Pi runtime's two processes are up. */
  piRuntimeLive: () => boolean;
  /**
   * Persisted engine of a session. Production supplies the host-backed lookup;
   * without one the router refuses id-only gates instead of assuming Pi.
   */
  sessionEngine?: EngineSessionLookup;
  /** Test seam. */
  ompAdapterFactory?: typeof createOmpRuntimeAdapter;
  routerFactory?: typeof createEngineRouter;
};

export type DesktopEngineRuntime = {
  ompRuntime: OmpRuntimeAdapter;
  engineRouter: EngineRouter;
  /** Status of one engine as of *now*; the router reads the same function. */
  status: (engine: EngineId) => EngineRuntimeStatus;
};

/** The Electron surface this module reads; structural so tests need no Electron. */
export type ElectronAppSurface = {
  isPackaged: boolean;
  getAppPath(): string;
};

/**
 * Boot-time construction for this process.
 *
 * The Electron surface arrives as an argument rather than an import, so this
 * module — and the status mapping it owns — stays loadable in a plain Node
 * test. `main/index.ts` keeps no runtime policy of its own.
 */
export function createDesktopEngineRuntimeForApp(dependencies: {
  dataRoot: string;
  app: ElectronAppSurface;
  piRuntimeLive: () => boolean;
  /** The host process; the session record is the only authority on an engine. */
  getHost: () => HostLookup | null;
  resourcesPath?: string | null;
  env?: NodeJS.ProcessEnv;
}): DesktopEngineRuntime {
  return createDesktopEngineRuntime({
    dataRoot: dependencies.dataRoot,
    isPackaged: dependencies.app.isPackaged,
    appPath: dependencies.app.getAppPath(),
    resourcesPath: dependencies.resourcesPath ?? process.resourcesPath,
    env: dependencies.env ?? process.env,
    expectedRuntimeVersion: OMP_RUNTIME_VERSION,
    piRuntimeLive: dependencies.piRuntimeLive,
    sessionEngine: createHostSessionLookup(dependencies.getHost),
  });
}

/** The host surface this lookup needs; structural so tests need no HostProcess. */
export type HostLookup = {
  call<T>(method: string, params?: unknown): Promise<T>;
};

/**
 * Read a session's engine from host-core — the only durable record of it.
 *
 * `messageLimit: 1` keeps the read to a bounded transcript window; the engine
 * field comes from the summary. A missing session answers `null`, which the
 * router treats as "not a record I can route" rather than as a legacy session.
 */
export function createHostSessionLookup(
  getHost: () => HostLookup | null,
): EngineSessionLookup {
  return async (sessionId: string) => {
    const host = getHost();
    if (!host) {
      throw Object.assign(new Error("host unavailable while reading a session engine"), {
        errorCode: ErrorCodes.HOST_UNAVAILABLE,
      });
    }
    const result = await host.call<{ session?: { engine?: unknown } | null }>("session.get", {
      id: sessionId,
      messageLimit: 1,
    });
    const session = result?.session;
    if (!session) {
      throw Object.assign(new Error(`session not found: ${sessionId}`), {
        errorCode: ErrorCodes.NOT_FOUND,
      });
    }
    return session.engine ?? null;
  };
}

/**
 * Reclaim the runtime this process owns, reporting what could not be reclaimed.
 *
 * A rejected reclaim is a lifecycle failure too, and it must reach the log: a
 * shutdown that swallows it leaves a process nobody will look for again. The
 * caller supplies its own logger so this stays testable without Electron.
 */
export async function reclaimOwnedRuntime(
  runtime: Pick<OmpRuntimeAdapter, "reclaim">,
  log: (message: string, fields: { code: string; event?: string; data: string }) => void,
): Promise<void> {
  let results: Awaited<ReturnType<OmpRuntimeAdapter["reclaim"]>>;
  try {
    results = await runtime.reclaim();
  } catch (error) {
    log("OMP runtime reclaim failed", {
      code: "OMP_RUNTIME_RECLAIM_FAILED",
      data: String((error as Error)?.message ?? error),
    });
    return;
  }
  for (const result of results) {
    if (result.stopped) continue;
    log("OMP runtime cleanup incomplete", {
      code: "OMP_RUNTIME_CLEANUP_FAILED",
      event: result.steps.join("; "),
      data: result.errors.join("; "),
    });
  }
}

export function createDesktopEngineRuntime(
  dependencies: EngineRuntimeDependencies,
): DesktopEngineRuntime {
  const ompRuntime = (dependencies.ompAdapterFactory ?? createOmpRuntimeAdapter)({
    dataRoot: dependencies.dataRoot,
    isPackaged: dependencies.isPackaged,
    appPath: dependencies.appPath,
    resourcesPath: dependencies.resourcesPath,
    env: dependencies.env ?? process.env,
    expectedRuntimeVersion: dependencies.expectedRuntimeVersion,
  });

  /**
   * Pi's runtime is the agent sidecar over host-core: both have to be up before
   * a Pi session can do anything, so their presence *is* its phase. OMP's comes
   * from its supervisor, which knows whether it started, failed, or is running.
   */
  const status = (engine: EngineId): EngineRuntimeStatus => {
    if (engine === "omp") return ompRuntime.status();
    const live = dependencies.piRuntimeLive();
    return {
      engine: "pi",
      phase: live ? "idle" : "stopped",
      runtimeVersion: APP_VERSION,
      protocolVersion: PROTOCOL_VERSION,
      reason: live ? null : "not-started",
      detail: live ? undefined : "the Pi runtime is not running",
      capabilities: live ? PI_ENGINE_CAPABILITIES : closedEngineCapabilities(),
    };
  };

  const engineRouter = (dependencies.routerFactory ?? createEngineRouter)({
    status,
    ...(dependencies.sessionEngine ? { sessionEngine: dependencies.sessionEngine } : {}),
  });

  return { ompRuntime, engineRouter, status };
}
