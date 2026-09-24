/**
 * The desktop's side of the pinned runtime's host-tool bridge (M5/T19-B).
 *
 * The pinned OMP 18.2.7 runtime exposes three frames for host-owned tools
 * (`modes/rpc/rpc-types.ts`):
 *
 *   - `host_tool_call`  — the agent wants one registered host tool executed.
 *   - `host_tool_cancel` — a pending call was aborted on the runtime side;
 *     correlation is by `targetId`, the original call's frame id.
 *   - `host_tool_result` — the desktop's answer: `{ id, result, isError? }`.
 *
 * This module owns the protocol half of that contract — pending calls,
 * at-most-once execution, cancellation correlation and teardown — while the
 * desktop owns the tools themselves: what they are called and what running one
 * means is injected as an executor, so the runtime package never learns about
 * plugins or MCP servers.
 *
 * The rules that keep one desktop tool call from turning into two executions
 * or a leaked side effect:
 *
 *   - every call id is handled at most once: a duplicate frame, a settled id
 *     seen again, an unknown `targetId`, a late result and a late cancel are
 *     all counted and dropped;
 *   - the at-most-once record is scoped to the owning generation and is
 *     unbounded within it: every id the generation saw is remembered until the
 *     generation explicitly ends (`closeGeneration`), so no LRU cap can evict
 *     an id the transport later replays. After the generation ends the record
 *     is reclaimed — a frame that arrives then has no owning run and is failed
 *     closed instead of executed;
 *   - cancellation settles the entry before the abort signal fires, so a
 *     completion that races the cancel can never write a result afterwards.
 *     The abort signal reaches plugin executions (which honour it); an MCP
 *     call has no client-side abort (`McpServerClient.callTool` takes no
 *     signal), so for MCP the guarantee is exactly: the pending entry is
 *     cancelled locally and a late completion is dropped — the remote server's
 *     side effect is never claimed to be retracted;
 *   - a call that arrives with no active run (or no wired executor) is answered
 *     `isError` rather than executed: the runtime is waiting on an answer, and
 *     dropping the frame would hang the turn until the bridge disconnects;
 *   - `cancelAll` is the teardown hook: stop, dispose, run close and transport
 *     failure all abort every pending execution, and a completion that arrives
 *     after its entry was settled is dropped rather than fed back.
 */
import type { OmpFrame } from "../protocol.js";

/** One desktop-owned tool the runtime may offer to the model. */
export type OmpHostToolDefinition = {
  /** `plugin_<plugin>_<tool>` or `mcp_<server>_<tool>` (the PI Desktop names). */
  name: string;
  description: string;
  /** JSON Schema object; passed through verbatim, never stringified or rebuilt. */
  parameters: Record<string, unknown>;
  /**
   * How the pinned runtime presents the tool. `"essential"` keeps it in the
   * top-level schema; `"discoverable"` would demote it to xd:///BM25 discovery
   * and hide it from most model requests.
   */
  loadMode?: "essential" | "discoverable";
};

/** The runtime's `host_tool_call` frame, narrowed to the fields this module reads. */
export type OmpHostToolCall = {
  /** The frame id every result/cancel is correlated to. */
  id: string;
  /** The agent's own tool call id (transcript identity, not correlation). */
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
};

/** The identity of the run that owns a call, supplied by the runner. */
export type OmpHostToolRun = {
  generation: number;
  turnId: string;
  sessionId: string;
};

/** One content block the pinned runtime's `host_tool_result` accepts. */
export type OmpHostToolContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** What the desktop returns for one executed call. */
export type OmpHostToolOutcome = {
  /** Blocks the model reads; the frame must fit the 1 MiB line limit. */
  content: OmpHostToolContentBlock[];
  /** True marks a failed execution (surface as a tool error, not a result). */
  isError?: boolean;
};

/** The desktop's execution seam: run one call with the run's identity. */
export type OmpHostToolExecutor = {
  execute(call: OmpHostToolCall, run: OmpHostToolRun, signal: AbortSignal): Promise<OmpHostToolOutcome>;
};

