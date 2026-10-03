# ADR 0311: OMP model-side mode entry (EnterPlanMode / EnterGoalMode)

- Status: Accepted (M5/T20-D-Enter; 2026-10-03). Implementation complete and
  pending the root's independent review. Does **not** open the `plan`/`goal`
  engine capability keys, does not touch the Cursor + Plan/Goal gate (ADR
  0306), and does not claim M5/T20 completion.
- Date: 2026-10-03
- Scope: the two model-side contract entries, their same-turn trusted
  transition (system prompt, tool catalogue, execution policy), the fork patch
  level `.5` that makes the live prompt replacement possible, and the
  failure/stop semantics of a committed-but-unprepared transition.
- Amends: ADR 0310 §2 (the desktop now also owns the Enter tool definitions
  and the `plans.enter` endpoint), ADR 0308 (the contract catalogue gains the
  Agent-side entry tools), ADR 0309 §5 (the decision table's contract branch
  is unchanged; the admission it reads can now move mid-turn).
- Evidence: `docs/validation/M5-t20-d-mode-entry.md`,
  `app/patches/oh-my-pi/manifest.json` (patch level `.5`),
  `app/packages/omp-runtime/src/session/mode-transition.ts`,
  `app/packages/omp-runtime/src/session/turn-failure.ts`,
  `app/packages/omp-runtime/extensions/omp-desktop-gate.ts`,
  `app/apps/desktop/electron/main/runtime/omp-host-tools.ts`,
  `app/apps/desktop/electron/main/runtime/omp-session.ts`,
  `app/apps/desktop/test/omp-mode-entry-unit.test.mjs`,
  `app/apps/desktop/test/omp-plan-submit-e2e.test.mjs` (T20-D cases),
  `app/packages/omp-runtime/src/session/gate-mode-transition.test.ts`,
  `app/packages/omp-runtime/src/session/mode-transition.test.ts`.

## Context

The fixed PI contract gives the Agent a second way into the two contract
modes: `EnterPlanMode` / `EnterGoalMode` are Agent-only tools that call the
host's `plans.enter`, and a **successful entry does not end the durable turn**
— the same run continues with the new mode's system prompt and tool
catalogue, and only `SubmitPlan`/`SubmitGoal` terminates (`runtime.ts:3595-3630`,
`runtime.test.ts:2138-2320`; product spec §5b and state machine rule 12).
PI's contract also makes each of the four transition tools the only tool call
of its assistant batch.

The non-Cursor OMP route reached T20-B2 with the submit half implemented and
no entry half: the desktop host-tool catalogue registered only
`SubmitPlan`/`SubmitGoal`, and the Agent catalogue contained neither Enter
tool (baseline evidence in the validation record). The runtime gap behind that
was concrete:

- the trusted extension API can replace the active tool set mid-run
  (`setActiveTools`), and the agent loop re-reads both the live system prompt
  and the tool set before **every** provider request
  (`syncContextBeforeModelCall`), so a mid-run update is observable by the
  next request of the same run;
- but no public extension surface could replace the live system prompt.
  `before_agent_start` does not fire on a tool-only iteration — a second
  prompt cannot serve a same-turn transition — and the per-provider payload
  hooks (`before_provider_request`) differ per provider and do not run for
  every provider, so rewriting provider-shaped payloads is not a contract.

Public API alone therefore cannot move all three pieces (prompt, catalogue,
policy) in the same tool turn; the missing piece is one narrow, optional
extension action (fork patch level `.5`), after which the same-turn transition
is implementable without touching private agent/session state, without
monkeypatching the loop, and without trusting tool-result text.

## Decision

### 1. The desktop owns both entries, exactly as PI defines them

`desktopEnterToolCatalogEntry(kind)` registers `EnterPlanMode` /
`EnterGoalMode` with PI's verbatim names, descriptions and the empty-object
schema (`{ type: "object", properties: {} }`), declared `loadMode:
"essential"`, `concurrency: "exclusive"`, `batchPolicy: "sole"` and
`terminateOnSettle: false` — entry commits the durable mode and the same turn
continues. The bridge appends both entries to an **Agent-mode** catalogue
only; a contract mode exposes its own submit tool instead. The policy table
carries `{risk: "low", planSafeActions: [], origin: "desktop"}` for both, so
the card/risk lookup never guesses from the name (PI classifies both Low).

The entries run through the same executor as the submit tools, and identity
comes only from the binding and the frame: `{sessionId, turnId: hostTurnId,
toolCallId: frame id, kind}`. Model-supplied arguments are ignored (the schema
accepts none). A call in a non-Agent mode, without a durable host turn, or
without a wired `plans.enter`, fails closed before the host call; the host's
own `plans.enter` remains authoritative for the durable rules (mode must be
Agent, live running turn with exactly the bound id, no queued/running
execution, CAS mode write). A reply must be exactly `{ok: true, state:
"planning", kind}` before the desktop treats the entry as committed.

