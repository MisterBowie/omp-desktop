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
  assert.deepEqual(
    fieldValues(blocks).filter((v) => v.startsWith("path")),
    ["path: src/App.tsx"],
  );
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
  const paths = fieldValues(blocks).filter((v) => v.startsWith("path"));
  assert.deepEqual(paths, ["path: a.ts", "path: b.ts"]);
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
  assert.deepEqual(fieldValues(blocks), ["move: a.ts → b.ts"]);
  assert.equal(blocks.some((block) => block.kind === "diff"), false, "a move has no diff body");
  assert.doesNotMatch(allText(blocks), /no changes/, "a move is not reported as a no-op");
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
