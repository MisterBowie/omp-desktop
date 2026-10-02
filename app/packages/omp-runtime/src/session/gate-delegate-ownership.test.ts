/**
 * Delegate admission ownership (M5/T20-C second review repair, R3).
 *
 * Layer: the real gate's registered handlers, the real state serialization and
 * the real fence/admission codec — the same controlled-callback layer the
 * reviewing root used to reproduce "an old no-UI child is allowed under a newer
 * parent admission". Nothing here executes a provider request or a tool body:
 * these cases pin who may decide a delegate's call, not how the runtime
 * schedules a detached child.
 *
 * The requirement being pinned: a delegate that started under admission A keeps
 * that association — and is refused once A is retired or replaced — instead of
 * being lent whichever admission happens to be live when its call arrives. A
 * delegate never observed under a live admission, and one whose own session
 * header shows it predates the admission, fail closed.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ToolCallEvent } from "../../extensions/omp-desktop-gate.ts";
import { DESKTOP_STATE_FILE, serializeDesktopCapabilityState } from "../desktop-state.js";
import { createGateHandlerHarness, gateTurnAdmission, type GateHandlerHarness } from "./gate-handler-testkit.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const OWNER = "native-owner";
const TOKEN_A = "a".repeat(32);
const TOKEN_B = "b".repeat(32);
const WRITE: ToolCallEvent = {
  type: "tool_call",
  toolCallId: "call-child-write",
  toolName: "write",
  input: { path: "untouched.txt", content: "not-executed" },
};

/** One run root with a state file slot (the mandatory channel's content). */
function world(): { root: string; statePath: string; ownerFile: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-delegate-ownership-")));
  scratch.push(root);
  return { root, statePath: join(root, DESKTOP_STATE_FILE), ownerFile: join(root, "owner-session.jsonl") };
}

/**
 * Write the run-scoped state the owner's start validates against. The gate
 * refuses a start whose file disagrees with the admitted policy, so each
 * admission needs its matching file (the bridge writes both from one prompt).
 */
function writeState(statePath: string, permissionMode: "ask" | "auto"): void {
  writeFileSync(
    statePath,
    serializeDesktopCapabilityState(
      {
        sessionId: OWNER,
        mode: "agent",
        modeBlock: "You are operating in Agent mode.",
        permissionMode,
        skills: [],
        memory: null,
        hostTools: [],
      },
      Date.now(),
    ),
  );
}

/**
 * One admitted parent turn, driven the way the desktop does: fence with the
 * admission payload, then the owner's `before_agent_start` and `agent_start`.
 */
async function admit(
  h: GateHandlerHarness,
  token: string,
  statePath: string,
  permissionMode: "ask" | "auto",
): Promise<void> {
  writeState(statePath, permissionMode);
  h.arm(token, gateTurnAdmission({ sessionId: OWNER, mode: "agent", permissionMode, hostTools: [] }));
  await h.beforeAgentStart();
  h.agentStart();
}

/** A delegate's own start: the parent session started it under the live turn. */
async function childStart(h: GateHandlerHarness, child: Record<string, unknown>): Promise<void> {
  await h.lifecycle("before_agent_start", child);
  await h.lifecycle("agent_start", child);
}

