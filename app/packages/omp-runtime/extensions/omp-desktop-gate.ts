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
 *   - `OMP_DESKTOP_STATE` — the run-scoped desktop runtime state
 *     (M5/T19-C skills+memory; M5/T20-B1 mode/policy). Its
 *     `before_agent_start` handler appends the PI-identical skill-catalog and
 *     project-memory blocks plus the production `composeModeSystemPrompt(mode,
 *     "")` output to the runtime's system prompt when the file is fresh,
 *     valid and owned by the firing session; in Plan/Goal it also clamps the
 *     active tool set to the PI contract catalog. A file that claims the
 *     firing session but fails validation refuses the turn (`ctx.abort()`,
 *     the runtime's own formal stop path — a thrown handler error is logged
 *     and swallowed by the extension runner and would NOT protect the turn).
 */
import {
  OMP_APPROVAL_OPTIONS,
  encodeApprovalDescriptor,
  type OmpApprovalDescriptor,
  type OmpApprovalPermissionMode,
  type OmpApprovalRisk,
} from "../src/session/approval-protocol.ts";
import {
  desktopCapabilityPrompt,
  readDesktopStateForSession,
  type DesktopCapabilityState,
  type DesktopHostToolPolicy,
  type DesktopPermissionMode,
} from "../src/desktop-state.ts";

const DEFAULT_GATED_TOOLS = "write,edit,apply_patch,bash,eval";

/**
 * The native tools PI's contract modes allow, restricted to names this
 * runtime actually ships (`read`, `glob`, `grep`, `bash`, `ask`,
 * `new_context`). PI's `BrowserPreview` has no OMP counterpart — it is never
 * fabricated here — and every entry is still filtered against the live active
 * set before it is selected: a tool this session does not have is not made to
 * appear. OMP names that PI's contract excludes (`write`, `edit`, `eval`,
 * `task`, `todo`, `web_search`, …) and every user MCP tool stay out.
 */
export const CONTRACT_MODE_NATIVE_TOOLS: readonly string[] = [
  "read",
  "grep",
  "glob",
  "bash",
  "ask",
  "new_context",
];

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
 * limitation is recorded in ADR 0304 / the T19-B validation.) The per-tool
 * declared risk does travel to the gate in the run-scoped state policy table
 * (M5/T20-B1) for the execution-time decision table (T20-C); the card split
 * here is unchanged this phase.
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

export interface ExtensionAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ToolCallContext) => unknown): void;
  on(
    event: "before_agent_start",
    handler: (
      event: BeforeAgentStartEventSlice,
      ctx: BeforeAgentStartContextSlice,
    ) => { systemPrompt: string[] } | undefined | Promise<{ systemPrompt: string[] } | undefined>,
  ): void;
  /** Live active-tool selection (the extension API's `session.getEnabledToolNames`). */
  getActiveTools?: () => string[];
  /** Replace the active-tool selection (the extension API's `setActiveToolsByName`). */
  setActiveTools?: (names: string[]) => Promise<void> | void;
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
  permissionMode?: OmpApprovalPermissionMode,
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
    ...(permissionMode ? { permissionMode } : {}),
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
    /** The effective permission mode from the run-scoped state, when readable. */
    permissionMode?: DesktopPermissionMode;
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
  const dialog = buildApprovalDialog(event, context, policy.timeoutMs, policy.permissionMode);
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

/** The `before_agent_start` event slice the injection handler reads. */
export type BeforeAgentStartEventSlice = {
  systemPrompt: string[];
};

/** The session identity and stop channel the injection handler reads. */
export type BeforeAgentStartContextSlice = {
  sessionManager?: { getSessionId?: () => string } | null;
  /**
   * Abort the current agent operation (the pinned runtime's
   * `ExtensionContext.abort` → `session.abort({ reason: USER_INTERRUPT_LABEL })`).
   * This is the only formal way a `before_agent_start` handler can refuse a
   * turn: a thrown handler error is caught by the extension runner, logged and
   * swallowed, and the provider request would still be delivered.
   */
  abort?: () => void;
};

