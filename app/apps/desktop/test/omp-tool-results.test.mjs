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
const {
  buildToolPresentation,
  runOutcome,
  toolResultChips,
} = await import("../src/lib/tool-presentation.ts");

const converter = new OmpEventConverter({ sessionId: "s1", now: () => 1 });
const entry = (message, id = "entry-1") => ({
  id,
  parentId: null,
  timestamp: "2026-09-24T00:00:00.000Z",
  message: { timestamp: 1, ...message },
});
const tool = (toolName, content, details, id = "call-1") =>
  entry(
    {
      role: "toolResult",
      toolName,
      toolCallId: id,
      content,
      ...(details === undefined ? {} : { details }),
    },
    `entry-${id}`,
  );

const byRole = (blocks, role) => blocks.filter((block) => block.role === role);
const fieldValues = (blocks) =>
  blocks
    .filter((block) => block.kind === "fields")
    .flatMap((block) => block.rows.map((row) => `${row.label}: ${row.value}`));
const allText = (blocks) => JSON.stringify(blocks);

test("LSP diagnostics text is visible and is not read as a tool failure", () => {
  const row = converter.convertEntry(
    tool("lsp", [{ type: "text", text: "Diagnostics: 1 error(s)\nsrc/example.ts:1:7 [error] [ts] Type 'number' is not assignable to type 'string'. (2322)" }], {
      action: "diagnostics",
      serverName: "typescript",
      success: true,
    }),
  );
  assert.ok(row, "the LSP row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const output = byRole(blocks, "output");
  assert.equal(output.length, 1, "the diagnostic text renders as one output block");
  assert.match(output[0].text, /Type 'number' is not assignable to type 'string'/);
  assert.equal(blocks.some((block) => block.lang === "json"), false, "metadata renders as rows, not a JSON blob");
  assert.deepEqual(
    fieldValues(blocks).filter((v) => v.startsWith("serverName") || v.startsWith("action")),
    ["serverName: typescript", "action: diagnostics"],
  );
  // Error-severity findings are a successful LSP answer, not a failed tool.
  assert.equal(runOutcome(row), "ok");
});

test("an LSP all-servers-failed result shows the failure with an error tone", () => {
  const row = converter.convertEntry(
    tool("lsp", [{ type: "text", text: "src/example.ts: all language servers failed (typescript)" }], {
      action: "diagnostics",
      serverName: "typescript",
      success: false,
    }),
  );
  assert.ok(row, "the LSP row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const error = byRole(blocks, "error");
  assert.equal(error.length, 1, "the server failure renders as an error block");
  assert.match(error[0].text, /all language servers failed/);
  assert.equal(error[0].tone, "error");
  // The producer does not set isError for a server failure, so the row itself
  // is not declared failed.
  assert.equal(runOutcome(row), "ok");
});

test("a text-only debug failure still shows its message", () => {
  // The producer throws on a debug failure: `{ content, isError: true }` with
  // no `details`. The row is text-only, so the generic fallback must show it.
  const row = converter.convertEntry(
    entry({
      role: "toolResult",
      toolName: "debug",
      toolCallId: "call-debug-fail",
      content: [{ type: "text", text: "debug: adapter 'dlv' failed to launch" }],
      isError: true,
    }),
  );
  assert.ok(row, "the failed debug row projects");
  assert.equal(row.toolResult, "", "a text-only result carries no envelope");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  assert.match(byRole(blocks, "output")[0].text, /adapter 'dlv' failed to launch/);
  assert.equal(runOutcome(row), "failed");
});

test("debug evaluate flattens snapshot and evaluation instead of a JSON blob", () => {
  const row = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Result: EVALUATED_VALUE_42" }], {
      action: "evaluate",
      success: true,
      snapshot: { id: "session-1", adapter: "mock", status: "stopped", cwd: "/tmp/example", program: "example.js" },
      evaluation: { result: "EVALUATED_VALUE_42", type: "string", variablesReference: 0 },
    }),
  );
  assert.ok(row, "the debug row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const values = fieldValues(blocks);
  assert.ok(values.includes("adapter: mock"), "snapshot adapter renders as a field");
  assert.ok(values.includes("status: stopped"), "snapshot status renders as a field");
  assert.ok(values.includes("cwd: /tmp/example"), "snapshot cwd renders as a field");
  assert.ok(values.includes("program: example.js"), "snapshot program renders as a field");
  assert.ok(values.includes("result: EVALUATED_VALUE_42"), "evaluation value renders as a field");
  assert.ok(values.includes("type: string"), "evaluation type renders as a field");
  assert.ok(values.includes("action: evaluate"), "action renders as a field");
  assert.doesNotMatch(allText(blocks), /"snapshot"/, "the snapshot is not a JSON blob");
  assert.doesNotMatch(allText(blocks), /"evaluation"/, "the evaluation is not a JSON blob");
});

