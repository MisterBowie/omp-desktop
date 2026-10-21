import assert from "node:assert/strict";
import test from "node:test";
import {execFileSync} from "node:child_process";
import {mkdirSync,mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import { canReuseSourceVerification, trackedProductChanges, VERIFIED_SOURCE } from "./reuse-source-verification.mjs";
function fixture() {
  return { run: { repository:{full_name:"MisterBowie/omp-desktop"},head_sha:VERIFIED_SOURCE,path:".github/workflows/release.yml",conclusion:"failure" }, jobs:[{name:"verify",conclusion:"success",steps:["Require the stable version and its release notes","Run pnpm build:js","Run pnpm --filter @pi-desktop/desktop typecheck","Run pnpm lint","Run pnpm -r --if-present test","Run cargo test -p host-core --locked"].map(name=>({name,conclusion:"success"}))}], changedPaths:["app/docs/spec/06-delivery/06-release-runbook.md","app/scripts/stage-release-inputs.mjs"] };
}
test("source checks remain reusable after an independent native packaging failure",()=>{assert.equal(canReuseSourceVerification(fixture()),true);});
test("any runtime, lockfile, build entry, version or fixed submodule change requires full source checks",()=>{
 for(const path of ["app/packages/shared/src/protocol.ts","app/pnpm-lock.yaml","app/scripts/release-package.mjs","app/package.json","upstream/oh-my-pi",".gitmodules","app/apps/desktop/electron/main/updater.ts","app/docs-escape/source.ts"]){const f=fixture();f.changedPaths.push(path);assert.equal(canReuseSourceVerification(f),false,path);}
});
test("failed, missing or skipped source gates are never reused",()=>{
 const f=fixture();f.jobs[0].steps[4].conclusion="skipped";assert.equal(canReuseSourceVerification(f),false);f.jobs=[];assert.equal(canReuseSourceVerification(f),false);
});
test("a different repository or source revision cannot supply a verification receipt",()=>{
 const f=fixture();f.run.head_sha="b".repeat(40);assert.equal(canReuseSourceVerification(f),false);f.run.head_sha=VERIFIED_SOURCE;f.run.repository.full_name="other/repo";assert.equal(canReuseSourceVerification(f),false);
});
test("running from app still compares product paths at the repository root",t=>{
 const root=mkdtempSync(join(tmpdir(),"omp-source-identity-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const git=(...args)=>execFileSync("git",["-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false",...args],{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
 git("init","--initial-branch=main");git("config","user.name","Fixture");git("config","user.email","fixture@example.invalid");mkdirSync(join(root,"app/packages"),{recursive:true});
 writeFileSync(join(root,"app/packages/runtime.ts"),"export const value=1;\n");git("add","--","app/packages/runtime.ts");git("commit","-m","fixture baseline");const base=git("rev-parse","HEAD");
 writeFileSync(join(root,"app/packages/runtime.ts"),"export const value=2;\n");git("add","--","app/packages/runtime.ts");git("commit","-m","fixture runtime change");
 assert.deepEqual(trackedProductChanges(base,join(root,"app")),["app/packages/runtime.ts"]);
 const f=fixture();f.changedPaths=trackedProductChanges(base,join(root,"app"));assert.equal(canReuseSourceVerification(f),false);
});

test("native memory fixture changes reuse source checks while all native acceptance gates rerun",()=>{
 const f=fixture();f.changedPaths.push("app/apps/desktop/test/omp-memory-native-e2e.test.mjs");
 assert.equal(canReuseSourceVerification(f),true);
 f.changedPaths.push("app/apps/desktop/electron/main/runtime/omp-memory.ts");
 assert.equal(canReuseSourceVerification(f),false);
});
