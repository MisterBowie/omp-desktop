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
- A delegate (`hasUI=false`, a real subagent) is bound to the exact admission
  it started under and decides only while that record is still the live,
  started admission (§7). Delegates never get a card, and `auto` allows a
  *bound* delegate just as it allows the parent — no mode/skill/memory
  injection or elevation.
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
that policy. The digest is an app-owned consistency check between the runner
and the gate inside the one trusted runtime process; it is not, and is not
claimed to be, cryptographic authentication of the desktop (see §7).

- **One owner.** Every call of the turn — the owning session's own calls and
  its delegates (`hasUI=false`, PI's subagent-under-parent-policy semantics,
  bound per §7) — decides from the admitted record. The mutable state file is
  never re-read for policy on the product path; a file rewritten mid-turn
  cannot relax the mode, nor swap the risk/plan-safe table. A record whose
  turn never started, a foreign interactive session, an unbound or retired
  delegate, and (with the mandatory channel on) a process with no record all
  fail closed.
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

## 7. Second review repair (2026-10-03): delegate admission ownership

The §6.2 record still decided a delegate by *"any `hasUI=false` context uses
the process's current admission"*. The reviewing root drove the gate's real
registered callbacks, state serializer and fence/admission codec and showed the
consequence: a child that started under parent turn A (ask) was correctly
blocked under A and after A's terminal end, but the **same old child was then
allowed** once a newer parent turn B (auto) installed its admission — the old
child inherited a policy it never started under. No provider or tool body ran
in that probe; it is a registered-handler counterexample, not a reproduced
native scheduling exploit. The requirement was already explicit and is now
enforced: a delegated context cannot borrow an earlier, newer or foreign
admission.

The repair (`extensions/omp-desktop-gate.ts`, `bindDelegate`) makes ownership
explicit and fail-closed. All of it reads public interfaces only — the
extension lifecycle events (`session_start`, `before_agent_start`,
`agent_start`, `agent_end`), the command context
(`createCommandContext().sessionManager`) and the public
`ReadonlySessionManager` members `getSessionId` / `getSessionFile` /
`getHeader`; no private runtime field is touched and no runtime code is
patched for it:

- **Binding at the delegate's own start.** A no-UI session is bound, once, to
  the admission record that is live and started when its own first lifecycle
  event arrives. The binding stores the record itself, not a token: a later
  fence replaces the live admission, and the delegate then fails closed
  instead of deciding under the new one. The first binding wins; the session
  is never re-pointed.
- **The owning file is captured at the fence.** The admission records the
  owning session's file (`getSessionFile()` of the command context) and the
  wall clock it was armed. A delegate's declared parentage — its header's
  `parentSession`, walked up through the parent links the gate recorded for
  intermediate delegates — must reach that file when both sides expose file
  identity, and every intermediate hop must itself carry the exact admission
  record being claimed (§7.3); a chain that resolves to a different session,
  or through a retired, other-generation or unattributed intermediate, is
  refused.
- **Delayed starts are never adopted.** A delegate session whose public
  header shows it was created before the live admission was armed (a delayed
  start, a parked/revived worker, a pre-existing session file) is recorded as
  refused for the process's lifetime: it is neither bound to the newer turn
  nor revived by a later, more permissive admission. The check only applies
  where the surface exposes a parseable header; a fixture context without one
  is bound by its lifecycle events alone.
- **Retirement is sticky.** A terminal `agent_end`, a start refusal and the
  next fence all retire the bindings that referenced the retired record, and
  those sessions stay refused. A delegate observed only after its admission
  was retired has no record to decide under and fails closed
  (`policy-unavailable`).
- **Legitimate children keep working.** A child that starts inside the live
  turn is bound and decided exactly as before: ask + no UI fails closed at the
  approval, `auto`/Low/grant calls pass, Plan/Goal hard denials and the
  catalog clamp are unchanged. The production E2E asserts the real child's
  persisted header: both real children declare `parentSession` = the owning
  session's file, and the child of the current turn was created after the
  parent's first provider request (which itself follows the fence), i.e. the
  freshness guard accepts genuine children.
