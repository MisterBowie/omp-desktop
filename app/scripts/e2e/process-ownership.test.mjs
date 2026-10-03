/**
 * Regression tests for M5/T20-D R13: the UI harness must reclaim only the
 * processes it really owns and must never signal its launcher, an ancestor, or
 * an unrelated process that merely references the same shared source tree.
 *
 * The ownership and signaling decisions run against controlled process tables
 * with a kill spy, and the last three tests drive real sentinel processes
 * (spawned here, never any other user process): a detached group that must be
 * reclaimed, a reparented "detached runtime" that is attributable only by the
 * run's scratch root, and a mixed group where the unrelated member must
 * survive a member-only signal.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  ancestorPids,
  argvIdentifiesRun,
  collectOwnedProcesses,
  environmentIdentifiesRun,
  pathBoundaryMatches,
  planSignalTargets,
  processEnvironment,
  readProcessTable,
  sameProcess,
  signalProcessPlan,
} from "./process-ownership.mjs";

/** The shared patched tree from the archived review runs: never an identity. */
const SHARED_TREE = "/tmp/omp-patched-t20d-ui-repair1";
const RUN_ROOT = "/tmp/omp-plan-ui-100-run";

function entryOf({ pid, ppid = 1, pgid = pid, comm = "node", starttime = "100", argv = [], environ = [] }) {
  return {
    pid,
    ppid,
    pgid,
    comm,
    state: "S",
    starttime: String(starttime),
    argv,
    cmdline: argv.join(" "),
    environ,
  };
}

function tableOf(...entries) {
  return new Map(entries.map((entry) => [entry.pid, entry]));
}

function killSpy({ fail = {} } = {}) {
  const calls = [];
  const kill = (target, signal) => {
    calls.push({ target, signal });
    const error = fail[target];
    if (error) throw error;
  };
  kill.calls = calls;
  return kill;
}

/* --------------------------------------------------------------------- */
/* Ownership                                                              */
/* --------------------------------------------------------------------- */

test("the archived misclassification: a launcher that names the shared tree is not owned", () => {
  // Shape of the two real review runs: the Python verifier spawns the node
  // harness (this process), which spawns the Electron root. The verifier's
  // argv carries `--patched-tree <shared tree>`; it must stay out of the
  // owned set (and so must every ancestor).
  const table = tableOf(
    entryOf({ pid: 1946963, comm: "ssh", starttime: "1" }),
    entryOf({
      pid: 2279095,
      ppid: 1946963,
      comm: "python3",
      starttime: "2",
      argv: ["python3", "/tmp/omp-root-ui-review-80ce94ac.py", "--candidate", "80ce94ac", "--patched-tree", SHARED_TREE],
      environ: ["HOME=/tmp/omp-t20-d-ui-root-review-80ce94ac/home"],
    }),
    entryOf({
      pid: 2279124,
      ppid: 2279095,
      comm: "node",
      starttime: "3",
      argv: ["node", "scripts/e2e-omp-plan-ui.mjs"],
      environ: [`TMPDIR=/tmp/omp-t20-d-ui-root-review-80ce94ac/tmp`, `PI_DESKTOP_E2E_PATCHED_TREE=${SHARED_TREE}`],
    }),
    entryOf({
      pid: 2279151,
      ppid: 2279124,
      pgid: 2279151,
      comm: "electron",
      starttime: "4",
      argv: ["electron", `--user-data-dir=${RUN_ROOT}/profile`, "."],
      environ: [`HOME=${RUN_ROOT}/home`],
    }),
    entryOf({
      pid: 2279174,
      ppid: 1,
      pgid: 2279173,
      comm: "chrome_crashpad",
      starttime: "5",
      argv: ["chrome_crashpad_handler", `--database=${RUN_ROOT}/data/crash-dumps`],
      environ: [`HOME=${RUN_ROOT}/home`],
    }),
    entryOf({
      pid: 2279190,
      ppid: 1,
      comm: "node",
      starttime: "6",
      argv: ["node", `${SHARED_TREE}/packages/coding-agent/scripts/omp`, "--version"],
      environ: ["HOME=/home/vv"],
    }),
  );
  const snapshot = collectOwnedProcesses({
    table,
    selfPid: 2279124,
    roots: [{ pid: 2279151, starttime: "4" }],
    runRoots: [RUN_ROOT],
  });
  assert.equal(snapshot.supported, true);
  const pids = snapshot.processes.map((entry) => entry.pid);
  assert.deepEqual(pids, [2279151, 2279174]);
  assert.ok(!pids.includes(2279095), "the launcher must never be owned");
  assert.ok(!pids.includes(2279124), "the harness itself must never be owned");
  assert.ok(!pids.includes(2279190), "a shared-tree user must never be owned");
  assert.equal(snapshot.processes.find((entry) => entry.pid === 2279151).ownership, "root");
  assert.equal(snapshot.processes.find((entry) => entry.pid === 2279174).ownership, "argv-run-root");
  assert.deepEqual(
    snapshot.protectedAncestors.map((entry) => entry.pid),
    [2279095, 1946963],
  );
});

