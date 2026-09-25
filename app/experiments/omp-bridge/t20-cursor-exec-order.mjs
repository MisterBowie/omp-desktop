#!/usr/bin/env bun
/**
 * T20-R3 provider-gate experiment: WHEN does a Cursor exec-channel tool call
 * execute, relative to the assistant message that carries it?
 *
 * The strict R3 contract requires a batch decision *before* any physical
 * execution: an assistant message holding a `batchPolicy: "sole"` transition
 * tool (SubmitPlan/SubmitGoal) and any sibling call must be rejected wholesale
 * with zero executions. A decision on the assistant message can only be taken
 * once the message exists, so any call that executes while that message is
 * still streaming is unreachable for the decision.
 *
 * This script therefore measures ordering, not a patch:
 *
 *   real dispatcher  `<omp>/packages/ai/src/providers/cursor.ts`
 *                    `handleServerMessage` — the function the provider's socket
 *                    reader calls for every `execServerMessage`, awaited
 *                    through `stream.trackLocalWork` (cursor.ts:1170-1193).
 *   real bridge      `<omp>/packages/coding-agent/src/cursor.ts`
 *                    `CursorExecHandlers` — the class `sdk.ts:3114` installs
 *                    for a Cursor session. Its `shell`/`mcp` methods call
 *                    `executeTool`, which invokes the session tool's
 *                    `execute` (cursor.ts:230-289).
 *
 * Only the *tool bodies* and the h2 socket are fakes, and those are exactly the
 * two places a side effect can happen. No block is hand-stamped
 * `kCursorExecResolved`: the marker comes from the provider's own
 * `synthesizeCursorExecToolCall`.
 *
 * Frame dispatch mirrors the socket loop in `streamCursorWithWireMode`
 * (cursor.ts:854-882): each frame's `handleServerMessage` promise is
 * fire-and-forget but tracked, and the provider drains every tracked dispatch
 * before `stream.push({type:"done"})` (cursor.ts:950-960). The harness
 * reproduces that drain, because it is the reason "defer the exec until the
 * message is complete" cannot be expressed inside the client.
 *
 *   bun app/experiments/omp-bridge/t20-cursor-exec-order.mjs [--omp <checkout>] [--json]
 *
 * Exit code 0 = the strict contract held in every scenario; 1 = RED (the
 * contract is violated, which is the expected outcome for the pinned runtime).
 * No network, no paid model: every frame and every tool body is local.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const argv = process.argv.slice(2);
const ompIndex = argv.indexOf("--omp");
const OMP_ROOT = resolve(ompIndex === -1 ? join(REPO_ROOT, "upstream/oh-my-pi") : argv[ompIndex + 1]);
const AS_JSON = argv.includes("--json");
const PINNED_OMP_SHA = "d49918fab2dba3986927f2d46721629ed0f3a02c";

const SUBMIT_TOOL = "SubmitPlan";
const SIBLING_TOOL = "bash";

/** Import by absolute path so the checkout under test is the one that loads. */
const mod = async (...segments) => import(pathToFileURL(join(OMP_ROOT, ...segments)).href);

const [
  cursorProvider,
  proto,
  protobuf,
  blockSymbols,
  eventStreamModule,
  codingAgentCursor,
] = await Promise.all([
  mod("packages/ai/src/providers/cursor.ts"),
  mod("packages/catalog/src/discovery/cursor-proto.ts"),
  mod("packages/catalog/src/discovery/protobuf.ts"),
  mod("packages/ai/src/utils/block-symbols.ts"),
  mod("packages/ai/src/utils/event-stream.ts"),
  mod("packages/coding-agent/src/cursor.ts"),
]);

const { handleServerMessage, synthesizeCursorExecToolCall } = cursorProvider;
const { create, encodeJsonValue } = protobuf;
const {
  AgentServerMessageSchema,
  ExecServerMessageSchema,
  McpArgsSchema,
  ShellArgsSchema,
} = proto;
const { kCursorExecResolved } = blockSymbols;
const { CursorExecHandlers } = codingAgentCursor;

