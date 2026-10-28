import assert from "node:assert/strict";
import test from "node:test";

import { ompProxyPolicy, proxyUrlFromChromiumList } from "../electron/main/runtime/omp-network-proxy.ts";

const TARGET = "https://api.example.com/v1";

test("custom mode launches behind the saved address with its bypass list", async () => {
  const policy = await ompProxyPolicy({
    settings: { mode: "custom", url: "http://127.0.0.1:7890", bypass: "localhost" },
    targetUrl: TARGET,
    label: "test",
    systemProxy: async () => {
      throw new Error("custom mode must not ask the system");
    },
  });
  assert.deepEqual(policy, { url: "http://127.0.0.1:7890", bypass: "localhost" });
});

test("direct mode launches without a proxy and never asks the system", async () => {
  const policy = await ompProxyPolicy({
    settings: { mode: "direct" },
    targetUrl: TARGET,
    label: "test",
    systemProxy: async () => {
      throw new Error("direct mode must not ask the system");
    },
  });
  assert.equal(policy, undefined);
});

test("system mode uses the proxy Chromium resolves for the target", async () => {
  const asked = [];
  const policy = await ompProxyPolicy({
    settings: { mode: "system" },
    targetUrl: TARGET,
    label: "test",
    systemProxy: async (url) => {
      asked.push(url);
      return "PROXY 127.0.0.1:7890; DIRECT";
    },
  });
  assert.deepEqual(asked, [TARGET]);
  assert.deepEqual(policy, { url: "http://127.0.0.1:7890", bypass: "localhost,127.0.0.1,::1" });
});

test("system mode resolving DIRECT launches without a proxy", async () => {
  const policy = await ompProxyPolicy({
    settings: undefined,
    targetUrl: TARGET,
    label: "test",
    systemProxy: async () => "DIRECT",
  });
  assert.equal(policy, undefined);
});

test("a failing system resolver degrades to direct and logs a warning", async () => {
  const logs = [];
  const policy = await ompProxyPolicy({
    settings: { mode: "system" },
    targetUrl: TARGET,
    label: "OMP session",
    systemProxy: async () => {
      throw new Error("no resolver");
    },
    log: (level, message, data) => logs.push({ level, message, data }),
  });
  assert.equal(policy, undefined);
  assert.deepEqual(logs, [{ level: "warn", message: "OMP session system proxy unresolved", data: "no resolver" }]);
});

test("a Chromium proxy list maps each proxy type to a URL the runtime understands", () => {
  assert.equal(proxyUrlFromChromiumList("SOCKS5 127.0.0.1:1080"), "socks5://127.0.0.1:1080");
  assert.equal(proxyUrlFromChromiumList("HTTPS proxy.corp:8443"), "https://proxy.corp:8443");
  assert.equal(proxyUrlFromChromiumList("DIRECT"), null);
});
