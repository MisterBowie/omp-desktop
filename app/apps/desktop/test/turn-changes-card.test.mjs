import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { createInstance } from "i18next";
import { createServer } from "vite";
import { catalogs } from "@pi-desktop/i18n";
import { installMinimalDom, restoreGlobals } from "./helpers/react-dom-test-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));
const { OmpEventConverter } = await import(
  pathToFileURL(join(here, "../../../packages/omp-runtime/src/session/events.ts"))
);
const { summarizeTurnChanges } = await import("../src/lib/turn-changed-files.ts");
const { currentReviewFocusRequest, requestReviewFocus } = await import(
  "../src/lib/review-focus-request.ts"
);

/*
 * The per-turn changed-files summary (ported from PI-Desktop 73b714ed and
 * c19c3387): one collapsed card under a finished reply, built from the turn's
 * recorded changes — PI review snapshots and OMP native edit/write results.
 */

let sequence = 0;

/** A PI Edit row with its host review snapshot. */
function piEdit(path, review = {}, overrides = {}) {
  sequence += 1;
  const id = `tool-${sequence}`;
  return {
    id,
    role: "tool",
    content: "",
    status: "complete",
    createdAt: `2026-11-05T00:00:${String(sequence % 60).padStart(2, "0")}.000Z`,
    toolName: "Edit",
    toolCallId: `call-${sequence}`,
    toolStatus: "success",
    toolArgs: { path },
    toolResult: {
      details: {
        root: "workspace",
        review: {
          version: 1, snapshotId: `snap-${sequence}`, messageId: id, path, operation: "edit",
          status: "modified", state: "active", additions: 1, deletions: 1, hunks: [], reversible: true,
          ...review,
        },
      },
    },
    ...overrides,
  };
}

const converter = new OmpEventConverter({ sessionId: "s", now: () => 1 });
/** An OMP native tool row, as the runtime adapter projects it. */
function omp(toolName, details) {
  sequence += 1;
  const id = `omp-${sequence}`;
  return {
    ...converter.convertEntry({
      id: `entry-${id}`,
      timestamp: "2026-11-05T00:00:00Z",
      message: {
        role: "toolResult", toolName, toolCallId: id, timestamp: 1, isError: false,
        content: [{ type: "text", text: "ok" }], details,
      },
    }),
    status: "complete",
  };
}
const ompUpdate = (path, diff) => omp("edit", { op: "update", path, diff });

test("PI: one file edited several times is one row with merged counts and status", () => {
  const summary = summarizeTurnChanges([
    piEdit("src/new.ts", { status: "added", operation: "write", additions: 10, deletions: 0 }),
    piEdit("src/new.ts", { additions: 3, deletions: 2 }),
    piEdit("src/app.ts", { additions: 4, deletions: 1 }),
    piEdit("src/app.ts", { additions: 1, deletions: 0 }),
    piEdit("src/old.ts", { additions: 2, deletions: 0 }),
    piEdit("src/old.ts", { status: "deleted", operation: "delete", additions: 0, deletions: 9 }),
  ]);
  assert.deepEqual(
    summary.files.map(({ path, status, additions, deletions, reviewKeys }) => [
      path, status, additions, deletions, reviewKeys.length,
    ]),
    [
      ["src/new.ts", "added", 13, 2, 2],
      ["src/app.ts", "modified", 5, 1, 2],
      ["src/old.ts", "deleted", 2, 9, 2],
    ],
  );
  assert.equal(summary.additions, 20);
  assert.equal(summary.deletions, 12);
  assert.equal(summary.directoryCount, 1);
});

test("PI: rolled-back changes stay listed; a file is rolled back only when every edit is", () => {
  const summary = summarizeTurnChanges([
    piEdit("a.ts", { state: "rolledBack" }),
    piEdit("b.ts", { state: "rolledBack" }),
    piEdit("b.ts"),
  ]);
  assert.deepEqual(summary.files.map((file) => [file.path, file.rolledBack]), [["a.ts", true], ["b.ts", false]]);
});

