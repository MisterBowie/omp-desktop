import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

/** The receipt is produced immediately beforehand by the strict candidate gate. */
export function shouldCancelValidatedRebuild(receipt,run,currentRunId){
 assert.equal(receipt.schema,"omp-desktop.accepted-release-candidate/1");
 assert.equal(receipt.version,"0.1.0");
 assert.equal(receipt.sourceRevision,"154bc03dfb619b5c219b5e3cf1e08ae1672bcec6");
 assert.equal(receipt.runId,38862126801);
 assert.equal(run.repository?.full_name,"MisterBowie/omp-desktop");
 assert.equal(run.path,".github/workflows/release.yml");
 assert.equal(run.event,"push");
 assert.equal(run.head_branch,"v"+receipt.version);
 assert.equal(run.head_sha,receipt.sourceRevision);
 assert(Number.isSafeInteger(run.id)&&run.id>receipt.runId);
 assert.notEqual(String(run.id),String(currentRunId));
 assert(["queued","in_progress","waiting","pending","requested","completed"].includes(run.status));
 return run.status!=="completed";
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [receiptPath,runPath]=process.argv.slice(2);
 const receipt=JSON.parse(readFileSync(receiptPath)),run=JSON.parse(readFileSync(runPath));
 console.log(shouldCancelValidatedRebuild(receipt,run,process.env.GITHUB_RUN_ID)?String(run.id):"none");
}