test("debug paused snapshot shows location, stop reason, breakpoints and output", () => {
  const row = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Program paused." }], {
      action: "continue",
      success: true,
      snapshot: {
        id: "session-1",
        adapter: "mock",
        status: "paused",
        cwd: "/tmp/example",
        program: "example.js",
        stopReason: "breakpoint",
        frameName: "main",
        source: { path: "src/example.ts" },
        line: 10,
        column: 5,
        needsConfigurationDone: false,
      },
      breakpoints: [{ line: 10, verified: true, condition: "x > 0" }],
      output: "program started\n",
    }),
  );
  assert.ok(row, "the debug row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const values = fieldValues(blocks);
  assert.ok(values.includes("location: src/example.ts:10:5"), "the stop location renders");
  assert.ok(values.includes("stopReason: breakpoint"), "the stop reason renders");
  assert.ok(values.includes("frameName: main"), "the frame renders");
  assert.ok(values.some((v) => v.startsWith("breakpoint: line 10")), "the breakpoint renders as a row");
  const output = byRole(blocks, "output").find((b) => b.text.includes("program started"));
  assert.ok(output, "the debugger console output renders");
});

test("edit renders a single-file change as a diff, not a JSON blob", () => {
  const row = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated src/App.tsx" }], {
      path: "src/App.tsx",
      op: "update",
      diff: "-1|old\n+1|new",
      oldText: "old\n",
      newText: "new\n",
    }),
  );
  assert.ok(row, "the edit row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const files = blocks.find((block) => block.kind === "files");
  assert.ok(files, "the edited path is an openable file list");
  assert.deepEqual(files.paths, ["src/App.tsx"]);
  const diff = blocks.find((block) => block.kind === "diff");
  assert.ok(diff, "the source snapshots render a colored diff");
  assert.ok(diff.lines.some((line) => line.type === "del" && line.text === "old"));
  assert.ok(diff.lines.some((line) => line.type === "add" && line.text === "new"));
  assert.doesNotMatch(allText(blocks), /"perFileResults"/);
  assert.doesNotMatch(allText(blocks), /"oldText"/);
});

test("edit renders multi-file results one file at a time", () => {
  const row = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated 2 files" }], {
      perFileResults: [
        { path: "a.ts", op: "update", diff: "-1|a\n+1|A", oldText: "a\n", newText: "A\n" },
        { path: "b.ts", op: "update", diff: "-1|b\n+1|B", oldText: "b\n", newText: "B\n" },
      ],
    }),
  );
  assert.ok(row, "the multi-file edit row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const filesBlocks = blocks.filter((block) => block.kind === "files");
  assert.deepEqual(
    filesBlocks.map((block) => block.paths),
    [["a.ts"], ["b.ts"]],
  );
  const diffs = blocks.filter((block) => block.kind === "diff");
  assert.equal(diffs.length, 2, "each file renders its own diff");
});

