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
 *   1. The decision needs an interaction and no UI is available (a subagent
 *      session, a headless run) → block. The desktop's interaction design
 *      cannot answer from inside the runtime's own process; pretending
 *      otherwise would execute the call unapproved. A call the effective
 *      policy allows without interaction (Low risk, `auto`, an eligible
 *      session grant) still passes — no-UI fails closed exactly where PI's
 *      host would have to ask (M5/T20-C).
 *   2. The dialog returned `undefined` (cancel, timeout, disconnected desktop)
 *      → block.
 *   3. The hook threw → block with the error text; it never falls through to
 *      "allow".
 *   4. The mandatory state channel is on but no owned, valid policy exists for
 *      an interactive session (or a delegate has no fresh parent snapshot) →
 *      block every call. "Cannot read the policy" is never silently an Agent
 *      policy, and a mutable state failure during execution cannot turn a
 *      contract refusal into an approval.
 *
 * When the run-scoped state is readable, calls are decided with PI's
 * execution-time order (M5/T20-C, §1.3.1): contract modes hard-deny every tool
 * outside PI's allowlist (plus declared plan-safe plugin tools) before risk,
 * `auto`, grants, external paths or this gate's legacy fixture switch can
 * matter; explicit external paths allow under `auto`/grant and ask otherwise;
 * Low risk allows; `auto` allows; `accept-edits` auto-accepts only Write/Edit;
 * a session grant allows; everything else asks.
 *
 * Environment (set by the desktop when it starts the runtime):
 *   - `OMP_DESKTOP_GATE_TOOLS` — comma-separated native tool names (default
 *     below). Desktop host tools (`plugin_*`, `mcp_*`, M5/T19-B) are gated
 *     unconditionally and can only be opted out through
 *     `OMP_DESKTOP_GATE_MODE` — a host tool is a desktop-side capability and
 *     must never execute without the desktop's own approval first.
 *   - `OMP_DESKTOP_GATE_TIMEOUT_MS` — dialog deadline (default 120000).
 *   - `OMP_DESKTOP_GATE_MODE` — `ask` (default), `deny` (block everything
 *     gated without asking: unattended runs), or `allow`. A fixture-only
 *     switch: the production launcher never writes it, and it is subordinate
 *     to the contract hard deny and the state-driven decision table — `allow`
 *     cannot resurrect a contract-denied tool (M5/T20-C).
 *   - `OMP_DESKTOP_STATE_REQUIRED` — `1` when the launcher enabled the
 *     mandatory mode/policy channel for this run (the supervisor's
 *     `desktopStateRequired`, `0`/absent otherwise). Fixed at spawn; it is
 *     never inferred from the mutable state file.
 *   - `OMP_DESKTOP_STATE` — the run-scoped desktop runtime state
 *     (M5/T19-C skills+memory; M5/T20-B1 mode/policy). Its
 *     `before_agent_start` handler appends the PI-identical skill-catalog and
 *     project-memory blocks plus the production `composeModeSystemPrompt(mode,
 *     "")` output to the runtime's system prompt when the file is fresh,
 *     valid and owned by the firing session; in Plan/Goal it also clamps the
 *     active tool set to the PI contract catalog. The owning bridge launches
 *     the runtime with the mandatory channel enabled
 *     (`OMP_DESKTOP_STATE_REQUIRED=1`, the supervisor's
 *     `desktopStateRequired` option); from then on a file that is missing,
 *     unreadable or fails validation refuses the interactive session's turn
 *     (`ctx.abort()` plus a structured `notify` — a thrown handler error is
 *     logged and swallowed by the extension runner and would NOT protect the
 *     turn), while a delegate session (no UI) keeps the zero-injection skip a
 *     real subagent needs. The switch is fixed at spawn, so deleting the
 *     state file (or anything else in the mutable run root) can never turn the
 *     channel off; a fixture that never enabled it says so explicitly.
 *
 * The gate also registers the desktop's internal turn-boundary command
 * (`/<OMP_TURN_COMMAND> <token>`, see `session/turn-fence.ts`). The runner
 * invokes it through the formal RPC `prompt` path before every admitted turn;
 * it is consumed locally before any provider request, acknowledges itself
 * through `notify`, and its token is echoed by every start refusal so a
 * replayed descriptor from an earlier generation can never close a newer one.
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
  isDesktopStateRequired,
  MAX_DESKTOP_STATE_AGE_MS,
  readDesktopStateForSession,
  type DesktopCapabilityState,
  type DesktopHostToolPolicy,
  type DesktopRuntimeMode,
} from "../src/desktop-state.ts";
import {
  encodeStartRefusal,
  OMP_START_REFUSAL_KIND,
  OMP_START_REFUSAL_VERSION,
  type OmpStartRefusal,
  type OmpStartRefusalCode,
} from "../src/session/start-refusal.ts";
import {
  encodeTurnAck,
  isTurnToken,
  OMP_TURN_COMMAND,
} from "../src/session/turn-fence.ts";
import { requiresExternalPathPermission } from "../src/session/tool-paths.ts";

