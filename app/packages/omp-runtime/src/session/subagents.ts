/**
 * The subagent registry: live child identity, per-child conversion, and the
 * settlement events that feed the existing Pi delegation renderer.
 *
 * The pinned OMP runtime reports children three ways, and only this module
 * owns how the three join into one picture:
 *
 *   - `subagent_lifecycle` — a child starts or settles (started/completed/
 *     failed/aborted). The payload carries the child's opaque `id`, its agent
 *     name, and the parent `task` tool call that spawned it (`parentToolCallId`).
 *   - `subagent_progress` — a running child's `AgentProgress` snapshot
 *     (current tool, recent output, token/cost counters).
 *   - `subagent_event` — a child's own event stream (`AgentSessionEvent`), the
 *     same vocabulary the parent converter already understands. Its payload is
 *     only `{ id, event }`; the owning parent tool call and agent name come
 *     from the lifecycle/progress record for that `id`.
 *
 * Ownership rules, each fail-closed:
 *
 *   - A child event whose `id` has no lifecycle/progress record is refused: it
 *     cannot be attributed to a parent tool call, so it must not fall through
 *     as a parent event (that is exactly cross-run contamination).
 *   - Only message and tool rows are forwarded for a child. `agent_end`,
 *     `turn_end`, `error` and every other session-level frame stay inside the
 *     child: Electron main ends the durable turn on those, and a delegate
 *     finishing must never end its parent's turn (the same rule Pi's own
 *     `SubagentRun.handleEvent` states).
 *   - The `sessionFile` absolute path is kept on the record for the bridge's
 *     `get_subagent_messages` but never leaves this package in a list result:
 *     `list()` returns the opaque `id` and metadata only.
 *
 * Lifecycle/progress feed the *existing* Pi renderer structures. The parent's
 * `task` tool row is the delegation node: its `toolResult.details` is augmented
 * with `delegationId`/`agent`/`status`/`startedAt`/`completedAt` so
 * `subagent-topology.ts` reads it exactly as it reads a Pi `Task` result. A
 * terminal lifecycle emits the same `message_end` (role `tool`) settlement the
 * Pi runtime uses to refresh that row.
 */
import type { AgentEvent, AgentEventEnvelope } from "@pi-desktop/shared";

import { OmpEventConverter } from "./events.js";
import type {
  SubagentAgentSource,
  SubagentEventPayload,
  SubagentLifecyclePayload,
  SubagentProgressPayload,
  SubagentSnapshot,
} from "./subagent-frames.js";

/** The subset of Pi's `SubagentOutcome` the pinned OMP runtime can produce. */
export type OmpSubagentOutcome = "running" | "completed" | "failed" | "aborted";

export type SubagentListEntry = {
  /** Opaque child id (the OMP subagent id); never a native path. */
  id: string;
  agent: string;
  agentSource: SubagentAgentSource;
  status: OmpSubagentOutcome;
  parentToolCallId?: string;
  task?: string;
  assignment?: string;
  description?: string;
  startedAt?: number;
  completedAt?: number;
  lastUpdate: number;
};

export type SubagentDiagnostics = {
  /** Frames that claimed a subagent type but failed validation. */
  malformedFrames: number;
  /** Child events whose id had no owning parent record. */
  orphanEvents: number;
  /** Progress frames for children this registry did not know. */
  orphanProgress: number;
  /** Lifecycle frames whose parent tool call was not a tracked `task` call. */
  unknownParentCalls: number;
};

export type SubagentTrackerOptions = {
  sessionId: string;
  now?: () => number;
  /** Bounded registry: oldest settled children are dropped first. */
  maxChildren?: number;
};

type ChildRecord = SubagentListEntry & {
  progress?: SubagentProgressPayload["progress"];
  converter: OmpEventConverter;
};

type TaskCallRecord = {
  toolCallId: string;
  args: unknown;
  startedAt: number;
};

/** A synthesized envelope body: the runner adds `sessionId`/`turnId`/`ts`. */
export type SubagentSynthesis = {
  event: AgentEvent;
  parentToolCallId?: string;
  agentName?: string;
};

const DEFAULT_MAX_CHILDREN = 64;

/** Map a lifecycle status to the Pi outcome vocabulary. */
function lifecycleOutcome(status: SubagentLifecyclePayload["status"]): OmpSubagentOutcome {
  return status === "started" ? "running" : status;
}

/** Map an `AgentProgress` status to the Pi outcome vocabulary. */
function progressOutcome(status: SubagentProgressPayload["progress"]["status"]): OmpSubagentOutcome {
  return status === "pending" ? "running" : status;
}

