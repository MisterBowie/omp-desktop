# ADR 0310: OMP Plan/Goal submission, approval and dispatch

- Status: Accepted (M5/T20-B2; 2026-10-03); the root's first independent review
  returned **changes-required** (R1-R3 production ordering races + R4 E2E proof
  gap), the repair is implemented (§5) and **pending the root's
  re-verification**. `@pi-desktop/shared` has no `plan`/`goal` capability keys
  today and `ComposerToolbar` takes no engine/capability input, so missing keys
  cannot demonstrate a UI gate: the engine-gated capability/UI acceptance stays
  T20-D and is not claimed here.
- Date: 2026-10-03
- Scope: M5/T20-B2 — the submit tools, their settle-time termination, the
  durable host turn identity for OMP prompts, and the approved-execution
  dispatch into the OMP runtime (matrix rows B4-B8, B13 and the D1/D3 loop).
  Does not open `OMP_ENGINE_CAPABILITIES.plan`/`goal` (T20-D) and does not touch
  the Cursor + Plan/Goal gate (ADR 0306).
- Amends: ADR 0305 (patch level `62bc57b+omp-desktop.4` adds the settle-time
  termination declaration), ADR 0308 §2 (the contract catalog now includes the
  active mode's submit tool), ADR 0309 §5 (the decision table grants exactly
  the mode's own submit tool and denies the other kind).
- Evidence: `docs/validation/M5-t20-b2-submit-approval.md`,
  `app/patches/oh-my-pi/manifest.json` (patch level `.4`),
  `app/packages/omp-runtime/extensions/omp-desktop-gate.ts`,
  `app/packages/omp-runtime/src/session/host-tools.ts`,
  `app/packages/omp-runtime/src/session/runner.ts`,
  `app/apps/desktop/electron/main/runtime/omp-host-tools.ts`,
  `app/apps/desktop/electron/main/runtime/omp-session.ts`,
  `app/apps/desktop/electron/main/runtime/omp-session-wiring.ts`,
  `app/apps/desktop/electron/main/runtime/plans.ts`,
  `app/packages/agent-runtime/src/plan-execution-instruction.ts`,
  `app/apps/desktop/test/omp-plan-submit-unit.test.mjs`,
  `app/apps/desktop/test/omp-plan-submit-e2e.test.mjs`,
  `app/apps/desktop/test/plan-drain-engine-gate.test.mjs`,
  `app/packages/omp-runtime/src/session/gate-permissions.test.ts`,
  `app/packages/omp-runtime/src/session/gate-desktop-state.test.ts`.

## Context

The submission loop was the last missing link of the non-Cursor Plan/Goal
route: the contract modes and their tool clamp existed (ADR 0308), and the
execution-time permission decisions were in place (ADR 0309), but nothing
registered `SubmitPlan`/`SubmitGoal`, nothing opened the durable host turn the
host's `plans.submit` protocol requires, and an approved execution for an OMP
session was refused before the claim (`refuseOutsidePiRuntime(job, "plan
execution")`). The root's independent probe (`omp-t20-b2-submit-validation-…`)
measured the remaining runtime gap: a schema-validation rejection of a submit
tool never reaches `execute`/`afterToolCall`, so a settle-time termination
carried only by the host result cannot cover it — the model kept running with
the next provider request.

## Decision

### 1. The patch set declares settle-time termination (level `.4`)

`AgentTool.terminateOnSettle?: boolean` (default off) and the matching
`RpcHostToolDefinition.terminateOnSettle` field are added by the maintained
patch set. The agent loop enforces the declaration at its single settlement
boundary (`emitSettledToolResult`), reading it from the **resolved tool
definition**, so every result path terminates identically for a declared tool:
schema-validation rejection, `beforeToolCall` rejection or transform failure,
execution throw, host error and success. A validation failure therefore
terminates without ever reaching `execute`.

Boundaries kept intact:

- a call skipped by batch admission, a pending interrupt, or a run under an
  external (user Stop) abort does **not** terminate — an interrupt is not a
  submission outcome and Stop remains a cancellation;
- a streaming partial can never terminate (only the settled result is read);
- a rejected mixed batch still returns `terminate: false`, so the model keeps
  its turn and can correct (`block-and-continue`);
- an unknown tool name never acquires the declaration; only the resolved
  definition grants it.

`normalizeHostToolPolicy` validates the field at both `set_host_tools`
boundaries and rejects the whole request for any non-boolean value; the field
is part of the registration fingerprint.

### 2. Submit tools are the PI contract, registered only in their own mode

The production host-tool adapter owns `desktopSubmitToolCatalogEntry(kind)`:
`SubmitPlan`/`SubmitGoal` with PI's exact names, descriptions and the required
`title`/`markdown`/`question` string schema, declared `loadMode: "essential"`,
`concurrency: "exclusive"`, `batchPolicy: "sole"` and `terminateOnSettle: true`.
The bridge appends exactly the active contract mode's entry while assembling
the per-prompt catalog (the only catalog assembly point), so Plan exposes
`SubmitPlan` only, Goal `SubmitGoal` only, and Agent neither. The entry rides
the run-scoped policy table as `{risk: "low", planSafeActions: [],
origin: "desktop"}` — a new, explicit provenance value, never a name-prefix
guess.

The trusted gate:

- `contractAllowsTool(name, hostTools, mode)` admits exactly the mode's own
  submit tool; the other kind is a contract deny with `PLAN_KIND_MISMATCH`;
- `contractActiveToolNames` keeps the mode's submit tool in the clamp (PI's
  `rebuildToolCatalog` analogue);