test("edit rename shows source → destination with no diff body", () => {
  const row = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Moved a.ts to b.ts" }], {
      op: "update",
      path: "b.ts",
      move: "b.ts",
      sourcePath: "a.ts",
      diff: "",
    }),
  );
  assert.ok(row, "the move row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const files = blocks.find((block) => block.kind === "files");
  assert.ok(files, "a move exposes both paths as an openable file list");
  assert.deepEqual(files.paths, ["a.ts", "b.ts"]);
  assert.equal(blocks.some((block) => block.kind === "diff"), false, "a move has no diff body");
  assert.doesNotMatch(allText(blocks), /no changes/, "a move is not reported as a no-op");
  assert.ok(
    fieldValues(blocks).includes("move: a.ts → b.ts"),
    "the rename relationship reads as a move, not two unrelated files",
  );
});

test("edit create and delete show the added and removed content", () => {
  const created = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Created created.txt" }], {
      path: "created.txt",
      op: "create",
      diff: "+1|created",
      newText: "created\n",
    }),
  );
  const createdBlocks = buildToolPresentation(created, { hideSummaryArg: true });
  assert.ok(fieldValues(createdBlocks).includes("operation: create"));
  const written = byRole(createdBlocks, "written");
  assert.equal(written[0].text, "created\n");

  const deleted = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Deleted deleted.txt" }], {
      path: "deleted.txt",
      op: "delete",
      diff: "-1|gone",
      oldText: "gone\n",
    }),
  );
  const deletedBlocks = buildToolPresentation(deleted, { hideSummaryArg: true });
  assert.ok(fieldValues(deletedBlocks).includes("operation: delete"));
  const content = byRole(deletedBlocks, "content");
  assert.equal(content[0].text, "gone\n");
});

test("edit no-op and pruned snapshots stay honest", () => {
  const noop = converter.convertEntry(
    tool("edit", [{ type: "text", text: "no change" }], {
      op: "update",
      path: "scripts/real.ts",
      diff: "",
    }),
  );
  const noopBlocks = buildToolPresentation(noop, { hideSummaryArg: true });
  const notice = byRole(noopBlocks, "notice").find((b) => /no changes were made to scripts\/real\.ts/.test(b.text));
  assert.ok(notice, "a genuine no-op says so and names the path");

  const pruned = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated large.txt" }], {
      path: "large.txt",
      diff: "+9001|new",
      firstChangedLine: 9001,
      snapshotsPruned: true,
    }),
  );
  const prunedBlocks = buildToolPresentation(pruned, { hideSummaryArg: true });
  const diff = byRole(prunedBlocks, "diff").find((b) => b.text.includes("+9001|new"));
  assert.ok(diff, "a pruned result keeps its diff metadata");
  assert.ok(
    byRole(prunedBlocks, "notice").some((b) => /pruned/.test(b.text)),
    "a pruned result says the snapshots were dropped",
  );
});

test("edit partial errors surface per-file error text", () => {
  const row = converter.convertEntry(
    tool("edit", [{ type: "text", text: "1 file updated, 1 failed" }], {
      perFileResults: [
        { path: "ok.ts", op: "update", diff: "-1|a\n+1|b", oldText: "a\n", newText: "b\n" },
        { path: "bad.ts", op: "update", isError: true, displayErrorText: "hashline mismatch" },
      ],
    }),
  );
  assert.ok(row, "the partial-error edit row projects");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const error = byRole(blocks, "error");
  assert.equal(error.length, 1);
  assert.match(error[0].text, /hashline mismatch/);
});

test("the live tool_execution_end path shows LSP text through the same presenter", () => {
  const events = converter.convert({
    type: "tool_execution_end",
    toolCallId: "call-lsp-live",
    toolName: "lsp",
    result: {
      content: [{ type: "text", text: "Diagnostics: 1 error(s)\nsrc/x.ts:2:3 [error] missing return" }],
      details: { action: "diagnostics", serverName: "typescript", success: true },
    },
    isError: false,
  });
  const event = events[0];
  assert.equal(event.type, "tool_end");
  const row = {
    toolName: "lsp",
    toolArgs: { action: "diagnostics" },
    toolResult: event.result,
    toolStatus: event.isError ? "error" : "success",
  };
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  assert.match(byRole(blocks, "output")[0].text, /missing return/);
});

