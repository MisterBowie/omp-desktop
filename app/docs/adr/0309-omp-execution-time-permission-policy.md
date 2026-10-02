# ADR 0309: OMP execution-time permission enforcement (PI's decision table)

- Status: Accepted (M5/T20-C; 2026-10-03)
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
  `apps/desktop/electron/main/runtime/omp-host-tools.ts`,
  `apps/desktop/electron/main/runtime/omp-session.ts`,
  `apps/desktop/electron/main/plugin-host-process.mjs`,
  `packages/omp-runtime/src/session/gate-permissions.test.ts`,
  `packages/omp-runtime/src/session/tool-paths.test.ts`,
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
- `OMP_DESKTOP_GATE_TOOLS` still tunes the native name list for fixtures; the
  default list grows by the three PI-unknown Medium names.
