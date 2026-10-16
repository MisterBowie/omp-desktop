import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

const desktop=JSON.parse(readFileSync(new URL("../apps/desktop/package.json",import.meta.url)));

// Exercise pnpm's real selector and the host's package-script shell. Compilation
// is replaced only at the fixture package boundary; nothing is installed.
test("the native package shell builds every workspace dependency and excludes the app",t=>{
 const root=mkdtempSync(join(tmpdir(),"omp-workspace-build-"));
 t.after(()=>rmSync(root,{recursive:true,force:true}));
 writeFileSync(join(root,"package.json"),JSON.stringify({private:true,packageManager:"pnpm@10.34.5"}));
 writeFileSync(join(root,"pnpm-workspace.yaml"),"packages:\n  - packages/*\n");
 const names=Object.entries(desktop.devDependencies).filter(([,value])=>value.startsWith("workspace:" )).map(([name])=>name);
 function pkg(name,manifest){
  const directory=join(root,"packages",name.split("/").at(-1));mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,"package.json"),JSON.stringify({name,version:"1.0.0",...manifest}));
  return directory;
 }
 const command='node -e "require(\'fs\').writeFileSync(\'built\',\'yes\')"';
 for(const name of names)pkg(name,{scripts:{build:command}});
 const app=pkg(desktop.name,{devDependencies:Object.fromEntries(names.map(name=>[name,"workspace:*"])),scripts:{"build:deps":desktop.scripts["build:deps"],build:command}});
 const unrelated=pkg("unrelated-fixture",{scripts:{build:command}});
 const result=spawnSync("pnpm",["--filter",desktop.name,"run","build:deps"],{cwd:root,encoding:"utf8",shell:process.platform==="win32",timeout:60000,env:process.env});
 assert.equal(result.status,0,result.stdout+result.stderr+String(result.error??""));
 for(const name of names)assert(existsSync(join(root,"packages",name.split("/").at(-1),"built")),`missing build output for ${name}: ${result.stdout}`);
 assert(!existsSync(join(app,"built")),"the selector must exclude the desktop itself");
 assert(!existsSync(join(unrelated,"built")),"unrelated packages must not be built");
});