test("a child transcript row shares the same presentation", () => {
  const child = new OmpEventConverter({
    sessionId: "s1",
    now: () => 1,
    parentToolCallId: "parent-1",
    agentName: "explorer",
  });
  const row = child.convertEntry(
    tool("lsp", [{ type: "text", text: "src/child.ts:1:1 [error] bad" }], {
      action: "diagnostics",
      serverName: "typescript",
      success: true,
    }),
  );
  assert.ok(row, "the child tool row projects");
  assert.equal(row.parentToolCallId, "parent-1");
  assert.equal(row.agentName, "explorer");
  assert.match(byRole(buildToolPresentation(row, { hideSummaryArg: true }), "output")[0].text, /bad/);
});

test("a PI Edit with `ops` does not take the OMP path", () => {
  // PI's Edit result has no `diff`/`perFileResults`; its stated ops still show.
  const row = converter.convertEntry(
    tool(
      "edit",
      [{ type: "text", text: "edit complete" }],
      { root: "workspace", warnings: [] },
      "pi-edit",
    ),
  );
  const message = { toolName: "Edit", toolArgs: { ops: "Replace old with new" }, toolResult: row.toolResult };
  const blocks = buildToolPresentation(message, { hideSummaryArg: false });
  const input = byRole(blocks, "input");
  assert.ok(input.some((b) => b.text === "Replace old with new"), "the PI ops still render");
});

test("a large Unicode LSP result stays within the durable row bound and readable", () => {
  const ROW_BUDGET_BYTES = 4 * 1024 * 1024;
  const text = "⚠".repeat(2_500_000) + " Diagnostics tail";
  const row = converter.convertEntry(
    tool("lsp", [{ type: "text", text }], {
      action: "diagnostics",
      serverName: "typescript",
      success: true,
    }),
  );
  assert.ok(row, "the oversized LSP row projects");
  assert.ok(
    Buffer.byteLength(JSON.stringify(row), "utf8") <= ROW_BUDGET_BYTES,
    "the whole row stays within the 4 MiB bound",
  );
  assert.deepEqual(toolResultChips(row), [{ role: "truncated" }]);
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const output = byRole(blocks, "output")[0];
  assert.ok(output.text.endsWith("\u2026"), "the retained text is visibly truncated");
});

// ---------------------------------------------------------------------------
// Independent-review regressions: the presenter must not drop text that lives
// outside `details`, diagnostics it does not map, or unknown producer fields.
// ---------------------------------------------------------------------------

test("a text-only LSP ToolError (read-only/timeout) keeps its message and error tone", () => {
  // The producer throws ToolError: `{ content, isError: true }` with no
  // `details`. The durable projection puts the text on `content` and empties
  // `toolResult`, so the LSP mapping must read the row content, not only the
  // envelope.
  const row = converter.convertEntry(
    entry({
      role: "toolResult",
      toolName: "lsp",
      toolCallId: "call-lsp-timeout",
      content: [{ type: "text", text: "LSP definition timed out after 30s on typescript." }],
      isError: true,
    }),
  );
  assert.ok(row, "the LSP failure row projects");
  assert.equal(row.toolResult, "", "a text-only result carries no envelope");
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const error = byRole(blocks, "error")[0];
  assert.match(error.text, /timed out after 30s/);
  assert.equal(error.tone, "error");
  assert.equal(runOutcome(row), "failed");
});

