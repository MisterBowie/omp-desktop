/**
 * T20-A feasibility spike extension.
 *
 * This is an *experiment* extension, not product code and not a gate: it
 * measures what the fixed OMP 18.2.7 trusted-extension surface can actually
 * observe and change, so the T20-A rework can state the transition-tool
 * (SubmitPlan/SubmitGoal) contract from evidence instead of assumption.
 *
 * It is driven entirely from `T20_SPIKE_*` environment variables and appends
 * one JSON object per observation to `T20_SPIKE_LOG`:
 *
 *   - `tool_call`        — every pre-execution interception OMP offers, with
 *                          the exact payload key set (recorded once) so the
 *                          spike can state whether the handler can see the
 *                          *batch* or only the single call.
 *   - `before_agent_start` — attempt index, prompt size, and the active tool
 *                          names OMP reports, so ordering/retry behavior of
 *                          `set_host_tools` vs `setActiveTools` is measurable.
 *   - `spike_*`          — what the extension itself did (clamp, block, abort).
 *
 * Controls:
 *   T20_SPIKE_LOG           JSONL output path (required for any logging).
 *   T20_SPIKE_CLAMP_FILE    JSON file `{"activeTools": [...]}` read fresh on
 *                           every `before_agent_start`; when present and
 *                           `pi.setActiveTools` exists, that list is applied.
 *   T20_SPIKE_MODE_FILE     JSON file `{"modeBlock": "<text>"}` read fresh on
 *                           every `before_agent_start`; the text is appended to
 *                           `event.systemPrompt` verbatim. The driver writes
 *                           the real `composeModeSystemPrompt(mode, "")` output
 *                           here (the production composer), so the measurement
 *                           covers the production block bytes, not a marker.
 *   T20_SPIKE_BLOCK         comma list of tool names to block pre-execution.
 *   T20_SPIKE_ABORT_ON      comma list of tool names whose interception calls
 *                           `ctx.abort()` (the spike's probe for whether a
 *                           sibling tool in the same batch can be stopped).
 *
 * Import-time side effects: none. A throwing handler would abort the runtime,
 * so every handler body is wrapped.
 */
import { readFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

interface ToolCallEvent {
  type: "tool_call";
  toolName: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
}

interface BeforeAgentStartEvent {
  type: "before_agent_start";
  systemPrompt: string[];
  prompt?: string;
  images?: unknown;
}

interface SpikeContext {
  hasUI?: boolean;
  cwd?: string;
  sessionManager?: { getSessionId?: () => string };
  abort?: () => void;
}

interface ExtensionAPI {
  on(
    event: "tool_call",
    handler: (event: ToolCallEvent, ctx: SpikeContext) => unknown,
  ): void;
  on(
    event: "before_agent_start",
    handler: (
      event: BeforeAgentStartEvent,
      ctx: SpikeContext,
    ) => { systemPrompt: string[] } | undefined,
  ): void;
  getActiveTools?: () => string[];
  setActiveTools?: (names: string[]) => Promise<void> | void;
  logger?: { warn?: (message: string, meta?: unknown) => void };
}

function env(name: string): string | undefined {
  const holder = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const value = holder.process?.env?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function log(entry: Record<string, unknown>): void {
  const path = env("T20_SPIKE_LOG");
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...entry })}\n`);
  } catch {
    // Logging must never break the runtime under measurement.
  }
}

function readClamp(): string[] | null {
  const path = env("T20_SPIKE_CLAMP_FILE");
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { activeTools?: unknown };
    if (!Array.isArray(parsed.activeTools)) return null;
    return parsed.activeTools.filter((name): name is string => typeof name === "string");
  } catch {
    return null;
  }
}

function readModeBlock(): string | null {
  const path = env("T20_SPIKE_MODE_FILE");
  if (!path) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { modeBlock?: unknown };
    return typeof parsed.modeBlock === "string" && parsed.modeBlock.length > 0 ? parsed.modeBlock : null;
  } catch {
    return null;
  }
}

export default function t20SpikeGate(pi: ExtensionAPI): void {
  const block = (env("T20_SPIKE_BLOCK") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const abortOn = (env("T20_SPIKE_ABORT_ON") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  let payloadKeysLogged = false;
  let startAttempt = 0;

  pi.on("tool_call", (event, ctx) => {
    try {
      if (!payloadKeysLogged) {
        payloadKeysLogged = true;
        log({
          event: "tool_call_payload_keys",
          eventKeys: Object.keys(event ?? {}),
          contextKeys: Object.keys(ctx ?? {}),
          hasAbort: typeof ctx?.abort === "function",
          hasUI: typeof ctx?.hasUI === "boolean" ? ctx.hasUI : typeof ctx?.hasUI,
        });
      }
      log({
        event: "tool_call",
        toolName: event?.toolName ?? null,
        toolCallId: event?.toolCallId ?? null,
        input: event?.input ?? null,
      });
      if (abortOn.includes(event?.toolName ?? "")) {
        const hadAbort = typeof ctx?.abort === "function";
        log({ event: "spike_abort_requested", toolName: event.toolName, hadAbort });
        if (hadAbort) ctx.abort?.();
        return { block: true, reason: `spike abort-on-intercept (${event.toolName})` };
      }
      if (block.includes(event?.toolName ?? "")) {
        log({ event: "spike_block", toolName: event.toolName });
        return { block: true, reason: `spike block (${event.toolName})` };
      }
      return undefined;
    } catch (error) {
      log({ event: "spike_error", where: "tool_call", message: String(error) });
      return undefined;
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    startAttempt += 1;
    const parts = Array.isArray(event?.systemPrompt) ? event.systemPrompt : [];
    const joined = parts.join("\n\n");
    log({
      event: "before_agent_start",
      attempt: startAttempt,
      parts: parts.length,
      chars: joined.length,
      bytes: Buffer.byteLength(joined, "utf8"),
      activeTools: typeof pi.getActiveTools === "function" ? pi.getActiveTools() : null,
      sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
    });
    const clamp = readClamp();
    if (clamp && typeof pi.setActiveTools === "function") {
      try {
        await pi.setActiveTools(clamp);
        log({ event: "spike_clamp", attempt: startAttempt, requested: clamp });
      } catch (error) {
        log({ event: "spike_error", where: "setActiveTools", message: String(error) });
      }
    }
    const modeBlock = readModeBlock();
    if (modeBlock) {
      log({
        event: "spike_mode_block",
        attempt: startAttempt,
        chars: modeBlock.length,
        bytes: Buffer.byteLength(modeBlock, "utf8"),
        sha256: createHash("sha256").update(modeBlock).digest("hex").slice(0, 16),
      });
      return { systemPrompt: [...parts, modeBlock] };
    }
    return undefined;
  });
}
