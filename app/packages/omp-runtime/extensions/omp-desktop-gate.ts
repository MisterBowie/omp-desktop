/**
 * The desktop's tool gate, loaded into the pinned runtime with
 * `--trusted-extension` (M5/T19-A: an exact file allowlist that disables
 * ambient extension discovery, so this module is the only policy that runs).
 *
 * It exists to make one promise: a gated tool does not run until the desktop
 * has answered, and an answer that never arrives is a denial. The pinned
 * runtime calls `tool_call` handlers before the call is scheduled, so returning
 * `{ block: true }` here is a real pre-execution block — nothing has touched the
 * filesystem or spawned a process yet (M1 E04: deny left the target file
 * untouched, allow executed exactly once).
 *
 * The dialog it raises is deliberately richer than a yes/no: it carries a
 * versioned descriptor (see `approval-protocol.ts`) in
 * `optionDetails[0].description`, which is how the desktop knows which tool
 * call, in which session, is being decided — the runtime's frame has no other
 * field for it. The option labels are ours too, and they are the fail-closed
 * boundary: anything that is not exactly the "allow" label denies.
 *
 * Fail-closed rules, in order of how often they matter:
 *
 *   1. No UI available (a subagent session, a headless run) → block. The
 *      desktop's interaction design cannot answer from inside the runtime's own
 *      process; pretending otherwise would execute the call unapproved.
 *   2. The dialog returned `undefined` (cancel, timeout, disconnected desktop)
 *      → block.
 *   3. The hook threw → block with the error text; it never falls through to
 *      "allow".
 *
 * Environment (set by the desktop when it starts the runtime):
 *   - `OMP_DESKTOP_GATE_TOOLS` — comma-separated native tool names (default
 *     below). Desktop host tools (`plugin_*`, `mcp_*`, M5/T19-B) are gated
 *     unconditionally and can only be opted out through
 *     `OMP_DESKTOP_GATE_MODE` — a host tool is a desktop-side capability and
 *     must never execute without the desktop's own approval first.
 *   - `OMP_DESKTOP_GATE_TIMEOUT_MS` — dialog deadline (default 120000).
 *   - `OMP_DESKTOP_GATE_MODE` — `ask` (default), `deny` (block everything
 *     gated without asking: unattended runs), or `allow`.
 */
import {
  OMP_APPROVAL_OPTIONS,
  encodeApprovalDescriptor,
  type OmpApprovalDescriptor,
  type OmpApprovalRisk,
} from "../src/session/approval-protocol.ts";

const DEFAULT_GATED_TOOLS = "write,edit,apply_patch,bash,eval";

/**
 * Risk for the card, decided by this gate's own policy.
 *
 * The desktop's permission card shows a risk level; the runtime does not
 * report one, and inferring it from arguments would be guesswork, so the split
 * is by tool: anything that can change a file, spawn a process or drive a
 * browser is high, read-only tools are low, everything else in between.
 *
 * Desktop host tools (M5/T19-B) are always controlled here, before any
 * execution, and their declared Pi risk cannot cross the pinned protocol:
 * plugin tools are therefore shown as `high` — the conservative upper bound,
 * so a high-risk plugin can never be downgraded — while user MCP tools are
 * `medium`, matching the Pi host's fixed MCP classification. (A low- or
 * medium-declared plugin sees a stricter high prompt this phase; that
 * limitation is recorded in ADR 0304 / the T19-B validation.)
 */
export function riskForTool(toolName: string): OmpApprovalRisk {
  if (toolName.startsWith("plugin_")) return "high";
  if (toolName.startsWith("mcp_")) return "medium";
  switch (toolName) {
    case "write":
    case "edit":
    case "apply_patch":
    case "bash":
    case "eval":
    case "browser":
    case "computer":
      return "high";
    case "read":
    case "grep":
    case "glob":
      return "low";
    default:
      return "medium";
  }
}

/**
 * True for desktop host-tool names (`plugin_<plugin>_…`, `mcp_<server>_…`).
 *
 * These are gated unconditionally — the `OMP_DESKTOP_GATE_TOOLS` list only
 * controls the native tool names; a host tool is a desktop-side capability
 * and must never execute without the desktop's own approval first. The only
 * opt-outs are the gate modes (`OMP_DESKTOP_GATE_MODE=allow`/`deny`).
 */
export function isHostToolName(toolName: string): boolean {
  return toolName.startsWith("plugin_") || toolName.startsWith("mcp_");
}
const DEFAULT_TIMEOUT_MS = 120_000;

type DialogOptions = { timeout?: number };

/**
 * One select item.
 *
 * The pinned RPC UI context turns an item's `description` into the request's
 * `optionDetails[index]` (`requestRpcSelect` in `modes/rpc/rpc-mode.ts`), which
 * is the only structured field a select frame carries. Our descriptor travels
 * there; passing it in `dialogOptions` would be silently dropped.
 */
type SelectItem = string | { label: string; description?: string };

interface UIContext {
  select(
    title: string,
    options: SelectItem[],
    dialogOptions?: DialogOptions,
  ): Promise<string | undefined>;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
}

interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

interface ToolCallContext {
  ui?: UIContext;
  cwd?: string;
  sessionManager?: { getSessionId?: () => string; getCwd?: () => string };
  hasUI?: boolean | (() => boolean);
}

interface ExtensionAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ToolCallContext) => unknown): void;
  logger?: { warn?(message: string, meta?: unknown): void; info?(message: string, meta?: unknown): void };
}