export type OmpHostToolCounters = {
  pending: number;
  executed: number;
  cancelled: number;
  /** A call id handled twice (duplicate delivery after settle or while pending). */
  duplicates: number;
  /** A cancel whose targetId names no pending call. */
  unknownCancels: number;
  /** A call that arrived with no active run and was failed closed. */
  noRun: number;
  /** A call or cancel frame that failed validation. */
  malformed: number;
  /** A completion that arrived after its entry was settled (late side effect). */
  lateCompletions: number;
  /** Ids currently remembered across tracked generations. */
  rememberedIds: number;
  /** Generations whose at-most-once record is still held. */
  trackedGenerations: number;
};

export type OmpHostToolCallsOptions = {
  /**
   * The desktop's execution seam. When absent (no host tools were ever
   * registered), every call is failed closed: the runtime is waiting on an
   * answer, and dropping the frame would hang the turn.
   */
  execute?: OmpHostToolExecutor;
  /** Write one frame back to the runtime (the runner's runtime handle). */
  write: (frame: OmpFrame) => boolean;
};

type PendingEntry = {
  controller: AbortController;
  settled: boolean;
  toolName: string;
  toolCallId: string;
};

/** True when a frame is a valid `host_tool_call`; malformed frames are dropped. */
export function isHostToolCallFrame(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === "host_tool_call" &&
    typeof frame.id === "string" &&
    frame.id.length > 0 &&
    typeof frame.toolCallId === "string" &&
    frame.toolCallId.length > 0 &&
    typeof frame.toolName === "string" &&
    frame.toolName.length > 0 &&
    (frame.arguments === undefined ||
      (typeof frame.arguments === "object" && frame.arguments !== null && !Array.isArray(frame.arguments)))
  );
}

/** True when a frame is a valid `host_tool_cancel`; malformed frames are dropped. */
export function isHostToolCancelFrame(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const frame = value as Record<string, unknown>;
  return (
    frame.type === "host_tool_cancel" &&
    typeof frame.id === "string" &&
    frame.id.length > 0 &&
    typeof frame.targetId === "string" &&
    frame.targetId.length > 0
  );
}

export class OmpHostToolCalls {
  private readonly execute: OmpHostToolExecutor | undefined;
  private readonly write: (frame: OmpFrame) => boolean;
  private readonly pendingCalls = new Map<string, PendingEntry>();
  /**
   * Every id a tracked generation has seen, unbounded within the generation:
   * the at-most-once record must survive an arbitrarily long replay window, so
   * no cap may evict an id and let a duplicate frame execute again. Cleared
   * only when the generation explicitly ends.
   */
  private readonly seenByGeneration = new Map<number, Set<string>>();
  private readonly counters: OmpHostToolCounters = {
    pending: 0,
    executed: 0,
    cancelled: 0,
    duplicates: 0,
    unknownCancels: 0,
    noRun: 0,
    malformed: 0,
    lateCompletions: 0,
    rememberedIds: 0,
    trackedGenerations: 0,
  };

  constructor(options: OmpHostToolCallsOptions) {
    this.execute = options.execute;
    this.write = options.write;
  }

  /** Live counters, for diagnostics and the E2E probes. */
  snapshot(): OmpHostToolCounters {
    this.counters.pending = this.pendingCalls.size;
    this.counters.trackedGenerations = this.seenByGeneration.size;
    let remembered = 0;
    for (const ids of this.seenByGeneration.values()) remembered += ids.size;
    this.counters.rememberedIds = remembered;
    return { ...this.counters };
  }

