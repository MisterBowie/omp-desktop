/**
 * Unit coverage for the desktop half of the model-side mode entry (M5/T20-D):
 * the PI-parity `EnterPlanMode`/`EnterGoalMode` definitions and the executor's
 * fail-closed identity checks around the host `plans.enter` call, including the
 * committed-but-unprepared path that must stop the turn instead of reporting a
 * success.
 *
 * The real pinned runtime, the real host database and the trusted gate are
 * exercised by `omp-mode-entry-e2e.test.mjs`; these probes drive the production
 * adapter directly so every refusal path is observable without a provider.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { createOmpHostToolAdapter, desktopEnterToolCatalogEntry, DESKTOP_ENTER_TOOL_KINDS } = await import(
  "../electron/main/runtime/omp-host-tools.ts"
);
const { decodeModeTransitionDetails, encodeModeTransitionDetails, OMP_ENTER_TOOL_NAMES } = await import(
  "@pi-desktop/omp-runtime"
);

const SESSION = "mode-entry-unit";
const RUN = { sessionId: SESSION, turnId: `omp-turn:${SESSION}:1`, generation: 1, hostTurnId: "host-turn-1" };
const PLAN_BLOCK = "You are operating in Plan mode as the same PI-Desktop agent.";
const NEW_HOST_TOOLS = [
  { name: "SubmitPlan", risk: "low", planSafeActions: [], origin: "desktop" },
  { name: "plugin_demo_readonly", risk: "low", planSafeActions: ["read"], origin: "plugin" },
];

function adapterWith(plans) {
  return createOmpHostToolAdapter({
    plugins: { getTools: () => [], getSkills: () => [], loadSkillBody: () => ({ id: "x", name: "x", body: "x" }) },
    userMcp: { toolsForProject: async () => [], callTool: async () => "" },
    pluginActiveInProject: () => true,
    ...(plans ? { plans } : {}),
  });
}

function binding(overrides = {}) {
  return {
    sessionId: SESSION,
    projectPath: "/tmp/omp-mode-entry-unit",
    modelKey: () => null,
    thinkingLevel: () => null,
    dispatchable: () => true,
    modeForTurn: () => "agent",
    nativeSessionId: () => "native-owner",
    enterMode: async (_run, kind) => ({
      modeBlock: kind === "plan" ? PLAN_BLOCK : "GOAL-BLOCK",
      hostTools: kind === "plan" ? NEW_HOST_TOOLS : NEW_HOST_TOOLS.map((tool) => ({ ...tool, name: "SubmitGoal" })),
    }),
    ...overrides,
  };
}

function callFor(toolName, toolCallId = "tc-1", args = {}) {
  return { id: `frame-${toolCallId}`, toolCallId, toolName, arguments: args };
}

function enterHost(overrides = {}) {
  const calls = [];
  const plans = {
    enter: async (input) => {
      calls.push(input);
      return { ok: true, state: "planning", kind: input.kind };
    },
    submit: async () => {
      throw new Error("submit must not be called by an Enter probe");
    },
    ...overrides,
  };
  return { calls, plans };
}

/** A ready host reply for one kind, with `overrides` applied. */
function readyReply(kind, overrides = {}) {
  return { ok: true, state: "planning", kind, ...overrides };
}

test("enter catalog entries carry the PI name/schema and the sole, non-terminating policy", () => {
  assert.deepEqual(DESKTOP_ENTER_TOOL_KINDS, ["plan", "goal"]);
  for (const kind of DESKTOP_ENTER_TOOL_KINDS) {
    const entry = desktopEnterToolCatalogEntry(kind);
    assert.equal(entry.definition.name, OMP_ENTER_TOOL_NAMES[kind]);
    assert.equal(entry.definition.name, kind === "plan" ? "EnterPlanMode" : "EnterGoalMode");
    assert.equal(entry.definition.loadMode, "essential");
    assert.equal(entry.definition.concurrency, "exclusive");
    assert.equal(entry.definition.batchPolicy, "sole");
    // PI's Enter commits the mode and the same turn continues.
    assert.equal(entry.definition.terminateOnSettle, false);
    assert.deepEqual(entry.definition.parameters, { type: "object", properties: {} });
    assert.equal(entry.risk, "low");
    assert.deepEqual(entry.planSafeActions, []);
    assert.equal(entry.origin, "desktop");
  }
  assert.notEqual(
    desktopEnterToolCatalogEntry("plan").definition.description,
    desktopEnterToolCatalogEntry("goal").definition.description,
  );
});

