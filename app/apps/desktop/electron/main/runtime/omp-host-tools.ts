/**
 * The desktop's half of the host-tool catalog (M5/T19-B): the PI Desktop
 * plugin/MCP registries, projected into the pinned runtime's
 * `set_host_tools` definitions and executed with the same re-checks the Pi
 * path applies (`session-launch.ts` catalog assembly, `host.ts`
 * `plugins.execute` dispatch, `user-mcp.ts` `callTool`).
 *
 * Naming is the PI Desktop contract, never re-invented here:
 *
 *   - plugin agent tools and plugin-declared MCP tools carry their
 *     `plugin_<plugin>_…` full names from the plugin runtime registry;
 *   - desktop user MCP tools carry `mcp_<server>_<tool>` from the user MCP
 *     runtime.
 *
 * Descriptions and JSON schemas pass through the desktop verbatim; a
 * definition the pinned runtime would refuse (a blank name, an empty
 * description, a non-object schema, a duplicate name) fails the catalog
 * closed with the tool named, instead of a partial registration the session
 * could mistake for complete. (The pinned runtime's own
 * `normalizeHostToolDefinitions` trims name and description at registration —
 * that normalization is OMP's, never re-implemented here.)
 *
 * Result semantics (measured against the pinned sources):
 *
 *   - Protocol errors: `McpServerClient.callTool` throws `TOOL_FAILED` when a
 *     tools/call answer carries `isError` (`plugin-mcp.ts`), so real user MCP
 *     and plugin-declared MCP errors already surface as exceptions — this
 *     executor propagates the throw and the runtime package maps it to an
 *     outer `host_tool_result.isError`.
 *   - Inner `isError`: a plugin that returns an AgentToolResult-shaped value
 *     with `isError: true` is mapped to an outer failed result, never rendered
 *     as success.
 *   - Content blocks: text blocks pass as text; MCP image blocks
 *     (`{type:"image", data, mimeType}`) are shape-compatible with OMP
 *     `ImageContent` (`pi-ai/types.ts`) and pass through faithfully; audio/
 *     resource/embedded blocks and `structuredContent` become deterministic
 *     text (metadata only, never raw base64 payloads) so a text block beside
 *     them cannot hide them. Any key beside `content`/`isError`/
 *     `structuredContent` — including `details`, `providerMetadata` or
 *     `useless` a plugin happened to return — is preserved as JSON text for
 *     the model, matching the Pi contract where the plugin's whole return
 *     value is shown to the model (`host.ts` forwards `content: result`
 *     verbatim). Those keys are never mapped onto the OMP result's own
 *     `details`/`providerMetadata`/`useless` fields, which are OMP-internal
 *     metadata with different (non-model-facing) semantics.
 *   - Budget: the `host_tool_result` frame must fit the pinned runtime's
 *     1 MiB line limit, and JSON escaping expands raw text (quotes,
 *     backslashes, control characters), so every truncation is measured on
 *     the final serialized JSON bytes — never on the raw text.
 *   - Cancellation boundary: child-backed plugin Agent Tools receive the abort
 *     signal (`RegisteredPluginTool.execute` ctx.signal → the plugin runtime's
 *     `sendToChild` aborts the child call, `plugin-runtime.ts:2200-2222`).
 *     Plugin-declared MCP tools are registered with an execute closure that
 *     ignores `ctx.signal` (`plugin-runtime.ts:3506-3519`), and
 *     `McpServerClient.callTool(name, args)` takes no signal, so those share
 *     the MCP limitation below: a cancellation already observed before the
 *     call path is entered refuses it; once the path is entered, connection
 *     or request may continue and only the cancelled pending entry drops the
 *     late completion — remote side effects are never claimed prevented or
 *     retracted (the fixed Pi client has the same limitation).
 */
import {
  boundHostToolContent,
  encodeModeTransitionDetails,
  OMP_ENTER_TOOL_NAMES,
  OMP_MODE_TRANSITION_EXPECTED_MODE,
  OMP_MODE_TRANSITION_VERSION,
  type DesktopHostToolPolicy,
  type DesktopRuntimeMode,
  type OmpHostToolCall,
  type OmpHostToolContentBlock,
  type OmpHostToolDefinition,
  type OmpHostToolExecutor,
  type OmpHostToolOutcome,
  type OmpHostToolRun,
  type OmpModeTransition,
  type OmpModeTransitionKind,
} from "@pi-desktop/omp-runtime";
import type { RegisteredPluginSkill, RegisteredPluginTool } from "../plugin-runtime";
import type { UserMcpToolDescriptor } from "../user-mcp";

/** The plugin registry slice this adapter reads. */
type PluginToolSource = {
  getTools(): RegisteredPluginTool[];
  /** The plugin skill catalog (ids are `<pluginId>/<skillId>`). */
  getSkills(): RegisteredPluginSkill[];
  /** Live body read: throws NOT_FOUND/INVALID_ARGUMENT like the Pi runtime. */
  loadSkillBody(id: string): { id: string; name: string; body: string };
};

/** The user MCP runtime slice this adapter reads. */
type UserMcpSource = {
  toolsForProject(projectPath: string | null | undefined): Promise<UserMcpToolDescriptor[]>;
  callTool(fullName: string, args: unknown, projectPath: string | null | undefined): Promise<unknown>;
};