  /**
   * Serve one `host_tool_call` frame, or fail it closed.
   *
   * `run` is the runner's active run, or null when no run is in flight: a call
   * with no owning run is answered `isError` rather than executed — the runtime
   * is waiting on an answer, and dropping the frame would hang the turn.
   */
  handleCall(frame: unknown, run: OmpHostToolRun | null): void {
    if (!isHostToolCallFrame(frame)) {
      this.counters.malformed += 1;
      return;
    }
    const id = String(frame.id);
    if (this.pendingCalls.has(id) || (run !== null && this.seenByGeneration.get(run.generation)?.has(id))) {
      this.counters.duplicates += 1;
      return;
    }
    if (!run || !this.execute) {
      this.counters.noRun += 1;
      this.write({
        type: "host_tool_result",
        id,
        result: {
          content: [
            {
              type: "text",
              text: run ? "no host tool executor is wired for this session" : "no active run owns this host tool call",
            },
          ],
        },
        isError: true,
      });
      return;
    }
    const seen = this.seenByGeneration.get(run.generation) ?? new Set<string>();
    seen.add(id);
    this.seenByGeneration.set(run.generation, seen);
    const controller = new AbortController();
    const entry: PendingEntry = {
      controller,
      settled: false,
      toolName: String(frame.toolName),
      toolCallId: String(frame.toolCallId),
    };
    this.pendingCalls.set(id, entry);
    const call: OmpHostToolCall = {
      id,
      toolCallId: entry.toolCallId,
      toolName: entry.toolName,
      arguments: (frame.arguments as Record<string, unknown>) ?? {},
    };
    void this.execute.execute(call, run, controller.signal)
      .then((outcome) => this.settle(id, entry, outcome))
      .catch((error: unknown) =>
        this.settle(id, entry, {
          content: [{ type: "text", text: describe(error) }],
          isError: true,
        }),
      );
  }

  /**
   * Correlate a `host_tool_cancel` to its pending call.
   *
   * Only `targetId` is correlation: a cancel for an unknown or already-settled
   * call is counted and dropped, and this frame never reaches the event
   * converter. Settling happens before the abort signal fires, so a completion
   * racing the cancel cannot write a result afterwards.
   */
  handleCancel(frame: unknown): void {
    if (!isHostToolCancelFrame(frame)) {
      this.counters.malformed += 1;
      return;
    }
    const targetId = String(frame.targetId);
    const entry = this.pendingCalls.get(targetId);
    if (!entry) {
      this.counters.unknownCancels += 1;
      return;
    }
    this.settleAndAbort(targetId, entry, "the runtime cancelled the host tool call");
  }

  /**
   * Abort every pending execution without writing anything.
   *
   * The teardown hook for stop, dispose, run close and transport failure: a
   * late completion is dropped (its entry is settled), and the abort signal —
   * carrying `reason` — is the only cancellation a plugin execution honours.
   * An MCP call has no client-side abort; for those the guarantee is the
   * settled entry, which drops the late completion.
   */
  cancelAll(reason: string): number {
    let cancelled = 0;
    for (const [id, entry] of [...this.pendingCalls]) {
      this.settleAndAbort(id, entry, reason);
      cancelled += 1;
    }
    return cancelled;
  }

  /**
   * Release one generation's at-most-once record.
   *
   * Called by the runner when the generation explicitly ends. After this, a
   * frame naming that generation has no owning run and is failed closed; the
   * id memory is reclaimed.
   */
  closeGeneration(generation: number): void {
    this.seenByGeneration.delete(generation);
  }

  /** Forget every generation record (dispose); pending calls must be aborted first. */
  clearGenerations(): void {
    this.seenByGeneration.clear();
  }

  private settleAndAbort(id: string, entry: PendingEntry, reason: string): void {
    entry.settled = true;
    this.pendingCalls.delete(id);
    this.counters.cancelled += 1;
    entry.controller.abort(new Error(reason));
  }

  /** Complete one call exactly once; a settled entry means the result is late. */
  private settle(id: string, entry: PendingEntry, outcome: OmpHostToolOutcome): void {
    if (entry.settled) {
      // The call was cancelled (or the run was torn down) while it executed;
      // its completion is a late arrival and must not reach the runtime.
      this.counters.lateCompletions += 1;
      return;
    }
    entry.settled = true;
    this.pendingCalls.delete(id);
    this.counters.executed += 1;
    this.write({
      type: "host_tool_result",
      id,
      result: { content: outcome.content },
      ...(outcome.isError === true ? { isError: true } : {}),
    });
  }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}
