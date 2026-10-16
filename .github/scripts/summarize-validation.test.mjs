import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {summarizeValidation} from "./summarize-validation.mjs";
test("summaries expose fixed fields without private report strings",t=>{
 const root=mkdtempSync(join(tmpdir(),"omp-validation-summary-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dir=join(root,"validation-win32-x64");mkdirSync(dir);
 writeFileSync(join(dir,"installed-smoke.json"),JSON.stringify({failure:"Timed out: Composer Send enabled /private/token secret-value",cleaned:true}));
 writeFileSync(join(dir,"workflow-facts.json"),JSON.stringify({checks:["secret-value"],steps:{project:true,privateKey:"secret-value"}}));
 writeFileSync(join(dir,"progress.json"),JSON.stringify({label:"secret-value"}));
 writeFileSync(join(dir,"packaged-plan-goal.tap"),"# tests 15\n# pass 15\n# fail 0\n# skipped 0\n");
 const [summary]=summarizeValidation(root);assert.deepEqual(summary.errorClasses,["TIMEOUT","SEND_TIMEOUT"]);assert.equal(summary.completedChecks,1);assert.equal(summary.progress,"UNKNOWN");assert.equal(summary.strict.pass,15);
 const output=JSON.stringify(summary);for(const text of ["secret-value","/private","privateKey"])assert(!output.includes(text));
});
