import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
export function classifyPublicationFailure(input){
 const text=String(input).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,"");
 const known=[
  ["FEED_SHA512",/SHA512 mismatch/],["FEED_SIZE",/size mismatch/],
  ["FEED_VERSION",/version mismatch/],["FEED_LEGACY",/legacy path\/hash mismatch/],
  ["FEED_MISSING_FILES",/missing files/],["FEED_MISSING_INSTALLER",/missing \.(?:zip|exe|AppImage) installer/],
  ["FEED_ARCHITECTURE",/wrong architecture/],["FEED_DUPLICATE",/duplicate Mac update artifact/],
  ["FEED_UNSAFE_URL",/unsafe or stale artifact URL/],["INSTALLER_NOT_REGULAR",/installer must be a regular file/],
  ["NSIS_REQUIRED",/NSIS installer required/],["PORTABLE_FEED",/portable package cannot drive NSIS updates/],
  ["HOST_SHA256",/remote-host SHA256 mismatch/],["STALE_ARTIFACT",/stale release artifact/],
  ["UNEXPECTED_ENTRY",/unexpected release entry/],["MISSING_FILE",/ENOENT/],
  ["ASSERTION",/ERR_ASSERTION/],["MODULE_MISSING",/ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/],
 ];
 const classes=known.filter(([,pattern])=>pattern.test(text)).map(([code])=>code);
 const feeds=["latest.yml","latest-linux.yml","latest-mac.yml","latest-mac-arm64.yml","latest-mac-x64.yml"].filter(name=>text.includes(name));
 const source=["prepare-github-release.mjs","stage-release-inputs.mjs"].flatMap(file=>[...text.matchAll(new RegExp(file.replaceAll(".","\\.")+":(\\d+):(\\d+)","g"))].map(match=>({file,line:Number(match[1]),column:Number(match[2])})));
 return {classes:classes.length?classes:["UNCLASSIFIED"],feeds,source};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 let result;try{result=classifyPublicationFailure(readFileSync(process.argv[2],"utf8"));}catch{result={classes:["LOG_FILE_UNAVAILABLE"]};}
 console.log("::notice title=Safe publication failure classification::"+JSON.stringify(result));
}
