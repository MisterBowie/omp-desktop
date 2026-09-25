# ADR 0306: Plan/Goal mode excludes Cursor models

- Status: Accepted (M5/T20-R3C), **revised after independent review (F1-F3)**.
  User-approved product decision; it restricts which combinations any writer may
  persist, and it does **not** resolve R3.
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

Three facts shaped the decision:

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
- **A desktop-side check alone cannot hold it.** The transition tool's write path
  runs inside the host process: the Pi sidecar calls `plans.enter` directly, so a
  refusal placed in Electron's IPC is bypassed by construction, and even at the
  IPC boundary a check that reads the session and then writes it leaves a window
  for a concurrent update. Both facts force the invariant down to the durable
  write.

## Decision

- **Invariant:** a session may not combine an active Cursor model/provider with
  Plan or Goal mode.
- **Identity:** the canonical provider id `cursor`, compared exactly — never a
  display label, a user-typed vendor hint, an endpoint URL, or a case variant. The
  literal and the refusal code are declared once per language
  (`packages/shared/src/plan-goal-model-gate.ts`,
  `crates/host-core/src/plan_goal_guard.rs`), the guard SQL is generated from the
  Rust constants, and
  `apps/desktop/test/plan-goal-cursor-constant-parity.test.mjs` fails if either
  drifts.
- **Primary enforcement — the durable write itself.** Two triggers on `sessions`
  (`plan_goal_guard`, installed idempotently on every database open) abort any
  `INSERT`, or any `UPDATE OF mode, provider_id`, whose result is Plan/Goal + the
  Cursor provider. That covers the transition tool (`plans.enter`, which the Pi
  sidecar calls directly, outside the desktop's IPC), `session.configure`,
  `session.create`, forks, imports and every future writer in one place, and it
  closes the window a caller-side pre-read leaves open: SQLite evaluates the
  condition against the row as it is written, so a racing update cannot land on
  the pair.
- **Rows that already hold the pair are tolerated, not legalised.** A database
  that already holds it (a hand edit, or a historical migration from before the
  guard) keeps opening, and unrelated writes to that row still work — but only
  while both guarded columns keep exactly their previous values. Hopping such a
  row to the other contract mode (`plan` + Cursor → `goal` + Cursor) is a
  transition into the pair and is refused. Both repairs pass as ordinary writes:
  drop the mode, or choose another provider.
- **Stable codes at every boundary.** Host RPCs that can write the pair answer
  `PLAN_GOAL_CURSOR_UNSUPPORTED` rather than flattening the refusal into
  `INTERNAL` (`plans.enter` and `session.configure` already reported any `PLAN_*`
  refusal verbatim; `session.create`, `session.fork` and `session.import` now
  share that mapping). The desktop's `sessionConfigure`, `sessionCreate` and
  `agentPrompt` boundaries refuse the same pair before any runtime work through
  one constructor that carries `{ errorCode, mode, providerId }` in `data`, which
  `register.ts` forwards to the renderer as `error.details`.
- **The prompt gate is the last line of defence** for a row the guard cannot see
  (a migration, a manual edit): no turn runs while the pair is recorded, and the
  refusal names both escape paths.
- **Renderer prevention is UX, not the gate:** the store refuses before IPC and
  toasts the localized message; the model menu withholds the Cursor provider in
  Plan/Goal mode and states why; an automatic model pin that would create the pair
  is skipped with the same reason instead of forking optimistic local state.
- **Recovery is deterministic and never silent.** Neither side rewrites the user's
  mode or model; a refusal leaves the previous state in place and the user chooses
  the repair.
- **Not gated:** Cursor models in Agent mode, and every non-Cursor provider in
  Plan/Goal mode.

## Consequences

- The product limitation is explicit and testable rather than implicit: strict
  Cursor compatibility with Plan/Goal is not claimed, and R3's blocked status is
  unchanged.
- Plan/Goal for OMP stays unimplemented (T20-B/C/D unstarted). This gate is a
  precondition for that work, not the feature.
- Coverage: host-core tests that first reproduce the hole and then prove the
  guard (the transition tool, configure, create, forks, imports, the plan⇄goal hop
  on a pre-existing row, both repairs, non-Cursor behaviour, the RPC codes, and
  the write-time judgement a stale caller's pre-read cannot defeat); the
  predicate's boundary table; IPC behaviour tests for every reachable invalid
  combination plus both escape paths and the non-Cursor regressions; the
  cross-language literal parity check; and renderer contracts for the withheld
  menu entries, the notice, the pre-IPC refusal and the skipped pin.
- A user whose session carries a `cursor` provider id — or a future user of a
  projectable Cursor transport — sees one clear, localized refusal and can
  continue after a single change of mode or model.
