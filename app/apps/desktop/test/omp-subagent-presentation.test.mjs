import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { OmpEventConverter } = await import(
  pathToFileURL(join(here, "../../../packages/omp-runtime/src/session/events.ts"))
);
const { buildToolPresentation, hasToolDetails, runOutcome, toolResultPayload } =
  await import("../src/lib/tool-presentation.ts");

const converter = new OmpEventConverter({ sessionId: "s1", now: () => 1 });
const entry = (message, id = "entry-1") => ({
  id,
  parentId: null,
  timestamp: "2026-09-24T00:00:00.000Z",
  message: { timestamp: 1, ...message },
});
const tool = (content, details) =>
  entry({
    role: "toolResult",
    toolName: "read",
    toolCallId: "call-1",
    content,
    ...(details === undefined ? {} : { details }),
  });

test("a structured Read result unwraps to its details in the PI renderer", () => {
  const row = converter.convertEntry(
    tool([{ type: "text", text: "export const App = () => null;\n" }], {
      path: "src/App.tsx",
      root: "workspace",
      content: "export const App = () => null;\n",
      truncated: false,
    }),
  );
  assert.ok(row, "the tool row projects");
  // The row keeps the text in the envelope, not duplicated into `content`.
  assert.equal(row.content, "");
  const payload = toolResultPayload(row);
  assert.deepEqual(payload, {
    path: "src/App.tsx",
    root: "workspace",
    content: "export const App = () => null;\n",
    truncated: false,
  });
  assert.equal(hasToolDetails(row), true);
});

test("a text-only result reads through the row's content field", () => {
  const row = converter.convertEntry(tool("plain output"));
  assert.equal(row.toolResult, "");
  assert.equal(toolResultPayload(row), "plain output");
});

test("runOutcome still reads the exit code from a projected Bash result", () => {
  const row = converter.convertEntry(
    tool(
      [{ type: "text", text: "$ make build\nok" }],
      { command: "make build", exitCode: 0 },
    ),
  );
  assert.equal(row.toolName, "read");
  // Exercise the outcome path with a run-shaped message by renaming the tool.
  const run = { ...row, toolName: "Bash" };
  assert.equal(runOutcome(run), "ok");
});

test("a delegation's report survives in the envelope text blocks", () => {
  const row = converter.convertEntry(
    entry({
      role: "toolResult",
      toolName: "Task",
      toolCallId: "task-1",
      content: [{ type: "text", text: "Finished: implemented the change." }],
      details: {
        delegationId: "child-1",
        agent: "explorer",
        status: "completed",
        startedAt: 1_000,
        completedAt: 2_000,
        turns: 3,
      },
    }),
  );
  assert.ok(row, "the Task row projects");
  // The report must not be dropped: the PI renderer reads it from the envelope.
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const output = blocks.find((block) => block.role === "output");
  assert.ok(output, "the delegation report renders as an output block");
  assert.match(String(output.text ?? ""), /Finished: implemented the change/);
  // The counters render from the details, not a raw JSON blob.
  const details = blocks.find((block) => block.role === "details");
  assert.ok(details, "the delegation counters render as field rows");
});

test("a lifecycle row's roster reads the envelope and the delegations array", () => {
  const row = converter.convertEntry(
    entry({
      role: "toolResult",
      toolName: "TaskWait",
      toolCallId: "task-1",
      content: [{ type: "text", text: "one subagent still running" }],
      details: {
        delegations: [
          {
            delegationId: "child-1",
            agent: "explorer",
            status: "running",
            startedAt: 1_000,
            turns: 2,
          },
        ],
      },
    }),
  );
  assert.ok(row, "the TaskWait row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  // `envelopeTextOf` supplies the one-line summary from the envelope text.
  const output = blocks.find((block) => block.role === "output");
  assert.match(String(output.text ?? ""), /one subagent still running/);
  // `rosterRows` renders the named roster from `details.delegations`.
  const roster = blocks.find((block) => block.kind === "fields");
  assert.ok(roster, "the lifecycle roster renders as field rows");
});

test("an unknown tool's structured result degrades to fields, not a JSON blob", () => {
  const row = converter.convertEntry(
    entry({
      role: "toolResult",
      toolName: "PluginTool",
      toolCallId: "call-1",
      content: [{ type: "text", text: "done" }],
      details: { count: 42, label: "items" },
    }),
  );
  assert.ok(row, "the unknown tool row projects");
  const payload = toolResultPayload(row);
  assert.deepEqual(payload, { count: 42, label: "items" });
});
