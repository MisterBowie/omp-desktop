// Real Chromium capture through the bundled Browser tool and production host.
// The page and profile belong to this fixture; no model or user profile is used.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage } from "electron";
import { BrowserHost } from "../../apps/desktop/electron/main/browser-host.ts";
import { onLoad } from "../../apps/desktop/resources/plugins/pi.browser/main.js";

const evidence = process.env.PI_BROWSER_SCREENSHOT_EVIDENCE;
app.setPath("userData", join(evidence, "profile"));
let window;

async function run() {
  await app.whenReady();
  window = new BrowserWindow({
    width: 345, height: 720, useContentSize: true, show: false,
    webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  const host = new BrowserHost({
    pane: { getWebContents: () => window.webContents },
    isPluginLoaded: () => true,
    getFileRoot: async () => evidence,
    getScratchDir: () => evidence,
    onState: () => {},
  });
  let tool;
  globalThis.pi = {
    agent: { registerTool: async (value) => { tool = value; } },
    browser: { screenshot: (input) => host.screenshot(input, "screenshot-regression") },
  };
  await onLoad();
  assert.equal(tool.name, "Browser");
  const captures = [];
  for (const [name, width, height, deviceScaleFactor] of [
    ["reported-long-page", 345, 9663, 1],
    ["wide-page", 10000, 800, 1],
    ["both-axes", 5000, 12000, 1],
    ["small-page", 800, 900, 1],
    ["long-page-hidpi", 345, 9663, 2],
  ]) {
    const html = `<style>html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
      #page{width:${width}px;height:${height}px;background:linear-gradient(to bottom,
      rgb(240,20,20) 0% 33%,rgb(20,240,20) 33% 66%,rgb(20,20,240) 66% 100%)}</style><div id="page"></div>`;
    await window.loadURL(`data:text/html,${encodeURIComponent(html)}`);
    if (!window.webContents.debugger.isAttached()) window.webContents.debugger.attach("1.3");
    await window.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 345, height: 720, deviceScaleFactor, mobile: false,
    });
    await window.webContents.executeJavaScript(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    const result = await tool.execute({ action: "screenshot", fullPage: true });
    assert.equal(result.ok, true);
    assert.equal(result.images.length, 1);
    assert.equal(result.mimeType, "image/jpeg");
    const bytes = Buffer.from(result.images[0].data, "base64");
    writeFileSync(join(evidence, `${name}.jpg`), bytes);
    assert.deepEqual(readFileSync(result.path), bytes, "saved and model-facing images match");
    const image = nativeImage.createFromBuffer(bytes);
    assert.equal(image.isEmpty(), false, "JPEG must decode");
    const size = image.getSize();
    assert.ok(size.width <= 1280 * deviceScaleFactor && size.height <= 2048 * deviceScaleFactor,
      `${name}: ${JSON.stringify(size)}`);
    assert.ok(size.width <= 4096 && size.height <= 4096, "model image dimensions remain valid");
    assert.ok(size.width <= width * deviceScaleFactor && size.height <= height * deviceScaleFactor,
      "small pages are never upscaled");
    assert.ok(Math.abs(size.width * height - size.height * width) <= width + height,
      `${name}: aspect ratio is preserved to pixel rounding (${JSON.stringify(size)})`);
    for (const [fraction, channel] of [[0.1, 2], [0.5, 1], [0.9, 0]]) {
      // Native bitmaps use BGRA: all three page sections must survive scaling.
      const pixel = image.crop({
        x: Math.floor(size.width / 2), y: Math.floor(size.height * fraction), width: 1, height: 1,
      }).toBitmap();
      assert.ok(pixel[channel] > 200, `${name}: full-page section ${fraction} is missing`);
    }
    captures.push({ name, original: { width, height }, deviceScaleFactor, actual: size, bytes: bytes.length });
  }
  const viewport = await tool.execute({ action: "screenshot", fullPage: false });
  const viewportSize = nativeImage.createFromBuffer(Buffer.from(viewport.images[0].data, "base64")).getSize();
  assert.deepEqual(viewportSize, { width: 690, height: 1440 });
  captures.push({ name: "viewport", actual: viewportSize });
  writeFileSync(join(evidence, "report.json"), JSON.stringify({
    status: "passed", electron: process.versions.electron, captures,
  }, null, 2));
}

run().then(() => {
  window.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  window?.destroy();
  app.exit(1);
});
