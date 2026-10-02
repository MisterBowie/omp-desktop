/**
 * The gate's admitted-turn ownership (M5/T20-C review repair, R1/R2).
 *
 * The production counterexample these tests encode: inside one admitted
 * Plan/ask prompt, the first Bash call is approved once, and the tool body
 * rewrites the run-scoped state file (`permissionMode: "auto"`); the *next*
 * Bash call in the same prompt must still require approval. The decision may
 * come only from the immutable admission installed by the fence — never from a
 * mutable file, an earlier turn, or another session's policy.
 *
 * These are registered-handler tests with the real gate, the real state
 * serialization and the real admission codec; the native-body counterexamples
 * run in `apps/desktop/test/omp-execution-policy-e2e.test.mjs`.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ToolCallEvent } from "../../extensions/omp-desktop-gate.ts";
import {
  DESKTOP_STATE_FILE,
  serializeDesktopCapabilityState,
  type DesktopHostToolPolicy,
  type DesktopRuntimeMode,
} from "../desktop-state.js";
import { OMP_APPROVAL_OPTIONS, parseApprovalDescriptor } from "./approval-protocol.js";
import { createGateHandlerHarness, type GateHandlerHarness } from "./gate-handler-testkit.js";
import type { OmpStartRefusal } from "./start-refusal.js";
import { parseStartRefusalNotice } from "./start-refusal.js";
import { parseTurnAckNotice } from "./turn-fence.js";
import { encodeTurnAdmission, type OmpTurnAdmission } from "./turn-admission.js";

const created: string[] = [];
afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.OMP_DESKTOP_STATE;
  delete process.env.OMP_DESKTOP_STATE_REQUIRED;
  delete process.env.OMP_DESKTOP_GATE_MODE;
  delete process.env.OMP_DESKTOP_GATE_TOOLS;
});

const NOW = 1_700_000_000_000;
const OWNER = "native-owner";
const PLAN_BLOCK = "You are operating in Plan mode as the same PI-Desktop agent.";
const AGENT_BLOCK = "You are operating in Agent mode. After the user approves a plan.";

/** The harness the tests drive: the shared gate-handler testkit. */
type Harness = GateHandlerHarness;

type StateOverrides = {
  sessionId?: string;
  mode?: DesktopRuntimeMode;
  permissionMode?: "ask" | "accept-edits" | "auto";
  hostTools?: DesktopHostToolPolicy[];
};