// ---------------------------------------------------------------------------
// Fixtures (shapes copied from the upstream Cursor suites:
// packages/ai/test/cursor-exec-modern.test.ts:76-122 / :1355-1362, so the
// dispatcher sees the same message objects the real provider builds).
// ---------------------------------------------------------------------------

function cursorAssistantMessage() {
  return {
    role: "assistant",
    content: [],
    api: "cursor-agent",
    provider: "cursor",
    model: "cursor-composer-2.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function newBlockState() {
  let textBlock = null;
  let thinkingBlock = null;
  let toolCall = null;
  return {
    get currentTextBlock() {
      return textBlock;
    },
    get currentThinkingBlock() {
      return thinkingBlock;
    },
    get currentToolCall() {
      return toolCall;
    },
    openToolCalls: new Map(),
    resolvedMcpToolCallIds: new Set(),
    firstTokenTime: undefined,
    setTextBlock: block => {
      textBlock = block;
    },
    setThinkingBlock: block => {
      thinkingBlock = block;
    },
    setToolCall: block => {
      toolCall = block;
    },
    setFirstTokenTime: () => {},
  };
}

function decodeClientFrame(frame) {
  const length = frame.readUInt32BE(1);
  return protobuf.fromBinary(proto.AgentClientMessageSchema, frame.subarray(5, 5 + length));
}

function execFrame(execId, message) {
  return create(AgentServerMessageSchema, {
    message: {
      case: "execServerMessage",
      value: create(ExecServerMessageSchema, { id: 7, execId, message }),
    },
  });
}

const shellFrame = (execId, toolCallId, command) =>
  execFrame(
    execId,
    { case: "shellArgs", value: create(ShellArgsSchema, { command, workingDirectory: OMP_ROOT, toolCallId }) },
  );

const submitFrame = (execId, toolCallId, args) =>
  execFrame(execId, {
    case: "mcpArgs",
    value: create(McpArgsSchema, {
      name: SUBMIT_TOOL,
      toolName: SUBMIT_TOOL,
      providerIdentifier: "pi-agent",
      toolCallId,
      args: Object.fromEntries(Object.entries(args).map(([key, value]) => [key, encodeJsonValue(JSON.stringify(value))])),
    }),
  });

/**
 * One assistant message driven through the real dispatcher.
 *
 * `frames` are dispatched exactly like the socket loop: fire-and-forget, all
 * tracked, then drained before `done` — the provider's own completion rule.
 */
async function runScenario({ label, scratch, frames, execHandlers, externalToolExecutor = false, order }) {
  const output = cursorAssistantMessage();
  const stream = new eventStreamModule.AssistantMessageEventStream();
  const state = newBlockState();
  const written = [];
  const h2Request = {
    write: chunk => {
      written.push(chunk);
      return true;
    },
  };

  const events = [];
  const toolExecutions = [];
  let sequence = 0;
  const record = event => {
    sequence += 1;
    events.push({ seq: sequence, event });
  };

  const consume = (async () => {
    for await (const event of stream) {
      if (event.type === "toolcall_start" || event.type === "toolcall_end") {
        record(`${event.type}:${event.toolCall?.name ?? output.content[event.contentIndex]?.name ?? "?"}`);
      } else {
        record(event.type);
      }
    }
  })();

  const tools = new Map();
  const makeTool = (name, body) => ({
    name,
    label: name,
    description: `${name} fixture`,
    parameters: { type: "object", properties: {} },
    execute: async (toolCallId, args) => {
      sequence += 1;
      toolExecutions.push({ seq: sequence, toolName: name, toolCallId, args });
      const result = body(args, toolCallId);
      return result;
    },
  });
  tools.set(SIBLING_TOOL, makeTool(SIBLING_TOOL, args => {
    const target = join(scratch, "sibling.txt");
    writeFileSync(target, `ran:${args.command ?? ""}`);
    return { content: [{ type: "text", text: "sibling ran" }], details: { wrote: target } };
  }));
  tools.set(SUBMIT_TOOL, makeTool(SUBMIT_TOOL, () => {
    const target = join(scratch, "submitted.json");
    writeFileSync(target, JSON.stringify({ submitted: true }));
    // The desktop host tool answers with `terminate: true`; the bridge only
    // copies content/details/isError into its ToolResultMessage (cursor.ts:206-219).
    return { content: [{ type: "text", text: "plan submitted" }], details: {}, terminate: true };
  }));

  const bridge = new CursorExecHandlers({
    cwd: scratch,
    tools,
    getToolContext: () => undefined,
    emitEvent: event => {
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        record(`${event.type}:${event.toolName}`);
      }
    },
  });
  const resolvedHandlers = execHandlers === "bridge" ? bridge : execHandlers;

  const results = [];
  const inFlight = new Set();
  for (const frame of frames) {
    record(`dispatch:${frame.message.value.message.case}`);
    const dispatch = handleServerMessage(
      frame,
      output,
      stream,
      state,
      new Map(),
      h2Request,
      resolvedHandlers,
      result => {
        results.push(result);
        return result;
      },
      { sawTokenDelta: false },
      [],
      [],
      undefined,
      externalToolExecutor,
    ).catch(error => record(`dispatch-error:${String(error)}`));
    inFlight.add(dispatch);
    void dispatch.finally(() => inFlight.delete(dispatch));
  }
  await Promise.all([...inFlight]);
  record("drain:complete");
  // cursor.ts:950-960 — `done` is pushed only after every tracked dispatch settles.
  stream.push({ type: "done", reason: output.stopReason, message: output });
  stream.end(output);
  await consume;

  const toolCallBlocks = output.content.filter(block => block.type === "toolCall");
  const blocks = toolCallBlocks.map(block => ({
    id: block.id,
    name: block.name,
    resolved: block[kCursorExecResolved] === true,
    args: block.arguments,
  }));
  const wire = written.map(frame => {
    const decoded = decodeClientFrame(frame);
    const value = decoded.message.value;
    // ExecClientMessage { id, execId, message: {case:"shellResult"|"mcpResult"|…, value} }
    const answer = value?.message;
    const result = answer?.value?.result;
    return {
      frame: decoded.message.case,
      answer: answer?.case,
      result: result?.case,
      payload: JSON.stringify(result?.value ?? answer?.value ?? {}).slice(0, 400),
    };
  });

  const doneSeq = events.find(event => event.event === "done")?.seq ?? -1;
  const executionsBeforeDone = toolExecutions.filter(execution => execution.seq < doneSeq);
  const siblingPath = join(scratch, "sibling.txt");
  const submitPath = join(scratch, "submitted.json");

  return {
    label,
    order,
    events,
    toolExecutions: toolExecutions.map(({ seq, toolName, toolCallId }) => ({ seq, toolName, toolCallId })),
    executionsBeforeDone,
    wire,
    blocks,
    results: results.map(result => ({
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      isError: result.isError,
      text: result.content?.find(part => part.type === "text")?.text,
      hasTerminate: Object.hasOwn(result, "terminate"),
    })),
    sideEffects: { sibling: existsSync(siblingPath), submit: existsSync(submitPath) },
    doneSeq,
  };
}