/** The gate's verdict for one `before_agent_start`. */
export type BeforeAgentStartDecision =
  | { kind: "inject"; state: DesktopCapabilityState; systemPrompt: string[] }
  | { kind: "skip" }
  | { kind: "refuse"; reason: string };

/**
 * Decide the `before_agent_start` answer for one state file.
 *
 * Returns an injection that appends the capability block (skills then memory,
 * byte-identical to the T19-C behavior) and then the mode block, both after
 * every native part — never replacing or dropping them. The mode block is
 * `composeModeSystemPrompt(mode, "")`'s exact output, written by the desktop
 * and validated back here, so no PI default base or OMP base is ever copied
 * into the state.
 *
 * Every other case is explicit:
 *   - a file owned by another session (a subagent delegate) or an absent file
 *     → `skip`: nothing is injected and no tool set is touched (Pi's delegates
 *     never receive project memory, skills or mode blocks either);
 *   - a file that claims this session but fails validation → `refuse`: the
 *     turn must be aborted, because continuing would silently run a Plan/Goal
 *     intent as an unclamped Agent turn.
 */
export function beforeAgentStartPolicy(
  event: BeforeAgentStartEventSlice,
  context: BeforeAgentStartContextSlice,
  statePath: string | undefined | null,
  now: number,
): BeforeAgentStartDecision {
  let sessionId: string | undefined;
  try {
    sessionId = context.sessionManager?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  const read = readDesktopStateForSession(statePath, now, sessionId);
  if (read.kind === "absent" || read.kind === "foreign") return { kind: "skip" };
  if (read.kind === "invalid") {
    return {
      kind: "refuse",
      reason: "the desktop runtime state for this session is missing or invalid; refusing to run the turn without its mode and policy",
    };
  }
  const systemPrompt = [...event.systemPrompt];
  const capability = desktopCapabilityPrompt(read.state);
  if (capability) systemPrompt.push(capability);
  systemPrompt.push(read.state.modeBlock);
  return { kind: "inject", state: read.state, systemPrompt };
}

/**
 * The tool names a contract mode (Plan/Goal) may keep active, in the order the
 * runtime currently has them: the allowed native names plus every desktop
 * plugin tool that declares a non-empty plan-safe action list (PI ADR 0211).
 * User MCP tools and undeclared plugin tools are never contract-visible, and
 * nothing outside the live active set is invented.
 */
export function contractActiveToolNames(
  state: Pick<DesktopCapabilityState, "hostTools">,
  activeNames: readonly string[],
): string[] {
  const allowed = new Set<string>(CONTRACT_MODE_NATIVE_TOOLS);
  for (const tool of state.hostTools as DesktopHostToolPolicy[]) {
    if (tool.origin === "plugin" && tool.planSafeActions.length > 0) allowed.add(tool.name);
  }
  return activeNames.filter((name) => allowed.has(name));
}

/** The gate's cross-prompt clamp memory: the pre-contract selection and whether a clamp is live. */
export type ContractClampState = { applied: boolean; before: string[] };

export type ContractClampResult =
  | { ok: true; changed: boolean; active: string[] }
  | { ok: false; reason: string };

/**
 * Enforce the mode's tool contract on the runtime's active-tool selection.
 *
 * Contract modes select exactly {@link contractActiveToolNames}; returning to
 * Agent restores the selection captured before the first clamp, unioned with
 * anything the runtime auto-activated while the clamp was live (a host tool
 * registered for this prompt), so no user-disabled tool is resurrected and no
 * stale clamp survives. An unchanged selection is left untouched — that is
 * what keeps a stable prompt at one start attempt, while a real change costs
 * at most the runtime's one policy retry.
 *
 * Exported so the selection state machine is testable without a runtime; the
 * registered handler is a thin caller.
 */
export async function applyContractToolClamp(
  api: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">,
  clamp: ContractClampState,
  state: Pick<DesktopCapabilityState, "mode" | "hostTools">,
): Promise<ContractClampResult> {
  if (state.mode === "agent") {
    if (!clamp.applied) return { ok: true, changed: false, active: api.getActiveTools?.() ?? [] };
    if (typeof api.setActiveTools !== "function") {
      return { ok: false, reason: "the runtime exposes no tool-selection API to restore the pre-Plan selection" };
    }
    const active = api.getActiveTools?.() ?? [];
    const restore = [...clamp.before, ...active.filter((name) => !clamp.before.includes(name))];
    clamp.applied = false;
    clamp.before = [];
    await api.setActiveTools(restore);
    return { ok: true, changed: true, active: restore };
  }
  if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") {
    return { ok: false, reason: "the runtime exposes no tool-selection API to enforce the contract catalog" };
  }
  const active = api.getActiveTools();
  if (!clamp.applied) {
    clamp.before = [...active];
    clamp.applied = true;
  }
  const allowed = contractActiveToolNames(state, active);
  if (active.length === allowed.length && active.every((name, index) => name === allowed[index])) {
    return { ok: true, changed: false, active };
  }
  await api.setActiveTools(allowed);
  return { ok: true, changed: true, active: allowed };
}

