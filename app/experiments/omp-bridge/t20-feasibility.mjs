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
 *         clamp must come second and the prompt-policy retry must settle), and
 *         the catalog must be replaceable per prompt (add/remove/re-add a
 *         submit tool) without residue.
 *   R2    The mode block appended to the system prompt must be the production
 *         `composeModeSystemPrompt(mode, "")` bytes — appended, never merged
 *         with a base prompt, and stable across the prompt-policy retry.
 *
 * Every check below asserts the CONTRACT, not current behavior: a failing
 * check is the evidence that the fixed surface cannot satisfy it. Tool-list
 * assertions are STRICT (exact sequence: missing, extra, reordered, or
 * duplicated names all fail) — a subset check would let an unregistered tool
 * masquerade as a successful catalog. Provider, runtime and extension are all
 * local (fake provider, pinned launcher) — no paid or remote model is called.
 *
 * Usage: node t20-feasibility.mjs [--keep-artifacts]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OmpRpc } from "./lib/rpc.mjs";
import { FakeProvider } from "./lib/provider.mjs";
import { resolveRepoRoot, EXPERIMENT_ROOT } from "./lib/base.mjs";
import { runExperiment, experimentRoot } from "./lib/run.mjs";

const SPIKE_GATE = join(EXPERIMENT_ROOT, "extensions", "t20-spike-gate.ts");
const APP_ROOT = resolve(EXPERIMENT_ROOT, "../..");
const APP_MODE_PROMPTS = join(APP_ROOT, "packages/agent-runtime/src/mode-prompts.ts");
const PINNED_MODE_PROMPTS = join(
  resolveRepoRoot(),
  "upstream/pi-desktop/packages/agent-runtime/src/mode-prompts.ts",
);
// The real production composer, imported directly (the module has only a
// type-only import, so Node's type stripping loads it without a bundler).
const { composeModeSystemPrompt } = await import(pathToFileURL(APP_MODE_PROMPTS).href);
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

const SUBMIT_GOAL_TOOL = {
  name: "SubmitGoal",
  label: "Submit goal",
  description: "Submit one complete Markdown goal contract for user approval.",
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

/** Exact-sequence equality: order, duplicates, missing and extra all matter. */
function sameSequence(observed, expected) {
  if (!Array.isArray(observed) || !Array.isArray(expected)) return false;
  return observed.length === expected.length && observed.every((name, index) => name === expected[index]);
}

const toolNamesOf = (request) => (request?.body?.tools ?? []).map((tool) => tool?.function?.name ?? tool?.name);

function systemTextOf(request) {
  const messages = request?.body?.messages ?? [];
  const system = messages.find((message) => message?.role === "system");
  return typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "");
}

const occurrences = (text, needle) => (needle ? text.split(needle).length - 1 : 0);

