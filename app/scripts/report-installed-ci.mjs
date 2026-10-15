#!/usr/bin/env node
/** Publish a bounded synthetic-run failure diagnosis as a public annotation. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.argv[2];
const path = join(root, "installed-smoke.json");
if (existsSync(path)) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const summary = { platform: report.platform, arch: report.arch, sourceRevision: report.sourceRevision, steps: report.workflow?.steps, failure: report.failure, cleanupFailure: report.cleanupFailure, cleaned: report.cleaned };
  if (report.failure || report.cleanupFailure) {
    const log = join(root, "application-output.txt");
    if (existsSync(log)) summary.applicationOutputTail = readFileSync(log, "utf8").slice(-5000);
    const text = JSON.stringify(summary).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
    console.log(`::error title=Native installed workflow::${text}`);
  } else console.log(JSON.stringify(summary));
} else {
  console.log("::error title=Native installed workflow::No installed acceptance report was produced; the native lane remains failed.");
}