export default function ompDesktopGate(pi: ExtensionAPI): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const gated = parseGatedTools(env?.OMP_DESKTOP_GATE_TOOLS);
  const mode = (env?.OMP_DESKTOP_GATE_MODE ?? "ask").trim() as "ask" | "deny" | "allow";
  const timeoutMs = Number(env?.OMP_DESKTOP_GATE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const sessionAllowed = new Set<string>();
  const clamp: ContractClampState = { applied: false, before: [] };

  /** Refuse one agent start through the runtime's own abort path. */
  const refuseStart = (context: BeforeAgentStartContextSlice, reason: string): void => {
    if (typeof context.abort === "function") {
      try {
        context.abort();
        return;
      } catch (error) {
        pi.logger?.warn?.("desktop gate could not abort a refused agent start", String(error));
      }
    }
    // The pinned runtime always provides abort; a host that does not cannot be
    // protected from inside this process. Never pretend the refusal happened.
    pi.logger?.warn?.("desktop gate refused an agent start but the runtime exposes no abort", reason);
  };

  pi.on("tool_call", async (event, context) => {
    let permissionMode: DesktopPermissionMode | undefined;
    try {
      const read = readDesktopStateForSession(
        env?.OMP_DESKTOP_STATE,
        Date.now(),
        sessionIdOf(context),
      );
      if (read.kind === "owned") permissionMode = read.state.permissionMode;
    } catch {
      permissionMode = undefined;
    }
    const verdict = await decideToolCall(event, context, {
      gated,
      mode: mode === "deny" || mode === "allow" ? mode : "ask",
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      sessionAllowed,
      ...(permissionMode ? { permissionMode } : {}),
    });
    if (!verdict.block) return undefined;
    return { block: true, reason: verdict.reason ?? "denied" };
  });

  // Desktop skills, project memory and the mode block enter the provider-visible
  // system prompt here, and nowhere else; the mode's tool contract is clamped
  // in the same handler, before the runtime commits the start. A failed read
  // injects nothing (a delegate session) or refuses the turn (the owner's
  // state is invalid); the handler never throws into the agent start.
  pi.on("before_agent_start", async (event, context) => {
    try {
      const decision = beforeAgentStartPolicy(event, context, env?.OMP_DESKTOP_STATE, Date.now());
      if (decision.kind === "refuse") {
        refuseStart(context, decision.reason);
        return undefined;
      }
      if (decision.kind === "skip") return undefined;
      const clamped = await applyContractToolClamp(pi, clamp, decision.state);
      if (!clamped.ok) {
        refuseStart(context, clamped.reason);
        return undefined;
      }
      return { systemPrompt: decision.systemPrompt };
    } catch (error) {
      // The handler must not silently degrade: an unexpected failure while a
      // state file is owned by this session refuses the turn, and otherwise
      // falls back to "no injection" (the native prompt ships untouched).
      try {
        const read = readDesktopStateForSession(env?.OMP_DESKTOP_STATE, Date.now(), context.sessionManager?.getSessionId?.());
        if (read.kind === "owned" || read.kind === "invalid") {
          refuseStart(context, `desktop gate failed while applying the runtime state: ${String(error)}`);
        }
      } catch {
        // The probe itself failed; nothing attributable to refuse.
      }
      return undefined;
    }
  });
}
