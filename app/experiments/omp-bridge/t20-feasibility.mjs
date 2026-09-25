#!/usr/bin/env node
/**
 * T20-A feasibility spike: can the *fixed* OMP 18.2.7 trusted-extension
 * surface + host-tool RPC implement PI's transition-tool contract?
 *
 * The contract under test (from the pinned PI Desktop source, see
 * docs/validation/M5-plan-goal-capability-gates.md):
 *
 *   R3-a  `SubmitPlan`/`SubmitGoal` must be the ONLY tool call in the
 *         assistant batch; any sibling call in the same batch must have zero
 *         side effects (PI blocks every call of a mixed batch in
 *         `beforeToolCall`).
 *   R3-b  A successful submission ends the turn: no further provider step and
 *         no further tool execution (PI sets `terminate: true` on every
 *         terminal branch of the submit tool).
 *   R3-c  A failed submission ends the turn the same way.
 *   R3-d  An aborted turn leaves pending/error state observable and executes
 *         nothing.
 *   R4    Per-prompt tool availability must be clamp-able through
 *         `set_host_tools` + `setActiveTools` with a stable order/convergence
 *         (`set_host_tools` auto-activates new non-hidden host tools, so the
 *         clamp must come second and the prompt-policy retry must settle).
 *
 * Every check below asserts the CONTRACT, not current behavior: a failing
 * check is the evidence that the fixed surface cannot satisfy it. Provider,
 * runtime and extension are all local (fake provider, pinned launcher) — no
 * paid or remote model is called.
 *
 * Usage: node t20-feasibility.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT } from "./lib/base.mjs";
import { runExperiment, experimentRoot } from "./lib/run.mjs";

const SPIKE_GATE = join(EXPERIMENT_ROOT, "extensions", "t20-spike-gate.ts");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SUBMIT_TOOL = {
  name: "SubmitPlan",
  label: "Submit plan",
  description: "Submit one complete Markdown plan for user approval.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      markdown: { type: "string" },
      question: { type: "string" },
    },
    required: ["title", "markdown", "question"],
  },
};

const ECHO_TOOL = {
  name: "HostEcho",
  label: "Host echo",
  description: "Echo text back to the model (a second desktop host tool).",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

const submitArgs = { title: "T", markdown: "# Plan", question: "Approve?" };

/** Run one isolated runtime and return everything the checks read. */
async function runScenario(ctx, provider, config) {
  const {
    label,
    project,
    turns,
    env = {},
    tools = [SUBMIT_TOOL],
    registerToolsAfterPrompts = 0,
    clampPlan = [],
    prompts = [{ message: "go" }],
    answerHostTool = () => ({ content: [{ type: "text", text: "host-answer" }] }),
    abortAfterHostCallMs = null,
    hostToolDeadlineMs = 20_000,
    settleMs = 1_200,
  } = config;

  const repoRoot = resolveRepoRoot();
  const { root, runRoot, selector } = experimentRoot(ctx, label, { baseUrl: provider.baseUrl });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const logPath = join(root, "spike.log");
  const clampFile = join(root, "clamp.json");
  const requestBase = provider.requests.length;
  provider.script(turns);

  const hostCalls = [];
  const answered = new Set();
  let rpc;
  let registerIndex = 0;
  try {
    rpc = await OmpRpc.start({
      repoRoot,
      runRoot,
      mode: "rpc-ui",
      args: ["--model", selector, "--trusted-extension", SPIKE_GATE, "--approval-mode", "yolo"],
      cwd: projectDir,
      extraEnv: {
        T20_SPIKE_LOG: logPath,
        ...(env.T20_SPIKE_PROMPT_SUFFIX ? { T20_SPIKE_PROMPT_SUFFIX: env.T20_SPIKE_PROMPT_SUFFIX } : {}),
        ...(env.T20_SPIKE_BLOCK ? { T20_SPIKE_BLOCK: env.T20_SPIKE_BLOCK } : {}),
        ...(env.T20_SPIKE_ABORT_ON ? { T20_SPIKE_ABORT_ON: env.T20_SPIKE_ABORT_ON } : {}),
        ...(clampPlan.length > 0 ? { T20_SPIKE_CLAMP_FILE: clampFile } : {}),
      },
    });
    await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });

    if (registerToolsAfterPrompts === 0 && tools.length > 0) {
      const registered = await rpc.request({ type: "set_host_tools", tools });
      if (!registered.success) throw new Error(`set_host_tools rejected: ${JSON.stringify(registered)}`);
    }

    const perPromptRequests = [];
    const perPromptStartAttempts = [];
    const countStartEvents = () => {
      if (!existsSync(logPath)) return 0;
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes('"event":"before_agent_start"')).length;
    };
    for (const [index, prompt] of prompts.entries()) {
      if (registerToolsAfterPrompts > 0 && index === registerToolsAfterPrompts) {
        await rpc.request({ type: "set_host_tools", tools });
      }
      if (clampPlan[index] !== undefined) {
        writeFileSync(clampFile, JSON.stringify({ activeTools: clampPlan[index] }));
      } else if (clampPlan.length > 0) {
        // An explicit "no clamp for this prompt" must clear the previous list,
        // otherwise the previous clamp would silently apply again.
        writeFileSync(clampFile, JSON.stringify({ activeTools: null }));
      }
      const framesBefore = rpc.frames.length;
      const requestCountBefore = provider.requests.length;
      const startEventsBefore = countStartEvents();
      const promptPromise = rpc.request({ type: "prompt", message: prompt.message }, { timeoutMs: 60_000 });
      const deadline = Date.now() + 45_000;
      let aborted = false;
      while (Date.now() < deadline && !rpc.frames.slice(framesBefore).some((f) => f.type === "agent_end")) {
        for (const frame of rpc.frames.slice(framesBefore)) {
          if (frame.type !== "host_tool_call" || answered.has(frame.id)) continue;
          answered.add(frame.id);
          hostCalls.push({ id: frame.id, toolName: frame.toolName, arguments: frame.arguments, promptIndex: index });
          if (abortAfterHostCallMs !== null) {
            setTimeout(() => { if (!aborted) { aborted = true; rpc.request({ type: "abort" }, { timeoutMs: 20_000 }).catch(() => {}); } }, abortAfterHostCallMs);
            continue;
          }
          rpc.write({ type: "host_tool_result", id: frame.id, result: answerHostTool(frame), ...(answerHostTool.isError ? { isError: true } : {}) });
        }
        await sleep(40);
      }
      await promptPromise.catch(() => {});
      await rpc.waitFor((f) => f.type === "agent_end", 10_000, framesBefore);
      await sleep(settleMs);
      perPromptRequests.push(provider.requests.slice(requestCountBefore));
      perPromptStartAttempts.push(countStartEvents() - startEventsBefore);
      // Consume a per-prompt host-call deadline: a prompt that expects no host
      // call still ends through agent_end or the loop deadline above.
      void hostToolDeadlineMs;
    }

    const log = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    // The session must still answer after an aborted turn; the runtime is
    // stopped in `finally`, so this observation has to happen here.
    const postAbortState = abortAfterHostCallMs === null
      ? null
      : await rpc.request({ type: "get_state" }, { timeoutMs: 10_000 }).catch((error) => ({ error: String(error) }));
    return { rpc, projectDir, log, hostCalls, perPromptRequests, perPromptStartAttempts, requestBase, postAbortState, frames: rpc.frames.slice(0) };
  } finally {
    if (rpc?.pid) {
      const reaped = await rpc.stop();
      ctx.check(`${label}: process group reaped`, reaped === true);
    }
  }
}

