/**
 * The independent review's canonical decision matrix, ported (M5/T20-C
 * review repair).
 *
 * The root reviewer ran a controlled 20-case fixture against the registered
 * production gate handlers (`gate-policy-review.mjs`, canonical-workspace
 * variant: 20/20) and an extended fixture that additionally probed the
 * fixture switches (`gate-policy-extended-review.mjs`). This file is the
 * portable product equivalent: real registered handlers, real state
 * serialization, real turn admission, real dialog descriptors — no provider
 * or native body is claimed here (those run in
 * `apps/desktop/test/omp-execution-policy-e2e.test.mjs`).
 *
 * Two extended-fixture observations are pinned as *contract boundaries*
 * rather than repaired, because the production launcher never sets those
 * switches and the "synthetic unknown native name" is not a registered tool:
 *
 *   - the legacy `OMP_DESKTOP_GATE_MODE=allow` switch is ignored for an
 *     admitted turn (Agent/ask still cards; it can neither allow nor deny
 *     around PI's order);
 *   - a native name outside the product's gated set and the host-tool set is
 *     not adjudicated by this gate at all (no card, no refusal). Any unknown
 *     name that *is* adjudicated carries PI's Medium risk — never Low — which
 *     the risk assertions below pin.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  DESKTOP_STATE_FILE,
  serializeDesktopCapabilityState,
  type DesktopHostToolPolicy,
  type DesktopRuntimeMode,
} from "../desktop-state.js";
import { OMP_APPROVAL_OPTIONS, parseApprovalDescriptor } from "./approval-protocol.js";
import { createGateHandlerHarness, gateTurnAdmission } from "./gate-handler-testkit.js";
import { toolRiskForCall } from "../../extensions/omp-desktop-gate.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const savedEnv = { ...process.env };
afterEach(() => {
  for (const key of [
    "OMP_DESKTOP_STATE",
    "OMP_DESKTOP_STATE_REQUIRED",
    "OMP_DESKTOP_GATE_MODE",
    "OMP_DESKTOP_GATE_TOOLS",
  ]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

const OWNER = "native-review";
const TOKEN = "c".repeat(32);

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-t20c-matrix-")));
  scratch.push(root);
  const project = join(root, "project");
  const outside = join(root, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  writeFileSync(join(project, "inside.txt"), "inside");
  writeFileSync(join(outside, "outside.txt"), "outside");
  return { root, project, outside };
}

type Case = {
  name: string;
  mode: DesktopRuntimeMode;
  permission: "ask" | "accept-edits" | "auto";
  tool: string;
  input: Record<string, unknown>;
  host?: DesktopHostToolPolicy;
  /** Fixture switch, set exactly like the review's extended fixture. */
  legacy?: "allow";
  hasUI?: boolean;
  blocked: boolean;
  cards: number;
  risk?: "low" | "medium" | "high";
};

/** The canonical 20 cases plus the two extended-fixture boundaries. */
function cases(project: string, outside: string): Case[] {
  const out = join(project, "out.txt");
  const write = { path: out, content: "x" };
  const plugin = (risk: "low" | "medium", planSafeActions: string[]): DesktopHostToolPolicy => ({
    name: "plugin_review_action",
    risk,
    planSafeActions,
    origin: "plugin",
  });
  const mcp: DesktopHostToolPolicy = { name: "mcp_review_lookup", risk: "low", planSafeActions: [], origin: "user-mcp" };
  return [
    { name: "agent-write-ask-denied-control", mode: "agent", permission: "ask", tool: "write", input: write, blocked: true, cards: 1, risk: "high" },
    { name: "agent-write-auto", mode: "agent", permission: "auto", tool: "write", input: write, blocked: false, cards: 0 },
    { name: "agent-write-accept-edits", mode: "agent", permission: "accept-edits", tool: "write", input: write, blocked: false, cards: 0 },
    { name: "plan-write-auto-legacy-allow", mode: "plan", permission: "auto", legacy: "allow", tool: "write", input: write, blocked: true, cards: 0 },
    { name: "goal-write-auto", mode: "goal", permission: "auto", tool: "write", input: write, blocked: true, cards: 0 },
    { name: "plan-bash-auto", mode: "plan", permission: "auto", tool: "bash", input: { command: "printf review" }, blocked: false, cards: 0 },
    { name: "plan-bash-ask", mode: "plan", permission: "ask", tool: "bash", input: { command: "pwd" }, blocked: true, cards: 1, risk: "high" },
    { name: "goal-bash-accept-edits", mode: "goal", permission: "accept-edits", tool: "bash", input: { command: "pwd" }, blocked: true, cards: 1, risk: "high" },
    { name: "agent-plugin-low-ask", mode: "agent", permission: "ask", tool: "plugin_review_action", host: plugin("low", []), input: { action: "inspect" }, blocked: false, cards: 0 },
    { name: "agent-plugin-medium-ask", mode: "agent", permission: "ask", tool: "plugin_review_action", host: plugin("medium", []), input: { action: "inspect" }, blocked: true, cards: 1, risk: "medium" },
    { name: "plan-plugin-unsafe-auto", mode: "plan", permission: "auto", legacy: "allow", tool: "plugin_review_action", host: plugin("low", []), input: { action: "inspect" }, blocked: true, cards: 0 },
    { name: "plan-plugin-safe-low", mode: "plan", permission: "ask", tool: "plugin_review_action", host: plugin("low", ["inspect"]), input: { action: "inspect" }, blocked: false, cards: 0 },
    { name: "agent-user-mcp-low", mode: "agent", permission: "ask", tool: "mcp_review_lookup", host: mcp, input: { query: "review" }, blocked: false, cards: 0 },
    { name: "goal-user-mcp-auto-legacy-allow", mode: "goal", permission: "auto", legacy: "allow", tool: "mcp_review_lookup", host: mcp, input: { query: "review" }, blocked: true, cards: 0 },
    { name: "agent-read-workspace", mode: "agent", permission: "ask", tool: "read", input: { path: join(project, "inside.txt") }, blocked: false, cards: 0 },
    { name: "agent-read-outside-ask", mode: "agent", permission: "ask", tool: "read", input: { path: join(outside, "outside.txt") }, blocked: true, cards: 1, risk: "low" },
    { name: "agent-read-outside-auto", mode: "agent", permission: "auto", tool: "read", input: { path: join(outside, "outside.txt") }, blocked: false, cards: 0 },
    { name: "agent-read-prefix-sibling", mode: "agent", permission: "ask", tool: "read", input: { path: `${project}-sibling/file.txt` }, blocked: true, cards: 1, risk: "low" },
    { name: "agent-auto-no-ui-at-call", mode: "agent", permission: "auto", tool: "bash", input: { command: "printf review" }, hasUI: false, blocked: false, cards: 0 },
    { name: "agent-ask-no-ui-at-call", mode: "agent", permission: "ask", tool: "bash", input: { command: "printf review" }, hasUI: false, blocked: true, cards: 0 },
    // Extended-fixture boundaries (contract, not defect).
    { name: "agent-write-ask-legacy-allow-is-ignored", mode: "agent", permission: "ask", legacy: "allow", tool: "write", input: write, blocked: true, cards: 1, risk: "high" },
    { name: "agent-unknown-name-not-adjudicated", mode: "agent", permission: "ask", tool: "review_unknown_tool", input: {}, blocked: false, cards: 0 },
  ];
}

