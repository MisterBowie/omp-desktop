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
 * T20-A rework head 07de0a7; the measured seams are unchanged). Each gap is
 * owned by the noted later stage; the checks here must be REPLACED by real
 * behavioral tests there, not converted into pins.
 *
 * g1's verdict is a disjunction over real runtime channels (protocol prompt
 * key, runtime-domain state field, engine-seam mode prompt) — the previous
 * version keyed the verdict on a comment in the bridge, which is not evidence
 * of anything and has been removed.
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

  // The gap is "no runtime channel carries the durable mode". It closes when
  // any channel does, so the verdict is a disjunction over real seams — never a
  // comment match:
  //   1. the pinned per-prompt `prompt` command grows a mode/tools key,
  //   2. the runtime-domain state snapshot (`desktop-state.ts`) carries a mode
  //      block that `before_agent_start` reads,
  //   3. the desktop engine seam composes PI's mode prompt (directly or through
  //      the `mode-prompts` module).
  const stateSource = sourceSeam("packages/omp-runtime/src/desktop-state.ts");
  const stateCarriesMode = /^\s*mode(Prompt)?\s*[?:]/m.test(stateSource);
  const engineSeamDir = join(appRoot, "apps/desktop/electron/main/runtime");
  const engineSeamSources = readdirSync(engineSeamDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => readFileSync(join(engineSeamDir, name), "utf8"));
  const composesModePrompt = engineSeamSources.some(
    (source) => source.includes("composeModeSystemPrompt") || source.includes("mode-prompts"),
  );

  if (promptCarriesModeKey) {
    console.log(
      `REVIEW-REQUIRED g1: the pinned prompt command now carries a mode/systemPrompt/tools key (${promptVariant.trim().replace(/\s+/g, " ")}) — the T20-A g1 verdict is stale and must be re-audited before T20-B`,
    );
    open.push("g1");
  } else {
    const gapOpen = !stateCarriesMode && !composesModePrompt;
    report(
      "g1",
      "T20-B",
      gapOpen,
      "session mode/permissionMode persist to the host DB only; no OMP prompt/tool path reads them",
      `pinned prompt command has no mode/systemPrompt/tools key: ${!promptCarriesModeKey} (${promptVariant.trim().replace(/\s+/g, " ")}); runtime-domain state carries a mode field: ${stateCarriesMode}; desktop engine seam composes the PI mode prompt: ${composesModePrompt}`,
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
