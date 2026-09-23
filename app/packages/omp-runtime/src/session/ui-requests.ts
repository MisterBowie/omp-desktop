/**
 * The desktop's side of the runtime's dialog channel.
 *
 * The pinned runtime routes every interactive request — extension questions,
 * our gate's approval prompt, the runtime's own tool approval — through
 * `extension_ui_request` frames, and waits for one `extension_ui_response` per
 * request id. Two things make this dangerous if it is treated casually:
 *
 *   - The requester is *blocked inside the runtime's process*. A request that
 *     is never answered strands the tool call; a request answered twice, or
 *     answered after the run it belonged to was stopped, can authorise work in
 *     a run the user already cancelled.
 *   - The decision authorises a side effect. Every path that cannot produce a
 *     definite, current, single answer must therefore fail closed — a cancel,
 *     not a silent allow.
 *
 * This module owns those rules in one place:
 *
 *   - **Classification is structural.** `classifyUiRequest` uses the frame's
 *     own `method` discriminator plus our descriptor (see
 *     `extensions/approval-protocol.ts`); it never inspects user-facing text.
 *   - **One decision per request.** `resolve` removes the entry as it answers,
 *     so a duplicate or late decision is refused instead of re-authorising.
 *   - **Identity is bound.** Every pending request records the session and the
 *     run generation that raised it. A decision for a different session, or for
 *     a generation that has since been superseded or stopped, is refused.
 *   - **Stopping cancels, it does not drop.** `cancelPending` answers every open
 *     request with `cancelled: true` (the runtime's own fail-closed value) and
 *     forgets it, so nothing is left waiting on a UI that will not come back.
 *   - **Every refusal is recorded.** `records()` is the diagnostic trail the
 *     validation report cites: answered, refused-unknown, refused-late.
 */
import type { Risk } from "@pi-desktop/shared";

import {
  OMP_APPROVAL_ALLOW_LABEL,
  OMP_APPROVAL_DENY_LABEL,
  isNativeApprovalOptions,
  parseApprovalDescriptor,
  type OmpApprovalDescriptor,
} from "./approval-protocol.js";

/** Frames this module writes back to the runtime. */
export type OmpUiResponseFrame = Record<string, unknown> & { type: "extension_ui_response" };

/** A classified request, as the desktop surfaces it. */
export type OmpUiRequest =
  | {
      kind: "approval";
      frameId: string;
      /**
       * `gate` — our shipped extension, carrying a descriptor.
       * `runtime` — the runtime's own approval prompt (`["Approve","Deny"]`).
       */
      source: "gate" | "runtime";
      descriptor: OmpApprovalDescriptor | null;
      title: string;
      options: string[];
    }
  | {
      kind: "question";
      frameId: string;
      method: "select" | "confirm" | "input" | "editor";
      title: string;
      message?: string;
      options?: string[];
      optionDetails?: Array<{ description?: string }>;
      timeoutMs?: number;
    }
  | { kind: "cancel"; frameId: string; targetId: string }
  | { kind: "notice"; frameId: string; method: string }
  | { kind: "unsupported"; frameId: string; method: string };

/** A decision, as the desktop's UI produces it. */
export type OmpUiDecision = "allow-once" | "allow-session" | "deny";

/** Terminal outcome for one request, kept for diagnostics. */
export type OmpUiRecord = {
  frameId: string;
  kind: OmpUiRequest["kind"];
  generation: number;
  outcome: "answered" | "refused-unknown" | "refused-stale" | "refused-duplicate" | "cancelled";
  decision?: OmpUiDecision | "cancel";
  detail?: string;
  at: number;
};

export type OmpUiRequestsOptions = {
  sessionId: string;
  /** Writes one response frame; returning false means the runtime is gone. */
  write: (frame: OmpUiResponseFrame) => boolean;
  now?: () => number;
  /** Bounded diagnostic trail. */
  maxRecords?: number;
};

type Pending = {
  request: OmpUiRequest;
  generation: number;
  sessionId: string;
  raisedAt: number;
  answered: boolean;
};

