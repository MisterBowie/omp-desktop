#!/usr/bin/env node
/**
 * T20-A diagnostic: observable Plan/Goal capability gaps of the OMP engine,
 * reported through the CURRENT shipped source seams only. This is a
 * diagnostic, not a correctness assertion and not part of the default test
 * suite — it reports the baseline facts recorded in
 * `docs/validation/M5-plan-goal-capability-gates.md` §4.
 *
 * Usage:
 *   node scripts/check-omp-plan-goal-gaps.mjs              -> prints SKIP, exit 0
 *   OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs
 *                                                          -> one stable line per
 *                                                             open gap, exit 1
 *
 * Baseline: commit 2ca2565, OMP d49918fab, PI 0111e306 (re-verified on the
 * T20-A rework heads 5da616f/dd2ec72; the measured seams are unchanged). Each
 * gap is owned by the noted later stage; the checks here must be REPLACED by
 * real behavioral tests there, not converted into pins.
 *
 * g1's verdict policy: static symbols cannot prove that the durable mode
 * actually reaches the prompt, so g1 NEVER auto-closes. The baseline (no
 * mode-ish state field, no composer seam, no protocol key) reports GAP-OPEN;
 * any appearance of such a symbol reports REVIEW-REQUIRED and keeps the exit
 * code non-zero for a human re-review. Only the T20-B behavior test (B2/B13)
 * may replace this check.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = join(appRoot, "..");
const ompSource = (rel) => join(repoRoot, "upstream", "oh-my-pi", rel);

if (process.env.OMP_T20_GAP_PROBE !== "1") {
  console.log("SKIP: T20-A gap diagnostic not enabled (set OMP_T20_GAP_PROBE=1 to run it)");
  process.exit(0);
}

/** @type {string[]} */
const open = [];

function report(id, owner, openGap, message, evidence) {
  const line = openGap
    ? `GAP-OPEN ${id} (owner: ${owner}) ${message} [evidence: ${evidence}]`
    : `GAP-CLOSED ${id} (owner: ${owner}) ${message} [evidence: ${evidence}]`;
  console.log(line);
  if (openGap) open.push(id);
}

function sourceSeam(rel) {
  return readFileSync(join(appRoot, rel), "utf8");
}

// ---------------------------------------------------------------------------
// g1 (owner: T20-B) — mode/permissionMode is persistence-only in the bridge
//
// Verdict policy (F8): this check NEVER auto-closes. Static keyword matching
// cannot prove a data flow — a state property plus comments naming the
// composer and the gate would satisfy any `includes` heuristic — so the only
// way g1 retires is the T20-B behavior test (B2/B13), which replaces it.
//   - baseline (no mode-ish state field, no composer seam, no protocol key):
//     GAP-OPEN, exit 1;
//   - ANY appearance of a mode-ish state field, a composer seam, or a
//     protocol mode/systemPrompt/tools key: REVIEW-REQUIRED, exit 1, with the
//     matched symbols reported for the human re-review.
// ---------------------------------------------------------------------------
{
  const typesSource = readFileSync(
    ompSource("packages/coding-agent/src/modes/rpc/rpc-types.ts"),
    "utf8",
  );
  const promptVariant = typesSource.match(
    /\|\s*\{[^{}]*?type:\s*"prompt";[^{}]*?\}/s,
  )?.[0] ?? "";
  const promptCarriesModeKey = /(mode|systemPrompt|tools)\s*[?:]/.test(promptVariant);

  const stateSource = sourceSeam("packages/omp-runtime/src/desktop-state.ts");
  const stateFieldNames = [
    ...new Set([...stateSource.matchAll(/^\s*([A-Za-z]*[Mm]ode[A-Za-z]*)\s*\??\s*:/gm)].map((match) => match[1])),
  ];

  const engineSeamDir = join(appRoot, "apps/desktop/electron/main/runtime");
  const engineSeams = readdirSync(engineSeamDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, source: readFileSync(join(engineSeamDir, name), "utf8") }));
  const composerSeamFiles = engineSeams
    .filter((seam) => /composeModeSystemPrompt|mode-prompts/.test(seam.source))
    .map((seam) => seam.name);

  const gateSource = sourceSeam("packages/omp-runtime/extensions/omp-desktop-gate.ts");
  const gateReadsValidatedState = /readDesktopCapabilityState/.test(gateSource);

  const triggers = [
    promptCarriesModeKey ? `pinned prompt command carries a mode/systemPrompt/tools key (${promptVariant.trim().replace(/\s+/g, " ")})` : null,
    stateFieldNames.length > 0 ? `runtime-domain state has mode-ish field(s): ${stateFieldNames.join("|")}` : null,
    composerSeamFiles.length > 0 ? `engine seam references the mode composer: ${composerSeamFiles.join("|")}` : null,
  ].filter((entry) => entry !== null);

  if (triggers.length > 0) {
    console.log(
      `REVIEW-REQUIRED g1: ${triggers.join("; ")} — static symbols cannot prove the mode actually reaches the prompt (a field or comment would match them), so g1 is NOT closed here; a human must replace this diagnostic with the T20-B behavior test (B2/B13) that asserts the bridge writes composeModeSystemPrompt(mode, "") into the validated state and the gate appends it`,
    );
    open.push("g1");
  } else {
    report(
      "g1",
      "T20-B",
      true,
      "session mode/permissionMode persist to the host DB only; no OMP prompt/tool path reads them",
      [
        `pinned prompt command has no mode/systemPrompt/tools key: ${!promptCarriesModeKey}`,
        `state mode-ish fields: ${stateFieldNames.join("|") || "none"}`,
        `engine seams referencing the mode composer: ${composerSeamFiles.join("|") || "none"}`,
        `gate reads the validated state (T19-C skills/memory only, not mode): ${gateReadsValidatedState}`,
        "retirement: T20-B behavior test (B2/B13) replaces this check; g1 never auto-closes",
      ].join("; "),
    );
  }
}