/** Child frame kinds the desktop forwards as transcript rows. */
const CHILD_EVENT_TYPES: Record<string, true> = {
  message_start: true,
  message_update: true,
  message_end: true,
  tool_start: true,
  tool_update: true,
  tool_end: true,
};

/**
 * True when a converted child event is a transcript row rather than a
 * session-level frame. Session-level frames (`agent_start`/`agent_end`/
 * `turn_start`/`turn_end`/`error`/`status`) stay inside the child.
 */
function isChildRow(event: AgentEvent): boolean {
  return CHILD_EVENT_TYPES[event.type] === true;
}

export class SubagentTracker {
  private readonly sessionId: string;
  private readonly now: () => number;
  private readonly maxChildren: number;
  private readonly children = new Map<string, ChildRecord>();
  private readonly taskCalls = new Map<string, TaskCallRecord>();
  private readonly diagnosticCounts: SubagentDiagnostics = {
    malformedFrames: 0,
    orphanEvents: 0,
    orphanProgress: 0,
    unknownParentCalls: 0,
  };

  constructor(options: SubagentTrackerOptions) {
    this.sessionId = options.sessionId;
    this.now = options.now ?? Date.now;
    this.maxChildren = options.maxChildren ?? DEFAULT_MAX_CHILDREN;
  }

  /** Observe a `tool_execution_start` for the parent `task` tool. */
  observeTaskStart(toolCallId: string, args: unknown): void {
    this.taskCalls.set(toolCallId, { toolCallId, args, startedAt: this.now() });
    if (this.taskCalls.size > 256) {
      const oldest = this.taskCalls.keys().next().value;
      if (oldest !== undefined) this.taskCalls.delete(oldest);
    }
  }

  /**
   * Handle a validated `subagent_lifecycle` payload.
   *
   * Returns zero or more settlement syntheses. A `started` frame registers the
   * child; a terminal frame records the terminal outcome and emits the
   * `message_end` settlement that refreshes the parent `task` row.
   */
  handleLifecycle(payload: SubagentLifecyclePayload): SubagentSynthesis[] {
    const existing = this.children.get(payload.id);
    if (!existing && payload.status !== "started") {
      // A terminal lifecycle for a child we never saw start is a late frame:
      // it carries a real outcome but no row to attach it to. Track the outcome
      // for `list()`/reconciliation but emit nothing (the parent row is gone).
      this.rememberTerminal(payload);
      return [];
    }
    const record = existing ?? this.createChild(payload.id, payload.agent, payload.agentSource, payload.parentToolCallId);
    record.agent = payload.agent;
    record.agentSource = payload.agentSource;
    if (payload.parentToolCallId) record.parentToolCallId = payload.parentToolCallId;
    if (payload.description !== undefined) record.description = payload.description;
    record.status = lifecycleOutcome(payload.status);
    record.lastUpdate = this.now();
    if (payload.status === "started") {
      record.startedAt ??= this.now();
      return [];
    }
    record.completedAt ??= this.now();
    return [this.settlement(record)];
  }

  /**
   * Handle a validated `subagent_progress` payload (update only, no event).
   */
  handleProgress(payload: SubagentProgressPayload): void {
    const progress = payload.progress;
    const existing = this.children.get(progress.id);
    if (!existing) {
      this.diagnosticCounts.orphanProgress += 1;
      return;
    }
    existing.agent = payload.agent;
    existing.agentSource = payload.agentSource;
    if (payload.parentToolCallId) existing.parentToolCallId = payload.parentToolCallId;
    if (payload.task !== undefined) existing.task = payload.task;
    if (payload.assignment !== undefined) existing.assignment = payload.assignment;
    existing.status = progressOutcome(progress.status);
    existing.progress = progress;
    existing.lastUpdate = this.now();
  }

  /**
   * Handle a validated `subagent_event` payload: convert the child's event
   * stream through its own converter and return the forwarded rows.
   */
  handleEvent(payload: SubagentEventPayload): SubagentSynthesis[] {
    const record = this.children.get(payload.id);
    if (!record) {
      this.diagnosticCounts.orphanEvents += 1;
      return [];
    }
    const events = record.converter.convert(payload.event);
    const rows: SubagentSynthesis[] = [];
    for (const event of events) {
      if (!isChildRow(event)) continue;
      rows.push({
        event,
        parentToolCallId: record.parentToolCallId,
        agentName: record.agent,
      });
    }
    return rows;
  }

