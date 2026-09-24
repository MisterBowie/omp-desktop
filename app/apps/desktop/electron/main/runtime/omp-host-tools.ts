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
 *   - Cancellation boundary: plugin agent tools receive the abort signal
 *     (`RegisteredPluginTool.execute` ctx.signal → the plugin runtime's
 *     `sendToChild` aborts the child call, `plugin-runtime.ts`). The MCP
 *     client exposes no call-level signal (`McpServerClient.callTool(name,
 *     args)`), and `UserMcpRuntime.callTool` awaits a connection handshake
 *     before the actual `tools/call` dispatch, so the guarantee is exactly: a
 *     cancellation already observed before the MCP call path is entered
 *     refuses it; once the path is entered, connection or request may
 *     continue and only the cancelled pending entry drops the late completion
 *     — remote side effects are never claimed prevented or retracted (the
 *     fixed Pi client has the same limitation).
 */
import {
  boundHostToolContent,
  type OmpHostToolCall,
  type OmpHostToolContentBlock,
  type OmpHostToolDefinition,
  type OmpHostToolExecutor,
  type OmpHostToolOutcome,
  type OmpHostToolRun,
} from "@pi-desktop/omp-runtime";
import type { RegisteredPluginTool } from "../plugin-runtime";
import type { UserMcpToolDescriptor } from "../user-mcp";

/** The plugin registry slice this adapter reads. */
type PluginToolSource = {
  getTools(): RegisteredPluginTool[];
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

/** One session's binding the executor is scoped to. */
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
};

export type OmpHostToolAdapter = {
  /** The session's tool catalog for one project (never shared across projects). */
  catalog(projectPath: string): Promise<OmpHostToolDefinition[]>;
  /** An executor bound to one session/project, with live re-checks. */
  executor(binding: OmpHostToolBinding): OmpHostToolExecutor;
};

const FALLBACK_SCHEMA = { type: "object", properties: {} } as const;
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
  async function catalog(projectPath: string): Promise<OmpHostToolDefinition[]> {
    // The same assembly `session-launch.ts` performs for the Pi sidecar: the
    // live plugin registry filtered by activation scope, plus every user MCP
    // tool active in this project (which `toolsForProject` already scopes).
    const pluginTools = deps.plugins
      .getTools()
      .filter((tool) => deps.pluginActiveInProject(tool.pluginId, projectPath))
      .map((tool) => ({
        name: tool.fullName,
        description: tool.description,
        parameters: tool.schema ?? FALLBACK_SCHEMA,
      }));
    const userMcpTools = await deps.userMcp.toolsForProject(projectPath);
    const definitions = [
      ...pluginTools,
      ...userMcpTools.map((tool) => ({
        name: tool.fullName,
        description: tool.description,
        parameters: tool.schema ?? FALLBACK_SCHEMA,
      })),
    ].map(toDefinition);
    const seen = new Set<string>();
    for (const definition of definitions) {
      if (seen.has(definition.name)) {
        throw new Error(`duplicate host tool name in the desktop catalog: ${definition.name}`);
      }
      seen.add(definition.name);
    }
    return definitions;
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
    return {
      async execute(call: OmpHostToolCall, run: OmpHostToolRun, signal: AbortSignal): Promise<OmpHostToolOutcome> {
        try {
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
          const modelKey = binding.modelKey();
          const thinkingLevel = binding.thinkingLevel();
          const result = await tool.execute(call.arguments, {
            sessionId: binding.sessionId,
            turnId: run.turnId,
            signal,
            mode: "agent",
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
