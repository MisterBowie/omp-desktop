import assert from "node:assert/strict";
import { register } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { McpServerClient } = await import("../electron/main/plugin-mcp.ts");
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const json = (id, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
  headers: { "content-type": "application/json" },
});
const reply = (message) => message.method === "initialize"
  ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
  : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
function client(t, fetchImpl, options = {}) {
  const instance = new McpServerClient({
    rootPath: tmpdir(), values: {},
    server: { id: "fixture", transport: "http", url: "http://127.0.0.1:1/mcp" },
    connectTimeoutMs: 500, callTimeoutMs: 100, fetchImpl, ...options,
  });
  t.after(() => instance.close());
  return instance;
}

test("MCP dispatches chunked UTF-8/CRLF events while their SSE bodies remain open", async (t) => {
  const signals = [];
  const instance = client(t, async (_url, request) => {
    const message = JSON.parse(request.body);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = reply(message);
    if (message.method === "tools/list") result.tools[0].name = "工具";
    const bytes = new TextEncoder().encode(`event: message\r\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\r\n\r\n`);
    signals.push(request.signal);
    return new Response(new ReadableStream({
      start(controller) {
        // Splits include multibyte code points and CR/LF boundaries.
        for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
        request.signal.addEventListener("abort", () => controller.error(new DOMException("Aborted", "AbortError")), { once: true });
      },
    }), { headers: { "content-type": "text/event-stream" } });
  });
  assert.equal((await instance.connect())[0].name, "工具");
  assert.equal(signals.length, 2);
  assert.equal(signals.some((signal) => signal.aborted), false);
  instance.close();
  assert.equal(signals.every((signal) => signal.aborted), true);
});

test("an oversized incremental SSE body is cancelled and refused", async (t) => {
  let cancelled = false;
  const instance = client(t, async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1).fill(120)); },
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/event-stream" } }));
  await assert.rejects(instance.connect(), (error) => error.code === "LIMIT_EXCEEDED");
  assert.equal(cancelled, true);
  assert.equal(instance.isConnected(), false);
});

test("MCP timeout notifies the server once and aborts the HTTP call at its own budget", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  let toolId;
  let signal;
  const instance = client(t, async (_url, request) => {
    const message = JSON.parse(request.body);
    sent.push(message);
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method !== "tools/call") return json(message.id, reply(message));
    toolId = message.id;
    signal = request.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  });
  await instance.connect();
  const rejected = assert.rejects(instance.callTool("echo", {}), (error) => error.code === "TIMEOUT");
  await drain();
  assert.equal(typeof toolId, "number");
  t.mock.timers.tick(100);
  await rejected;
  await drain();
  assert.deepEqual(sent.filter((message) => message.method === "notifications/cancelled"), [{
    jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: toolId, reason: "timeout" },
  }]);
  assert.equal(signal.aborted, true);
});

test("MCP never sends a cancellation notification for initialize", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sent = [];
  const instance = client(t, async (_url, request) => {
    sent.push(JSON.parse(request.body));
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
  });
  const rejected = assert.rejects(instance.connect(), (error) => error.code === "TIMEOUT");
  await drain();
  t.mock.timers.tick(500);
  await rejected;
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, "initialize");
});

test("a tool's HTTP response may outlive the shorter connection timeout", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let signal;
  let respond;
  const instance = client(t, async (_url, request) => {
    const message = JSON.parse(request.body);
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method !== "tools/call") return json(message.id, reply(message));
    signal = request.signal;
    return new Promise((resolve, reject) => {
      respond = () => resolve(json(message.id, { content: [{ type: "text", text: "done" }] }));
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }, { connectTimeoutMs: 10, callTimeoutMs: 100 });
  await instance.connect();
  const pending = instance.callTool("echo", {});
  await drain();
  t.mock.timers.tick(11);
  assert.equal(signal.aborted, false);
  respond();
  assert.deepEqual(await pending, { content: [{ type: "text", text: "done" }] });
});
