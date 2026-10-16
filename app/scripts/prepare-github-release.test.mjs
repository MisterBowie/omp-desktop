import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { prepareGitHubRelease } from "./prepare-github-release.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "omp-release-feed-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const definitions = {
    "latest-mac-arm64.yml": "OMP-Desktop-0.1.0-arm64-mac.zip",
    "latest-mac-x64.yml": "OMP-Desktop-0.1.0-x64-mac.zip",
    "latest.yml": "OMP-Desktop-Setup-0.1.0.exe",
    "latest-linux.yml": "OMP-Desktop-0.1.0-x64.AppImage",
  };
  for (const [name, url] of Object.entries(definitions)) {
    const bytes = Buffer.from(`owned fixture ${url}`);
    writeFileSync(join(directory, url), bytes);
    const sha512 = createHash("sha512").update(bytes).digest("base64");
    writeFileSync(join(directory, name), stringify({ version: "0.1.0", files: [{ url, sha512, size: bytes.length }], path: url, sha512 }));
  }
  const host = "pi-host-0.1.0-linux-x64.tar.gz", bytes = Buffer.from("owned headless fixture");
  writeFileSync(join(directory, host), bytes);
  writeFileSync(join(directory, `${host}.sha256`), createHash("sha256").update(bytes).digest("hex") + `  ${host}\n`);
  return { directory, definitions, run: () => prepareGitHubRelease({ directory, version: "0.1.0" }) };
}

test("prepares all platform feeds and merges both Mac architectures after verifying bytes", async t => {
  const f = fixture(t), result = await f.run();
  assert.equal(Object.keys(result.verifiedUpdateArtifacts).length, 4);
  const mac = parse(readFileSync(join(f.directory, "latest-mac.yml"), "utf8"));
  assert.equal(mac.files.length, 2);
  assert(mac.files.some(file => file.url.includes("arm64")));
  assert(mac.files.some(file => file.url.includes("x64")));
  assert(existsSync(join(f.directory, "SHA256SUMS.txt")));
});

test("refuses tampered downloads without producing a merged update feed", async t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, f.definitions['latest.yml']), "tampered");
  await assert.rejects(f.run(), /SHA512 mismatch/);
  assert.equal(existsSync(join(f.directory, "latest-mac.yml")), false);
});

test("refuses stale versions, prereleases and missing platform manifests", async t => {
  const f = fixture(t);
  await assert.rejects(prepareGitHubRelease({ directory: f.directory, version: "0.1.0-beta.1" }), /stable semver/);
  const path = join(f.directory, "latest.yml"), data = parse(readFileSync(path, "utf8"));
  data.version = "0.15.3"; writeFileSync(path, stringify(data));
  await assert.rejects(f.run(), /version mismatch/);
  rmSync(path);
  await assert.rejects(f.run(), /ENOENT/);
});

test("refuses traversal and remote installer URLs", async t => {
  const f = fixture(t);
  const path = join(f.directory, "latest.yml"), data = parse(readFileSync(path, "utf8"));
  for (const url of ["../OMP-Desktop-Setup-0.1.0.exe", "https://example.com/OMP-Desktop-Setup-0.1.0.exe", "OMP-Desktop-Setup-0.1.0.exe?other"] ) {
    data.files[0].url = url; writeFileSync(path, stringify(data));
    await assert.rejects(f.run(), /unsafe or stale/);
  }
});

test("refuses stale non-feed assets and a mismatched remote-host checksum", async t => {
  const f = fixture(t);
  const stale = join(f.directory, "OMP-Desktop-0.15.3-arm64.dmg");
  writeFileSync(stale, "old build");
  await assert.rejects(f.run(), /stale release artifact/);
  rmSync(stale);
  writeFileSync(join(f.directory, "pi-host-0.1.0-linux-x64.tar.gz.sha256"), "wrong");
  await assert.rejects(f.run(), /remote-host SHA256 mismatch/);
});