// ---------------------------------------------------------------------------
// Does a pending exec handler gate the message's completion?
//
// Same fixture, one frame at a time: the shell frame's handler cannot settle
// until the gate opens, so the question is whether anything else can progress.
// The harness releases the gate and only then pushes `done`, mirroring the
// provider (`cursor.ts:950-960` drains tracked dispatches before `done`).
// ---------------------------------------------------------------------------
async function runGatedScenario(scratch) {
  const output = cursorAssistantMessage();
  const stream = new eventStreamModule.AssistantMessageEventStream();
  const state = newBlockState();
  const written = [];
  const h2Request = { write: chunk => { written.push(chunk); return true; } };

  const events = [];
  let sequence = 0;
  const record = event => events.push({ seq: ++sequence, event });

  const gate = Promise.withResolvers();
  const results = [];
  const tools = new Map();
  let submitExecutions = 0;
  tools.set(SUBMIT_TOOL, {
    name: SUBMIT_TOOL,
    label: SUBMIT_TOOL,
    description: "fixture",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      submitExecutions += 1;
      record("tool:SubmitPlan:execute");
      return { content: [{ type: "text", text: "plan submitted" }], details: {} };
    },
  });
  const bridge = new CursorExecHandlers({ cwd: scratch, tools, getToolContext: () => undefined });
  const handlers = {
    shell: async () => {
      record("handler:shell:enter");
      await gate.promise;
      record("handler:shell:leave");
      return { toolResult: undefined };
    },
    mcp: bridge.mcp.bind(bridge),
  };

  const inFlight = new Set();
  const dispatch = frame => {
    record(`dispatch:${frame.message.value.message.case}`);
    const promise = handleServerMessage(
      frame,
      output,
      stream,
      state,
      new Map(),
      h2Request,
      handlers,
      result => {
        results.push(result);
        return result;
      },
      { sawTokenDelta: false },
      [],
      [],
      undefined,
      false,
    ).catch(error => record(`dispatch-error:${String(error)}`));
    inFlight.add(promise);
    void promise.finally(() => inFlight.delete(promise));
  };

  dispatch(shellFrame("exec-gate-shell", "call-gate-shell", "sleep"));
  dispatch(submitFrame("exec-gate-submit", "call-gate-submit", { title: "T", markdown: "# P", question: "?" }));
  await new Promise(resolveTimer => setTimeout(resolveTimer, 50));

  const submitRanWhileShellPending = submitExecutions > 0 && !events.some(event => event.event === "handler:shell:leave");
  const pendingLocalWork = stream.hasPendingLocalWork === true;
  const doneBeforeRelease = events.some(event => event.event === "done");

  gate.resolve();
  await Promise.all([...inFlight]);
  record("drain:complete");
  // cursor.ts:949-955 — the provider's own completion rule.
  stream.push({ type: "done", reason: output.stopReason, message: output });
  record("done");
  stream.end(output);
  for await (const _ of stream) {
    // drain; ordering is already recorded
  }
  const eventOrder = events.map(event => event.event);

  return {
    label: "s6-gated-handler",
    submitRanWhileShellPending,
    pendingLocalWork,
    doneBeforeRelease,
    handlerLeaveBeforeDrain: eventOrder.indexOf("handler:shell:leave") < eventOrder.indexOf("drain:complete"),
    doneAfterDrain: eventOrder.indexOf("done") > eventOrder.indexOf("drain:complete"),
    events,
    blocks: output.content
      .filter(block => block.type === "toolCall")
      .map(block => ({ id: block.id, name: block.name, resolved: block[kCursorExecResolved] === true })),
    results: results.map(result => ({ toolCallId: result.toolCallId, toolName: result.toolName, isError: result.isError })),
  };
}

