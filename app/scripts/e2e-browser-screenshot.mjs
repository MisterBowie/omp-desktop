#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { resolveElectronBinary, repositoryRoot } from "./e2e/boot.mjs";

const root = repositoryRoot();
const evidence = resolve(process.argv[2] ?? mkdtempSync(join(tmpdir(), "omp-browser-screenshot-")));
mkdirSync(evidence, { recursive: true });
const entry = join(evidence, "browser-screenshot.cjs");
await build({
  entryPoints: [join(root, "scripts/e2e/browser-screenshot.mjs")],
  outfile: entry,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
});
const binary = process.env.PI_BROWSER_SCREENSHOT_ELECTRON ?? resolveElectronBinary().electronBinary;
const env = { ...process.env, PI_BROWSER_SCREENSHOT_EVIDENCE: evidence };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(binary, [entry], { env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
child.stdout.on("data", (data) => { output += data; });
child.stderr.on("data", (data) => { output += data; });
const deadline = setTimeout(() => child.kill(), 45_000);
try {
  const [code, signal] = await once(child, "exit");
  assert.equal(code, 0, `native screenshot fixture failed (${signal ?? code}):\n${output}`);
  const report = JSON.parse(readFileSync(join(evidence, "report.json"), "utf8"));
  assert.equal(report.status, "passed");
  assert.equal(report.captures.length, 6);
  console.log(JSON.stringify({ ...report, evidence }, null, 2));
} finally {
  clearTimeout(deadline);
}