test("an ancestor stays excluded even when it carries the run root, and its children are not adopted", () => {
  const table = tableOf(
    entryOf({ pid: 50, ppid: 1, pgid: 40, comm: "python3", starttime: "1", argv: ["python3", "/tmp/wrapper.py", RUN_ROOT] }),
    entryOf({ pid: 100, ppid: 50, pgid: 100, comm: "node", starttime: "2", argv: ["node", "harness.mjs"] }),
    entryOf({ pid: 200, ppid: 100, pgid: 200, comm: "electron", starttime: "3", argv: ["electron", "."] }),
    entryOf({ pid: 201, ppid: 200, pgid: 200, comm: "electron", starttime: "4", argv: ["electron", "--type=renderer"] }),
    entryOf({ pid: 300, ppid: 50, comm: "sleep", starttime: "5", argv: ["sleep", "600"] }),
  );
  const snapshot = collectOwnedProcesses({
    table,
    selfPid: 100,
    roots: [{ pid: 200, starttime: "3" }],
    runRoots: [RUN_ROOT],
  });
  assert.deepEqual(
    snapshot.processes.map((entry) => entry.pid),
    [200, 201],
  );
  assert.ok(
    snapshot.ignored.some((item) => item.pid === 50 && item.reason === "ancestor-run-root"),
    `the launcher must be recorded as an excluded ancestor: ${JSON.stringify(snapshot.ignored)}`,
  );
  assert.ok(!snapshot.processes.some((entry) => entry.pid === 300), "a sibling of the launcher is not ours");
  assert.deepEqual(
    ancestorPids(table, 100),
    [50],
  );
});

test("a recycled root pid contributes nothing, not even its children", () => {
  const table = tableOf(
    entryOf({ pid: 100, comm: "node", starttime: "9" }),
    entryOf({ pid: 200, comm: "electron", starttime: "2", argv: ["electron", RUN_ROOT] }),
    entryOf({ pid: 201, ppid: 200, comm: "electron", starttime: "3" }),
  );
  const snapshot = collectOwnedProcesses({
    table,
    selfPid: 100,
    roots: [{ pid: 200, starttime: "1" }],
    runRoots: [],
  });
  assert.deepEqual(snapshot.processes, []);
  assert.ok(snapshot.ignored.some((item) => item.pid === 200 && item.reason === "root-reused"));
});

test("path identity is matched on element boundaries, never as a substring", () => {
  assert.equal(pathBoundaryMatches("/tmp/run", ["/tmp/run"]), true);
  assert.equal(pathBoundaryMatches("/tmp/run/data/x.yml", ["/tmp/run"]), true);
  assert.equal(pathBoundaryMatches("/tmp/run/", ["/tmp/run"]), true);
  assert.equal(pathBoundaryMatches("/tmp/run-2/data", ["/tmp/run"]), false);
  assert.equal(pathBoundaryMatches("/tmp/runner", ["/tmp/run"]), false);
  assert.equal(pathBoundaryMatches("/tmp/run", ["/"]), false);
  assert.equal(argvIdentifiesRun(["bun", "--session-dir", "/tmp/run/data/omp-sessions"], ["/tmp/run"]), true);
  assert.equal(argvIdentifiesRun(["electron", "--user-data-dir=/tmp/run/profile"], ["/tmp/run"]), true);
  assert.equal(argvIdentifiesRun(["bun", "--session-dir", "/tmp/run-2/data"], ["/tmp/run"]), false);
  assert.equal(argvIdentifiesRun(["--patched-tree", SHARED_TREE], [RUN_ROOT]), false);
  assert.equal(environmentIdentifiesRun([`HOME=${RUN_ROOT}/home`], [RUN_ROOT]), true);
  assert.equal(environmentIdentifiesRun([`TMPDIR=${RUN_ROOT}-other/tmp`], [RUN_ROOT]), false);
  assert.equal(environmentIdentifiesRun([`PI_DESKTOP_E2E_PATCHED_TREE=${SHARED_TREE}`], [RUN_ROOT]), false);
});