// ---------------------------------------------------------------------------
// g2 (owner: T20-C) — plugin execution hardcodes mode "agent"
// ---------------------------------------------------------------------------
{
  const hostToolsSource = sourceSeam("apps/desktop/electron/main/runtime/omp-host-tools.ts");
  // The literal must sit at the plugin-execution context (the executor's
  // `tool.execute(call.arguments, { ... mode: "agent" ... })`), not in prose.
  const hardcoded = /tool\.execute\(call\.arguments,\s*\{[\s\S]{0,200}?mode:\s*"agent"/.test(
    hostToolsSource,
  );
  report(
    "g2",
    "T20-C",
    hardcoded,
    "the host-tool adapter executes every plugin tool with a hardcoded mode 'agent'; the session's durable mode never reaches plugin execution",
    `omp-host-tools.ts hardcoded execution-context mode literal present: ${hardcoded}`,
  );
}

// ---------------------------------------------------------------------------
// g3 (owner: T20-B) — approved plan execution refuses OMP sessions
// ---------------------------------------------------------------------------
{
  const plansSource = sourceSeam("apps/desktop/electron/main/runtime/plans.ts");
  const refused = /refuseOutsidePiRuntime\([\s\S]{0,160}?"plan execution"\)/.test(plansSource);
  report(
    "g3",
    "T20-B",
    refused,
    "an approved Plan/Goal execution for an OMP session is refused before claiming; the queued row stays queued and nothing runs on the OMP engine",
    `runtime/plans.ts refuseOutsidePiRuntime("plan execution") present: ${refused}`,
  );
}

// ---------------------------------------------------------------------------
// g4 (verdict pin, not a gap to close) — pinned rpc-ui exposes no Plan/Goal
// control commands. Report-only on baseline; a non-empty match means the
// upstream upgrade invalidated the T20-A verdict and REQUIRES re-review.
// ---------------------------------------------------------------------------
{
  const typesPath = ompSource("packages/coding-agent/src/modes/rpc/rpc-types.ts");
  const source = readFileSync(typesPath, "utf8");
  const union = source.slice(source.indexOf("export type RpcCommand ="), source.indexOf("// RPC State"));
  const names = [...union.matchAll(/\|\s*\{[^}]*?type:\s*"([a-z_]+)"/gs)].map((m) => m[1]);
  const planGoalish = names.filter((name) => /plan|goal|permission|approval/i.test(name));
  console.log(`VERDICT g4: pinned rpc-ui RpcCommand union has ${names.length} commands: ${names.join(", ")}`);
  if (planGoalish.length > 0) {
    console.log(
      `REVIEW-REQUIRED g4: upstream now carries plan/goal/permission/approval commands: ${planGoalish.join(", ")} — the T20-A rpc-ui verdict in docs/validation/M5-plan-goal-capability-gates.md is stale and must be re-audited`,
    );
    open.push("g4");
  } else {
    console.log(
      "VERDICT g4: no plan/goal/permission/approval command exists in the pinned rpc-ui surface (rpc-ui = rpc + tool-UI context; see the validation document)",
    );
  }
}

console.log(`SUMMARY: ${open.length} gap(s) open [${open.join(", ") || "none"}]`);
process.exit(open.length > 0 ? 1 : 0);
