#!/usr/bin/env node
/** Preserve a bounded native failure annotation without changing its exit code. */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
const directory = resolve(process.argv[2] ?? ".");
let summary;
try {
  const file = ["maintenance-smoke.json", "maintenance-upgrade.json"].map(name => join(directory, name)).find(existsSync);
  if (!file) throw new Error("native maintenance report missing");
  const report = JSON.parse(readFileSync(file, "utf8"));
  const status = report.failureState?.status?.status;
  summary = {
    complete: report.bootAndOrderedQuit === true && report.cleaned === true && !report.failure && !report.cleanupFailure,
    platform: report.platform, revision: report.sourceRevision, steps: report.workflow?.steps ?? report.steps,
    failure: report.failure, cleanupFailure: report.cleanupFailure, diagnosticFailure: report.failureDiagnosticError,
    status: status ? { isRunning: status.isRunning, activity: status.activity, turnId: status.turnId } : undefined,
    ui: report.failureState?.ui ? { activeSessionId: report.failureState.ui.activeSessionId, stop: report.failureState.ui.stop, permissionVisible: Boolean(report.failureState.ui.permission), tail: report.failureState.ui.text?.slice(-1200) } : undefined,
  };
} catch (error) { summary = { complete: false, reportError: String(error) }; }
const text = JSON.stringify(summary).slice(-8000);
if (summary.complete) console.log(text);
else console.log(`::error title=Native maintenance acceptance::${text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