test("a reparented process is attributed by its run root in the environment", () => {
  const table = tableOf(
    entryOf({ pid: 100, comm: "node", starttime: "9" }),
    entryOf({
      pid: 400,
      ppid: 1,
      pgid: 400,
      comm: "omp",
      starttime: "10",
      argv: ["bun", "--preload", `${SHARED_TREE}/packages/coding-agent/scripts/omp.ts`],
      environ: [`HOME=${RUN_ROOT}/home`, `TMPDIR=${RUN_ROOT}/tmp`],
    }),
  );
  const snapshot = collectOwnedProcesses({ table, selfPid: 100, roots: [], runRoots: [RUN_ROOT] });
  assert.deepEqual(
    snapshot.processes.map((entry) => [entry.pid, entry.ownership]),
    [[400, "environ-run-root"]],
  );
});

test("an unsupported process table reports itself as unsupported", () => {
  assert.deepEqual(collectOwnedProcesses({ table: new Map(), selfPid: 1, roots: [], runRoots: [] }), {
    supported: false,
    processes: [],
    protectedAncestors: [],
    ignored: [],
  });
});

/* --------------------------------------------------------------------- */
/* Signal plans                                                           */
/* --------------------------------------------------------------------- */

test("a pure-owned group is signaled as a group", () => {
  const table = tableOf(
    entryOf({ pid: 100, comm: "node", starttime: "1" }),
    entryOf({ pid: 200, comm: "electron", starttime: "2", pgid: 200 }),
    entryOf({ pid: 201, ppid: 200, comm: "electron", starttime: "3", pgid: 200 }),
    entryOf({ pid: 300, ppid: 201, comm: "omp", starttime: "4", pgid: 300 }),
    entryOf({ pid: 301, ppid: 300, comm: "sleep", starttime: "5", pgid: 300 }),
  );
  const plan = planSignalTargets({ table, owned: [...table.values()].filter((e) => e.pid !== 100), selfPid: 100 });
  assert.deepEqual(plan.groups, [200, 300]);
  assert.deepEqual(plan.pids, []);
  assert.deepEqual(plan.mixedGroups, []);
  assert.deepEqual(plan.stale, []);
});

test("a narrowed stage targets one group but still judges purity over the whole owned set", () => {
  const table = tableOf(
    entryOf({ pid: 100, comm: "node", starttime: "1" }),
    entryOf({ pid: 200, comm: "electron", starttime: "2", pgid: 200 }),
    entryOf({ pid: 201, ppid: 200, comm: "electron", starttime: "3", pgid: 200 }),
    entryOf({ pid: 300, ppid: 200, comm: "omp", starttime: "4", pgid: 300 }),
    entryOf({ pid: 400, ppid: 1, comm: "chrome_crashpad", starttime: "5", pgid: 400 }),
  );
  const owned = [table.get(200), table.get(201), table.get(300), table.get(400)];
  const stage = planSignalTargets({ table, owned, selfPid: 100, onlyGroups: [200] });
  assert.deepEqual(stage.groups, [200], "the Electron group is pure-owned and signaled as a group");
  assert.deepEqual(stage.pids, [], "detached survivors wait for the escalation stage");
  assert.deepEqual(stage.mixedGroups, []);

  // The same narrowing with a real foreign member must not promote the group.
  const mixedTable = tableOf(
    entryOf({ pid: 100, comm: "node", starttime: "1" }),
    entryOf({ pid: 200, comm: "electron", starttime: "2", pgid: 200 }),
    entryOf({ pid: 201, ppid: 200, comm: "electron", starttime: "3", pgid: 200 }),
    entryOf({ pid: 202, ppid: 1, comm: "sleep", starttime: "4", pgid: 200 }),
  );
  const mixedStage = planSignalTargets({
    table: mixedTable,
    owned: [mixedTable.get(200), mixedTable.get(201)],
    selfPid: 100,
    onlyGroups: [200],
  });
  assert.deepEqual(mixedStage.groups, []);
  assert.deepEqual(mixedStage.pids, [200, 201]);
  assert.deepEqual(mixedStage.mixedGroups, [{ pgid: 200, ownedPids: [200, 201], foreignPids: [202] }]);
});