/**
 * The native tools the gate controls by default. `browser`/`computer`/
 * `browserpreview` are PI-unknown (Medium) capabilities the decision table
 * must card in ask/accept-edits and allow under auto (M5/T20-C, C5/C7);
 * `browserpreview` never exists in this runtime, so gating it is inert here —
 * it is listed so the PI contract name is judged, not defaulted.
 */
const DEFAULT_GATED_TOOLS = "write,edit,apply_patch,bash,eval,browser,computer,browserpreview";

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
 * The native risk mapping, exactly PI's `tool_risk_with_declared` for the
 * names this runtime ships: `Read`/`Glob`/`Grep` (and PI's
 * `ScheduledTaskList`) are Low, `Write`/`Edit`/`Bash` (and PI's
 * `GenerateImages`) are High, and everything PI's table does not name —
 * including OMP-only tools such as `apply_patch`, `eval`, `browser` and
 * `computer` — is Medium. The gate never guesses a higher or lower class from
 * a name prefix; host tools get their declared risk from the run-scoped
 * policy table instead (M5/T20-C).
 */
const NATIVE_LOW_RISK: Record<string, true> = {
  read: true,
  glob: true,
  grep: true,
  scheduledtasklist: true,
};
const NATIVE_HIGH_RISK: Record<string, true> = {
  write: true,
  edit: true,
  bash: true,
  generateimages: true,
};

export function nativeRiskForTool(toolName: string): OmpApprovalRisk {
  const name = toolName.toLowerCase();
  if (NATIVE_LOW_RISK[name] === true) return "low";
  if (NATIVE_HIGH_RISK[name] === true) return "high";
  return "medium";
}

/**
 * The risk the execution-time decision table and the approval card share for
 * one call: the declared plugin risk from the run-scoped policy table
 * (missing/unregistered plugin declarations are Medium, PI's default), PI's
 * fixed Low for user MCP tools, and the native mapping above for everything
 * else. The card never re-derives a different number than the decision.
 */
export function toolRiskForCall(
  toolName: string,
  hostTools: readonly DesktopHostToolPolicy[],
): OmpApprovalRisk {
  const declared = hostTools.find((tool) => tool.name === toolName);
  if (declared) return declared.risk;
  if (toolName.startsWith("plugin_")) return "medium";
  if (toolName.startsWith("mcp_")) return "low";
  return nativeRiskForTool(toolName);
}

/**
 * PI's `plan_mode_allows` translated to this runtime's tool names. `ask` is
 * this runtime's non-mutating question tool — PI's contract has no model
 * tool for questions because the host owns that channel, and denying it
 * would leave a Plan/Goal turn unable to ask the user anything. `new_context`
 * is sidecar-side and never reaches this gate; `BrowserPreview` has no OMP
 * counterpart and nothing here fabricates one. Both PI-only names stay in the
 * set so a call that somehow arrives is judged by the PI contract instead of
 * being misclassified as an unknown tool.
 */
const CONTRACT_MODE_ALLOWED: Record<string, true> = {
  read: true,
  glob: true,
  grep: true,
  bash: true,
  ask: true,
  browserpreview: true,
  new_context: true,
};