export class OmpUiRequests {
  private readonly sessionId: string;
  private readonly write: (frame: OmpUiResponseFrame) => boolean;
  private readonly now: () => number;
  private readonly maxRecords: number;
  private readonly pending = new Map<string, Pending>();
  private readonly trail: OmpUiRecord[] = [];
  private generation = 0;

  constructor(options: OmpUiRequestsOptions) {
    this.sessionId = options.sessionId;
    this.write = options.write;
    this.now = options.now ?? Date.now;
    this.maxRecords = options.maxRecords ?? 200;
  }

  /** The run generation decisions are currently accepted for. */
  currentGeneration(): number {
    return this.generation;
  }

  /** Start a run: every later request belongs to this generation. */
  beginRun(): number {
    this.generation += 1;
    return this.generation;
  }

  /**
   * Classify an incoming frame and, when it expects an answer, track it.
   *
   * Returns null for frames that are not extension UI requests at all.
   */
  observe(frame: unknown): OmpUiRequest | null {
    const request = classifyUiRequest(frame);
    if (!request) return null;
    if (request.kind === "cancel") {
      // The runtime retracting its own request: the entry is dropped without an
      // answer (the requester already stopped waiting for one), but the
      // retraction is remembered so the desktop can withdraw the card.
      this.pending.delete(request.targetId);
      this.record({
        frameId: request.targetId,
        kind: "cancel",
        generation: this.generation,
        outcome: "cancelled",
        decision: "cancel",
        detail: "the runtime retracted its request",
      });
      return request;
    }
    if (request.kind === "notice") return request;
    if (request.kind === "unsupported") {
      // An unknown interactive method would otherwise hang the runtime: answer
      // it with the fail-closed value and keep the evidence.
      this.write({ type: "extension_ui_response", id: request.frameId, cancelled: true });
      this.record({
        frameId: request.frameId,
        kind: "unsupported",
        generation: this.generation,
        outcome: "cancelled",
        detail: `unsupported ui method: ${request.method}`,
      });
      return request;
    }
    this.pending.set(request.frameId, {
      request,
      generation: this.generation,
      sessionId: this.sessionId,
      raisedAt: this.now(),
      answered: false,
    });
    return request;
  }

  /** Requests still waiting for an answer, oldest first. */
  open(): Array<{ requestId: string; request: OmpUiRequest; generation: number }> {
    return [...this.pending.values()].map((entry) => ({
      requestId: entry.request.frameId,
      request: entry.request,
      generation: entry.generation,
    }));
  }

