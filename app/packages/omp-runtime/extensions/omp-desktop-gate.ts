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
 * Which policy a call is decided with (M5/T20-C review repairs):
 *
 *   - The **admitted turn** is the one and only policy owner. It is installed
 *     by the fence — the desktop's admission payload for the exact turn token
 *     (`turn-admission.ts`) — or, for a host that drives the gate without a
 *     payload, by the first validated `before_agent_start` read of a fenced
 *     turn. It is armed by `agent_start`, replaced by the next fence, and
 *     retired on a terminal `agent_end` or a start refusal.
 *   - The owning session's own calls and its **delegates** (`hasUI=false`)
 *     decide from that immutable snapshot. A delegate is *bound* to the exact
 *     admission record it started under — at its own `session_start`,
 *     `before_agent_start` or `agent_start` — and only while that record is
 *     still the live, started admission; a delegate that was never observed,
 *     one whose public session header shows it predates the admission, or one
 *     bound to a retired/replaced admission is refused rather than lent the
 *     live turn's policy (`bindDelegate`). The mutable run-scoped file is
 *     never re-read for policy, so a tool body that rewrites it mid-turn can
 *     neither relax the permission mode nor swap the risk/catalog/safeActions
 *     table.
 *   - A record whose turn never started, a foreign interactive session, an
 *     unbound delegate, and (with the mandatory channel on) a process with no
 *     record at all fail closed. A fixture that never enabled the channel
 *     keeps the legacy disk-driven behavior.
 *
 * When a policy snapshot is available, calls are decided with PI's
 * execution-time order (M5/T20-C, §1.3.1): contract modes hard-deny every tool
 * outside PI's allowlist (plus declared plan-safe plugin tools) before risk,
 * `auto`, grants, external paths or this gate's legacy fixture switch can
 * matter; explicit external paths allow under `auto`/grant and ask otherwise;
 * Low risk allows; `auto` allows; `accept-edits` auto-accepts only Write/Edit;
 * a session grant allows; everything else asks. For an owned admission the
 * legacy `OMP_DESKTOP_GATE_MODE` switch is ignored entirely (it may not allow
 * or deny outside that order), and `OMP_DESKTOP_GATE_TOOLS` may only add
 * native names to the product's gated set, never shrink it.
 *
 * Environment (set by the desktop when it starts the runtime):
 *   - `OMP_DESKTOP_GATE_TOOLS` — comma-separated native tool names added to
 *     the product's default gated set (below) for the legacy, un-admitted
 *     path; for an admitted turn the effective set is the default plus these
 *     names, so the switch can only widen the policy. Desktop host tools
 *     (`plugin_*`, `mcp_*`, M5/T19-B) are gated unconditionally and can only
 *     be opted out through `OMP_DESKTOP_GATE_MODE` — a host tool is a
 *     desktop-side capability and must never execute without the desktop's
 *     own approval first.
 *   - `OMP_DESKTOP_GATE_TIMEOUT_MS` — dialog deadline (default 120000).
 *   - `OMP_DESKTOP_GATE_MODE` — `ask` (default), `deny` (block everything
 *     gated without asking: unattended runs), or `allow`. A fixture-only
 *     switch: the production launcher never writes it, it is subordinate to
 *     the contract hard deny, and it is ignored entirely for an owned
 *     admission (M5/T20-C review repair) — `allow` can neither resurrect a
 *     contract-denied tool nor approve around the admitted mode.
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
 * (`/<OMP_TURN_COMMAND> <token> [<encoded admission>]`, see
 * `session/turn-fence.ts`). The runner invokes it through the formal RPC
 * `prompt` path before every admitted turn; it is consumed locally before any
 * provider request, installs the turn's admission (when the handshake carries
 * one) and acknowledges itself through `notify` with the admission's digest,
 * and its token is echoed by every start refusal so a
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
  OMP_TURN_COMMAND,
  turnCommandArgs,
} from "../src/session/turn-fence.ts";
import {
  admissionDigest,
  decodeTurnAdmission,
  type OmpTurnAdmission,
} from "../src/session/turn-admission.ts";
import {
  decodeModeTransitionDetails,
  enterKindForToolName,
  OMP_ENTER_TOOL_NAMES,
  type OmpModeTransition,
  type OmpModeTransitionKind,
} from "../src/session/mode-transition.ts";
import {
  encodeTurnFailure,
  OMP_TURN_FAILURE_KIND,
  OMP_TURN_FAILURE_VERSION,
  type OmpTurnFailure,
  type OmpTurnFailureCode,
} from "../src/session/turn-failure.ts";
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
 * The submit tool each contract mode owns, exactly PI's `SUBMIT_TOOL_NAMES`
 * (`agent-runtime/src/runtime.ts`): Plan mode exposes `SubmitPlan` only, Goal
 * mode `SubmitGoal` only. The other kind's submit tool is contract-denied, so
 * a wrong-kind submission is refused before it can reach the host's own
 * durable-mode check.
 */
export const SUBMIT_TOOL_BY_MODE: Partial<Record<DesktopRuntimeMode, string>> = {
  plan: "SubmitPlan",
  goal: "SubmitGoal",
};

/**
 * True when a contract mode (Plan/Goal) may execute this tool: the mode's own
 * submit tool, a PI-allowed native name, or a plugin tool whose forwarded
 * declaration carries a non-empty `planSafeActions` list (PI ADR 0211). The
 * per-action restriction of such a plugin tool is enforced at execution by the
 * PI plugin-runtime guard with the turn's real mode (M5/T20-C). User MCP tools
 * and plugin tools without a declaration are never contract-allowed, and the
 * *other* kind's submit tool is denied like any unknown name. Without a mode
 * the submit tools are not granted — a caller that does not name the contract
 * cannot admit one.
 */
export function contractAllowsTool(
  toolName: string,
  hostTools: readonly DesktopHostToolPolicy[],
  mode?: DesktopRuntimeMode,
): boolean {
  if (mode !== undefined && SUBMIT_TOOL_BY_MODE[mode] === toolName) return true;
  if (CONTRACT_MODE_ALLOWED[toolName.toLowerCase()] === true) return true;
  const declared = hostTools.find((tool) => tool.name === toolName);
  return (
    declared !== undefined && declared.origin === "plugin" && declared.planSafeActions.length > 0
  );
}

