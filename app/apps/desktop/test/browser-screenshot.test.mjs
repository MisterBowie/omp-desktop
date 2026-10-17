import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { register } from "node:module";
import test from "node:test";

register(new URL("./helpers/ts-import-hooks.mjs", import.meta.url));
const { BrowserCdp } = await import("../electron/main/browser-cdp.ts");

function guest(metrics, data = "jpeg-data") {
  const commands = [];
  let attached = false;
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => { attached = true; },
    detach: () => { attached = false; },
    async sendCommand(method, params) {
      commands.push({ method, params });
      if (method === "Page.getLayoutMetrics") return metrics;
      if (method === "Page.captureScreenshot") return { data };
      return {};
    },
  });
  return {
    wc: { id: 1, isDestroyed: () => false, debugger: debuggerApi },
    commands,
  };
}

for (const [name, width, height] of [
  ["reported long page", 345, 9663],
  ["wide page", 10000, 800],
  ["large page on both axes", 10000, 30000],
  ["page already at the limits", 1280, 2048],
  ["small page", 320, 240],
]) {
  test(`full-page screenshot bounds ${name} without cropping or upscaling`, async () => {
    const { wc, commands } = guest({ cssContentSize: { width, height } });
    const cdp = new BrowserCdp();
    try {
      assert.deepEqual(await cdp.screenshot(wc, { fullPage: true }), {
        mimeType: "image/jpeg", data: "jpeg-data",
      });
      const { params } = commands.find((c) => c.method === "Page.captureScreenshot");
      assert.deepEqual(
        { x: params.clip.x, y: params.clip.y, width: params.clip.width, height: params.clip.height },
        { x: 0, y: 0, width, height },
        "capture the complete page, including the bottom",
      );
      assert.equal(params.captureBeyondViewport, true);
      assert.ok(params.clip.scale > 0 && params.clip.scale <= 1);
      assert.ok(width * params.clip.scale <= 1280);
      assert.ok(height * params.clip.scale <= 2048);
      if (width <= 1280 && height <= 2048) assert.equal(params.clip.scale, 1);
    } finally {
      cdp.detach(wc);
    }
  });
}

test("full-page screenshot prefers CSS metrics over device-pixel metrics", async () => {
  const { wc, commands } = guest({
    cssContentSize: { width: 345, height: 9663 },
    contentSize: { width: 690, height: 19326 },
  });
  const cdp = new BrowserCdp();
  try {
    await cdp.screenshot(wc, { fullPage: true });
    const { clip } = commands.find((c) => c.method === "Page.captureScreenshot").params;
    assert.equal(clip.width, 345);
    assert.equal(clip.height, 9663);
    assert.ok(clip.height * clip.scale <= 2048);
  } finally {
    cdp.detach(wc);
  }
});

test("full-page screenshot supports legacy content metrics", async () => {
  const { wc, commands } = guest({ contentSize: { width: 345, height: 9663 } });
  const cdp = new BrowserCdp();
  try {
    await cdp.screenshot(wc, { fullPage: true });
    const { clip } = commands.find((c) => c.method === "Page.captureScreenshot").params;
    assert.equal(clip.height, 9663);
    assert.ok(clip.height * clip.scale <= 2048);
  } finally {
    cdp.detach(wc);
  }
});

test("viewport screenshot preserves its existing capture behavior", async () => {
  const { wc, commands } = guest({});
  const cdp = new BrowserCdp();
  try {
    await cdp.screenshot(wc);
    assert.equal(commands.some((c) => c.method === "Page.getLayoutMetrics"), false);
    assert.deepEqual(commands.find((c) => c.method === "Page.captureScreenshot").params, {
      format: "jpeg", quality: 70,
    });
  } finally {
    cdp.detach(wc);
  }
});

test("empty screenshot remains an observable error", async () => {
  const { wc } = guest({}, "");
  const cdp = new BrowserCdp();
  try {
    await assert.rejects(cdp.screenshot(wc), /screenshot produced no data/);
  } finally {
    cdp.detach(wc);
  }
});
