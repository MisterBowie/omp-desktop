import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, copyFileSync, realpathSync } from "node:fs";
import {createHash} from "node:crypto";
import {spawnSync} from "node:child_process";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";
import {parse,stringify} from "yaml";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stageReleaseInputs } from "./stage-release-inputs.mjs";
import {prepareGitHubRelease} from "./prepare-github-release.mjs";
const desktopRequire=createRequire(new URL("../apps/desktop/package.json",import.meta.url));
const builderRequire=createRequire(desktopRequire.resolve("electron-builder/package.json"));
const {writeUpdateInfoFiles}=builderRequire("app-builder-lib/out/publish/updateInfoBuilder");

function fixture(t) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "omp-release-staging-"))), source = join(root, "download"), out = join(root, "flat");
  mkdirSync(source); t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, bytes = name) => { const path = join(source, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, bytes); return path; };
  return { root, source, out, put, run: () => stageReleaseInputs(source, out, "0.1.0") };
}
test("preserves nested candidate bytes and includes Debian installers in the canonical checksum namespace", t => {
  const f = fixture(t); f.put("desktop/release/OMP-Desktop-0.1.0-x64.AppImage", "appimage");
  const deb = f.put("desktop/release/omp-desktop_0.1.0_amd64.deb", "deb");
  f.put("desktop/release/latest-linux.yml", stringify({version:"0.1.0",files:[]}));
  const files = f.run(); assert.equal(files.length, 3);
  assert.deepEqual(readFileSync(join(f.out, "OMP-Desktop-0.1.0-x64.deb")), readFileSync(deb));
  assert(files.every(file => /^[a-f0-9]{64}$/.test(file.sha256)));
});
async function linuxFixture(t,debFirst=false){
 const f=fixture(t),names=["OMP-Desktop-0.1.0-x64.AppImage","omp-desktop_0.1.0_amd64.deb","omp-desktop-0.1.0-x64.rpm"];
 if(debFirst)names.unshift(names.splice(1,1)[0]);
 const tasks=names.map(name=>{
  const bytes=Buffer.from("owned installer "+name);f.put("desktop/release/"+name,bytes);
  const sha512=createHash("sha512").update(bytes).digest("base64");
  return {file:join(f.source,"desktop/release/latest-linux.yml"),arch:1,publishConfiguration:{provider:"github",owner:"MisterBowie",repo:"omp-desktop"},info:{version:"0.1.0",files:[{url:name,sha512,size:bytes.length}],path:name,sha512}};
 });
 await writeUpdateInfoFiles(tasks,{emitArtifactCreated:async()=>{}});
 return f;
}
test("the real builder's mixed Linux feed follows Debian renaming without changing installer bytes or hashes",async t=>{
 for(const debFirst of [false,true]){
  const f=await linuxFixture(t,debFirst),original=readFileSync(join(f.source,"desktop/release/latest-linux.yml"),"utf8"),before=parse(original);
  assert.equal(before.files.length,3);f.run();
  const after=parse(readFileSync(join(f.out,"latest-linux.yml"),"utf8"));
  assert.equal(after.files.length,3);assert(after.files.some(file=>file.url==="OMP-Desktop-0.1.0-x64.deb"));
  assert.deepEqual(after.files.map(file=>file.sha512),before.files.map(file=>file.sha512));
  assert.deepEqual(readFileSync(join(f.out,"OMP-Desktop-0.1.0-x64.deb")),readFileSync(join(f.source,"desktop/release/omp-desktop_0.1.0_amd64.deb")));
  await prepareGitHubRelease({directory:f.out,version:"0.1.0",platforms:["linux"]});
 }
});
test("copied staging CLI resolves workspace YAML and retains hash and URL refusals",async t=>{
 const f=await linuxFixture(t),copy=join(f.root,"stage.mjs");copyFileSync(fileURLToPath(new URL("./stage-release-inputs.mjs",import.meta.url)),copy);
 const result=spawnSync(process.execPath,[copy,f.source,f.out,"0.1.0"],{cwd:fileURLToPath(new URL("..",import.meta.url)),encoding:"utf8"});assert.equal(result.status,0,result.stdout+result.stderr);
 const file=join(f.out,"latest-linux.yml"),feed=parse(readFileSync(file,"utf8"));
 const deb=feed.files.find(item=>item.url.endsWith(".deb"));assert(deb);deb.sha512="tampered";writeFileSync(file,stringify(feed));
 await assert.rejects(prepareGitHubRelease({directory:f.out,version:"0.1.0",platforms:["linux"]}),/SHA512 mismatch/);
 deb.url="https://example.invalid/OMP-Desktop-0.1.0-x64.deb";writeFileSync(file,stringify(feed));
 await assert.rejects(prepareGitHubRelease({directory:f.out,version:"0.1.0",platforms:["linux"]}),/unsafe or stale/);
});
test("refuses basename collisions before producing output", t => {
  const f = fixture(t); f.put("one/latest.yml"); f.put("two/latest.yml");
  assert.throws(f.run, /duplicate/); assert.equal(existsSync(f.out), false);
});

test("refuses retired Pi host archives before staging any output", t => {
  const f = fixture(t);
  f.put("pi-host/dist-bundle/pi-host-0.1.0-linux-x64.tar.gz", "retired fixture");
  assert.throws(f.run, /unexpected release input/);
  assert.equal(existsSync(f.out), false);
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