test("failed, scratch, and non-file tool messages add nothing", () => {
  const summary = summarizeTurnChanges([
    piEdit("a.ts", {}, { toolStatus: "error" }),
    piEdit("b.ts", {}, { toolResult: { details: { root: "scratch", review: {} } } }),
    { id: "r", role: "tool", content: "", createdAt: "", toolName: "Read", toolStatus: "success" },
    omp("read", { path: "/repo/a.txt" }),
  ]);
  assert.deepEqual(summary.files, []);
});

test("OMP: edits merge per file; a write or rename sets the status and unknown counts stay unknown", () => {
  const summary = summarizeTurnChanges([
    ompUpdate("/repo/src/a.ts", "-1|a\n+1|A"),
    ompUpdate("/repo/src/a.ts", " 1|A\n+2|B\n+3|C"),
    omp("write", { resolvedPath: "/repo/src/w.ts" }),
    ompUpdate("/repo/src/w.ts", "-1|x\n+1|X"),
    omp("edit", { op: "update", path: "/repo/src/moved.ts", move: "/repo/src/moved.ts", sourcePath: "/repo/src/old.ts", diff: "" }),
    ompUpdate("/repo/src/moved.ts", "-4|q\n+4|Q"),
    omp("edit", { op: "delete", path: "/repo/gone.txt", diff: "", oldText: "1\n2\n" }),
  ]);
  assert.deepEqual(
    summary.files.map(({ path, sourcePath, status, additions, deletions, reviewKeys }) => [
      path, sourcePath ?? null, status, additions, deletions, reviewKeys.length,
    ]),
    [
      ["/repo/src/a.ts", null, "modified", 3, 1, 2],
      ["/repo/src/w.ts", null, "written", null, null, 2],
      ["/repo/src/moved.ts", "/repo/src/old.ts", "renamed", 1, 1, 2],
      ["/repo/gone.txt", null, "deleted", 0, 2, 1],
    ],
  );
  // Only proven lines count: the written file adds nothing.
  assert.equal(summary.additions, 4);
  assert.equal(summary.deletions, 4);
  assert.equal(summary.directoryCount, 2);
});

test("a focus request carries its review keys, expansion, and a fresh sequence", () => {
  requestReviewFocus([], { expand: true });
  const before = currentReviewFocusRequest();
  requestReviewFocus(["s1", "omp:m:0"], { expand: true });
  const first = currentReviewFocusRequest();
  assert.deepEqual(first.reviewKeys, ["s1", "omp:m:0"]);
  assert.equal(first.expand, true);
  assert.notEqual(first, before, "an empty request is ignored, a real one replaces it");
  requestReviewFocus(["s1"], { expand: false });
  assert.ok(currentReviewFocusRequest().seq > first.seq);
});

