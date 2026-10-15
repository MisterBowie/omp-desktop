import assert from "node:assert/strict";
import { test } from "node:test";
import { FakeProvider } from "../../../experiments/omp-bridge/lib/provider.mjs";
import { startMaintenanceProvider } from "../../../scripts/e2e/maintenance-provider.mjs";
import { assertClosedHistory } from "../../../scripts/e2e/maintenance-history.mjs";

test("maintenance HTTP faults preserve the real request path and recover", async () => {
  const provider = await FakeProvider.start();
  const proxy = await startMaintenanceProvider(provider.baseUrl);
  try {
    const url = `${proxy.baseUrl}/chat/completions`;
    const post = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "local-model", messages: [{ role: "user", content: "fixture" }] }) });
    proxy.failNext(2);
    await assert.rejects(post); await assert.rejects(post);
    assert.equal(proxy.faults.length, 2);
    assert.equal(provider.requests.length, 0, "disconnected requests must not reach the model");
    const recovered = await post(); assert.equal(recovered.status, 200); assert((await recovered.text()).includes("[DONE]"));
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].body.messages[0].content, "fixture");
    proxy.failNext(1, 401);
    const terminal = await post(); assert.equal(terminal.status, 401); assert((await terminal.text()).includes("M7_AUTH_TERMINAL"));
    const resumed = await post(); assert.equal(resumed.status, 200); await resumed.text();
    assert.equal(provider.requests.length, 2);
    assert.deepEqual(proxy.faults.map(row => row.path), Array(3).fill("/v1/chat/completions"));
  } finally { await proxy.close(); await provider.close(); }
});

test("maintenance proxy rejects a non-loopback destination before opening a socket", async () => {
  await assert.rejects(() => startMaintenanceProvider("http://example.com/v1"));
});

test("closed native history may append exit records but never mutate or append execution", () => {
  const before = Buffer.from('{"type":"message"}\n');
  const closed = Buffer.concat([before, Buffer.from('{"type":"custom","customType":"session_exit"}\n')]);
  assert.equal(assertClosedHistory(before, closed), 1);
  assert.equal(assertClosedHistory(before, before), 0);
  assert.throws(() => assertClosedHistory(before, Buffer.from('{"type":"changed"}\n')));
  assert.throws(() => assertClosedHistory(before, Buffer.concat([before, Buffer.from('{"type":"message"}\n')])));
});