test("debug no-session terminate and empty output keep their producer text", () => {
  const terminate = converter.convertEntry(
    tool("debug", [{ type: "text", text: "No debug session to terminate." }], {
      action: "terminate",
      success: true,
    }),
  );
  const terminateBlocks = buildToolPresentation(terminate, { hideSummaryArg: true });
  assert.ok(
    byRole(terminateBlocks, "output").some((b) => b.text.includes("No debug session to terminate.")),
    "a metadata-only terminate still shows its message",
  );

  const emptyOutput = converter.convertEntry(
    tool("debug", [{ type: "text", text: "(no output captured)" }], {
      action: "output",
      success: true,
      output: "",
    }),
  );
  const emptyBlocks = buildToolPresentation(emptyOutput, { hideSummaryArg: true });
  assert.ok(
    byRole(emptyBlocks, "output").some((b) => b.text.includes("no output captured")),
    "an empty console read still shows its producer text",
  );
});

test("LSP request and unknown metadata stay readable", () => {
  const row = converter.convertEntry(
    tool("lsp", [{ type: "text", text: "Status OK" }], {
      action: "status",
      success: true,
      request: { action: "status", file: "REQUEST_TARGET.ts" },
    }),
  );
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  assert.ok(
    fieldValues(blocks).includes("file: REQUEST_TARGET.ts"),
    "the request target the model asked for is visible",
  );
  assert.ok(
    fieldValues(blocks).includes("action: status"),
    "the action field is still shown",
  );
});

test("debug snapshot id, instruction pointer, breakpoint message and unknown fields stay readable", () => {
  const row = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Paused" }], {
      action: "pause",
      success: true,
      snapshot: {
        id: "session-9",
        adapter: "fake",
        status: "stopped",
        cwd: "/tmp",
        needsConfigurationDone: false,
        instructionPointerReference: "0xFF44",
        futureMeta: "FUTURE_SNAPSHOT_DATA",
      },
      breakpoints: [
        { id: 4, line: 8, verified: false, message: "No executable code at the breakpoint location." },
      ],
    }),
  );
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  const values = fieldValues(blocks);
  assert.ok(values.includes("id: session-9"), "the session id renders");
  assert.ok(values.includes("instructionPointerReference: 0xFF44"), "the instruction pointer renders");
  assert.ok(
    values.some((v) => v.startsWith("breakpoint:") && v.includes("No executable code at the breakpoint location.")),
    "the breakpoint pending reason renders",
  );
  assert.ok(
    allText(blocks).includes("FUTURE_SNAPSHOT_DATA"),
    "an unknown snapshot field is not silently dropped",
  );
});

test("edit keeps diagnostics, firstChangedLine and unknown fields", () => {
  const row = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated warning.ts" }], {
      diff: "-1|old\n+1|new",
      path: "warning.ts",
      firstChangedLine: 42,
      diagnostics: {
        server: "patch",
        summary: "Patch warnings: 1",
        errored: false,
        messages: ["patch: Inexact match in warning.ts near line 1: PATTERN_WARNING"],
      },
      futureMeta: { reason: "FUTURE_EDIT_DATA" },
    }),
  );
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  assert.ok(
    byRole(blocks, "notice").some((b) => b.text.includes("PATTERN_WARNING")),
    "the patch warning renders as a notice",
  );
  assert.ok(
    fieldValues(blocks).some((v) => v.startsWith("firstChangedLine: 42")),
    "the first changed line renders",
  );
  assert.ok(
    fieldValues(blocks).includes("summary: Patch warnings: 1"),
    "the diagnostics summary renders",
  );
  assert.ok(
    allText(blocks).includes("FUTURE_EDIT_DATA"),
    "an unknown edit field is not silently dropped",
  );
});

test("a plugin name ending in edit keeps its own diff/revision metadata", () => {
  const row = {
    toolName: "plugin_publisher_edit",
    toolArgs: { path: "src/plugin.ts" },
    toolResult: {
      details: {
        diff: "OPAQUE_PLUGIN_DIFF",
        action: "evaluate",
        success: true,
        revision: "PLUGIN_REVISION_42",
        nested: { future: "UNKNOWN_PLUGIN_DATA" },
      },
      content: [{ type: "text", text: "Duplicate metadata echo" }],
    },
  };
  const rendered = JSON.stringify(buildToolPresentation(row));
  assert.ok(rendered.includes("PLUGIN_REVISION_42"), "the plugin revision stays visible");
  assert.ok(rendered.includes("UNKNOWN_PLUGIN_DATA"), "nested plugin data stays visible");
  assert.ok(rendered.includes("OPAQUE_PLUGIN_DIFF"), "the plugin's own diff stays visible");
});

