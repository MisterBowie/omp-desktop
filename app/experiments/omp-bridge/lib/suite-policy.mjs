/**
 * Suite policy shared by the aggregator and its regressions: argument parsing
 * and the pass/fail verdict. Kept in a module (not in run-all.mjs) so tests can
 * import it without executing the suite.
 */
import { resolve } from "node:path";

export function parseArgs(args, defaultDir) {
  const selectors = [];
  let dir = defaultDir;
  let keep = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--keep-artifacts") { keep = true; continue; }
    if (arg === "--dir") {
      const value = args[i + 1];
      if (!value) throw new Error("--dir requires a path");
      dir = resolve(value);
      i++;
      continue;
    }
    if (arg.startsWith("--")) continue;
    selectors.push(arg);
  }
  return { selectors, dir, keep };
}

/**
 * Decide whether one experiment really passed.
 *
 * A `PASS` line alone is not enough: the process must exit 0, must not have
 * been killed by a signal, and its recorded result file must exist, parse, name
 * the same experiment and itself report `ok: true`. This is what catches an
 * experiment that prints PASS and then dies (or whose assertions were never
 * written to disk).
 */
export function verdictFor({ exitCode, signal, headline, result }) {
  if (signal) return { ok: false, reason: `killed by signal ${signal}` };
  if (exitCode !== 0) return { ok: false, reason: `exit code ${exitCode}` };
  if (!headline) return { ok: false, reason: "no PASS/FAIL line" };
  if (!/^PASS /.test(headline)) return { ok: false, reason: "reported FAIL" };
  if (!result.exists) return { ok: false, reason: "no result file" };
  if (result.parseError) return { ok: false, reason: `result file unreadable: ${result.parseError}` };
  if (result.experiment !== result.expected) return { ok: false, reason: `result file names "${result.experiment}"` };
  if (!result.runId) return { ok: false, reason: "result file has no run id (stale file?)" };
  if (result.runId !== result.expectedRunId) return { ok: false, reason: `result file belongs to run ${result.runId}` };
  if (result.ok !== true) return { ok: false, reason: "result file reports failure" };
  return { ok: true, reason: "exit 0, no signal, PASS, matching valid result" };
}