test("enters Plan through the host with the durable identity and returns a ready record", async () => {
  const { calls, plans } = enterHost();
  const executor = adapterWith(plans).executor(binding());
  const outcome = await executor.execute(callFor("EnterPlanMode"), RUN, new AbortController().signal);

  assert.deepEqual(calls, [{ sessionId: SESSION, turnId: "host-turn-1", toolCallId: "tc-1", kind: "plan" }]);
  assert.equal(outcome.isError, undefined);
  assert.match(JSON.stringify(outcome.content), /Plan mode is active\. Inspect the workspace, formulate the plan, then call SubmitPlan for approval\./);

  const record = decodeModeTransitionDetails(outcome.details);
  assert.ok(record);
  assert.equal(record.state, "ready");
  assert.equal(record.kind, "plan");
  // The record names the OMP-native session identity the gate admits against,
  // never the desktop session id.
  assert.equal(record.sessionId, "native-owner");
  assert.equal(record.liveTurnId, RUN.turnId);
  assert.equal(record.hostTurnId, "host-turn-1");
  assert.equal(record.toolCallId, "tc-1");
  assert.equal(record.expectedMode, "agent");
  assert.equal(record.modeBlock, PLAN_BLOCK);
  assert.deepEqual(record.hostTools, NEW_HOST_TOOLS);
});

test("enters Goal through the host and never reads identity from model arguments", async () => {
  const { calls, plans } = enterHost();
  const executor = adapterWith(plans).executor(binding());
  // Model-supplied lookalike fields must be ignored: only the frame and the
  // binding supply identity.
  const outcome = await executor.execute(
    callFor("EnterGoalMode", "tc-goal", {
      sessionId: "forged",
      turnId: "forged",
      toolCallId: "forged",
      kind: "plan",
    }),
    RUN,
    new AbortController().signal,
  );
  assert.deepEqual(calls, [{ sessionId: SESSION, turnId: "host-turn-1", toolCallId: "tc-goal", kind: "goal" }]);
  const record = decodeModeTransitionDetails(outcome.details);
  assert.equal(record?.kind, "goal");
  assert.equal(record?.toolCallId, "tc-goal");
  assert.match(JSON.stringify(outcome.content), /Goal mode is active/);
});

test("refuses a non-Agent turn and a run without a durable host turn before any host call", async () => {
  const contract = enterHost();
  const inPlan = await adapterWith(contract.plans)
    .executor(binding({ modeForTurn: () => "plan" }))
    .execute(callFor("EnterPlanMode"), RUN, new AbortController().signal);
  assert.equal(inPlan.isError, true);
  assert.match(JSON.stringify(inPlan.content), /available only in Agent mode/);
  assert.equal(inPlan.details, undefined);

  const goal = enterHost();
  const inGoal = await adapterWith(goal.plans)
    .executor(binding({ modeForTurn: () => "goal" }))
    .execute(callFor("EnterGoalMode"), RUN, new AbortController().signal);
  assert.equal(inGoal.isError, true);
  assert.match(JSON.stringify(inGoal.content), /available only in Agent mode/);

  const noTurn = enterHost();
  const withoutTurn = await adapterWith(noTurn.plans)
    .executor(binding())
    .execute(callFor("EnterPlanMode", "tc-2"), { ...RUN, hostTurnId: null }, new AbortController().signal);
  assert.equal(withoutTurn.isError, true);
  assert.match(JSON.stringify(withoutTurn.content), /no durable host turn/);
  assert.equal(withoutTurn.details, undefined);

  const unwired = await adapterWith(undefined)
    .executor(binding())
    .execute(callFor("EnterPlanMode", "tc-3"), RUN, new AbortController().signal);
  assert.equal(unwired.isError, true);
  assert.match(JSON.stringify(unwired.content), /not wired/);

  assert.equal(contract.calls.length + goal.calls.length + noTurn.calls.length, 0);
});