// ---------------------------------------------------------------------------
// Independent-review residuals: a metadata snapshot is not the action's result,
// and a field is consumed only once its actual value was rendered.
// ---------------------------------------------------------------------------

test("a debug snapshot does not hide an empty output or breakpoint listing", () => {
  const snapshot = {
    id: "debug-session",
    adapter: "fake",
    status: "stopped",
    cwd: "/tmp",
    needsConfigurationDone: false,
  };
  const emptyOutput = converter.convertEntry(
    tool("debug", [{ type: "text", text: "(no output captured)" }], {
      action: "output",
      success: true,
      snapshot,
      output: "",
    }),
  );
  assert.ok(
    byRole(buildToolPresentation(emptyOutput, { hideSummaryArg: true }), "output").some((b) =>
      b.text.includes("no output captured"),
    ),
    "an empty console read keeps its producer text even with a snapshot",
  );

  const emptyBreakpoints = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Function breakpoints:\n(none)" }], {
      action: "remove_breakpoint",
      success: true,
      snapshot,
      functionBreakpoints: [],
    }),
  );
  assert.ok(
    byRole(buildToolPresentation(emptyBreakpoints, { hideSummaryArg: true }), "output").some((b) =>
      b.text.includes("none"),
    ),
    "an empty breakpoint listing keeps its producer text even with a snapshot",
  );
});

test("debug keeps the breakpoint id, per-item remainder and source remainder", () => {
  const snapshot = {
    id: "debug-session",
    adapter: "fake",
    status: "stopped",
    cwd: "/tmp",
    needsConfigurationDone: false,
  };
  const row = converter.convertEntry(
    tool("debug", [{ type: "text", text: "- line 8: verified" }], {
      action: "set_breakpoint",
      success: true,
      snapshot,
      breakpoints: [{ id: 73918264, line: 8, verified: true, futureMeta: "BREAKPOINT_REMAINDER" }],
    }),
  );
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  assert.ok(
    fieldValues(blocks).some((v) => v.startsWith("breakpoint:") && v.includes("73918264")),
    "the real breakpoint id is not dropped",
  );
  assert.ok(
    allText(blocks).includes("BREAKPOINT_REMAINDER"),
    "an unrecognized breakpoint field is not dropped",
  );

  const paused = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Paused" }], {
      action: "pause",
      success: true,
      snapshot: { ...snapshot, source: { path: "a.ts", name: "SOURCE_NAME_REMAINDER" }, line: 8 },
    }),
  );
  assert.ok(
    allText(buildToolPresentation(paused, { hideSummaryArg: true })).includes("SOURCE_NAME_REMAINDER"),
    "a source field beyond path stays readable",
  );
});

test("unrecognized known-field values stay readable instead of vanishing", () => {
  const lsp = converter.convertEntry(
    tool("lsp", [{ type: "text", text: "Status OK" }], {
      action: "status",
      success: true,
      request: "UNRECOGNIZED_REQUEST",
    }),
  );
  assert.ok(
    allText(buildToolPresentation(lsp, { hideSummaryArg: true })).includes("UNRECOGNIZED_REQUEST"),
    "a scalar LSP request value stays readable",
  );

  const debug = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Output" }], {
      action: "output",
      success: true,
      output: { message: "UNRECOGNIZED_OUTPUT" },
    }),
  );
  assert.ok(
    allText(buildToolPresentation(debug, { hideSummaryArg: true })).includes("UNRECOGNIZED_OUTPUT"),
    "a non-string debug output value stays readable",
  );

  const edit = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated a.ts" }], {
      path: "a.ts",
      diff: "-1|old\n+1|new",
      diagnostics: "UNRECOGNIZED_DIAGNOSTIC",
    }),
  );
  assert.ok(
    allText(buildToolPresentation(edit, { hideSummaryArg: true })).includes("UNRECOGNIZED_DIAGNOSTIC"),
    "a non-record diagnostics value stays readable",
  );
});