test("a mixed group never escalates to the whole group", () => {
  const table = tableOf(
    entryOf({ pid: 100, comm: "node", starttime: "1" }),
    entryOf({ pid: 200, comm: "omp", starttime: "2", pgid: 200 }),
    entryOf({ pid: 201, ppid: 1, comm: "sleep", starttime: "3", pgid: 200 }),
  );
  const plan = planSignalTargets({ table, owned: [table.get(200)], selfPid: 100 });
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.pids, [200]);
  assert.deepEqual(plan.mixedGroups, [{ pgid: 200, ownedPids: [200], foreignPids: [201] }]);
});

test("our own group, an ancestor's group and excluded groups are never group targets", () => {
  const table = tableOf(
    entryOf({ pid: 50, ppid: 1, pgid: 50, comm: "python3", starttime: "1" }),
    entryOf({ pid: 100, ppid: 50, pgid: 100, comm: "node", starttime: "2" }),
    entryOf({ pid: 200, comm: "omp", starttime: "3", pgid: 50 }),
    entryOf({ pid: 300, comm: "sleep", starttime: "4", pgid: 100 }),
    entryOf({ pid: 400, comm: "electron", starttime: "5", pgid: 400 }),
  );
  const sharedPlan = planSignalTargets({
    table,
    owned: [table.get(200), table.get(300), table.get(400)],
    selfPid: 100,
    excludedGroups: [400],
  });
  assert.deepEqual(sharedPlan.groups, []);
  assert.deepEqual(sharedPlan.pids, [200, 300, 400]);
  assert.deepEqual(
    sharedPlan.protectedTargets.map((item) => [item.pgid, item.reason]),
    [
      [50, "ancestor-group"],
      [100, "own-group"],
      [400, "excluded-group"],
    ],
  );

  const selfPlan = planSignalTargets({ table, owned: [table.get(100)], selfPid: 100 });
  assert.deepEqual(selfPlan.groups, []);
  assert.deepEqual(selfPlan.pids, []);
  assert.ok(selfPlan.protectedTargets.some((item) => item.reason === "self-or-ancestor"));
});

test("a vanished or recycled pid is reported as stale, never signaled", () => {
  const table = tableOf(
    entryOf({ pid: 100, comm: "node", starttime: "1" }),
    entryOf({ pid: 400, comm: "omp", starttime: "8" }),
  );
  const plan = planSignalTargets({
    table,
    owned: [entryOf({ pid: 400, comm: "omp", starttime: "7" }), entryOf({ pid: 401, comm: "sleep", starttime: "7" })],
    selfPid: 100,
  });
  assert.deepEqual(plan.groups, []);
  assert.deepEqual(plan.pids, []);
  assert.deepEqual(
    plan.stale.map((item) => [item.pid, item.reason]),
    [
      [400, "pid-reused"],
      [401, "gone"],
    ],
  );
});

test("the signal executor negates groups, spares stale targets and reports real errors", () => {
  const plan = {
    groups: [200],
    pids: [300],
    mixedGroups: [],
    protectedTargets: [],
    stale: [{ pid: 400, reason: "gone" }],
  };
  const kill = killSpy();
  const results = signalProcessPlan(plan, "SIGTERM", { kill });
  assert.deepEqual(kill.calls, [
    { target: -200, signal: "SIGTERM" },
    { target: 300, signal: "SIGTERM" },
  ]);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, true],
  );

  const missing = signalProcessPlan(plan, "SIGKILL", {
    kill: killSpy({ fail: { [-200]: Object.assign(new Error("no such process"), { code: "ESRCH" }) } }),
  });
  assert.equal(missing[0].ok, false);
  assert.equal(missing[0].gone, true);

  const denied = signalProcessPlan({ ...plan, groups: [500], pids: [] }, "SIGTERM", {
    kill: killSpy({ fail: { [-500]: Object.assign(new Error("operation not permitted"), { code: "EPERM" }) } }),
  });
  assert.equal(denied[0].ok, false);
  assert.equal(denied[0].gone, false);
  assert.equal(denied[0].code, "EPERM");
  assert.match(denied[0].message, /operation not permitted/);
});

/* --------------------------------------------------------------------- */
/* Live-table sanity                                                      */
/* --------------------------------------------------------------------- */

