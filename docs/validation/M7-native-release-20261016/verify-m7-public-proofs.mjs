import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PLATFORM_PAYLOADS} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/stage-test-package.mjs';
import {verifyInstalledEvidence} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/installed-acceptance-record.mjs';
import {verifyMaintenanceEvidence} from '/Users/vv/Documents/对话/omp-desktop-local-m7/app/scripts/maintenance-acceptance-record.mjs';
const root=fileURLToPath(new URL('.',import.meta.url));
const meta=JSON.parse(readFileSync(join(root,'m7-native-dispatch.json')));
const download=process.argv[2]??join(root,'release-download');
const record=JSON.parse(readFileSync(join(download,'BUILD-RECORD.json')));
assert.equal(record.revision,meta.candidate);assert.equal(record.tag,meta.tag);
assert.equal(record.platforms.length,3);
const proofs=[];
for(const platform of record.platforms){
 const staged={...platform,assets:platform.assets.map(asset=>{const target=PLATFORM_PAYLOADS[platform.platform].targets.find(target=>target.kind===asset.kind);return target?{...asset,sourceName:target.source(record.version,platform.arch)}:asset})};
 verifyInstalledEvidence(download,staged,{version:record.version,revision:meta.candidate});
 verifyMaintenanceEvidence(download,staged,{version:record.version,revision:meta.candidate});
 proofs.push({platform:platform.platform,arch:platform.arch,installed:platform.installedWorkflow,maintenance:platform.maintenanceWorkflow});
}
writeFileSync(join(root,process.argv[3]??'m7-public-proofs-reopened.json'),JSON.stringify({candidate:meta.candidate,tag:meta.tag,verified:true,proofs},null,2)+'\n');
console.log('All three downloaded public native installed and maintenance proofs reopened and verified against the production acceptance contract.');
