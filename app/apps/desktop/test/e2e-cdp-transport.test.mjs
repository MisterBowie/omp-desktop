import assert from "node:assert/strict";
import { test } from "node:test";
import { CdpClient } from "../../../scripts/e2e/cdp.mjs";

class TestSocket extends EventTarget {
  static instances = [];
  static open = true;
  sent = [];
  closeCount = 0;
  constructor() {
    super();
    TestSocket.instances.push(this);
    if (TestSocket.open) queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(message) { this.sent.push(JSON.parse(message)); }
  close() { this.closeCount++; this.dispatchEvent(new Event("close")); }
  message(value) { this.dispatchEvent(new MessageEvent("message", { data: value })); }
}

test("CDP transport owns its socket and outstanding requests", async (t) => {
  const original = globalThis.WebSocket;
  globalThis.WebSocket = TestSocket;
  t.after(() => { globalThis.WebSocket = original; });
  await t.test("invalid frames reject pending work and close the socket exactly once", async () => {
    let failures = 0;
    const client = await CdpClient.connect("ws://fixture", () => { failures++; });
    const socket = TestSocket.instances.at(-1);
    const pending = client.send("Runtime.enable");
    const rejection = assert.rejects(pending, /invalid CDP message/);
    socket.message("invalid-json");
    await rejection;
    await client.close();
    assert.equal(socket.closeCount, 1);
    assert.equal(client.pending.size, 0);
    assert.equal(failures, 1);
  });
  await t.test("a connection that never opens is bounded and closed", async () => {
    TestSocket.open = false;
    try {
      await assert.rejects(CdpClient.connect("ws://fixture", undefined, { timeoutMs: 20 }), /connection timed out/);
      assert.equal(TestSocket.instances.at(-1).closeCount, 1);
    } finally { TestSocket.open = true; }
  });
  await t.test("sync Main reads and async renderer reads use explicit protocol semantics", async () => {
    const client = await CdpClient.connect("ws://fixture");
    const socket = TestSocket.instances.at(-1);
    try {
      const sync = client.evaluate("app.isReady()", "Main", { awaitPromise: false });
      const first = socket.sent.at(-1);
      assert.equal(first.params.awaitPromise, false);
      socket.message(JSON.stringify({ id: first.id, result: { result: { value: true } } }));
      assert.equal(await sync, true);
      const asyncResult = client.evaluate("Promise.resolve(42)");
      const second = socket.sent.at(-1);
      assert.equal(second.params.awaitPromise, true);
      socket.message(JSON.stringify({ id: second.id, result: { result: { value: 42 } } }));
      assert.equal(await asyncResult, 42);
      await assert.rejects(client.send("never-answered", {}, 20), /timeout never-answered/);
      assert.equal(client.pending.size, 0);
    } finally { await client.close(); }
  });
});