/** The PI rejection code and message for one contract-denied call. */
function contractDenyReason(toolName: string, mode: DesktopRuntimeMode): string {
  const name = toolName.toLowerCase();
  if (name === "submitplan" || name === "submitgoal") {
    return `PLAN_KIND_MISMATCH: ${toolName} is not available in ${mode} mode`;
  }
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

export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

/**
 * The settled-result slice the `tool_result` handler reads (M5/T20-D): the
 * call identity, the model-visible content, the structured `details` the
 * desktop adapter attached and the error flag the wrapper computed. The
 * handler leaves the result untouched (returns `undefined`).
 */
export interface ToolResultEventSlice {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: unknown;
  details: unknown;
  isError: boolean;
}

/**
 * The public session facts the ownership decision reads. All four members are
 * part of the pinned runtime's public `ReadonlySessionManager` pick
 * (`getSessionId` / `getCwd` / `getSessionFile` / `getHeader`); a host that
 * exposes none of the file members simply provides no parentage evidence, and
 * the binding falls back to its lifecycle rules.
 */
type SessionManagerFacts = {
  getSessionId?: () => string;
  getCwd?: () => string;
  getSessionFile?: () => string | undefined;
  getHeader?: () => unknown;
};

interface ToolCallContext {
  ui?: UIContext;
  cwd?: string;
  sessionManager?: SessionManagerFacts;
  hasUI?: boolean | (() => boolean);
  /**
   * The runtime's abort channel (`ExtensionContext.abort`), available on the
   * `tool_call`/`tool_result` and lifecycle contexts the pinned runtime builds.
   * The gate uses it to stop a turn whose mode transition could not be applied
   * consistently (M5/T20-D); a context without it can refuse but never abort,
   * which the fail-closed paths report rather than hide.
   */
  abort?: () => void;
}

/**
 * The UI surface a lifecycle context can carry: the interactive one, the
 * notify-only slice `before_agent_start` exposes, or none at all.
 */
type LifecycleUiSlice =
  | UIContext
  | { notify?: (message: string, type?: "info" | "warning" | "error") => void }
  | null;

/**
 * A context a delegate's own lifecycle event (or the turn-boundary command)
 * carries. Identical to {@link ToolCallContext} apart from tolerating the
 * `before_agent_start` slice's `null` session manager and notify-only UI.
 */
type DelegateLifecycleContext = {
  ui?: LifecycleUiSlice;
  cwd?: string;
  sessionManager?: SessionManagerFacts | null;
  hasUI?: boolean | (() => boolean);
};

export interface ExtensionAPI {
  on(event: "tool_call", handler: (event: ToolCallEvent, ctx: ToolCallContext) => unknown): void;
  /**
   * A session's own start, emitted by the pinned runtime once the session's
   * extension runner is initialized (`agent-session`/`task/executor.ts`
   * `extensionRunner.emit({ type: "session_start" })`). A delegate session
   * (`hasUI=false`) is bound to its owning admission here — its creation is
   * the earliest legitimate ownership signal the public surface offers.
   */
  on(event: "session_start", handler: (event: { type: "session_start" }, ctx: DelegateLifecycleContext) => unknown): void;
  on(
    event: "before_agent_start",
    handler: (
      event: BeforeAgentStartEventSlice,
      ctx: BeforeAgentStartContextSlice,
    ) => { systemPrompt: string[] } | undefined | Promise<{ systemPrompt: string[] } | undefined>,
  ): void;
  /**
   * The runtime's agent lifecycle notifications (M5/T20-C review repair):
   * `agent_start` arms the admitted turn (a policy whose turn never actually
   * started decides nothing), and a terminal `agent_end` retires it so a late
   * callback cannot borrow a finished turn's policy. A scheduled continuation
   * (`willContinue`) keeps the admission.
   */
  on(event: "agent_start", handler: (event: { type: "agent_start" }, ctx: ToolCallContext) => unknown): void;
  on(
    event: "agent_end",
    handler: (event: { type: "agent_end"; willContinue?: boolean }, ctx: ToolCallContext) => unknown,
  ): void;
  /**
   * A settled tool result, emitted by the runtime's tool wrapper for every
   * executed call (M5/T20-D). The handler is awaited before the result reaches
   * the agent loop, so it is the trusted place to apply a host-confirmed mode
   * transition carried on the result's `details` — after the tool ran, before
   * the next provider request.
   */
  on(event: "tool_result", handler: (event: ToolResultEventSlice, ctx: ToolCallContext) => unknown): void;
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
  /**
   * Replace the live per-turn system prompt (the fork's
   * `ExtensionAPI.setTurnSystemPrompt`, patched in at level `.5`). The host
   * and the runtime report its absence instead of silently keeping the old
   * prompt, which is what the transition's fail-closed path relies on.
   */
  setTurnSystemPrompt?: (prompt: string[]) => Promise<void> | void;
  logger?: { warn?(message: string, meta?: unknown): void; info?(message: string, meta?: unknown): void };
}

/**
 * The extension-command context the runtime's `createCommandContext()` hands a
 * registered command: the same session-bearing context the lifecycle events
 * carry, which is why the turn-boundary handler can read the owning session's
 * file for the admission.
 */
type BeginAgentStartContextSlice = DelegateLifecycleContext;

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

function sessionIdOf(context: DelegateLifecycleContext): string | undefined {
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

function hasUi(context: DelegateLifecycleContext): boolean {
  const flag = context.hasUI;
  if (typeof flag === "function") {
    try {
      return flag() === true;
    } catch {
      return false;
    }
  }
  if (typeof flag === "boolean") return flag;
  const ui = context.ui;
  return ui !== null && ui !== undefined && "select" in ui && typeof ui.select === "function";
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
    /**
     * True when the snapshot came from the admitted turn (the fence payload
     * or the first validated read of a fenced turn). An owned snapshot is the
     * product's policy: the legacy `OMP_DESKTOP_GATE_MODE` fixture switch,
     * which could otherwise allow or deny outside PI's decision order, is
     * ignored for it.
     */
    owned?: boolean;
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
    if (contract && !contractAllowsTool(event.toolName, snapshot.hostTools, snapshot.mode)) {
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
    // The legacy fixture switch stays subordinate to the contract deny above,
    // and never applies to an owned admission: an ambient switch may not
    // allow or deny around the policy the desktop session admitted.
    if (!policy.owned) {
      if (policy.mode === "allow") return { block: false, route: "mode-allow" };
      if (policy.mode === "deny") {
        return { block: true, reason: "tool calls are denied in this run", route: "mode-deny" };
      }
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
  | {
      kind: "inject";
      state: DesktopCapabilityState;
      systemPrompt: string[];
      /**
       * The capability block (skills/memory) that was appended, or `null` when
       * none was. Exposed so the live admission can cache the exact prompt
       * parts a later mid-turn transition must preserve (M5/T20-D): base stays
       * the runtime's own, the capability block appears once, and only the mode
       * block changes.
       */
      capability: string | null;
    }
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
    return { kind: "inject", state: read.state, systemPrompt, capability: capability ?? null };
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
  state: Pick<DesktopCapabilityState, "mode" | "hostTools">,
  activeNames: readonly string[],
): string[] {
  const allowed = new Set<string>(CONTRACT_MODE_NATIVE_TOOLS);
  // The mode's own submit tool rides the contract catalog exactly like PI's
  // `rebuildToolCatalog` adds `SubmitPlan`/`SubmitGoal`; the other kind's name
  // stays out.
  const submitTool = state.mode === "plan" || state.mode === "goal" ? SUBMIT_TOOL_BY_MODE[state.mode] : undefined;
  if (submitTool !== undefined) allowed.add(submitTool);
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
 * One admitted turn's immutable policy ownership (M5/T20-C review repair).
 *
 * Exactly one record is live per runtime process, because a process serves
 * exactly one desktop session. It is installed by the authenticated turn
 * fence — the desktop's admission payload from `turn-admission.ts` — or, for
 * a host that drives the gate without a payload, by the first validated
 * `before_agent_start` read of the run-scoped state. Every `tool_call`
 * afterwards decides from this record, never from the mutable state file, so a
 * tool body that rewrites the file mid-turn can neither relax the policy nor
 * change the risk/catalog/safeActions the decision uses.
 *
 * Ownership rules:
 *   - `started` is set by `agent_start` for the record's own native session:
 *     a fence whose turn never actually started (a handshake whose prompt was
 *     stopped or refused before dispatch) decides nothing.
 *   - the owning session's calls decide under the record; a *foreign*
 *     interactive session is refused rather than lent another session's
 *     policy.
 *   - a delegate (`hasUI=false`) decides under the record only when it was
 *     explicitly bound to it at its own lifecycle start (`bindDelegate`):
 *     a child that started under this record keeps this association, and once
 *     the record is retired or replaced the child is refused — it never
 *     inherits a newer admission. A nested delegate must reach the owning
 *     session file through intermediates that are themselves bound to this
 *     very record; an ancestry hop owned by a retired/other admission, or
 *     never attributed, fails closed (third review repair).
 *   - the record is replaced wholesale by the next fence and cleared on
 *     terminal `agent_end` (unless the runtime scheduled a continuation) and
 *     on a start refusal, so a late callback can never borrow an earlier
 *     turn's policy.
 *
 * Module-level, not per-registration: a delegate session (`task`/`eval`
 * subagent) builds its own extension runner in the same process and
 * re-invokes this factory, and its `tool_call` handler must see the owning
 * session's record — a per-runner closure would answer "unavailable" for
 * every delegated call.
 */
type AdmittedTurn = {
  /** The fence token the admission was installed for (null: no fence armed). */
  token: string | null;
  /** The native session the admission belongs to. */
  nativeSessionId: string;
  snapshot: ToolCallPolicySnapshot;
  /** Deliberate scoped grants, seeded from the desktop and extended in-turn. */
  grants: Set<string>;
  /** `fence`: desktop payload; `disk`: first validated state read of the turn. */
  source: "fence" | "disk";
  /** True once `agent_start` fired for the owning session. */
  started: boolean;
  /** Wall clock at installation: a delegate session created before this cannot be attributed to it. */
  armedAt: number;
  /**
   * The owning session's file as the public surface reported it when the
   * admission was armed (`ReadonlySessionManager.getSessionFile`), or
   * undefined when the surface exposes none. A delegate's declared parentage
   * chain is resolved against this value.
   */
  ownerSessionFile: string | undefined;
  /**
   * The mid-turn contract mode this record was moved into by a host-confirmed
   * `EnterPlanMode`/`EnterGoalMode` (M5/T20-D), or undefined while the record
   * still carries its prompt-time mode. A transitioned record is replaced by a
   * *new* record (same token, new snapshot) and the previous one is retired
   * with its delegate bindings, so a delegate that started under the
   * prompt-time mode can never decide under the transitioned policy. At most
   * one transition per record: the mode is Agent-only and the transitioned
   * catalogue no longer advertises either Enter tool.
   */
  transitioned?: OmpModeTransitionKind;
};

/**
 * The prompt parts the gate injected for the live turn: the runtime's own base
 * parts (never re-derived), the capability block (skills/memory) when one was
 * injected, and the current mode block. A mid-turn transition rebuilds the
 * live prompt from these parts — base and capability stay byte-identical and
 * appear exactly once each, and only the last block (the mode block) changes —
 * instead of reading anything mutable.
 */
let injectedPromptParts: { base: string[]; capability: string | null; modeBlock: string } | null = null;

/** Monotonic id for structured turn-failure descriptors (diagnostics only). */
let turnFailureSequence = 0;

let admittedTurn: AdmittedTurn | null = null;

/**
 * Delegate session id → the exact admission record it started under
 * (M5/T20-C second review repair).
 *
 * A delegate's calls are decided by the *record it was bound to*, referenced
 * by identity — never by whatever admission happens to be module-global when
 * the call arrives. A binding is written once, at the delegate's first
 * legitimate lifecycle event while its owning admission is live and started,
 * and is never re-pointed: once that record is retired (a terminal
 * `agent_end`, a start refusal) or replaced by the next fence, the delegate
 * fails closed even while a newer admission is live.
 */
const delegateBindings = new Map<string, AdmittedTurn>();

/**
 * One observed delegate session file → the parent file its header declares
 * (`ReadonlySessionManager.getHeader().parentSession`) and the exact admission
 * record the session was bound to.
 *
 * `admission` is `null` while the session is observed but not attributed: a
 * delayed start, a chain that did not resolve, or a binding retired with its
 * admission. The recorded identity is what lets a nested delegate (a child of
 * a child) resolve a chain in which **every** intermediate hop belongs to the
 * very admission record the new delegate is being bound to — a fresh
 * descendant of a retired child can never bridge into the live turn
 * (M5/T20-C third review repair).
 *
 * Keyed by the file the public surface reports, because that is how a child's
 * header names its parent. A link is written once — `parentSession` is fixed
 * at session creation — and a later lifecycle event of the same session never
 * re-attributes it.
 */
type DelegateLineageLink = {
  parentFile: string;
  admission: AdmittedTurn | null;
};

const delegateLineage = new Map<string, DelegateLineageLink>();

/**
 * Delegate sessions that must never decide under any admission in this
 * process, whatever the live turn is. A session lands here when
 *
 *   - its public header showed it was created before the admission it was
 *     first observed under was armed (a delayed start, a parked/revived
 *     worker): it must not be casually associated with a newer turn; or
 *   - its binding was retired with its admission (the next fence, a start
 *     refusal): a child that started under A keeps A's association and is
 *     refused from then on instead of inheriting B.
 */
const refusedDelegates = new Set<string>();

/**
 * Retire every active delegate binding with the admission it belongs to:
 * each bound session is remembered as refused, so the same session can never
 * be re-pointed at the admission that replaces it.
 */
function retireDelegateBindings(): void {
  for (const sessionId of delegateBindings.keys()) refusedDelegates.add(sessionId);
  delegateBindings.clear();
}

/**
 * Retire the live admission wholesale: the record, the cached prompt parts it
 * produced, and every delegate binding that referenced it. Called wherever the
 * record ends — the next fence, a refused start, a terminal turn, a failed
 * transition — so nothing can borrow a finished or superseded policy.
 */
function retireAdmittedTurn(): void {
  admittedTurn = null;
  injectedPromptParts = null;
  retireDelegateBindings();
}

/**
 * Why a host-confirmed transition record cannot move the live admission, or
 * `null` when it may. Pure over the record and the live facts, so the gate
 * handler and its tests cannot disagree about the ownership rules.
 *
 * The checks are the runtime-side half of the authorisation. The other half is
 * the host's own `plans.enter` validator: it requires the durable mode to be
 * Agent, a live durable turn, no queued/running execution and a CAS mode
 * write. Together they bind the transition to this native session, this live
 * generation (the fence token the runtime installed for the very run emitting
 * the result), this exact tool call, and the Agent -> contract direction.
 */
export function modeTransitionProblem(
  transition: OmpModeTransition,
  live: {
    /** The native session the live admission belongs to, or null without a record. */
    nativeSessionId: string | null;
    /** The session the `tool_result` event was emitted for. */
    firingSessionId: string | undefined;
    /** The token the runner armed for the live generation. */
    turnToken: string | null;
    /** The live admission record's own facts. */
    record: { token: string | null; started: boolean; mode: DesktopRuntimeMode; transitioned?: OmpModeTransitionKind } | null;
    /** The tool name the result was emitted for. */
    toolName: string;
    /** The tool call id the result was emitted for. */
    toolCallId: string;
  },
): string | null {
  const record = live.record;
  if (record === null || live.nativeSessionId === null) return "no live admission exists for this process";
  if (live.turnToken === null) return "no turn fence is armed";
  if (record.token === null || record.token !== live.turnToken) return "the admission does not belong to the live generation";
  if (!record.started) return "the admitted turn has not started";
  if (record.transitioned !== undefined) return `the turn already transitioned to ${record.transitioned}`;
  if (live.firingSessionId === undefined || live.firingSessionId !== live.nativeSessionId) {
    return "the result was not emitted by the admitted session";
  }
  if (transition.sessionId !== live.nativeSessionId) return "the record names a different native session";
  if (live.toolName !== OMP_ENTER_TOOL_NAMES[transition.kind]) {
    return `the ${transition.kind} transition is not the tool that produced this result`;
  }
  if (transition.toolCallId !== live.toolCallId) return "the record does not name this tool call";
  if (record.mode !== "agent" || transition.expectedMode !== "agent") {
    return `the turn is in ${record.mode} mode, not agent`;
  }
  return null;
}

/**
 * The last validated policy snapshot for the *legacy* (unfenced, payload-less)
 * fixture path, where a delegate's call falls back to the owning session's
 * freshest read. Produced-path decisions never read this: they use
 * {@link admittedTurn}. Age-bounded for the fixture path exactly as before.
 */
let policyCache: { state: DesktopCapabilityState } | null = null;

/**
 * The public session facts a delegate ownership decision reads, each validated
 * at the boundary: the pinned `ReadonlySessionManager` returns a real header
 * object, but this module only trusts primitives it checked itself.
 */
type DelegateSessionFacts = {
  file: string | undefined;
  parentFile: string | undefined;
  createdAt: number | undefined;
};

function delegateSessionFactsOf(context: DelegateLifecycleContext): DelegateSessionFacts {
  let file: string | undefined;
  try {
    const reported = context.sessionManager?.getSessionFile?.();
    if (typeof reported === "string" && reported.length > 0) file = reported;
  } catch {
    file = undefined;
  }
  let parentFile: string | undefined;
  let createdAt: number | undefined;
  try {
    const header = context.sessionManager?.getHeader?.();
    if (header !== null && typeof header === "object") {
      if ("parentSession" in header) {
        const parent = header.parentSession;
        if (typeof parent === "string" && parent.length > 0) parentFile = parent;
      }
      if ("timestamp" in header) {
        const timestamp = header.timestamp;
        if (typeof timestamp === "string") {
          const parsed = Date.parse(timestamp);
          if (Number.isFinite(parsed)) createdAt = parsed;
        }
      }
    }
  } catch {
    parentFile = undefined;
    createdAt = undefined;
  }
  return { file, parentFile, createdAt };
}

/**
 * Does this delegate's declared parentage reach the admission's owning session
 * file *through sessions that all belong to this very admission record*?
 *
 * `undefined` means the surface exposes no parentage to check (a fixture
 * context without a session file), `false` means it affirmatively does not
 * resolve: a parent chain that stops before the owner, one that never reaches
 * it, one with an unknown intermediate, or one whose intermediate hop was
 * bound to a different (retired or other-generation) admission record or to
 * none at all. Requiring the exact record identity at every hop — not merely
 * that some chain of recorded files arrives at the same owner file — is what
 * stops a freshly created descendant of a retired delegate from bridging into
 * the live turn (M5/T20-C third review repair).
 */
function delegateDescendsFrom(context: DelegateLifecycleContext, admission: AdmittedTurn): boolean | undefined {
  const owner = admission.ownerSessionFile;
  const parent = delegateSessionFactsOf(context).parentFile;
  if (owner === undefined || parent === undefined) return undefined;
  let current = parent;
  const seen = new Set<string>();
  for (let hops = 0; hops < 32; hops += 1) {
    if (current === owner) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    const link = delegateLineage.get(current);
    if (link === undefined) return false;
    if (link.admission !== admission) return false;
    current = link.parentFile;
  }
  return false;
}

/**
 * Bind one delegate (no-UI) session to the admission it started under
 * (M5/T20-C second review repair).
 *
 * Evaluated at the delegate's own lifecycle events — `session_start`,
 * `before_agent_start`, `agent_start` — while its owning admission is live and
 * started. It is never a moving lookup at tool-call time: the binding stores
 * the admission record itself, so a later fence can replace the live admission
 * without lending its policy to this delegate.
 *
 * Fail-closed rules:
 *   - no live, started admission: nothing to bind;
 *   - the session has no id on this surface: nothing to key a binding by;
 *   - the first binding wins (an already-bound delegate is never re-pointed);
 *   - the public header shows the session was created before the admission was
 *     armed: recorded as permanently unattributable — a delayed start must not
 *     adopt a newer turn;
 *   - a declared parentage chain that does not resolve to the admission's
 *     owning session file, or that passes through an intermediate bound to a
 *     different admission record (retired, other generation) or to none at
 *     all: not bound (M5/T20-C third review repair).
 */
function bindDelegate(context: DelegateLifecycleContext): void {
  if (hasUi(context)) return;
  const sessionId = sessionIdOf(context);
  if (sessionId === undefined) return;
  const facts = delegateSessionFactsOf(context);
  // Record the declared parentage link even when this delegate is not (yet)
  // bindable: a nested delegate's chain needs its intermediate recorded. The
  // link is written once (the header's `parentSession` is fixed at session
  // creation) and starts unattributed; the successful binding below is what
  // attributes it to an admission record, exactly once.
  let link = facts.file !== undefined ? delegateLineage.get(facts.file) : undefined;
  if (facts.file !== undefined && facts.parentFile !== undefined && link === undefined) {
    link = { parentFile: facts.parentFile, admission: null };
    delegateLineage.set(facts.file, link);
  }
  if (delegateBindings.has(sessionId) || refusedDelegates.has(sessionId)) return;
  const admitted = admittedTurn;
  if (!admitted || !admitted.started || sessionId === admitted.nativeSessionId) return;
  if (facts.createdAt !== undefined && facts.createdAt < admitted.armedAt) {
    refusedDelegates.add(sessionId);
    return;
  }
  if (delegateDescendsFrom(context, admitted) === false) return;
  // This file already belongs to a different admission record (or was never
  // attributed): never re-point it at the live one. A re-observation of an
  // already bound session returned above, so this only guards file reuse.
  if (link !== undefined && link.admission !== null && link.admission !== admitted) return;
  if (link !== undefined) link.admission = admitted;
  delegateBindings.set(sessionId, admitted);
}

export default function ompDesktopGate(pi: ExtensionAPI): void {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  const gated = parseGatedTools(env?.OMP_DESKTOP_GATE_TOOLS);
  /**
   * The owned-turn gated set: the product's default names plus any names a
   * fixture adds. The legacy `OMP_DESKTOP_GATE_TOOLS` switch may only *grow*
   * the product set — a fixture (or an ambient environment) that names a
   * smaller list, or nothing at all, can never shrink the policy the desktop
   * session admitted (M5/T20-C review repair).
   */
  const ownedGated = new Set<string>([...parseGatedTools(undefined), ...gated]);
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
   * never reaches the provider, the transcript or the tool catalogue.
   *
   * The handshake replaces the process's admitted turn wholesale: the desktop
   * payload (when present and valid) becomes the immutable policy for the new
   * token, and a token-only handshake clears any earlier admission so a new
   * turn can never borrow the previous one's policy. A malformed argument, or
   * a malformed/oversized payload, is refused without an acknowledgment — the
   * runner then refuses the prompt before submitting it, which is the
   * fail-closed answer.
   */
  if (typeof pi.registerCommand === "function") {
    pi.registerCommand(OMP_TURN_COMMAND, {
      description: "internal desktop turn boundary (reserved; not a user command)",
      handler: (args, context) => {
        const command = turnCommandArgs(args);
        if (!command) {
          pi.logger?.warn?.("the desktop turn-boundary command received a malformed argument");
          return;
        }
        // Any well-formed handshake replaces the process's record, and it is
        // cleared *before* the payload is decoded: an undecodable payload must
        // leave no admission at all (the runner refuses the prompt for the
        // missing acknowledgment, and a late call then fails closed instead of
        // borrowing the previous turn's policy).
        turnToken = command.token;
        // Any well-formed handshake replaces the process's record, and it is
        // cleared *before* the payload is decoded: an undecodable payload must
        // leave no admission at all (the runner refuses the prompt for the
        // missing acknowledgment, and a late call then fails closed instead of
        // borrowing the previous turn's policy). Every active delegate binding
        // belongs to the record retired here: its sessions are remembered as
        // refused, so they can never be re-pointed at this new admission.
        retireAdmittedTurn();
        let admission: OmpTurnAdmission | null = null;
        if (command.admission !== null) {
          admission = decodeTurnAdmission(command.admission);
          if (!admission) {
            pi.logger?.warn?.("the desktop turn-boundary command received a malformed policy admission");
            return;
          }
        }
        admittedTurn = admission
          ? {
              token: command.token,
              nativeSessionId: admission.nativeSessionId,
              snapshot: {
                mode: admission.mode,
                permissionMode: admission.permissionMode,
                hostTools: admission.hostTools,
              },
              grants: new Set(admission.grants),
              source: "fence",
              started: false,
              armedAt: Date.now(),
              // The owning session's own file, as the public surface reports it
              // at the moment the admission is installed: the reference a
              // delegate's declared parentage chain must resolve to.
              ownerSessionFile: delegateSessionFactsOf(context).file,
            }
          : null;
        try {
          context.ui?.notify?.(
            encodeTurnAck(
              command.token,
              command.admission === null ? null : admissionDigest(command.admission),
            ),
            "info",
          );
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
   *
   * `token` is the generation the refusal was *decided* under, passed in by
   * the caller — never whatever token happens to be armed when a suspended
   * handler finally gives up. A start attempt that lost its admission to a
   * successor must not refuse, retire or abort that successor (the caller
   * checks ownership before calling this at all), and this token parameter is
   * what keeps a refusal made under an older generation attributable to that
   * generation.
   */
  const refuseStart = (
    context: BeforeAgentStartContextSlice,
    decision: StartRefusalVerdict,
    token: string | null,
  ): void => {
    const at = Date.now();
    const refusal: OmpStartRefusal = {
      v: OMP_START_REFUSAL_VERSION,
      kind: OMP_START_REFUSAL_KIND,
      sessionId: decision.sessionId,
      turnToken: token,
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
    // The refused turn never started: its admission is retired here, so a
    // late callback cannot decide under a policy for a turn that was aborted.
    // The bindings that referenced it are dropped with it.
    if (admittedTurn && admittedTurn.token === token) {
      retireAdmittedTurn();
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
   * Fail one *started* turn: the runtime's own abort path *and* the structured
   * notify the desktop runner consumes (M5/T20-D).
   *
   * `ctx.abort()` stops the loop, but the plain `agent_end` it produces would
   * be read by the runner as a completed turn, misreporting a failed mode
   * transition as success. The notify carries the versioned turn-failure
   * descriptor (`session/turn-failure.ts`) so the runner closes exactly this
   * generation as failed — one terminal error envelope and an `error`
   * turn-end announcement — and the bridge settles the durable host turn as
   * failed. The admission is retired here: the turn is over, and a late
   * callback must not decide under a policy for an aborted turn.
   *
   * The descriptor names the token that was live when the failure was
   * *decided*, passed in by the caller — never whatever token happens to be
   * armed when a slow handler finally gives up. A continuation that lost its
   * admission to a successor turn must not fail, retire or abort that
   * successor (the caller checks ownership before calling this at all), and
   * this token parameter is what keeps a decision made under an older
   * generation attributable to that generation.
   */
  const failStartedTurn = (
    context: ToolCallContext,
    code: OmpTurnFailureCode,
    reason: string,
    token: string | null,
  ): void => {
    const at = Date.now();
    const failure: OmpTurnFailure = {
      v: OMP_TURN_FAILURE_VERSION,
      kind: OMP_TURN_FAILURE_KIND,
      sessionId: sessionIdOf(context) ?? null,
      turnToken: token,
      code,
      reason,
      failureId: `omp-turn-failure-${at}-${turnFailureSequence++}`,
      at,
    };
    if (typeof context.ui?.notify === "function") {
      try {
        context.ui.notify(encodeTurnFailure(failure), "error");
      } catch (error) {
        pi.logger?.warn?.("desktop gate could not deliver the turn failure", String(error));
      }
    } else {
      pi.logger?.warn?.("desktop gate failed a turn but the context exposes no notify", reason);
    }
    if (admittedTurn && admittedTurn.token === token) {
      retireAdmittedTurn();
    }
    if (typeof context.abort === "function") {
      try {
        context.abort();
        return;
      } catch (error) {
        pi.logger?.warn?.("desktop gate could not abort a failed turn", String(error));
      }
    }
    pi.logger?.warn?.("desktop gate failed a turn but the runtime exposes no abort", reason);
  };

  /**
   * Apply one host-confirmed contract-mode transition (M5/T20-D).
   *
   * The desktop adapter attaches the record to the Enter tool's settled result
   * (`session/mode-transition.ts`). This handler is the runtime-side half of
   * the authorisation: it validates the record against the live admission (the
   * owning session, the fence token of the very run that emitted the result,
   * the exact tool-call id, the Agent-only direction, single use) and then
   * moves the three pieces of live state the next provider request reads —
   * the system prompt (base and capability preserved byte-identically, only
   * the mode block replaced), the tool catalogue (the contract clamp for the
   * new mode; the new submit tool must already be registered, which the
   * desktop's mid-turn `set_host_tools` did) and the decision policy (a new
   * admission record; the previous record's delegate bindings are retired so
   * a delegate that started under the prompt-time mode can never decide under
   * the transitioned policy).
   *
   * Failure is never silently ignored:
   *
   *   - an Enter tool result that claims success without a valid record, a
   *     record that fails attribution, and a record that reports the desktop
   *     could not prepare the transition all fail the turn through
   *     {@link failStartedTurn};
   *   - a prompt replacement or clamp that throws after the host committed
   *     fails the turn the same way, so the rest of the run cannot continue as
   *     Agent under a host row that already says Plan/Goal. The durable host
   *     fact stays, and the next prompt rebuilds from it.
   *
   * An ordinary host refusal (a failed `plans.enter`: wrong mode, stale turn,
   * a pending execution) arrives as an error result *without* a record; that
   * is a correctable tool error and no transition is attempted.
   *
   * Every await in the apply path re-checks ownership (M5/T20-D review
   * repair). The admission is process-global state that a replacement fence
   * swaps wholesale, and the result handler runs concurrently with the agent
   * lifecycle: a turn can end (a terminal `agent_end`) and a successor turn be
   * armed and started while this handler is suspended in the prompt API or the
   * clamp. A continuation that no longer owns the live record must not
   * replace it with a transitioned copy, retire the successor's delegate
   * bindings, overwrite the cached prompt parts, apply the old clamp to the
   * successor's selection, emit a failure attributed to the successor's token,
   * or abort its context. Ownership is exact identity — the record object this
   * continuation installed or read, plus the token this result was validated
   * against — never a mutable-field comparison a later fence could fake.
   */
  pi.on("tool_result", async (event, context) => {
    const kind = enterKindForToolName(event.toolName);
    if (kind === null) return undefined;
    const transition = decodeModeTransitionDetails(event.details);
    if (transition === null) {
      if (event.isError !== true) {
        failStartedTurn(
          context,
          "transition-invalid",
          `${event.toolName} settled without a valid mode transition record`,
          turnToken,
        );
      }
      return undefined;
    }
    const current = admittedTurn;
    const token = turnToken;
    const problem = modeTransitionProblem(transition, {
      nativeSessionId: current?.nativeSessionId ?? null,
      firingSessionId: sessionIdOf(context),
      turnToken: token,
      record:
        current === null
          ? null
          : {
              token: current.token,
              started: current.started,
              mode: current.snapshot.mode,
              ...(current.transitioned !== undefined ? { transitioned: current.transitioned } : {}),
            },
      toolName: event.toolName,
      toolCallId: event.toolCallId,
    });
    if (problem !== null || transition.kind !== kind) {
      failStartedTurn(
        context,
        "transition-invalid",
        `${event.toolName}: ${problem ?? "the record kind does not match the tool"}`,
        token,
      );
      return undefined;
    }
    if (transition.state === "failed") {
      failStartedTurn(context, "transition-apply-failed", `${event.toolName}: ${transition.reason}`, token);
      return undefined;
    }
    const parts = injectedPromptParts;
    if (parts === null || current === null) {
      failStartedTurn(
        context,
        "transition-apply-failed",
        "the gate has no prepared system prompt to rebuild the transitioned turn",
        token,
      );
      return undefined;
    }
    /**
     * The record this continuation owns: the live record it validated against,
     * later the transitioned copy it installed. `true` once a fence, a start
     * refusal or a terminal lifecycle replaced or retired it — after which
     * this continuation may only stop touching process state.
     */
    let owned: AdmittedTurn = current;
    const lostOwnership = (): boolean => {
      if (admittedTurn === owned && turnToken === token) return false;
      pi.logger?.warn?.(
        "the desktop gate discarded a stale mode transition: its admission is no longer the live one",
      );
      return true;
    };
    try {
      if (typeof pi.setTurnSystemPrompt !== "function") {
        throw new Error("the runtime exposes no live system-prompt API");
      }
      // Base and capability stay byte-identical and exactly once each; only
      // the mode block (always last) changes.
      const prompt = [
        ...parts.base,
        ...(parts.capability === null ? [] : [parts.capability]),
        transition.modeBlock,
      ];
      await pi.setTurnSystemPrompt(prompt);
      if (lostOwnership()) return undefined;
      // Replace the record wholesale before the clamp: every later decision
      // reads the transitioned snapshot, and the previous record's delegate
      // bindings are retired with it.
      owned = {
        ...current,
        snapshot: {
          mode: transition.kind,
          permissionMode: current.snapshot.permissionMode,
          hostTools: transition.hostTools,
        },
        transitioned: transition.kind,
      };
      admittedTurn = owned;
      retireDelegateBindings();
      injectedPromptParts = { ...parts, modeBlock: transition.modeBlock };
      const clamped = await applyContractToolClamp(pi, clamp, owned.snapshot);
      if (!clamped.ok) throw new Error(clamped.reason);
      if (lostOwnership()) return undefined;
    } catch (error) {
      // A failure of this continuation is only this turn's to report while
      // this turn's record is still the live one; otherwise the successor owns
      // the process and must not be retired, failed or aborted from here.
      if (!lostOwnership()) {
        retireAdmittedTurn();
        failStartedTurn(
          context,
          "transition-apply-failed",
          `the gate could not apply the ${kind} transition: ${String(error)}`,
          token,
        );
      }
    }
    return undefined;
  });

  /**
   * Decide one call (M5/T20-C review repair).
   *
   * A live admission decides every call of its turn: the owning session's own
   * calls and its delegates (`hasUI=false`) both read the immutable snapshot
   * installed by the fence — the mutable state file is never consulted for
   * policy, so a file rewritten by a tool body mid-turn cannot relax the
   * decision. A record whose turn never started, or a foreign interactive
   * session, is refused rather than lent a policy. Without a record the
   * mandatory channel fails closed, and a fixture that never enabled it keeps
   * the legacy disk-driven behavior (including the delegate cache).
   */
  pi.on("tool_call", async (event, context) => {
    const now = Date.now();
    const required = isDesktopStateRequired(env?.OMP_DESKTOP_STATE_REQUIRED);
    let snapshot: ToolCallPolicySnapshot | undefined;
    let grants = sessionAllowed;
    let owned = false;
    let policyUnavailable = false;
    const admitted = admittedTurn;
    if (admitted) {
      const sessionId = sessionIdOf(context);
      const owner = sessionId !== undefined && sessionId === admitted.nativeSessionId;
      if (!admitted.started) {
        policyUnavailable = true;
      } else if (owner) {
        snapshot = admitted.snapshot;
        grants = admitted.grants;
        owned = true;
      } else if (!hasUi(context)) {
        // A delegate decides only under the exact admission it was bound to at
        // its own lifecycle start (`bindDelegate`). An unbound delegate — never
        // observed, or observed with header evidence that its session predates
        // this turn — and one bound to a retired or replaced admission both fail
        // closed; the live turn's policy is never lent to it.
        const binding = sessionId !== undefined ? delegateBindings.get(sessionId) : undefined;
        if (binding !== undefined && binding === admitted) {
          snapshot = admitted.snapshot;
          grants = admitted.grants;
          owned = true;
        } else {
          policyUnavailable = true;
        }
      } else {
        policyUnavailable = true;
      }
    } else if (required) {
      // The mandatory channel is on and no admission exists for this process:
      // there is no policy to decide with. The mutable file is never re-read
      // here — a turn with no admitted record must fail closed rather than
      // adopt a file that could have been rewritten (M5/T20-C review repair).
      policyUnavailable = true;
    } else {
      // Legacy fixture path (the channel was explicitly disabled): the
      // pre-repair disk read, including the delegate cache.
      try {
        const read = readDesktopStateForSession(env?.OMP_DESKTOP_STATE, now, sessionIdOf(context));
        if (read.kind === "owned") {
          policyCache = { state: read.state };
          snapshot = read.state;
        } else if (!hasUi(context)) {
          const cached =
            policyCache && now - policyCache.state.writtenAt <= MAX_DESKTOP_STATE_AGE_MS
              ? policyCache.state
              : undefined;
          if (cached) snapshot = cached;
        }
      } catch {
        // A fixture read failure on the legacy path decides with no snapshot.
      }
    }
    const verdict = await decideToolCall(event, context, {
      gated: owned ? ownedGated : gated,
      mode: mode === "deny" || mode === "allow" ? mode : "ask",
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
      sessionAllowed: grants,
      ...(owned ? { owned: true } : {}),
      ...(snapshot ? { snapshot } : {}),
      ...(policyUnavailable ? { policyUnavailable: true } : {}),
    });
    if (!verdict.block) return undefined;
    return { block: true, reason: verdict.reason ?? "denied" };
  });

  // The admitted turn's ownership window: armed by the runtime's own
  // `agent_start` for the owning native session, retired on a terminal
  // `agent_end` (a scheduled continuation keeps it). A delegate's own
  // lifecycle events name the child session, never touch the record, and are
  // where that child is bound to its owning admission (M5/T20-C second repair).
  pi.on("agent_start", (_event, context) => {
    bindDelegate(context);
    if (!admittedTurn) return;
    const sessionId = sessionIdOf(context);
    if (sessionId !== undefined && sessionId === admittedTurn.nativeSessionId) {
      admittedTurn.started = true;
    }
  });
  pi.on("agent_end", (event, context) => {
    if (!admittedTurn || event.willContinue === true) return;
    const sessionId = sessionIdOf(context);
    if (sessionId !== undefined && sessionId === admittedTurn.nativeSessionId) {
      retireAdmittedTurn();
    }
  });
  // A delegate session's own start is its earliest ownership signal: the
  // runtime emits it from the extension runner the child session builds for
  // itself, with the child's own session manager (`hasUI=false`), so that is
  // where the child is bound to the admission it started under.
  pi.on("session_start", (_event, context) => {
    bindDelegate(context);
  });

  // Desktop skills, project memory and the mode block enter the provider-visible
  // system prompt here, and nowhere else; the mode's tool contract is clamped
  // in the same handler, before the runtime commits the start. A failed read
  // injects nothing (a delegate session) or refuses the turn (the owner's
  // state is invalid, or — with the mandatory marker — missing/unreadable);
  // the handler never throws into the agent start.
  //
  // Every await in this handler re-checks ownership (M5/T20-D second review
  // repair). A start attempt can be suspended in the prompt-time clamp — the
  // transitioned continuation and the ordinary branch both call
  // `applyContractToolClamp` — while the turn ends, a successor fence replaces
  // the admission wholesale and the successor's own start caches its prompt
  // parts. A start attempt that no longer owns the live record must abstain
  // (return undefined) rather than return its injection (or borrow the
  // successor's cached prompt), overwrite the successor's cached parts, refuse
  // under the successor's token, retire its admission or abort its context.
  // Ownership is exact identity — the record object this invocation read or
  // installed, plus the token it was read under — never a mutable-field
  // comparison a later fence could fake.
  pi.on("before_agent_start", async (event, context) => {
    // A delegate's own start is a legitimate ownership signal too (and the
    // first one a fixture context without a session file exposes): bind it to
    // the live admission before the policy decision below can skip the start.
    bindDelegate(context);
    const statePath = env?.OMP_DESKTOP_STATE;
    // The generation this invocation owns, updated as soon as the record it
    // decides under is known and re-checked after every await.
    let ownedRecord: AdmittedTurn | null = admittedTurn;
    let ownedToken: string | null = turnToken;
    const lostOwnership = (): boolean => {
      if (admittedTurn === ownedRecord && turnToken === ownedToken) return false;
      pi.logger?.warn?.(
        "the desktop gate discarded a stale agent start: its admission is no longer the live one",
      );
      return true;
    };
    try {
      const decision = beforeAgentStartPolicy(event, context, statePath, Date.now(), {
        required: isDesktopStateRequired(env?.OMP_DESKTOP_STATE_REQUIRED),
      });
      if (decision.kind === "refuse") {
        refuseStart(context, decision, ownedToken);
        return undefined;
      }
      if (decision.kind === "skip") return undefined;
      const sessionId = context.sessionManager?.getSessionId?.() ?? null;
      if (admittedTurn && admittedTurn.source === "fence" && sessionId === admittedTurn.nativeSessionId) {
        // A continuation within the same live turn whose contract was already
        // moved by a host-confirmed transition (M5/T20-D). The run-scoped file
        // still describes the prompt-time mode — expected, because nothing may
        // rewrite it mid-turn — so the record, not the file, is the authority:
        // the injection is rebuilt from the cached parts with the transitioned
        // mode block and the clamp re-applied for the transitioned snapshot.
        if (
          admittedTurn.transitioned !== undefined &&
          injectedPromptParts !== null &&
          decision.state.sessionId === admittedTurn.nativeSessionId
        ) {
          // Capture the generation and the exact parts this continuation owns
          // *before* the await: afterwards the module-global record and cache
          // may already describe a successor turn, and this callback must
          // neither return the successor's cached prompt nor refuse under its
          // token.
          const continuing = admittedTurn;
          const parts = injectedPromptParts;
          ownedRecord = continuing;
          ownedToken = turnToken;
          const clampedTransitioned = await applyContractToolClamp(pi, clamp, continuing.snapshot);
          if (lostOwnership()) return undefined;
          if (!clampedTransitioned.ok) {
            refuseStart(
              context,
              {
                code: "clamp-unavailable",
                reason: clampedTransitioned.reason,
                sessionId,
              },
              ownedToken,
            );
            return undefined;
          }
          return {
            systemPrompt: [
              ...parts.base,
              ...(parts.capability === null ? [] : [parts.capability]),
              parts.modeBlock,
            ],
          };
        }
        // The desktop's payload is the policy. The file must still describe
        // the same session and the same mode/permission mode: a file modified
        // between the bridge's write and this start is a tampered channel and
        // refuses the turn rather than injecting or clamping a different
        // policy.
        if (
          decision.state.sessionId !== admittedTurn.nativeSessionId ||
          decision.state.mode !== admittedTurn.snapshot.mode ||
          decision.state.permissionMode !== admittedTurn.snapshot.permissionMode
        ) {
          refuseStart(
            context,
            {
              code: "state-mismatch",
              reason:
                "the run-scoped desktop state does not match the admitted policy (session, mode or permission mode changed after admission)",
              sessionId,
            },
            ownedToken,
          );
          return undefined;
        }
      } else if (admittedTurn && admittedTurn.source === "fence" && admittedTurn.token === turnToken) {
        // A fenced admission exists and this start is not its owning session:
        // refuse rather than adopt a different session's file as the policy.
        refuseStart(
          context,
          {
            code: "state-foreign",
            reason: `the admitted turn belongs to native session ${JSON.stringify(admittedTurn.nativeSessionId)}, not this start`,
            sessionId,
          },
          ownedToken,
        );
        return undefined;
      } else if (
        !admittedTurn ||
        admittedTurn.token !== turnToken ||
        admittedTurn.nativeSessionId !== decision.state.sessionId
      ) {
        // No payload for this turn: the first validated read of the fenced
        // turn becomes its admission, frozen for the rest of the turn. A
        // later read within the same turn (a queued batch or continuation)
        // reuses it instead of re-adopting a possibly rewritten file.
        admittedTurn = {
          token: turnToken,
          nativeSessionId: decision.state.sessionId,
          snapshot: {
            mode: decision.state.mode,
            permissionMode: decision.state.permissionMode,
            hostTools: decision.state.hostTools,
          },
          grants: new Set(),
          source: "disk",
          started: false,
          armedAt: Date.now(),
          ownerSessionFile: delegateSessionFactsOf(context).file,
        };
      }
      const admitted = admittedTurn;
      // The record this prompt-time clamp decides under; re-checked after the
      // await, because the clamp is the window in which a successor fence can
      // replace the admission and cache its own parts.
      ownedRecord = admitted;
      ownedToken = turnToken;
      const clamped = await applyContractToolClamp(pi, clamp, admitted ? admitted.snapshot : decision.state);
      if (lostOwnership()) return undefined;
      if (!clamped.ok) {
        refuseStart(
          context,
          {
            code: "clamp-unavailable",
            reason: clamped.reason,
            sessionId: context.sessionManager?.getSessionId?.() ?? null,
          },
          ownedToken,
        );
        return undefined;
      }
      // Cache the exact parts this injection produced: a host-confirmed
      // mid-turn transition rebuilds the live prompt from them, so base and
      // capability cannot be re-derived (or duplicated) by a second code path.
      injectedPromptParts = {
        base: [...event.systemPrompt],
        capability: decision.capability,
        modeBlock: decision.state.modeBlock,
      };
      return { systemPrompt: decision.systemPrompt };
    } catch (error) {
      // The handler must not silently degrade: an unexpected failure while a
      // state file is owned by this session refuses the turn, and otherwise
      // falls back to "no injection" (the native prompt ships untouched). A
      // failure of a continuation that meanwhile lost its admission to a
      // successor is only its own: it must not refuse, retire or abort that
      // successor.
      if (!lostOwnership()) {
        try {
          const read = readDesktopStateForSession(statePath, Date.now(), context.sessionManager?.getSessionId?.());
          if (read.kind === "owned" || read.kind === "invalid") {
            refuseStart(
              context,
              {
                code: "gate-error",
                reason: `desktop gate failed while applying the runtime state: ${String(error)}`,
                sessionId: context.sessionManager?.getSessionId?.() ?? null,
              },
              ownedToken,
            );
          }
        } catch {
          // The probe itself failed; nothing attributable to refuse.
        }
      }
      return undefined;
    }
  });
}
