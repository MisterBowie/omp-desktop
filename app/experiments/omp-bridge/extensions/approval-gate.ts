/**
 * Approval gate for E04/E05: blocks a native tool before it produces any side
 * effect, using the OMP extension `tool_call` hook plus a real UI decision.
 *
 * Decisions are appended to $M1_UI_LOG so the experiment can assert what the
 * gate saw and how it answered. The gate is deny-by-default when no UI exists.
 */
import { appendFileSync } from "node:fs";

interface DialogOptions {
  timeout?: number;
}
interface UIContext {
  select(title: string, options: string[], options?: DialogOptions): Promise<string | undefined>;
}
interface ToolCallCtx {
  hasUI: boolean;
  ui: UIContext;
}
interface ToolCallEvent {
  toolName: string;
  input: Record<string, unknown>;
}
interface ExtensionAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ToolCallCtx) => Promise<unknown> | unknown): void;
}

const GATED_TOOLS: Record<string, true> = { write: true, bash: true };

function log(entry: Record<string, unknown>): void {
  const path = process.env.M1_UI_LOG;
  if (path) appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export default function approvalGate(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    const auditAll = process.env.M1_UI_LOG_ALL === "1";
    if (auditAll) {
      log({ event: "tool-call-audit", toolName: event.toolName, hasUI: ctx.hasUI, gated: Boolean(GATED_TOOLS[event.toolName]) });
    }
    if (!GATED_TOOLS[event.toolName]) return undefined;
    const target = String(event.input.path ?? event.input.command ?? "");
    log({ event: "gate", toolName: event.toolName, target, hasUI: ctx.hasUI, at: Date.now() });

    if (!ctx.hasUI) {
      log({ event: "gate-decision", decision: "deny", reason: "no-ui" });
      return { block: true, reason: "denied: no UI available for approval" };
    }
    const choice = await ctx.ui.select(`Approve ${event.toolName}?`, ["Allow", "Deny"]);
    const allow = choice === "Allow";
    log({ event: "gate-decision", decision: allow ? "allow" : "deny", choice: choice ?? null, at: Date.now() });
    if (!allow) return { block: true, reason: `denied by user (${choice ?? "no answer"})` };
    return undefined;
  });
}