test("a multi-file edit keeps top-level diagnostics and a pruned file is not a no-op", () => {
  const multi = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated two files" }], {
      diff: "",
      diagnostics: { messages: ["MULTI_TOP_WARNING"] },
      perFileResults: [
        { path: "a.ts", diff: "-1|old\n+1|new" },
        { path: "b.ts", diff: "-1|before\n+1|after" },
      ],
    }),
  );
  const multiBlocks = buildToolPresentation(multi, { hideSummaryArg: true });
  assert.ok(
    byRole(multiBlocks, "notice").some((b) => b.text.includes("MULTI_TOP_WARNING")),
    "a top-level multi-file diagnostic is not dropped",
  );

  const pruned = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated a.ts" }], {
      diff: "",
      perFileResults: [{ path: "a.ts", snapshotsPruned: true, truncated: true }],
    }),
  );
  const prunedBlocks = buildToolPresentation(pruned, { hideSummaryArg: true });
  assert.ok(
    !allText(prunedBlocks).match(/no changes were made/i),
    "a pruned/truncated file is missing its diff, not unchanged",
  );
});

// ---------------------------------------------------------------------------
// Independent-review residuals (round two): a known field is consumed only once
// its actual value was rendered, so malformed/future values stay readable.
// ---------------------------------------------------------------------------

test("malformed known snapshot fields stay readable", () => {
  const snapshot = {
    id: "debug-session",
    adapter: "fake",
    status: "stopped",
    cwd: "/tmp",
    needsConfigurationDone: false,
  };
  const malformedId = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Paused" }], {
      action: "pause",
      success: true,
      snapshot: { ...snapshot, id: { future: "MALFORMED_SNAPSHOT_ID" } },
    }),
  );
  assert.ok(
    allText(buildToolPresentation(malformedId, { hideSummaryArg: true })).includes(
      "MALFORMED_SNAPSHOT_ID",
    ),
    "a non-string snapshot id is not silently dropped",
  );

  const malformedSource = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Paused" }], {
      action: "pause",
      success: true,
      snapshot: { ...snapshot, source: { path: { future: "MALFORMED_SOURCE_PATH" }, name: "source" }, line: 8 },
    }),
  );
  assert.ok(
    allText(buildToolPresentation(malformedSource, { hideSummaryArg: true })).includes(
      "MALFORMED_SOURCE_PATH",
    ),
    "a non-string source path stays readable even though no location rendered",
  );
});

test("a malformed breakpoint id stays readable", () => {
  const snapshot = {
    id: "debug-session",
    adapter: "fake",
    status: "stopped",
    cwd: "/tmp",
    needsConfigurationDone: false,
  };
  const row = converter.convertEntry(
    tool("debug", [{ type: "text", text: "- line 8: verified" }], {
      action: "set_breakpoint",
      success: true,
      snapshot,
      breakpoints: [{ line: 8, verified: true, id: { future: "MALFORMED_BREAKPOINT_ID" } }],
    }),
  );
  assert.ok(
    allText(buildToolPresentation(row, { hideSummaryArg: true })).includes(
      "MALFORMED_BREAKPOINT_ID",
    ),
    "a non-numeric breakpoint id is not dropped from the remainder",
  );
});

test("mixed diagnostic messages keep non-string items", () => {
  const row = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated a.ts" }], {
      path: "a.ts",
      diff: "-1|old\n+1|new",
      diagnostics: { messages: ["warning", { future: "DIAGNOSTIC_MESSAGE_REMAINDER" }] },
    }),
  );
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  assert.ok(
    byRole(blocks, "notice").some((b) => b.text === "warning"),
    "the valid string message still renders as a note",
  );
  assert.ok(
    allText(blocks).includes("DIAGNOSTIC_MESSAGE_REMAINDER"),
    "a non-string message is not dropped with the rendered strings",
  );
});