test("the card stays borderless and the Review tab honors focus requests", async () => {
  const css = await readFile(new URL("../src/styles/turn-changes.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /^\s*border(-top|-bottom|-left|-right)?\s*:/m);
  assert.doesNotMatch(css, /box-shadow/);
  assert.match(css, /\.turn-changes-card \{[\s\S]*?background: var\(--ds-tile\)/);
  const reviewTab = await readFile(new URL("../src/components/workpanel/ReviewTab.tsx", import.meta.url), "utf8");
  assert.match(reviewTab, /useReviewFocusRequest\(\)/);
  assert.match(reviewTab, /openRequest=\{openRequest\}/);
  assert.match(reviewTab, /scrollIntoView/);
});

async function harness() {
  const server = await createServer({
    root: fileURLToPath(new URL("..", import.meta.url)),
    configFile: false,
    server: { middlewareMode: true, hmr: false, ws: false },
    esbuild: { jsx: "automatic" },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const previous = installMinimalDom();
  const createNode = document.createElement.bind(document);
  document.createElement = (tag) => {
    const node = createNode(tag);
    node.namespaceURI = "http://www.w3.org/1999/xhtml";
    node.querySelector = () => null;
    node.querySelectorAll = () => [];
    node.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 });
    return node;
  };
  // The context menu reads the selection and measures itself; the shim has neither.
  globalThis.Node ??= class {};
  globalThis.HTMLTextAreaElement ??= class {};
  window.getSelection = () => null;
  window.innerWidth = 1280;
  window.innerHeight = 800;
  const invoked = [];
  const exactPaths = new Set(["/repo/src/a.ts", "/repo/src/b.ts"]);
  window.piDesktop = {
    platform: "darwin",
    on: () => () => {},
    invoke: async (channel, payload) => {
      invoked.push([channel, payload]);
      if (channel === "pi-desktop/fs/resolveRef") {
        const ref = payload.ref;
        if (exactPaths.has(ref)) {
          return { ok: true, data: { match: {
            root: "workspace", relativePath: ref.slice("/repo/".length), absolutePath: ref,
            matchedBy: "exact-absolute", projectRoot: { primary: true },
          } } };
        }
        // A moved/removed file: only a same-named lookalike elsewhere matches.
        return { ok: true, data: { match: {
          root: "workspace", relativePath: "other/gone.ts", absolutePath: "/repo/other/gone.ts",
          matchedBy: "basename", projectRoot: { primary: true },
        } } };
      }
      if (channel === "pi-desktop/fs/reveal") return { ok: true, data: { ok: true } };
      throw new Error(`Unexpected IPC ${channel}`);
    },
  };
  document.createElementNS = (namespace, tag) => {
    const node = document.createElement(tag);
    node.namespaceURI = namespace;
    return node;
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.CSS ??= { escape: (value) => String(value) };
  const container = document.createElement("div");
  const root = createRoot(container);
  const { TranscriptEntryView } = await server.ssrLoadModule("/src/features/chat/transcript/AssistantTurn.tsx");
  const { ReviewTab } = await server.ssrLoadModule("/src/components/workpanel/ReviewTab.tsx");
  const { buildTranscriptEntries } = await server.ssrLoadModule("/src/lib/assistant-turns.ts");
  const { useAppStore } = await server.ssrLoadModule("/src/stores/app-store.ts");
  const focus = await server.ssrLoadModule("/src/lib/review-focus-request.ts");
  const card = await server.ssrLoadModule("/src/features/chat/transcript/TurnChangesCard.tsx");
  const preview = await server.ssrLoadModule("/src/hooks/use-preview-target.ts");
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    resources: { en: { translation: catalogs.en } },
    interpolation: { escapeValue: false },
  });
  const text = (node) => `${node._text ?? ""}${(node.childNodes ?? []).map(text).join("")}`;
  const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];
  const click = async (target) => {
    const event = {
      type: "click", target, bubbles: true, button: 0, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {},
    };
    await act(async () => {
      for (const listener of container._listeners.click ?? []) listener(event);
    });
  };
  const renderTurn = (messages, props = {}) => {
    const entry = buildTranscriptEntries(messages).entries.find((item) => item.kind === "assistant-turn");
    return act(async () =>
      root.render(createElement(I18nextProvider, { i18n },
        createElement(TranscriptEntryView, { key: `${sequence}-${JSON.stringify(props)}`, entry, isRunning: false, isActive: false, ...props }))),
    );
  };
  const renderReview = () =>
    act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(ReviewTab))));
  const fire = async (type, target, init = {}) => {
    const event = {
      type, target, bubbles: true, button: type === "contextmenu" ? 2 : 0, clientX: 40, clientY: 40,
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {},
      ...init,
    };
    await act(async () => {
      for (const host of [container, document.body]) {
        for (const listener of host._listeners?.[type] ?? []) listener(event);
      }
    });
    return event;
  };
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  const cleanup = async () => {
    await act(async () => root.unmount());
    restoreGlobals(previous);
    await server.close();
  };
  return {
    container, text, nodes, click, fire, settle, renderTurn, renderReview, useAppStore, focus, card, preview,
    i18n, root, invoked, cleanup,
  };
}

