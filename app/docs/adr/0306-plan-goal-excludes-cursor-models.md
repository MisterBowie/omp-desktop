# ADR 0306: Plan/Goal mode excludes Cursor models

- Status: Accepted (M5/T20-R3C). User-approved product decision; it restricts
  which combinations the desktop accepts, and it does **not** resolve R3.
- Date: 2026-09-25
- Scope: which (mode, model) combinations a session may hold, and where the
  desktop refuses the invalid ones.
- Evidence: `docs/validation/M5-cursor-plan-goal-gate.md`,
  `docs/validation/M5-omp-transition-patch.md` §9/§10,
  `packages/shared/src/plan-goal-model-gate.ts`,
  `apps/desktop/test/plan-goal-cursor-gate.test.mjs`,
  `apps/desktop/test/plan-goal-cursor-renderer.test.mjs`.

## Context

PI Desktop's Plan/Goal contract requires the transition tool to own the whole
assistant batch — no sibling call may have a side effect — and the run to end
when that tool settles (R3). On the pinned OMP runtime that contract cannot be
implemented: Cursor's exec channel executes tool calls while the response is
still streaming, before the assistant message that carries them exists, and those
effects cannot be blocked or undone by the loop or the provider/bridge layer.
T20-R3A's patch level reduces the loop-controllable risk only, and T20-R3B
measured **0/12** strict contract checks held against the real Cursor exec
dispatcher and bridge (`M5-omp-transition-patch.md` §9/§10). R3 therefore stays a
hard blocker, and T20-B/C/D must not start.

The user then selected the product option: **Plan/Goal mode must not support
Cursor models**. This ADR records that restriction and the honest way to
implement it, instead of claiming strict Cursor compatibility or rewriting R3 as
solved.

Two facts shaped the decision:

- **PI Desktop has no precedent for gating a mode by a model.** Every mode gate
  there is about session state or context (`PLAN_ALREADY_ACTIVE`,
  `PLAN_CONFIGURATION_BLOCKED`, `PLAN_REQUIRES_INTERACTIVE_SESSION`,
  `PLAN_KIND_MISMATCH`), and every model gate is about configuration or auth
  (`MODEL_NOT_CONFIGURED`). A mode↔model gate is a new concept in this codebase
  and has to justify itself explicitly — which this ADR does.
- **Cursor's transport is not reachable through the desktop today.** The wire
  vocabulary has no `cursor-agent` (`packages/shared/src/model-catalog.ts`
  `API_STYLES`), the OMP projection maps five HTTP apis and refuses OAuth
  (`omp-model-projection.ts`), and the Pi engine's `pi-ai` 0.86.1 has no Cursor
  transport at all. Provider rows are UUIDs or namespaced plugin ids, so the only
  reachable Cursor identity is a persisted provider id that is literally
  `cursor` — for example an imported `pi`/`opencode` session, whose provider id is
  copied verbatim while its mode is forced to `agent`. The gate is therefore a
  product invariant that binds the reachable shapes now and is already in force if
  Cursor ever becomes projectable.

## Decision

- **Invariant:** a session may not combine an active Cursor model/provider with
  Plan or Goal mode.
- **Identity:** the canonical provider id `cursor` (`CURSOR_PROVIDER_ID`).
  Detection is an exact comparison on that id — never a display label, a
  user-typed vendor hint, an endpoint URL, or a case-insensitive variant.
- **One source of truth:** `planGoalCursorRefusal(mode, providerId)` in
  `packages/shared/src/plan-goal-model-gate.ts`, shared by the main process and
  the renderer. The refusal is `PLAN_GOAL_CURSOR_UNSUPPORTED` and carries `mode`
  and `providerId`.
- **Enforcement at the boundaries that accept a combination**, each one
  immediately before it would take effect: `sessionConfigure` (a mode or model
  change, judged against the resulting pair, because the renderer sends partial
  updates), `sessionCreate` (the inherited initial pairing), and `agentPrompt`
  (a persisted or imported pair, before any runtime work starts).
- **Renderer prevention is UX, not the gate:** the store refuses before IPC and
  toasts the localized message; the model menu withholds the Cursor provider in
  Plan/Goal mode and states why; an invalid automatic model pin is skipped with
  the same reason instead of forking optimistic local state.
- **Recovery is deterministic and never silent.** A refusal names both escape
  paths — switch to Agent mode, or choose another model — and the desktop does
  not rewrite the user's mode or model by itself.
- **Not gated:** Cursor models in Agent mode, and every non-Cursor provider in
  Plan/Goal mode.
- **The Rust host is deliberately unchanged, and one path is documented as
  adjusted instead.** The three desktop boundaries cover every transition the
  desktop accepts and every pair that reaches a run. One path cannot be
  intercepted there: a Pi session whose durable `provider_id` is `cursor` can
  still start a turn — the launch resolver falls back to the default or first
  provider when the binding does not resolve
  (`packages/host-runtime/src/launch-resolver.ts`) — and the model's
  `EnterPlanMode` tool then writes `mode='plan'` through host-core
  `plans.enter` (`crates/host-core/src/plans/approval.rs`), which the Pi sidecar
  calls directly, outside the desktop's IPC. That pair is refused by the prompt
  gate before any further runtime work, with the same reason and escape paths:
  the durable record can hold the pair, but no turn runs in it. The technical
  hazard is absent on that path anyway — the Pi engine has no Cursor transport
  (`pi-ai` 0.86.1), and the resolver substitutes a real provider. Making the
  durable record pair-free would mean a provider check in host-core's
  `PlanManager::enter` plus a cross-language test pinning the `cursor` literal;
  this ADR does not take that step, and names it as the seam to change if the
  product later requires it.

## Consequences

- The product limitation is explicit and testable rather than implicit: strict
  Cursor compatibility with Plan/Goal is not claimed, and R3's blocked status is
  unchanged.
- Plan/Goal for OMP stays unimplemented (T20-B/C/D unstarted). This gate is a
  precondition for that work, not the feature.
- Coverage: the predicate's boundary table as a unit test, IPC behaviour tests
  for every reachable invalid combination plus both escape paths and the
  non-Cursor regressions, and renderer contracts for the withheld menu entries,
  the notice, the pre-IPC refusal and the skipped pin.
- A user whose session carries a `cursor` provider id — or a future user of a
  projectable Cursor transport — sees one clear, localized refusal and can
  continue after a single change of mode or model.