describe("independent review decision matrix (ported)", () => {
  it("matches every canonical and extended case through the registered handlers", async () => {
    const { project, outside } = world();
    const runRoot = mkdtempSync(join(tmpdir(), "omp-t20c-matrix-state-"));
    scratch.push(runRoot);
    const statePath = join(runRoot, DESKTOP_STATE_FILE);
    const failures: string[] = [];

    for (const testCase of cases(project, outside)) {
      const hostTools = testCase.host ? [testCase.host] : [];
      process.env.OMP_DESKTOP_STATE = statePath;
      process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
      process.env.OMP_DESKTOP_GATE_MODE = testCase.legacy ?? "ask";
      delete process.env.OMP_DESKTOP_GATE_TOOLS;
      writeFileSync(
        statePath,
        serializeDesktopCapabilityState(
          {
            sessionId: OWNER,
            mode: testCase.mode,
            modeBlock: `block:${testCase.mode}`,
            permissionMode: testCase.permission,
            skills: [],
            memory: null,
            hostTools,
          },
          Date.now(),
        ),
      );
      const h = createGateHandlerHarness({ sessionId: OWNER, cwd: project });
      // The product shape: an admitted turn with the desktop's payload.
      h.arm(TOKEN, gateTurnAdmission({ sessionId: OWNER, mode: testCase.mode, permissionMode: testCase.permission, hostTools }));
      expect(await h.beforeAgentStart()).toBeDefined();
      expect(h.aborted()).toBe(0);
      h.agentStart();
      h.answerWith(OMP_APPROVAL_OPTIONS[2]);
      const context = testCase.hasUI === false ? h.delegateContext() : h.context;
      const verdict = await h.toolCall(
        { type: "tool_call", toolCallId: `call-${testCase.name}`, toolName: testCase.tool, input: testCase.input },
        context,
      );
      const blocked = verdict?.block === true;
      const actualRisk = h.dialogs[0]
        ? parseApprovalDescriptor(h.dialogs[0].items[0]?.description)?.risk
        : undefined;
      const ok =
        blocked === testCase.blocked &&
        h.dialogs.length === testCase.cards &&
        (testCase.risk === undefined || actualRisk === testCase.risk);
      if (!ok) {
        failures.push(
          `${testCase.name}: blocked=${blocked} cards=${h.dialogs.length} risk=${actualRisk} ` +
            `(expected blocked=${testCase.blocked} cards=${testCase.cards} risk=${testCase.risk ?? "-"})`,
        );
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps PI's Medium risk for adjudicated unknown names", () => {
    expect(toolRiskForCall("review_unknown_tool", [])).toBe("medium");
    expect(toolRiskForCall("plugin_review_action", [])).toBe("medium");
    expect(toolRiskForCall("plugin_review_action", [{ name: "plugin_review_action", risk: "low", planSafeActions: [], origin: "plugin" }])).toBe("low");
    expect(toolRiskForCall("mcp_review_lookup", [])).toBe("low");
  });
});