function turnMessages(tools, replyOverrides = {}) {
  return [
    { id: "u1", role: "user", content: "fix it", status: "complete", createdAt: "2026-11-05T00:00:00.000Z" },
    ...tools,
    { id: "a-reply", role: "assistant", content: "Done.", status: "complete", createdAt: "2026-11-05T00:01:00.000Z", ...replyOverrides },
  ];
}

test("mounted: an OMP turn gets a collapsed card under the reply that opens Review on a file", async () => {
  const h = await harness();
  try {
    h.useAppStore.setState({
      activeSessionId: "s", workspace: { path: "/repo" }, workPanelOpen: false, workPanelTabs: [],
      transcriptViews: {}, retainedTranscripts: {}, runningSessions: {}, pluginViews: [],
    });
    const edit = omp("edit", {
      diff: "-1|a\n+1|A",
      perFileResults: [
        { path: "/repo/src/a.ts", diff: "-1|a\n+1|A", op: "update" },
        { path: "/repo/src/b.ts", diff: "+1|new", op: "update" },
      ],
    });
    const write = omp("write", { resolvedPath: "/repo/notes.md" });
    const messages = turnMessages([edit, write]);
    await h.renderTurn(messages);

    const card = h.nodes(h.container).find((node) => node.nodeName === "SECTION" && node.className === "turn-changes-card");
    assert.ok(card, "a finished turn with file changes shows the card");
    assert.equal(card.getAttribute("aria-label"), "Files changed this turn");
    const all = h.text(h.container);
    assert.ok(all.indexOf("Done.") < all.indexOf("Changes this turn"), "the card sits under the reply");
    const head = h.nodes(card).find((node) => node.nodeName === "BUTTON" && String(node.className).includes("turn-changes-head"));
    assert.equal(head.getAttribute("aria-expanded"), "false", "the summary starts collapsed");
    assert.ok(h.text(head).includes("3 files"));
    const body = h.nodes(card).find((node) => node.getAttribute?.("id") === head.getAttribute("aria-controls"));
    assert.equal(body.hidden ?? body.getAttribute("hidden") !== null, true, "file rows are hidden until expanded");

    await h.click(head);
    assert.equal(head.getAttribute("aria-expanded"), "true");
    const rows = h.nodes(card).filter((node) => node.nodeName === "BUTTON" && node.className === "turn-changes-row");
    assert.deepEqual(rows.map((row) => [row.getAttribute("data-status"), h.text(row)]), [
      ["modified", "Msrc/a.ts+1−1"],
      ["modified", "Msrc/b.ts+1"],
      ["written", "Wnotes.md"],
    ], "project-relative paths, status letters, and only proven counts");
    assert.equal(rows[2].getAttribute("aria-label"), "Open Written change for notes.md in Review");

    await h.click(rows[1]);
    const state = h.useAppStore.getState();
    assert.equal(state.workPanelOpen, true, "a row opens the work panel");
    assert.equal(state.workPanelTabs.find((tab) => tab.id === state.activeWorkPanelTabId)?.kind, "review");
    const request = h.focus.currentReviewFocusRequest();
    assert.deepEqual(request.reviewKeys, [`omp:${edit.id}:1`]);
    assert.equal(request.expand, true);

    // The Review tab applies that request: only the named row opens.
    h.useAppStore.setState({ messages });
    await h.renderReview();
    const reviewRows = h.nodes(h.container).filter((node) => node.nodeName === "SECTION" && node.getAttribute("data-review-key"));
    assert.deepEqual(
      reviewRows.map((node) => [node.getAttribute("data-review-key"), String(node.className).includes("open")]),
      [[`omp:${edit.id}:0`, false], [`omp:${edit.id}:1`, true], [`omp:${write.id}:0`, false]],
    );
  } finally {
    await h.cleanup();
  }
});

