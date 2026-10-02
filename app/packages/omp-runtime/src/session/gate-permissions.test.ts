/**
 * M5/T20-C: the execution-time permission decision table (PI §1.3.1).
 *
 * `decideToolCall` is the gate's exported decision seam; these tests drive it
 * with the same run-scoped snapshot the desktop writes (mode, effective
 * permission mode, host-tool policy table) and assert PI's decision order:
 * contract hard-deny → external path → risk/mode/grant → card, with the
 * legacy fixture switch strictly below the contract deny.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { OMP_APPROVAL_OPTIONS } from "./approval-protocol.js";
import {
  DESKTOP_STATE_ENV,
  DESKTOP_STATE_FILE,
  DESKTOP_STATE_REQUIRED_ENV,
  MAX_DESKTOP_STATE_AGE_MS,
  serializeDesktopCapabilityState,
  writeDesktopCapabilityState,
} from "../desktop-state.js";
import {
  contractActiveToolNames,
  contractAllowsTool,
  decideToolCall,
  nativeRiskForTool,
  parseGatedTools,
  toolRiskForCall,
  type ToolCallPolicySnapshot,
} from "../../extensions/omp-desktop-gate.ts";
import ompDesktopGate from "../../extensions/omp-desktop-gate.ts";
import { mintTurnToken, OMP_TURN_COMMAND } from "./turn-fence.js";

const scratch = [];

/** A project root plus one file outside it, a symlink alias and a scratch root. */
function makeWorld() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "t20c-gate-")));
  scratch.push(root);
  const project = join(root, "project");
  const outside = join(root, "outside");
  const scratchRoot = join(root, "scratch");
  mkdirSync(project);
  mkdirSync(outside);
  mkdirSync(scratchRoot);
  writeFileSync(join(project, "inside.txt"), "inside\n");
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(outside, join(project, "alias"));
  return {
    root,
    project,
    outside,
    scratchRoot,
    context: {
      cwd: project,
      sessionManager: { getSessionId: () => "omp-session-1", getCwd: () => project },
      hasUI: true,
    },
  };
}

