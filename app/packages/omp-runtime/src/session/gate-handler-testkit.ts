/**
 * Test-double helpers for the gate's registered handlers (M5/T20-C review
 * repair).
 *
 * The production counterexamples drive the *real* runtime and bridge; these
 * helpers drive the same registered handlers with the real state
 * serialization and the real turn-admission codec, so the decision table,
 * the admission ownership and the fixture-switch subordination can be pinned
 * deterministically. Excluded from the package build (see `tsconfig.json`).
 */
import type { DesktopHostToolPolicy, DesktopRuntimeMode } from "../desktop-state.js";
import ompDesktopGate, { type ExtensionAPI, type ToolCallEvent } from "../../extensions/omp-desktop-gate.ts";
import { OMP_APPROVAL_OPTIONS } from "./approval-protocol.js";
import { OMP_TURN_COMMAND } from "./turn-fence.js";
import { encodeTurnAdmission, type OmpTurnAdmission } from "./turn-admission.js";

export type GateHarnessOptions = {
  /** Fixture value for `OMP_DESKTOP_GATE_TOOLS` (undefined: leave unset). */
  gated?: string;
  /** Fixture value for `OMP_DESKTOP_GATE_MODE` (undefined: leave unset). */
  mode?: string;
  /** The owning session id the contexts report (default `omp-session-1`). */
  sessionId?: string;
  /** The context's working directory (the external-path workspace root). */
  cwd?: string;
  /** The owning session file the context reports (`getSessionFile`), when a test needs the parentage check. */
  ownerFile?: string;
};

export type GateHandlerHarness = {
  /** The owning session context (interactive, same cwd). */
  context: Record<string, unknown>;
  /** A context for another interactive session. */
  foreignContext(sessionId?: string): Record<string, unknown>;
  /** A delegate context (`hasUI=false`), optionally exposing session-file facts. */
  delegateContext(sessionId?: string, facts?: GateDelegateFacts): Record<string, unknown>;
  /** Arm the fence with a token and (optionally) an admission payload. */
  arm(token: string, admission?: OmpTurnAdmission): void;
  /** Arm with raw argument text (to exercise malformed handshakes). */
  armRaw(args: string): void;
  beforeAgentStart(context?: Record<string, unknown>): Promise<{ systemPrompt: string[] } | undefined>;
  agentStart(sessionId?: string): void;
  agentEnd(sessionId?: string, willContinue?: boolean): void;
  /**
   * Drive one event for an explicit context — how a delegate's own start
   * (`session_start`, `before_agent_start`, `agent_start`) reaches the gate.
   */
  lifecycle(
    event: "session_start" | "before_agent_start" | "agent_start" | "agent_end",
    context: Record<string, unknown>,
    payload?: Record<string, unknown>,
  ): Promise<unknown>;
  toolCall(
    event: ToolCallEvent,
    context?: Record<string, unknown>,
  ): Promise<{ block?: boolean; reason?: string } | undefined>;
  /** Dialogs the gate raised, in order. */
  dialogs: Array<{ title: string; items: Array<{ label: string; description?: string }> }>;
  /** Notifications the gate emitted, in order. */
  notices: Array<{ message: string; type?: string }>;
  /** How many times `ctx.abort()` was called. */
  aborted: () => number;
  /** Answer subsequent dialogs with this option (undefined: dismiss). */
  answerWith(option: string | undefined): void;
};

/**
 * The public session facts a delegate context exposes. Undefined members are
 * simply absent from the context, exactly like a host whose session manager
 * does not publish that member.
 */
export type GateDelegateFacts = {
  /** The session file the context reports (`ReadonlySessionManager.getSessionFile`). */
  file?: string;
  /** The parent session file its header declares (`getHeader().parentSession`). */
  parentFile?: string;
  /** The ISO creation time its header declares (`getHeader().timestamp`). */
  createdAt?: string;
};

export type GateTurnInput = {
  sessionId: string;
  mode: DesktopRuntimeMode;
  permissionMode: "ask" | "accept-edits" | "auto";
  hostTools: DesktopHostToolPolicy[];
  grants?: string[];
};

/** Build one turn admission the way the bridge does. */
export function gateTurnAdmission(input: GateTurnInput): OmpTurnAdmission {
  return {
    v: 1,
    nativeSessionId: input.sessionId,
    mode: input.mode,
    permissionMode: input.permissionMode,
    hostTools: input.hostTools,
    grants: input.grants ?? [],
  };
}

/**
 * Register the real gate against a controlled `ExtensionAPI` and return the
 * handles a test drives: the fence command, the four lifecycle handlers and
 * the dialog/notify recorders. Environment switches are read at registration,
 * exactly like the runtime child, so set `OMP_DESKTOP_STATE*` before calling.
 */
