import assert from "node:assert/strict";
import { exec, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { writeDistributionNotices } from "../../../scripts/distribution-notices.mjs";

const run = promisify(execFile);
const shell = promisify(exec);
const desktop = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("the real release host command prepares cold-cache notices without changing Cargo.lock", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "omp-cold-cargo 中文 space-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "app");
  const cwd = join(app, "apps", "desktop");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(app, "src"));
  mkdirSync(join(app, "node_modules", ".pnpm"), { recursive: true });
  writeFileSync(join(app, "pnpm-lock.yaml"), '{"lockfileVersion":"9.0","packages":{}}');
  writeFileSync(join(app, "Cargo.toml"), `[package]
name = "host-core"
version = "0.0.0"
edition = "2021"
[dependencies]
notice-normal = "=1.0.0"
[dev-dependencies]
notice-dev = "=1.0.0"
`);
  writeFileSync(join(app, "src", "main.rs"), 'fn main() { println!("{}", notice_normal::value()); }');
  const crates = new Map();
  for (const name of ["notice-normal", "notice-dev"]) {
    const directory = `${name}-1.0.0`;
    const source = join(root, directory);
    mkdirSync(join(source, "src"), { recursive: true });
    writeFileSync(join(source, "Cargo.toml"), `[package]\nname = "${name}"\nversion = "1.0.0"\nedition = "2021"\nlicense-file = "LICENSE"\n`);
    writeFileSync(join(source, "src", "lib.rs"), "pub fn value() -> u8 { 42 }");
    const license = Buffer.from(`Original ${name} license\r\nCopyright fixture authors\n`);
    writeFileSync(join(source, "LICENSE"), license);
    const archive = join(root, `${directory}.crate`);
    await run("tar", ["-czf", archive, "-C", root, directory], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    const bytes = readFileSync(archive);
    crates.set(name, { bytes, license, checksum: hash(bytes), downloads: 0 });
  }
  let base;
  const server = createServer((request, response) => {
    const path = request.url;
    if (path === "/config.json") {
      response.end(JSON.stringify({ dl: `${base}/api/v1/crates/{crate}/{version}/download` }));
      return;
    }
    for (const [name, crate] of crates) {
      if (path === `/${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`) {
        response.end(JSON.stringify({ name, vers: "1.0.0", deps: [], cksum: crate.checksum, features: {}, yanked: false }) + "\n");
        return;
      }
      if (path === `/api/v1/crates/${name}/1.0.0/download`) {
        crate.downloads++;
        response.end(crate.bytes);
        return;
      }
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  base = `http://127.0.0.1:${server.address().port}`;
  const cargoHome = join(root, "cold-cargo-home");
  mkdirSync(cargoHome);
  writeFileSync(join(cargoHome, "config.toml"), `[source.crates-io]\nreplace-with = "fixture"\n[source.fixture]\nregistry = "sparse+${base}/"\n`);
  const env = { ...process.env, CARGO_HOME: cargoHome, CARGO_TARGET_DIR: join(root, "target") };
  await run("cargo", ["generate-lockfile"], { cwd: app, env });
  const locked = readFileSync(join(app, "Cargo.lock"));
  await run("cargo", ["build", "--release", "--locked", "-p", "host-core"], { cwd: app, env });
  assert.equal(crates.get("notice-normal").downloads, 1);
  assert.equal(crates.get("notice-dev").downloads, 0, "release build must reproduce the missing dev-source cache");
  const previous = process.env.CARGO_HOME;
  process.env.CARGO_HOME = cargoHome;
  t.after(() => { if (previous === undefined) delete process.env.CARGO_HOME; else process.env.CARGO_HOME = previous; });
  assert.throws(() => writeDistributionNotices(app), /Rust notice metadata unavailable:.*(?:failed to download|no matching package)/s);
  // Execute the shipped command, from the same apps/desktop layout. The HTTP
  // fixture is the only external boundary; Cargo and notice collection are real.
  await shell(desktop.scripts["build:host-release"], { cwd, env });
  const result = writeDistributionNotices(app);
  assert.equal(result.components, 2);
  assert.equal(crates.get("notice-dev").downloads, 1);
  assert.deepEqual(readFileSync(join(app, "Cargo.lock")), locked);
  const out = join(cwd, "resources", "licenses-generated");
  const inventory = JSON.parse(readFileSync(join(out, "inventory.json"), "utf8"));
  const body = readFileSync(join(out, inventory.notice.file));
  for (const [name, crate] of crates) {
    const item = inventory.components.find((component) => component.id === `cargo:${name}@1.0.0`);
    const file = item.files.find((entry) => entry.name === "LICENSE");
    assert.deepEqual(body.subarray(file.offset, file.offset + file.bytes), crate.license);
    assert.equal(file.sha256, hash(crate.license));
  }
});