describe("delegate admission ownership", () => {
  it("refuses an old child once its parent turn is replaced, and allows a fresh child under the new one", async () => {
    const { statePath } = world();
    process.env.OMP_DESKTOP_STATE = statePath;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    delete process.env.OMP_DESKTOP_GATE_MODE;
    delete process.env.OMP_DESKTOP_GATE_TOOLS;
    const h = createGateHandlerHarness({ sessionId: OWNER });
    const oldChild = h.delegateContext("child-native-a1");
    const freshChild = h.delegateContext("child-native-b1");

    // 1. Parent A (ask), child A started under it: bound, and its write fails
    //    closed exactly where the decision would have asked.
    await admit(h, TOKEN_A, statePath, "ask");
    await childStart(h, oldChild);
    const underAsk = await h.toolCall(WRITE, oldChild);
    expect(underAsk?.block).toBe(true);
    expect(underAsk?.reason).toMatch(/no interactive UI/);

    // 2. Parent A's terminal end retires the admission; the late child is refused.
    h.agentEnd();
    const late = await h.toolCall(WRITE, oldChild);
    expect(late?.block).toBe(true);
    expect(late?.reason).toMatch(/policy is unavailable/);

    // 3. Parent B (auto) is live: the old child must not inherit it, even
    //    though it is currently the only admission in the process.
    await admit(h, TOKEN_B, statePath, "auto");
    const borrowed = await h.toolCall(WRITE, oldChild);
    expect(borrowed?.block).toBe(true);
    expect(borrowed?.reason).toMatch(/policy is unavailable/);

    // 4. Positive control: a child that starts under B is decided by B — auto
    //    allows the same write with no card.
    await childStart(h, freshChild);
    expect(await h.toolCall(WRITE, freshChild)).toBeUndefined();
    expect(h.dialogs).toHaveLength(0);
  });

  it("binds at the delegate's first lifecycle event (session_start alone is enough)", async () => {
    const { statePath } = world();
    process.env.OMP_DESKTOP_STATE = statePath;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    await admit(h, TOKEN_A, statePath, "auto");
    const child = h.delegateContext("child-native-a2");
    await h.lifecycle("session_start", child);
    expect(await h.toolCall(WRITE, child)).toBeUndefined();
  });

  it("never re-points an already bound child at a newer admission", async () => {
    const { statePath } = world();
    process.env.OMP_DESKTOP_STATE = statePath;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    const child = h.delegateContext("child-native-a3");
    await admit(h, TOKEN_A, statePath, "ask");
    await h.lifecycle("session_start", child);

    // A second lifecycle observation while B is admitted (a resumed/parked
    // worker, a delayed callback) must not move the binding to B.
    await admit(h, TOKEN_B, statePath, "auto");
    await h.lifecycle("session_start", child);
    await h.lifecycle("agent_start", child);
    const verdict = await h.toolCall(WRITE, child);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toMatch(/policy is unavailable/);
  });

  it("refuses a delegate whose own session header predates the live admission", async () => {
    const { statePath } = world();
    process.env.OMP_DESKTOP_STATE = statePath;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    // Created a minute before this turn was armed: a delayed start, not a child
    // of this turn. Its first observation under A records it as unattributable.
    const stale = h.delegateContext("child-native-stale", {
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    await admit(h, TOKEN_A, statePath, "auto");
    await h.lifecycle("session_start", stale);
    const refused = await h.toolCall(WRITE, stale);
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toMatch(/policy is unavailable/);

    // A later, more permissive admission does not revive it either.
    h.agentEnd();
    await admit(h, TOKEN_B, statePath, "auto");
    await h.lifecycle("session_start", stale);
    expect((await h.toolCall(WRITE, stale))?.block).toBe(true);
  });

  it("checks the declared parentage chain against the admission's owning session file", async () => {
    const { root, statePath, ownerFile } = world();
    process.env.OMP_DESKTOP_STATE = statePath;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER, ownerFile });
    await admit(h, TOKEN_A, statePath, "auto");

    // A direct child of the owning session: its parent file is the owner's file.
    const directFile = join(root, "direct.jsonl");
    const direct = h.delegateContext("child-native-direct", { file: directFile, parentFile: ownerFile });
    await h.lifecycle("session_start", direct);
    expect(await h.toolCall(WRITE, direct)).toBeUndefined();

    // A child of some other session: its chain never reaches this owner.
    const foreign = h.delegateContext("child-native-foreign", {
      file: join(root, "foreign.jsonl"),
      parentFile: join(root, "another-session.jsonl"),
    });
    await h.lifecycle("session_start", foreign);
    const refused = await h.toolCall(WRITE, foreign);
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toMatch(/policy is unavailable/);

    // A nested delegate resolves through the intermediate recorded above.
    const nested = h.delegateContext("child-native-nested", {
      file: join(root, "nested.jsonl"),
      parentFile: directFile,
    });
    await h.lifecycle("session_start", nested);
    expect(await h.toolCall(WRITE, nested)).toBeUndefined();
  });

  it("keeps the owner's own calls and a foreign interactive session on their existing rules", async () => {
    const { statePath } = world();
    process.env.OMP_DESKTOP_STATE = statePath;
    process.env.OMP_DESKTOP_STATE_REQUIRED = "1";
    const h = createGateHandlerHarness({ sessionId: OWNER });
    await admit(h, TOKEN_A, statePath, "auto");

    // The owner is decided by its own admission: auto allows, no card.
    expect(await h.toolCall(WRITE)).toBeUndefined();
    // A foreign interactive session is still refused, never lent the policy.
    const foreign = await h.toolCall(WRITE, h.foreignContext("native-elsewhere"));
    expect(foreign?.block).toBe(true);
    expect(foreign?.reason).toMatch(/policy is unavailable/);
    expect(h.dialogs).toHaveLength(0);
  });

  it("keeps the legacy fixture path (channel off) on its disk-driven delegate cache", async () => {
    const { statePath } = world();
    process.env.OMP_DESKTOP_STATE = statePath;
    delete process.env.OMP_DESKTOP_STATE_REQUIRED;
    const h = createGateHandlerHarness({ sessionId: OWNER });
    // The admitted record is process-scoped (a delegate runner sees the owning
    // session's turn), so retire any turn an earlier scenario left live.
    h.agentEnd();
    // The legacy path never arms a fence. The owner's own call performs the
    // pre-repair disk read and fills the cache; a no-UI call then falls back to
    // that cache, exactly as before this repair.
    const owner = await h.toolCall(WRITE);
    expect(owner?.block).toBe(true);
    const child = h.delegateContext("child-native-a4");
    const verdict = await h.toolCall(WRITE, child);
    expect(verdict?.block).toBe(true);
    expect(verdict?.reason).toMatch(/no interactive UI/);
  });
});