const toolNamesOf = (request) => (request?.body?.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name);

const evidence = await runExperiment("t20-feasibility", async (ctx) => {
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  // ==========================================================================
  // R3-1  mixed batch [bash, SubmitPlan]
  // ==========================================================================
  {
    const sideEffect = (name) => join(name, "sibling.txt");
    const project = ctx.scratch("t20-s1-project");
    const touched = join(project, "sibling.txt");
    const run = await runScenario(ctx, provider, {
      label: "s1-mixed-bash-first",
      project,
      turns: [
        {
          text: "running both",
          toolCalls: [
            { id: "s1-bash", name: "bash", args: { command: `touch ${touched}` } },
            { id: "s1-submit", name: "SubmitPlan", args: submitArgs },
          ],
          finish: "tool_calls",
        },
        { text: "after the batch", finish: "stop" },
      ],
      env: {},
    });
    const submitted = run.hostCalls.filter((call) => call.toolName === "SubmitPlan");
    const submitsSeen = submitted.length;
    ctx.note("s1.observed", {
      hookOrder: run.log.filter((e) => e.event === "tool_call").map((e) => e.toolName),
      bashSideEffect: existsSync(touched),
      submitHostCalls: submitsSeen,
      providerRequests: run.perPromptRequests[0]?.length ?? 0,
      executions: run.rpc.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
    });
    ctx.check(
      "R3-a [bash, SubmitPlan]: the sibling bash call has ZERO side effects",
      !existsSync(touched),
      "PI blocks every call in a batch that contains a transition tool",
    );
    ctx.check(
      "R3-a [bash, SubmitPlan]: the transition call is blocked before it executes",
      submitsSeen === 0,
      `SubmitPlan host calls: ${submitsSeen}`,
    );
    ctx.limit("A mixed batch containing a transition tool is the exact case PI's beforeToolCall batch guard exists for.");
    void sideEffect;
  }

  // ==========================================================================
  // R3-2  mixed batch [SubmitPlan, bash]
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s2-project");
    const touched = join(project, "sibling.txt");
    const run = await runScenario(ctx, provider, {
      label: "s2-mixed-submit-first",
      project,
      turns: [
        {
          text: "running both",
          toolCalls: [
            { id: "s2-submit", name: "SubmitPlan", args: submitArgs },
            { id: "s2-bash", name: "bash", args: { command: `touch ${touched}` } },
          ],
          finish: "tool_calls",
        },
        { text: "after the batch", finish: "stop" },
      ],
    });
    ctx.note("s2.observed", {
      hookOrder: run.log.filter((e) => e.event === "tool_call").map((e) => e.toolName),
      bashSideEffect: existsSync(touched),
      submitHostCalls: run.hostCalls.filter((call) => call.toolName === "SubmitPlan").length,
      executions: run.rpc.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
    });
    ctx.check(
      "R3-a [SubmitPlan, bash]: the sibling bash call has ZERO side effects",
      !existsSync(touched),
      "order inside the batch must not matter",
    );
  }

  // ==========================================================================
  // R3-3  double submit in one batch
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s3-project");
    const run = await runScenario(ctx, provider, {
      label: "s3-double-submit",
      project,
      turns: [
        {
          text: "submitting twice",
          toolCalls: [
            { id: "s3-a", name: "SubmitPlan", args: submitArgs },
            { id: "s3-b", name: "SubmitPlan", args: submitArgs },
          ],
          finish: "tool_calls",
        },
        { text: "after the batch", finish: "stop" },
      ],
    });
    const submitsSeen = run.hostCalls.filter((call) => call.toolName === "SubmitPlan").length;
    ctx.note("s3.observed", { submitHostCalls: submitsSeen, hookCalls: run.log.filter((e) => e.event === "tool_call").length });
    ctx.check(
      "R3-a [SubmitPlan, SubmitPlan]: a duplicated transition call executes zero times",
      submitsSeen === 0,
      `PI's batch guard blocks the whole batch; observed ${submitsSeen} submissions`,
    );
  }

  // ==========================================================================
  // R3-3b  the gate blocks the transition call — does the sibling still run?
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s3b-project");
    const touched = join(project, "sibling.txt");
    const run = await runScenario(ctx, provider, {
      label: "s3b-blocked-transition-sibling",
      project,
      env: { T20_SPIKE_BLOCK: "SubmitPlan" },
      turns: [
        {
          text: "running both",
          toolCalls: [
            { id: "s3b-bash", name: "bash", args: { command: `touch ${touched}` } },
            { id: "s3b-submit", name: "SubmitPlan", args: submitArgs },
          ],
          finish: "tool_calls",
        },
        { text: "after the batch", finish: "stop" },
      ],
    });
    ctx.note("s3b.observed", {
      blockedEvents: run.log.filter((e) => e.event === "spike_block").map((e) => e.toolName),
      bashSideEffect: existsSync(touched),
      submitHostCalls: run.hostCalls.filter((call) => call.toolName === "SubmitPlan").length,
      executions: run.rpc.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
      executionsNote: "tool_execution_start also fires for a blocked call; the side-effect signals are the sibling file and the host_tool_call frame",
    });
    ctx.check(
      "R3-a: blocking the transition call in the gate still leaves the sibling with ZERO side effects",
      !existsSync(touched),
      "the interception payload has no batch view, so a per-call block cannot protect the siblings",
    );
  }

  // ==========================================================================
  // R3-4  submit success, then the model tries to continue
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s4-project");
    const touched = join(project, "continued.txt");
    const run = await runScenario(ctx, provider, {
      label: "s4-continue-after-success",
      project,
      turns: [
        { text: "submitting", toolCalls: [{ id: "s4-submit", name: "SubmitPlan", args: submitArgs }], finish: "tool_calls" },
        { text: "continuing anyway", toolCalls: [{ id: "s4-bash", name: "bash", args: { command: `touch ${touched}` } }], finish: "tool_calls" },
        { text: "done", finish: "stop" },
      ],
    });
    ctx.note("s4.observed", {
      providerRequestsAfterSubmit: run.perPromptRequests[0]?.length ?? 0,
      continuedToolRan: existsSync(touched),
      executions: run.rpc.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
      submitResultDelivered: run.rpc.frames.filter((f) => f.type === "tool_execution_end").map((f) => f.toolName),
    });
    ctx.check(
      "R3-b: a successful submission leaves no further provider step",
      (run.perPromptRequests[0]?.length ?? 0) <= 1,
      `model calls after the submit result: ${(run.perPromptRequests[0]?.length ?? 0) - 1}`,
    );
    ctx.check("R3-b: a successful submission leaves no further tool execution", !existsSync(touched));
  }

  // ==========================================================================
  // R3-5  submit failure, then the model tries to continue
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s5-project");
    const touched = join(project, "failed-continue.txt");
    const failing = () => ({ content: [{ type: "text", text: "submission failed: PLAN_SUBMIT_FAILED" }] });
    failing.isError = true;
    const run = await runScenario(ctx, provider, {
      label: "s5-failure-branch",
      project,
      answerHostTool: failing,
      turns: [
        { text: "submitting", toolCalls: [{ id: "s5-submit", name: "SubmitPlan", args: submitArgs }], finish: "tool_calls" },
        { text: "continuing anyway", toolCalls: [{ id: "s5-bash", name: "bash", args: { command: `touch ${touched}` } }], finish: "tool_calls" },
        { text: "done", finish: "stop" },
      ],
    });
    ctx.note("s5.observed", {
      providerRequests: run.perPromptRequests[0]?.length ?? 0,
      continuedToolRan: existsSync(touched),
      hostCalls: run.hostCalls.map((call) => call.toolName),
    });
    ctx.check(
      "R3-c: a failed submission also leaves no further provider step",
      (run.perPromptRequests[0]?.length ?? 0) <= 1,
      `model calls after the failed submit result: ${(run.perPromptRequests[0]?.length ?? 0) - 1}`,
    );
  }

  // ==========================================================================
  // R3-6  abort while the submission is pending at the host
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s6-project");
    const run = await runScenario(ctx, provider, {
      label: "s6-abort-pending",
      project,
      abortAfterHostCallMs: 700,
      turns: [
        { text: "submitting", toolCalls: [{ id: "s6-submit", name: "SubmitPlan", args: submitArgs }], finish: "tool_calls" },
        { text: "should not run", finish: "stop" },
      ],
    });
    const cancelFrame = run.rpc.frames.find((f) => f.type === "host_tool_cancel");
    const agentEnd = run.rpc.frames.filter((f) => f.type === "agent_end");
    const pendingCall = run.hostCalls[0];
    ctx.note("s6.observed", {
      pendingCall: pendingCall ? { id: pendingCall.id, toolName: pendingCall.toolName } : null,
      hostToolCancel: cancelFrame ?? null,
      agentEndCount: agentEnd.length,
      providerRequests: run.perPromptRequests[0]?.length ?? 0,
      frames: run.rpc.frames.map((f) => f.type),
    });
    ctx.check(
      "R3-d: abandoning a pending transition call cancels it by targetId",
      Boolean(cancelFrame) && cancelFrame.targetId === pendingCall?.id,
      cancelFrame ? `cancel.targetId=${cancelFrame.targetId} call.id=${pendingCall?.id}` : "no host_tool_cancel frame",
    );
    ctx.check("R3-d: the aborted turn terminates", agentEnd.length >= 1, `${agentEnd.length} agent_end frames`);
    ctx.check(
      "R3-d: the session stays observable after the abort",
      run.postAbortState?.success === true,
      JSON.stringify(run.postAbortState ?? {}).slice(0, 200),
    );
  }

  // ==========================================================================
  // R3-7  can the gate stop a mixed batch at all? (abort on interception)
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s7-project");
    const touched = join(project, "sibling.txt");
    const run = await runScenario(ctx, provider, {
      label: "s7-abort-on-intercept",
      project,
      env: { T20_SPIKE_ABORT_ON: "SubmitPlan" },
      turns: [
        {
          text: "running both",
          toolCalls: [
            { id: "s7-bash", name: "bash", args: { command: `touch ${touched}` } },
            { id: "s7-submit", name: "SubmitPlan", args: submitArgs },
          ],
          finish: "tool_calls",
        },
        { text: "after the batch", finish: "stop" },
      ],
    });
    ctx.note("s7.observed", {
      abortEvents: run.log.filter((e) => e.event === "spike_abort_requested"),
      bashSideEffect: existsSync(touched),
      submitHostCalls: run.hostCalls.filter((call) => call.toolName === "SubmitPlan").length,
      executions: run.rpc.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
      frames: [...new Set(run.rpc.frames.map((f) => f.type))],
      messages: run.rpc.frames.filter((f) => f.type === "message_end").map((f) => f.message?.stopReason ?? null),
    });
    ctx.check(
      "R3-a: aborting from the transition interception still leaves the sibling with ZERO side effects",
      !existsSync(touched),
    );
    ctx.limit("Abort-on-intercept is the only per-batch lever the fixed surface offers; if it works it is abort semantics, not PI's block-and-continue.");
  }

  // ==========================================================================
  // R4-1  required order: set_host_tools, then the before_agent_start clamp
  // ==========================================================================
  {
    const project = ctx.scratch("t20-r4a-project");
    const clamp = ["read", "grep", "glob", "bash", "SubmitPlan"];
    const run = await runScenario(ctx, provider, {
      label: "r4a-forward-order",
      project,
      tools: [SUBMIT_TOOL, ECHO_TOOL],
      clampPlan: [clamp],
      prompts: [{ message: "first" }],
      turns: [{ text: "ok", finish: "stop" }],
    });
    const names = toolNamesOf(run.perPromptRequests[0]?.[0]);
    ctx.note("r4a.observed", {
      clamp,
      providerToolNames: names,
      startEvents: run.log.filter((e) => e.event === "before_agent_start").length,
      clampEvents: run.log.filter((e) => e.event === "spike_clamp").length,
    });
    ctx.check("R4: the registered host tool is visible before the clamp", names.includes("SubmitPlan"));
    ctx.check("R4: the clamp hides every tool outside its list", names.every((name) => clamp.includes(name)), names.join(","));
    ctx.check("R4: the clamp hides a second host tool (HostEcho)", !names.includes("HostEcho"), names.join(","));
  }

  // ==========================================================================
  // R4-2  reverse order: clamp first, then set_host_tools re-exposes
  // ==========================================================================
  {
    const project = ctx.scratch("t20-r4b-project");
    const clamp = ["read", "grep", "glob", "bash"];
    const run = await runScenario(ctx, provider, {
      label: "r4b-reverse-order",
      project,
      tools: [SUBMIT_TOOL, ECHO_TOOL],
      registerToolsAfterPrompts: 1,
      clampPlan: [clamp],
      prompts: [{ message: "first" }, { message: "second" }],
      turns: [
        { text: "first turn", finish: "stop" },
        { text: "second turn", finish: "stop" },
      ],
    });
    const first = toolNamesOf(run.perPromptRequests[0]?.[0]);
    const second = toolNamesOf(run.perPromptRequests[1]?.[0]);
    ctx.note("r4b.observed", { first, second, clamp });
    ctx.check("R4: a clamp without registration exposes no host tool", !first.includes("SubmitPlan"), first.join(","));
    ctx.check(
      "R4: registering host tools after a clamp re-exposes them (the clamp does not stick)",
      second.includes("SubmitPlan") && second.includes("HostEcho"),
      second.join(","),
    );
  }

  // ==========================================================================
  // R4-3  per-prompt clamp across a mode cycle, with retry accounting
  // ==========================================================================
  {
    const project = ctx.scratch("t20-r4c-project");
    const plan = [
      ["read", "grep", "glob", "bash"], // agent
      ["read", "grep", "glob", "bash", "SubmitPlan"], // plan
      ["read", "grep", "glob", "bash", "SubmitGoal"], // goal (unregistered on purpose)
      ["read", "grep", "glob", "bash"], // agent again
    ];
    const run = await runScenario(ctx, provider, {
      label: "r4c-mode-cycle",
      project,
      tools: [SUBMIT_TOOL, ECHO_TOOL],
      clampPlan: plan,
      prompts: [{ message: "agent" }, { message: "plan" }, { message: "goal" }, { message: "agent again" }],
      turns: [
        { text: "one", finish: "stop" },
        { text: "two", finish: "stop" },
        { text: "three", finish: "stop" },
        { text: "four", finish: "stop" },
      ],
    });
    const observed = run.perPromptRequests.map((requests) => toolNamesOf(requests[0]));
    const startEvents = run.log.filter((e) => e.event === "before_agent_start");
    ctx.note("r4c.observed", { plan, observed, startAttempts: startEvents.map((e) => e.attempt) });
    ctx.check(
      "R4: every prompt's tool list matches its own clamp",
      observed.every((names, index) => names.length > 0 && names.every((name) => plan[index].includes(name))),
      JSON.stringify(observed),
    );
    ctx.check(
      "R4: the prompt-policy retry settles (no prompt needs more than one retry)",
      startEvents.length <= 8,
      `${startEvents.length} before_agent_start attempts for 4 prompts`,
    );
    ctx.check(
      "R4: agent-mode prompts after the cycle are unrestricted again (back to the base clamp)",
      observed[3]?.includes("SubmitPlan") === false,
      (observed[3] ?? []).join(","),
    );
  }
  // ==========================================================================
  // R4-4  clamp + system-prompt override in one before_agent_start (the exact
  //       T20-B shape): does the prompt-policy retry settle, and is the block
  //       appended exactly once after the native prompt?
  // ==========================================================================
  {
    const project = ctx.scratch("t20-r4d-project");
    const marker = "<t20-spike-mode-block>";
    const agentClamp = ["read", "grep", "glob", "bash"];
    const planClamp = ["read", "grep", "glob", "bash", "SubmitPlan"];
    const run = await runScenario(ctx, provider, {
      label: "r4d-clamp-and-override",
      project,
      tools: [SUBMIT_TOOL, ECHO_TOOL],
      clampPlan: [agentClamp, agentClamp, planClamp],
      env: { T20_SPIKE_PROMPT_SUFFIX: marker },
      prompts: [{ message: "one" }, { message: "two" }, { message: "three" }],
      turns: [
        { text: "one", finish: "stop" },
        { text: "two", finish: "stop" },
        { text: "three", finish: "stop" },
      ],
    });
    const systemOf = (request) => {
      const messages = request?.body?.messages ?? [];
      const system = messages.find((message) => message?.role === "system");
      const content = typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
      return { messages, content };
    };
    const systems = run.perPromptRequests.map((requests) => systemOf(requests[0]));
    const occurrences = (text, needle) => text.split(needle).length - 1;
    ctx.note("r4d.observed", {
      attemptsPerPrompt: run.perPromptStartAttempts,
      toolsPerPrompt: run.perPromptRequests.map((requests) => toolNamesOf(requests[0])),
      systemMessagesPerPrompt: systems.map((entry) => entry.messages.filter((message) => message?.role === "system").length),
      markerOccurrences: systems.map((entry) => occurrences(entry.content, marker)),
      piDefaultBasePresent: systems.map((entry) => entry.content.includes("You are PI-Desktop, a local-first coding agent")),
      systemBytes: systems.map((entry) => entry.content.length),
    });
    ctx.check(
      "R4: a prompt that both clamps and appends is delivered within one policy retry",
      run.perPromptStartAttempts[0] <= 2 && (run.perPromptRequests[0]?.length ?? 0) >= 1,
      `attempts=${run.perPromptStartAttempts[0]} requests=${run.perPromptRequests[0]?.length ?? 0}`,
    );
    ctx.check(
      "R4: an unchanged clamp on the next prompt needs exactly one preparation",
      run.perPromptStartAttempts[1] === 1,
      `attempts=${run.perPromptStartAttempts[1]}`,
    );
    ctx.check(
      "R4: an in-place clamp change converges within one retry",
      run.perPromptStartAttempts[2] <= 2 && (run.perPromptRequests[2]?.length ?? 0) >= 1,
      `attempts=${run.perPromptStartAttempts[2]} requests=${run.perPromptRequests[2]?.length ?? 0}`,
    );
    ctx.check(
      "R2: the appended mode block survives the retry exactly once",
      systems.every((entry) => occurrences(entry.content, marker) === 1),
      JSON.stringify(systems.map((entry) => occurrences(entry.content, marker))),
    );
    ctx.check(
      "R2: the runtime keeps exactly one system message",
      systems.every((entry) => entry.messages.filter((message) => message?.role === "system").length === 1),
      JSON.stringify(systems.map((entry) => entry.messages.filter((message) => message?.role === "system").length)),
    );
    ctx.check(
      "R2: PI Desktop's default base prompt is not injected",
      systems.every((entry) => !entry.content.includes("You are PI-Desktop, a local-first coding agent")),
    );
  }
});

process.exit(evidence.ok ? 0 : 1);
