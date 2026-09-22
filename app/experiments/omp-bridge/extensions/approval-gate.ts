/**
 * Approval gate for the M1 experiments: blocks a native tool before it produces
 * any side effect, using the OMP extension `tool_call` hook.
 *
 * Two decision paths exist because OMP gives a UI to the top-level rpc-ui
 * session but not to subagent sessions (`hasUI: false`, verified in E11):
 *
 *   1. hasUI === true  — the real path: ask the user through `ctx.ui.select`
 *      and block unless they choose "Allow".
 *   2. hasUI === false — the session cannot prompt. The desktop therefore has
 *      to decide from its own policy. `M1_CHILD_POLICY` models that policy so
 *      the experiments can measure a subagent's approve/deny/defer behaviour
 *      instead of only observing a blanket denial:
 *        allow  → approve (the desktop pre-authorized this call for subagents)
 *        deny   → block
 *        defer  → wait for an out-of-band decision in `M1_CHILD_DECISION`
 *                 (the desktop answering through another channel), else block
 *      When `M1_CHILD_POLICY` is unset the gate falls back to deny, which is
 *      the conservative default.
 *
 * Decisions are appended to `M1_UI_LOG` so experiments can assert what the gate
 * saw, which session it belonged to, and how it answered.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface DialogOptions {
  timeout?: number;
}
interface UIContext {
  select(title: string, options: string[], options?: DialogOptions): Promise<string | undefined>;
}
interface SessionManagerLike {
  getSessionId?(): string | undefined;
  getCwd?(): string | undefined;
}
interface ToolCallCtx {
  hasUI: boolean;
  ui: UIContext;
  cwd?: string;
  sessionManager?: SessionManagerLike;
}
interface ToolCallEvent {
  toolName: string;
  toolCallId?: string;
  input: Record<string, unknown>;
}
interface ExtensionAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ToolCallCtx) => Promise<unknown> | unknown): void;
}

const GATED_TOOLS: Record<string, true> = { write: true, bash: true };

/** Session identity of the context that raised the hook, when exposed. */
function sessionInfo(ctx: ToolCallCtx): Record<string, unknown> {
  try {
    return {
      sessionId: ctx.sessionManager?.getSessionId?.() ?? null,
      cwd: ctx.cwd ?? ctx.sessionManager?.getCwd?.() ?? null,
    };
  } catch {
    return { sessionId: null, cwd: null };
  }
}

function log(entry: Record<string, unknown>): void {
  const path = process.env.M1_UI_LOG;
  if (path) appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

/**
 * Child-approval channel: a request-scoped, single-use decision plus an
 * authoritative cancellation marker.
 *
 * PI-Desktop reference (source facts): `permissions.cancel()` removes the
 * pending request and answers Deny so a waiter racing the cancellation wakes
 * up, and `rpc/mod.rs` re-checks cancellation after the approval wait; a late
 * `permissions.resolve` returns NOT_FOUND. The property that matters here is
 * that an approval which has not executed yet cannot be admitted once its
 * cancellation is known — the *order in which files were written* is not a
 * signal about whether the call may run.
 *
 * OMP provides none of this for a subagent tool call (measured: after a parent
 * `abort` the child keeps running, no cancel frame is emitted, and an `allow`
 * that arrives later executes the call). This channel is therefore the bridge's
 * own implementation of that contract, not an OMP capability.
 *
 * Rules:
 *   - The cancel marker is checked first on every poll. If it is present, the
 *     call is `cancelled`, regardless of any decision already on disk: an older
 *     `allow` cannot outrank a cancellation that is already visible.
 *   - A decision is applied at most once and only to the call it names. An
 *     unscoped `allow`/`deny` is consumed by the first call that reads it (the
 *     file is rewritten as `consumed <toolCallId>`), so one approval can never
 *     authorise two calls.
 *   - `timeout` is its own outcome: no decision, no cancellation.
 */
type ChildOutcome = "allow" | "deny" | "timeout" | "cancelled";

interface ScopedDecision {
  decision: "allow" | "deny";
  toolCallId: string | null;
}

/** Parse a decision line: `allow`, `deny`, `allow <id>` or `{"decision":…,"toolCallId":…}`. */
function parseDecision(text: string): ScopedDecision | "consumed" | null {
  const raw = text.trim();
  if (!raw) return null;
  if (raw.startsWith("consumed")) return "consumed";
  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as { decision?: unknown; toolCallId?: unknown };
      if (parsed.decision === "allow" || parsed.decision === "deny") {
        return { decision: parsed.decision, toolCallId: typeof parsed.toolCallId === "string" ? parsed.toolCallId : null };
      }
    } catch { /* fall through to the plain form */ }
    return null;
  }
  const [verdict, id] = raw.split(/\s+/, 2);
  const lowered = verdict?.toLowerCase();
  if (lowered === "allow" || lowered === "deny") return { decision: lowered, toolCallId: id ?? null };
  if (lowered === "consumed") return "consumed";
  return null;
}

