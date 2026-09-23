# ADR 0303: OMP subagent surfacing, attribution and the stop boundary

- Status: Accepted
- Date: 2026-09-23
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
responses. A frame missing its child id, a valid `parentToolCallId`, a sane
status or an `agentSource` is *rejected* (counted as malformed), never cast and
never forwarded as a parent event. A `subagent_event` payload carries only
`{ id, event }`; its owning parent and agent come from the lifecycle/progress
record, and an event whose id is not in the registry is refused.

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
to refresh the row. The `sessionFile` is kept on the record for the transcript
read but never appears in `list()` or the read result.

### 5. Reconciliation, ownership and the restart boundary

`get_subagents` is reconciled into the registry while the runtime is alive: a
snapshot repairs a missed `started`/progress frame without duplicating a child
or replaying tool side effects. A child frame that arrives after its parent turn
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

Fixed OMP exposes no per-child stop command, and a child session has no
trustworthy child-owned process handle to terminate without risking the parent
or siblings. `stopSubagent` therefore always returns a typed
`capability-unavailable` refusal with an accurate explanation; the UI keeps
individual child stop disabled rather than silently calling a parent abort.

### 7. Capability

`OMP_ENGINE_CAPABILITIES.subagentEvents` is opened, backed by the behaviour and
tests above. `branch`, `steer`, `followUp` and `compact` remain closed.

## Consequences

- OMP children render through the existing Pi cards/topology/detail/work-panel,
  with no second UI model and no engine branch in the renderer.
- Malformed or ownership-ambiguous frames are counted, never attributed to the
  parent or a newer generation.
- Child detail requires `--model` (the explicit projected binding); a build that
  omits it would show topology/progress but no child transcript, which is exactly
  the gap the projection now closes.
- Per-child stop is visibly unavailable with an accurate reason; stopping a
  child means stopping the parent run.
- Pi subagent orchestration, catalog, panels and tests are unchanged.
