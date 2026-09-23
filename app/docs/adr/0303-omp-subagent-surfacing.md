# ADR 0303: OMP subagent surfacing, attribution and the stop boundary

- Status: Accepted (M5/T17 for the implemented capability boundary — accepted code baseline `ab07a888d6afb916561b80e5661ed27aa6be612a`; macOS arm64 independent review and real fixed-OMP E2Es pass; the macOS full desktop run's 9 failures are pre-existing fixed-PI release-fixture Chinese-path issues tracked at M6/T22, so the full macOS desktop suite is not claimed green; limitations — no per-child stop RPC, child `hasUI=false` tool gating, batch topology approximation, closed modes — remain as documented below)
- Date: 2026-09-23 (revised 2026-09-24 for the B1/C1 stop-boundary and runtime-replacement fixes, the B3 whole-row UTF-8 budget, and again for the B3 follow-up allocation priority and truncation indication; accepted 2026-09-24)
- Scope: M5/T17. Amends 0301 (conversation surface) by wiring the subagent
  frame families into the existing Pi delegation renderer, and 0302 (per-session
  registry) by adding a per-child registry inside each session's runner.
- Evidence: `docs/validation/M5-subagents.md`,
  `packages/omp-runtime/src/session/subagent-frames.ts`,
  `packages/omp-runtime/src/session/subagents.ts`,
  `packages/omp-runtime/src/session/runner.ts`,
  `apps/desktop/electron/main/runtime/omp-session.ts`,
  `apps/desktop/electron/main/runtime/omp-session-wiring.ts`,
  `apps/desktop/electron/main/ipc/agent-ipc.ts`,
  `apps/desktop/test/omp-subagent-e2e.test.mjs`.

## Context

The pinned OMP runtime reports children through three frame families on the
rpc-ui stdout — `subagent_lifecycle`, `subagent_progress`, `subagent_event` —
and answers two read commands, `get_subagents` (live snapshots of *active*
children) and `get_subagent_messages` (a byte-cursor read of one child's durable
transcript). M1 (E08/E11) established the wire facts: the frames carry a stable
child `id`, a `parentToolCallId` naming the parent `task` tool call, and (on
lifecycle/progress/snapshot only) an absolute `sessionFile`; a child session
runs with `hasUI=false`, so its gated tools can never borrow the parent's
interactive approval; and the parent `abort` does not stop a detached child.

The Pi desktop already renders delegations — the `task`/`Task` tool row is the
topology node, `TaskWait`/`TaskList`/`TaskStop` lifecycle rows carry
`delegations[]`/`stopped[]` rosters, and child rows stream as `UiMessage`s with
`parentToolCallId`/`agentName` (ADR 0062, ADR 0089). T17's job is to feed that
existing renderer from the OMP frames, not to build a second subagent UI.

## Decision

### 1. OMP is the only subagent orchestrator for OMP sessions

An OMP session's children are spawned by OMP's native `task` tool and reported
by the three frame families above. The desktop never launches the old Pi
`Task`/`TaskWait`/`TaskList`/`TaskStop` runtime for an OMP session, never
duplicates a task, and never translates an OMP tool into a same-named Pi tool.
The Pi subagent catalog channels (`subagentList`, `subagentCatalog`, …) stay in
the Pi IPC module, untouched by the OMP surface; the OMP read channels are new
and separate (`ompSubagentList`, `ompSubagentRead`, `ompSubagentStop`).

### 2. Strict validation, not a cast

`subagent-frames.ts` typebox-validates the three frame payloads and the two read
responses. A frame missing its child id, a sane status or an `agentSource` is
*rejected* (counted as malformed), never cast and never forwarded as a parent
event. A `subagent_event` payload carries only `{ id, event }`; its owning parent
and agent come from the lifecycle/progress record, and an event whose id is not
in the registry is refused.

Ownership is a separate, fail-closed check in `subagents.ts`, because the wire
`parentToolCallId` is genuinely optional on the pinned runtime's frames. A child
may only surface — or settle — after its parent id names an *observed* `task`
tool call owned by this runner/session (`observeTaskStart` recorded it). A
`started`/`terminal` lifecycle, a progress frame or a snapshot row whose parent
is missing, unknown, or conflicts with the child's already-bound parent is
counted (`unknownParentCalls`) and dropped; it is never attributed to the parent
or to whatever runs next. `emitSynthesis` never falls back to the current run: a
synthesis whose owning task call has no recorded turn is dropped rather than
guessed.

### 3. Subscription, after readiness

The runner sends `set_subagent_subscription level: "events"` exactly once, after
the supervisor has validated the `ready` frame and the native session is
established. A refused or failed subscription leaves the level `off`, and the
list/read paths then report a typed failure rather than a partial picture.

The pinned runtime only forwards a child's `subagent_event` frames when its
model is selected explicitly: `--model provider/model`. Discovery from
`models.yml` alone leaves the child's event stream unwired (a real upstream
fact, reproduced in the E2E before the fix). Because 0302's projection already
pins one provider and one model, the wiring now passes the same binding as
`--model` alongside the projection (`omp-session-wiring.ts`); this is the
product-visible change that makes child detail stream.