- a submit call needs no approval card (PI risk Low); the approval is the
  existing plan-approval surface.

The executor's submit branch is the desktop-side fail-closed layer before the
host's own validator: the admitted turn's mode must equal the submitted kind
(`modeForTurn`), the run must carry a durable host turn id, and an unwired
`plans.submit` refuses. Only then does it call the real `plans.submit` RPC with
`{sessionId, turnId, toolCallId, kind, title, markdown, question}` built from
the binding and the frame's real tool-call id — never a model-supplied identity.
The host remains authoritative for kind vs durable mode, one pending per
session, live-turn membership and artifact publication; its error code is
surfaced to the model verbatim.

### 3. One durable host turn per accepted OMP prompt

The bridge — the single owner of the lifecycle — calls `session.beginTurn`
immediately before submitting each accepted prompt (the regular user entry and
the approved-execution entry both go through `prompt`) and settles exactly that
row from the runner's `closeRun` path (completed / aborted / error). The live
`omp-turn:…` generation id and the host turn id are stored separately and never
interchange: `OmpHostToolRun` carries the bound `hostTurnId`, and the submit
tools refuse a run without one.

Properties:

- a preparation failure before `beginTurn` leaves no row; a prompt refused (or
  stopped) after `beginTurn` settles its own row exactly once (`error`, or
  `aborted` when the stop epoch moved) — the runner's close cannot double-settle
  it;
- `recoverInflight` is always false and no task notification is created: OMP's
  native JSONL stays the only transcript source (M2 decision), and no Pi
  message writer is involved;
- the settle is dispatched from the runner's synchronous close, so the next
  prompt awaits the previous row's end before `beginTurn` (the host refuses a
  second running turn);
- the plugin announcement is optional; host-turn settlement is not gated on it.

### 4. Approved execution dispatches into OMP through the existing pipeline

`runtime/plans.ts` now decides the engine before anything durable changes and
dispatches per engine:

- **Pi**: unchanged (`claimExecution` CAS → durable turn → sidecar
  `agent.executeApprovedPlan`);
- **OMP**: wait for the session's live OMP turn to settle, claim the queued row
  exactly once (CAS), restore the session's native identity
  (`session.getEngineRef`) so the execution continues the same transcript, and
  submit the shared `approvedPlanInstruction(execution)` through the bridge's
  own `prompt` — the same path the user entry uses, so exactly one host turn is
  opened and the admission carries the mode/permission the approval selected;
- **anything else / any refusal**: skip before the claim (the row stays queued;
  the drain continues), never claim-then-interrupt.

`approvedPlanInstruction` is now a single exported implementation in
`@pi-desktop/agent-runtime`, used by both the Pi runtime and the OMP dispatch:
it carries the immutable artifact's workspace-relative path, the title, the
approval question and the exact Markdown inside explicit boundary tags (and the
Goal acceptance-criteria walk). Neither engine may substitute a summary.

