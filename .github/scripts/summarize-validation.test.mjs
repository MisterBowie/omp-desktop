import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {summarizeValidation,summarizeStrictFailures} from "./summarize-validation.mjs";
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
test("failed TAP assertions expose coordinates and bounded values only",()=>{
 const tap=`# Subtest: private-title\nnot ok 5 - private-title\n  ---\n  failureType: 'testCodeFailure'\n  error: 'private-message'\n  code: 'ERR_ASSERTION'\n  expected: 'completed'\n  actual: 'running'\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///private/secret/omp-plan-submit-e2e.test.mjs:941:12)\n  ...\n# Subtest: next-private\nnot ok 6 - next-private\n  ---\n  code: 'PRIVATE_CODE'\n  expected: 'private-value'\n  actual: false\n  stack: |-\n    TestContext.<anonymous> (file:///private/secret/omp-plan-submit-e2e.test.mjs:1064:14)\n  ...\n1..6\n`;
 assert.deepEqual(summarizeStrictFailures(tap),[{number:5,approvalInTimeline:false,noReportedErrors:false,source:[],diagnosticCodes:["ERR_ASSERTION"],failureType:"testCodeFailure",code:"ERR_ASSERTION",operator:"strictEqual",lines:[{line:941,column:12}],expected:"completed",actual:"running"},{number:6,approvalInTimeline:false,noReportedErrors:false,source:[],diagnosticCodes:[],lines:[{line:1064,column:14}],actual:false}]);
 assert(!JSON.stringify(summarizeStrictFailures(tap)).includes("private"));
 const nested=tap.replace("private-message","OMP_RESTORE_FAILED").replace("file:///private/secret/omp-plan-submit-e2e.test.mjs:941:12","file:///private/secret/omp-session.ts:1412:9");
 assert.deepEqual(summarizeStrictFailures(nested)[0].source,[{file:"omp-session.ts",line:1412,column:9}]);
 assert(summarizeStrictFailures(nested)[0].diagnosticCodes.includes("OMP_RESTORE_FAILED"));
});
