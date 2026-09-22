/**
 * The desktop's single decision point for "which engine serves this session,
 * and may it do this?".
 *
 * It exists to make one class of bug impossible: a session that belongs to one
 * engine being served by another engine's code path. A refusal here is final —
 * there is no fallback branch, because falling back would run a session on a
 * runtime that does not own its transcript, its permissions or its working
 * directory.
 *
 * The module is deliberately pure: it takes a status provider and reads the
 * engine out of a session record the caller already has. That keeps it
 * importable (and testable) without Electron, and keeps the gate out of the
 * places that merely *use* it.
 */
import {
  ErrorCodes,
  closedEngineCapabilities,
  engineCapabilities,
  engineCapabilityRefusal,
  liveEngineCapabilities,
  normalizeEngineId,
  type EngineCapability,
  type EngineCapabilities,
  type EngineId,
  type EngineRuntimeStatus,
} from "@pi-desktop/shared";

/** Live status of one engine, as the process that owns it reports it. */
export type EngineStatusProvider = (engine: EngineId) => EngineRuntimeStatus;

export type EngineSessionRecord = { engine?: unknown } | null | undefined;

export type EngineRefusal = Error & {
  errorCode: typeof ErrorCodes.ENGINE_CAPABILITY_UNAVAILABLE;
  engine: EngineId;
  capability: EngineCapability;
};

export type EngineRouter = {
  /**
   * The engine a session record belongs to. Absent means Pi: records that
   * predate the engine field were created by the Pi engine, and treating
   * absence as "the newest engine" would move a user's existing sessions onto
   * a runtime that has never seen them.
   */
  engineOf(session: EngineSessionRecord): EngineId;
  /** Declared capabilities of an engine, independent of whether it is running. */
  capabilities(engine: EngineId): EngineCapabilities;
  /** Capabilities a caller may act on right now. */
  liveCapabilities(engine: EngineId): EngineCapabilities;
  status(engine: EngineId): EngineRuntimeStatus;
  /** Non-throwing check, for UI affordances. */
  supports(session: EngineSessionRecord, capability: EngineCapability): boolean;
  /**
   * Engine of a session the caller has only an id for.
   *
   * An unknown session reads as Pi, which is what every session created before
   * the engine field is; the call that follows reports `NOT_FOUND` on its own.
   */
  engineForSession(sessionId: string): Promise<EngineId>;
  /** `require` for a caller that has an id rather than a record. */
  requireForSession(sessionId: string, capability: EngineCapability): Promise<EngineId>;
  /**
   * Throwing check, for every path that is about to *do* something.
   *
   * Returns the engine that was checked, so the caller can assert it is the
   * engine it is about to call into.
   */
  require(session: EngineSessionRecord, capability: EngineCapability): EngineId;
};

export function createEngineRouter(options: {
  status: EngineStatusProvider;
  /** Persisted engine of a session, when the caller has only its id. */
  sessionEngine?: (sessionId: string) => Promise<unknown>;
}): EngineRouter {
  const engineOf = (session: EngineSessionRecord): EngineId =>
    normalizeEngineId(session?.engine);

  const statusOf = (engine: EngineId): EngineRuntimeStatus => {
    const normalized = normalizeEngineId(engine);
    try {
      return options.status(normalized);
    } catch {
      // A status provider that cannot answer means the engine is not usable;
      // reporting it as stopped is the conservative reading.
      return {
        engine: normalized,
        phase: "failed",
        runtimeVersion: null,
        protocolVersion: null,
        reason: "not-started",
        capabilities: closedEngineCapabilities(),
      };
    }
  };

  const liveCapabilities = (engine: EngineId): EngineCapabilities =>
    liveEngineCapabilities(normalizeEngineId(engine), statusOf(engine).phase);

  const router: EngineRouter = {
    engineOf,
    capabilities: (engine) => engineCapabilities(normalizeEngineId(engine)),
    liveCapabilities,
    status: statusOf,
    supports: (session, capability) => liveCapabilities(engineOf(session))[capability],
    async engineForSession(sessionId) {
      if (!options.sessionEngine) return normalizeEngineId(undefined);
      try {
        return normalizeEngineId(await options.sessionEngine(sessionId));
      } catch {
        // A lookup that cannot answer keeps the session on the path it has
        // always used; the operation itself will report the real failure.
        return normalizeEngineId(undefined);
      }
    },
    async requireForSession(sessionId, capability) {
      const engine = await this.engineForSession(sessionId);
      return router.require({ engine }, capability);
    },
    require(session, capability) {
      const engine = engineOf(session);
      const capabilities = liveCapabilities(engine);
      if (capabilities[capability]) return engine;
      const refusal = engineCapabilityRefusal(engine, capability);
      const detail = statusOf(engine).detail;
      const error = Object.assign(new Error(detail ? `${refusal.message} (${detail})` : refusal.message), {
        errorCode: refusal.errorCode,
        engine: refusal.engine,
        capability: refusal.capability,
      }) as EngineRefusal;
      throw error;
    },
  };
  return router;
}