/** Write one run-scoped state file (the first call creates its directory). */
function writeState(overrides: StateOverrides = {}, path?: string): string {
  let target = path;
  if (!target) {
    const dir = join(tmpdir(), `omp-gate-admission-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    created.push(dir);
    target = join(dir, DESKTOP_STATE_FILE);
  }
  writeFileSync(
    target,
    serializeDesktopCapabilityState(
      {
        sessionId: overrides.sessionId ?? OWNER,
        mode: overrides.mode ?? "plan",
        modeBlock: (overrides.mode ?? "plan") === "plan" ? PLAN_BLOCK : AGENT_BLOCK,
        permissionMode: overrides.permissionMode ?? "ask",
        skills: [],
        memory: null,
        hostTools: overrides.hostTools ?? [],
      },
      // The gate enforces the freshness window against the wall clock, so the
      // handler-level fixtures must be written "now" (a fixed epoch timestamp
      // would make every state stale and refuse the turn).
      Date.now(),
    ),
  );
  return target;
}

function admission(overrides: Partial<OmpTurnAdmission> = {}): OmpTurnAdmission {
  return {
    v: 1,
    nativeSessionId: OWNER,
    mode: "plan",
    permissionMode: "ask",
    hostTools: [],
    grants: [],
    ...overrides,
  };
}

const BASH: ToolCallEvent = { type: "tool_call", toolCallId: "call-bash", toolName: "bash", input: { command: "true" } };
const WRITE: ToolCallEvent = { type: "tool_call", toolCallId: "call-write", toolName: "write", input: { path: "out.txt", content: "x" } };
const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);

describe("admitted-turn policy ownership", () => {
  it("decides from the fenced admission even when the tool body rewrites the state file mid-turn", async () => {
    const path = writeState({ permissionMode: "ask" });
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission({ permissionMode: "ask" }));
    expect(await h.beforeAgentStart()).toMatchObject({ systemPrompt: ["native prompt", PLAN_BLOCK] });
    h.agentStart();

    // The tool body's write: only the permission mode changes, the file stays
    // valid and owned.
    writeState({ permissionMode: "auto" }, path);
    // The mutation must be invisible to this turn's decision.
    const second = await h.toolCall(BASH);
    expect(second?.block).toBe(true);
    expect(h.dialogs).toHaveLength(1);
    const descriptor = parseApprovalDescriptor(h.dialogs[0]?.items[0]?.description);
    expect(descriptor).toMatchObject({ toolName: "bash", permissionMode: "ask", mode: "plan" });
  });

  it("adopts the first validated read for a payload-less fence and freezes it for the turn", async () => {
    const path = writeState({ permissionMode: "ask" });
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A);
    await h.beforeAgentStart();
    h.agentStart();
    // A file rewrite after the start is a mutation, not a settings change.
    writeState({ permissionMode: "auto" }, path);
    expect((await h.toolCall(BASH))?.block).toBe(true);
    expect(h.dialogs).toHaveLength(1);
  });

  it("replaces the admission wholesale at the next fence, so new settings land on the next turn", async () => {
    const path = writeState({ mode: "agent", permissionMode: "ask" });
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission({ mode: "agent", permissionMode: "ask" }));
    await h.beforeAgentStart();
    h.agentStart();
    expect((await h.toolCall(BASH))?.block).toBe(true);
    expect(h.dialogs).toHaveLength(1);
    h.agentEnd();

    // The next admitted turn resolves the new setting: auto allows Bash with
    // no card, and the old record (and its grants) are gone.
    writeState({ mode: "agent", permissionMode: "auto" }, path);
    h.arm(TOKEN_B, admission({ mode: "agent", permissionMode: "auto" }));
    await h.beforeAgentStart();
    h.agentStart();
    expect(await h.toolCall(BASH)).toBeUndefined();
    expect(h.dialogs).toHaveLength(1);
  });

  it("fails closed for an admission whose turn never started", async () => {
    const path = writeState();
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission());
    const verdict = await h.toolCall(BASH);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toMatch(/policy is unavailable/);
    expect(h.dialogs).toHaveLength(0);
  });

  it("refuses a foreign interactive session and decides a bound delegate under the parent record", async () => {
    const path = writeState();
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission());
    await h.beforeAgentStart();
    h.agentStart();

    const foreign = await h.toolCall(BASH, {
      ...h.context,
      hasUI: true,
      sessionManager: { getSessionId: () => "native-elsewhere", getCwd: () => "/tmp/project" },
    });
    expect(foreign?.block).toBe(true);
    expect(h.dialogs).toHaveLength(0);

    // A delegate (hasUI=false) is decided under the owning session's admitted
    // policy — but only after its own start bound it to that admission
    // (M5/T20-C second repair): Plan/ask Bash asks, and with no UI it fails
    // closed exactly there.
    const delegate = h.delegateContext("native-child");
    await h.lifecycle("session_start", delegate);
    const bound = await h.toolCall(BASH, delegate);
    expect(bound?.block).toBe(true);
    expect(bound?.reason).toMatch(/no interactive UI/);
  });

  it("fails closed for a delegate that was never bound to an admission", async () => {
    const path = writeState();
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission({ mode: "agent", permissionMode: "auto" }));
    await h.beforeAgentStart();
    h.agentStart();

    // No lifecycle event ever named this session: the live admission is never
    // lent to an unknown no-UI context, so even an `auto` call is refused.
    const unobserved = await h.toolCall(BASH, h.delegateContext("native-unseen"));
    expect(unobserved?.block).toBe(true);
    expect(unobserved?.reason).toMatch(/policy is unavailable/);
    expect(h.dialogs).toHaveLength(0);
  });

  it("retires the record on a terminal agent_end but keeps it across a scheduled continuation", async () => {
    const path = writeState();
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission());
    await h.beforeAgentStart();
    h.agentStart();

    h.agentEnd(OWNER, true);
    expect((await h.toolCall(BASH))?.block).toBe(true);
    expect(h.dialogs).toHaveLength(1);

    h.agentEnd();
    const retired = await h.toolCall(BASH);
    expect(retired?.block).toBe(true);
    expect(retired?.reason).toMatch(/policy is unavailable/);
    expect(h.dialogs).toHaveLength(1);
  });

  it("ignores the legacy fixture switch and cannot shrink the product gated set", async () => {
    const path = writeState({ mode: "agent", permissionMode: "ask" });
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    // The ambient fixture switches ask for "allow everything, gate nothing".
    const h = createGateHandlerHarness({ sessionId: OWNER, mode: "allow", gated: "" });
    h.arm(TOKEN_A, admission({ mode: "agent", permissionMode: "ask" }));
    await h.beforeAgentStart();
    h.agentStart();
    // The owned admission still cards the high-risk native write and Bash, and
    // a host tool is still controlled.
    h.answerWith(OMP_APPROVAL_OPTIONS[2]);
    expect((await h.toolCall(BASH))?.block).toBe(true);
    expect((await h.toolCall(WRITE))?.block).toBe(true);
    expect(h.dialogs).toHaveLength(2);
  });

  it("seeds grants from the admission and keeps contract denials above them", async () => {
    const path = writeState({ permissionMode: "auto" });
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission({ permissionMode: "auto", grants: ["bash", "write"] }));
    await h.beforeAgentStart();
    h.agentStart();
    // Plan hard-denies write regardless of the grant or auto.
    const write = await h.toolCall(WRITE);
    expect(write?.block).toBe(true);
    expect(write?.reason).toMatch(/WRITE_DISABLED_IN_PLAN/);
    expect(h.dialogs).toHaveLength(0);
    // The granted contract-allowed Bash passes without a card.
    expect(await h.toolCall(BASH)).toBeUndefined();
  });

  it("mints a grant only from the session option, and only for the current turn", async () => {
    const path = writeState({ mode: "agent", permissionMode: "ask" });
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission({ mode: "agent", permissionMode: "ask" }));
    await h.beforeAgentStart();
    h.agentStart();

    // allow-once does not grant: the next Bash call cards again.
    h.answerWith(OMP_APPROVAL_OPTIONS[0]);
    expect(await h.toolCall(BASH)).toBeUndefined();
    expect(await h.toolCall(BASH)).toBeUndefined();
    expect(h.dialogs).toHaveLength(2);

    // "Allow for this session" grants for the rest of the turn.
    h.answerWith(OMP_APPROVAL_OPTIONS[1]);
    expect(await h.toolCall(WRITE)).toBeUndefined();
    expect(await h.toolCall(WRITE)).toBeUndefined();
    expect(h.dialogs).toHaveLength(3);

    // A new admission without that grant does not inherit it.
    h.agentEnd();
    h.arm(TOKEN_B, admission({ mode: "agent", permissionMode: "ask" }));
    await h.beforeAgentStart();
    h.agentStart();
    h.answerWith(OMP_APPROVAL_OPTIONS[2]);
    expect((await h.toolCall(WRITE))?.block).toBe(true);
    expect(h.dialogs).toHaveLength(4);
  });

  it("verifies the file against the payload and refuses a mismatch", async () => {
    const path = writeState({ permissionMode: "auto" });
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission({ permissionMode: "ask" }));
    await h.beforeAgentStart();
    expect(h.aborted()).toBe(1);
    const refusal = parseStartRefusalNotice({
      type: "extension_ui_request",
      id: "refusal-1",
      method: "notify",
      message: h.notices.at(-1)?.message,
    }) as OmpStartRefusal | null;
    expect(refusal).toMatchObject({ code: "state-mismatch", turnToken: TOKEN_A });
    // The refused turn is retired: a later call cannot borrow its policy.
    const late = await h.toolCall(BASH);
    expect(late?.block).toBe(true);
    expect(late?.reason).toMatch(/policy is unavailable/);
  });

  it("clears the previous admission on any parsed fence, even a malformed payload", async () => {
    const path = writeState();
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    h.arm(TOKEN_A, admission());
    await h.beforeAgentStart();
    h.agentStart();
    expect(await h.toolCall({ ...BASH, toolCallId: "call-1" })).toBeDefined(); // cards (deny)

    const notices = h.notices.length;
    h.arm(`${TOKEN_B} not-an-admission`);
    // No acknowledgment is sent for an undecodable payload, and the previous
    // admission is gone: the runner refuses the prompt and a late call fails
    // closed instead of borrowing the old policy.
    expect(h.notices).toHaveLength(notices);
    const late = await h.toolCall({ ...BASH, toolCallId: "call-2" });
    expect(late?.block).toBe(true);
    expect(late?.reason).toMatch(/policy is unavailable/);
  });

  it("acknowledges a payload fence with the digest of the installed argument", async () => {
    const path = writeState();
    process.env.OMP_DESKTOP_STATE = path;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    const encoded = encodeTurnAdmission(admission());
    h.arm(`${TOKEN_A} ${encoded}`);
    const ack = parseTurnAckNotice({
      type: "extension_ui_request",
      id: "ack",
      method: "notify",
      message: h.notices.at(0)?.message,
    });
    expect(ack).toMatchObject({ token: TOKEN_A });
    expect(ack?.admissionDigest).toMatch(/^[0-9a-f]{64}$/);
  });
});
