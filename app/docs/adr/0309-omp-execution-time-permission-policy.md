# ADR 0309: OMP execution-time permission enforcement (PI's decision table)

- Status: Accepted (M5/T20-C; 2026-10-03); §6 added by the review repair of
  2026-10-03 (grant wire/lifetime and admitted-turn ownership) and **still
  pending the root's independent acceptance**.
- Date: 2026-10-03
- Scope: M5/T20-C (the trusted gate's execution-time decision table, external
  path handling, risk fidelity, the plugin execution mode, and the delegate
  policy). T20-B2 (submit/approve/dispatch) and T20-D (capability opening)
  remain declared, not claimed.
- Amends: ADR 0308 §4 (the card now carries the decision's full policy, not
  just the permission mode), ADR 0304 §5 (the host-tool contract carve-out is
  now enforced at execution, not only in the catalog).
- Evidence: `docs/validation/M5-t20-c-execution-policy.md`,
  `packages/omp-runtime/extensions/omp-desktop-gate.ts`,
  `packages/omp-runtime/src/session/tool-paths.ts`,
  `packages/omp-runtime/src/session/approval-protocol.ts`,
  `packages/omp-runtime/src/session/turn-admission.ts`,
  `packages/omp-runtime/src/session/turn-fence.ts`,
  `apps/desktop/electron/main/runtime/omp-host-tools.ts`,
  `apps/desktop/electron/main/runtime/omp-session.ts`,
  `apps/desktop/electron/main/plugin-host-process.mjs`,
  `packages/omp-runtime/src/session/gate-permissions.test.ts`,
  `packages/omp-runtime/src/session/gate-admission.test.ts`,
  `packages/omp-runtime/src/session/turn-admission.test.ts`,
  `packages/omp-runtime/src/session/tool-paths.test.ts`,
  `apps/desktop/test/omp-session-bridge.test.mjs`,
  `apps/desktop/test/omp-plugin-plan-safe.test.mjs`,
  `apps/desktop/test/omp-execution-policy-e2e.test.mjs`,
  `apps/desktop/test/omp-sidecar.test.mjs`.

## Context

T20-B1 (ADR 0308) made the desktop write one run-scoped state per prompt
(mode, the production mode block, the *effective* permission mode, and the
per-tool `{risk, planSafeActions, origin}` policy table) and had the trusted
gate inject/clamp from it. Execution-time decisions, however, were still the
M3 shape: a gated tool was asked unless the launch-scoped
`OMP_DESKTOP_GATE_MODE` said deny/allow or a session grant existed, the card
risk was a name-prefix guess (`plugin_*` → high, `mcp_*` → medium), and the
plugin execution context hardcoded `mode: "agent"` (`g2`).

PI-Desktop's authority (fixed reference `0111e306`) is the decision order in
`permissions.rs` (`evaluate_auto_with_permission_mode_and_risk_and_path`):

1. a contract mode (Plan/Goal) hard-denies everything outside
   `plan_mode_allows` (`Read|Glob|Grep|Bash|BrowserPreview|new_context`)
   *before* risk, `auto`, grants or external-path exceptions; a plugin tool
   survives only with a non-empty forwarded `planSafeActions` list, and its
   per-action restriction is enforced at execution (`plugin-runtime.ts`);
2. an explicit external path allows under `auto`, allows with a session
   grant, otherwise asks;
3. Low risk allows; `auto` allows; `accept-edits` auto-accepts only Write/Edit;
   a session grant allows; everything else asks;
4. no UI fails closed only where the decision needed the interaction.

## Decision

### 1. The gate decides from the owned snapshot, in PI's order

`decideToolCall` consumes the validated state snapshot (mode, effective
permission mode, host-tool policy table) and applies PI's order. The contract
hard deny runs for *every* tool the hook sees, before the legacy fixture
switch, `auto`, Low risk, grants, external paths or no-UI handling can matter;
`ask` and the PI-only `BrowserPreview`/`new_context` names stay
contract-allowed (the runtime ships no `BrowserPreview` and nothing fabricates
one), while OMP's `browser`/`computer`/`eval`/`apply_patch` and every unknown
name are denied in contract modes. Rejection reasons carry PI's codes
(`WRITE_DISABLED_IN_PLAN`, `EDIT_DISABLED_IN_PLAN`, `PLUGIN_DISABLED_IN_PLAN`,
`TOOL_DISABLED_IN_PLAN`).

The legacy launch switch is fixture-only and subordinate: `allow` cannot
resurrect a contract-denied tool, and the production launcher never writes it.

### 2. External paths use PI's host-core resolver, ported