/** One-line, human-readable action summary for the dialog title. */
export function approvalTitle(event: ToolCallEvent): string {
  const input = event.input ?? {};
  const first = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return undefined;
  };
  switch (event.toolName) {
    case "write":
    case "edit":
    case "apply_patch": {
      const target = first("path", "file", "file_path", "paths");
      return target ? `${event.toolName}: ${target}` : event.toolName;
    }
    case "bash": {
      const command = first("command", "cmd");
      return command ? `bash: ${command.slice(0, 200)}` : "bash";
    }
    default: {
      const detail = first("path", "command", "query", "url");
      return detail ? `${event.toolName}: ${detail.slice(0, 200)}` : event.toolName;
    }
  }
}

/**
 * The dialog our gate raises for one call.
 *
 * Returns the labels (what the user picks) and the items (what the runtime
 * turns into labels plus per-option details). The descriptor rides on the first
 * item's description, which is how the desktop learns which tool call, in which
 * session, this dialog is about.
 */
export function buildApprovalDialog(
  event: ToolCallEvent,
  context: ToolCallContext,
  timeoutMs: number,
): { title: string; items: Array<{ label: string; description?: string }>; options: string[]; dialogOptions: DialogOptions } {
  const descriptor: OmpApprovalDescriptor = {
    v: 1,
    kind: "omp-desktop-approval",
    ...(sessionIdOf(context) ? { sessionId: sessionIdOf(context)! } : {}),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    risk: riskForTool(event.toolName),
    reason: approvalTitle(event),
    argsPreview: event.input,
    ...(cwdOf(context) ? { cwd: cwdOf(context)! } : {}),
  };
  const items = [
    { label: OMP_APPROVAL_OPTIONS[0], description: encodeApprovalDescriptor(descriptor) },
    { label: OMP_APPROVAL_OPTIONS[1] },
    { label: OMP_APPROVAL_OPTIONS[2] },
  ];
  return {
    title: approvalTitle(event),
    items,
    options: items.map((item) => item.label),
    dialogOptions: { timeout: timeoutMs },
  };
}

function sessionIdOf(context: ToolCallContext): string | undefined {
  try {
    return context.sessionManager?.getSessionId?.();
  } catch {
    return undefined;
  }
}

function cwdOf(context: ToolCallContext): string | undefined {
  try {
    return context.cwd ?? context.sessionManager?.getCwd?.();
  } catch {
    return undefined;
  }
}

function hasUi(context: ToolCallContext): boolean {
  const flag = context.hasUI;
  if (typeof flag === "function") {
    try {
      return flag() === true;
    } catch {
      return false;
    }
  }
  if (typeof flag === "boolean") return flag;
  return typeof context.ui?.select === "function";
}

/**
 * Decide one call. Exported so the decision table can be tested without a
 * running runtime; the extension below is a thin registration over it.
 */
export async function decideToolCall(
  event: ToolCallEvent,
  context: ToolCallContext,
  policy: {
    gated: ReadonlySet<string>;
    mode: "ask" | "deny" | "allow";
    timeoutMs: number;
    sessionAllowed: Set<string>;
  },
): Promise<{ block: boolean; reason?: string; route: string }> {
  // Desktop host tools are controlled unconditionally: the name list only
  // tunes the native tools, and a host tool must never slip past on a name.
  if (!policy.gated.has(event.toolName) && !isHostToolName(event.toolName)) {
    return { block: false, route: "not-gated" };
  }
  if (policy.mode === "allow") return { block: false, route: "mode-allow" };
  if (policy.mode === "deny") {
    return { block: true, reason: "tool calls are denied in this run", route: "mode-deny" };
  }
  if (policy.sessionAllowed.has(event.toolName)) return { block: false, route: "session-allow" };
  if (!hasUi(context) || !context.ui?.select) {
    return {
      block: true,
      reason: "tool requires approval but this session has no interactive UI",
      route: "no-ui",
    };
  }
  const dialog = buildApprovalDialog(event, context, policy.timeoutMs);
  let choice: string | undefined;
  try {
    choice = await context.ui.select(dialog.title, dialog.items, dialog.dialogOptions);
  } catch (error) {
    return {
      block: true,
      reason: `approval dialog failed: ${error instanceof Error ? error.message : String(error)}`,
      route: "dialog-error",
    };
  }
  if (choice === OMP_APPROVAL_OPTIONS[0]) return { block: false, route: "allow-once" };
  if (choice === OMP_APPROVAL_OPTIONS[1]) {
    policy.sessionAllowed.add(event.toolName);
    return { block: false, route: "allow-session" };
  }
  return {
    block: true,
    reason: choice === undefined ? "denied by user (no answer)" : `denied by user (${choice})`,
    route: "deny",
  };
}

/** Parse the gated-tool list; an empty list gates nothing (explicit opt-out). */
export function parseGatedTools(value: string | undefined): Set<string> {
  const raw = value ?? DEFAULT_GATED_TOOLS;
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

export default function ompDesktopGate(pi: ExtensionAPI): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const gated = parseGatedTools(env?.OMP_DESKTOP_GATE_TOOLS);
  const mode = (env?.OMP_DESKTOP_GATE_MODE ?? "ask").trim() as "ask" | "deny" | "allow";
  const timeoutMs = Number(env?.OMP_DESKTOP_GATE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const sessionAllowed = new Set<string>();

  pi.on("tool_call", async (event, context) => {
    const verdict = await decideToolCall(event, context, {
      gated,
      mode: mode === "deny" || mode === "allow" ? mode : "ask",
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      sessionAllowed,
    });
    if (!verdict.block) return undefined;
    return { block: true, reason: verdict.reason ?? "denied" };
  });
}