  /**
   * Augment the parent `task` tool result's `details` with the delegation
   * fields Pi's topology reads. Runs on `tool_execution_end` for the `task`
   * tool, after the child registry has the live snapshot.
   */
  augmentTaskResult(toolCallId: string, result: unknown): unknown {
    if (typeof result !== "object" || result === null) return result;
    const envelope = result as { content?: unknown; details?: unknown };
    const details = envelope.details;
    if (typeof details !== "object" || details === null || Array.isArray(details)) {
      return result;
    }
    // The live registry is authoritative; the result's own progress/results
    // are the fallback when a frame raced ahead of the lifecycle.
    const live = this.childrenForParent(toolCallId);
    let stamped: Array<{ id: string; agent: string; status: OmpSubagentOutcome }>;
    if (live.length > 0) {
      stamped = live;
    } else {
      const record = details as Record<string, unknown>;
      const progress = Array.isArray(record.progress) ? record.progress : [];
      const results = Array.isArray(record.results) ? record.results : [];
      const fromProgress = progress.map((entry) => this.fromProgressEntry(entry)).filter((entry) => entry !== null);
      const fromResults = results.map((entry) => this.fromResultEntry(entry)).filter((entry) => entry !== null);
      stamped = [...fromProgress, ...fromResults];
    }
    if (stamped.length === 0) return result;
    const record = { ...(details as Record<string, unknown>) };
    this.stampDelegations(record, stamped);
    return { ...envelope, details: record };
  }

  /** Reconcile the live registry against a `get_subagents` snapshot. */
  reconcile(snapshots: SubagentSnapshot[]): SubagentSynthesis[] {
    const syntheses: SubagentSynthesis[] = [];
    for (const snapshot of snapshots) {
      const existing = this.children.get(snapshot.id);
      const record =
        existing ??
        this.createChild(snapshot.id, snapshot.agent, snapshot.agentSource, snapshot.parentToolCallId);
      record.agent = snapshot.agent;
      record.agentSource = snapshot.agentSource;
      if (snapshot.parentToolCallId) record.parentToolCallId = snapshot.parentToolCallId;
      if (snapshot.task !== undefined) record.task = snapshot.task;
      if (snapshot.assignment !== undefined) record.assignment = snapshot.assignment;
      if (snapshot.description !== undefined) record.description = snapshot.description;
      record.status = progressOutcome(snapshot.status);
      if (snapshot.progress) record.progress = snapshot.progress;
      record.lastUpdate = Math.max(record.lastUpdate, snapshot.lastUpdate);
      // A snapshot repairing a missed `started` frame must still surface the
      // child on its parent row.
      if (!existing) syntheses.push(this.settlement(record));
    }
    return syntheses;
  }

  /** Active children for a parent `task` tool call, in registry order. */
  childrenForParent(toolCallId: string): ChildRecord[] {
    return [...this.children.values()].filter((child) => child.parentToolCallId === toolCallId);
  }

