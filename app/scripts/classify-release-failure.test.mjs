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
