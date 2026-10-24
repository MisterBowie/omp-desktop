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

const {
  dismissTranscriptError,
  dismissedTranscriptErrors,
  withoutDismissedErrors,
} = await import("../src/features/chat/transcript/dismissed-errors.ts");

const refusal = (id) => ({
  id,
  role: "assistant",
  content: "",
  createdAt: "2026-10-24T01:52:34.000Z",
  status: "error",
  isError: true,
  error: {
    code: "OMP_PROJECTION_INVALID",
    message: "thinking level off is not supported by model factory/claude-opus-5-5",
  },
});

test("closed error rows leave the rendered transcript and keep any streamed answer", () => {
  const answer = { id: "a1", role: "assistant", content: "Batch 2 is done.", createdAt: "t" };
  const closedRefusal = refusal("e1");
  const partial = {
    ...refusal("p1"),
    createdAt: "2026-10-24T01:50:31.000Z",
    content: "Half an answer",
    error: { code: "OMP_MODEL_ERROR", message: "503 No available accounts" },
  };
  const open = { ...refusal("e-open"), createdAt: "2026-10-24T01:52:49.000Z" };
  const messages = [answer, closedRefusal, partial, open];

  assert.equal(withoutDismissedErrors(messages, new Set()), messages, "nothing closed keeps the array");
  dismissTranscriptError(answer);
  assert.equal(
    withoutDismissedErrors(messages, dismissedTranscriptErrors()),
    messages,
    "closing a row without an error card changes nothing",
  );

  dismissTranscriptError(closedRefusal);
  dismissTranscriptError(partial);
  const visible = withoutDismissedErrors(messages, dismissedTranscriptErrors());
  assert.deepEqual(visible.map((message) => message.id), ["a1", "p1", "e-open"]);
  const kept = visible.find((message) => message.id === "p1");
  assert.equal(kept.content, "Half an answer");
  assert.equal("error" in kept, false, "only the card is removed from a row with text");
  assert.equal(partial.error.code, "OMP_MODEL_ERROR", "the stored row is not mutated");
  assert.equal(visible.at(-1), open, "an unclosed error keeps its identity");

  const tool = { id: "t1", role: "tool", content: "", createdAt: "t", error: { code: "X", message: "x" } };
  dismissTranscriptError(tool);
  assert.deepEqual(
    withoutDismissedErrors([tool], dismissedTranscriptErrors()),
    [tool],
    "only assistant cards close",
  );
});

test("a closed live OMP failure stays closed when a transcript read returns its durable twin", () => {
  const failure = {
    role: "assistant",
    content: "",
    createdAt: "2026-10-24T01:39:34.667Z",
    status: "error",
    modelId: "factory/claude-sonnet-5-5",
    error: { code: "OMP_MODEL_ERROR", message: '503 {"error":{"message":"No available accounts"}}' },
  };
  const live = { ...failure, id: "omp:s:ctx:7" };
  const durable = { ...failure, id: "omp:s:entry:01a1615b" };
  // A later failure with the same provider text is a new failure.
  const retried = { ...failure, id: "omp:s:entry:01a1615c", createdAt: "2026-10-24T01:50:31.992Z" };

  dismissTranscriptError(live);
  const visible = withoutDismissedErrors([durable, retried], dismissedTranscriptErrors());
  assert.deepEqual(visible.map((message) => message.id), [retried.id]);
});

test("closing is idempotent and bounded", () => {
  const before = dismissedTranscriptErrors();
  const first = refusal("bound-0");
  dismissTranscriptError(first);
  const once = dismissedTranscriptErrors();
  assert.notEqual(once, before, "a close publishes a new snapshot");
  dismissTranscriptError(first);
  dismissTranscriptError({ ...first, id: "" });
  assert.equal(dismissedTranscriptErrors(), once, "a repeat or an id-less row publishes nothing");

  const rows = Array.from({ length: 500 }, (_, index) => ({
    ...refusal(`bound-${index + 1}`),
    createdAt: new Date(Date.UTC(2026, 9, 24, 0, 0, index)).toISOString(),
  }));
  for (const row of rows) dismissTranscriptError(row);
  const closed = dismissedTranscriptErrors();
  assert.equal(closed.size, 1000, "500 closes, two keys each");
  assert.deepEqual(withoutDismissedErrors([first], closed), [first], "the oldest close falls out first");
  assert.deepEqual(withoutDismissedErrors([rows.at(-1)], closed), []);
});