test("a scalar meta and an unknown edit operation fall back readably", () => {
  const meta = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated a.ts" }], {
      path: "a.ts",
      diff: "-1|old\n+1|new",
      meta: "EDIT_META_SCALAR",
    }),
  );
  assert.ok(
    allText(buildToolPresentation(meta, { hideSummaryArg: true })).includes("EDIT_META_SCALAR"),
    "a non-record meta is not dropped",
  );

  const futureOp = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated a.ts" }], {
      path: "a.ts",
      diff: "-1|old\n+1|new",
      op: "FUTURE_EDIT_OPERATION",
    }),
  );
  assert.ok(
    allText(buildToolPresentation(futureOp, { hideSummaryArg: true })).includes(
      "FUTURE_EDIT_OPERATION",
    ),
    "an operation other than create/delete is not silently consumed",
  );
});

test("mixed per-file results and a malformed aggregate diff stay readable", () => {
  const mixed = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated files" }], {
      diff: "",
      perFileResults: ["PER_FILE_SCALAR_REMAINDER", { path: "a.ts", diff: "-1|old\n+1|new" }],
    }),
  );
  const mixedBlocks = buildToolPresentation(mixed, { hideSummaryArg: true });
  assert.ok(
    allText(mixedBlocks).includes("PER_FILE_SCALAR_REMAINDER"),
    "a non-record per-file entry is not skipped",
  );
  assert.ok(allText(mixedBlocks).includes("a.ts"), "the valid per-file entry still renders");

  const malformedDiff = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated files" }], {
      diff: { future: "AGGREGATE_DIFF_REMAINDER" },
      perFileResults: [{ path: "a.ts", diff: "-1|old\n+1|new" }],
    }),
  );
  assert.ok(
    allText(buildToolPresentation(malformedDiff, { hideSummaryArg: true })).includes(
      "AGGREGATE_DIFF_REMAINDER",
    ),
    "a non-string aggregate diff is not dropped as a redundant value",
  );
});

test("a valid snapshot field renders once and is not repeated in the fallback", () => {
  const row = converter.convertEntry(
    tool("debug", [{ type: "text", text: "Paused" }], {
      action: "pause",
      success: true,
      snapshot: {
        id: "debug-session",
        adapter: "fake",
        status: "stopped",
        cwd: "/tmp",
        needsConfigurationDone: false,
        source: { path: "a.ts" },
        line: 8,
      },
    }),
  );
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  assert.deepEqual(
    fieldValues(blocks).filter((v) => v === "id: debug-session"),
    ["id: debug-session"],
    "the session id renders exactly once",
  );
  assert.equal(
    blocks.some((block) => block.lang === "json"),
    false,
    "no JSON fallback repeats the already-rendered snapshot fields",
  );
});

test("a large mixed per-file result respects the generic list bound", () => {
  const scalars = Array.from({ length: 250 }, (_, i) => `PER_FILE_SCALAR_${i}`);
  const row = converter.convertEntry(
    tool("edit", [{ type: "text", text: "Updated files" }], {
      diff: "",
      perFileResults: [{ path: "a.ts", diff: "-1|old\n+1|new" }, ...scalars],
    }),
  );
  const blocks = buildToolPresentation(row, { hideSummaryArg: true });
  assert.ok(allText(blocks).includes("a.ts"), "the valid per-file entry still renders");
  const remainderFiles = blocks.find(
    (block) => block.kind === "files" && block.label === "perFileResults",
  );
  assert.ok(remainderFiles, "the non-record entries render as a bounded files block");
  assert.equal(remainderFiles.paths.length, 200, "the generic list cap still applies");
  assert.equal(remainderFiles.hidden, 50, "the overflow is reported, not dropped");
});
