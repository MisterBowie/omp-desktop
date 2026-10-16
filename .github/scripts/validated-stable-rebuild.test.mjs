import assert from "node:assert/strict";
import test from "node:test";
import {shouldCancelValidatedRebuild} from "./validated-stable-rebuild.mjs";
const receipt={schema:"omp-desktop.accepted-release-candidate/1",version:"0.1.0",sourceRevision:"154bc03dfb619b5c219b5e3cf1e08ae1672bcec6",runId:38862126801};
const run={id:38870000000,repository:{full_name:"MisterBowie/omp-desktop"},path:".github/workflows/release.yml",event:"push",head_branch:"v0.1.0",head_sha:receipt.sourceRevision,status:"in_progress"};
test("only the selected same-source stable rebuild is redundant",()=>{
 assert(shouldCancelValidatedRebuild(receipt,run,38870000001));
 assert.equal(shouldCancelValidatedRebuild(receipt,{...run,status:"completed"},38870000001),false);
});
test("foreign, different-source, candidate and control jobs cannot be cancelled",()=>{
 for(const patch of [{repository:{full_name:"other/repo"}},{path:".github/workflows/release-publish.yml"},{event:"workflow_dispatch"},{head_branch:"release-check-0.1.0-154bc03"},{head_sha:"b".repeat(40)},{id:receipt.runId},{id:38870000001},{status:"unknown"}])assert.throws(()=>shouldCancelValidatedRebuild(receipt,{...run,...patch},38870000001));
 assert.throws(()=>shouldCancelValidatedRebuild({...receipt,sourceRevision:"b".repeat(40)},run,38870000001));
});
