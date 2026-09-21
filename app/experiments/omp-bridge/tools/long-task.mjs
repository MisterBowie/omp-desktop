#!/usr/bin/env node
/**
 * External long-running test program for the cancellation experiments.
 *
 * It is launched as a real command by OMP's `bash` tool (not by the harness),
 * so the identity it records is the identity the harness must observe and
 * reclaim. It writes its own pid, its parent pid and its descendant's pid to a
 * JSON file, then runs until it is terminated:
 *
 *   - it never exits on its own, so a later "process is gone" observation can
 *     only be explained by something actually terminating it;
 *   - it spawns a descendant that outlives a naive parent-only kill, so
 *     "descendant reclaimed" distinguishes a process-group kill from a
 *     single-process kill;
 *   - it dies on SIGTERM/SIGINT like a normal program, so a stop path that
 *     works is not penalised.
 *
 * Usage: node long-task.mjs <identity-file> [--ignore-term]
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const identityPath = process.argv[2];
const ignoreTerm = process.argv.includes("--ignore-term");
if (!identityPath) {
  process.stderr.write("usage: long-task.mjs <identity-file> [--ignore-term]\n");
  process.exit(2);
}

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });

writeFileSync(
  identityPath,
  `${JSON.stringify({
    pid: process.pid,
    ppid: process.ppid,
    descendantPid: descendant.pid,
    argv: process.argv.slice(2),
    startedAt: Date.now(),
  })}\n`,
);

if (ignoreTerm) {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}

setInterval(() => {}, 1000);