### 2. The same-turn transition is one trusted host-authored record

After `plans.enter` commits, the desktop prepares the live turn and hands the
trusted gate a record (`session/mode-transition.ts`) on the settled result's
`details`:

1. the bridge records the new mode for this exact live turn (`modeForTurn`),
   so a submit attempt, plugin execution or user-MCP call in the same turn is
   judged under the new mode;
2. it re-registers the desktop host tools for the new mode's catalogue — the
   Enter tools leave, the new mode's submit tool is registered (the runtime
   auto-activates it) — so the clamp that follows can keep it;
3. it returns the exact `composeModeSystemPrompt(kind, "")` block and the new
   policy table to the adapter, which encodes them into the record.

The record names every identity the runtime can check: the native session,
the durable host turn the host validated, the run's own live generation id
(diagnostics), the exact tool-call id, the expected previous mode (always
`agent`) and a single-use state. The gate's `tool_result` handler — awaited by
the runtime's tool wrapper, so it runs after the call settled and before the
next provider request — validates the record against the **live admission**:

- a live admission exists, its turn has started, and its fence token is the
  live generation's token;
- the record names the admitted session and the event's own tool call;
- the record names the same tool that produced the result, and the direction
  is Agent-only;
- the admission has not already been transitioned (one transition per turn;
  the Agent-only direction and the transitioned catalogue leave no lawful
  second entry).

Only then does it apply, in order: the new system prompt (rebuilt from the
parts the gate itself injected at start — the runtime's base stays
byte-identical, the capability block appears once, only the mode block
changes), a new admission record with the transitioned snapshot, retirement
of the previous record's delegate bindings, and the contract tool clamp for
the new mode. The next provider request of the same run reads all three from
the live session, so the model sees the new contract in the same turn.

Delegates: a delegate bound to the prompt-time record is retired with it and
fails closed afterwards; the transitioned catalogue contains no tool that can
spawn a new delegate in a contract mode.

### 3. Fork patch level `.5`: one optional extension action

`ExtensionAPI.setTurnSystemPrompt(prompt: string[])` (backed by
`AgentSession.setTurnSystemPrompt`) registers a replacement as the turn's own
system-prompt override: every provider request of the running turn re-reads
it, a base-prompt rebuild inside the turn preserves it, and the next prompt
preparation drops it. It is optional — every other `ExtensionActions` host
leaves it undefined and the API rejects the call — so ordinary OMP runs,
other hosts and non-desktop sessions are unchanged. The action validates its
input (non-empty array of strings) and throws otherwise.

### 4. Failure and Stop semantics: never a half-switched turn

The transition is applied only when the whole record is valid **and** the
desktop could prepare it. Everything else fails the turn closed:

- an ordinary host refusal (wrong mode, stale turn, a pending execution)
  arrives as an error result **without** a record: a correctable tool error,
  no transition attempted, the turn keeps its Agent contract;
- a record that fails attribution, a record that reports `state: "failed"`,
  or an Enter success without a valid record fails the started turn: the gate
  retires the admission, emits a versioned `omp-desktop-turn-failure` notice
  and aborts the run. The runner honors that notice only for the live
  generation (native session, fence token, `running` state) and closes it as a
  failed turn — one terminal `error` envelope and an `error` turn-end
  announcement — so the desktop does not misreport an internally aborted run
  as completed, the bridge settles the durable host turn as failed, and no
  further provider request or tool call can run under the half-applied
  contract;
- a prompt replacement or clamp that throws after the host committed takes the
  same path, and the admission is retired first so a late call cannot decide
  under it;
- a Stop/dispose that lands while `plans.enter` is in flight is re-checked
  after the RPC and after the desktop preparation; the host has committed, so
  the adapter reports a failed record rather than a success, and the durable
  host row remains the explainable fact the next prompt rebuilds from.

The durable host row is the recovery source: the next prompt reads the
session's mode from the host (`sessionPolicy.policy`) and assembles the new
mode's admission, catalogue and prompt from scratch. Nothing rolls back the
committed mode and nothing pretends it was not committed.

### 5. Batch and termination semantics are unchanged

`EnterPlanMode`/`EnterGoalMode` are sole tools under the `.4` batch rule: a
batch that carries one plus any sibling (native, host or unknown, in any
order) is rejected whole before scheduling — zero `tool_execution_start`,
zero host calls, zero side effects — the model is answered with blocked error
results and can retry with a sole call. Speculation stays off while a sole
tool is advertised. Enter never terminates; only the mode's own submit tool
does, with the T20-B2 semantics (success, failure, host error and schema
rejection all terminate; external Stop does not).

