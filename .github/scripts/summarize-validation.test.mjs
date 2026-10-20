import assert from "node:assert/strict";
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";
import {summarizeValidation,summarizeStrictFailures,summarizeProcessCleanup} from "./summarize-validation.mjs";
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
test("process cleanup diagnostics retain roles and outcomes without executable paths or ids",()=>{
 const result=summarizeProcessCleanup({runRoot:"C:\\PRIVATE\\omp-installed-fixture",processReports:[
  {label:"PRIVATE_LABEL",processes:[{exe:"PRIVATE_VALUE"}]},
  {label:"cleanup-pinned-Windows-handles",result:{results:[{pid:1234,terminated:true,waitStatus:0,executable:"PRIVATE_VALUE"},{pid:4567,refusedOutsideRoot:true,openError:99999}]}},
  {label:"after-Windows-handle-reclaim",processes:[{pid:1234,exe:"C:\\PRIVATE\\omp-installed-fixture\\OMP Desktop.exe",state:"R",starttime:"123456"},{pid:4567,exe:"C:\\Windows\\System32\\conhost.exe",state:"R",starttime:"234567"},{exe:"C:\\PRIVATE\\secret.exe",state:"PRIVATE_STATE",starttime:"PRIVATE_BIRTH"}]},
 ]});
 assert.deepEqual(result,{lastSnapshot:"after-Windows-handle-reclaim",survivorCount:3,processes:[{image:"omp desktop.exe",state:"R",hasIdentity:true,executableUnderRunRoot:true,firstOwnership:"UNKNOWN",parentObserved:false,childPredatesParent:null},{image:"conhost.exe",state:"R",hasIdentity:true,executableUnderRunRoot:false,firstOwnership:"UNKNOWN",parentObserved:false,childPredatesParent:null},{image:"OTHER",state:"UNKNOWN",hasIdentity:false,executableUnderRunRoot:false,firstOwnership:"UNKNOWN",parentObserved:false,childPredatesParent:null}],controls:[[{terminated:true,refusedOutsideRoot:false,identityMismatch:false,openError:null,waitStatus:0},{terminated:false,refusedOutsideRoot:true,identityMismatch:false,openError:null,waitStatus:null}]]});
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|1234|4567|99999|System32|secret/);
});
test("failed TAP assertions expose coordinates and bounded values only",()=>{
 const tap=`# Subtest: private-title\nnot ok 5 - private-title\n  ---\n  failureType: 'testCodeFailure'\n  error: 'private-message'\n  code: 'ERR_ASSERTION'\n  expected: 'completed'\n  actual: 'running'\n  operator: 'strictEqual'\n  stack: |-\n    TestContext.<anonymous> (file:///private/secret/omp-plan-submit-e2e.test.mjs:941:12)\n  ...\n# Subtest: next-private\nnot ok 6 - next-private\n  ---\n  code: 'PRIVATE_CODE'\n  expected: 'private-value'\n  actual: false\n  stack: |-\n    TestContext.<anonymous> (file:///private/secret/omp-plan-submit-e2e.test.mjs:1064:14)\n  ...\n1..6\n`;
 assert.deepEqual(summarizeStrictFailures(tap),[{number:5,approvalInTimeline:false,noReportedErrors:false,source:[],diagnosticCodes:["ERR_ASSERTION"],failureType:"testCodeFailure",code:"ERR_ASSERTION",operator:"strictEqual",lines:[{line:941,column:12}],expected:"completed",actual:"running"},{number:6,approvalInTimeline:false,noReportedErrors:false,source:[],diagnosticCodes:[],lines:[{line:1064,column:14}],actual:false}]);
 assert(!JSON.stringify(summarizeStrictFailures(tap)).includes("private"));
 const nested=tap.replace("private-message","OMP_RESTORE_FAILED").replace("file:///private/secret/omp-plan-submit-e2e.test.mjs:941:12","file:///private/secret/omp-session.ts:1412:9");
 assert.deepEqual(summarizeStrictFailures(nested)[0].source,[{file:"omp-session.ts",line:1412,column:9}]);
 assert(summarizeStrictFailures(nested)[0].diagnosticCodes.includes("OMP_RESTORE_FAILED"));
});

test("process ancestry diagnostics detect a reused parent id without publishing identities",()=>{
 const root="C:/PRIVATE/omp-installed-fixture";
 const child={pid:1234,ppid:5678,exe:"C:/PRIVATE/foreign.exe",state:"R",starttime:"133000000000000001",ownership:"descendant"};
 const parent={pid:5678,ppid:1,exe:root+"/OMP Desktop.exe",state:"R",starttime:"133000000000000002",ownership:"root"};
 const result=summarizeProcessCleanup({runRoot:root,processReports:[{label:"before-ordered-quit",processes:[parent,child]},{label:"cleanup-before",processes:[{...child,ownership:"root"}]}]});
 assert.equal(result.processes[0].firstOwnership,"descendant");
 assert.equal(result.processes[0].parentObserved,true);
 assert.equal(result.processes[0].childPredatesParent,true);
 assert.doesNotMatch(JSON.stringify(result),/PRIVATE|1234|5678|133000/);
});

test("memory diagnostics reveal counts and source lines without saved memory content",t=>{
 const root=mkdtempSync(join(tmpdir(),"omp-memory-summary-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const dir=join(root,"validation-win32-x64",".artifacts","automatic-memory");mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,"native.tap"),"not ok 1 - PRIVATE_TITLE\n  ---\n  error: 'PRIVATE_MEMORY'\n  code: 'ENOENT'\n  stack: |-\n    file:///PRIVATE_PATH/omp-memory-native-e2e.test.mjs:92:8\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n");
 writeFileSync(join(dir,"ui.txt"),'MEMORY_SETTINGS_PROBE {"ok":true,"restart":true,"private":"PRIVATE_MEMORY"}\n');
 const [result]=summarizeValidation(root);assert.equal(result.memory.fail,1);assert.equal(result.memory.failures[0].code,"ENOENT");assert.deepEqual(result.memory.failures[0].lines,[{line:92,column:8}]);assert.deepEqual(result.memoryUi,{ok:true,restart:true});assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
});