test("the live /proc table describes this process", { skip: process.platform !== "linux" }, () => {
  const table = readProcessTable();
  assert.ok(table.size > 1, "the live process table must not be empty");
  const self = table.get(process.pid);
  assert.ok(self, "this process must be in its own snapshot");
  assert.ok(self.ppid > 0);
  assert.ok(self.starttime.length > 0);
  assert.ok(self.argv.some((arg) => arg.includes("process-ownership.test.mjs")));
  if (process.env.PATH) {
    assert.ok(processEnvironment(self)?.includes(`PATH=${process.env.PATH}`), "environment must be readable");
  }
  assert.equal(sameProcess(self), true);
  assert.equal(sameProcess({ pid: self.pid, starttime: "0" }), false);
});

/* --------------------------------------------------------------------- */
/* Real sentinel processes (never any other user process)                 */
/* --------------------------------------------------------------------- */

const linuxOnly = { skip: process.platform !== "linux" ? "Linux /proc only" : false };

async function waitForEntry(pid, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const entry = readProcessTable().get(pid);
    if (entry) return entry;
    if (Date.now() > deadline) throw new Error(`pid ${pid} never appeared`);
    await delay(50);
  }
}

async function waitForTable(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate(readProcessTable());
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(50);
  }
}

async function waitForGone(entry, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!sameProcess(entry)) return true;
    await delay(50);
  }
  return !sameProcess(entry);
}