/**
 * True when a contract mode (Plan/Goal) may execute this tool: a PI-allowed
 * native name, or a plugin tool whose forwarded declaration carries a
 * non-empty `planSafeActions` list (PI ADR 0211). The per-action restriction
 * of such a plugin tool is enforced at execution by the PI plugin-runtime
 * guard with the turn's real mode (M5/T20-C). User MCP tools and plugin tools
 * without a declaration are never contract-allowed.
 */
export function contractAllowsTool(
  toolName: string,
  hostTools: readonly DesktopHostToolPolicy[],
): boolean {
  if (CONTRACT_MODE_ALLOWED[toolName.toLowerCase()] === true) return true;
  const declared = hostTools.find((tool) => tool.name === toolName);
  return (
    declared !== undefined && declared.origin === "plugin" && declared.planSafeActions.length > 0
  );
}

/** The PI rejection code and message for one contract-denied call. */
function contractDenyReason(toolName: string, mode: DesktopRuntimeMode): string {
  const name = toolName.toLowerCase();
  if (name === "write") return `WRITE_DISABLED_IN_PLAN: Write is disabled in ${mode} mode`;
  if (name === "edit") return `EDIT_DISABLED_IN_PLAN: Edit is disabled in ${mode} mode`;
  if (toolName.startsWith("plugin_")) {
    return `PLUGIN_DISABLED_IN_PLAN: plugin tool ${toolName} is not available in ${mode} mode`;
  }
  return `TOOL_DISABLED_IN_PLAN: ${toolName} is not available in ${mode} mode`;
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
  /**
   * Register the desktop's internal turn-boundary command (the runtime's
   * public `pi.registerCommand`). Optional so an embedder without the command
   * API still loads the gate for its other policies; the runner refuses to
   * prompt when the command is not advertised, so a missing registration can
   * never degrade into an unbound turn.
   */
  registerCommand?(
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: BeginAgentStartContextSlice) => unknown;
    },
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
 * session, this dialog is about. Risk, reason, mode and permission mode all
 * come from the same decision that produced the card — the desktop never
 * re-derives a different risk or mode for the same call.
 */