test("mounted assistant turn: the close button hides the card and keeps the answer", async () => {
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
    return node;
  };
  document.createElementNS = (namespace, tag) => {
    const node = document.createElement(tag);
    node.namespaceURI = namespace;
    return node;
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    const { TranscriptEntryView } = await server.ssrLoadModule(
      "/src/features/chat/transcript/AssistantTurn.tsx",
    );
    const dismissed = await server.ssrLoadModule(
      "/src/features/chat/transcript/dismissed-errors.ts",
    );
    const { buildTranscriptEntries } = await server.ssrLoadModule("/src/lib/assistant-turns.ts");
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { translation: catalogs.en } } });

    const messages = [
      { id: "u1", role: "user", content: "check batch 2", createdAt: "2026-10-24T01:51:57.000Z" },
      { id: "a1", role: "assistant", content: "Batch 2 is done.", createdAt: "2026-10-24T01:52:10.000Z" },
      refusal("mounted-e1"),
    ];
    // The same projection ChatTranscript applies before it builds rows.
    function Transcript() {
      const closed = dismissed.useDismissedTranscriptErrors();
      const { entries } = buildTranscriptEntries(dismissed.withoutDismissedErrors(messages, closed));
      return entries.map((entry, index) =>
        createElement(TranscriptEntryView, {
          key: `${entry.kind}-${index}`,
          entry,
          isRunning: false,
          isActive: false,
        }),
      );
    }

    const flattenText = (node) =>
      `${node._text ?? ""}${(node.childNodes ?? []).map(flattenText).join("")}`;
    const nodes = (node) => [node, ...(node.childNodes ?? []).flatMap(nodes)];
    const click = async (target) => {
      const event = {
        type: "click",
        target,
        bubbles: true,
        button: 0,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        stopPropagation() {},
      };
      await act(async () => {
        for (const listener of container._listeners.click ?? []) listener(event);
      });
    };

    await act(async () =>
      root.render(createElement(I18nextProvider, { i18n }, createElement(Transcript))),
    );
    assert.ok(flattenText(container).includes("OMP_PROJECTION_INVALID"), "the card renders first");
    const close = nodes(container).find(
      (node) => node.nodeName === "BUTTON" && node.getAttribute("aria-label") === "Close error",
    );
    assert.ok(close, "the error card offers a labelled close button");

    await click(close);

    const text = flattenText(container);
    assert.equal(text.includes("OMP_PROJECTION_INVALID"), false, "the closed card is gone");
    assert.ok(text.includes("Batch 2 is done."), "the earlier answer stays");
    assert.ok(text.includes("check batch 2"), "the user row stays");
    assert.equal(dismissed.dismissedTranscriptErrors().has("id:mounted-e1"), true);
  } finally {
    await act(async () => root.unmount());
    restoreGlobals(previous);
    await server.close();
  }
});

test("the transcript filters rendered rows only and subagent answers keep their cards", async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [transcript, toolRow, card] = await Promise.all([
    read("src/features/chat/transcript/ChatTranscript.tsx"),
    read("src/features/chat/transcript/ToolRow.tsx"),
    read("src/features/chat/transcript/shared.tsx"),
  ]);
  assert.match(transcript, /withoutDismissedErrors\(messages, dismissedErrors\)/);
  assert.match(transcript, /useTranscriptScroll\(\{\s*sessionId,\s*messages: visibleMessages,/);
  // A closed failure still suppresses the generic outcome card.
  assert.match(transcript, /<TurnOutcomeCard\s+messages=\{messages\}/);
  assert.match(toolRow, /<AssistantErrorMessage message=\{item\.message\} \/>/);
  assert.match(card, /\{onDismiss \? \(/);
});
