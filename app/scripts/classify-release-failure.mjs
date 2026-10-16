import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

/** Never return log text, paths, URLs, names or arbitrary captured strings. */
export function classifyReleaseFailure(input) {
  const text=String(input).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const known=[
    ["FORK_DIRTY", /source checkout has uncommitted changes/],
    ["FORK_ORIGIN_MISMATCH", /OMP-SIDECAR-FAIL source origin is/],
    ["FORK_COMMIT_MISMATCH", /OMP-SIDECAR-FAIL source HEAD is/],
    ["FORK_FILE_SET_MISMATCH", /OMP-SIDECAR-FAIL source differs from base/],
    ["FORK_SOURCE_MISSING", /source checkout does not exist|source does not look like the OMP checkout/],
    ["SIDECAR_BUILD_FAILED", /OMP-SIDECAR-FAIL sidecar build failed/],
    ["SIDECAR_VERSION_PROBE_FAILED", /built sidecar reported/],
    ["GATE_BUNDLE_FAILED", /tool gate bundle failed|tool gate still contains relative imports/],
    ["NOTICES_FAILED", /RELEASE-PACKAGE-FAIL dependency notices/],
    ["NOTICE_VARIANTS_DISAGREE", /dependency variants disagree on notices/],
    ["CARGO_METADATA_UNAVAILABLE", /Rust notice metadata unavailable/],
    ["NOTICE_ESCAPES_PACKAGE", /notice leaves its published package/],
    ["BUNDLER_MODULE_MISSING", /Could not resolve|Cannot find module|Cannot find package/],
    ["BUILDER_EXECUTION_FAILED", /ERR_ELECTRON_BUILDER_CANNOT_EXECUTE/],
    ["CERTIFICATE_IMPORT_FAILED", /SecKeychainItemImport|certificate.*import|Invalid CSC_LINK|Env CSC_LINK is not correct/],
    ["SIGNING_FAILED", /cannot find signing|No valid identity|code signing.*failed/],
    ["MISSING_FILE", /ENOENT|No such file or directory/],
    ["PERMISSION_DENIED", /EACCES|Permission denied/],
    ["TYPE_ERROR", /TypeError:/],
  ];
  const classes=known.filter(([,pattern])=>pattern.test(text)).map(([name])=>name);
  return {classes:classes.length?classes:["UNCLASSIFIED"],phase:{preflight:/RELEASE-PACKAGE [a-z0-9]+\/[a-z0-9]+: preflight/.test(text),notices:/RELEASE-PACKAGE: dependency notices/.test(text),builder:/RELEASE-PACKAGE [a-z0-9]+\/[a-z0-9]+: electron-builder/.test(text)}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let result;
 try {result=classifyReleaseFailure(readFileSync(process.argv[2],"utf8"));}
 catch {result={classes:["LOG_FILE_UNAVAILABLE"]};}
 console.log("::notice title=Safe native failure classification::"+JSON.stringify(result));
}