test("refuses an already-aborted call without touching the host", async () => {
  const { calls, plans } = enterHost();
  const controller = new AbortController();
  controller.abort(new Error("stopped"));
  // The executor throws for a call that must not start; the runtime package's
  // host-tool bridge maps a thrown execution to a failed result (the same
  // contract the plugin/MCP branches use).
  await assert.rejects(
    () => adapterWith(plans).executor(binding()).execute(callFor("EnterPlanMode", "tc-4"), RUN, controller.signal),
    /cancelled before it started/,
  );
  assert.equal(calls.length, 0);
});

test("refuses to enter without an established native session", async () => {
  const { calls, plans } = enterHost();
  const outcome = await adapterWith(plans)
    .executor(binding({ nativeSessionId: () => null }))
    .execute(callFor("EnterPlanMode", "tc-native"), RUN, new AbortController().signal);
  assert.equal(outcome.isError, true);
  assert.match(JSON.stringify(outcome.content), /no established native session/);
  assert.equal(outcome.details, undefined);
  assert.equal(calls.length, 0);
});

test("records the native session identity the gate validates, not the desktop session id", async () => {
  const { plans } = enterHost();
  const outcome = await adapterWith(plans)
    .executor(binding({ nativeSessionId: () => "omp-native-1" }))
    .execute(callFor("EnterPlanMode", "tc-native-2"), RUN, new AbortController().signal);
  const record = decodeModeTransitionDetails(outcome.details);
  assert.equal(record?.sessionId, "omp-native-1");
  assert.notEqual(record?.sessionId, SESSION);
});

test("reports a host refusal as a correctable error with no transition record", async () => {
  const { plans } = enterHost({
    enter: async () => {
      throw Object.assign(new Error("stale turn"), { data: { errorCode: "PLAN_APPROVAL_STALE" } });
    },
  });
  const outcome = await adapterWith(plans)
    .executor(binding())
    .execute(callFor("EnterPlanMode", "tc-5"), RUN, new AbortController().signal);
  assert.equal(outcome.isError, true);
  assert.match(JSON.stringify(outcome.content), /EnterPlanMode was refused: PLAN_APPROVAL_STALE/);
  assert.equal(outcome.details, undefined);
});

test("an unreadable host reply stops the turn with a failed record instead of a correctable error", async () => {
  // The host may have committed before answering with a shape this build
  // cannot attribute; that uncertainty must stop the turn, never be reported
  // as a correctable refusal the model can retry under a stale contract.
  for (const reply of [
    { ok: false, state: "planning", kind: "plan" },
    { ok: true, state: "awaiting_approval", kind: "plan" },
    { ok: true, state: "planning", kind: "goal" },
    { state: "planning" },
  ]) {
    const { plans } = enterHost({ enter: async () => reply });
    const outcome = await adapterWith(plans)
      .executor(binding())
      .execute(callFor("EnterPlanMode", "tc-6"), RUN, new AbortController().signal);
    assert.equal(outcome.isError, true, JSON.stringify(reply));
    assert.match(JSON.stringify(outcome.content), /unreadable transition result/);
    const record = decodeModeTransitionDetails(outcome.details);
    assert.equal(record?.state, "failed", JSON.stringify(reply));
    assert.equal(record?.kind, "plan");
    assert.equal(record?.toolCallId, "tc-6");
    assert.match(record?.reason ?? "", /committed state cannot be confirmed/);
  }
});