test("mounted: many files switch to dense rows, cap at twelve, and offer the whole list", async () => {
  const h = await harness();
  try {
    h.useAppStore.setState({ activeSessionId: "s", workspace: { path: "/repo" }, transcriptViews: {}, retainedTranscripts: {}, runningSessions: {}, pluginViews: [] });
    const tools = Array.from({ length: 15 }, (_, index) => ompUpdate(`/repo/pkg/dir${index % 3}/file${index}.ts`, "-1|a\n+1|b\n+2|c"));
    await h.renderTurn(turnMessages(tools));
    const card = h.nodes(h.container).find((node) => node.className === "turn-changes-card");
    const head = h.nodes(card).find((node) => String(node.className).includes("turn-changes-head"));
    assert.ok(h.text(head).includes("15 files · 3 dirs"));
    assert.ok(h.text(head).includes("+30") && h.text(head).includes("−15"));
    await h.click(head);
    assert.ok(h.nodes(card).some((node) => node.className === "turn-changes-body is-dense"));
    assert.equal(h.nodes(card).filter((node) => node.className === "turn-changes-row").length, 12);
    assert.ok(h.text(card).includes("+3 more"));
    const viewAll = h.nodes(card).find((node) => node.className === "turn-changes-view-all");
    assert.equal(h.text(viewAll), "View all 15 files in Review");
    await h.click(viewAll);
    const request = h.focus.currentReviewFocusRequest();
    assert.equal(request.reviewKeys.length, 15);
    assert.equal(request.expand, false, "the whole list is revealed, not expanded");
  } finally {
    await h.cleanup();
  }
});