/** Mark a decision as used so no later call can reuse it. */
function consumeDecision(path: string, toolCallId: string): void {
  try {
    writeFileSync(path, `consumed ${toolCallId}\n`);
  } catch { /* best effort: the caller already holds the decision */ }
}

async function awaitChildDecision(toolCallId: string): Promise<ChildOutcome> {
  const decisionPath = process.env.M1_CHILD_DECISION;
  const cancelPath = process.env.M1_CHILD_CANCEL;
  const budgetMs = Number(process.env.M1_CHILD_DEFER_MS ?? 15_000);
  const started = Date.now();

  const sleep = (ms: number) => {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, ms);
    return promise;
  };

  while (Date.now() - started < budgetMs) {
    // Cancellation first: it is authoritative for a call that has not run yet.
    if (cancelPath && existsSync(cancelPath)) return "cancelled";

    if (decisionPath && existsSync(decisionPath)) {
      const parsed = parseDecision(readFileSync(decisionPath, "utf8"));
      if (parsed === "consumed") {
        // Already applied to some call; never reuse it.
      } else if (parsed) {
        if (parsed.toolCallId === null || parsed.toolCallId === toolCallId) {
          consumeDecision(decisionPath, toolCallId);
          return parsed.decision;
        }
        // A decision addressed to another call is not this call's to use.
        log({ event: "gate-decision-ignored", reason: "scope-mismatch", toolCallId, decisionFor: parsed.toolCallId, at: Date.now() });
      }
    }
    await sleep(50);
  }
  return "timeout";
}

export default function approvalGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const session = sessionInfo(ctx);
    const auditAll = process.env.M1_UI_LOG_ALL === "1";
    if (auditAll) {
      log({ event: "tool-call-audit", toolName: event.toolName, hasUI: ctx.hasUI, gated: Boolean(GATED_TOOLS[event.toolName]), ...session });
    }
    if (!GATED_TOOLS[event.toolName]) return undefined;
    const target = String(event.input.path ?? event.input.command ?? "");
    log({ event: "gate", toolName: event.toolName, toolCallId: event.toolCallId ?? null, target, hasUI: ctx.hasUI, ...session, at: Date.now() });

    if (ctx.hasUI) {
      const choice = await ctx.ui.select(`Approve ${event.toolName}?`, ["Allow", "Deny"]);
      const allow = choice === "Allow";
      log({ event: "gate-decision", decision: allow ? "allow" : "deny", route: "ui", choice: choice ?? null, at: Date.now() });
      if (!allow) return { block: true, reason: `denied by user (${choice ?? "no answer"})` };
      return undefined;
    }

    // No UI in this session (subagent): decide from the experiment's policy.
    const policy = (process.env.M1_CHILD_POLICY ?? "deny").toLowerCase();
    if (policy === "allow") {
      log({ event: "gate-decision", decision: "allow", route: "child-policy", at: Date.now() });
      return undefined;
    }
    if (policy === "defer") {
      log({ event: "gate-pending", route: "child-defer", toolCallId: event.toolCallId ?? null, target, at: Date.now() });
      const decided = await awaitChildDecision(event.toolCallId ?? "");
      if (decided === "allow") {
        log({ event: "gate-decision", decision: "allow", route: "child-defer", at: Date.now() });
        return undefined;
      }
      if (decided === "cancelled") {
        // Bridge-provided cancellation: the pending request is gone and a late
        // decision can no longer admit the call. Distinct from `timeout`.
        log({ event: "gate-decision", decision: "deny", route: "child-cancelled", cancelled: true, toolCallId: event.toolCallId ?? null, at: Date.now() });
        return { block: true, reason: "aborted: the session was stopped while this approval was pending" };
      }
      log({ event: "gate-decision", decision: "deny", route: "child-defer", outcome: decided, at: Date.now() });
      return { block: true, reason: `denied: no out-of-band decision (${decided})` };
    }
    if (policy === "deny") {
      log({ event: "gate-decision", decision: "deny", route: "child-policy", at: Date.now() });
      return { block: true, reason: "denied by the session's child policy" };
    }
    log({ event: "gate-decision", decision: "deny", route: "no-ui", reason: "no-ui" });
    return { block: true, reason: "denied: no UI available for approval" };
  });
}
