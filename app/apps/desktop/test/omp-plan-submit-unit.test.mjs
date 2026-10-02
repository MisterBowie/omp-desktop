/**
 * Unit coverage for the desktop half of the Plan/Goal submission loop
 * (M5/T20-B2): the PI-parity submit-tool definitions, and the executor's
 * fail-closed identity/kind checks around the host `plans.submit` call.
 *
 * The real pinned runtime and the real host database are exercised by
 * `omp-plan-submit-e2e.test.mjs`; these probes drive the production adapter
 * directly so every refusal path (wrong mode, no durable turn, empty
 * arguments, host error, malformed host reply) is observable without a
 * provider.
 */
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers", "ts-import-hooks.mjs")));

const { createOmpHostToolAdapter, desktopSubmitToolCatalogEntry, DESKTOP_SUBMIT_TOOL_NAMES } = await import(
  "../electron/main/runtime/omp-host-tools.ts"
);

const SESSION = "plan-submit-unit";

/** The production adapter over empty plugin/MCP registries plus a scripted host. */
function adapterWith(plans) {
  return createOmpHostToolAdapter({
    plugins: { getTools: () => [], getSkills: () => [], loadSkillBody: () => ({ id: "x", name: "x", body: "x" }) },
    userMcp: { toolsForProject: async () => [], callTool: async () => "" },
    pluginActiveInProject: () => true,
    ...(plans ? { plans } : {}),
  });
}

function bindingFor(mode) {
  return {
    sessionId: SESSION,
    projectPath: "/tmp/omp-plan-submit-unit",
    modelKey: () => null,
    thinkingLevel: () => null,
    dispatchable: () => true,
    modeForTurn: () => mode,
    nativeSessionId: () => "native-owner",
    enterMode: async () => {
      throw new Error("the fixture does not wire mode transitions");
    },
  };
}

function runWith(hostTurnId) {
  return { sessionId: SESSION, turnId: `omp-turn:${SESSION}:1`, generation: 1, hostTurnId };
}

function callFor(toolName, toolCallId, args) {
  return { id: `frame-${toolCallId}`, toolCallId, toolName, arguments: args };
}

const VALID_ARGS = { title: "  Title  ", markdown: "# Markdown", question: "  Approve?  " };

test("submit catalog entries carry the PI name/schema and the sole+terminate policy", () => {
  for (const kind of ["plan", "goal"]) {
    const entry = desktopSubmitToolCatalogEntry(kind);
    assert.equal(entry.definition.name, DESKTOP_SUBMIT_TOOL_NAMES[kind]);
    assert.equal(entry.definition.name, kind === "plan" ? "SubmitPlan" : "SubmitGoal");
    assert.equal(entry.definition.loadMode, "essential");
    assert.equal(entry.definition.concurrency, "exclusive");
    assert.equal(entry.definition.batchPolicy, "sole");
    assert.equal(entry.definition.terminateOnSettle, true);
    assert.equal(entry.risk, "low");
    assert.deepEqual(entry.planSafeActions, []);
    assert.equal(entry.origin, "desktop");
    assert.deepEqual(Object.keys(entry.definition.parameters.properties).sort(), ["markdown", "question", "title"]);
    assert.deepEqual(entry.definition.parameters.required, ["title", "markdown", "question"]);
    for (const field of ["title", "markdown", "question"]) {
      assert.equal(entry.definition.parameters.properties[field].type, "string");
    }
  }
  // Plan and Goal must not share a description: the model is told which
  // contract it is authoring.
  assert.notEqual(
    desktopSubmitToolCatalogEntry("plan").definition.description,
    desktopSubmitToolCatalogEntry("goal").definition.description,
  );
});

