/** Inspect the actual Electron payload, separately from runtime-only acceptance. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DESKTOP = join(ROOT, "apps", "desktop");
const expected = JSON.parse(readFileSync(join(DESKTOP, "package.json"), "utf8"));
const require = createRequire(join(DESKTOP, "package.json"));
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const { extractFile } = libRequire("@electron/asar");
export const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileDigest = (path) => digest(readFileSync(path));

export function executableArchitecture(path, platform) {
  if (platform === "darwin") {
    return execFileSync("/usr/bin/lipo", ["-archs", path], { encoding: "utf8" }).trim();
  }
  const descriptor = openSync(path, "r");
  const header = Buffer.alloc(64 * 1024);
  let length;
  try { length = readSync(descriptor, header, 0, header.length, 0); }
  finally { closeSync(descriptor); }
  if (platform === "win32") {
    assert(length >= 64 && header.toString("ascii", 0, 2) === "MZ", "invalid installed PE header");
    const offset = header.readUInt32LE(0x3c);
    assert(offset + 6 <= length && header.readUInt32LE(offset) === 0x4550, "invalid PE signature");
    const arch = { 0x8664: "x64", 0xaa64: "arm64", 0x14c: "ia32" }[header.readUInt16LE(offset + 4)];
    assert(arch, "unrecognized installed PE architecture");
    return arch;
  }
  assert(length >= 20 && header.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70])), "invalid installed ELF header");
  assert.equal(header[5], 1, "installed ELF must use little-endian encoding");
  const arch = { 62: "x64", 183: "arm64", 3: "ia32" }[header.readUInt16LE(18)];
  assert(arch, "unrecognized installed ELF architecture");
  assert.equal(header[4], arch === "ia32" ? 1 : 2, "ELF class and machine disagree");
  return arch;
}

export function installedPaths(appDirectory, platform = process.platform) {
  const appDir = resolve(appDirectory);
  if (platform === "darwin") {
    assert(appDir.endsWith(".app"), "an actual .app bundle is required");
    const info = JSON.parse(execFileSync("/usr/bin/plutil", [
      "-convert", "json", "-o", "-", join(appDir, "Contents", "Info.plist"),
    ], { encoding: "utf8" }));
    return {
      appDir, info, resources: join(appDir, "Contents", "Resources"),
      executable: join(appDir, "Contents", "MacOS", info.CFBundleExecutable),
    };
  }
  assert(platform === "win32" || platform === "linux", "unsupported native platform");
  return {
    appDir, info: null, resources: join(appDir, "resources"),
    executable: join(appDir, platform === "win32"
      ? `${expected.build.win.executableName}.exe` : expected.build.linux.executableName),
  };
}

function verifyNotices(resources) {
  const source = join(DESKTOP, "resources", "licenses");
  const directory = join(resources, "licenses");
  const staticFiles = [];
  for (const line of readFileSync(join(source, "SHA256SUMS.txt"), "utf8").trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([A-Za-z0-9_.-]+)$/);
    assert(match, "invalid source notice checksum");
    const bytes = readFileSync(join(directory, match[2]));
    assert.equal(digest(bytes), match[1], `installed upstream notice changed: ${match[2]}`);
    staticFiles.push({ file: match[2], bytes: bytes.length, sha256: match[1] });
  }
  const generated = join(directory, "dependencies");
  const inventoryBytes = readFileSync(join(generated, "inventory.json"));
  const inventory = JSON.parse(inventoryBytes);
  assert.equal(inventory.schema, "omp-desktop.dependency-notices/1");
  assert.equal(inventory.notice.file, "THIRD-PARTY-NOTICES.txt");
  const body = readFileSync(join(generated, inventory.notice.file));
  assert.equal(body.length, inventory.notice.bytes);
  assert.equal(digest(body), inventory.notice.sha256);
  assert(Array.isArray(inventory.components) && inventory.components.length > 0);
  const seen = new Set();
  let originalFiles = 0;
  let rustComponents = 0;
  for (const component of inventory.components) {
    assert(typeof component.id === "string" && !seen.has(component.id));
    seen.add(component.id);
    if (component.id.startsWith("cargo:")) rustComponents++;
    assert(Array.isArray(component.files));
    for (const file of component.files) {
      assert(Number.isSafeInteger(file.offset) && file.offset >= 0);
      assert(Number.isSafeInteger(file.bytes) && file.bytes >= 0);
      assert(file.offset + file.bytes <= body.length);
      assert.equal(digest(body.subarray(file.offset, file.offset + file.bytes)), file.sha256);
      originalFiles++;
    }
  }
  assert(rustComponents > 0 && rustComponents < inventory.components.length);
  assert(originalFiles > 0);
  return {
    staticFiles, components: inventory.components.length, rustComponents, originalFiles,
    noticeSha256: digest(body), inventorySha256: digest(inventoryBytes),
  };
}

export function inspectInstalledProduct(appDirectory, platform = process.platform, expectedVersion = expected.version) {
  const paths = installedPaths(appDirectory, platform);
  assert(existsSync(paths.executable), "installed Electron executable is missing");
  const archive = join(paths.resources, "app.asar");
  const metadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  assert.equal(metadata.name, expected.build.extraMetadata.name, "installed package identity is not OMP's own");
  assert.equal(metadata.version, expectedVersion);
  assert.equal(metadata.homepage, expected.homepage);
  const html = extractFile(archive, join("out", "renderer", "index.html")).toString("utf8");
  assert(html.includes("<title>OMP Desktop</title>"), "installed renderer title is stale");
  const update = parseYaml(readFileSync(join(paths.resources, "app-update.yml"), "utf8"));
  const source = expected.build.publish[0];
  for (const key of ["provider", "owner", "repo"]) assert.equal(update[key], source[key]);
  assert.equal(update.updaterCacheDirName, "omp-desktop-updater");
  const icons = [];
  function icon(resource, original) {
    const hash = fileDigest(join(paths.resources, resource));
    assert.equal(hash, fileDigest(join(DESKTOP, "build", original)), `installed icon differs: ${resource}`);
    icons.push({ file: resource, sha256: hash });
  }
  icon("tray-icon.png", "icon.png");
  const architecture = executableArchitecture(paths.executable, platform);
  assert.equal(architecture, process.arch);
  if (platform === "darwin") {
    assert.equal(paths.info.CFBundleIdentifier, expected.build.appId);
    assert.equal(paths.info.CFBundleDisplayName, expected.build.productName);
    const iconName = paths.info.CFBundleIconFile;
    assert.equal(basename(iconName), iconName, "invalid bundle icon path");
    icon(iconName.endsWith(".icns") ? iconName : `${iconName}.icns`, "icon.icns");
    icon("tray-icon-mac.png", "tray-icon-mac.png");
  } else if (platform === "win32") {
    icon("app-icon.ico", "icon.ico");
  }
  return {
    verified: true, platform, arch: architecture, ...paths,
    package: { name: metadata.name, version: metadata.version, homepage: metadata.homepage },
    asarSha256: fileDigest(archive), update, icons, licenses: verifyNotices(paths.resources),
    scope: "Actual Electron payload metadata/resources; no installed UI workflow claimed by this inspection alone",
  };
}
