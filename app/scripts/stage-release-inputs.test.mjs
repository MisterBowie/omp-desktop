import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageReleaseInputs } from "./stage-release-inputs.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "omp-release-staging-")), source = join(root, "download"), out = join(root, "flat");
  mkdirSync(source); t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, bytes = name) => { const path = join(source, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, bytes); return path; };
  return { root, source, out, put, run: () => stageReleaseInputs(source, out, "0.1.0") };
}
test("preserves nested candidate bytes and includes Debian installers in the canonical checksum namespace", t => {
  const f = fixture(t); f.put("desktop/release/OMP-Desktop-0.1.0-x64.AppImage", "appimage");
  const deb = f.put("desktop/release/omp-desktop_0.1.0_amd64.deb", "deb");
  f.put("pi-host/dist-bundle/pi-host-0.1.0-linux-x64.tar.gz", "host");
  f.put("desktop/release/latest-linux.yml", "feed");
  const files = f.run(); assert.equal(files.length, 4);
  assert.deepEqual(readFileSync(join(f.out, "OMP-Desktop-0.1.0-x64.deb")), readFileSync(deb));
  assert.equal(readFileSync(join(f.out, "pi-host-0.1.0-linux-x64.tar.gz"), "utf8"), "host");
  assert(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
});
test("refuses basename collisions before producing output", t => {
  const f = fixture(t); f.put("one/latest.yml"); f.put("two/latest.yml");
  assert.throws(f.run, /duplicate/); assert.equal(existsSync(f.out), false);
});
test("refuses linked, stale, unknown or mixed prior staging inputs", t => {
  for (const kind of ["link", "stale", "unknown", "prior"]) {
    const f = fixture(t);
    if (kind === "link") { const p = f.put("one/OMP-Desktop-0.1.0-x64.zip"); symlinkSync(p, join(f.source, "linked.zip")); }
    if (kind === "stale") f.put("omp-desktop_0.15.3_amd64.deb");
    if (kind === "unknown") f.put("unrelated.txt");
    if (kind === "prior") { f.put("latest.yml"); mkdirSync(f.out); writeFileSync(join(f.out, "keep.txt"), "owned prior bytes"); }
    assert.throws(f.run);
    if (kind === "prior") assert.equal(readFileSync(join(f.out, "keep.txt"), "utf8"), "owned prior bytes");
  }
});
