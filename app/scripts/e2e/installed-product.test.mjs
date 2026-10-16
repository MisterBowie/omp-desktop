import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {executableArchitecture} from "./installed-product.mjs";

test("the actual native executable has Node's architecture name",()=>{
 assert.equal(executableArchitecture(process.execPath,process.platform),process.arch);
});
test("actual Intel and ARM Mach-O files use the release architecture names",{skip:process.platform!=="darwin"},t=>{
 const root=mkdtempSync(join(tmpdir(),"omp-native-architecture-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const source=join(root,"fixture.c");writeFileSync(source,"int fixture(void) { return 42; }\n");
 for(const [target,expected] of [["x86_64","x64"],["arm64","arm64"]]){
  const binary=join(root,target+".o");
  execFileSync("/usr/bin/clang",["-target",target+"-apple-macos13","-c",source,"-o",binary]);
  assert.equal(executableArchitecture(binary,"darwin"),expected);
 }
 const universal=join(root,"universal.o");execFileSync("/usr/bin/lipo",["-create",join(root,"x86_64.o"),join(root,"arm64.o"),"-output",universal]);
 assert(!["x64","arm64"].includes(executableArchitecture(universal,"darwin")),"a universal binary must not impersonate a single target");
});