/** Run one isolated runtime and return everything the checks read. */
async function runScenario(ctx, provider, config) {
  const {
    label,
    turns,
    env = {},
    tools = [],
    catalogPlan = null,
    clampPlan = [],
    modePlan = null,
    prompts = [{ message: "go" }],
    answerHostTool = () => ({ content: [{ type: "text", text: "host-answer" }] }),
    abortAfterHostCallMs = null,
    settleMs = 1_200,
  } = config;

  const repoRoot = resolveRepoRoot();
  const { root, runRoot, selector } = experimentRoot(ctx, label, { baseUrl: provider.baseUrl });
  const projectDir = join(root, "project");
  mkdirSync(projectDir, { recursive: true });
  const logPath = join(root, "spike.log");
  const clampFile = join(root, "clamp.json");
  const modeFile = join(root, "mode.json");
  const requestBase = provider.requests.length;
  provider.script(turns);

  const hostCalls = [];
  const answered = new Set();
  let rpc;
  try {
    rpc = await OmpRpc.start({
      repoRoot,
      runRoot,
      mode: "rpc-ui",
      args: ["--model", selector, "--trusted-extension", SPIKE_GATE, "--approval-mode", "yolo"],
      cwd: projectDir,
      extraEnv: {
        T20_SPIKE_LOG: logPath,
        ...(clampPlan.length > 0 ? { T20_SPIKE_CLAMP_FILE: clampFile } : {}),
        ...(modePlan ? { T20_SPIKE_MODE_FILE: modeFile } : {}),
        ...(env.T20_SPIKE_BLOCK ? { T20_SPIKE_BLOCK: env.T20_SPIKE_BLOCK } : {}),
        ...(env.T20_SPIKE_ABORT_ON ? { T20_SPIKE_ABORT_ON: env.T20_SPIKE_ABORT_ON } : {}),
      },
    });
    await rpc.request({ type: "negotiate_protocol", protocolVersion: 2 });
    if (!catalogPlan && tools.length > 0) {
      const registered = await rpc.request({ type: "set_host_tools", tools });
      if (!registered.success) throw new Error(`set_host_tools rejected: ${JSON.stringify(registered)}`);
    }

    const perPrompt = [];
    const countStartEvents = () => {
      if (!existsSync(logPath)) return 0;
      return readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.includes('"event":"before_agent_start"')).length;
    };
    for (const [index, prompt] of prompts.entries()) {
      let catalogNames = tools.map((tool) => tool.name);
      if (catalogPlan) {
        const catalog = catalogPlan[index] ?? [];
        catalogNames = catalog.map((tool) => tool.name);
        const registered = await rpc.request({ type: "set_host_tools", tools: catalog });
        if (!registered.success) throw new Error(`set_host_tools(${index}) rejected: ${JSON.stringify(registered)}`);
      }
      if (clampPlan[index] !== undefined) {
        writeFileSync(clampFile, JSON.stringify({ activeTools: clampPlan[index] }));
      } else if (clampPlan.length > 0) {
        // An explicit "no clamp for this prompt" must clear the previous list,
        // otherwise the previous clamp would silently apply again.
        writeFileSync(clampFile, JSON.stringify({ activeTools: null }));
      }
      if (modePlan) {
        writeFileSync(
          modeFile,
          JSON.stringify(
            modePlan[index]
              ? { modeBlock: composeModeSystemPrompt(modePlan[index], "") }
              : { modeBlock: null },
          ),
        );
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
      const requests = provider.requests.slice(requestCountBefore);
      const first = requests[0];
      perPrompt.push({
        requests,
        catalogNames,
        clamp: clampPlan[index] ?? null,
        mode: modePlan?.[index] ?? null,
        toolNames: toolNamesOf(first),
        systemText: systemTextOf(first),
        systemMessages: (first?.body?.messages ?? []).filter((message) => message?.role === "system").length,
        startAttempts: countStartEvents() - startEventsBefore,
      });
    }

    const log = existsSync(logPath)
      ? readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];
    // The session must still answer after an aborted turn; the runtime is
    // stopped in `finally`, so this observation has to happen here.
    const postAbortState = abortAfterHostCallMs === null
      ? null
      : await rpc.request({ type: "get_state" }, { timeoutMs: 10_000 }).catch((error) => ({ error: String(error) }));
    return { projectDir, log, hostCalls, perPrompt, requestBase, postAbortState, frames: rpc.frames.slice(0) };
  } finally {
    if (rpc?.pid) {
      const reaped = await rpc.stop();
      ctx.check(`${label}: process group reaped`, reaped === true);
    }
  }
}

