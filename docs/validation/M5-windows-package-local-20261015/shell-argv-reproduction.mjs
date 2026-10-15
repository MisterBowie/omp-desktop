import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { shellQuote } from "../../../app/apps/desktop/test/helpers/omp-e2e-process.mjs";

const value = String.raw`C:\Users\runneradmin\AppData\Local\Temp\t20b2-mixed-project-123\control.txt`;
const capture = (command) => execFileSync("/bin/bash", ["--noprofile", "--norc", "-c", command], { encoding: "utf8" }).split("\0").filter(Boolean);
const unquoted = capture(`printf '%s\\0' ${value}`);
const quoted = capture(`printf '%s\\0' ${shellQuote(value)}`);
assert.notDeepEqual(unquoted, [value]);
assert.deepEqual(quoted, [value]);
console.log(JSON.stringify({ platform: process.platform, expected: value, unquoted, quoted, nativeWindowsProof: false }, null, 2));
