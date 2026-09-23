import assert from "node:assert/strict";
import { register } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { installMinimalDom, restoreGlobals } from "./helpers/react-dom-test-env.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "helpers/ts-import-hooks.mjs")));

const { IPC } = await import("../../../packages/shared/src/protocol.ts");
const { useOmpSubagentRead } = await import("../src/hooks/use-omp-subagent-read.ts");
const { useAppStore } = await import("../src/stores/app-store.ts");

/** The hook result of the last committed render, for assertions and reload. */
let latest = null;

function HookProbe({ sessionId, delegationId, running, enabled = true }) {
  const result = useOmpSubagentRead(sessionId, delegationId, { enabled, running });
  latest = result;
  const items = result.run?.items ?? [];
  return createElement(
    "div",
    null,
    createElement("span", { "data-testid": "phase" }, result.phase),
    createElement("span", { "data-testid": "count" }, String(items.length)),
    ...items.map((item) =>
      createElement(
        "span",
        { "data-testid": "row", key: item.message.id },
        item.message.content ?? item.message.role ?? "",
      ),
    ),
    result.errorDetail
      ? createElement("span", { "data-testid": "error" }, result.errorDetail)
      : null,
    createElement("button", { "data-testid": "retry", onClick: () => result.reload() }, "retry"),
  );
}

/** A `window.piDesktop.invoke` mock with per-channel scripted behaviour. */
function makeInvokeMock() {
  const calls = [];
  const behaviour = {
    list: () => ({ ok: true, data: [] }),
    read: () => ({
      ok: true,
      data: { cursor: { fromByte: 0, nextByte: 0, reset: false }, messages: [] },
    }),
  };
  const invoke = async (channel, ...args) => {
    calls.push({ channel, args });
    if (channel === IPC.invoke.ompSubagentList) return behaviour.list();
    if (channel === IPC.invoke.ompSubagentRead) return behaviour.read(args[0]);
    throw new Error(`unexpected channel ${channel}`);
  };
  return { calls, behaviour, invoke };
}

function message(id, content) {
  return { id, role: "assistant", content, status: "complete" };
}

const flush = () => act(async () => {});

test.beforeEach(() => {
  latest = null;
});

test("mounted read: full rows, empty increment, append, reset cursor, and no OMP IPC for Pi", async () => {
  const previous = installMinimalDom();
  const { calls, behaviour, invoke } = makeInvokeMock();
  globalThis.window.piDesktop = { invoke, on: () => () => {}, platform: "linux" };

  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  try {
    useAppStore.setState({ sessions: [{ id: "s1", title: "OMP", mode: "agent", messageCount: 0, engine: "omp" }] });

    // Initial read: full rows.
    behaviour.read = () => ({
      ok: true,
      data: {
        cursor: { fromByte: 0, nextByte: 10, reset: false },
        messages: [message("a", "first"), message("b", "second")],
      },
    });
    await act(async () => {
      root.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-1", running: false }));
    });
    assert.equal(latest.phase, "ready");
    assert.equal(latest.run.items.length, 2);
    assert.deepEqual(latest.run.items.map((i) => i.message.content), ["first", "second"]);

    // Empty increment must not clear the panel.
    behaviour.read = () => ({
      ok: true,
      data: { cursor: { fromByte: 10, nextByte: 10, reset: false }, messages: [] },
    });
    await act(async () => {
      latest.reload();
    });
    assert.equal(latest.phase, "ready");
    assert.equal(latest.run.items.length, 2, "an empty poll must not clear the detail");

    // Second batch appends and dedups by stable id.
    behaviour.read = () => ({
      ok: true,
      data: {
        cursor: { fromByte: 10, nextByte: 20, reset: false },
        messages: [message("b", "second-dup"), message("c", "third")],
      },
    });
    await act(async () => {
      latest.reload();
    });
    assert.equal(latest.run.items.length, 3, "the second batch must append, not overwrite");
    assert.deepEqual(
      latest.run.items.map((i) => i.message.content),
      ["first", "second", "third"],
    );

    // Reset response replaces the set and advances the cursor to nextByte.
    behaviour.read = (args) => {
      assert.equal(args.fromByte, 20, "the next read must continue from the reset response's nextByte");
      return {
        ok: true,
        data: {
          cursor: { fromByte: 0, nextByte: 7, reset: true },
          messages: [message("z", "replacement")],
        },
      };
    };
    await act(async () => {
      latest.reload();
    });
    assert.equal(latest.run.items.length, 1, "a reset response must replace the accumulated set");
    assert.deepEqual(latest.run.items.map((i) => i.message.content), ["replacement"]);

    // A read after a reset must explicitly continue from nextByte=7.
    behaviour.read = (args) => {
      assert.equal(args.fromByte, 7, "after a reset the next read must continue from nextByte=7");
      return {
        ok: true,
        data: {
          cursor: { fromByte: 7, nextByte: 9, reset: false },
          messages: [message("y", "post-reset")],
        },
      };
    };
    await act(async () => {
      latest.reload();
    });
    assert.deepEqual(
      latest.run.items.map((i) => i.message.content),
      ["replacement", "post-reset"],
      "the post-reset read appends after the replaced set",
    );

    // The bridge was driven through the real api.ts channels.
    assert.ok(calls.some((c) => c.channel === IPC.invoke.ompSubagentList), "list channel called");
    assert.ok(calls.some((c) => c.channel === IPC.invoke.ompSubagentRead), "read channel called");

    await act(async () => {
      root.unmount();
    });
  } finally {
    restoreGlobals(previous);
  }
});