function forceKill(...pids) {
  for (const pid of pids) {
    if (typeof pid !== "number") continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
}

test("reclaims its own detached group and leaves a shared-tree decoy alone", linuxOnly, async () => {
  const runRoot = mkdtempSync(join(tmpdir(), "omp-ownership-smoke-"));
  // A detached group leader (own group, argv names the run root) with a real
  // child, exactly like the app's own OMP runtime group holding a tool child.
  const leader = spawn(
    "python3",
    ["-c", "import subprocess, time\nsubprocess.Popen(['/bin/sleep', '300'])\ntime.sleep(300)", runRoot],
    { detached: true, stdio: "ignore" },
  );
  leader.unref();
  // The decoy only references the shared source tree: the archived parent
  // verifier shape. It must never be collected or signaled.
  const decoy = spawn("python3", ["-c", "import time\ntime.sleep(300)", SHARED_TREE], { stdio: "ignore" });
  decoy.unref();
  let childPid = null;
  try {
    const leaderEntry = await waitForEntry(leader.pid);
    const decoyEntry = await waitForEntry(decoy.pid);
    const settled = await waitForTable((table) => {
      const members = [...table.values()].filter((entry) => entry.pgid === leader.pid);
      const child = members.find((entry) => entry.pid !== leader.pid && entry.comm === "sleep");
      return members.length === 2 && child ? { table, child } : null;
    }, "the leader's group child");
    const { table, child } = settled;
    childPid = child.pid;
    const snapshot = collectOwnedProcesses({
      table,
      selfPid: process.pid,
      roots: [{ pid: leader.pid, starttime: leaderEntry.starttime }],
      runRoots: [runRoot],
    });
    const pids = snapshot.processes.map((entry) => entry.pid);
    assert.ok(pids.includes(leader.pid), "the run-root leader is owned");
    assert.ok(pids.includes(child.pid), "the group child is owned");
    assert.ok(!pids.includes(decoy.pid), "the shared-tree decoy must not be owned");
    assert.ok(!pids.includes(process.pid));
    assert.ok(!pids.includes(process.ppid));
    const plan = planSignalTargets({ table, owned: snapshot.processes, selfPid: process.pid });
    assert.ok(plan.groups.includes(leader.pid), `pure-owned group expected: ${JSON.stringify(plan)}`);
    assert.ok(!plan.groups.includes(decoyEntry.pgid) && !plan.pids.includes(decoy.pid));
    const results = signalProcessPlan(plan, "SIGTERM");
    assert.ok(results.every((result) => result.ok || result.gone), JSON.stringify(results));
    assert.equal(await waitForGone(leaderEntry), true, "the owned group must be reclaimed");
    assert.equal(sameProcess(decoyEntry), true, "the decoy must survive the signal plan");
  } finally {
    forceKill(leader.pid, childPid, decoy.pid);
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("attributes a reparented detached runtime by its run environment", linuxOnly, async () => {
  const runRoot = mkdtempSync(join(tmpdir(), "omp-ownership-orphan-"));
  // The intermediate leader exits at once; the sleep it leaves behind is
  // reparented, carries the run root only in its environment, and inherits the
  // leader's group — the detached-runtime-after-restart shape.
  const code = [
    "import os, time",
    "if os.fork() == 0:",
    `    os.execve('/bin/sleep', ['sleep', '300'], {'HOME': ${JSON.stringify(`${runRoot}/home`)}})`,
    "os._exit(0)",
  ].join("\n");
  const leader = spawn("python3", ["-c", code], { detached: true, stdio: "ignore" });
  leader.unref();
  let orphanPid = null;
  try {
    const settled = await waitForTable((table) => {
      const orphan = [...table.values()].find(
        (entry) => entry.comm === "sleep" && entry.pgid === leader.pid && entry.ppid !== leader.pid,
      );
      return orphan ? { table, orphan } : null;
    }, "the reparented detached sleep");
    const { table, orphan } = settled;
    orphanPid = orphan.pid;
    const snapshot = collectOwnedProcesses({
      table,
      selfPid: process.pid,
      roots: [{ pid: leader.pid }],
      runRoots: [runRoot],
    });
    const owned = snapshot.processes.find((entry) => entry.pid === orphan.pid);
    assert.ok(owned, "the orphan must be attributed by its run root");
    assert.equal(owned.ownership, "environ-run-root");
    const plan = planSignalTargets({ table, owned: snapshot.processes, selfPid: process.pid });
    assert.ok(
      plan.groups.includes(orphan.pgid) || plan.pids.includes(orphan.pid),
      `the orphan must be a target: ${JSON.stringify(plan)}`,
    );
    signalProcessPlan(plan, "SIGTERM");
    assert.equal(await waitForGone(orphan), true, "the orphan must be reclaimed");
  } finally {
    forceKill(leader.pid, orphanPid);
    rmSync(runRoot, { recursive: true, force: true });
  }
});

test("a group that mixes an owned leader with an unrelated member is signaled member-only", linuxOnly, async () => {
  const runRoot = mkdtempSync(join(tmpdir(), "omp-ownership-mixed-"));
  // The leader stays in its group; a double-forked sleep joins the same group
  // with an empty environment and a bare argv, so it is neither a descendant
  // nor attributable to the run — the mixed-group case.
  const code = [
    "import os, time",
    "pid = os.fork()",
    "if pid == 0:",
    "    if os.fork() == 0:",
    "        os.execve('/bin/sleep', ['sleep', '300'], {})",
    "    os._exit(0)",
    "os.waitpid(pid, 0)",
    "time.sleep(300)",
  ].join("\n");
  const leader = spawn("python3", ["-c", code, runRoot], { detached: true, stdio: "ignore" });
  leader.unref();
  let foreignPid = null;
  try {
    const leaderEntry = await waitForEntry(leader.pid);
    const settled = await waitForTable((snapshot) => {
      const members = [...snapshot.values()].filter((entry) => entry.pgid === leader.pid);
      const foreign = members.find((entry) => entry.pid !== leader.pid && entry.comm === "sleep");
      return members.length === 2 && foreign ? { table: snapshot, foreign } : null;
    }, "the settled mixed group");
    const { table, foreign } = settled;
    foreignPid = foreign.pid;
    const snapshot = collectOwnedProcesses({
      table,
      selfPid: process.pid,
      roots: [{ pid: leader.pid, starttime: leaderEntry.starttime }],
      runRoots: [runRoot],
    });
    assert.deepEqual(
      snapshot.processes.map((entry) => entry.pid),
      [leader.pid],
      "only the leader is owned; the double-forked member is not",
    );
    const plan = planSignalTargets({ table, owned: snapshot.processes, selfPid: process.pid });
    assert.deepEqual(plan.groups, [], "a mixed group must never be a group target");
    assert.deepEqual(plan.pids, [leader.pid]);
    assert.equal(plan.mixedGroups.length, 1);
    assert.deepEqual(plan.mixedGroups[0].foreignPids, [foreign.pid]);
    const results = signalProcessPlan(plan, "SIGTERM");
    assert.ok(results.every((result) => result.ok || result.gone), JSON.stringify(results));
    assert.equal(await waitForGone(leaderEntry), true, "the owned leader must be reclaimed");
    assert.equal(sameProcess(foreign), true, "the unrelated group member must survive");
  } finally {
    // The foreign member is deliberately spared by the plan and reaped here.
    forceKill(leader.pid, foreignPid);
    rmSync(runRoot, { recursive: true, force: true });
  }
});
