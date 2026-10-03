# ADR 0312: Plan/Goal engine capabilities, their boundaries, and unguarded OMP terminal delivery

- Status: Accepted (M5/T20-D; 2026-10-03). Implementation complete, pending the
  root's independent re-review. Opens the `plan`/`goal` engine capability keys
  now that the whole contract exists on OMP; keeps the Cursor + Plan/Goal gate
  (ADR 0306) and every other closed capability unchanged. Does not claim M5/T20
  completion by itself: the final matrix and the three-platform packages remain.
- Date: 2026-10-03
- Scope: the shared capability model (`plan`/`goal` keys), the renderer mode
  entry and the Main-process boundaries that consume it, and one main-process
  defect this stage found and fixed: OMP terminal agent events were dropped by
  the Pi turn-ownership guard, leaving the renderer's running state stuck.
- Amends: ADR 0300 (capability table gains the two mode keys), ADR 0311 §"未做"
  (the keys are now open), ADR 0309/0310 (unchanged: their gates remain the
  enforcement behind the modes).
- Evidence: `docs/validation/M5-t20-d-capability-ui.md`,
  `app/packages/shared/src/engine.ts`,
  `app/apps/desktop/electron/main/runtime/engine-router.ts`,
  `app/apps/desktop/electron/main/runtime/agent-event-fanout.ts`,
  `app/apps/desktop/electron/main/ipc/session-ipc.ts`,
  `app/apps/desktop/electron/main/ipc/agent-ipc.ts`,
  `app/apps/desktop/src/features/chat/composer/model.ts`,
  `app/scripts/e2e-omp-plan-ui.mjs`.

## Context

T20-B1/C/B2/D-Enter built the whole OMP Plan/Goal contract — mode state and
prompt block, catalogue clamp, execution-time permission decisions,
submit/approve/dispatch, and the model-side `EnterPlanMode`/`EnterGoalMode`
same-turn transition. Until T20-D the product could not *offer* the modes on
OMP: `EngineCapability` had no `plan`/`goal` keys at all, so "the UI hides
them" was not even a fact that could be stated — the composer cycled
Agent→Plan→Goal through `nextMode` with no engine input, and no Main-process
boundary judged a mode against its engine. A direct IPC caller could persist a
mode no engine could run.

The D3 user path (real renderer → Main → host → OMP runtime) also exposed a
second, independent defect. The sidecar event fan-out drops a terminal
(`agent_end`/`error`) whose turn does not own its session according to
`activeTurns` — the **Pi** turn map. An OMP session never has an entry there
(its durable turn is opened by the OMP bridge and its live turn ids are
`omp-turn:*`), so every OMP terminal was dropped. The renderer kept a finished
turn "running": a rejected plan could not be resubmitted from the composer
(the send was queued behind a turn that no longer existed), and Stop/permission
state was never cleared by the terminal.

## Decision

1. **`plan`/`goal` are engine capabilities.** `EngineCapability` and
   `ENGINE_CAPABILITY_KEYS` gain both keys; both shipped engines declare them
   open (`PI_ENGINE_CAPABILITIES`, `OMP_ENGINE_CAPABILITIES`). The capability
   states what an engine can do, never whether its runtime is up:
   `liveEngineCapabilities` keeps folding phase, and `requireContractMode`
   judges the declaration only, so a stopped runtime is a temporary outage and
   not a permanent refusal.

2. **One authoritative table, three consumers.**
   - `engineCapabilities` / `engineSupportsContractMode` (shared) is the single
     source; `contractModeCapability` maps a mode name to its key and is
     checked against `PROPOSAL_KINDS` by test so a new contract kind cannot
     appear without a capability.
   - The renderer derives the composer's mode cycle from
     `offeredModes(session.engine)`: an unsupported mode is never offered, a
     single-mode cycle is disabled, and no modes hides the chip.
   - Main boundaries refuse a mode the engine does not carry:
     `session.create` (creation mode), `session.configure` (the mode the write
     would persist, checked before any host/runtime mutation), and
     `agentPrompt` (a durable record already sitting in the mode — imported or
     stale rows included). All three throw the shared typed refusal
     (`ENGINE_CAPABILITY_UNAVAILABLE`, engine, capability).

3. **OMP terminal events bypass the Pi ownership guard.** The event fan-out
   (`agent-event-fanout.ts`) takes `guardPiTurnOwnership` (default true); the
   OMP registry wiring passes `false`. The OMP bridge's runner already emits
   only for the live generation and drops late frames, so the Pi map is both
   unnecessary and harmful for OMP envelopes. The Pi guard keeps its exact
   semantics (stale terminals and delegate terminals are still dropped).

4. **D2 stays unimplemented, as the matrix allows.** No `goal_updated`
   read-only surface is added: the OMP interactive goal runtime's continuation
   timer is not part of this product, and no second goal state is invented. A
   goal is a single contract turn whose approval runs as an ordinary agent turn
   that self-stops.

## Consequences

- The composer's mode affordance and the Main refusals read one table, so a
  future engine (or a build that lacks the patched runtime contract) closes
  the modes in both places at once; tests exercise the closed branch with an
  injected declaration table rather than a third engine.
- Pi behavior is unchanged: all three modes were and remain open, and the
  composer cycle is byte-for-byte the same for Pi sessions.
- The fan-out option is deliberately narrow: engines opting out must guard
  terminal generations themselves, which is stated on the option and proven by
  the OMP runner's generation tests. A future engine without that property must
  not reuse the flag.
- Stopping/erroring an OMP turn now clears the renderer's running state and
  pending permission cards through the same terminal path the Pi engine uses.