  /** Opaque list for the bridge: identity and metadata, never a native path. */
  list(): SubagentListEntry[] {
    return [...this.children.values()].map(({ id, agent, agentSource, status, parentToolCallId, task, assignment, description, startedAt, completedAt, lastUpdate }) => ({
      id,
      agent,
      agentSource,
      status,
      ...(parentToolCallId ? { parentToolCallId } : {}),
      ...(task !== undefined ? { task } : {}),
      ...(assignment !== undefined ? { assignment } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(completedAt !== undefined ? { completedAt } : {}),
      lastUpdate,
    }));
  }

  /** The owning parent tool call and agent for a child id, if tracked. */
  lookup(id: string): { parentToolCallId?: string; agent: string } | undefined {
    const record = this.children.get(id);
    if (!record) return undefined;
    return { parentToolCallId: record.parentToolCallId, agent: record.agent };
  }

  /** Whether any tracked child is still `running`. */
  hasRunningChildren(): boolean {
    return [...this.children.values()].some((child) => child.status === "running");
  }

  /** Drop every child and task-call record (dispose/restart boundary). */
  reset(): void {
    this.children.clear();
    this.taskCalls.clear();
  }

  diagnostics(): SubagentDiagnostics {
    return { ...this.diagnosticCounts };
  }

  // -------------------------------------------------------------------------

  private createChild(
    id: string,
    agent: string,
    agentSource: SubagentAgentSource,
    parentToolCallId?: string,
  ): ChildRecord {
    const record: ChildRecord = {
      id,
      agent,
      agentSource,
      status: "running",
      ...(parentToolCallId ? { parentToolCallId } : {}),
      lastUpdate: this.now(),
      converter: new OmpEventConverter({
        sessionId: `${this.sessionId}:subagent:${id}`,
        now: this.now,
        ...(parentToolCallId ? { parentToolCallId } : {}),
        agentName: agent,
      }),
    };
    this.children.set(id, record);
    this.prune();
    return record;
  }

  /** Track a terminal outcome for a child this registry never saw start. */
  private rememberTerminal(payload: SubagentLifecyclePayload): void {
    const record = this.createChild(payload.id, payload.agent, payload.agentSource, payload.parentToolCallId);
    record.status = lifecycleOutcome(payload.status);
    record.completedAt ??= this.now();
    record.lastUpdate = this.now();
  }

  private settlement(record: ChildRecord): SubagentSynthesis {
    const summary: Record<string, unknown> = {
      delegationId: record.id,
      agent: record.agent,
      status: record.status,
      ...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
    };
    const text = `Delegation ${record.id}: ${record.status}.`;
    const result = {
      content: [{ type: "text", text }],
      details: summary,
    };
    const taskCall = record.parentToolCallId ? this.taskCalls.get(record.parentToolCallId) : undefined;
    const message = {
      id: record.parentToolCallId ?? record.id,
      role: "tool" as const,
      content: JSON.stringify(result),
      ...(record.parentToolCallId ? { toolCallId: record.parentToolCallId } : {}),
      toolName: "task",
      ...(taskCall ? { toolArgs: taskCall.args } : {}),
      toolStatus: "success" as const,
      toolResult: result,
      ...(record.completedAt !== undefined
        ? { toolCompletedAt: new Date(record.completedAt).toISOString() }
        : {}),
      createdAt: new Date(record.startedAt ?? record.lastUpdate).toISOString(),
      status: "complete" as const,
      isError: false,
    };
    return {
      event: { type: "message_end", message },
      ...(record.parentToolCallId ? { parentToolCallId: record.parentToolCallId } : {}),
      agentName: record.agent,
    };
  }

  private stampDelegations(record: Record<string, unknown>, children: Array<{ id: string; agent: string; status: OmpSubagentOutcome; startedAt?: number; completedAt?: number }>): void {
    const primary = children[0];
    record.delegationId = primary.id;
    record.agent = primary.agent;
    record.status = primary.status;
    if (primary.startedAt !== undefined) record.startedAt = primary.startedAt;
    if (primary.completedAt !== undefined) record.completedAt = primary.completedAt;
    record.delegations = children.map((child) => ({
      delegationId: child.id,
      agent: child.agent,
      status: child.status,
      ...(child.startedAt !== undefined ? { startedAt: child.startedAt } : {}),
      ...(child.completedAt !== undefined ? { completedAt: child.completedAt } : {}),
    }));
  }

  private fromProgressEntry(entry: unknown): { id: string; agent: string; status: OmpSubagentOutcome } | null {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as { id?: unknown; agent?: unknown; status?: unknown };
    if (typeof record.id !== "string" || !record.id) return null;
    if (typeof record.agent !== "string" || !record.agent) return null;
    if (typeof record.status !== "string") return null;
    const status = progressOutcome(record.status as SubagentProgressPayload["progress"]["status"]);
    return { id: record.id, agent: record.agent, status };
  }

  private fromResultEntry(entry: unknown): { id: string; agent: string; status: OmpSubagentOutcome } | null {
    if (typeof entry !== "object" || entry === null) return null;
    const record = entry as { id?: unknown; agent?: unknown; exitCode?: unknown };
    if (typeof record.id !== "string" || !record.id) return null;
    if (typeof record.agent !== "string" || !record.agent) return null;
    // `SingleResult` has no status field; a settled result that reached the
    // result list is treated as completed (exitCode 0) or failed otherwise.
    const status: OmpSubagentOutcome =
      typeof record.exitCode === "number" && record.exitCode === 0 ? "completed" : "failed";
    return { id: record.id, agent: record.agent, status };
  }

  private prune(): void {
    while (this.children.size > this.maxChildren) {
      const settled = [...this.children.entries()].find(([, child]) => child.status !== "running");
      const victim = settled ?? [...this.children.entries()][0];
      if (!victim) break;
      this.children.delete(victim[0]);
    }
  }
}

/** Re-export for callers that only need the outcome type. */
export type { AgentEventEnvelope };