Completion is settled from the durable host turn: the bridge's turn-end
announcement flows into `settleOmpTurnEnd`, which finishes the execution
(completed / interrupted) only when the announced `hostTurnId` equals the one
recorded at dispatch — a later turn on the same session can never finish the
wrong execution. A CAS loser, an interrupted/completed row, a rejected
approval, an expired row and a boot-maintenance interruption
(`queued`/`running` → `interrupted` on the next host start) never prompt and
never replay; no timer or background continuation is added (the Goal
continuation difference stays recorded, per D1).

The approval IPC no longer refuses OMP sessions: the engine gate runs before
the resolve transaction, the host transaction flips `mode=agent` +
`permissionMode` and queues the execution, the existing `plans.changed`
notification drives the existing `PlanApprovalBar`, and the same dispatch path
runs. No second approval queue or storage is introduced.

### 5. Review repair (2026-10-03)

The root's independent review (candidate `148cfcc7`) found three production
ordering races in the desktop binding/dispatch layer plus one E2E proof gap.
The review scripts were ported to this host (environment paths only) and
reproduced RED on the unmodified candidate; after the fix they pass GREEN. Raw
reports and scripts: `docs/validation/M5-t20-b2-submit-approval/repair-red/`
and `.../repair-green/`. The fork, the patch level and the pinned submodules
did not change.

- **Durable-id announcement (R2).** The runner's turn-end callback reports the
  `hostTurnId` recorded on the closing run (read before the run record is
  cleared). A real `agent_end` may be emitted before the prompt response is
  delivered (`docs/rpc.md` states the response acknowledges acceptance, not
  completion); the announcement now names the correct durable turn anyway. The
  bridge matches the current host turn by exact live id or exact durable id,
  settles it once (`settledHostTurns`, monotonic runner generation guard),
  never revives it when the prompt's response arrives later, and a late or
  duplicate terminal for an older generation cannot close the new one.
- **Stop during the durable begin (R1).** `prompt` re-checks `closed`/
  `stopEpoch` after `hostTurns.begin` resolves and before any user content is
  written: a stop or dispose that landed in that window settles the real row
  exactly once as `aborted` and refuses with `stopping` — the prompt is never
  marked aborted while still being sent, no provider request is made, and the
  next prompt on the same native identity recovers normally. A begin that fails
  under a concurrent stop is classified as the stop, not as a host failure.
- **Dispatch binding (R3).** `OmpPromptInput.onHostTurnBound` is invoked once
  the durable row exists and the stop re-check has passed, immediately before
  the runner may deliver any terminal; `dispatchApprovedPlanToOmp` records the
  execution↔host-turn mapping there instead of after `bridge.prompt` returns.
  A terminal that beats the prompt's return settles the right execution; a
  start refusal (`begin` failure or a refused prompt) finalizes it as
  `interrupted` with no provider request. The mapping stays keyed by the exact
  durable turn id (a late event from an earlier turn can never finish a later
  execution), and a finished execution's identity is not re-added after its
  terminal. The bridge remains the single `beginTurn` owner; the Pi path is
  unchanged.
- **E2E proof (R4).** The product E2E composes the production
  `onTurnEnd → settleOmpTurnEnd` link (the failure mode the root demonstrated
  with a missing-link control) and asserts the durable
  `plan_approvals.execution_state` directly — completed for a normal dispatch
  and interrupted for a refused start or a restart — instead of treating an
  empty queue as completion. Three controlled-order regressions were added with
  positive controls and real provider counters, durable rows, terminal
  identities and cleanup assertions: Stop during the durable begin; terminal
  before the prompt response; dispatch terminal before the prompt return plus
  a refused-begin case.

## Consequences

- A non-Cursor OMP session can now submit a Plan/Goal, show the existing
  approval card, and execute the approved contract in agent mode with the
  chosen permission mode; the strict batch/termination contract holds for every
  observed path (`[bash, SubmitPlan]` rejected whole with zero side effects and
  no termination; a successful or failed submission terminates with exactly one
  provider request).
- The patch level moves to `62bc57b+omp-desktop.4` (fork
  `codex/omp-desktop-18.3.0-patch-4`, commit recorded in the manifest); the
  `.3` artifact and coordinates stay in the manifest history.
- `plan`/`goal` capability keys remain **closed**; the composer entry and the
  matrix-wide acceptance remain T20-D. The Cursor + Plan/Goal combination stays
  unsupported and refused (ADR 0306).
- Goal continuation (autonomous re-prompting/timers) is deliberately not
  implemented; the approved Goal runs as one agent turn, exactly like Pi's
  execution path in this release.
