/**
 * E03 probe extension: exercises extension UI select/confirm/input against the
 * rpc-ui surface. Answers are appended to $M1_UI_LOG so the experiment can
 * assert what the extension actually observed (not just what was sent).
 *
 * Scenario is chosen by $M1_UI_SCENARIO: "all" (default) | "cancel" | "timeout".
 * The tool call is always blocked so the experiment stays side-effect free.
 */
import { appendFileSync } from "node:fs";

interface DialogOptions {
  timeout?: number;
}
interface UIContext {
  select(title: string, options: string[], options?: DialogOptions): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
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

function log(entry: Record<string, unknown>): void {
  const path = process.env.M1_UI_LOG;
  if (path) appendFileSync(path, `${JSON.stringify(entry)}\n`);
}

export default function uiProbe(pi: ExtensionAPI): void {
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write") return undefined;
    const scenario = process.env.M1_UI_SCENARIO ?? "all";
    log({ event: "tool_call", toolName: event.toolName, hasUI: ctx.hasUI, scenario });
    if (!ctx.hasUI) return { block: true, reason: "e03: no UI surface" };

    if (scenario === "cancel") {
      const answer = await ctx.ui.select("E03 cancel probe", ["A", "B"]);
      log({ asked: "select", answered: answer ?? null });
      return { block: true, reason: "e03: cancel probe" };
    }
    if (scenario === "timeout") {
      const answer = await ctx.ui.select("E03 timeout probe", ["A", "B"], { timeout: 800 });
      log({ asked: "select-timeout", answered: answer ?? null });
      return { block: true, reason: "e03: timeout probe" };
    }

    const selected = await ctx.ui.select("E03 select probe", ["A", "B"]);
    log({ asked: "select", answered: selected ?? null });
    const confirmed = await ctx.ui.confirm("E03 confirm probe", "proceed?");
    log({ asked: "confirm", answered: confirmed });
    const typed = await ctx.ui.input("E03 input probe", "placeholder");
    log({ asked: "input", answered: typed ?? null });
    return { block: true, reason: "e03: probed UI then blocked" };
  });
}
