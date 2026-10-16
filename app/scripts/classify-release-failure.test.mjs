import assert from "node:assert/strict";
import test from "node:test";
import {classifyReleaseFailure} from "./classify-release-failure.mjs";
test("classifies known failures without returning any private log strings",()=>{
 const secret="private-token-should-never-appear",path="/private/internal/project/secret";
 const result=classifyReleaseFailure(`RELEASE-PACKAGE darwin/arm64: preflight\nOMP-SIDECAR-FAIL source checkout has uncommitted changes ${path}\napi_key=${secret}`);
 assert.deepEqual(result.classes,["FORK_DIRTY"]);assert.equal(result.phase.preflight,true);
 const output=JSON.stringify(result);assert(!output.includes(secret));assert(!output.includes(path));assert(!output.includes("api_key"));
});
test("unknown failures disclose only a fixed enum and phase booleans",()=>{
 const result=classifyReleaseFailure("confidential-hostname confidential-user private text");
 assert.deepEqual(result,{classes:["UNCLASSIFIED"],phase:{preflight:false,notices:false,builder:false}});
});
test("module and missing-file categories disclose no captured path or dependency name",()=>{
 const input="Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'yaml' imported from /private/secret\nError: ENOENT: no such file or directory, open 'C:\\private\\OMP Desktop.exe'";
 const result=classifyReleaseFailure(input);
 assert.deepEqual(result.classes,["BUNDLER_MODULE_MISSING","NODE_ESM_MODULE_MISSING","MISSING_FILE"]);
 assert(!JSON.stringify(result).includes("private"));
 assert(!JSON.stringify(result).includes("yaml"));
});
test("file failures never disclose public or private dependency names",()=>{
 const result=classifyReleaseFailure("ENOENT: open '/private/secret/node_modules/semver/index.js'\nENOENT: open '/private/secret/node_modules/private-secret-package/index.js'");
 assert.deepEqual(result.classes,["MISSING_FILE"]);assert.equal(result.publicDependencyClasses,undefined);
 const output=JSON.stringify(result);assert(!output.includes("/private"));assert(!output.includes("private-secret-package"));assert(!output.includes("semver"));
});
test("a release classification excludes setup and post-job cleanup failures",()=>{
 const result=classifyReleaseFailure("ENOENT open '/private/node_modules/semver/index.js'\n> @pi-desktop/desktop@0.1.0 dist:mac /private/app\nRELEASE-PACKAGE darwin/arm64: preflight\ncertificate target not a file\n##[error]Process completed with exit code 1.\nENOENT open '/private/node_modules/pnpm/bin/pnpm.cjs'");
 assert.deepEqual(result.classes,["NOT_A_REGULAR_FILE"]);
 assert.equal(result.publicDependencyClasses,undefined);
});
