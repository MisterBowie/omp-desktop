/**
 * Repair-6 probe (R13c): a spawn root recorded without a start time must never
 * be claimed by its number alone, and must never produce a signal plan.
 *
 * Mirrors the root's controlled-table reference: one unrelated pid 100 with no
 * argv/environment evidence of this run, passed as root `{ pid: 100 }` exactly
 * like `readProcessIdentity` failure produces. No OS signal is ever sent: the
 * plan is applied to a kill spy.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(
  Array.from({ length: (process.argv.length - 2) / 2 }, (_, i) => [process.argv[2 + i * 2], process.argv[3 + i * 2]]),
);
const { "--repo": repo, "--output": output } = args;
if (!repo || !output) throw new Error("usage: --repo <dir> --output <file>");

const { collectOwnedProcesses, planSignalTargets, signalProcessPlan } = await import(
  pathToFileURL(`${repo}/app/scripts/e2e/process-ownership.mjs`)
);

const row = (pid, ppid, pgid, starttime, argv, environ = []) => ({
  pid,
  ppid,
  pgid,
  starttime,
  argv,
  cmdline: argv.join(" "),
  comm: "fixture",
  environ,
});
const RUN_ROOT = "/tmp/omp-t20d-repair6-run";

const scenarios = [];
for (const [name, root] of [
  ["root-without-starttime", { pid: 100 }],
  ["root-with-null-starttime", { pid: 100, starttime: null }],
  ["root-with-empty-starttime", { pid: 100, starttime: "" }],
]) {
  const table = new Map([
    [3, row(3, 1, 3, "launcher-birth", ["python3", "wrapper.py", "--run-root", RUN_ROOT])],
    [7, row(7, 3, 7, "harness-birth", ["node", "e2e-omp-plan-ui.mjs"])],
    [100, row(100, 1, 100, "unrelated-new-birth", ["unrelated"])],
  ]);
  // Distinct table per scenario: environ caches are per-entry.
  const snapshot = collectOwnedProcesses({ table, selfPid: 7, roots: [root], runRoots: [RUN_ROOT] });
  const plan = planSignalTargets({ table, owned: snapshot.processes, selfPid: 7 });
  const sent = [];
  signalProcessPlan(plan, "SIGTERM", { kill: (target, signal) => sent.push({ target, signal }) });
  scenarios.push({
    name,
    root,
    expectedOwned: [],
    actualOwned: snapshot.processes.map((entry) => entry.pid),
    ignored: snapshot.ignored,
    plannedTargets: { groups: plan.groups, pids: plan.pids, mixedGroups: plan.mixedGroups },
    osSignalsSent: sent,
  });
}

const report = {
  layer: "actual helper with missing/empty spawn identity and a controlled table; signal plan applied to a kill spy only",
  helperPath: `${repo}/app/scripts/e2e/process-ownership.mjs`,
  helperSha256: createHash("sha256").update(readFileSync(`${repo}/app/scripts/e2e/process-ownership.mjs`)).digest("hex"),
  reproduced: scenarios.some((scenario) => scenario.actualOwned.length > 0 || scenario.plannedTargets.groups.length > 0),
  passed: scenarios.every(
    (scenario) =>
      scenario.actualOwned.length === 0 &&
      scenario.plannedTargets.groups.length === 0 &&
      scenario.plannedTargets.pids.length === 0 &&
      scenario.osSignalsSent.length === 0,
  ),
  scenarios,
};
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
process.exitCode = report.passed ? 0 : 1;
