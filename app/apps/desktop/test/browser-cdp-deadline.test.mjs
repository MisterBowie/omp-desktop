import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserHost, BROWSER_CDP_TIMEOUT_MS } = await import("../electron/main/browser-host.ts");
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function harness() {
  const control = { hang: false, hangMethod: null, detached: 0, commands: [], release: null };
  let attached = true;
  const wc = {
    id: 120, isDestroyed: () => false, getURL: () => "about:blank", getTitle: () => "Fixture",
    debugger: {
      isAttached: () => attached,
      attach() { attached = true; },
      detach() { attached = false; control.detached++; },
      on() {}, off() {},
      sendCommand(method) {
        control.commands.push(method);
        if (method.endsWith(".enable")) return Promise.resolve({});
        if (control.hang || control.hangMethod === method) {
          return new Promise((resolve) => { control.release = resolve; });
        }
        if (method === "Accessibility.getFullAXTree") return Promise.resolve({
          nodes: [{ nodeId: "root", backendDOMNodeId: 1, role: { value: "textbox" }, name: { value: "fixture" } }],
        });
        if (method === "DOM.getBoxModel") return Promise.resolve({ model: { content: [0, 0, 10, 0, 10, 10, 0, 10] } });
        if (method === "DOM.resolveNode") return Promise.resolve({ object: { objectId: "fixture" } });
        if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: 1 } });
        if (method === "Page.captureScreenshot") return Promise.resolve({ data: "eA==" });
        return Promise.resolve({});
      },
    },
  };
  const host = new BrowserHost({
    pane: { getWebContents: () => wc, dispose() {} },
    isPluginLoaded: () => true, getFileRoot: async () => null, onState() {},
  });
  return { host, control };
}

const operations = {
  snapshot: (host) => host.snapshot(),
  screenshot: (host) => host.screenshot(),
  click: (host) => host.click("e1"),
  fill: (host) => host.fill("e1", "value"),
  evaluate: (host) => host.evaluate("1"),
  cdp: (host) => host.cdpCommand("Runtime.evaluate", { expression: "1" }),
};
for (const [name, invoke] of Object.entries(operations)) {
  test(`a stalled BrowserHost ${name} times out and allows a new snapshot`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { host, control } = harness();
    t.after(() => host.disposeGuest());
    await host.snapshot();
    control.hang = true;
    const rejected = assert.rejects(invoke(host), (error) => error.code === "TIMEOUT");
    await drain();
    t.mock.timers.tick(BROWSER_CDP_TIMEOUT_MS);
    await rejected;
    assert.equal(control.detached, 1);
    control.hang = false;
    assert.match((await host.snapshot()).tree, /fixture/);
  });
}

test("healthy CDP calls clear the deadline without detaching later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, control } = harness();
  t.after(() => host.disposeGuest());
  assert.equal(await host.evaluate("1"), 1);
  t.mock.timers.tick(BROWSER_CDP_TIMEOUT_MS * 2);
  await drain();
  assert.equal(control.detached, 0);
});

test("a late reply after timeout cannot resume an old click on the reattached guest", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { host, control } = harness();
  t.after(() => host.disposeGuest());
  await host.snapshot();
  control.hangMethod = "DOM.scrollIntoViewIfNeeded";
  const rejected = assert.rejects(host.click("e1"), (error) => error.code === "TIMEOUT");
  await drain();
  const releaseOldReply = control.release;
  assert.equal(typeof releaseOldReply, "function");
  t.mock.timers.tick(BROWSER_CDP_TIMEOUT_MS);
  await rejected;
  control.hangMethod = null;
  await host.snapshot();
  releaseOldReply({});
  await drain();
  assert.equal(control.commands.filter((method) => method === "Input.dispatchMouseEvent").length, 0);
});