export type OmpHostToolAdapterDeps = {
  plugins: PluginToolSource;
  userMcp: UserMcpSource;
  /** PI's activation-scope predicate; the same one `session-launch.ts` uses. */
  pluginActiveInProject(pluginId: string, projectPath: string | null | undefined): boolean;
  /**
   * The host's Plan/Goal entry and submission endpoints (`plans.enter` /
   * `plans.submit` RPC). The executor passes only the binding's durable
   * identity — desktop session id, host turn id and the frame's real tool-call
   * id — never a model-supplied value. Absent means the Enter/submit tools
   * cannot run: a call fails closed instead of pretending the host accepted
   * it.
   */
  plans?: {
    enter(input: {
      sessionId: string;
      /** Durable host turn id from the run binding, never the live generation. */
      turnId: string;
      toolCallId: string;
      kind: DesktopSubmitKind;
    }): Promise<unknown>;
    submit(input: {
      sessionId: string;
      /** Durable host turn id from the run binding, never the live generation. */
      turnId: string;
      toolCallId: string;
      kind: DesktopSubmitKind;
      title: string;
      markdown: string;
      question: string;
    }): Promise<unknown>;
  };
  /**
   * Builtin skill body reader (`builtin-skills.ts`): null for any id the host
   * does not ship, which lets the lookup fall through to the user catalog.
   */
  loadBuiltinSkillBody?: (id: string) => { id: string; name: string; body: string } | null;
  /**
   * User skill body reader (PI `loadUserSkillBody`): null when the id is not
   * a user skill; throws when the skill is not active in the bound project —
   * the scope re-check at execution, not at catalog time.
   */
  loadUserSkillBody?: (id: string, projectPath: string | null) => Promise<{ id: string; name: string; body: string } | null>;
  /** The user's active skill ids (PI `activeUserSkills`), for the error hint. */
  activeUserSkills?: (projectPath: string | undefined) => Promise<Array<{ id: string }>>;
  /**
   * The plugin runtime's toast queue (`PluginRuntime.drainToasts()`), drained
   * after every tool execution the way `host.ts` does after `plugins.execute`;
   * `emitToast` delivers each message to the renderer. Drain and delivery
   * failures are isolated — like Pi, which resolves the execution before it
   * drains — so a throwing toast never changes the tool result.
   */
  drainToasts?: () => string[];
  emitToast?: (message: string) => void;
  log?: (level: "info" | "warn" | "error", message: string, data?: unknown) => void;
};

/**
 * The host RPC surface the submit endpoint needs; `HostProcess` satisfies it.
 */
export type OmpHostToolPlansHost = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>;
};

/**
 * The host's Plan/Goal entry and submission endpoints as the adapter consumes
 * them. The executor supplies the durable identity from the run binding; these
 * closures only reach the host RPC, and the host's own validators enforce the
 * durable-mode, live-turn, single-pending and CAS rules.
 * Exported so the E2E wires the production implementation.
 */
export function createHostPlansEndpoints(
  host: () => OmpHostToolPlansHost | null,
): NonNullable<OmpHostToolAdapterDeps["plans"]> {
  const client = (): OmpHostToolPlansHost => {
    const connected = host();
    if (!connected) {
      throw Object.assign(new Error("host unavailable"), { errorCode: "HOST_UNAVAILABLE" });
    }
    return connected;
  };
  return {
    enter: async (input) => client().call("plans.enter", input),
    submit: async (input) => client().call("plans.submit", input),
  };
}

/**
 * One session's binding the executor is scoped to.
 */
export type OmpHostToolBinding = {
  sessionId: string;
  /** The project every execution re-checks against; never crossed. */
  projectPath: string;
  /** Live model key; read at each execution, never a construction snapshot. */
  modelKey(): string | null;
  /** Live thinking level; read at each execution (see the provider type). */
  thinkingLevel(): string | null;
  /**
   * The OMP turn-dispatch gate, required. The bridge supplies a closure over
   * its own entry: true only while the named turn is still the entry's live,
   * running, unstopping run. The Pi predicate (`session-coordination.ts`)
   * answers false for OMP turns — they never enter `activeTurns` — so the
   * OMP source of truth is the runner state, never the Pi turn map. Checked
   * at the last synchronous dispatch point of each branch, after
   * `signal.aborted`; there must be no await between the checks and the
   * dispatch.
   */
  dispatchable(turnId: string): boolean;
  /**
   * The session's operating mode for the turn that owns this call (M5/T20-C),
   * or null when no policy was admitted for that turn. The plugin execution
   * context receives this exact value — never a hardcoded "agent" — and the
   * PI plugin-runtime guard enforces the per-action `planSafeActions`
   * restriction with it; user MCP tools are refused outside Agent mode. A
   * null answer refuses the call: an execution without a known mode could be
   * a Plan/Goal action running as Agent. Read after `dispatchable` has bound
   * the call to the entry's live turn.
   */
  modeForTurn(turnId: string): DesktopRuntimeMode | null;
  /**
   * The runtime's own native session identity (the OMP session id the fence
   * admission is bound to), or null while the runtime has not established it.
   * The mid-turn mode transition record is validated against the admitted
   * native session, so the adapter must name that identity, never the desktop
   * session id.
   */
  nativeSessionId(): string | null;
  /**
   * Prepare the live turn for a host-confirmed `Agent -> Plan|Goal` transition
   * (M5/T20-D), after `plans.enter` committed the durable mode. The bridge:
   * records the new mode for this exact live turn (`modeForTurn`), re-registers
   * the desktop host tools for the new mode (the Enter tools leave the
   * catalogue; the new mode's submit tool appears) and returns the exact
   * `composeModeSystemPrompt(kind, "")` block plus the new policy table for
   * the trusted gate. A rejection means the transition could not be prepared:
   * the adapter reports it as a failed transition, and the gate stops the
   * inconsistent turn instead of continuing as Agent under a Plan/Goal row.
   */
  enterMode(
    run: OmpHostToolRun,
    kind: OmpModeTransitionKind,
  ): Promise<{ modeBlock: string; hostTools: DesktopHostToolPolicy[] }>;
};

export type OmpHostToolAdapter = {
  /** The session's tool catalog for one project (never shared across projects). */
  catalog(projectPath: string): Promise<OmpHostToolCatalogEntry[]>;
  /** An executor bound to one session/project, with live re-checks. */
  executor(binding: OmpHostToolBinding): OmpHostToolExecutor;
};

/**
 * Which desktop registry served one host tool. Provenance is taken from the
 * registry that produced the entry, never from the name prefix: plugin tools
 * (including plugin-declared MCP tools) come from the plugin registry, user
 * MCP tools from the user MCP runtime, and `desktop` names this adapter's own
 * built-in tools (the Plan/Goal submit tools, M5/T20-B2).
 */