afterAll(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

const EVENT = {
  type: "tool_call" as const,
  toolCallId: "call_1",
  toolName: "write",
  input: { path: "/tmp/x", content: "x" },
};

const HOST_TOOLS = {
  pluginSafeLow: { name: "plugin_demo_inspect", risk: "low" as const, planSafeActions: ["inspect"], origin: "plugin" as const },
  pluginPlainHigh: { name: "plugin_demo_run", risk: "high" as const, planSafeActions: [], origin: "plugin" as const },
  mcp: { name: "mcp_alpha_lookup", risk: "low" as const, planSafeActions: [], origin: "user-mcp" as const },
};

function snapshot(
  mode: "agent" | "plan" | "goal",
  permissionMode: "ask" | "accept-edits" | "auto",
  hostTools: ToolCallPolicySnapshot["hostTools"] = [],
): ToolCallPolicySnapshot {
  return { mode, permissionMode, hostTools };
}

function policy(overrides: Record<string, unknown> = {}) {
  return {
    gated: parseGatedTools(undefined),
    mode: "ask" as const,
    timeoutMs: 1_000,
    sessionAllowed: new Set<string>(),
    ...overrides,
  };
}

/** A context whose select records the dialog and answers with `answer`. */
function cardContext(world, answer = OMP_APPROVAL_OPTIONS[0]) {
  const cards = [];
  return {
    cards,
    context: {
      ...world.context,
      ui: {
        select: async (title, items) => {
          cards.push({
            title,
            descriptor: JSON.parse(items[0].description),
          });
          return answer;
        },
      },
    },
  };
}

const CONTRACT_FORBIDDEN = [
  ["write", { path: "/tmp/project/a.txt", content: "x" }],
  ["edit", { path: "/tmp/project/a.txt", old_string: "a", new_string: "b" }],
  ["apply_patch", { patch: "*** Begin Patch" }],
  ["eval", { code: "process.exit(0)" }],
  ["browser", { url: "https://example.com" }],
  ["computer", { action: "screenshot" }],
  ["todo", { todos: [] }],
  ["mcp_alpha_lookup", { query: "q" }],
  ["plugin_demo_run", { action: "run" }],
];

describe("C1 contract hard deny", () => {
  it("denies every forbidden tool in Plan and Goal under every permission mode and the legacy allow switch", async () => {
    const world = makeWorld();
    for (const mode of ["plan", "goal"] as const) {
      for (const permissionMode of ["ask", "accept-edits", "auto"] as const) {
        for (const [toolName, input] of CONTRACT_FORBIDDEN) {
          const { context, cards } = cardContext(world);
          const granted = policy({
            mode: "allow",
            sessionAllowed: new Set([toolName]),
            snapshot: snapshot(mode, permissionMode, [HOST_TOOLS.pluginPlainHigh, HOST_TOOLS.mcp]),
          });
          const verdict = await decideToolCall({ ...EVENT, toolName, input }, context, granted);
          expect(verdict, `${mode}/${permissionMode}/${toolName}`).toMatchObject({
            block: true,
            route: "contract-deny",
          });
          expect(verdict.reason, `${mode}/${permissionMode}/${toolName}`).toMatch(/DISABLED_IN_PLAN/);
          expect(cards.length, `${toolName} must not raise a card`).toBe(0);
        }
      }
    }
  });

  it("applies the PI rejection codes to the tool class", async () => {
    const world = makeWorld();
    const snapshotPlan = snapshot("plan", "auto", [HOST_TOOLS.pluginPlainHigh]);
    const write = await decideToolCall({ ...EVENT, toolName: "write" }, world.context, policy({ snapshot: snapshotPlan }));
    const edit = await decideToolCall({ ...EVENT, toolName: "edit" }, world.context, policy({ snapshot: snapshotPlan }));
    const plugin = await decideToolCall(
      { ...EVENT, toolName: "plugin_demo_run", input: { action: "run" } },
      world.context,
      policy({ snapshot: snapshotPlan }),
    );
    const unknown = await decideToolCall(
      { ...EVENT, toolName: "ast_edit", input: {} },
      world.context,
      policy({ snapshot: snapshotPlan }),
    );
    expect(write.reason).toMatch(/^WRITE_DISABLED_IN_PLAN/);
    expect(edit.reason).toMatch(/^EDIT_DISABLED_IN_PLAN/);
    expect(plugin.reason).toMatch(/^PLUGIN_DISABLED_IN_PLAN/);
    expect(unknown.reason).toMatch(/^TOOL_DISABLED_IN_PLAN/);
  });

  it("keeps the PI contract core available: read/glob/grep/ask without a card, bash through the permission mode", async () => {
    const world = makeWorld();
    const ask = snapshot("plan", "ask", [HOST_TOOLS.pluginSafeLow]);
    for (const toolName of ["read", "glob", "grep", "ask"]) {
      const { context, cards } = cardContext(world);
      const verdict = await decideToolCall(
        { ...EVENT, toolName, input: { path: join(world.project, "inside.txt") } },
        context,
        policy({ snapshot: ask }),
      );
      expect(verdict, toolName).toMatchObject({ block: false, route: "contract-allow" });
      expect(cards.length, toolName).toBe(0);
    }
    // A declared plan-safe plugin falls through the contract carve-out to the
    // ordinary permission table (low risk → allow in ask).
    const safe = await decideToolCall(
      { ...EVENT, toolName: "plugin_demo_inspect", input: { action: "inspect" } },
      world.context,
      policy({ snapshot: ask }),
    );
    expect(safe).toMatchObject({ block: false, route: "low-risk" });
    // PI-only contract names are judged by the PI allowlist, never fabricated.
    expect(contractAllowsTool("BrowserPreview", [])).toBe(true);
    expect(contractAllowsTool("new_context", [])).toBe(true);
    expect(contractAllowsTool("browser", [])).toBe(false);
    expect(contractAllowsTool("computer", [])).toBe(false);
    // The clamp (B1) still never invents BrowserPreview.
    expect(contractActiveToolNames({ hostTools: [] }, ["read", "write", "BrowserPreview"])).toEqual(["read"]);
  });
});

describe("C2 Bash permission semantics (no command classifier)", () => {
  it("decides Bash only by the effective permission mode", async () => {
    const world = makeWorld();
    const ask = snapshot("plan", "ask", []);
    const acceptEdits = snapshot("plan", "accept-edits", []);
    const auto = snapshot("plan", "auto", []);

    for (const command of ["ls -la", "rm -rf /tmp/x"]) {
      const { context: askContext, cards: askCards } = cardContext(world);
      expect(
        (await decideToolCall({ ...EVENT, toolName: "bash", input: { command } }, askContext, policy({ snapshot: ask }))).route,
        command,
      ).toBe("allow-once");
      expect(askCards.length, command).toBe(1);
      const { context: acceptContext, cards: acceptCards } = cardContext(world);
      expect(
        (
          await decideToolCall(
            { ...EVENT, toolName: "bash", input: { command } },
            acceptContext,
            policy({ snapshot: acceptEdits }),
          )
        ).route,
        command,
      ).toBe("allow-once");
      expect(acceptCards.length, command).toBe(1);
      expect(
        (await decideToolCall({ ...EVENT, toolName: "bash", input: { command } }, world.context, policy({ snapshot: auto })))
          .route,
        command,
      ).toBe("auto-allow");
    }
    // Agent + auto allows Bash too (PI: auto allows High).
    expect(
      (
        await decideToolCall(
          { ...EVENT, toolName: "bash", input: { command: "rm -rf /tmp/x" } },
          world.context,
          policy({ snapshot: snapshot("agent", "auto", []) }),
        )
      ).route,
    ).toBe("auto-allow");
  });
});

describe("C5 high-permission OMP tools", () => {
  it("treats browser/computer/eval as PI-unknown Medium: card in ask/accept-edits, allow in auto, deny in contract modes", async () => {
    const world = makeWorld();
    for (const toolName of ["browser", "computer", "eval"]) {
      const { context: askContext, cards } = cardContext(world);
      await decideToolCall({ ...EVENT, toolName, input: {} }, askContext, policy({ snapshot: snapshot("agent", "ask", []) }));
      expect(cards[0]?.descriptor.risk, toolName).toBe("medium");
      const { context: acceptContext, cards: acceptCards } = cardContext(world);
      await decideToolCall(
        { ...EVENT, toolName, input: {} },
        acceptContext,
        policy({ snapshot: snapshot("agent", "accept-edits", []) }),
      );
      expect(acceptCards.length, toolName).toBe(1);
      expect(
        (await decideToolCall({ ...EVENT, toolName, input: {} }, world.context, policy({ snapshot: snapshot("agent", "auto", []) })))
          .route,
        toolName,
      ).toBe("auto-allow");
      for (const mode of ["plan", "goal"] as const) {
        for (const permissionMode of ["ask", "auto"] as const) {
          expect(
            (
              await decideToolCall(
                { ...EVENT, toolName, input: {} },
                world.context,
                policy({ snapshot: snapshot(mode, permissionMode, []) }),
              )
            ).route,
            `${mode}/${permissionMode}/${toolName}`,
          ).toBe("contract-deny");
        }
      }
    }
  });
});

describe("C6 effective permission modes", () => {
  it("applies exactly the resolved mode from the snapshot", async () => {
    const world = makeWorld();
    const writeEvent = { ...EVENT, toolName: "write", input: { path: join(world.project, "a.txt"), content: "x" } };
    // auto allows High without a card even when the legacy switch says ask.
    const auto = await decideToolCall(writeEvent, world.context, policy({ mode: "ask", snapshot: snapshot("agent", "auto", []) }));
    expect(auto).toMatchObject({ block: false, route: "auto-allow" });
    // accept-edits auto-accepts Write and Edit only.
    const acceptWrite = await decideToolCall(
      writeEvent,
      world.context,
      policy({ snapshot: snapshot("agent", "accept-edits", []) }),
    );
    expect(acceptWrite).toMatchObject({ block: false, route: "accept-edits-allow" });
    const acceptPatch = await decideToolCall(
      { ...EVENT, toolName: "apply_patch", input: { patch: "p" } },
      world.context,
      policy({ snapshot: snapshot("agent", "accept-edits", []) }),
    );
    expect(acceptPatch).toMatchObject({ block: true, route: "no-ui" });
    // ask needs the card.
    const { context, cards } = cardContext(world);
    await decideToolCall(writeEvent, context, policy({ snapshot: snapshot("agent", "ask", []) }));
    expect(cards[0]?.descriptor.permissionMode).toBe("ask");
  });
});

describe("C7 risk fidelity", () => {
  it("maps native names by PI's table and everything unknown to Medium", () => {
    expect(nativeRiskForTool("Read")).toBe("low");
    expect(nativeRiskForTool("read")).toBe("low");
    expect(nativeRiskForTool("glob")).toBe("low");
    expect(nativeRiskForTool("grep")).toBe("low");
    expect(nativeRiskForTool("Write")).toBe("high");
    expect(nativeRiskForTool("bash")).toBe("high");
    expect(nativeRiskForTool("apply_patch")).toBe("medium");
    expect(nativeRiskForTool("eval")).toBe("medium");
    expect(nativeRiskForTool("browser")).toBe("medium");
    expect(nativeRiskForTool("BrowserPreview")).toBe("medium");
    expect(nativeRiskForTool("some_future_tool")).toBe("medium");
  });

  it("takes host-tool risk from the declared policy table, never from the name prefix", () => {
    const hostTools = [HOST_TOOLS.pluginSafeLow, HOST_TOOLS.pluginPlainHigh, HOST_TOOLS.mcp];
    expect(toolRiskForCall("plugin_demo_inspect", hostTools)).toBe("low");
    expect(toolRiskForCall("plugin_demo_run", hostTools)).toBe("high");
    expect(toolRiskForCall("mcp_alpha_lookup", hostTools)).toBe("low");
    // Unregistered host tools fall back to PI's defaults.
    expect(toolRiskForCall("plugin_unregistered", [])).toBe("medium");
    expect(toolRiskForCall("mcp_unregistered", [])).toBe("low");
  });

  it("allows declared-low plugins and user MCP in Agent ask, cards declared-high plugins", async () => {
    const world = makeWorld();
    const hostTools = [HOST_TOOLS.pluginSafeLow, HOST_TOOLS.pluginPlainHigh, HOST_TOOLS.mcp];
    const agentAsk = snapshot("agent", "ask", hostTools);
    expect(
      (await decideToolCall({ ...EVENT, toolName: "mcp_alpha_lookup", input: {} }, world.context, policy({ snapshot: agentAsk })))
        .route,
    ).toBe("low-risk");
    expect(
      (await decideToolCall({ ...EVENT, toolName: "plugin_demo_inspect", input: {} }, world.context, policy({ snapshot: agentAsk })))
        .route,
    ).toBe("low-risk");
    const { context, cards } = cardContext(world);
    await decideToolCall(
      { ...EVENT, toolName: "plugin_demo_run", input: {} },
      context,
      policy({ snapshot: agentAsk }),
    );
    expect(cards[0]?.descriptor.risk).toBe("high");
  });

  it("keeps mcp_* Low only outside contract modes", async () => {
    const world = makeWorld();
    const hostTools = [HOST_TOOLS.mcp];
    expect(
      (
        await decideToolCall(
          { ...EVENT, toolName: "mcp_alpha_lookup", input: {} },
          world.context,
          policy({ snapshot: snapshot("goal", "auto", hostTools) }),
        )
      ).route,
    ).toBe("contract-deny");
    expect(
      (
        await decideToolCall(
          { ...EVENT, toolName: "mcp_alpha_lookup", input: {} },
          world.context,
          policy({ mode: "allow", snapshot: snapshot("plan", "ask", hostTools) }),
        )
      ).route,
    ).toBe("contract-deny");
  });

  it("cards BrowserPreview in contract ask (Medium) and allows it in contract auto, unlike Low reads", async () => {
    const world = makeWorld();
    const { context, cards } = cardContext(world);
    await decideToolCall(
      { ...EVENT, toolName: "BrowserPreview", input: { url: "https://example.com" } },
      context,
      policy({ snapshot: snapshot("plan", "ask", []) }),
    );
    expect(cards.length).toBe(1);
    expect(cards[0]?.descriptor.risk).toBe("medium");
    expect(
      (
        await decideToolCall(
          { ...EVENT, toolName: "BrowserPreview", input: { url: "https://example.com" } },
          world.context,
          policy({ snapshot: snapshot("plan", "auto", []) }),
        )
      ).route,
    ).toBe("auto-allow");
  });
});

describe("C8 external paths", () => {
  it("asks for an external path unless auto or granted, and never treats it as Low", async () => {
    const world = makeWorld();
    const readOutside = {
      ...EVENT,
      toolName: "read",
      input: { path: join(world.outside, "secret.txt") },
    };
    const asked = await decideToolCall(readOutside, world.context, policy({ snapshot: snapshot("agent", "ask", []) }));
    expect(asked).toMatchObject({ block: true, route: "no-ui" });
    const { context: uiContext, cards: uiCards } = cardContext(world);
    const allowed = await decideToolCall(readOutside, uiContext, policy({ snapshot: snapshot("agent", "ask", []) }));
    expect(allowed).toMatchObject({ block: false, route: "allow-once" });
    expect(uiCards[0]?.descriptor.reason).toMatch(/external path/);
    expect(
      (await decideToolCall(readOutside, world.context, policy({ snapshot: snapshot("agent", "auto", []) }))).route,
    ).toBe("external-allow");
    expect(
      (
        await decideToolCall(
          readOutside,
          world.context,
          policy({ snapshot: snapshot("agent", "ask", []), sessionAllowed: new Set(["read"]) }),
        )
      ).route,
    ).toBe("external-grant");
    // The same tool on an inside path stays Low.
    expect(
      (
        await decideToolCall(
          { ...readOutside, input: { path: join(world.project, "inside.txt") } },
          world.context,
          policy({ snapshot: snapshot("agent", "ask", []) }),
        )
      ).route,
    ).toBe("not-gated");
  });

  it("resolves .. and symlink aliases before deciding, and honors PI's scratch exception", async () => {
    const world = makeWorld();
    // `project/alias/secret.txt` is lexically inside the workspace but resolves
    // outside it: it must be external.
    const alias = { ...EVENT, toolName: "read", input: { path: join(world.project, "alias", "secret.txt") } };
    expect(
      (await decideToolCall(alias, world.context, policy({ snapshot: snapshot("agent", "ask", []) }))).route,
    ).toBe("no-ui");
    // `project/../outside/secret.txt` must be external too.
    const dotdot = {
      ...EVENT,
      toolName: "read",
      input: { path: join(world.project, "..", "outside", "secret.txt") },
    };
    expect(
      (await decideToolCall(dotdot, world.context, policy({ snapshot: snapshot("agent", "ask", []) }))).route,
    ).toBe("no-ui");
  });

  it("fails closed without a UI only when the decision needs the interaction", async () => {
    const world = makeWorld();
    const noUi = { ...world.context, hasUI: false, ui: undefined };
    const writeEvent = { ...EVENT, toolName: "write", input: { path: join(world.project, "a.txt"), content: "x" } };
    expect((await decideToolCall(writeEvent, noUi, policy({ snapshot: snapshot("agent", "ask", []) }))).route).toBe("no-ui");
    expect(
      (await decideToolCall(writeEvent, noUi, policy({ snapshot: snapshot("agent", "auto", []) }))).route,
    ).toBe("auto-allow");
    expect(
      (
        await decideToolCall(
          { ...EVENT, toolName: "read", input: { path: join(world.project, "inside.txt") } },
          noUi,
          policy({ snapshot: snapshot("agent", "ask", []) }),
        )
      ).route,
    ).toBe("not-gated");
    expect(
      (
        await decideToolCall(
          writeEvent,
          noUi,
          policy({ snapshot: snapshot("agent", "ask", []), sessionAllowed: new Set(["write"]) }),
        )
      ).route,
    ).toBe("session-grant");
    const external = {
      ...EVENT,
      toolName: "read",
      input: { path: join(world.outside, "secret.txt") },
    };
    expect((await decideToolCall(external, noUi, policy({ snapshot: snapshot("agent", "ask", []) }))).route).toBe("no-ui");
    expect(
      (await decideToolCall(external, noUi, policy({ snapshot: snapshot("agent", "auto", []) }))).route,
    ).toBe("external-allow");
  });
});

describe("C4 delegates and unavailable policy", () => {
  it("decides a delegate (hasUI=false) call under the same snapshot: no card, fail closed when interaction is needed", async () => {
    const world = makeWorld();
    const delegate = { ...world.context, hasUI: false, ui: undefined };
    const writeEvent = { ...EVENT, toolName: "write", input: { path: join(world.project, "a.txt"), content: "x" } };
    expect((await decideToolCall(writeEvent, delegate, policy({ snapshot: snapshot("agent", "ask", []) }))).route).toBe("no-ui");
    expect(
      (await decideToolCall(writeEvent, delegate, policy({ snapshot: snapshot("agent", "auto", []) }))).route,
    ).toBe("auto-allow");
    // A contract mode binds the delegate exactly like the parent: no elevation.
    expect(
      (await decideToolCall(writeEvent, delegate, policy({ snapshot: snapshot("plan", "auto", []) }))).route,
    ).toBe("contract-deny");
    expect(
      (
        await decideToolCall(
          { ...EVENT, toolName: "mcp_alpha_lookup", input: {} },
          delegate,
          policy({ snapshot: snapshot("plan", "auto", [HOST_TOOLS.mcp]) }),
        )
      ).route,
    ).toBe("contract-deny");
  });

  it("blocks every call when the mandatory channel has no usable policy", async () => {
    const world = makeWorld();
    for (const toolName of ["read", "write", "plugin_demo_run"]) {
      const verdict = await decideToolCall(
        { ...EVENT, toolName, input: { path: join(world.project, "inside.txt") } },
        world.context,
        policy({ policyUnavailable: true }),
      );
      expect(verdict, toolName).toMatchObject({ block: true, route: "policy-unavailable" });
    }
  });
});

describe("shared policy values", () => {
  it("consumes the snapshot's effective permission mode verbatim", async () => {
    const world = makeWorld();
    const writeEvent = { ...EVENT, toolName: "write", input: { path: join(world.project, "a.txt"), content: "x" } };
    const { context, cards } = cardContext(world);
    await decideToolCall(writeEvent, context, policy({ snapshot: snapshot("agent", "ask", []) }));
    expect(cards.length).toBe(1);
    expect(cards[0]?.descriptor).toMatchObject({ mode: "agent", permissionMode: "ask", risk: "high" });
    const { context: autoContext, cards: autoCards } = cardContext(world);
    expect(
      (await decideToolCall(writeEvent, autoContext, policy({ snapshot: snapshot("agent", "auto", []) }))).route,
    ).toBe("auto-allow");
    expect(autoCards.length).toBe(0);
  });
});

describe("registered handler: admitted-turn ownership and the delegate policy", () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    for (const key of [DESKTOP_STATE_ENV, DESKTOP_STATE_REQUIRED_ENV]) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    vi.useRealTimers();
  });

  function gateHarness(world) {
    const runRoot = join(world.root, "run");
    mkdirSync(runRoot, { recursive: true });
    const statePath = join(runRoot, DESKTOP_STATE_FILE);
    const handlers = new Map();
    const commands = new Map();
    const gatePi = {
      on: (event, handler) => {
        handlers.set(event, handler);
      },
      registerCommand: (name, definition) => {
        commands.set(name, definition.handler);
      },
      getActiveTools: () => [],
      setActiveTools: async () => undefined,
      logger: { warn: () => undefined },
    };
    process.env[DESKTOP_STATE_ENV] = statePath;
    process.env[DESKTOP_STATE_REQUIRED_ENV] = "1";
    ompDesktopGate(gatePi);
    const writeState = (sessionId, mode, permissionMode, writtenAt = Date.now()) => {
      writeDesktopCapabilityState(
        statePath,
        serializeDesktopCapabilityState(
          { sessionId, mode, modeBlock: `block:${mode}`, permissionMode, skills: [], hostTools: [] },
          writtenAt,
        ),
      );
    };
    const run = (event, payload, context) => handlers.get(event)?.(payload, context);
    return {
      statePath,
      writeState,
      call: (event, context) => run("tool_call", event, context),
      // One admitted turn without a desktop payload: a fresh fence token is
      // armed, then the first validated read of the fenced turn becomes its
      // frozen admission (the payload-less host shape the canonical gate
      // fixtures drive). The token is what makes each call a *new* turn.
      beginTurn: async (context) => {
        const command = commands.get(OMP_TURN_COMMAND);
        command(mintTurnToken(), context);
        await run("before_agent_start", { type: "before_agent_start", systemPrompt: ["native"] }, context);
        run("agent_start", { type: "agent_start" }, context);
      },
      endTurn: (context) => run("agent_end", { type: "agent_end" }, context),
    };
  }

  it("freezes the first validated read for the turn, and a rewrite mid-turn does not move the decision", async () => {
    const world = makeWorld();
    const { writeState, call, beginTurn, endTurn } = gateHarness(world);
    const writeEvent = { ...EVENT, toolName: "write", input: { path: join(world.project, "a.txt"), content: "x" } };
    writeState("omp-session-1", "agent", "auto");
    await beginTurn(world.context);
    const auto = cardContext(world);
    expect(await call(writeEvent, auto.context)).toBeUndefined();
    expect(auto.cards.length).toBe(0);

    // Same turn, the file is rewritten to ask: the admission still says auto.
    writeState("omp-session-1", "agent", "ask");
    const frozen = cardContext(world);
    expect(await call(writeEvent, frozen.context)).toBeUndefined();
    expect(frozen.cards.length).toBe(0);

    // The next admitted turn resolves the new setting and cards again.
    endTurn(world.context);
    await beginTurn(world.context);
    const ask = cardContext(world);
    expect(await call(writeEvent, ask.context)).toBeUndefined();
    expect(ask.cards.length).toBe(1);
    const denied = cardContext(world, OMP_APPROVAL_OPTIONS[2]);
    expect(await call(writeEvent, denied.context)).toMatchObject({ block: true });
  });

  it("fails every call closed while the mandatory channel has no admitted record", async () => {
    const world = makeWorld();
    const { statePath, writeState, call, beginTurn, endTurn } = gateHarness(world);
    const read = { ...EVENT, toolName: "read", input: { path: join(world.project, "inside.txt") } };
    // The admitted record is process-scoped by design (a delegate runner must
    // see the owning session's turn), so retire the previous test's turn first.
    endTurn(world.context);
    // No fence and no start yet: nothing may decide from the mutable file.
    writeState("omp-session-1", "agent", "auto");
    expect(await call(read, world.context)).toMatchObject({
      block: true,
      reason: expect.stringMatching(/policy is unavailable/),
    });

    // A malformed owned file refuses the start; the refused turn admits
    // nothing, so calls stay closed.
    writeFileSync(statePath, "{not json");
    await beginTurn(world.context);
    expect(await call(read, world.context)).toMatchObject({
      block: true,
      reason: expect.stringMatching(/policy is unavailable/),
    });

    // A valid file that names another session is never lent to this one.
    writeState("other-session", "agent", "auto");
    await beginTurn(world.context);
    expect(await call(read, world.context)).toMatchObject({
      block: true,
      reason: expect.stringMatching(/policy is unavailable/),
    });
  });

  it("decides a delegate under the owning turn's admitted policy, never a card, never another turn's", async () => {
    const world = makeWorld();
    const { writeState, call, beginTurn, endTurn } = gateHarness(world);
    const writeEvent = { ...EVENT, toolName: "write", input: { path: join(world.project, "a.txt"), content: "x" } };
    const delegate = { cwd: world.project, sessionManager: { getSessionId: () => "omp-child-1" }, hasUI: false };

    writeState("omp-session-1", "agent", "ask");
    await beginTurn(world.context);
    expect(await call(writeEvent, delegate)).toMatchObject({
      block: true,
      reason: expect.stringMatching(/no interactive UI/),
    });
    // The file says auto now, but the admitted turn is the authority.
    writeState("omp-session-1", "agent", "auto");
    expect(await call(writeEvent, delegate)).toMatchObject({ block: true });

    // The next admitted turn is auto; the delegate follows it without a card.
    endTurn(world.context);
    await beginTurn(world.context);
    expect(await call(writeEvent, delegate)).toBeUndefined();

    // A contract turn hard-denies the same write for the delegate.
    endTurn(world.context);
    writeState("omp-session-1", "plan", "auto");
    await beginTurn(world.context);
    expect(await call(writeEvent, delegate)).toMatchObject({ block: true, reason: /WRITE_DISABLED_IN_PLAN/ });

    // A retired turn leaves no policy to borrow.
    endTurn(world.context);
    expect(await call(writeEvent, delegate)).toMatchObject({
      block: true,
      reason: expect.stringMatching(/policy is unavailable/),
    });
  });
});
