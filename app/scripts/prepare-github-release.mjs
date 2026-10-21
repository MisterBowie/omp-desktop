#!/usr/bin/env node
/** Validate updater feeds against actual release bytes before publication. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream, lstatSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";

async function digest(path, algorithm, encoding = "hex") {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
}

export async function prepareGitHubRelease({ directory, version, platforms = ["darwin", "win32", "linux"], macArchitectures = ["arm64", "x64"], sourceRevision = null }) {
  assert(/^\d+\.\d+\.\d+$/.test(version), "stable semver required");
  assert(platforms.length && platforms.every(p => ["darwin", "win32", "linux"].includes(p)), "invalid release platform");
  assert(macArchitectures.length && macArchitectures.every(a => ["arm64", "x64"].includes(a)), "invalid Mac architecture");
  const checked = new Map();
  async function feed(name, extension) {
    const data = parse(readFileSync(join(directory, name), "utf8"));
    assert.equal(data.version, version, `${name}: version mismatch`);
    assert(Array.isArray(data.files) && data.files.length, `${name}: missing files`);
    for (const file of data.files) {
      assert(file && typeof file.url === "string" && file.url === basename(file.url) && !/[\\?#%\0]/.test(file.url) && file.url.includes(`-${version}`), `${name}: unsafe or stale artifact URL`);
      const path = join(directory, file.url);
      const stat = lstatSync(path);
      assert(stat.isFile() && !stat.isSymbolicLink(), `${name}: installer must be a regular file`);
      assert.equal(await digest(path, "sha512", "base64"), file.sha512, `${file.url}: SHA512 mismatch`);
      if (file.size !== undefined) assert.equal(stat.size, file.size, `${file.url}: size mismatch`);
      checked.set(file.url, { bytes: stat.size, sha512: file.sha512 });
    }
    assert(data.files.some(file => file.url.endsWith(extension)), `${name}: missing ${extension} installer`);
    const legacy = data.files.find(file => file.url === data.path);
    assert(legacy && data.sha512 === legacy.sha512, `${name}: legacy path/hash mismatch`);
    return data;
  }
  let macFeed;
  if (platforms.includes("darwin")) {
    const feeds = [];
    for (const arch of macArchitectures) {
      const data = await feed(`latest-mac-${arch}.yml`, ".zip");
      assert(data.files.some(file => file.url.endsWith(`-${arch}-mac.zip`)), `Mac ${arch}: wrong architecture`);
      feeds.push(data);
    }
    const files = feeds.flatMap(data => data.files);
    assert.equal(new Set(files.map(file => file.url)).size, files.length, "duplicate Mac update artifact");
    const zip = files.find(file => file.url.endsWith(".zip"));
    macFeed = { ...feeds[0], files, path: zip.url, sha512: zip.sha512 };
  }
  if (platforms.includes("win32")) {
    const data = await feed("latest.yml", ".exe");
    assert(data.files.some(file => /^OMP-Desktop-Setup-/.test(file.url)), "NSIS installer required");
    assert(data.files.every(file => !file.url.includes("Portable")), "portable package cannot drive NSIS updates");
  }
  if (platforms.includes("linux")) {
    await feed("latest-linux.yml", ".AppImage");
  }
  // Commit the merged feed only after every platform and digest passed.
  if (macFeed) {
    const temporary = join(directory, "latest-mac.yml.tmp");
    writeFileSync(temporary, stringify(macFeed));
    renameSync(temporary, join(directory, "latest-mac.yml"));
  }
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    assert(!name.startsWith("pi-host-"), "retired Pi host is not a product release asset");
    if (!/^(?:OMP-Desktop-|omp-desktop-|latest(?:-[a-z0-9]+)*\.yml$)/.test(name)) continue;
    if (!name.startsWith("latest")) assert(name.includes(`-${version}`), `stale release artifact: ${name}`);
    const path = join(directory, name);
    assert(lstatSync(path).isFile(), `unexpected release entry: ${name}`);
    files.push({ name, bytes: lstatSync(path).size, sha256: await digest(path, "sha256") });
  }
  const report = { schema: "omp-desktop.github-release/1", version, sourceRevision, repository: "MisterBowie/omp-desktop", platforms, macArchitectures, verifiedUpdateArtifacts: Object.fromEntries(checked), files };
  writeFileSync(join(directory, "BUILD-RECORD.json"), JSON.stringify(report, null, 2) + "\n");
  files.push({ name: "BUILD-RECORD.json", sha256: await digest(join(directory, "BUILD-RECORD.json"), "sha256") });
  writeFileSync(join(directory, "SHA256SUMS.txt"), files.map(file => `${file.sha256}  ${file.name}\n`).join(""));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [directory, version] = process.argv.slice(2);
  assert(directory && version, "usage: prepare-github-release.mjs <artifact-directory> <stable-version>");
  const report = await prepareGitHubRelease({ directory: resolve(directory), version, sourceRevision: process.env.GITHUB_SHA ?? null });
  console.log(`Verified ${Object.keys(report.verifiedUpdateArtifacts).length} updater artifacts for ${version}`);
}