export type OmpHostToolOrigin = "plugin" | "user-mcp" | "desktop";

/**
 * One catalog entry: the wire definition the runtime registers, plus the
 * desktop policy that rides the run-scoped state (M5/T20-B1) — the declared
 * PI risk, the plan-safe actions that make a plugin tool contract-visible, and
 * the origin registry. The policy is part of the catalog fingerprint, so a
 * risk or plan-safe-action change re-registers even when names and schemas are
 * unchanged.
 */
export type OmpHostToolCatalogEntry = {
  definition: OmpHostToolDefinition;
  /**
   * PI risk for this tool: the plugin's declared `low|medium|high`, `medium`
   * when the declaration is missing or invalid (PI's default), and `low` for
   * user MCP tools (PI host-core classifies `mcp_*` as Low). A name prefix
   * never decides this field.
   */
  risk: "low" | "medium" | "high";
  /** Declared plan-safe actions; only a plugin declaration can be non-empty. */
  planSafeActions: string[];
  origin: OmpHostToolOrigin;
};

const FALLBACK_SCHEMA = { type: "object", properties: {} } as const;

/**
 * The on-demand skill tool's name — the exact PI `Skill` contract, served as a
 * desktop host tool (M5/T19-C). The bridge adds it to the catalog only when
 * the desktop skill catalog is non-empty (the Pi registration gate), so a
 * model never sees a `Skill` tool without a Skills section to read.
 */
export const DESKTOP_SKILL_TOOL_NAME = "Skill";

/**
 * The constant host-tool definition the bridge registers for the on-demand
 * path. The description is the Pi runtime's verbatim; `essential` keeps it in
 * the top-level schema (an undeclared load mode would demote it to xd://
 * discovery and hide it from the model).
 */
export function desktopSkillToolDefinition(): OmpHostToolDefinition {
  return {
    name: DESKTOP_SKILL_TOOL_NAME,
    description:
      "Load the full instructions of one skill listed in the Skills section of your system prompt. Pass its exact id (for example \"demo.hello/release-notes\"). Returns the skill document; follow it for the current task.",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Skill id exactly as listed in the Skills section.",
        },
      },
      required: ["id"],
    },
    loadMode: "essential",
  };
}
/**
 * The Plan/Goal submit tools, exactly PI's `SUBMIT_TOOL_NAMES` and
 * `buildSubmitTool` contract (`agent-runtime/src/runtime.ts`): one kind-keyed
 * table so Plan and Goal cannot drift, the same names, descriptions and
 * `title`/`markdown`/`question` schema, declared `sole` (the only tool call of
 * its assistant message) and `terminateOnSettle` (any settled result ends the
 * run — success, host failure or a schema rejection that never reaches the
 * executor). The bridge adds the active mode's entry to the catalog, so the
 * other kind's tool never appears.
 */
export const DESKTOP_SUBMIT_TOOL_KINDS = ["plan", "goal"] as const;
export type DesktopSubmitKind = (typeof DESKTOP_SUBMIT_TOOL_KINDS)[number];

/** The submit tool name one contract kind owns (PI `SUBMIT_TOOL_NAMES`). */
export const DESKTOP_SUBMIT_TOOL_NAMES: Record<DesktopSubmitKind, string> = {
  plan: "SubmitPlan",
  goal: "SubmitGoal",
};

/** The definition the bridge registers for `SubmitPlan`/`SubmitGoal`. */
export function desktopSubmitToolCatalogEntry(kind: DesktopSubmitKind): OmpHostToolCatalogEntry {
  const name = DESKTOP_SUBMIT_TOOL_NAMES[kind];
  const definition: OmpHostToolDefinition = {
    name,
    description:
      kind === "plan"
        ? "Submit one new complete Markdown implementation plan for user approval. Prior submissions are immutable historical checkpoints; after a rejected, expired, or interrupted approval, revise the plan and submit a new full snapshot in this turn. Do not use this until the plan is concrete."
        : "Submit one new complete Markdown goal contract for user approval: the outcome to reach, the acceptance criteria that prove it, and the boundaries you must not cross. Prior submissions are immutable historical checkpoints; after a rejected, expired, or interrupted approval, revise the contract and submit a new full snapshot in this turn. Do not use this until the goal is unambiguous and every criterion is checkable.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            kind === "plan"
              ? "A concise title for the implementation plan."
              : "A concise title naming the goal.",
        },
        markdown: {
          type: "string",
          description:
            kind === "plan"
              ? "The exact Markdown implementation plan, including files, behavior, and validation."
              : "The exact Markdown goal contract, with a Goal section, an Acceptance criteria section of objectively checkable items, and a Boundaries section. Describe outcomes, not implementation steps.",
        },
        question: {
          type: "string",
          description:
            kind === "plan"
              ? "The question or decision the user should answer when approving this plan."
              : "The question or decision the user should answer when approving this goal contract.",
        },
      },
      required: ["title", "markdown", "question"],
    },
    loadMode: "essential",
    concurrency: "exclusive",
    batchPolicy: "sole",
    terminateOnSettle: true,
  };
  return {
    definition,
    // PI's risk table classifies the submit tools Low; the declaration rides
    // the run-scoped policy table so the card/risk lookup never guesses from
    // the name.
    risk: "low",
    planSafeActions: [],
    origin: "desktop",
  };
}

/**
 * The model-side mode-entry tools, exactly PI's `ENTER_TOOL_NAMES` and
 * `buildEnterModeTool` contract (`agent-runtime/src/runtime.ts`): both are
 * Agent-only, take no arguments (`Type.Object({})`), and are declared `sole`
 * (the only tool call of their assistant message) — but, unlike the submit
 * tools, a settled result does **not** terminate: PI's Enter commits the
 * durable mode and the same turn continues with the new prompt and catalogue.
 *
 * The bridge adds both entries to an Agent-mode catalogue only; the contract
 * modes expose their own submit tool instead, and the trusted gate's clamp
 * keeps exactly the mode's catalogue.
 */
export const DESKTOP_ENTER_TOOL_KINDS: readonly OmpModeTransitionKind[] = ["plan", "goal"];