### 6. Goal remains a single contract turn

No continuation timer, no autonomous re-prompting: the approved Goal runs as
one Agent turn exactly like the approved Plan (D1's deliberate difference
stays recorded). `EnterGoalMode` only moves the same Agent into the Goal
contract; `SubmitGoal` publishes `.pi/goal/<unique-name>.md` through the
unchanged host path.

### 7. First independent review repair (2026-10-03): the failure channel and generation ownership

The root's independent review reproduced four production gaps at the real
bridge/gate/adapter/host layer; the repairs below keep the §1-§6 contracts and
add no new protocol surface (no fork change, no patch-level move).

1. **A structured error must survive to the gate.** The frame's top-level
   `isError` is the runtime's *reject* channel: `.5`'s
   `RpcHostToolBridge.handleResult` throws the text and discards the settled
   value, including `details` — so a `state: "failed"` transition record sent
   that way never reached the gate, the error stayed "correctable", and the
   turn continued under a committed mode. An error outcome that carries
   `details` is now settled as the protocol's documented other error shape
   (`result.isError: true`, no top-level flag): the agent loop reads
   `frame.isError || result.isError`, and the extension `tool_result` hook
   receives the flag **and** the details. Outcomes without details keep the
   unchanged top-level path.
2. **"Undecidable commit" is not "correctable refusal".** Only the host's four
   pre-CAS refusals (`PLAN_INVALID_ARGUMENT`, `PLAN_SESSION_NOT_FOUND`,
   `PLAN_ALREADY_ACTIVE`, `PLAN_APPROVAL_STALE`) prove that nothing was
   written. An unreadable reply, a transport failure, a timeout or an unknown
   error code can follow a commit whose response was lost, so the adapter
   reports a `state: "failed"` record and the turn stops; the next prompt
   recovers from the durable row.
3. **The transition continuation is bound to its own generation.** The
   `tool_result` handler awaits twice (prompt API, clamp); a terminal
   `agent_end` and a successor turn can be armed in those windows. Every await
   now re-checks exact identity — the record object the continuation owns
   (updated once, when it installs the transitioned copy) plus the token the
   record was validated against — and a continuation that lost ownership must
   not replace the live record, retire the successor's delegate bindings,
   overwrite the cached prompt parts, apply the old clamp, emit a failure
   attributed to the successor's token or abort its context. Failure
   descriptors take the token captured when the failure was decided.
4. **The desktop preparation is bound to its own live turn.** `enterMode`
   re-checks, after the catalogue assembly and around the runtime
   registration, that the entry is not closed/stopping, that the admission
   record and runner are still the same objects, and that the runner still
   reports this very turn as its running current turn; the registration
   helper re-checks the same guard immediately before sending `set_host_tools`
   and again before trusting the acknowledgment and publishing the cache
   fingerprint. A stopped or superseded Enter can therefore neither register a
   catalogue on the successor's runtime nor poison the registration cache.

Notes that are contracts, not implementation details:

- The durable host turn vocabulary is `running | completed | aborted | error`
  (host-core `end_turn_settling`; product type unions match). A failed
  post-commit transition settles the turn as **`error`** — the same terminal
  the runner already uses for a failed turn — never `completed`.
- A known host refusal remains a correctable tool error; the repairs
  deliberately keep that path so wrong-mode/stale-retry scenarios are not
  disabled.

## Consequences

- A non-Cursor OMP session can now enter Plan or Goal from the model, in the
  same durable turn, with the PI prompt block and the contract catalogue
  visible to the very next provider request, and can then submit through the
  unchanged approval/dispatch loop (T20-B2).
- The three pieces move together or the turn fails: there is no observable
  state in which the prompt, the catalogue and the gate's policy disagree, and
  no path in which an old Agent-era admission keeps deciding for a
  transitioned turn.
- Two pieces of runtime-side state remain outside the runtime's own view and
  are recorded as limitations: the durable turn/mode validation lives in the
  host (`plans.enter`), and the gate's live-generation binding is the fence
  token plus the in-process origin of the result event — the record's
  `liveTurnId` is diagnostic, not a check the gate can perform (the pinned
  runtime exposes no live-generation identity to extensions).
- Patch level moves to `62bc57b+omp-desktop.5` (fork branch
  `codex/omp-desktop-18.3.0-patch-5`); the `.4` artifact and coordinates stay
  in the manifest history. The pinned submodules do not move.
- `plan`/`goal` capability keys remain closed, the composer entry is
  unchanged, and the engine-gated capability/UI acceptance stays T20-D; the
  Cursor + Plan/Goal combination remains unsupported and refused (ADR 0306).