test("only the host's own pre-commit refusals stay correctable", async () => {
  // `PlanManager::enter` authors exactly these codes before its mode CAS can
  // commit; every other failure (a transport error, a timeout, a lost
  // response, an unknown code) is undecidable and must stop the turn.
  for (const code of ["PLAN_INVALID_ARGUMENT", "PLAN_SESSION_NOT_FOUND", "PLAN_ALREADY_ACTIVE", "PLAN_APPROVAL_STALE"]) {
    const { plans } = enterHost({
      enter: async () => {
        throw Object.assign(new Error(code), { data: { errorCode: code } });
      },
    });
    const outcome = await adapterWith(plans)
      .executor(binding())
      .execute(callFor("EnterPlanMode", `tc-${code}`), RUN, new AbortController().signal);
    assert.equal(outcome.isError, true, code);
    assert.match(JSON.stringify(outcome.content), new RegExp(`was refused: ${code}`));
    assert.equal(decodeModeTransitionDetails(outcome.details), null, code);
  }
  for (const error of [
    Object.assign(new Error("socket closed"), { data: { errorCode: "OMP_HOST_UNAVAILABLE" } }),
    new Error("the host call timed out"),
  ]) {
    const { plans } = enterHost({
      enter: async () => {
        throw error;
      },
    });
    const outcome = await adapterWith(plans)
      .executor(binding())
      .execute(callFor("EnterGoalMode", "tc-undecidable"), RUN, new AbortController().signal);
    assert.equal(outcome.isError, true);
    const record = decodeModeTransitionDetails(outcome.details);
    assert.equal(record?.state, "failed");
    assert.equal(record?.kind, "goal");
    assert.match(record?.reason ?? "", /did not deliver a decidable transition result/);
    assert.match(record?.reason ?? "", /cannot be confirmed/);
  }
});

test("a stop racing the committed transition reports a failed record instead of success", async () => {
  const { calls, plans } = enterHost();
  let dispatchChecks = 0;
  const outcome = await adapterWith(plans)
    .executor(
      binding({
        // The first check (pre-dispatch) passes; the post-commit re-check sees
        // the turn is gone.
        dispatchable: () => {
          dispatchChecks += 1;
          return dispatchChecks === 1;
        },
      }),
    )
    .execute(callFor("EnterPlanMode", "tc-7"), RUN, new AbortController().signal);
  assert.equal(calls.length, 1, "the host still committed");
  assert.equal(outcome.isError, true);
  const record = decodeModeTransitionDetails(outcome.details);
  assert.equal(record?.state, "failed");
  assert.match(record?.reason ?? "", /stopped while the host committed/);
});

test("a desktop preparation failure after the commit reports a failed record", async () => {
  const { calls, plans } = enterHost();
  const outcome = await adapterWith(plans)
    .executor(
      binding({
        enterMode: async () => {
          throw new Error("the runtime refused the catalogue");
        },
      }),
    )
    .execute(callFor("EnterPlanMode", "tc-8"), RUN, new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.equal(outcome.isError, true);
  const record = decodeModeTransitionDetails(outcome.details);
  assert.equal(record?.state, "failed");
  assert.match(record?.reason ?? "", /could not prepare the transitioned turn: the runtime refused the catalogue/);
  assert.equal(record?.toolCallId, "tc-8");
});

test("a stop during desktop preparation also reports a failed record", async () => {
  const { plans } = enterHost();
  let dispatchChecks = 0;
  const outcome = await adapterWith(plans)
    .executor(
      binding({
        dispatchable: () => {
          dispatchChecks += 1;
          return dispatchChecks <= 2;
        },
      }),
    )
    .execute(callFor("EnterPlanMode", "tc-9"), RUN, new AbortController().signal);
  const record = decodeModeTransitionDetails(outcome.details);
  assert.equal(record?.state, "failed");
  assert.match(record?.reason ?? "", /stopped while the desktop prepared/);
});

test("the record's envelope is the one the gate decodes", () => {
  const record = {
    v: 1,
    kind: "plan",
    state: "ready",
    sessionId: SESSION,
    liveTurnId: RUN.turnId,
    hostTurnId: "host-turn-1",
    toolCallId: "tc-10",
    expectedMode: "agent",
    modeBlock: PLAN_BLOCK,
    hostTools: NEW_HOST_TOOLS,
    at: 1_700_000_000_000,
  };
  assert.deepEqual(decodeModeTransitionDetails(encodeModeTransitionDetails(record)), record);
});
