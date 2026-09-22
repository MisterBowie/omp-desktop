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
 *
 * A caller that has only a session id needs the persisted record, so it hands
 * the router a lookup. That lookup is the one place where a *failure* could be
 * mistaken for "a legacy session": it must not be. Only a successful read of a
 * record without an engine field is Pi; a read that failed, or that returned a
 * value this build does not understand, refuses the operation instead — the
 * alternative is routing a session nobody could identify into a runtime that
 * does not own it.
 *
 * The gate judges the *declaration*: can this engine serve this capability at
 * all? Whether its runtime is up right now is a different question with its own
 * answer on each path (the Pi paths check their sidecar and say so), and folding
 * the two together would turn a temporary outage into a permanent refusal — the
 * turn queue exists precisely to hold work while a runtime restarts. Liveness
 * still shapes `liveCapabilities()` and `EngineRuntimeStatus`, which is what a
 * status surface or an affordance reads.
 */
import {
  ErrorCodes,
  closedEngineCapabilities,
  isEngineId,
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

/**
 * Persisted engine of a session, read from the product's single durable source.
 *
 * `null`/`undefined` means a record that predates the engine field (Pi); an
 * unknown string is a value this build cannot route, and a rejection is a
 * lookup failure. The router tells the two apart, so an unreadable record never
 * degrades into a guess.
 */
export type EngineSessionLookup = (sessionId: string) => Promise<unknown>;

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
   * Reads the persisted record: a record without an engine field is Pi, a value
   * this build does not know or a record it cannot read is `ENGINE_UNAVAILABLE`.
   * There is no "unknown therefore Pi" path.
   */
  engineForSession(sessionId: string): Promise<EngineId>;
  /** `require` for a caller that has an id rather than a record. */
  requireForSession(sessionId: string, capability: EngineCapability): Promise<EngineId>;
  /**
   * Throwing check, for every path that is about to *do* something.
   *
   * Judges the engine's declaration, not its runtime's current phase: a path
   * that needs a running runtime says so itself, after the engine is known (see
   * the module header). Returns the engine that was checked, so the caller can
   * assert it is the engine it is about to call into.
   */
  require(session: EngineSessionRecord, capability: EngineCapability): EngineId;
};

/**
 * The failure a caller sees when the engine of a session cannot be established.
 *
 * It is `ENGINE_UNAVAILABLE` rather than `ENGINE_CAPABILITY_UNAVAILABLE`,
 * because no capability was judged: the operation was refused before any engine
 * was chosen, and retrying after the host answers again is meaningful.
 */
function lookupFailure(sessionId: string, detail: string): Error {
  return Object.assign(
    new Error(`Could not determine the engine of session ${sessionId}: ${detail}`),
    { errorCode: ErrorCodes.ENGINE_UNAVAILABLE, sessionId },
  );
}

export function createEngineRouter(options: {
  status: EngineStatusProvider;
  /**
   * Persisted engine of a session, when the caller has only its id.
   *
   * Required for {@link EngineRouter.requireForSession}: a router that cannot
   * read the record must refuse rather than assume Pi.
   */
  sessionEngine?: EngineSessionLookup;
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
      if (!options.sessionEngine) throw lookupFailure(sessionId, "no session lookup is configured");
      let persisted: unknown;
      try {
        persisted = await options.sessionEngine(sessionId);
      } catch (error) {
        // Not a legacy record: the engine is unknown, and an unknown engine
        // must never be served by the Pi runtime.
        throw lookupFailure(sessionId, `the session record could not be read: ${String((error as Error)?.message ?? error)}`);
      }
      if (persisted === undefined || persisted === null || persisted === "") {
        // A record that predates the engine field was created by Pi.
        return normalizeEngineId(undefined);
      }
      if (!isEngineId(persisted)) {
        throw lookupFailure(sessionId, `the session record names an engine this build does not know: ${String(persisted)}`);
      }
      return persisted;
    },
    async requireForSession(sessionId, capability) {
      const engine = await this.engineForSession(sessionId);
      return router.require({ engine }, capability);
    },
    require(session, capability) {
      const engine = engineOf(session);
      // Declaration, not phase: a stopped runtime must not read as an engine
      // that cannot serve the capability at all.
      const capabilities = engineCapabilities(engine);
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