test("mounted read: error, retry, and slow-request staleness on selection change", async () => {
  const previous = installMinimalDom();
  const { calls, behaviour, invoke } = makeInvokeMock();
  globalThis.window.piDesktop = { invoke, on: () => () => {}, platform: "linux" };

  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  try {
    useAppStore.setState({ sessions: [{ id: "s1", title: "OMP", mode: "agent", messageCount: 0, engine: "omp" }] });

    // Error surfaced from the bridge read.
    behaviour.read = () => ({
      ok: false,
      error: { code: "ENGINE_CAPABILITY_UNAVAILABLE", message: "subagent subscription unavailable" },
    });
    await act(async () => {
      root.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-1", running: false }));
    });
    assert.equal(latest.phase, "error");
    assert.match(latest.errorDetail ?? "", /subscription unavailable/);

    // Retry recovers.
    behaviour.read = () => ({
      ok: true,
      data: {
        cursor: { fromByte: 0, nextByte: 4, reset: false },
        messages: [message("a", "recovered")],
      },
    });
    await act(async () => {
      latest.reload();
    });
    assert.equal(latest.phase, "ready");
    assert.equal(latest.run.items.length, 1);

    // A slow request must not pollute a newer selection. While it is in
    // flight, the existing rows stay visible (phase stays "ready", not cleared).
    let resolveSlow;
    const slow = new Promise((resolve) => {
      resolveSlow = resolve;
    });
    behaviour.read = () => slow;
    await act(async () => {
      latest.reload();
    });
    assert.equal(latest.phase, "ready");
    assert.deepEqual(latest.run.items.map((i) => i.message.content), ["recovered"]);

    // Selection change: unmount + remount with a different delegation.
    await act(async () => {
      root.unmount();
    });
    const container2 = globalThis.document.createElement("div");
    const root2 = createRoot(container2);
    behaviour.read = () => ({
      ok: true,
      data: {
        cursor: { fromByte: 0, nextByte: 5, reset: false },
        messages: [message("n", "new-selection")],
      },
    });
    await act(async () => {
      root2.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-2", running: false }));
    });
    assert.equal(latest.phase, "ready");
    assert.deepEqual(latest.run.items.map((i) => i.message.content), ["new-selection"]);

    // The stale slow request resolves afterwards and must be dropped.
    resolveSlow({
      ok: true,
      data: {
        cursor: { fromByte: 0, nextByte: 99, reset: false },
        messages: [message("stale", "stale-row")],
      },
    });
    await flush();
    assert.equal(latest.phase, "ready");
    assert.deepEqual(
      latest.run.items.map((i) => i.message.content),
      ["new-selection"],
      "a stale response must not overwrite the newer selection",
    );

    await act(async () => {
      root2.unmount();
    });
  } finally {
    restoreGlobals(previous);
  }
});

test("mounted read: Pi sessions never call the OMP IPC channels", async () => {
  const previous = installMinimalDom();
  const { calls, invoke } = makeInvokeMock();
  globalThis.window.piDesktop = { invoke, on: () => () => {}, platform: "linux" };

  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  try {
    useAppStore.setState({ sessions: [{ id: "s1", title: "Pi", mode: "agent", messageCount: 0 }] });
    await act(async () => {
      root.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-1", running: false }));
    });
    // The hook leaves `omp` false for a Pi session: no read is triggered.
    assert.equal(latest.omp, false);
    assert.deepEqual(calls, [], "a Pi session must not call the OMP list/read channels");

    await act(async () => {
      root.unmount();
    });
  } finally {
    restoreGlobals(previous);
  }
});