/** The definition the bridge registers for `EnterPlanMode`/`EnterGoalMode`. */
export function desktopEnterToolCatalogEntry(kind: OmpModeTransitionKind): OmpHostToolCatalogEntry {
  const name = OMP_ENTER_TOOL_NAMES[kind];
  const definition: OmpHostToolDefinition = {
    name,
    description:
      kind === "plan"
        ? "Switch this same agent into Plan mode after the host confirms the durable session transition. Use when the user wants to agree on the implementation steps before any change is made."
        : "Switch this same agent into Goal mode after the host confirms the durable session transition. Use when the user states an outcome and wants you to agree on the goal and its acceptance criteria, then reach it autonomously.",
    parameters: { type: "object", properties: {} },
    loadMode: "essential",
    concurrency: "exclusive",
    batchPolicy: "sole",
    terminateOnSettle: false,
  };
  return {
    definition,
    // PI's risk table classifies both entries Low; the declaration rides the
    // run-scoped policy table so the card/risk lookup never guesses from the
    // name.
    risk: "low",
    planSafeActions: [],
    origin: "desktop",
  };
}

/**
 * One image block must leave room for the frame envelope and other blocks.
 * The frame-level budget itself is enforced at the protocol write boundary
 * (`boundHostToolContent` in the runtime package), which every outcome —
 * successful or thrown-error — passes through.
 */
const IMAGE_BYTES = 512 * 1024;
/** One content block the runtime's `host_tool_result` accepts. */
type OutcomeBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * Assemble and expose the desktop's host tools for OMP sessions.
 */
