import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chmodSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {parse} from "yaml";

const workflow=parse(readFileSync(new URL("../../.github/workflows/release.yml",import.meta.url),"utf8"));
const build=workflow.jobs.build.steps.find(step=>step.name==="Build all release installers").run;
const planner=new URL("./release-package.mjs",import.meta.url).href;
const matrix=workflow.jobs.build.strategy.matrix.include;

for(const target of [...matrix,...matrix.filter(target=>target.platform==="darwin").map(target=>({...target,signed:true}))]){
 test(`native release shell forwards a valid target for ${target.platform}/${target.arch}${target.signed?" signed":""}`,t=>{
  const root=mkdtempSync(join(tmpdir(),"omp-release-shell-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const pnpm=join(root,"pnpm");
  writeFileSync(pnpm,`#!${process.execPath}\nimport{planRelease}from${JSON.stringify(planner)};import assert from'node:assert/strict';const args=process.argv.slice(2);assert.deepEqual(args.slice(0,4),['--filter','@pi-desktop/desktop','run',${JSON.stringify(target.dist)}]);const plan=planRelease(['--platform',${JSON.stringify(target.platform)},'--publish','never',...args.slice(4)],${JSON.stringify({platform:target.platform,arch:target.arch})});console.log('RELEASE_ARGV_TEST:'+JSON.stringify(plan.target));process.exit(77);\n`);chmodSync(pnpm,0o755);
  // Stop at the successful pure plan. No package build or Apple request occurs.
  const script=build.replace(/\$\{\{\s*matrix\.(\w+)\s*\}\}/g,(_,key)=>target[key]);
  const result=spawnSync("bash",["-c",script],{encoding:"utf8",env:{...process.env,PATH:root+":"+dirname(process.execPath)+":"+process.env.PATH,RUNNER_TEMP:root,CSC_LINK:target.signed?"owned-fixture":"",APPLE_ID:"fixture@example.invalid",APPLE_APP_SPECIFIC_PASSWORD:"owned-fixture",APPLE_TEAM_ID:"ABCDE12345",MACOS_REQUIRE_SIGNING:"false"}});
  assert.equal(result.status,77,result.stdout+result.stderr);
  const line=/^RELEASE_ARGV_TEST:(.+)$/m.exec(result.stdout);assert(line,result.stdout);
  assert.deepEqual(JSON.parse(line[1]),{platform:target.platform,arch:target.arch});
 });
}