export function buildApprovalDialog(
  event: ToolCallEvent,
  context: ToolCallContext,
  timeoutMs: number,
  policy: {
    risk: OmpApprovalRisk;
    reason: string;
    mode?: DesktopRuntimeMode;
    permissionMode?: OmpApprovalPermissionMode;
  },
): { title: string; items: Array<{ label: string; description?: string }>; options: string[]; dialogOptions: DialogOptions } {
  const descriptor: OmpApprovalDescriptor = {
    v: 1,
    kind: "omp-desktop-approval",
    ...(sessionIdOf(context) ? { sessionId: sessionIdOf(context)! } : {}),
    toolCallId: event.toolCallId,
    toolName: event.toolName,
    risk: policy.risk,
    reason: policy.reason,
    argsPreview: event.input,
    ...(cwdOf(context) ? { cwd: cwdOf(context)! } : {}),
    ...(policy.mode ? { mode: policy.mode } : {}),
    ...(policy.permissionMode ? { permissionMode: policy.permissionMode } : {}),
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

/** The run-scoped policy subset one gate decision consumes. */
export type ToolCallPolicySnapshot = Pick<
  DesktopCapabilityState,
  "mode" | "permissionMode" | "hostTools"
>;

export type ToolCallVerdict = { block: boolean; reason?: string; route: string };

/**
 * Raise the desktop's approval dialog for one controlled call and map the
 * answer to a decision. Risk, reason, mode and permission mode all come from
 * the caller's decision, so the card and the enforced policy can never
 * disagree.
 */
async function raiseApproval(
  event: ToolCallEvent,
  context: ToolCallContext,
  policy: { timeoutMs: number; sessionAllowed: Set<string>; snapshot?: ToolCallPolicySnapshot },
  decision: { risk: OmpApprovalRisk; reason: string },
): Promise<ToolCallVerdict> {
  if (!hasUi(context) || !context.ui?.select) {
    return {
      block: true,
      reason: "tool requires approval but this session has no interactive UI",
      route: "no-ui",
    };
  }
  const dialog = buildApprovalDialog(event, context, policy.timeoutMs, {
    risk: decision.risk,
    reason: decision.reason,
    ...(policy.snapshot
      ? { mode: policy.snapshot.mode, permissionMode: policy.snapshot.permissionMode }
      : {}),
  });
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

/**
 * Decide one call with PI's execution-time decision order (M5/T20-C, PI
 * `permissions.rs` §1.3.1), using the run-scoped snapshot the desktop wrote
 * for this prompt:
 *
 *   1. a contract mode (Plan/Goal) hard-denies every tool outside PI's
 *      allowlist (plus plugin tools with a non-empty `planSafeActions`
 *      declaration) before risk, auto, grants, external paths or the legacy
 *      fixture switch can matter;
 *   2. external explicit paths: `auto` allows, a session grant allows, every
 *      other mode needs the card;
 *   3. Low risk allows, `auto` allows, `accept-edits` auto-accepts only
 *      Write/Edit; a session grant allows; everything else asks;
 *   4. no interactive UI fails closed exactly when the decision needs the
 *      interaction — an `auto` or Low call still passes.
 *
 * Without the mandatory channel (a fixture that never enabled it) the legacy
 * path is preserved: only the configured native names and desktop host tools
 * are controlled, and the card carries the PI default risk.
 */
export async function decideToolCall(
  event: ToolCallEvent,
  context: ToolCallContext,
  policy: {
    gated: ReadonlySet<string>;
    mode: "ask" | "deny" | "allow";
    timeoutMs: number;
    sessionAllowed: Set<string>;
    /**
     * The policy snapshot owned by the call's session — or, for a delegate
     * (no UI) call, the parent session's last validated snapshot, which is
     * the same durable policy PI's host reads for a subagent call.
     */
    snapshot?: ToolCallPolicySnapshot;
    /** The mandatory channel is on but no usable policy exists: fail closed. */
    policyUnavailable?: boolean;
  },
): Promise<ToolCallVerdict> {
  if (policy.policyUnavailable) {
    return {
      block: true,
      reason:
        "the desktop runtime policy is unavailable; refusing the call without its mode and permission mode",
      route: "policy-unavailable",
    };
  }
  const snapshot = policy.snapshot;
  if (snapshot) {
    const contract = snapshot.mode === "plan" || snapshot.mode === "goal";
    if (contract && !contractAllowsTool(event.toolName, snapshot.hostTools)) {
      return {
        block: true,
        reason: contractDenyReason(event.toolName, snapshot.mode),
        route: "contract-deny",
      };
    }
    // Gated membership accepts the PI capitalizations as well (`Read`,
    // `Bash`, `BrowserPreview`): the runtime dispatches lowercase names, but
    // the PI contract names must be judged by the same table, never defaulted.
    const controlled =
      policy.gated.has(event.toolName) ||
      policy.gated.has(event.toolName.toLowerCase()) ||
      isHostToolName(event.toolName);
    const external = requiresExternalPathPermission(
      cwdOf(context) ?? null,
      null,
      event.toolName,
      event.input,
    );
    // A contract-allowed read-only call (or an Agent call outside the
    // controlled set) does not need a decision of its own.
    if (!controlled && !external) {
      return { block: false, route: contract ? "contract-allow" : "not-gated" };
    }
    // The legacy fixture switch stays subordinate to the contract deny above.
    if (policy.mode === "allow") return { block: false, route: "mode-allow" };
    if (policy.mode === "deny") {
      return { block: true, reason: "tool calls are denied in this run", route: "mode-deny" };
    }
    const risk = toolRiskForCall(event.toolName, snapshot.hostTools);
    if (external) {
      if (snapshot.permissionMode === "auto") return { block: false, route: "external-allow" };
      if (policy.sessionAllowed.has(event.toolName)) {
        return { block: false, route: "external-grant" };
      }
      return raiseApproval(
        event,
        context,
        { ...policy, snapshot },
        { risk, reason: `external path requires approval (${snapshot.permissionMode} mode)` },
      );
    }
    if (risk === "low") return { block: false, route: "low-risk" };
    if (snapshot.permissionMode === "auto") return { block: false, route: "auto-allow" };
    if (
      snapshot.permissionMode === "accept-edits" &&
      (event.toolName.toLowerCase() === "write" || event.toolName.toLowerCase() === "edit")
    ) {
      return { block: false, route: "accept-edits-allow" };
    }
    if (policy.sessionAllowed.has(event.toolName)) return { block: false, route: "session-grant" };
    return raiseApproval(
      event,
      context,
      { ...policy, snapshot },
      { risk, reason: `approval required (${risk} risk, ${snapshot.permissionMode} mode)` },
    );
  }
  // No run-scoped snapshot: the legacy fixture path. Desktop host tools are
  // controlled unconditionally; native tools only through the configured name
  // list.
  if (!policy.gated.has(event.toolName) && !isHostToolName(event.toolName)) {
    return { block: false, route: "not-gated" };
  }
  if (policy.mode === "allow") return { block: false, route: "mode-allow" };
  if (policy.mode === "deny") {
    return { block: true, reason: "tool calls are denied in this run", route: "mode-deny" };
  }
  if (policy.sessionAllowed.has(event.toolName)) return { block: false, route: "session-allow" };
  const risk = toolRiskForCall(event.toolName, []);
  return raiseApproval(event, context, policy, {
    risk,
    reason: `approval required (${risk} risk, legacy ask)`,
  });
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

/** The session identity, UI availability and stop channel the injection handler reads. */
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
  /**
   * The pinned `ExtensionContext.hasUI`: false in a delegate session — `task`
   * and `eval` subagents initialize their extension runner with the runtime's
   * no-op UI context (`task/executor.ts` `extensionRunner.initialize(actions,
   * contextActions)` with no `uiContext`), while the rpc-ui parent session
   * passes its real UI context. It is how a mandatory-channel refusal tells
   * the interactive session (refuse) from a delegate (zero-injection skip).
   */
  hasUI?: boolean | (() => boolean);
  /** The context's UI surface; `notify` carries the structured refusal. */
  ui?: { notify?: (message: string, type?: "info" | "warning" | "error") => void } | null;
};

/** Why a `before_agent_start` turn was refused, carried into the notify. */
export type StartRefusalVerdict = {
  code: OmpStartRefusalCode;
  reason: string;
  sessionId: string | null;
};

/** The gate's verdict for one `before_agent_start`. */
export type BeforeAgentStartDecision =
  | { kind: "inject"; state: DesktopCapabilityState; systemPrompt: string[] }
  | { kind: "skip" }
  | ({ kind: "refuse" } & StartRefusalVerdict);

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
 *   - a valid file owned by another native identity (a delegate session) or,
 *     without the mandatory marker, an absent file → `skip`: nothing is
 *     injected and no tool set is touched (PI's delegates never receive
 *     project memory, skills or mode blocks either);
 *   - a file that claims this session but fails validation → `refuse` (this
 *     was already true without the mandatory channel: continuing would
 *     silently run a Plan/Goal intent as an unclamped Agent turn);
 *   - with the mandatory channel enabled (`OMP_DESKTOP_STATE_REQUIRED=1` at
 *     spawn) and an interactive context (`hasUI` not false): every read that
 *     is not `owned` refuses — deleted, truncated, oversized, identity-less,
 *     foreign and out-of-schema states alike. The channel was enabled by the
 *     launcher for this run, so "cannot read the state" is an anomaly, not
 *     "the channel is off".
 */
export function beforeAgentStartPolicy(
  event: BeforeAgentStartEventSlice,
  context: BeforeAgentStartContextSlice,
  statePath: string | undefined | null,
  now: number,
  options: { required?: boolean } = {},
): BeforeAgentStartDecision {
  let sessionId: string | undefined;
  try {
    sessionId = context.sessionManager?.getSessionId?.();
  } catch {
    sessionId = undefined;
  }
  const read = readDesktopStateForSession(statePath, now, sessionId);
  if (read.kind === "owned") {
    const systemPrompt = [...event.systemPrompt];
    const capability = desktopCapabilityPrompt(read.state);
    if (capability) systemPrompt.push(capability);
    systemPrompt.push(read.state.modeBlock);
    return { kind: "inject", state: read.state, systemPrompt };
  }
  // The mandatory channel only binds the interactive session that owns it. A
  // delegate session runs with the no-op UI context; its reads are `foreign`
  // (the parent's file) or `absent` (no attributable owner), and it keeps the
  // zero-injection skip rather than refusing the delegate's turn.
  const mandatory = options.required === true && uiAvailable(context) !== false;
  if (read.kind === "invalid") {
    return {
      kind: "refuse",
      code: "state-invalid",
      reason:
        "the desktop runtime state for this session is missing or invalid; refusing to run the turn without its mode and policy",
      sessionId: sessionId ?? read.sessionId,
    };
  }
  if (!mandatory) return { kind: "skip" };
  if (read.kind === "foreign") {
    return {
      kind: "refuse",
      code: "state-foreign",
      reason:
        "the desktop runtime state belongs to another native session; refusing to run this turn without its mode and policy",
      sessionId: sessionId ?? null,
    };
  }
  return {
    kind: "refuse",
    code: "state-missing",
    reason:
      "the desktop runtime state for this session is missing or unreadable; refusing to run the turn without its mode and policy",
    sessionId: sessionId ?? null,
  };
}

/**
 * The pinned `ExtensionContext.hasUI` as a tri-state: `false` is the one
 * affirmative answer a delegate gives. Unknown contexts (no field exposed)
 * are treated as interactive so the mandatory channel stays fail-closed.
 */
function uiAvailable(context: BeforeAgentStartContextSlice): boolean | undefined {
  const flag = context.hasUI;
  if (typeof flag === "function") {
    try {
      return flag() === true;
    } catch {
      return false;
    }
  }
  if (typeof flag === "boolean") return flag;
  return undefined;
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
export type ContractClampState = {
  applied: boolean;
  /** The live Agent selection captured before the first clamp. */
  before: string[];
  /**
   * Names the clamp observed in the live selection but removed from it while
   * the contract was applied — most importantly a host tool that
   * `set_host_tools` auto-activated after the clamp began. They are the
   * restore candidates the {@link ContractClampState.before} snapshot cannot
   * contain; at restore each one is filtered against the catalog *current at
   * that prompt*, so a tool removed or disabled while the clamp was live is
   * never revived.
   */
  removed: string[];
};

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
    const catalog = new Set(state.hostTools.map((tool) => tool.name));
    const restore: string[] = [];
    for (const name of [...clamp.before, ...clamp.removed, ...active]) {
      if (restore.includes(name)) continue;
      // A catalog-managed name (declared plugin/user-MCP tool) is restored
      // only while the catalog current at this prompt still declares it; a
      // native name only when the pre-clamp Agent selection had it. Nothing
      // is invented and nothing disabled is revived.
      const managed = catalog.has(name) || name.startsWith("plugin_") || name.startsWith("mcp_");
      if (managed ? catalog.has(name) : clamp.before.includes(name)) restore.push(name);
    }
    clamp.applied = false;
    clamp.before = [];
    clamp.removed = [];
    await api.setActiveTools(restore);
    return { ok: true, changed: true, active: restore };
  }
  if (typeof api.getActiveTools !== "function" || typeof api.setActiveTools !== "function") {
    return { ok: false, reason: "the runtime exposes no tool-selection API to enforce the contract catalog" };
  }
  const active = api.getActiveTools();
  if (!clamp.applied) {
    clamp.before = [...active];
    clamp.removed = [];
    clamp.applied = true;
  }
  const allowed = contractActiveToolNames(state, active);
  // Remember everything the contract removes from the live selection — that
  // is the only place a newly registered, auto-activated host tool is still
  // observable after the clamp has hidden it.
  for (const name of active) {
    if (!allowed.includes(name) && !clamp.before.includes(name) && !clamp.removed.includes(name)) {
      clamp.removed.push(name);
    }
  }
  if (active.length === allowed.length && active.every((name, index) => name === allowed[index])) {
    return { ok: true, changed: false, active };
  }
  await api.setActiveTools(allowed);
  return { ok: true, changed: true, active: allowed };
}

/**
 * The last validated policy snapshot for the interactive session this runtime
 * process serves (M5/T20-C).
 *
 * Module-level, not per-registration: a delegate session (`task`/`eval`
 * subagent) builds its own extension runner in the same process and
 * re-invokes this factory, and its `tool_call` handler must see the owning
 * session's policy — a per-runner closure would answer "unavailable" for
 * every delegated call. Written only from an `owned` read (or the gate's own
 * `before_agent_start` injection) and stamped with the state file's own
 * `writtenAt`, so the delegate fallback can never outlive the state age bound
 * and a later admitted turn always overwrites an earlier one.
 */
let policyCache: { state: DesktopCapabilityState } | null = null;

export default function ompDesktopGate(pi: ExtensionAPI): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const gated = parseGatedTools(env?.OMP_DESKTOP_GATE_TOOLS);
  const mode = (env?.OMP_DESKTOP_GATE_MODE ?? "ask").trim() as "ask" | "deny" | "allow";
  const timeoutMs = Number(env?.OMP_DESKTOP_GATE_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const sessionAllowed = new Set<string>();
  const clamp: ContractClampState = { applied: false, before: [], removed: [] };
  let refusalSequence = 0;

  /**
   * The turn token installed by the runner's fence for the admitted turn.
   *
   * It is process memory, not a file: a state file that is deleted, truncated
   * or replaced can never change it, and a refusal always echoes the token of
   * the turn the runner most recently armed. `null` until the first handshake,
   * which a conforming runner always performs before submitting a prompt.
   */
  let turnToken: string | null = null;

  /**
   * The desktop's internal turn-boundary command.
   *
   * Registered first so it exists before the runner ever queries the available
   * commands. The runtime's own command dispatch consumes it before any
   * provider loop starts (`#tryExecuteExtensionCommand`), so the handshake
   * never reaches the provider, the transcript or the tool catalogue. A
   * malformed argument is ignored without an acknowledgment — the runner then
   * refuses the prompt before submitting it, which is the fail-closed answer.
   */
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand(OMP_TURN_COMMAND, {
      description: "internal desktop turn boundary (reserved; not a user command)",
      handler: (args, context) => {
        const token = typeof args === "string" ? args.trim() : "";
        if (!isTurnToken(token)) {
          pi.logger?.warn?.("the desktop turn-boundary command received a malformed token");
          return;
        }
        turnToken = token;
        try {
          context.ui?.notify?.(encodeTurnAck(token), "info");
        } catch (error) {
          pi.logger?.warn?.("the desktop gate could not acknowledge the turn boundary", String(error));
        }
      },
    });
  } else {
    pi.logger?.warn?.(
      "the runtime exposes no extension command API; the desktop turn fence cannot be armed",
    );
  }

  /**
   * Refuse one agent start: the runtime's own abort path *and* the structured
   * notify the desktop runner consumes.
   *
   * `ctx.abort()` is what keeps the provider request from being delivered, but
   * the pinned runtime emits no terminal agent event for a turn aborted in
   * `before_agent_start` — so the runner would keep reporting the generation
   * as running. The `notify` extension-UI request is the runtime's own formal
   * output channel; its message carries the versioned refusal descriptor
   * (`session/start-refusal.ts`) that lets the runner close exactly the
   * session and generation it is starting. Delivery first (the abort path has
   * its own logging), then the abort.
   */
  const refuseStart = (context: BeforeAgentStartContextSlice, decision: StartRefusalVerdict): void => {
    const at = Date.now();
    const refusal: OmpStartRefusal = {
      v: OMP_START_REFUSAL_VERSION,
      kind: OMP_START_REFUSAL_KIND,
      sessionId: decision.sessionId,
      turnToken,
      code: decision.code,
      reason: decision.reason,
      refusalId: `omp-refusal-${at}-${refusalSequence++}`,
      at,
    };
    if (typeof context.ui?.notify === "function") {
      try {
        context.ui.notify(encodeStartRefusal(refusal), "error");
      } catch (error) {
        pi.logger?.warn?.("desktop gate could not deliver the start refusal", String(error));
      }
    } else {
      pi.logger?.warn?.("desktop gate refused an agent start but the context exposes no notify", decision.reason);
    }
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
    pi.logger?.warn?.("desktop gate refused an agent start but the runtime exposes no abort", decision.reason);
  };

  /**
   * Decide one call from the run-scoped state (M5/T20-C). The owning session
   * reads its own file; a delegate (no UI) falls back to the process-wide
   * snapshot of the owning session — PI's host decides subagent calls under
   * the parent's durable policy — while the mandatory channel with no usable
   * policy blocks every call.
   */
  pi.on("tool_call", async (event, context) => {
    const now = Date.now();
    const required = isDesktopStateRequired(env?.OMP_DESKTOP_STATE_REQUIRED);
    let snapshot: ToolCallPolicySnapshot | undefined;
    let policyUnavailable = false;
    try {
      const read = readDesktopStateForSession(env?.OMP_DESKTOP_STATE, now, sessionIdOf(context));
      if (read.kind === "owned") {
        policyCache = { state: read.state };
        snapshot = read.state;
      } else if (read.kind === "invalid") {
        // The state claims this session but fails validation: its policy is
        // unknown, and "unknown" must never become Agent by default.
        policyUnavailable = required;
      } else if (required) {
        if (hasUi(context)) {
          policyUnavailable = true;
        } else {
          const cached =
            policyCache && now - policyCache.state.writtenAt <= MAX_DESKTOP_STATE_AGE_MS
              ? policyCache.state
              : undefined;
          if (cached) snapshot = cached;
          else policyUnavailable = true;
        }
      }
    } catch {
      policyUnavailable = required;
    }
    const verdict = await decideToolCall(event, context, {
      gated,
      mode: mode === "deny" || mode === "allow" ? mode : "ask",
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      sessionAllowed,
      ...(snapshot ? { snapshot } : {}),
      ...(policyUnavailable ? { policyUnavailable: true } : {}),
    });
    if (!verdict.block) return undefined;
    return { block: true, reason: verdict.reason ?? "denied" };
  });

  // Desktop skills, project memory and the mode block enter the provider-visible
  // system prompt here, and nowhere else; the mode's tool contract is clamped
  // in the same handler, before the runtime commits the start. A failed read
  // injects nothing (a delegate session) or refuses the turn (the owner's
  // state is invalid, or — with the mandatory marker — missing/unreadable);
  // the handler never throws into the agent start.
  pi.on("before_agent_start", async (event, context) => {
    const statePath = env?.OMP_DESKTOP_STATE;
    try {
      const decision = beforeAgentStartPolicy(event, context, statePath, Date.now(), {
        required: isDesktopStateRequired(env?.OMP_DESKTOP_STATE_REQUIRED),
      });
      if (decision.kind === "refuse") {
        refuseStart(context, decision);
        return undefined;
      }
      if (decision.kind === "skip") return undefined;
      // The same owned snapshot the prompt was admitted under becomes the
      // fallback policy for this process's delegate sessions (M5/T20-C).
      policyCache = { state: decision.state };
      const clamped = await applyContractToolClamp(pi, clamp, decision.state);
      if (!clamped.ok) {
        refuseStart(context, {
          code: "clamp-unavailable",
          reason: clamped.reason,
          sessionId: context.sessionManager?.getSessionId?.() ?? null,
        });
        return undefined;
      }
      return { systemPrompt: decision.systemPrompt };
    } catch (error) {
      // The handler must not silently degrade: an unexpected failure while a
      // state file is owned by this session refuses the turn, and otherwise
      // falls back to "no injection" (the native prompt ships untouched).
      try {
        const read = readDesktopStateForSession(statePath, Date.now(), context.sessionManager?.getSessionId?.());
        if (read.kind === "owned" || read.kind === "invalid") {
          refuseStart(context, {
            code: "gate-error",
            reason: `desktop gate failed while applying the runtime state: ${String(error)}`,
            sessionId: context.sessionManager?.getSessionId?.() ?? null,
          });
        }
      } catch {
        // The probe itself failed; nothing attributable to refuse.
      }
      return undefined;
    }
  });
}
