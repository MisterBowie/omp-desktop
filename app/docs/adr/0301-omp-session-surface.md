# 0301 — The OMP conversation surface: events, dialogs and stopping

- Status: Accepted
- Date: 2026-09-23
- Scope: M3 (T11–T13). Amends 0300 (engine boundary) by opening the OMP
  capabilities those tasks ship.
- Evidence: `docs/validation/M3-workflow.md`, `app/experiments/omp-bridge/`
  (E02/E03/E04/E05/E08/E10 captures from M1),
  `packages/omp-runtime/src/session/*`, `apps/desktop/test/omp-session-e2e.test.mjs`

## Context

M2 left the desktop able to *own* an OMP runtime but not to talk to it: every
capability was closed and an OMP session was refused at the engine gate. M3 has
to serve real conversations in the existing UI — text, thinking, tools, usage,
errors, approvals, questions and stopping — without teaching the renderer about
a second engine and without inventing a second permission system.

The pinned runtime's own shapes decide most of this (recorded in M1 and
re-verified against the submodule during M3):

- Events arrive as `AgentSessionEvent` frames (`session.subscribe` in
  `modes/rpc/rpc-mode.ts`), a union rooted in `packages/agent/src/types.ts`.
- Dialog frames are `extension_ui_request` with a `method` discriminator; the
  reply is one `extension_ui_response` per `id`
  (`extensions/approval-protocol.ts` mirrors the type union).
- The `tool_call` extension hook runs **before** the call is scheduled, so a
  blocking hook is a genuine pre-execution gate; a blocked call still produces
  `tool_execution_start`/`_end` with the denial as the tool's result.
- Stopping is two commands: `abort` (`session.abort`) and, separately,
  `abort_bash` (`session.abortBash`), which targets the running command only.

## Decision

### 1. One event vocabulary, translated at the boundary

OMP frames are translated into the desktop's existing `AgentEvent` union
(`packages/omp-runtime/src/session/events.ts`); the renderer, stores, tool cards
and error surfaces are unchanged. Rules:

- Nothing on a mapped event is dropped. Tool `args`, `partialResult` and
  `result` are forwarded verbatim; runtime-only fields (`intent`,
  `customWireName`, `tool_stream_update` payloads) travel in the typed
  `ompToolMeta` member of the shared tool events rather than being folded into
  `args` or discarded.
- A tool result is represented once. The runtime emits both
  `tool_execution_end` and a `toolResult` message; the transcript renders one
  row per `toolCallId`, so the message form is folded away and counted.
- Usage carries only what the runtime reports: `input`, `output`, `cacheRead`,
  `cacheWrite`, `totalTokens`. The runtime has no reasoning-token counter, so
  `reasoningTokens` is omitted rather than zero-filled.
- `agent_end` completes a run only when it is terminal (`isTerminal !== false`).
- Unknown frame kinds are counted in `diagnostics().unmappedFrames`; they never
  throw and never become a fabricated row.

### 2. Approvals are structural, never textual

The desktop ships the gate it loads (`packages/omp-runtime/extensions/…`,
passed with `--trusted-extension` since M5/T19-A — an exact file allowlist
that disables ambient extension discovery). A gated call raises a `select` whose
`optionDetails[0].description` carries a versioned descriptor (tool call id,
tool name, risk, reason, arguments, cwd). Classification
(`src/session/ui-requests.ts`) accepts exactly two shapes as an approval:

1. a dialog carrying **our descriptor** (any dialog form), or
2. the runtime's **own** approval prompt, recognised by its exact option tuple
   `["Approve", "Deny"]` (`extensions/wrapper.ts`).

Everything else on the channel is a question, a retraction (`method: "cancel"`)
or a fire-and-forget notice. No rule inspects a title, a reason or any other
user-facing text; a title that merely says "approve" classifies as a question,
and a test asserts exactly that.

Enforcement lives in `OmpUiRequests`, not in the UI:

- **single use** — an entry is consumed as it is answered, so a duplicate or a
  late decision is refused and never written to the runtime;
- **bound** — every entry records the session and the run generation that
  raised it; a decision from a superseded generation, or naming another session,
  is refused;
- **fail closed** — stopping, closing the window, a transport failure or an
  unknown dialog method answers `cancelled: true`, which the runtime resolves as
  "no decision" (deny). A dialog that cannot be presented is cancelled, never
  auto-approved;
- **auditable** — every outcome is recorded (`answered`, `refused-unknown`,
  `refused-duplicate`, `refused-stale`, `cancelled`) for the validation report.

Approvals surface to the UI as the existing `tool_permission_request` event and
questions as `asktool_request`, so `PermissionCard`/`AskToolCard`, their
timeouts and the resolution IPC apply unchanged. A session-scoped allow is
remembered inside the runtime's process by the gate, because only that process
can remember it; the desktop sends the same allow value.

### 3. Stopping follows the runtime's order, and the process is the last resort

`OmpSessionRunner.stop()`:

1. cancel every open dialog (fail closed) before anything else, so a tool that
   is waiting on the user resolves as denied;
2. send `abort` and wait for its acknowledgement;
3. send `abort_bash` **only** while a `bash` tool call is still open (tracked
   from the event stream, not guessed);
4. wait for the turn to converge, bounded (`convergeTimeoutMs`);
5. only if the protocol did not converge, fall back to M2's process-group
   teardown through the supervisor (no in-protocol stop retry: it already
   failed), and report `converged: false` with the teardown's own verdict.

A run generation is closed when it ends or stops. Frames that arrive afterwards
are counted as late instead of being attributed to the next run, and a prompt is
refused while the previous run is still stopping.

### 4. One runtime, one session (M3)

An OMP process hosts one native session with its own transcript. This release
binds a session to the first runtime it prompts, runs it in that session's
project directory, and refuses a different session rather than sharing a
process. Engine-side session switching, resume and model projection are M4.

### 5. Capabilities are opened one at a time

`OMP_ENGINE_CAPABILITIES` opens `prompt`, `stop`, `structuredQuestions` and
`toolApproval` in M3 — each backed by the behaviour above and its tests.
`resume`, `branch`, `steer`, `followUp`, `modelSwitch` and `subagentEvents`
stay closed, and a refusal is final: no path falls back to the Pi runtime for an
OMP session.

## Consequences

- The desktop keeps one transcript vocabulary; OMP-specific structure survives
  inside typed metadata instead of leaking engine branches into the UI.
- A permission decision cannot be replayed: identity, generation and single-use
  consumption are enforced on the desktop side, and the runtime's own request
  settles once.
- The price is a stricter M3 than the UI could show: attachments, steering,
  model selection, resume and free-text extension dialogs are refused (with
  typed errors or a fail-closed cancel) rather than half-supported.
- Subagent tool calls arrive with `hasUI = false` and are therefore denied by
  the gate; making them policy-decidable is M5/T17, and the denial is recorded
  rather than papered over.

## Verification

`packages/omp-runtime/src/session/*.test.ts` (translation, classification,
registry races, runner lifecycle), `apps/desktop/test/omp-session-bridge.test.mjs`
(bridge/IPC wiring, including the Pi path staying untouched) and
`apps/desktop/test/omp-session-e2e.test.mjs` (the real pinned runtime: read →
deny → approve once → run tests → stop a long task). Results and residual
checks are recorded in `docs/validation/M3-workflow.md`.