test("mounted: a PI rolled-back file is marked; no card for a live, failed, or change-free turn", async () => {
  const h = await harness();
  try {
    h.useAppStore.setState({ activeSessionId: "s", workspace: { path: "/repo" }, transcriptViews: {}, retainedTranscripts: {}, runningSessions: {}, pluginViews: [] });
    await h.renderTurn(turnMessages([piEdit("src/a.ts", { state: "rolledBack" })]));
    const card = h.nodes(h.container).find((node) => node.className === "turn-changes-card");
    await h.click(h.nodes(card).find((node) => String(node.className).includes("turn-changes-head")));
    const row = h.nodes(card).find((node) => node.className === "turn-changes-row");
    assert.equal(row.getAttribute("data-rolled-back"), "true");
    assert.match(row.getAttribute("aria-label"), /a\.ts[^"]*· Rolled back$/);

    const hasCard = () => h.nodes(h.container).some((node) => node.className === "turn-changes-card");
    await h.renderTurn(turnMessages([]));
    assert.equal(hasCard(), false, "no file changes, no card");
    await h.renderTurn(turnMessages([ompUpdate("/repo/a.ts", "+1|x")]), { isActive: true });
    assert.equal(hasCard(), false, "a live turn never grows the card");
    await h.renderTurn(turnMessages([ompUpdate("/repo/a.ts", "+1|x")], { error: { code: "X", message: "boom" } }));
    assert.equal(hasCard(), false, "a failed turn has no card");
  } finally {
    await h.cleanup();
  }
});

test("the row menu offers open and show-in-folder, disabled where no current file exists", async () => {
  const h = await harness();
  try {
    const t = h.i18n.t.bind(h.i18n);
    const opened = [];
    const revealed = [];
    const items = (file, nativeFilesAllowed = true) =>
      h.card.turnChangedFileMenuItems({
        t, file, nativeFilesAllowed,
        openFile: (path) => opened.push(path),
        revealFile: (path) => revealed.push(path),
      });
    const modified = { path: "/repo/src/a.ts", status: "modified", additions: 1, deletions: 1, rolledBack: false, reviewKeys: ["k"] };
    const menu = items(modified);
    assert.deepEqual(menu.map((item) => [item.id, item.label, Boolean(item.disabled)]), [
      ["open-file", "Open file", false],
      ["reveal-file", "Show in folder", false],
    ]);
    menu[0].onSelect();
    menu[1].onSelect();
    assert.deepEqual([opened, revealed], [["/repo/src/a.ts"], ["/repo/src/a.ts"]]);
    for (const [label, file, allowed] of [
      ["a deleted file", { ...modified, status: "deleted" }, true],
      ["a remote session", modified, false],
    ]) {
      assert.ok(items(file, allowed).every((item) => item.disabled), `${label} offers neither action`);
    }
  } finally {
    await h.cleanup();
  }
});

test("exact open and reveal act on the recorded file and never on a same-named lookalike", async () => {
  const h = await harness();
  try {
    const toasts = [];
    const files = [];
    const tabs = [];
    h.useAppStore.setState({
      activeSessionId: "s", workspace: { path: "/repo" }, pluginViews: [],
      showToast: (...args) => toasts.push(args),
      openFileInWorkPanel: (...args) => files.push(args),
      openWorkPanelTab: (tab) => tabs.push(tab),
    });
    let actions;
    function Probe() {
      actions = { open: h.preview.useOpenChatFileRef(), reveal: h.preview.useRevealChatFileRef() };
      return null;
    }
    await act(async () => h.root.render(createElement(I18nextProvider, { i18n: h.i18n }, createElement(Probe))));

    actions.reveal("/repo/src/a.ts", { exact: true });
    await h.settle();
    assert.deepEqual(h.invoked.filter(([channel]) => channel === "pi-desktop/fs/reveal").map(([, payload]) => payload),
      [{ path: "/repo/src/a.ts", sessionId: "s" }], "reveal goes through the host with the session");

    actions.open("/repo/src/a.ts", undefined, undefined, { exact: true });
    await h.settle();
    assert.deepEqual(files, [["src/a.ts", undefined]], "an exact project file opens in the work panel");

    actions.reveal("/repo/gone.ts", { exact: true });
    actions.open("/repo/gone.ts", undefined, undefined, { exact: true });
    await h.settle();
    assert.equal(h.invoked.filter(([channel]) => channel === "pi-desktop/fs/reveal").length, 1, "no reveal of a lookalike");
    assert.equal(files.length, 1, "no open of a lookalike");
    assert.equal(toasts.length, 2);
    assert.ok(toasts.every(([, options]) => options.variant === "error"));

    // Chat references keep their shorthand completion unless they ask for exact.
    actions.open("/repo/gone.ts");
    await h.settle();
    assert.deepEqual(files.at(-1), ["other/gone.ts", undefined]);
  } finally {
    await h.cleanup();
  }
});

test("mounted: right-clicking a changed file opens its menu without opening Review", async () => {
  const h = await harness();
  try {
    h.useAppStore.setState({
      activeSessionId: "s", workspace: { path: "/repo" }, workPanelOpen: false, workPanelTabs: [],
      transcriptViews: {}, retainedTranscripts: {}, runningSessions: {}, pluginViews: [],
    });
    await h.renderTurn(turnMessages([ompUpdate("/repo/src/a.ts", "-1|a\n+1|A")]));
    const section = h.nodes(h.container).find((node) => node.className === "turn-changes-card");
    await h.click(h.nodes(section).find((node) => String(node.className).includes("turn-changes-head")));
    const row = h.nodes(section).find((node) => node.className === "turn-changes-row");
    const event = await h.fire("contextmenu", row);
    assert.equal(event.defaultPrevented, true, "the platform menu does not also open");
    const menuItems = h.nodes(document.body).filter((node) => node.getAttribute?.("role") === "menuitem");
    assert.deepEqual(menuItems.map((node) => h.text(node).trim()), ["Open file", "Show in folder"]);
    assert.equal(h.useAppStore.getState().workPanelOpen, false, "a right-click does not open Review");
  } finally {
    await h.cleanup();
  }
});