/** A controlled timer surface so the 2s poll interval never touches wall clock. */
function installFakeTimers() {
  const timers = new Map();
  let nextId = 1;
  window.setTimeout = (cb, delay) => {
    const id = nextId++;
    timers.set(id, { id, cb, delay });
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  const polls = () => [...timers.values()].filter((timer) => timer.delay === 2000);
  return { timers, polls };
}

test("mounted read: a running child is single-flight and polls 2s after completion", async () => {
  const previous = installMinimalDom();
  const { timers, polls } = installFakeTimers();
  const { calls, behaviour, invoke } = makeInvokeMock();
  globalThis.window.piDesktop = { invoke, on: () => () => {}, platform: "linux" };
  const readCalls = () => calls.filter((c) => c.channel === IPC.invoke.ompSubagentRead).length;

  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  try {
    useAppStore.setState({ sessions: [{ id: "s1", title: "OMP", mode: "agent", messageCount: 0, engine: "omp" }] });
    behaviour.read = () => ({
      ok: true,
      data: { cursor: { fromByte: 0, nextByte: 10, reset: false }, messages: [message("a", "first")] },
    });

    await act(async () => {
      root.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-1", running: true }));
    });
    assert.equal(readCalls(), 1, "mount performs exactly one read");
    assert.equal(polls().length, 1, "one poll is scheduled 2s after completion");

    // Fire the scheduled poll: exactly one more read, then a fresh poll.
    const [poll] = polls();
    timers.delete(poll.id);
    await act(async () => { await poll.cb(); });
    assert.equal(readCalls(), 2, "the scheduled poll is the second read");
    assert.equal(polls().length, 1, "the poll reschedules 2s after its own completion");

    // Stopping the child must stop polling: no further read on the next tick.
    await act(async () => {
      root.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-1", running: false }));
    });
    assert.equal(polls().length, 0, "stopping clears the armed poll");
    assert.equal(readCalls(), 2, "stopping performs no extra read");

    await act(async () => { root.unmount(); });
  } finally {
    restoreGlobals(previous);
  }
});

test("mounted read: a manual reload coalesces with an in-flight read", async () => {
  const previous = installMinimalDom();
  const { timers, polls } = installFakeTimers();
  const { calls, behaviour, invoke } = makeInvokeMock();
  globalThis.window.piDesktop = { invoke, on: () => () => {}, platform: "linux" };
  const readCalls = () => calls.filter((c) => c.channel === IPC.invoke.ompSubagentRead).length;

  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  try {
    useAppStore.setState({ sessions: [{ id: "s1", title: "OMP", mode: "agent", messageCount: 0, engine: "omp" }] });

    // Initial read resolves immediately; the poll then starts a slow read.
    behaviour.read = () => ({
      ok: true,
      data: { cursor: { fromByte: 0, nextByte: 10, reset: false }, messages: [message("a", "first")] },
    });
    await act(async () => {
      root.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-1", running: true }));
    });
    assert.equal(readCalls(), 1);

    let resolveSlow;
    const slow = new Promise((resolve) => { resolveSlow = resolve; });
    behaviour.read = () => slow;
    const [poll] = polls();
    timers.delete(poll.id);
    await act(async () => { await poll.cb(); });
    assert.equal(readCalls(), 2, "the poll starts the slow read");

    // A manual reload while that read is still in flight must coalesce, not
    // start a parallel list/read chain.
    await act(async () => { latest.reload(); });
    assert.equal(readCalls(), 2, "a manual reload coalesces with the in-flight read");

    resolveSlow({
      ok: true,
      data: { cursor: { fromByte: 10, nextByte: 20, reset: false }, messages: [message("b", "second")] },
    });
    await flush();
    assert.equal(readCalls(), 2, "no read may start merely because a coalesced trigger completed");
    assert.deepEqual(latest.run.items.map((i) => i.message.content), ["first", "second"]);

    await act(async () => { root.unmount(); });
  } finally {
    restoreGlobals(previous);
  }
});

test("mounted read: disabling OMP invalidates an in-flight read and drops its result", async () => {
  const previous = installMinimalDom();
  const { calls, behaviour, invoke } = makeInvokeMock();
  globalThis.window.piDesktop = { invoke, on: () => () => {}, platform: "linux" };

  const container = globalThis.document.createElement("div");
  const root = createRoot(container);
  try {
    useAppStore.setState({ sessions: [{ id: "s1", title: "OMP", mode: "agent", messageCount: 0, engine: "omp" }] });
    behaviour.read = () => ({
      ok: true,
      data: { cursor: { fromByte: 0, nextByte: 10, reset: false }, messages: [message("a", "first")] },
    });
    await act(async () => {
      root.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-1", running: false }));
    });
    assert.deepEqual(latest.run.items.map((i) => i.message.content), ["first"]);

    // A slow read is in flight when OMP is disabled.
    let resolveSlow;
    const slow = new Promise((resolve) => { resolveSlow = resolve; });
    behaviour.read = () => slow;
    await act(async () => { latest.reload(); });

    await act(async () => {
      root.render(createElement(HookProbe, { sessionId: "s1", delegationId: "child-1", running: false, enabled: false }));
    });
    assert.equal(latest.omp, false, "the read is disabled");

    resolveSlow({
      ok: true,
      data: { cursor: { fromByte: 0, nextByte: 99, reset: false }, messages: [message("stale", "stale-row")] },
    });
    await flush();
    assert.deepEqual(
      latest.run.items.map((i) => i.message.content),
      ["first"],
      "a read resolved after disabling OMP must not populate the panel",
    );

    await act(async () => { root.unmount(); });
  } finally {
    restoreGlobals(previous);
  }
});