const evidence = await runExperiment("t20-feasibility", async (ctx) => {
  const provider = await FakeProvider.start({ model: "local-model" });
  ctx.onCleanup(() => provider.close());

  // ==========================================================================
  // R3-1  mixed batch [bash, SubmitPlan]
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s1-project");
    const touched = join(project, "sibling.txt");
    const run = await runScenario(ctx, provider, {
      label: "s1-mixed-bash-first",
      tools: [SUBMIT_TOOL],
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
    });
    const submitsSeen = run.hostCalls.filter((call) => call.toolName === "SubmitPlan").length;
    ctx.note("s1.observed", {
      hookOrder: run.log.filter((e) => e.event === "tool_call").map((e) => e.toolName),
      bashSideEffect: existsSync(touched),
      submitHostCalls: submitsSeen,
      providerRequests: run.perPrompt[0]?.requests.length ?? 0,
      executions: run.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
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
  }

  // ==========================================================================
  // R3-2  mixed batch [SubmitPlan, bash]
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s2-project");
    const touched = join(project, "sibling.txt");
    const run = await runScenario(ctx, provider, {
      label: "s2-mixed-submit-first",
      tools: [SUBMIT_TOOL],
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
      executions: run.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
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
      tools: [SUBMIT_TOOL],
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
      tools: [SUBMIT_TOOL],
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
      executions: run.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
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
      tools: [SUBMIT_TOOL],
      turns: [
        { text: "submitting", toolCalls: [{ id: "s4-submit", name: "SubmitPlan", args: submitArgs }], finish: "tool_calls" },
        { text: "continuing anyway", toolCalls: [{ id: "s4-bash", name: "bash", args: { command: `touch ${touched}` } }], finish: "tool_calls" },
        { text: "done", finish: "stop" },
      ],
    });
    ctx.note("s4.observed", {
      providerRequestsAfterSubmit: run.perPrompt[0]?.requests.length ?? 0,
      continuedToolRan: existsSync(touched),
      executions: run.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
    });
    ctx.check(
      "R3-b: a successful submission leaves no further provider step",
      (run.perPrompt[0]?.requests.length ?? 0) <= 1,
      `model calls after the submit result: ${(run.perPrompt[0]?.requests.length ?? 0) - 1}`,
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
      tools: [SUBMIT_TOOL],
      answerHostTool: failing,
      turns: [
        { text: "submitting", toolCalls: [{ id: "s5-submit", name: "SubmitPlan", args: submitArgs }], finish: "tool_calls" },
        { text: "continuing anyway", toolCalls: [{ id: "s5-bash", name: "bash", args: { command: `touch ${touched}` } }], finish: "tool_calls" },
        { text: "done", finish: "stop" },
      ],
    });
    ctx.note("s5.observed", {
      providerRequests: run.perPrompt[0]?.requests.length ?? 0,
      continuedToolRan: existsSync(touched),
      hostCalls: run.hostCalls.map((call) => call.toolName),
    });
    ctx.check(
      "R3-c: a failed submission also leaves no further provider step",
      (run.perPrompt[0]?.requests.length ?? 0) <= 1,
      `model calls after the failed submit result: ${(run.perPrompt[0]?.requests.length ?? 0) - 1}`,
    );
  }

  // ==========================================================================
  // R3-6  abort while the submission is pending at the host
  // ==========================================================================
  {
    const project = ctx.scratch("t20-s6-project");
    const run = await runScenario(ctx, provider, {
      label: "s6-abort-pending",
      tools: [SUBMIT_TOOL],
      abortAfterHostCallMs: 700,
      turns: [
        { text: "submitting", toolCalls: [{ id: "s6-submit", name: "SubmitPlan", args: submitArgs }], finish: "tool_calls" },
        { text: "should not run", finish: "stop" },
      ],
    });
    const cancelFrame = run.frames.find((f) => f.type === "host_tool_cancel");
    const agentEnd = run.frames.filter((f) => f.type === "agent_end");
    const pendingCall = run.hostCalls[0];
    ctx.note("s6.observed", {
      pendingCall: pendingCall ? { id: pendingCall.id, toolName: pendingCall.toolName } : null,
      hostToolCancel: cancelFrame ?? null,
      agentEndCount: agentEnd.length,
      providerRequests: run.perPrompt[0]?.requests.length ?? 0,
      frames: run.frames.map((f) => f.type),
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
      tools: [SUBMIT_TOOL],
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
      executions: run.frames.filter((f) => f.type === "tool_execution_start").map((f) => f.toolName),
      frames: [...new Set(run.frames.map((f) => f.type))],
      messages: run.frames.filter((f) => f.type === "message_end").map((f) => f.message?.stopReason ?? null),
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
      tools: [SUBMIT_TOOL, ECHO_TOOL],
      clampPlan: [clamp],
      prompts: [{ message: "first" }],
      turns: [{ text: "ok", finish: "stop" }],
    });
    const observed = run.perPrompt[0]?.toolNames ?? [];
    ctx.note("r4a.observed", {
      clamp,
      providerToolNames: observed,
      startEvents: run.log.filter((e) => e.event === "before_agent_start").length,
      clampEvents: run.log.filter((e) => e.event === "spike_clamp").length,
    });
    ctx.check("R4: the registered host tool is visible before the clamp", observed.includes("SubmitPlan"));
    ctx.check("R4: the clamped tool list equals the clamp exactly (sequence, no extras)", sameSequence(observed, clamp), observed.join(","));
  }

  // ==========================================================================
  // R4-2  reverse order: clamp first, then set_host_tools re-exposes
  // ==========================================================================
  {
    const project = ctx.scratch("t20-r4b-project");
    const clamp = ["read", "grep", "glob", "bash"];
    const run = await runScenario(ctx, provider, {
      label: "r4b-reverse-order",
      catalogPlan: [[], [SUBMIT_TOOL, ECHO_TOOL]],
      clampPlan: [clamp, null],
      prompts: [{ message: "first" }, { message: "second" }],
      turns: [
        { text: "first turn", finish: "stop" },
        { text: "second turn", finish: "stop" },
      ],
    });
    const first = run.perPrompt[0]?.toolNames ?? [];
    const second = run.perPrompt[1]?.toolNames ?? [];
    ctx.note("r4b.observed", { first, second, clamp });
    ctx.check("R4: a clamp without registration equals the clamp exactly", sameSequence(first, clamp), first.join(","));
    ctx.check(
      "R4: registering host tools after a clamp re-exposes them (the clamp does not stick)",
      second.includes("SubmitPlan") && second.includes("HostEcho"),
      second.join(","),
    );
  }

  // ==========================================================================
  // R4-3  catalog lifecycle across a mode cycle: real set_host_tools
  //       add / remove / re-add, with a strict per-prompt tool-list contract
  // ==========================================================================
  {
    const project = ctx.scratch("t20-r4c-project");
    const agentClamp = ["read", "grep", "glob", "bash", "HostEcho"];
    const planClamp = ["read", "grep", "glob", "bash", "HostEcho", "SubmitPlan"];
    const goalClamp = ["read", "grep", "glob", "bash", "HostEcho", "SubmitGoal"];
    const catalogPlan = [
      [ECHO_TOOL], // 1 agent: no submit tool
      [ECHO_TOOL, SUBMIT_TOOL], // 2 plan: SubmitPlan registered
      [ECHO_TOOL, SUBMIT_GOAL_TOOL], // 3 goal: catalog replaced with SubmitGoal
      [ECHO_TOOL], // 4 agent again: submit tools removed
      [ECHO_TOOL, SUBMIT_TOOL], // 5 plan again: SubmitPlan re-registered
    ];
    const clampPlan = [agentClamp, planClamp, goalClamp, agentClamp, planClamp];
    const run = await runScenario(ctx, provider, {
      label: "r4c-catalog-lifecycle",
      catalogPlan,
      clampPlan,
      prompts: [
        { message: "agent" },
        { message: "plan" },
        { message: "goal" },
        { message: "agent again" },
        { message: "plan again" },
      ],
      turns: [
        { text: "one", finish: "stop" },
        { text: "two", finish: "stop" },
        { text: "three", finish: "stop" },
        { text: "four", finish: "stop" },
        { text: "five", finish: "stop" },
      ],
    });
    const observed = run.perPrompt.map((entry) => entry.toolNames);
    ctx.note("r4c.observed", {
      catalogPlan: catalogPlan.map((catalog) => catalog.map((tool) => tool.name)),
      clampPlan,
      observed,
      startAttempts: run.perPrompt.map((entry) => entry.startAttempts),
      duplicates: observed.map((names) => names.filter((name, index) => names.indexOf(name) !== index)),
    });
    ctx.check(
      "R4: every prompt's tool list equals its own catalog+clamp exactly (sequence, no residue, no duplicates)",
      observed.every((names, index) => sameSequence(names, clampPlan[index])),
      JSON.stringify(observed),
    );
    ctx.check(
      "R4: the removed submit tool stays out after the catalog drops it (prompt 4 = agent)",
      !observed[3]?.includes("SubmitPlan") && !observed[3]?.includes("SubmitGoal"),
      (observed[3] ?? []).join(","),
    );
    ctx.check(
      "R4: the re-registered submit tool is visible again on the next plan prompt (prompt 5)",
      observed[4]?.includes("SubmitPlan") === true && observed[4]?.includes("SubmitGoal") === false,
      (observed[4] ?? []).join(","),
    );
    ctx.check(
      "R4: the goal prompt carries SubmitGoal and not SubmitPlan (prompt 3)",
      observed[2]?.includes("SubmitGoal") === true && observed[2]?.includes("SubmitPlan") === false,
      (observed[2] ?? []).join(","),
    );
  }

  // ==========================================================================
  // R4-4  clamp + real mode block in one before_agent_start (the exact T20-B
  //       shape): retry convergence, block bytes, block placement
  // ==========================================================================
  {
    const project = ctx.scratch("t20-r4d-project");
    const agentClamp = ["read", "grep", "glob", "bash", "HostEcho"];
    // The third prompt is a REAL change: the catalog gains SubmitGoal and the
    // clamp drops HostEcho for it, so the preparation inputs differ from the
    // second prompt instead of repeating the same list.
    const goalClamp = ["read", "grep", "glob", "bash", "SubmitGoal"];
    const clampPlan = [agentClamp, agentClamp, goalClamp];
    const modePlan = ["agent", "plan", "goal"];
    const agentBlock = composeModeSystemPrompt("agent", "");
    const planBlock = composeModeSystemPrompt("plan", "");
    const goalBlock = composeModeSystemPrompt("goal", "");
    const run = await runScenario(ctx, provider, {
      label: "r4d-clamp-and-mode-block",
      catalogPlan: [[ECHO_TOOL], [ECHO_TOOL], [ECHO_TOOL, SUBMIT_GOAL_TOOL]],
      clampPlan,
      modePlan,
      prompts: [{ message: "one" }, { message: "two" }, { message: "three" }],
      turns: [
        { text: "one", finish: "stop" },
        { text: "two", finish: "stop" },
        { text: "three", finish: "stop" },
      ],
    });
    const systems = run.perPrompt.map((entry) => entry.systemText);
    const expectedBlocks = [agentBlock, planBlock, goalBlock];
    const prefixOf = (text, block) => (block.length > 0 && text.endsWith(block) ? text.slice(0, -block.length) : null);
    const expectedBlockBytes = expectedBlocks.map((block) => Buffer.byteLength(block, "utf8"));
    const systemBytes = systems.map((text) => Buffer.byteLength(text, "utf8"));
    const prefixBytes = systemBytes.map((bytes, index) => bytes - expectedBlockBytes[index]);
    ctx.note("r4d.observed", {
      attemptsPerPrompt: run.perPrompt.map((entry) => entry.startAttempts),
      toolsPerPrompt: run.perPrompt.map((entry) => entry.toolNames),
      catalogsPerPrompt: run.perPrompt.map((entry) => entry.catalogNames),
      clampsPerPrompt: run.perPrompt.map((entry) => entry.clamp),
      systemMessagesPerPrompt: run.perPrompt.map((entry) => entry.systemMessages),
      expectedBlockBytes,
      blockOccurrences: systems.map((text, index) => occurrences(text, expectedBlocks[index])),
      otherBlockOccurrences: systems.map((text, index) =>
        expectedBlocks.filter((_, other) => other !== index).map((block) => occurrences(text, block)),
      ),
      piDefaultBasePresent: systems.map((text) => text.includes("You are PI-Desktop, a local-first coding agent")),
      systemBytes,
      prefixBytes,
    });
    ctx.check(
      "R4: every prompt's tool list equals its catalog+clamp exactly (sequence, no residue, no duplicates)",
      run.perPrompt.every((entry, index) => sameSequence(entry.toolNames, clampPlan[index])),
      JSON.stringify(run.perPrompt.map((entry) => entry.toolNames)),
    );
    ctx.check(
      "R4: the third prompt is a real change (catalog gains SubmitGoal, clamp drops HostEcho)",
      !sameSequence(run.perPrompt[2].toolNames, run.perPrompt[1].toolNames) &&
        run.perPrompt[2].toolNames.includes("SubmitGoal") &&
        !run.perPrompt[2].toolNames.includes("HostEcho"),
      (run.perPrompt[2].toolNames ?? []).join(","),
    );
    ctx.check(
      "R4: a prompt that both clamps and appends a mode block is delivered within one policy retry",
      run.perPrompt[0].startAttempts <= 2 && run.perPrompt[0].requests.length >= 1,
      `attempts=${run.perPrompt[0].startAttempts} requests=${run.perPrompt[0].requests.length}`,
    );
    ctx.check(
      "R4: an unchanged clamp on the next prompt needs exactly one preparation",
      run.perPrompt[1].startAttempts === 1,
      `attempts=${run.perPrompt[1].startAttempts}`,
    );
    ctx.check(
      "R4: the real catalog+clamp change converges within one retry",
      run.perPrompt[2].startAttempts <= 2 && run.perPrompt[2].requests.length >= 1,
      `attempts=${run.perPrompt[2].startAttempts} requests=${run.perPrompt[2].requests.length}`,
    );
    ctx.check(
      "R2: the appended block is the production composeModeSystemPrompt(mode, '') bytes, exactly once",
      systems.every((text, index) => occurrences(text, expectedBlocks[index]) === 1),
      JSON.stringify(systems.map((text, index) => occurrences(text, expectedBlocks[index]))),
    );
    ctx.check(
      "R2: no other mode block is mixed into the prompt",
      systems.every((text, index) =>
        expectedBlocks.every((block, other) => other === index || occurrences(text, block) === 0),
      ),
      JSON.stringify(
        systems.map((text, index) =>
          expectedBlocks.filter((_, other) => other !== index).map((block) => occurrences(text, block)),
        ),
      ),
    );
    ctx.check(
      "R2: the runtime keeps exactly one system message",
      run.perPrompt.every((entry) => entry.systemMessages === 1),
      JSON.stringify(run.perPrompt.map((entry) => entry.systemMessages)),
    );
    ctx.check(
      "R2: PI Desktop's default base prompt is not injected",
      systems.every((text) => !text.includes("You are PI-Desktop, a local-first coding agent")),
    );
    const prefixes = systems.map((text, index) => prefixOf(text, expectedBlocks[index]));
    const sameToolList = (left, right) => sameSequence(run.perPrompt[left]?.toolNames ?? [], run.perPrompt[right]?.toolNames ?? []);
    ctx.check(
      "R2: the block is a pure append — the prompt text ends with it, and no mode block leaks into the prefix",
      prefixes.every((prefix, index) =>
        prefix !== null &&
        prefix.length > 0 &&
        !expectedBlocks.some((block) => occurrences(prefix, block) > 0),
      ),
      JSON.stringify(prefixes.map((prefix) => prefix?.length ?? -1)),
    );
    ctx.check(
      "R2: UTF-8 bytes satisfy system = prefix + block on every prompt",
      systemBytes.every((bytes, index) => bytes === prefixBytes[index] + expectedBlockBytes[index]) &&
        prefixBytes.every((bytes) => bytes > 0),
      `prefixBytes=${JSON.stringify(prefixBytes)} systemBytes=${JSON.stringify(systemBytes)} blockBytes=${JSON.stringify(expectedBlockBytes)}`,
    );
    ctx.check(
      "R2: prompts with the same tool catalog keep byte-identical prefixes (the block does not perturb the base)",
      prefixBytes[0] === prefixBytes[1] && sameToolList(0, 1),
      `prefixBytes=${JSON.stringify(prefixBytes)} tools0=${(run.perPrompt[0]?.toolNames ?? []).join(",")} tools1=${(run.perPrompt[1]?.toolNames ?? []).join(",")}`,
    );
    ctx.check(
      "R2: a changed tool catalog changes the base prefix, not the append shape (prompt 3 vs 2)",
      prefixBytes[2] !== prefixBytes[1] && systemBytes[2] === prefixBytes[2] + expectedBlockBytes[2],
      `prefixBytes2=${prefixBytes[2]} prefixBytes1=${prefixBytes[1]}`,
    );
    ctx.check(
      "R2: this is byte-parity evidence for the mode block only (source module equality)",
      readFileSync(APP_MODE_PROMPTS, "utf8") === readFileSync(PINNED_MODE_PROMPTS, "utf8"),
    );
  }
});

process.exit(evidence.ok ? 0 : 1);