### 4. Per-child conversion and attribution

Each child gets an isolated `OmpEventConverter` (its own message-id sequence,
scoped by child id). Only message and tool rows are forwarded; `agent_end`,
`turn_end`, `error` and every other session-level frame stay inside the child,
exactly as Pi's own `SubagentRun.handleEvent` does, because Electron main ends
the durable turn on those and a child finishing must never end its parent's
turn. Forwarded rows carry `parentToolCallId` and `agentName` on the envelope
and on the assistant message.

Lifecycle and progress feed the existing topology: the parent `task` tool's
`toolResult.details` is augmented with `delegationId`/`agent`/`status`/
`startedAt`/`completedAt` (the fields `subagent-topology.ts` reads), and a
terminal lifecycle emits the same `message_end` (role `tool`) settlement Pi uses
to refresh the row. The settlement is a *root* Task-row refresh: its envelope
carries the owning task call only as an internal `owningToolCallId` (used to
recover the turn), never as `parentToolCallId` — stamping `parentToolCallId`
onto the settlement would file the Task row as a child and drop the card from
the root transcript on reload. The `sessionFile` is kept on the record for the
transcript read but never appears in `list()` or the read result.

### 5. Reconciliation, ownership and the restart boundary

`get_subagents` is reconciled into the registry while the runtime is alive: a
snapshot repairs a missed `started`/progress frame without duplicating a child
or replaying tool side effects. A previously-`running` child that is *absent*
from a snapshot reached a terminal state this desktop missed (fixed OMP removes
terminal children from its active registry); it is represented as `aborted`
("interrupted/unavailable" in the Pi topology vocabulary) and its parent Task
row is settled exactly once — marking it terminal makes the settlement idempotent
across repeated snapshots. A child frame that arrives after its parent turn
closed is still attributed to the turn that spawned the `task` call (the runner
keeps `task toolCallId → { generation, turnId }`), never to whatever runs next.
`dispose` resets the registry and detaches the frame handler, so a stopped or
replaced runtime cannot leak late frames into a new generation.

On restart the registry is empty. A detached child is never claimed to be still
running and never replayed: the durable parent transcript carries whatever was
persisted (completed/failed when recorded), and the existing `turnLive: false`
topology rule renders any leftover `running` node as `aborted` — the honest
"interrupted/unavailable" reading. Fixed OMP cannot reopen a live child registry
after the process is gone; that boundary is recorded, not papered over.

### 6. Approval and the stop boundary

A child's gated tool (`write`/`edit`/`apply_patch`/`bash`/`eval`) travels the
same `tool_call` hook as the parent's, but the child session has `hasUI=false`,
so the gate's `no-ui` route blocks it before execution — fail closed, no side
effect, and never borrowed from the parent's interactive identity. A
policy-allowed child tool (`mode: allow`, or a prior `sessionAllow`) executes
exactly once and stays attributed to that child. Parent stop, dispose and
shutdown invalidate pending decisions through the existing M3 generation/session
checks; a late allow can never execute after stop.

Parent `stop` does not report clean convergence while an owned child is still
active. After the parent turn converges it *always* reconciles against
`get_subagents` — the live snapshot, not the local registry, is the authority
for "no child", because a missed lifecycle/started frame, a lost subscription,
or a list that was never opened leaves the registry empty while the child is
still alive. If a valid snapshot shows an owned child still running, the runner
tears down through the existing supervisor process-group boundary, which
reclaims the parent and every child it spawned (measured end-to-end: the child's
real command tree is gone after the stop). A refused or malformed snapshot is
conservative: when a `task` call was observed it tears down (recording why)
rather than claiming the process group is child-free. The registry and task-call
ownership are cleared only after a *confirmed* reaped teardown; a teardown that
fails to reap (or throws) retains them — matching the supervisor's
ownership-retained-for-retry semantics — so a late frame is still attributed to
its turn and a later stop/dispose can re-run the teardown.