`session/tool-paths.ts` reproduces `crates/host-core/src/workspace.rs`:
lexical `.`/`..` normalization with root clamping, component-wise (and
Windows-case-insensitive) containment, deepest-existing-ancestor
canonicalization with bounded dangling-symlink following, the two-root
(workspace, scratch) tool resolver with the advertised-spelling rewrite, and
`requires_external_path_permission` for `Read|Glob|Grep|Write|Edit`. The OMP
session has no scratch root (the desktop's scratch directory is a Pi-sidecar
concept), so the gate passes `null`; the parameter is kept and tested so the
semantics stay identical to PI if a scratch root is ever wired.

### 3. Risk comes from the declaration, never the name

Native risk is PI's `tool_risk_with_declared` mapping (`read`/`glob`/`grep`
Low; `write`/`edit`/`bash` High; everything unnamed — including
`apply_patch`, `eval`, `browser`, `computer`, `BrowserPreview` — Medium).
Host tools use the state policy table: the plugin's declared `low|medium|high`
(a missing/unregistered declaration is Medium, PI's default), and `mcp_*` is
Low (PI host-core) — but only outside contract modes, where the hard deny
precedes it. The card's risk is the decision's risk.

The default gated native set now also names `browser`, `computer` and
`browserpreview` so the PI-unknown Medium capabilities ask under
ask/accept-edits instead of running unapproved; `browserpreview` is inert in
this runtime (no such tool exists) and exists only so the PI contract name is
judged rather than defaulted.

### 4. Plugin execution receives the admitted turn's real mode

The bridge records the policy of the admitted turn (`{turnId, mode}`);
`OmpHostToolBinding.modeForTurn(turnId)` answers only for that exact turn and
`null` otherwise. The executor reads it after `dispatchable()` and before any
dispatch: `null` refuses the call, user MCP tools are refused outside `agent`
(PI host-core denies `mcp_*` in contract modes before the plugin bridge), and
the plugin context receives the real mode, so PI's per-action
`planSafeActions` guard enforces the declaration at execution.

The plugin child API (`plugin-host-process.mjs`) now forwards
`planSafeActions` to `agent.registerTool`. This is a fork fix of an upstream
PI gap: the host registry already reads `descriptor.planSafeActions`
(`plugin-runtime.ts` `normalizePlanSafeActions` + the execute guard), but the
upstream child never forwarded it, so a runtime-declared plan-safe list could
never reach the guard.

### 5. Failure, delegation and card coherence

- With the mandatory channel on, an unreadable/invalid/foreign state for an
  interactive session blocks every call (`policy-unavailable`) — a mutable
  state failure during execution can never turn a contract refusal into an
  approval, and "cannot read the policy" is never silently Agent.
- A delegate (`hasUI=false`, real subagents) uses the owning session's last
  validated snapshot while it is within the existing state age bound (PI
  decides subagent calls under the parent's durable policy); with no fresh
  snapshot it blocks. Delegates never get a card, and `auto` allows them just
  as it allows the parent — no mode/skill/memory injection or elevation.
- The approval descriptor carries `risk`, `mode`, `permissionMode` and the
  decision reason from the same policy object; the dialog and the enforced
  decision cannot disagree.

## Consequences

- `g2` (hardcoded plugin mode) is retired to the behavior tests referenced
  above; `g3` (approved-plan dispatch refusal) stays open, as do T20-B2/D.
  `plan`/`goal` capabilities remain closed; no `SubmitPlan`/`SubmitGoal`
  registration, approval dispatch, or UI capability is added by this ADR.
- Contract-forbidden tools that B1's clamp hides are refused by the catalog
  before the gate sees them; the gate-level hard deny is proven by the gate
  unit tests and the compiled-bundle probe (the production E2E states that
  layering honestly and does not claim a gate refusal for a not-found tool).
- The gate now reads the filesystem for external-path decisions (live
  metadata, like host-core); a tool call with a `path` argument costs a few
  `lstat`/`realpath` calls, bounded by the existing dangling-link hop limit.
- `OMP_DESKTOP_GATE_TOOLS` adds native names to the gated set. For an owned
  (admitted) turn it can only add to the product default — never shrink it —
  and the default list grows by the three PI-unknown Medium names.

## 6. Review repair (2026-10-03): granted scope and the admitted snapshot

The first independent review of M5/T20-C found two P1 defects in the real
production path. Both are repaired here; the accepted behaviors above are
unchanged.

### 6.1 The session scope must survive the runtime, and cross the wire intact

`responseFor` mapped both `allow-once` and `allow-session` to the gate's first
option, so a real "Allow for this session" decision was downgraded on the wire
and the gate never granted the scope (its `sessionAllowed` set was process
memory, which a same-session runtime replacement — the B1 Plan → Agent
rebuild — discarded anyway). The repair:

- the wire carries the exact option the user picked: `allow-session` becomes
  `OMP_APPROVAL_OPTIONS[1]`, and the gate grants the scope only on that label
  (the runtime's own approval prompt, `["Approve","Deny"]`, keeps its existing
  mapping and has no session scope);
- the grant store is the desktop session's, in the bridge's process, keyed by
  desktop session id and tagged with the native session that minted it —
  the counterpart of PI's in-memory `AppState.session_grants` (`permissions.rs`
  §1.3.1, `rpc/mod.rs` `permissions.listSessionGrants` /
  `permissions.clearSessionGrants`; `session.configure` deliberately does not
  clear grants). It is minted in exactly one place — a delivered
  `resolvePermission(requestId, "allow-session")` for a live gate approval, so
  a stale, cancelled, failed-send or duplicated resolution can never mint or
  replay one — and it is dropped when a different native identity binds and
  when the session is deleted (`clearSessionGrants`, wired through the delete
  path). Archiving reclaims the runtime but keeps the session row and its
  native identity, so it keeps the grants, exactly where PI keeps them across
  a configured session;
- the grant rides the turn admission (6.2) into every new runtime process, so
  the next prompt of the same session — including one after the B1 rebuild —
  is answered from the desktop session's state. The list is never written to
  disk as an authoritative escalation channel.

### 6.2 One immutable admitted policy per prompt

The gate re-read the run-scoped state file on **every** `tool_call`, so a tool
body that rewrote `permissionMode` inside an admitted Plan/ask prompt relaxed
the rest of that prompt (the second Bash ran with no card), and the
process-global fallback could lend a newer file to a delegate. The repair
introduces one **turn admission**: the desktop-owned `{mode, permissionMode,
hostTools, grants}` snapshot, encoded (`turn-admission.ts`) and installed with
the turn token through the existing fence handshake; the acknowledgment echoes
its digest, so the runner only submits the prompt after the gate holds exactly
that policy.

- **One owner.** Every call of the turn — the owning session's own calls and
  its delegates (`hasUI=false`, PI's subagent-under-parent-policy semantics) —
  decides from the admitted record. The mutable state file is never re-read
  for policy on the product path; a file rewritten mid-turn cannot relax the
  mode, nor swap the risk/plan-safe table. A record whose turn never started,
  a foreign interactive session, and (with the mandatory channel on) a process
  with no record all fail closed.
- **Ownership window.** `agent_start` arms the record, a terminal `agent_end`
  retires it (a scheduled continuation keeps it), and a start refusal clears
  it, so a late callback cannot borrow a stopped/refused/finished turn's
  policy. The bridge also nulls its `admittedTurnPolicy` synchronously on stop
  and on disposal, keeping the host-tool mode lookup (`modeForTurn`) coherent
  with the same admitted policy.
- **Next prompts resolve anew.** Every new user prompt still performs the B1
  mandatory owned read/validation, the exact mode-block injection and clamp,
  and re-resolves the settings; the new admission then replaces the old one
  wholesale. A payload-less host (a fixture that drives the gate without a
  payload) keeps the pre-repair shape *frozen per turn*: the first validated
  read of the fenced turn becomes its admission, so the same mid-turn rewrite
  cannot move the decision there either.
- **Fixture switches are subordinate.** For an owned admission the legacy
  `OMP_DESKTOP_GATE_MODE` is ignored entirely (it may not allow or deny around
  PI's order), and `OMP_DESKTOP_GATE_TOOLS` can only add gated native names to
  the product default, never shrink the set. The reachable contract is
  unchanged and stated here: the product gate adjudicates the configured
  side-effect native names plus every desktop host tool (`plugin_*`,
  `mcp_*`); a native name outside both sets is not adjudicated by this gate
  (OMP's own tool approval still applies), and whenever an unknown name *is*
  adjudicated — a host tool missing from the policy table, a gated name not in
  the risk map — its risk is Medium (PI's default), never Low.
- **Tool paths.** The ported resolver always joined relative paths to the
  workspace and treated a relative escape (`../outside`) as external, exactly
  as PI's `requires_external_path_permission` does; the comment claiming
  otherwise was wrong and is corrected (`tool-paths.test.ts` pins it). The
  macOS `/var` alias behavior is PI parity: the canonical root is lexical,
  aliases are realpath-resolved afterwards, and the review's canonical-path
  variants pass unchanged. No symlink/relative-escape containment was
  weakened.