test("submits through the host with the durable identity from the run binding", async () => {
  const calls = [];
  const adapter = adapterWith({
    submit: async (input) => {
      calls.push(input);
      return {
        status: "pending",
        proposal: {
          id: "proposal-1",
          artifact: { relativePath: ".pi/plan/review.md", sha256: "a".repeat(64), sizeBytes: 42 },
        },
      };
    },
  });
  const executor = adapter.executor(bindingFor("plan"));
  const outcome = await executor.execute(
    callFor("SubmitPlan", "tc-1", VALID_ARGS),
    runWith("host-turn-1"),
    new AbortController().signal,
  );
  assert.deepEqual(calls, [
    {
      sessionId: SESSION,
      turnId: "host-turn-1",
      toolCallId: "tc-1",
      kind: "plan",
      title: "Title",
      markdown: "# Markdown",
      question: "Approve?",
    },
  ]);
  assert.equal(outcome.isError, undefined);
  assert.match(JSON.stringify(outcome.content), /Plan submitted for approval/);

  // The Goal branch works the same way in goal mode.
  const goalCalls = [];
  const goalAdapter = adapterWith({
    submit: async (input) => {
      goalCalls.push(input);
      return {
        status: "pending",
        proposal: { id: "p2", artifact: { relativePath: ".pi/goal/g.md", sha256: "b".repeat(64), sizeBytes: 7 } },
      };
    },
  });
  const goalOutcome = await goalAdapter
    .executor(bindingFor("goal"))
    .execute(callFor("SubmitGoal", "tc-2", VALID_ARGS), runWith("host-turn-2"), new AbortController().signal);
  assert.equal(goalCalls[0].kind, "goal");
  assert.match(JSON.stringify(goalOutcome.content), /Goal contract submitted for approval/);
});

test("refuses a wrong-kind call and a call without a durable host turn", async () => {
  let submits = 0;
  const adapter = adapterWith({
    submit: async () => {
      submits += 1;
      return { status: "pending", proposal: { id: "p", artifact: { relativePath: "a", sha256: "s", sizeBytes: 1 } } };
    },
  });
  const wrongKind = await adapter
    .executor(bindingFor("plan"))
    .execute(callFor("SubmitGoal", "tc-1", VALID_ARGS), runWith("host-turn-1"), new AbortController().signal);
  assert.equal(wrongKind.isError, true);
  assert.match(JSON.stringify(wrongKind.content), /PLAN_KIND_MISMATCH/);

  const noTurn = await adapter
    .executor(bindingFor("plan"))
    .execute(callFor("SubmitPlan", "tc-2", VALID_ARGS), runWith(null), new AbortController().signal);
  assert.equal(noTurn.isError, true);
  assert.match(JSON.stringify(noTurn.content), /no durable host turn/);
  assert.equal(submits, 0);
});

test("refuses empty arguments and a missing host wiring before any host call", async () => {
  let submits = 0;
  const adapter = adapterWith({
    submit: async () => {
      submits += 1;
      return { status: "pending", proposal: { id: "p", artifact: { relativePath: "a", sha256: "s", sizeBytes: 1 } } };
    },
  });
  for (const args of [
    { title: "  ", markdown: "# m", question: "q" },
    { title: "t", markdown: "   ", question: "q" },
    { title: "t", markdown: "# m", question: "  " },
  ]) {
    const outcome = await adapter
      .executor(bindingFor("plan"))
      .execute(callFor("SubmitPlan", "tc", args), runWith("host-turn-1"), new AbortController().signal);
    assert.equal(outcome.isError, true);
    assert.match(JSON.stringify(outcome.content), /requires non-empty title, markdown, and question/);
  }
  const unwired = await adapterWith(undefined)
    .executor(bindingFor("plan"))
    .execute(callFor("SubmitPlan", "tc-unwired", VALID_ARGS), runWith("host-turn-1"), new AbortController().signal);
  assert.equal(unwired.isError, true);
  assert.match(JSON.stringify(unwired.content), /not wired/);
  assert.equal(submits, 0);
});

test("surfaces the host error code and rejects a malformed proposal reply", async () => {
  const failing = adapterWith({
    submit: async () => {
      throw Object.assign(new Error("pending approval exists"), { data: { errorCode: "PLAN_ALREADY_PENDING" } });
    },
  });
  const failure = await failing
    .executor(bindingFor("plan"))
    .execute(callFor("SubmitPlan", "tc-1", VALID_ARGS), runWith("host-turn-1"), new AbortController().signal);
  assert.equal(failure.isError, true);
  assert.match(JSON.stringify(failure.content), /Plan submission failed: PLAN_ALREADY_PENDING/);

  // A reply without the immutable artifact identity is not a submission the
  // desktop can show or approve.
  const malformed = adapterWith({
    submit: async () => ({ status: "pending", proposal: { id: "p", artifact: { relativePath: "a", sha256: "s" } } }),
  });
  const invalid = await malformed
    .executor(bindingFor("plan"))
    .execute(callFor("SubmitPlan", "tc-2", VALID_ARGS), runWith("host-turn-1"), new AbortController().signal);
  assert.equal(invalid.isError, true);
  assert.match(JSON.stringify(invalid.content), /invalid proposal/);
});