export function createOmpHostToolAdapter(deps: OmpHostToolAdapterDeps): OmpHostToolAdapter {
  async function catalog(projectPath: string): Promise<OmpHostToolCatalogEntry[]> {
    // The same assembly `session-launch.ts` performs for the Pi sidecar: the
    // live plugin registry filtered by activation scope, plus every user MCP
    // tool active in this project (which `toolsForProject` already scopes).
    const pluginEntries = deps.plugins
      .getTools()
      .filter((tool) => deps.pluginActiveInProject(tool.pluginId, projectPath))
      .map((tool): OmpHostToolCatalogEntry => ({
        definition: toDefinition({
          name: tool.fullName,
          description: tool.description,
          parameters: tool.schema ?? FALLBACK_SCHEMA,
        }),
        // PI forwards a declared risk only when it is one of the three legal
        // values and otherwise leaves it to the host's default (medium); the
        // same rule lands the default here. The declaration is read from the
        // registry entry, never inferred from the name.
        risk:
          tool.risk === "low" || tool.risk === "medium" || tool.risk === "high"
            ? tool.risk
            : ("medium" as const),
        // Registration validated the list (PI ADR 0211); an omitted list is
        // empty, and empty keeps the tool out of the contract catalog.
        planSafeActions: tool.planSafeActions ? [...tool.planSafeActions] : [],
        origin: "plugin" as const,
      }));
    const userMcpTools = await deps.userMcp.toolsForProject(projectPath);
    const entries: OmpHostToolCatalogEntry[] = [
      ...pluginEntries,
      ...userMcpTools.map((tool) => ({
        definition: toDefinition({
          name: tool.fullName,
          description: tool.description,
          parameters: tool.schema ?? FALLBACK_SCHEMA,
        }),
        // PI host-core classifies user MCP tools as Low, but that only decides
        // the card in Agent mode; it never overrides the contract hard-deny.
        risk: "low" as const,
        planSafeActions: [] as string[],
        origin: "user-mcp" as const,
      })),
    ];
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.definition.name)) {
        throw new Error(`duplicate host tool name in the desktop catalog: ${entry.definition.name}`);
      }
      seen.add(entry.definition.name);
    }
    return entries;
  }

  function executor(binding: OmpHostToolBinding): OmpHostToolExecutor {
    /**
     * The last synchronous dispatch gate: an aborted signal or a turn that is
     * no longer dispatchable must not start a side effect. The refusal mirrors
     * `host.ts`'s `TOOL_TURN_CANCELLED` answer; the outer host-tool bridge maps
     * the throw to an `isError` result. No await may sit between these checks
     * and the dispatch.
     */
    const assertDispatchable = (run: OmpHostToolRun, signal: AbortSignal): void => {
      if (signal.aborted) {
        throw Object.assign(new Error("the host tool call was cancelled before it started"), {
          errorCode: "TOOL_CANCELLED",
        });
      }
      if (!binding.dispatchable(run.turnId)) {
        throw Object.assign(new Error(`turn ${run.turnId} is no longer dispatchable`), {
          errorCode: "TOOL_TURN_CANCELLED",
        });
      }
    };

    /**
     * Serve one on-demand skill load with the exact PI precedence and error
     * shape (`sidecar.ts` local `Skill` tool): builtin first, then the user's
     * own — whose body is re-checked against the project scope at every call
     * (PI `loadUserSkillBody` throws when the skill is no longer active) —
     * then the plugin's, read with PI `loadSkillBody`'s checks only:
     * registered, plugin loaded, file readable, ≤128 KiB, non-empty body.
     * PI performs no scope predicate on the plugin body path, and neither
     * does this adapter; a plugin scope change lands on the next prompt's
     * catalog rebuild instead. Everything is read live, so an unload,
     * delete or edit between the catalog and this call takes effect here,
     * without a restart.
     */
    const runSkillLoad = async (
      call: OmpHostToolCall,
      run: OmpHostToolRun,
      signal: AbortSignal,
    ): Promise<OmpHostToolOutcome> => {
      assertDispatchable(run, signal);
      const args = call.arguments ?? {};
      const id = String((args as { id?: unknown }).id ?? "").trim();
      if (!id) {
        return outcomeFor({
          content: [{ type: "text", text: "Skill: `id` is required. Use an id from the Skills section." }],
          isError: true,
        });
      }
      try {
        const skill =
          deps.loadBuiltinSkillBody?.(id) ??
          (await deps.loadUserSkillBody?.(id, binding.projectPath)) ??
          deps.plugins.loadSkillBody(id);
        return outcomeFor({
          content: [{ type: "text", text: `# Skill: ${skill.name} (${skill.id})\n\n${skill.body}` }],
        });
      } catch (error) {
        const userIds =
          (await deps.activeUserSkills?.(binding.projectPath))?.map((skill) => skill.id) ?? [];
        const pluginIds = deps.plugins
          .getSkills()
          .filter((skill) => deps.pluginActiveInProject(skill.pluginId, binding.projectPath))
          .map((skill) => skill.id);
        const available = [...userIds, ...pluginIds].join(", ");
        return outcomeFor({
          content: [
            {
              type: "text",
              text: `Skill: ${error instanceof Error ? error.message : String(error)}.${
                available ? ` Available skills: ${available}.` : ""
              }`,
            },
          ],
          isError: true,
        });
      }
    };
    /**
     * Serve one Plan/Goal submission through the host's own plans protocol.
     *
     * The host's durable validator is authoritative (kind vs the persistent
     * session mode, live turn membership, one pending per session, artifact
     * publication); this branch's own checks are the desktop-side fail-closed
     * layer: the admitted turn's mode must be the kind being submitted, and a
     * run without a durable host turn must never submit under a fabricated id.
     */
    const runSubmit = async (
      call: OmpHostToolCall,
      run: OmpHostToolRun,
      signal: AbortSignal,
      kind: DesktopSubmitKind,
      mode: DesktopRuntimeMode,
    ): Promise<OmpHostToolOutcome> => {
      // A call the runtime cancelled before it started must not submit.
      assertDispatchable(run, signal);
      const name = DESKTOP_SUBMIT_TOOL_NAMES[kind];
      const label = kind === "plan" ? "Plan" : "Goal";
      if (mode !== kind) {
        return outcomeFor({
          content: [
            {
              type: "text",
              text: `PLAN_KIND_MISMATCH: ${name} is not available in ${mode} mode`,
            },
          ],
          isError: true,
        });
      }
      if (!run.hostTurnId) {
        return outcomeFor({
          content: [
            {
              type: "text",
              text: `${name} has no durable host turn bound to this run; refusing to submit`,
            },
          ],
          isError: true,
        });
      }
      if (!deps.plans) {
        return outcomeFor({
          content: [{ type: "text", text: `${name} is not wired in this build` }],
          isError: true,
        });
      }
      const args = call.arguments ?? {};
      const title = typeof args.title === "string" ? args.title.trim() : "";
      const markdown = typeof args.markdown === "string" ? args.markdown : "";
      const question = typeof args.question === "string" ? args.question.trim() : "";
      if (!title || !markdown.trim() || !question) {
        return outcomeFor({
          content: [
            {
              type: "text",
              text: `${name} requires non-empty title, markdown, and question.`,
            },
          ],
          isError: true,
        });
      }
      try {
        const result = await deps.plans.submit({
          sessionId: binding.sessionId,
          turnId: run.hostTurnId,
          toolCallId: call.toolCallId,
          kind,
          title,
          markdown,
          question,
        });
        if (!isPendingProposalResult(result)) {
          return outcomeFor({
            content: [
              {
                type: "text",
                text: `${label} submission returned an invalid proposal.`,
              },
            ],
            isError: true,
          });
        }
        return outcomeFor({
          content: [
            {
              type: "text",
              text:
                kind === "plan"
                  ? "Plan submitted for approval. Execution will begin only after approval."
                  : "Goal contract submitted for approval. Autonomous execution will begin only after approval.",
            },
          ],
        });
      } catch (error) {
        const errorCode = planSubmitErrorCode(error);
        return outcomeFor({
          content: [{ type: "text", text: `${label} submission failed: ${errorCode}` }],
          isError: true,
        });
      }
    };
    /**
     * Serve one Agent -> Plan/Goal entry through the host's own `plans.enter`.
     *
     * The host is authoritative: its CAS requires the durable mode to be
     * Agent, a live running turn with exactly the bound id, and no
     * queued/running execution; the reply names the resulting planning state.
     * Only then does the desktop prepare the runtime side (mode recorded for
     * this live turn, catalogue re-registered for the new mode) and return the
     * transition record the trusted gate applies.
     *
     * Once the host has committed, a run that can no longer be prepared — a
     * stop raced the commit, or the desktop-side preparation failed — must not
     * be reported as a successful entry either: it returns the record with
     * `state: "failed"`, and the gate stops the turn. The next prompt rebuilds
     * from the durable host row.
     */
    const runEnter = async (
      call: OmpHostToolCall,
      run: OmpHostToolRun,
      signal: AbortSignal,
      kind: OmpModeTransitionKind,
      mode: DesktopRuntimeMode,
    ): Promise<OmpHostToolOutcome> => {
      assertDispatchable(run, signal);
      const name = OMP_ENTER_TOOL_NAMES[kind];
      const label = kind === "plan" ? "Plan" : "Goal";
      if (mode !== "agent") {
        return outcomeFor({
          content: [{ type: "text", text: `${name} is available only in Agent mode` }],
          isError: true,
        });
      }
      // The record identifies the durable turn the host validated; without a
      // bound host turn there is nothing to validate against.
      const hostTurnId = run.hostTurnId;
      if (!hostTurnId) {
        return outcomeFor({
          content: [
            { type: "text", text: `${name} has no durable host turn bound to this run; refusing to enter ${label} mode` },
          ],
          isError: true,
        });
      }
      if (!deps.plans?.enter) {
        return outcomeFor({ content: [{ type: "text", text: `${name} is not wired in this build` }], isError: true });
      }
      const nativeSessionId = binding.nativeSessionId();
      if (!nativeSessionId) {
        return outcomeFor({
          content: [
            { type: "text", text: `${name} has no established native session; refusing to enter ${label} mode` },
          ],
          isError: true,
        });
      }
      const at = Date.now();
      // A committed transition the desktop could not prepare. The record is
      // the only channel that tells the gate to stop the inconsistent turn;
      // its own encoder ceiling can only fail for a pathological catalogue,
      // in which case the error result still stops the model from pretending
      // the entry succeeded (no record => the gate fails the turn).
      const failedOutcome = (reason: string): OmpHostToolOutcome => {
        let details: Record<string, OmpModeTransition> | undefined;
        try {
          details = encodeModeTransitionDetails({
            v: OMP_MODE_TRANSITION_VERSION,
            kind,
            state: "failed",
            sessionId: nativeSessionId,
            liveTurnId: run.turnId,
            hostTurnId,
            toolCallId: call.toolCallId,
            expectedMode: OMP_MODE_TRANSITION_EXPECTED_MODE,
            reason: reason.slice(0, 2000) || "the desktop could not prepare the mode transition",
            at,
          });
        } catch {
          details = undefined;
        }
        return {
          content: [{ type: "text", text: `${label} mode could not be entered: ${reason}` }],
          isError: true,
          ...(details ? { details } : {}),
        };
      };
      try {
        const result = await deps.plans.enter({
          sessionId: binding.sessionId,
          turnId: hostTurnId,
          toolCallId: call.toolCallId,
          kind,
        });
        if (!isEnterPlanResult(result, kind)) {
          return outcomeFor({
            content: [{ type: "text", text: `${name} returned an invalid transition result.` }],
            isError: true,
          });
        }
      } catch (error) {
        // The host refused: wrong durable mode, stale turn, an active
        // execution. This is a correctable tool error with no transition.
        return outcomeFor({
          content: [{ type: "text", text: `${name} was refused: ${planSubmitErrorCode(error)}` }],
          isError: true,
        });
      }
      // The host committed the durable mode. Everything below is the desktop's
      // preparation of the live turn, and any failure from here stops it.
      if (signal.aborted || !binding.dispatchable(run.turnId)) {
        return failedOutcome("the run stopped while the host committed the mode transition");
      }
      let prepared: { modeBlock: string; hostTools: DesktopHostToolPolicy[] };
      try {
        prepared = await binding.enterMode(run, kind);
      } catch (error) {
        return failedOutcome(
          `the desktop could not prepare the transitioned turn: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // The preparation awaits the runtime's own catalogue registration: a
      // stop that landed during it must not be reported as a ready transition.
      if (signal.aborted || !binding.dispatchable(run.turnId)) {
        return failedOutcome("the run stopped while the desktop prepared the mode transition");
      }
      let details: Record<string, OmpModeTransition>;
      try {
        details = encodeModeTransitionDetails({
          v: OMP_MODE_TRANSITION_VERSION,
          kind,
          state: "ready",
          sessionId: nativeSessionId,
          liveTurnId: run.turnId,
          hostTurnId,
          toolCallId: call.toolCallId,
          expectedMode: OMP_MODE_TRANSITION_EXPECTED_MODE,
          modeBlock: prepared.modeBlock,
          hostTools: prepared.hostTools,
          at,
        });
      } catch (error) {
        return failedOutcome(error instanceof Error ? error.message : String(error));
      }
      return {
        content: [
          {
            type: "text",
            text:
              kind === "plan"
                ? "Plan mode is active. Inspect the workspace, formulate the plan, then call SubmitPlan for approval."
                : "Goal mode is active. Clarify the outcome and how it will be verified, then call SubmitGoal for approval.",
          },
        ],
        details,
      };
    };
    return {
      async execute(call: OmpHostToolCall, run: OmpHostToolRun, signal: AbortSignal): Promise<OmpHostToolOutcome> {
        try {
          if (call.toolName === DESKTOP_SKILL_TOOL_NAME) {
            return await runSkillLoad(call, run, signal);
          }
          // The turn's real operating mode gates every host-tool dispatch
          // below (M5/T20-C). It comes from the policy the bridge admitted
          // this turn under; an unknown turn fails closed instead of
          // executing under a defaulted mode.
          const mode = binding.modeForTurn(run.turnId);
          if (mode === null) {
            throw Object.assign(
              new Error(
                `no admitted session policy exists for turn ${run.turnId}; refusing to execute ${call.toolName}`,
              ),
              { errorCode: "PERMISSION_DENIED" },
            );
          }
          // The Plan/Goal submit tools act on the host's own turn, so they run
          // before the plugin/MCP branches: their identity comes only from the
          // run binding (durable session/turn + the frame's real toolCallId),
          // and a call in the wrong mode or without a durable turn fails
          // closed instead of reaching `plans.submit`.
          const submitKind: DesktopSubmitKind | null =
            call.toolName === DESKTOP_SUBMIT_TOOL_NAMES.plan
              ? "plan"
              : call.toolName === DESKTOP_SUBMIT_TOOL_NAMES.goal
                ? "goal"
                : null;
          if (submitKind !== null) {
            return await runSubmit(call, run, signal, submitKind, mode);
          }
          // The Enter tools run before the plugin/MCP branches too: their
          // identity comes only from the run binding (durable session/turn +
          // the frame's real tool-callId), and a call in a contract mode or
          // without a durable turn fails closed instead of reaching
          // `plans.enter`.
          const enterKind =
            call.toolName === OMP_ENTER_TOOL_NAMES.plan
              ? "plan"
              : call.toolName === OMP_ENTER_TOOL_NAMES.goal
                ? "goal"
                : null;
          if (enterKind !== null) {
            return await runEnter(call, run, signal, enterKind, mode);
          }
          if (call.toolName.startsWith("mcp_")) {
            // Last synchronous gate before entering the MCP call path: the Pi
            // host has no turn gate on its user-MCP branch (`host.ts` calls
            // `callTool` directly), but the OMP adapter checks here — a
            // cancellation already observed before the call path is entered
            // refuses it. The guarantee ends at the path boundary:
            // `UserMcpRuntime.callTool` awaits `connect(record)` before the
            // client dispatches `tools/call`, and neither runtime nor client
            // accepts an AbortSignal (the fixed Pi client has the same
            // limitation), so a cancellation landing during that handshake
            // window may still let a `tools/call` through. Once the call path
            // is entered, only the cancelled pending entry can drop the late
            // completion — the remote side effect is never claimed prevented
            // or retracted.
            assertDispatchable(run, signal);
            // PI host-core denies every `mcp_*` tool in the contract modes
            // before the Electron plugin bridge ever sees it; the adapter
            // repeats the denial at its own dispatch boundary so a call that
            // somehow bypassed the gate can never run.
            if (mode !== "agent") {
              throw Object.assign(
                new Error(
                  `TOOL_DISABLED_IN_PLAN: user MCP tool ${call.toolName} is not available in ${mode} mode`,
                ),
                { errorCode: "PERMISSION_DENIED" },
              );
            }
            // `callTool` re-checks the server scope, the connection state and the
            // latest tool list before dispatching — the same re-checks the Pi
            // path relies on. A protocol-level error (`isError` on the
            // tools/call answer) throws `TOOL_FAILED` here and becomes an outer
            // failed host tool result.
            const result = await deps.userMcp.callTool(call.toolName, call.arguments, binding.projectPath);
            return outcomeFor(result);
          }
          // Live registry lookup, not the registration snapshot: a plugin that
          // was unloaded or scoped away since the catalog was assembled is
          // refused before anything executes.
          const tool = deps.plugins.getTools().find((candidate) => candidate.fullName === call.toolName);
          if (!tool) {
            throw new Error(`plugin tool not loaded: ${call.toolName}`);
          }
          if (!deps.pluginActiveInProject(tool.pluginId, binding.projectPath)) {
            throw new Error(`plugin tool ${call.toolName} is not enabled for this project`);
          }
          // The last synchronous gate before a plugin side effect, at the same
          // dispatch point as Pi's `host.ts`.
          assertDispatchable(run, signal);
          // The binding's model/thinking values are live getters: a configure()
          // that changed the thinking level on this same entry must be visible
          // to the very next execution, never a stale construction snapshot.
          // `mode` is the *real* mode of the admitted turn (M5/T20-C): the
          // PI plugin-runtime guard enforces the declared `planSafeActions`
          // restriction with it, and the plugin child receives it verbatim.
          const modelKey = binding.modelKey();
          const thinkingLevel = binding.thinkingLevel();
          const result = await tool.execute(call.arguments, {
            sessionId: binding.sessionId,
            turnId: run.turnId,
            signal,
            mode,
            ...(modelKey ? { modelKey } : {}),
            ...(thinkingLevel ? { thinkingLevel } : {}),
          });
          return outcomeFor(result);
        } finally {
          // The same post-execution drain `host.ts` performs after
          // `plugins.execute` — and like Pi, the drain runs *after* the
          // result is produced, so a failing drain or toast delivery can
          // never turn a successful tool result into an error.
          if (deps.drainToasts && deps.emitToast) {
            drainToastsSafely();
          }
        }
      },
    };
  }

  /** Drain the plugin toast queue without letting it affect the tool result. */
  function drainToastsSafely(): void {
    let toasts: string[];
    try {
      toasts = deps.drainToasts?.() ?? [];
    } catch (error) {
      deps.log?.("warn", "plugin toast drain failed", String(error));
      return;
    }
    for (const toast of toasts) {
      try {
        deps.emitToast?.(toast);
      } catch (error) {
        deps.log?.("warn", "plugin toast delivery failed", String(error));
      }
    }
  }

  return { catalog, executor };
}

/**
 * Validate one definition the way the pinned runtime's
 * `normalizeHostToolDefinitions` will (rpc-mode.ts): a non-empty name and
 * description and an object JSON Schema, exposed top-level (`essential`) so the
 * model always sees the tool. A definition the runtime would refuse is
 * rejected here, with the tool named, before anything is sent.
 */
function toDefinition(raw: { name: string; description: string; parameters: unknown }): OmpHostToolDefinition {
  // The pinned runtime's `normalizeHostToolDefinitions` trims both fields and
  // rejects a blank name (`rpc-mode.ts`); the desktop applies the same
  // rejection up front so a definition the runtime would refuse is never sent
  // as part of a partial registration.
  if (typeof raw.name !== "string" || raw.name.trim().length === 0) {
    throw new Error(`host tool at index must provide a non-empty name (received ${JSON.stringify(raw.name)})`);
  }
  // The description is checked with a trim but forwarded verbatim: the
  // desktop never normalizes what a tool author wrote. (The pinned runtime
  // trims it at registration — that is OMP's own normalization, not the
  // desktop's.)
  if (typeof raw.description !== "string" || raw.description.trim().length === 0) {
    throw new Error(`host tool "${raw.name}" must provide a non-empty description`);
  }
  if (!raw.parameters || typeof raw.parameters !== "object" || Array.isArray(raw.parameters)) {
    throw new Error(`host tool "${raw.name}" must provide a JSON Schema object`);
  }
  return {
    name: raw.name,
    description: raw.description,
    parameters: raw.parameters as Record<string, unknown>,
    loadMode: "essential",
  };
}

/**
 * One tool result, mapped to the pinned runtime's outcome shape.
 *
 * The two isError layers are kept apart: an AgentToolResult-shaped value that
 * itself carries `isError: true` (a plugin's non-throwing failure) becomes an
 * outer failed result; a thrown error does the same at the runtime-package
 * layer. Everything else renders as the model reads it: strings pass through,
 * MCP/AgentToolResult content blocks map block-by-block, and any structure
 * outside those shapes serializes as deterministic bounded JSON — nothing is
 * silently marked successful or dropped.
 *
 * Every path funnels through the shared `boundHostToolContent` pass, which
 * measures the final serialized `content` array (JSON escaping, brackets,
 * commas and block envelopes included) — no caller hand-computes byte
 * budgets. The same function is the FINAL, authoritative runtime write
 * boundary in `OmpHostToolCalls`, so a thrown executor error with a huge
 * message is bounded there too, with the outer `isError` retained.
 */
function outcomeFor(result: unknown): OmpHostToolOutcome {
  let blocks: OmpHostToolContentBlock[];
  let failed = false;
  if (typeof result === "string") {
    blocks = [{ type: "text", text: result }];
  } else if (result === null || result === undefined) {
    blocks = [{ type: "text", text: "ok" }];
  } else if (typeof result !== "object") {
    blocks = [{ type: "text", text: String(result) }];
  } else {
    const record = result as Record<string, unknown>;
    const content = record.content;
    if (!Array.isArray(content)) {
      // No content-block shape: the whole value is the model's text.
      blocks = [{ type: "text", text: stringifyJson(result) }];
    } else {
      failed = record.isError === true;
      blocks = blocksOf(content);
      // Keys beside the three the block shape defines are preserved as JSON
      // text for the model — the Pi contract shows the plugin's whole return
      // value to the model, so `details`/`providerMetadata`/`useless` a plugin
      // returned ride along as text instead of being dropped (they are never
      // mapped onto the OMP result's own metadata fields, which have
      // different semantics).
      const known = new Set(["content", "isError", "structuredContent"]);
      const extra = Object.keys(record).filter((key) => !known.has(key));
      if (extra.length > 0) {
        const extras: Record<string, unknown> = {};
        for (const key of extra) extras[key] = record[key];
        blocks.push({ type: "text", text: stringifyJson(extras) });
      }
      const structured = record.structuredContent;
      if (structured !== undefined) {
        blocks.push({ type: "text", text: stringifyJson(structured) });
      }
    }
  }
  return {
    content: boundHostToolContent(blocks),
    ...(failed ? { isError: true } : {}),
  };
}

/**
 * True when a `plans.submit` reply carries the pending proposal with the
 * immutable artifact identity PI's submit tool requires before it reports
 * success to the model: status `pending`, a proposal id, and a relative path,
 * sha256 and byte size. A reply missing any of them is not a submission the
 * desktop can show or approve, so it is reported to the model as invalid.
 */
function isPendingProposalResult(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const status = "status" in value ? value.status : undefined;
  const proposal = "proposal" in value ? value.proposal : undefined;
  if (status !== "pending" || !proposal || typeof proposal !== "object") return false;
  const id = "id" in proposal ? proposal.id : undefined;
  const artifact = "artifact" in proposal ? proposal.artifact : undefined;
  if (typeof id !== "string" || !artifact || typeof artifact !== "object") return false;
  const relativePath = "relativePath" in artifact ? artifact.relativePath : undefined;
  const sha256 = "sha256" in artifact ? artifact.sha256 : undefined;
  const sizeBytes = "sizeBytes" in artifact ? artifact.sizeBytes : undefined;
  return typeof relativePath === "string" && typeof sha256 === "string" && typeof sizeBytes === "number";
}

/**
 * True when a `plans.enter` reply carries PI's committed transition: the
 * host's own `ok`, the resulting `planning` state (the only state an
 * `Agent -> Plan|Goal` entry can produce, because the CAS refuses a session
 * with a queued/running execution) and the kind that was requested. A reply
 * missing any of them is not a transition the desktop can build on, so it is
 * reported to the model as invalid instead of being treated as success.
 */
function isEnterPlanResult(value: unknown, kind: DesktopSubmitKind): boolean {
  if (!value || typeof value !== "object") return false;
  const ok = "ok" in value ? value.ok : undefined;
  const state = "state" in value ? value.state : undefined;
  const reported = "kind" in value ? value.kind : undefined;
  return ok === true && state === "planning" && reported === kind;
}

/**
 * The host error code carried by a failed `plans.submit`/`plans.enter` RPC.
 * The host transport puts it in `data.errorCode` (Pi contract) and some paths
 * attach it to the error itself; anything unrecognized reports the generic
 * failure code rather than an empty message.
 */
function planSubmitErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const data = "data" in error ? error.data : undefined;
    if (data && typeof data === "object" && "errorCode" in data && typeof data.errorCode === "string") {
      return data.errorCode;
    }
    if ("errorCode" in error && typeof error.errorCode === "string") return error.errorCode;
  }
  return "PLAN_SUBMIT_FAILED";
}

/** Map one MCP/AgentToolResult content array block-by-block, unbounded. */
function blocksOf(content: unknown[]): OmpHostToolContentBlock[] {
  const blocks: OmpHostToolContentBlock[] = [];
  for (const raw of content) {
    if (!raw || typeof raw !== "object") {
      blocks.push({ type: "text", text: stringifyJson(raw) });
      continue;
    }
    const block = raw as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ type: "text", text: block.text });
      continue;
    }
    // MCP image blocks are shape-compatible with OMP ImageContent
    // (`{type:"image", data(base64), mimeType}`): faithful passthrough.
    if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
      if (Buffer.byteLength(block.data, "utf8") <= IMAGE_BYTES) {
        blocks.push({ type: "image", data: block.data, mimeType: block.mimeType });
        continue;
      }
      blocks.push({
        type: "text",
        text: `[image ${block.mimeType}: ${Buffer.byteLength(block.data, "utf8")} bytes, omitted]`,
      });
      continue;
    }
    // Audio/resource/embedded_resource and unknown blocks: deterministic
    // metadata text, never raw base64 payloads (not model-readable).
    blocks.push({ type: "text", text: describeBlock(block) });
  }
  return blocks;
}

/** Compact, deterministic metadata for a block the model cannot read verbatim. */
function describeBlock(block: Record<string, unknown>): string {
  const meta: Record<string, unknown> = { type: block.type ?? "unknown" };
  for (const key of ["mimeType", "name", "uri", "text"]) {
    if (typeof block[key] === "string") meta[key] = block[key];
  }
  for (const key of ["data", "blob"]) {
    if (typeof block[key] === "string") meta[key] = `[${block[key].length} base64 bytes omitted]`;
  }
  const nested = block.resource ?? block.content;
  if (nested && typeof nested === "object") {
    meta[typeof block.resource === "undefined" ? "content" : "resource"] = describeBlock(nested as Record<string, unknown>);
  }
  return stringifyJson(meta);
}

function stringifyJson(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, null, 2);
    // JSON.stringify answers undefined for `undefined` and functions: the
    // model still needs readable text, never a non-string.
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}
