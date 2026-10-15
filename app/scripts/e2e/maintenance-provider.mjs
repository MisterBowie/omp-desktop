/** Real HTTP fault boundary in front of the loopback scripted model. */
import assert from "node:assert/strict";
import { createServer, request } from "node:http";

export async function startMaintenanceProvider(target) {
  const destination = new URL(target);
  assert.equal(destination.hostname, "127.0.0.1");
  const faults = [];
  let remaining = 0;
  let status = null;
  const server = createServer((incoming, outgoing) => {
    if (incoming.method === "POST" && remaining > 0) {
      remaining--;
      faults.push({ at: Date.now(), method: incoming.method, path: incoming.url, status, kind: status ? "http-error" : "connection-destroyed" });
      incoming.resume();
      if (status) {
        outgoing.writeHead(status, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: { message: "M7_AUTH_TERMINAL", type: "authentication_error" } }));
      } else incoming.socket.destroy();
      return;
    }
    const forwarded = request({ hostname: destination.hostname, port: destination.port, path: incoming.url, method: incoming.method,
      headers: { "content-type": "application/json" } }, response => {
      outgoing.writeHead(response.statusCode, { "content-type": response.headers["content-type"] ?? "application/json" });
      response.pipe(outgoing);
    });
    forwarded.on("error", error => { outgoing.destroy(error); });
    outgoing.on("close", () => { if (!outgoing.writableFinished) forwarded.destroy(); });
    incoming.pipe(forwarded);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, faults,
    failNext(count, httpStatus = null) { assert(Number.isInteger(count) && count > 0); remaining = count; status = httpStatus; },
    async close() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}