  /**
   * Answer one request.
   *
   * Refusals never write a frame: an unknown id, a superseded generation or a
   * second decision for the same request must not reach the runtime, because
   * the only thing a late write can do is authorise something nobody is
   * waiting for.
   */
  resolve(
    requestId: string,
    decision: OmpUiDecision,
    options: { generation?: number; value?: string } = {},
  ):
    | { ok: true; frame: OmpUiResponseFrame }
    | { ok: false; reason: "unknown" | "stale" | "duplicate"; detail: string } {
    const entry = this.pending.get(requestId);
    if (!entry) {
      const previous = this.trail.find((record) => record.frameId === requestId);
      const reason = previous ? "duplicate" : "unknown";
      this.record({
        frameId: requestId,
        kind: previous?.kind ?? "unsupported",
        generation: this.generation,
        outcome: reason === "duplicate" ? "refused-duplicate" : "refused-unknown",
        decision,
        detail: previous
          ? "this request was already answered"
          : "no request with this id is waiting",
      });
      return {
        ok: false,
        reason,
        detail: previous ? "request already answered" : "unknown request id",
      };
    }
    if (entry.generation !== this.generation) {
      // The dialog was raised by a run that has since ended, failed or been
      // replaced. Its decision can no longer be delivered: the runtime waiting
      // on it belongs to a run the desktop has already closed.
      this.record({
        frameId: requestId,
        kind: entry.request.kind,
        generation: entry.generation,
        outcome: "refused-stale",
        decision,
        detail: `the dialog belongs to generation ${entry.generation}, the active run is ${this.generation}`,
      });
      return { ok: false, reason: "stale", detail: "the dialog belongs to an earlier run" };
    }
    if (options.generation !== undefined && options.generation !== entry.generation) {
      this.record({
        frameId: requestId,
        kind: entry.request.kind,
        generation: entry.generation,
        outcome: "refused-stale",
        decision,
        detail: `decision came from generation ${options.generation}`,
      });
      return { ok: false, reason: "stale", detail: "decision belongs to a superseded run" };
    }
    if (entry.answered) {
      this.record({
        frameId: requestId,
        kind: entry.request.kind,
        generation: entry.generation,
        outcome: "refused-duplicate",
        decision,
        detail: "the request was already answered",
      });
      return { ok: false, reason: "duplicate", detail: "request already answered" };
    }
    // Consume before writing: one decision authorises at most one execution,
    // and a failed write must not leave a request that can be answered again.
    entry.answered = true;
    this.pending.delete(requestId);
    const frame = responseFor(
      entry.request,
      decision,
      options.value === undefined ? {} : { value: options.value },
    );
    if (!this.write(frame)) {
      this.record({
        frameId: requestId,
        kind: entry.request.kind,
        generation: entry.generation,
        outcome: "refused-stale",
        decision,
        detail: "the runtime transport is gone; the decision was not delivered",
      });
      return { ok: false, reason: "stale", detail: "the runtime is no longer reachable" };
    }
    this.record({
      frameId: requestId,
      kind: entry.request.kind,
      generation: entry.generation,
      outcome: "answered",
      decision,
    });
    return { ok: true, frame };
  }

  /**
   * Fail closed: answer every open request with `cancelled`.
   *
   * Called when a run stops, the window closes or the runtime exits. The
   * runtime treats a cancel as "no decision", which denies the tool call.
   */
  cancelPending(reason: string, options: { timedOut?: boolean } = {}): string[] {
    const cancelled: string[] = [];
    for (const frameId of [...this.pending.keys()]) {
      if (this.cancel(frameId, reason, options)) cancelled.push(frameId);
    }
    return cancelled;
  }

  /**
   * Fail closed for one dialog: answer it `cancelled` and forget it.
   *
   * This is the only correct answer when nobody will decide: the requester is
   * blocked inside the runtime, and a `cancelled` response is what its own
   * response parser turns into "no answer" — the gate denies, the question
   * returns no value. Dropping the request without answering would strand that
   * call forever.
   */
  cancel(
    requestId: string,
    reason: string,
    options: { timedOut?: boolean } = {},
  ): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    entry.answered = true;
    this.write({
      type: "extension_ui_response",
      id: requestId,
      cancelled: true,
      ...(options.timedOut ? { timedOut: true } : {}),
    });
    this.record({
      frameId: requestId,
      kind: entry.request.kind,
      generation: entry.generation,
      outcome: "cancelled",
      decision: "cancel",
      detail: reason,
    });
    return true;
  }

  records(): readonly OmpUiRecord[] {
    return this.trail;
  }

  private record(entry: Omit<OmpUiRecord, "at">): void {
    this.trail.push({ ...entry, at: this.now() });
    if (this.trail.length > this.maxRecords) this.trail.shift();
  }
}

/** The response frame one decision becomes, by request kind. */
export function responseFor(
  request: OmpUiRequest,
  decision: OmpUiDecision,
  options: { value?: string } = {},
): OmpUiResponseFrame {
  if (request.kind === "approval") {
    if (request.source === "runtime") {
      return {
        type: "extension_ui_response",
        id: request.frameId,
        value: decision === "deny" ? "Deny" : "Approve",
      };
    }
    return {
      type: "extension_ui_response",
      id: request.frameId,
      // A session-scoped allow is the same value on the wire: the gate keeps
      // the scope, because only the runtime's process can remember it.
      value: decision === "deny" ? OMP_APPROVAL_DENY_LABEL : OMP_APPROVAL_ALLOW_LABEL,
    };
  }
  if (request.kind === "question") {
    if (request.method === "confirm") {
      return {
        type: "extension_ui_response",
        id: request.frameId,
        confirmed: decision !== "deny",
      };
    }
    if (request.method === "select") {
      // A question has real options, so the answer is the label the user chose;
      // the default (the first option) is what a bare "allow" means.
      return {
        type: "extension_ui_response",
        id: request.frameId,
        value: decision === "deny" ? "" : (options.value ?? request.options?.[0] ?? ""),
      };
    }
    return { type: "extension_ui_response", id: request.frameId, cancelled: true };
  }
  return { type: "extension_ui_response", id: request.frameId, cancelled: true };
}