The stop operation owns the prompt gate for its entire span — abort,
convergence, the child snapshot and the teardown — not just until the turn
reports idle. `agent_end` closes the run (state becomes idle) while the stop is
still reconciling or tearing down, so a second prompt is refused with a typed
`stopping` error for the whole stop (and any pending-reclaim retry), and a
completion that names an older generation never closes a run the runner has
already superseded. A run whose group was reaped but whose directory survived
is a directory-only debt: the bridge's teardown re-runs the supervisor sweep on
every subsequent stop until no retained run directory remains, and never
signals the ids of an already-reaped record.

When a teardown fully reaps the process group *and* removes the run root, the
runner is retired: its frame/failure handlers are detached and its runtime
handle is dropped. The next explicit prompt in the same desktop session rebuilds
a fresh runtime and runner, re-issues `switch_session` (restoring the same
validated native session — never a fresh session, never a replay of prior
tools) before exactly one prompt, and continues the turn counter from the
retired runner, so the new turn id is distinct from every turn the session has
already run. A converged protocol stop (no teardown) keeps the live runtime and
its runner; a failed or in-flight stop keeps the runner and its retryable
obligation, so a prompt is refused rather than starting a second runtime. The
rebuild and the native restore are single-flight, so concurrent prompts share
one runtime and cannot double-submit content or create duplicate runners.

Fixed OMP exposes no per-child stop command, and a child session has no
trustworthy child-owned process handle to terminate without risking the parent
or siblings. `stopSubagent` therefore always returns a typed
`capability-unavailable` refusal with an accurate explanation; the UI keeps
individual child stop disabled rather than silently calling a parent abort.

### 7. Capability

`OMP_ENGINE_CAPABILITIES.subagentEvents` is opened, backed by the behaviour and
tests above. When the runtime refuses or fails the event subscription, the
prompt still proceeds (only this child-surface feature is unavailable), but
`listSubagents` and `readSubagentTranscript` fail closed with a typed
`capability-unavailable` error rather than presenting a partial picture.
`branch`, `steer`, `followUp` and `compact` remain closed.

## Consequences

- OMP children render through the existing Pi cards/topology/detail/work-panel,
  with no second UI model and no engine branch in the renderer.
- Opening an OMP child detail uses the OMP-only bridge (`ompSubagentList` +
  `ompSubagentRead`) to resolve and read the opaque child id, then maps the
  bounded result into the existing `SubagentRun` presentation. Reads are
  incremental by byte cursor: the renderer merges each read's rows into the
  accumulated set by stable entry id, replaces the set on a `reset` response,
  advances the cursor to `nextByte` on every response (including reset), and
  leaves the current detail intact on an empty poll. The read is a local detail
  projection and never persists into the main transcript.
- Malformed or ownership-ambiguous frames are counted, never attributed to the
  parent or a newer generation.
- The durable transcript read projects every row through a single shared
  serialized-UTF-8 budget (4 MiB) that covers all payload-bearing fields of one
  durable `UiMessage` — `content`, `thinking` and the `toolResult` envelope
  (`{ content, details }`). The fixed envelope (id, role, timestamps, tool
  identity, status) is measured first and subtracted, so the whole serialized
  row is bounded to 4 MiB with no separate allowance. Byte accounting follows
  `JSON.stringify`: string keys and content are charged in their escaped UTF-8
  form (quotes, backslashes, C0 controls, multibyte code points), and scalars,
  separators and container syntax are all charged. Truncation walks code points
  and appends `…`, so a surrogate pair is never split. Text-only results keep
  their text in the row's `content` (with `toolResult` empty), structured
  results keep it in the envelope's text blocks for the Pi delegation-report
  and lifecycle-summary paths, so the same text is never serialized twice; a
  raw unbounded `content` never crosses the bridge into the renderer.
  Allocation is answer-first: `content` is charged before `thinking`, so
  oversized reasoning can never erase a short final answer — this priority is
  shared by the durable `convertEntry` and the live `message_start`/`message_end`
  paths, which therefore retain the final answer too. When the bound drops
  anything (a long string, an array item, an object key, or a whole field), the
  row still says so: the presenter's existing `details.truncated` flag is set
  (a record `details` gains the key directly; a non-record `details` is wrapped
  as `{ truncated: true, value }`), reserved from the same budget so the
  indication renders without exceeding the bound and without inventing original
  counts.
- Child detail requires `--model` (the explicit projected binding); a build that
  omits it would show topology/progress but no child transcript, which is exactly
  the gap the projection now closes.
- Per-child stop is visibly unavailable with an accurate reason; stopping a
  child means stopping the parent run (which also reclaims the child).
- Pi subagent orchestration, catalog, panels and tests are unchanged.