- **Evidence layers.** The generation rule (old child refused after A, after
  A's terminal end and under B; fresh child under B allowed) is pinned by
  `session/gate-delegate-ownership.test.ts` through the real registered
  handlers, state serializer and admission codec — the same controlled layer
  the reviewer used — and, for the shipped artifact, by the Bun-bundled gate
  probe in `omp-sidecar.test.mjs`. Cross-generation *native* scheduling
  remains undemonstrated: an earlier probe that tried to hold a real child's
  provider response while advancing the parent never reached generation B
  because the pinned runtime keeps an unsuppressed running child's turn alive
  (`agent-session.ts` `#hasPendingAsyncWake`/settle) — that fixture alone
  proves nothing about parked, revived or otherwise delayed callbacks, so no
  native cross-generation claim is made.

### 7.1 The digest is a consistency check, not authentication

The fence acknowledgment's SHA-256 proves that the gate installed the exact
argument the runner sent; both ends are the app's own code inside one trusted
runtime process. It is a deterministic consistency check between two app-owned
components — not a signature, not an attestation that the desktop is the
writer, and it does not authenticate across a process/user boundary.

### 7.2 Known limitation and the design it would need

The public surface cannot distinguish a *legitimately revived* worker session
(a parked child re-opened under the current turn, whose session file keeps its
original creation time) from a *delayed start* of an earlier generation: both
present an old header at their first observation. The repair resolves that
ambiguity conservatively — both fail closed for gated calls. Restoring revival
would need a formal spawn-correlation signal the pinned surface does not
provide today: `before_subagent_spawn` fires only for `task`/`eval`
`runStructuredSubagent` dispatches (not for the `eval` agent bridge, not for
lifecycle revivals) and carries no child identity; a future repair should bind
a child to a current-turn spawn intent emitted by every spawn path, or have
the runtime expose the parent session/agent identity on the child's context.
Until then, refusing is the honest fail-closed answer, and this ADR records it
rather than claiming universal delegate support.

### 7.3 Third review repair (2026-10-03): every ancestry hop must belong to the same admission

The §7 parentage check resolved a delegate's declared parent chain to the
admission's owning session file, but the recorded file links were
generation-blind: `delegateParents` stored only file→parent edges and was
retained across admissions. The reviewing root drove the gate's registered
callbacks again (real state serialization and fence/admission codec; no
provider or tool body) and showed the gap at step 6 of 7: childA is bound
under parent turn A (ask) and retired when A ends; parent turn B (auto) then
installs its admission; a **freshly created** grandchild of the retired
childA — new session id, new session file, public header `parentSession` =
childA's file, creation timestamp later than B — was allowed, because walking
childA's recorded parent link reached the same owning session file and its
freshness check passed against B. The old child itself, an unobserved child
and a foreign chain all refused correctly; a fresh child and a fresh
grandchild of the *current* turn's child were allowed (6/7). The requirement
was already the one §7 states — a delegate cannot borrow an earlier, newer or
foreign admission — and the nested-chain implementation had not carried it
through the intermediate hops.

The repair makes the ancestry rule exact (`extensions/omp-desktop-gate.ts`,
`bindDelegate` / `delegateDescendsFrom`): the gate records each observed
delegate file's declared parent **and the admission record the session was
bound to** (`delegateLineage`). A link starts unattributed and is attributed
exactly once, on that session's first successful binding; a re-observation of
an already bound session never re-points it, and a retired binding keeps its
original record reference. Resolution now requires **every** hop of the walk
to carry the very admission record being bound (identity, not token): a hop
bound to a retired or other-generation record, or never attributed (a delayed
start, an unresolved chain), fails closed exactly like an unknown
intermediate. Direct children are unaffected — their declared parent *is* the
owning session file — a descendant of the current turn's child still binds
through an intermediate bound to the same record, and deeper legitimate
nesting works while every hop carries that record. An intermediate that was
itself refused (its header predates its admission) permanently blocks its
descendants, and a later, more permissive admission never revives a chain
whose intermediate belonged to a retired record.

Evidence: `session/gate-delegate-ownership.test.ts` now pins the root's
7-step sequence (childA under A/ask refused at the no-UI ask; childA refused
after A's terminal end and under B/auto; childB allowed; unobserved child
refused; grandchild of retired childA refused; grandchild of childB allowed)
plus boundaries (a descendant of an unattributed stale intermediate, an
unknown intermediate, multi-hop legitimate nesting, re-observation of a
retired chain under a later admission, and a fresh descendant of that chain)
through the same controlled registered-handler layer; the shipped artifact is
covered by the extended Bun-bundle probe in `omp-sidecar.test.mjs`, which
runs the same sequence inside the compiled gate. This remains a
registered-handler counterexample and its fix, not a native cross-generation
scheduling exploit: no provider request or tool body runs in the probe, and
the earlier held-child fixture's failure to reach generation B stays a
statement about that fixture only (§7 evidence note).