// ---------------------------------------------------------------------------
// Strict-contract checks. `ok` means the contract HELD.
// ---------------------------------------------------------------------------
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const scenarioDir = mkdtempSync(join(tmpdir(), "t20-cursor-exec-"));
const scenarioScratch = label => {
  const dir = join(scenarioDir, label);
  mkdirSync(dir, { recursive: true });
  return dir;
};

const scenarios = {};

try {
  // ---- mixed batch, sibling first -----------------------------------------
  scenarios.siblingFirst = await runScenario({
    label: "s1-mixed-sibling-first",
    order: ["shell", "mcp"],
    scratch: scenarioScratch("s1"),
    execHandlers: "bridge",
    frames: [
      shellFrame("exec-shell-first", "call-sibling-1", "touch sibling.txt"),
      submitFrame("exec-submit-first", "call-submit-1", { title: "T", markdown: "# Plan", question: "Approve?" }),
    ],
  });
  // ---- mixed batch, submit first ------------------------------------------
  scenarios.submitFirst = await runScenario({
    label: "s2-mixed-submit-first",
    order: ["mcp", "shell"],
    scratch: scenarioScratch("s2"),
    execHandlers: "bridge",
    frames: [
      submitFrame("exec-submit-second", "call-submit-2", { title: "T", markdown: "# Plan", question: "Approve?" }),
      shellFrame("exec-shell-second", "call-sibling-2", "touch sibling.txt"),
    ],
  });
  // ---- the transition call alone -----------------------------------------
  scenarios.soleSubmit = await runScenario({
    label: "s3-sole-submit",
    order: ["mcp"],
    scratch: scenarioScratch("s3"),
    execHandlers: "bridge",
    frames: [submitFrame("exec-submit-sole", "call-submit-sole", { title: "T", markdown: "# Plan", question: "?" })],
  });
  // ---- no exec handlers at all (the "Tool not available" shape) -----------
  scenarios.noHandlers = await runScenario({
    label: "s4-no-handlers",
    order: ["shell", "mcp"],
    scratch: scenarioScratch("s4"),
    execHandlers: undefined,
    frames: [
      shellFrame("exec-shell-none", "call-sibling-none", "touch sibling.txt"),
      submitFrame("exec-submit-none", "call-submit-none", { title: "T", markdown: "# Plan", question: "?" }),
    ],
  });
  // ---- external handoff (handlers present but no `mcp` method) -----------
  // The Cursor `mcpArgs` branch only synthesizes/marks a block when
  // `execHandlers.mcp` exists (cursor.ts:1938-1952), and with
  // `externalToolExecutor` the wire answer becomes a handoff instead of
  // `toolNotFound` (cursor.ts:1959-1962). This scenario measures what the
  // dispatcher does by itself in that configuration: it cannot show the loop
  // picking the call up, because the block arrives on a different channel
  // (`processInteractionUpdate`), which this harness does not fabricate.
  scenarios.externalHandoff = await runScenario({
    label: "s5-external-handoff",
    order: ["mcp"],
    scratch: scenarioScratch("s5"),
    execHandlers: { shell: async () => ({ toolResult: undefined }) },
    externalToolExecutor: true,
    frames: [submitFrame("exec-submit-handoff", "call-submit-handoff", { title: "T", markdown: "# P", question: "?" })],
  });

  // ---- Scheme B shape: no native handlers, no `mcp`, external handoff -----
  // The configuration an "all-loop routing" scheme would have to use: native
  // exec frames have no executor, non-native calls are handed off. Measured to
  // show what each half costs: the native sibling is refused with a fabricated
  // "Tool not available", and no block is synthesized for the handed-off call.
  scenarios.schemeB = await runScenario({
    label: "s7-scheme-b-config",
    order: ["shell", "mcp"],
    scratch: scenarioScratch("s7"),
    execHandlers: {},
    externalToolExecutor: true,
    frames: [
      shellFrame("exec-shell-b", "call-sibling-b", "touch sibling.txt"),
      submitFrame("exec-submit-b", "call-submit-b", { title: "T", markdown: "# Plan", question: "?" }),
    ],
  });

  // ---- does a pending exec handler gate the message's completion? --------
  scenarios.gated = await runGatedScenario(scenarioScratch("s6"));
} finally {
  rmSync(scenarioDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

for (const key of ["siblingFirst", "submitFirst"]) {
  const scenario = scenarios[key];
  const siblingRuns = scenario.toolExecutions.filter(execution => execution.toolName === SIBLING_TOOL);
  const submitRuns = scenario.toolExecutions.filter(execution => execution.toolName === SUBMIT_TOOL);
  check(
    `${key}: the sibling in a batch that also holds ${SUBMIT_TOOL} executes ZERO times`,
    siblingRuns.length === 0 && !scenario.sideEffects.sibling,
    `sibling executions: ${siblingRuns.length}, side-effect file: ${scenario.sideEffects.sibling}`,
  );
  check(
    `${key}: the transition call itself is not executed by the provider`,
    submitRuns.length === 0,
    `SubmitPlan executions: ${submitRuns.length}`,
  );
  check(
    `${key}: every execution happens after the batch verdict (i.e. after the message is complete)`,
    scenario.executionsBeforeDone.length === 0,
    `executions before the stream's done event: ${scenario.executionsBeforeDone.length} of ${scenario.toolExecutions.length}`,
  );
  check(
    `${key}: the server is not told the sibling succeeded`,
    !scenario.wire.some(frame => frame.answer === "shellResult" && frame.result === "success"),
    JSON.stringify(scenario.wire),
  );
  check(
    `${key}: the successful submit cannot end the run (no terminate reaches the loop)`,
    scenario.blocks.every(block => block.resolved !== true) &&
      scenario.results.every(result => result.hasTerminate !== true),
    `blocks=${JSON.stringify(scenario.blocks)} results=${JSON.stringify(scenario.results)}`,
  );
}

check(
  "sole SubmitPlan: the provider leaves the call to the agent loop",
  scenarios.soleSubmit.toolExecutions.filter(execution => execution.toolName === SUBMIT_TOOL).length === 0,
  `SubmitPlan executions: ${scenarios.soleSubmit.toolExecutions.length}, blocks: ${JSON.stringify(scenarios.soleSubmit.blocks)}`,
);
check(
  "sole SubmitPlan: termination stays available to the loop",
  scenarios.soleSubmit.blocks.every(block => block.resolved !== true),
  JSON.stringify(scenarios.soleSubmit.blocks),
);
check(
  "no handlers: no tool call is answered with a fabricated failure",
  !scenarios.noHandlers.wire.some(
    frame => /Tool not available/.test(frame.payload) || frame.result === "toolNotFound",
  ),
  JSON.stringify(scenarios.noHandlers.wire),
);

// Scheme-relevant facts (not strict-contract verdicts): recorded so the
// scheme analysis below rests on measurements, not on reading only.
const observations = {
  gated: {
    framesNotSerialized: scenarios.gated.submitRanWhileShellPending,
    pendingLocalWorkWhileHandlerRuns: scenarios.gated.pendingLocalWork,
    doneBeforeGateRelease: scenarios.gated.doneBeforeRelease,
    doneAfterDrain: scenarios.gated.doneAfterDrain,
    note: "a handler that never settles keeps stream.hasPendingLocalWork true and blocks the provider's pre-done drain (cursor.ts:950-960); upstream's own http2 fixture asserts the same for done/error/abort (packages/ai/test/cursor-terminal-error.test.ts)",
  },
  externalHandoff: {
    blocks: scenarios.externalHandoff.blocks,
    pairedResults: scenarios.externalHandoff.results,
    wire: scenarios.externalHandoff.wire,
    note: "with no `mcp` handler the exec branch synthesizes no block and pairs nothing (cursor.ts:1938-1952); the block for such a call must therefore come from the interaction-update channel, which this harness does not fabricate",
  },
};

check(
  "external handoff: the exec branch leaves a non-native call to the loop (no block, no pair, handoff ack)",
  scenarios.externalHandoff.blocks.length === 0 &&
    scenarios.externalHandoff.results.length === 0 &&
    scenarios.externalHandoff.wire.some(frame => frame.answer === "mcpResult" && frame.result === "success"),
  `blocks=${JSON.stringify(scenarios.externalHandoff.blocks)} results=${scenarios.externalHandoff.results.length} wire=${JSON.stringify(scenarios.externalHandoff.wire)}`,
);
check(
  "deferral is expressible: the message can complete while an exec handler is still pending",
  scenarios.gated.doneBeforeRelease === true,
  "the provider's pre-done drain means an unresolved handler blocks `done`; a scheme that waits for message_end before executing would deadlock against its own completion",
);

check(
  "scheme B: native frames can be executed without a local executor (no fabricated failure)",
  scenarios.schemeB.toolExecutions.length === 0 &&
    !scenarios.schemeB.wire.some(frame => /Tool not available/.test(frame.payload) || frame.result === "toolNotFound"),
  `executions=${scenarios.schemeB.toolExecutions.length} wire=${JSON.stringify(scenarios.schemeB.wire)}`,
);

const passed = checks.filter(entry => entry.ok).length;
const report = {
  generatedAt: new Date().toISOString(),
  runtime: {
    ompRoot: OMP_ROOT,
    ompHead: spawnSync("git", ["-C", OMP_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
    pinnedOmpSha: PINNED_OMP_SHA,
    bun: process.versions.bun ?? null,
    node: process.versions.node,
    fileHashes: Object.fromEntries(
      [
        "packages/ai/src/providers/cursor.ts",
        "packages/coding-agent/src/cursor.ts",
        "packages/ai/src/utils/block-symbols.ts",
      ].map(relative => {
        const bytes = readFileSync(join(OMP_ROOT, relative));
        const hasher = new Bun.CryptoHasher("sha256");
        hasher.update(bytes);
        return [relative, hasher.digest("hex")];
      }),
    ),
  },
  scenarios,
  observations,
  checks,
  summary: { total: checks.length, contractHeld: passed, contractViolated: checks.length - passed, red: passed < checks.length },
};

const resultsDir = join(HERE, "results");
mkdirSync(resultsDir, { recursive: true });
const resultsPath = join(resultsDir, "t20-cursor-exec-order.json");
writeFileSync(resultsPath, `${JSON.stringify(report, null, 2)}\n`);

if (AS_JSON) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const lines = [
    `OMP ${report.runtime.ompHead} @ ${OMP_ROOT}`,
    ...Object.values(scenarios)
      .filter(scenario => scenario.order !== undefined)
      .flatMap(scenario => [
        "",
        `## ${scenario.label} (${scenario.order.join(" -> ")})`,
        `  call order: ${scenario.events.map(event => event.event).join(" | ")}`,
        `  tool executions: ${scenario.toolExecutions.map(execution => `${execution.toolName}@${execution.seq}`).join(", ") || "none"}`,
        `  exec-resolved blocks: ${JSON.stringify(scenario.blocks)}`,
        `  wire answers: ${JSON.stringify(scenario.wire)}`,
        `  paired results: ${JSON.stringify(scenario.results)}`,
        `  side effects: ${JSON.stringify(scenario.sideEffects)}`,
      ]),
    "",
    `## ${scenarios.gated.label}`,
    `  call order: ${scenarios.gated.events.map(event => event.event).join(" | ")}`,
    `  submit ran while shell handler was pending: ${scenarios.gated.submitRanWhileShellPending}`,
    `  pendingLocalWork while handler runs: ${scenarios.gated.pendingLocalWork}`,
    `  done before gate release: ${scenarios.gated.doneBeforeRelease}`,
    `  done after drain: ${scenarios.gated.doneAfterDrain}`,
    "",
    `## checks (${passed}/${checks.length} contract checks held)`,
    ...checks.map(entry => `  ${entry.ok ? "PASS" : "FAIL"}  ${entry.name}\n        ${entry.detail}`),
    "",
    `results: ${resultsPath}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

process.exit(report.summary.red ? 1 : 0);
