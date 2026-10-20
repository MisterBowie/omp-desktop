import assert from "node:assert/strict";
import test from "node:test";
import {classifyPublicationFailure} from "./classify-publication-failure.mjs";
test("publication diagnostics expose only enums, known feeds and numeric coordinates",()=>{
 const text="AssertionError [ERR_ASSERTION]: latest-mac-x64.yml: legacy path/hash mismatch\n at feed (file:///private/secret-value/prepare-github-release.mjs:37:5)\nexpected: private-token";
 assert.deepEqual(classifyPublicationFailure(text),{classes:["FEED_LEGACY","ASSERTION"],feeds:["latest-mac-x64.yml"],source:[{file:"prepare-github-release.mjs",line:37,column:5}]});
 assert(!JSON.stringify(classifyPublicationFailure(text)).includes("private"));
 assert.deepEqual(classifyPublicationFailure("unknown private-message"),{classes:["UNCLASSIFIED"],feeds:[],source:[]});
 assert.deepEqual(classifyPublicationFailure("gh: Resource not accessible by integration (HTTP 403) /private/token").classes,["API_FORBIDDEN"]);
});

test("missing memory fixture files expose only public names and source coordinates",()=>{
 const text="Error: ENOENT: PRIVATE_MESSAGE\n path: 'C:\\PRIVATE\\tokens.css'\n at read (file:///PRIVATE/e2e-memory-settings.mjs:55:9)\n path: '/PRIVATE/secret-file'";
 const result=classifyPublicationFailure(text);assert.deepEqual(result.missingFiles,["tokens.css","OTHER"]);assert.deepEqual(result.source,[{file:"e2e-memory-settings.mjs",line:55,column:9}]);assert.doesNotMatch(JSON.stringify(result),/PRIVATE|secret-file/);
});
