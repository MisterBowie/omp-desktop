/** Preserve published dependency notices before the bundler prunes package trees. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOTICE_NAME = /^(licen[cs]es?|notices?|copying|copyright)(?:[._-].*)?$/i;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function frozenNpmIds(appRoot) {
  const lock = parseYaml(readFileSync(join(appRoot, "pnpm-lock.yaml"), "utf8"));
  if (String(lock.lockfileVersion) !== "9.0" || !lock.packages) {
    throw new Error("frozen Node dependency identities are unavailable");
  }
  return new Set(Object.entries(lock.packages).map(([key, pkg]) => {
    const name = key.match(/^(@[^/]+\/[^@]+|[^@]+)@/)?.[1];
    if (!name) throw new Error(`unrecognized locked package identity: ${key}`);
    const version = pkg.version ?? key.slice(name.length + 1).split("(")[0];
    if (!/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(String(version))) {
      throw new Error(`unrecognized locked package version: ${key}`);
    }
    return `${name}@${version}`;
  }));
}

function packageRoots(store) {
  const roots = [];
  for (const entry of readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const modules = join(store, entry.name, "node_modules");
    if (!existsSync(modules)) continue;
    for (const child of readdirSync(modules, { withFileTypes: true })) {
      if (!child.isDirectory()) continue; // Do not follow dependency symlinks.
      const path = join(modules, child.name);
      if (child.name.startsWith("@")) {
        for (const scoped of readdirSync(path, { withFileTypes: true })) {
          if (scoped.isDirectory()) roots.push(join(path, scoped.name));
        }
      } else roots.push(path);
    }
  }
  return roots;
}

function noticeFiles(root, id, extra = []) {
  const files = [];
  const packageRoot = realpathSync(root);
  function collect(name, depth = 0) {
    const path = realpathSync(isAbsolute(name) ? name : join(root, name));
    const child = relative(packageRoot, path);
    if (isAbsolute(child) || child.startsWith(`..${sep}`) || child === "..") {
      throw new Error(`notice leaves its published package: ${id}/${name}`);
    }
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (depth >= 3) throw new Error(`notice directory is too deep: ${id}/${name}`);
      for (const child of readdirSync(path).sort()) collect(join(name, child), depth + 1);
    } else if (stat.isFile()) {
      if (stat.size > 3 * 1024 * 1024 || files.length >= 512) {
        throw new Error(`notice exceeds collection bounds: ${id}/${name}`);
      }
      const relativeName = child.split(sep).join("/");
      if (!files.some((file) => file.name === relativeName)) {
        files.push({ name: relativeName, bytes: readFileSync(path) });
      }
    }
  }
  for (const name of readdirSync(root).sort()) if (NOTICE_NAME.test(name)) collect(name);
  for (const name of extra) collect(name);
  return files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function cargoDependencies(appRoot, target) {
  if (!existsSync(join(appRoot, "Cargo.lock"))) return []; // Minimal JS-only fixtures.
  const triple = {
    "darwin/arm64": "aarch64-apple-darwin", "darwin/x64": "x86_64-apple-darwin",
    "win32/x64": "x86_64-pc-windows-msvc", "linux/x64": "x86_64-unknown-linux-gnu",
  }[`${target.platform}/${target.arch}`];
  if (!triple) throw new Error("no Rust notice target for this release platform");
  const command = spawnSync("cargo", [
    "metadata", "--format-version", "1", "--locked", "--offline", "--filter-platform", triple,
  ], { cwd: appRoot, encoding: "utf8", timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  if (command.status !== 0) {
    throw new Error(`Rust notice metadata unavailable: ${command.error?.message ?? command.stderr?.trim()}`);
  }
  const metadata = JSON.parse(command.stdout);
  const host = metadata.packages.find((pkg) => pkg.name === "host-core");
  if (!host || !metadata.resolve) throw new Error("Rust host dependency graph is unavailable");
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const owned = new Set();
  const visit = (id) => {
    if (owned.has(id)) return;
    owned.add(id);
    for (const dependency of nodes.get(id)?.deps ?? []) visit(dependency.pkg);
  };
  visit(host.id);
  return metadata.packages.filter((pkg) => pkg.source && owned.has(pkg.id));
}

/** Synchronous because release-package's preflight/exit-code API is synchronous. */
export function writeDistributionNotices(appRoot = ROOT, target = { platform: process.platform, arch: process.arch }) {
  const packages = new Map();
  const locked = frozenNpmIds(appRoot);
  for (const root of packageRoots(join(appRoot, "node_modules", ".pnpm"))) {
    const manifestPath = join(root, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const id = `${manifest.name}@${manifest.version}`;
    if (!locked.has(id)) continue; // A stale cache is not part of this release.
    const files = noticeFiles(root, id);
    const existing = packages.get(id);
    if (existing) {
      const identity = (items) => items.map((file) => [file.name, sha256(file.bytes)]);
      if (JSON.stringify(identity(existing.files)) !== JSON.stringify(identity(files)) ||
          JSON.stringify([existing.license, existing.repository]) !==
            JSON.stringify([manifest.license ?? null, manifest.repository ?? null])) {
        throw new Error(`dependency variants disagree on notices: ${id}`);
      }
      continue;
    }
    packages.set(id, { id, license: manifest.license ?? null, repository: manifest.repository ?? null, files });
  }
  for (const crate of cargoDependencies(appRoot, target)) {
    const id = `cargo:${crate.name}@${crate.version}`;
    const files = noticeFiles(dirname(crate.manifest_path), id, crate.license_file ? [crate.license_file] : []);
    packages.set(id, { id, license: crate.license ?? null, repository: crate.repository ?? null, files });
  }
  if (packages.size === 0) throw new Error("installed dependency notices are unavailable");
  const chunks = [];
  let offset = 0;
  const append = (bytes) => { chunks.push(bytes); offset += bytes.length; };
  append(Buffer.from("OMP Desktop dependency notices\n\n" +
    "Published license/notice files from the frozen Node and Rust dependency trees.\n" +
    "Build dependencies are included; listing a component does not imply it is shipped.\n" +
    "Original notice bytes are retained. Components without a published top-level\n" +
    "notice retain their package license metadata and source repository below.\n\n"));
  const components = [];
  for (const component of [...packages.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    append(Buffer.from(`\n=== ${component.id} ===\nLicense metadata: ${JSON.stringify(component.license)}\nSource: ${JSON.stringify(component.repository)}\n`));
    const files = [];
    for (const file of component.files) {
      append(Buffer.from(`\n--- ${file.name} ---\n`));
      files.push({ name: file.name, offset, bytes: file.bytes.length, sha256: sha256(file.bytes) });
      append(file.bytes);
      append(Buffer.from("\n"));
    }
    components.push({ id: component.id, license: component.license, repository: component.repository, files });
  }
  if (offset > 64 * 1024 * 1024) throw new Error("dependency notice bundle exceeds 64 MiB");
  const notice = Buffer.concat(chunks);
  const inventory = {
    schema: "omp-desktop.dependency-notices/1",
    notice: { file: "THIRD-PARTY-NOTICES.txt", bytes: notice.length, sha256: sha256(notice) },
    components,
  };
  const out = join(appRoot, "apps", "desktop", "resources", "licenses-generated");
  mkdirSync(out, { recursive: true });
  for (const [name, bytes] of [
    [inventory.notice.file, notice],
    ["inventory.json", Buffer.from(JSON.stringify(inventory, null, 2) + "\n")],
  ]) {
    const temporary = join(out, `${name}.${process.pid}.tmp`);
    writeFileSync(temporary, bytes);
    renameSync(temporary, join(out, name));
  }
  return { components: components.length, files: components.reduce((sum, c) => sum + c.files.length, 0), bytes: notice.length };
}