export function createGateHandlerHarness(options: GateHarnessOptions = {}): GateHandlerHarness {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const commands = new Map<string, (args: string, context: unknown) => unknown>();
  const dialogs: GateHandlerHarness["dialogs"] = [];
  const notices: GateHandlerHarness["notices"] = [];
  const active = ["read", "write", "edit", "bash", "ask", "new_context"];
  let aborted = 0;
  let answer: string | undefined = OMP_APPROVAL_OPTIONS[2];

  if (options.gated !== undefined) process.env.OMP_DESKTOP_GATE_TOOLS = options.gated;
  if (options.mode !== undefined) process.env.OMP_DESKTOP_GATE_MODE = options.mode;

  const pi: ExtensionAPI = {
    on: ((event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    }) as ExtensionAPI["on"],
    registerCommand: ((name: string, definition: { handler: (args: string, context: unknown) => unknown }) => {
      commands.set(name, definition.handler);
    }) as ExtensionAPI["registerCommand"],
    getActiveTools: () => [...active],
    setActiveTools: async () => undefined,
    logger: { warn: () => undefined },
  };
  ompDesktopGate(pi);

  const cwd = options.cwd ?? process.cwd();
  const contextFor = (sessionId: string): Record<string, unknown> => ({
    cwd,
    hasUI: true,
    sessionManager: {
      getSessionId: () => sessionId,
      getCwd: () => cwd,
      ...(options.ownerFile !== undefined ? { getSessionFile: () => options.ownerFile } : {}),
    },
    abort: () => {
      aborted += 1;
    },
    ui: {
      notify: (message: string, type?: string) => notices.push({ message, type }),
      select: async (title: string, items: Array<{ label: string; description?: string }>) => {
        dialogs.push({ title, items });
        return answer;
      },
    },
  });
  const sessionId = options.sessionId ?? "omp-session-1";
  const context = contextFor(sessionId);

  const run = async (event: string, payload: unknown, ctx: unknown): Promise<unknown> => {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = await handler(payload, ctx);
    return result;
  };

  return {
    context,
    foreignContext: (sessionId = "omp-elsewhere") => contextFor(sessionId),
    delegateContext: (sessionId = "omp-child-1", facts = {}) => ({
      cwd,
      hasUI: false,
      ui: undefined,
      sessionManager: {
        getSessionId: () => sessionId,
        getCwd: () => cwd,
        ...(facts.file !== undefined ? { getSessionFile: () => facts.file } : {}),
        ...(facts.parentFile !== undefined || facts.createdAt !== undefined
          ? {
              getHeader: () => ({
                ...(facts.parentFile !== undefined ? { parentSession: facts.parentFile } : {}),
                ...(facts.createdAt !== undefined ? { timestamp: facts.createdAt } : {}),
              }),
            }
          : {}),
      },
    }),
    arm: (token, admission) => {
      const handler = commands.get(OMP_TURN_COMMAND);
      if (!handler) throw new Error("the gate did not register the turn command");
      handler(admission ? `${token} ${encodeTurnAdmission(admission)}` : token, context);
    },
    armRaw: (args) => {
      const handler = commands.get(OMP_TURN_COMMAND);
      if (!handler) throw new Error("the gate did not register the turn command");
      handler(args, context);
    },
    beforeAgentStart: async (ctx) =>
      (await run(
        "before_agent_start",
        { type: "before_agent_start", systemPrompt: ["native prompt"] },
        ctx ?? context,
      )) as { systemPrompt: string[] } | undefined,
    agentStart: (owner = sessionId) => {
      for (const handler of handlers.get("agent_start") ?? []) {
        handler({ type: "agent_start" }, contextFor(owner));
      }
    },
    agentEnd: (owner = sessionId, willContinue) => {
      for (const handler of handlers.get("agent_end") ?? []) {
        handler(
          { type: "agent_end", ...(willContinue === undefined ? {} : { willContinue }) },
          contextFor(owner),
        );
      }
    },
    lifecycle: (event, ctx, payload) =>
      run(
        event,
        payload ??
          (event === "before_agent_start"
            ? { type: event, systemPrompt: ["native child prompt"] }
            : { type: event }),
        ctx,
      ),
    toolCall: async (event, ctx) =>
      (await run("tool_call", event, ctx ?? context)) as { block?: boolean; reason?: string } | undefined,
    dialogs,
    notices,
    aborted: () => aborted,
    answerWith: (option) => {
      answer = option;
    },
  };
}
