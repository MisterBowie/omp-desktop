import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const { GitHubProvider } = require("electron-updater/out/providers/GitHubProvider.js");
const updaterRequire = createRequire(require.resolve("electron-updater/package.json"));
const semver = updaterRequire("semver");

function fixture(stableAvailable = true) {
  const requests = [];
  const base = "/MisterBowie/omp-desktop/releases";
  const atom = `<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>Historical test package</title><link href="https://github.com${base}/tag/m7-test-20261015-46e7bf7"/><content type="html">0.15.3 test build</content></entry>
    <entry><title>OMP Desktop 0.1.1</title><link href="https://github.com${base}/tag/v0.1.1"/><content type="html">Stable product release</content></entry>
  </feed>`;
  const executor = { request: async options => {
    requests.push({ host: options.hostname, path: options.path });
    if (options.path === `${base}.atom`) return atom;
    if (options.path === `${base}/latest`) {
      if (!stableAvailable) throw new Error("404: no stable release");
      return JSON.stringify({ tag_name: "v0.1.1" });
    }
    if (options.path === `${base}/download/v0.1.1/latest-mac.yml`) {
      const file = { url: "OMP-Desktop-0.1.1-arm64-mac.zip", sha512: Buffer.alloc(64).toString("base64"), size: 1 };
      return JSON.stringify({ version: "0.1.1", files: [file], path: file.url, sha512: file.sha512 });
    }
    throw new Error(`Unexpected update request: ${options.path}`);
  } };
  const provider = new GitHubProvider({ provider: "github", owner: "MisterBowie", repo: "omp-desktop" }, {
    allowPrerelease: false, channel: null, currentVersion: semver.parse("0.1.0"), fullChangelog: false,
  }, { executor, platform: "darwin", isUseMultipleRangeRequest: false });
  return { provider, requests };
}

test("the real GitHub provider selects the new stable series ahead of historical test releases", async () => {
  const { provider, requests } = fixture();
  const info = await provider.getLatestVersion();
  assert.equal(info.version, "0.1.1");
  assert.equal(info.tag, "v0.1.1");
  const files = provider.resolveFiles(info);
  assert.equal(files[0].url.href, "https://github.com/MisterBowie/omp-desktop/releases/download/v0.1.1/OMP-Desktop-0.1.1-arm64-mac.zip");
  assert(requests.every(request => request.host === "github.com"));
  assert(requests.some(request => request.path.endsWith("/latest")));
  assert(requests.every(request => !request.path.includes("/download/m7-")));
});

test("a missing stable release is an error, never a fallback into a historical test package", async () => {
  const { provider, requests } = fixture(false);
  await assert.rejects(provider.getLatestVersion(), /production release exists/);
  assert(requests.every(request => !request.path.includes("/download/")));
});