/**
 * Classify one frame by its own discriminator.
 *
 * Approval detection is structural: our descriptor (any dialog form) or the
 * runtime's exact native option tuple. Titles and other user-facing text are
 * carried through for display only.
 */
export function classifyUiRequest(frame: unknown): OmpUiRequest | null {
  if (!isRecord(frame) || frame.type !== "extension_ui_request") return null;
  const frameId = typeof frame.id === "string" ? frame.id : null;
  if (!frameId) return null;
  const method = typeof frame.method === "string" ? frame.method : null;
  if (!method) return null;

  switch (method) {
    case "cancel": {
      const targetId = typeof frame.targetId === "string" ? frame.targetId : "";
      return { kind: "cancel", frameId, targetId };
    }
    case "select": {
      const options = Array.isArray(frame.options)
        ? frame.options.filter((option): option is string => typeof option === "string")
        : [];
      const optionDetails = selectOptionDetails(frame.optionDetails);
      const descriptor = parseApprovalDescriptor(optionDetails[0]?.description);
      if (descriptor || isNativeApprovalOptions(options)) {
        return {
          kind: "approval",
          frameId,
          source: descriptor ? "gate" : "runtime",
          descriptor,
          title: typeof frame.title === "string" ? frame.title : "",
          options,
        };
      }
      return {
        kind: "question",
        frameId,
        method: "select",
        title: typeof frame.title === "string" ? frame.title : "",
        options,
        ...(optionDetails.length > 0 ? { optionDetails } : {}),
        ...(typeof frame.timeout === "number" ? { timeoutMs: frame.timeout } : {}),
      };
    }
    case "confirm": {
      // A gate that asks with `confirm` carries the descriptor in `message`.
      const descriptor = parseApprovalDescriptor(frame.message);
      if (descriptor) {
        return {
          kind: "approval",
          frameId,
          source: "gate",
          descriptor,
          title: typeof frame.title === "string" ? frame.title : "",
          options: [OMP_APPROVAL_ALLOW_LABEL, OMP_APPROVAL_DENY_LABEL],
        };
      }
      return {
        kind: "question",
        frameId,
        method: "confirm",
        title: typeof frame.title === "string" ? frame.title : "",
        ...(typeof frame.message === "string" ? { message: frame.message } : {}),
        ...(typeof frame.timeout === "number" ? { timeoutMs: frame.timeout } : {}),
      };
    }
    case "input":
    case "editor":
      return {
        kind: "question",
        frameId,
        method,
        title: typeof frame.title === "string" ? frame.title : "",
        ...(typeof frame.timeout === "number" ? { timeoutMs: frame.timeout } : {}),
      };
    case "notify":
    case "setStatus":
    case "setWidget":
    case "setTitle":
    case "set_editor_text":
    case "open_url":
      // Fire and forget: the runtime holds no pending request for these, so a
      // response would be an unknown id on its side.
      return { kind: "notice", frameId, method };
    default:
      return { kind: "unsupported", frameId, method };
  }
}

/** The permission risk one descriptor carries, in the desktop's own union. */
export function descriptorRisk(descriptor: OmpApprovalDescriptor | null): Risk {
  if (!descriptor) return "high";
  return descriptor.risk;
}

function selectOptionDetails(value: unknown): Array<{ description?: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .map((entry) =>
      typeof entry.description === "string" ? { description: entry.description } : {},
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
