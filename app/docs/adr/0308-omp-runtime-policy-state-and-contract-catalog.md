# ADR 0308: OMP runtime mode/policy state, the mode block, and the contract tool catalog

- Status: Accepted (M5/T20-B1; 2026-10-02 review repair amends §2/§3)
- Date: 2026-10-02
- Scope: M5/T20-B1 (the run-scoped runtime state v2, the gate's mode-block
  append and contract-mode tool clamp, the effective permission mode, and the
  host-tool risk/plan-safe policy table). T20-C (execution-time permission
  enforcement), T20-B2 (submit/approve/dispatch), and T20-D (capability
  opening) remain declared, not claimed.
- Amends: ADR 0304 §5 (the run-scoped state becomes a runtime *policy*
  channel with a mandatory half), ADR 0301 (the gate's tool surface).
- Evidence: `docs/validation/M5-t20-b1-runtime-state.md`,
  `packages/omp-runtime/src/desktop-state.ts`,
  `packages/omp-runtime/src/session/start-refusal.ts`,
  `packages/omp-runtime/src/session/runner.ts`,
  `packages/omp-runtime/extensions/omp-desktop-gate.ts`,
  `apps/desktop/electron/main/runtime/omp-session.ts`,
  `apps/desktop/electron/main/runtime/omp-session-wiring.ts`,
  `apps/desktop/electron/main/runtime/omp-host-tools.ts`,
  `apps/desktop/test/omp-runtime-state-e2e.test.mjs`,
  `apps/desktop/test/omp-start-handler-semantics.test.mjs`.

## Context

M3/M4 persist `sessions.mode` and `sessions.permission_mode` in host-core and
expose a composer mode switch, but nothing in the OMP path read them: the
bridge sent `prompt` frames the same way for every mode, the trusted gate only
injected skills/memory, and the PAT-adjacent plugin execution context
hardcoded `mode: "agent"` (`g2`, owned by T20-C). The host-tool adapter also
dropped every plugin's declared risk and `planSafeActions` list when it
projected the registry into `set_host_tools` definitions, so the runtime-side
gate had no way to know which plugin tools PI's contract modes could see, and
the card risk was a name-prefix guess.

PI-Desktop's authority (fixed reference `0111e306`) is unambiguous:

- `sessions.mode` is the only durable mode store; `composeModeSystemPrompt`
  appends the mode block *after* the base/memory chain (`runtime.ts:2051`);
- `permission_mode` may be `inherit`, resolved against the app's current
  `defaultPermissionMode` else `ask`
  (`session_collaboration/permissions.rs`);
- the Plan/Goal catalog is `Read|Glob|Grep|Bash|BrowserPreview|new_context` +
  `Ask`/compaction + the current Submit tool + plugin tools with a non-empty
  declared plan-safe list (`runtime.ts:3314`, `3453`; ADR 0211);
- host-core's authority mirror is `plan_mode_allows`
  (`permissions.rs:148-153`), and risk is the declared plugin risk (missing/
  illegal → medium), `mcp_*` → Low.

The pinned OMP extension surface offers exactly three process-inner channels:
`before_agent_start` system-prompt replacement, `setActiveTools` /
`getActiveTools`, and pre-execution `tool_call` interception. The T20-A spike
measured that registering host tools *auto-activates* them (`session-tools.ts`
`autoRpcHostToolRefresh`), so the order must be `set_host_tools` first, then
the gate's clamp; that an unchanged clamp costs one attempt while a real
change costs the runtime's single policy retry (attempts 2/1/2); and that a
thrown handler error is caught and swallowed by the extension runner, while
`ctx.abort()` is the only formal refusal path.

## Decision

### 1. One run-scoped runtime state, schema v2, one writer, one reader

`<runRoot>/desktop-state.json` (`OMP_DESKTOP_STATE`) remains the only
desktop → gate channel, with the T19-C envelope: atomic same-directory 0600
replacement, symlink/hard-link-safe, size/length/count ceilings, a freshness
window, future-write rejection, and an owning-native-session check. Schema v2
adds the **mandatory policy half**:

| Field | Meaning |
| --- | --- |
| `mode` | `agent|plan|goal`, read from the host session row per prompt |
| `modeBlock` | the exact `composeModeSystemPrompt(mode, "")` output |
| `permissionMode` | the **effective** `ask|accept-edits|auto` (`inherit` already resolved) |
| `hostTools` | `{name, risk, planSafeActions, origin}` per registered host tool |
| `skills`, `memory` | the T19-C best-effort capability half (unchanged) |

The bridge is the single writer (one assembly per prompt; the same catalog
feeds `set_host_tools` and the policy table), the gate the single reader. The
policy half is mandatory: any failure to read the host row, validate the
enums, compose the block, write the file, or re-validate it with the gate's
own reader refuses the prompt before submission. There is no tombstone and no
Agent fallback on that half — the T19-C tombstone path is gone. The
capability half stays PI-best-effort: a failed snapshot becomes an empty
capability part (and withdraws the `Skill` tool) while the mode/policy half
stays exact; malformed skill lines are dropped like PI's own best-effort
loading, not turned into a refusal.

`inherit` is resolved desktop-side with host-core's semantics: a concrete mode
passes through; `inherit` resolves to the app's current
`defaultPermissionMode` when legal and non-`inherit`, else `ask`.

### 2. The gate appends the mode block and clamps the contract catalog

The gate's `before_agent_start` handler, for the owning session only:

- appends the capability block (skills then memory, byte-identical to T19-C)
  and then the mode block, in that order — the mode block is last, matching
  PI's `base + mode block` position; a policy retry re-runs the handler
  against the fresh base, so the block is appended exactly once;
- `plan`/`goal`, selects exactly `CONTRACT_NATIVE_TOOLS ∩ live active` plus
  plugin host tools whose state entry has a non-empty `planSafeActions`, in
  the runtime's current order, via `setActiveTools`. `write`/`edit`/
  `apply_patch`/unknown tools, user MCP tools and undeclared plugin tools
  never enter the contract catalog; PI's `BrowserPreview` is **not** invented
  because the pinned runtime ships no such tool;
- on return to `agent` in the same process, restores the pre-clamp enabled
  selection plus every name the clamp observed and removed, with
  catalog-managed names filtered against the catalog current at that prompt
  and native names against the pre-clamp selection — no `getAllTools`
  "enable everything", no resurrection of a removed/disabled tool;
- an unchanged selection makes no call — a stable prompt costs one start
  attempt, a real change costs at most the runtime's single policy retry.

### 2a. Leaving a contract mode rebuilds the runtime process (review repair)

The extension surface exposes only `getActiveTools`/`getAllTools`/
`setActiveTools`; `setActiveToolPresentation` (which restores the exact
top-level vs `xd://` partition) is a session method the interactive controller
and the SDK call directly, and the RPC command union has no presentation
command. A same-process restore through `setActiveToolsByName` pins every
restored name top-level (promoting `ast_edit`/`debug`/`lsp`) and cannot see a
plugin that was registered while the clamp was live. Therefore the bridge
detects the contract-mode → `agent` transition from the last prompt's mode and
reclaims the runtime; the next prompt starts a fresh process that re-applies
the runtime's own default presentation and re-registers the current host-tool
catalog over the same persisted native session (`switch_session`), same
project, same model projection. Generation/message-id seeds carry across the
replacement, so turn/message ids never collide; history is restored, nothing
is replayed and the persisted identity is unchanged. A reclaim failure refuses
the prompt rather than running in the pinned presentation.

### 3. Fail-closed refusal is `ctx.abort()` plus a structured notify

A state file that claims the firing session but fails validation makes the
gate refuse the turn through the runtime's own `ctx.abort()` (measured: zero
provider requests, prompt not delivered). A thrown handler error is *not*
protection: the extension runner logs it and continues (measured: the provider
request is still delivered), so the gate never relies on throws.

Because an aborted `before_agent_start` emits no `agent_start`/`agent_end`,
the gate also emits a versioned refusal descriptor through the runtime's own
`notify` extension-UI channel. The runner honors it only when the descriptor
names the native session the entry owns and the awaiting generation has not
emitted `agent_start`; it then closes exactly that generation with one
`error` envelope (`OMP_RUNTIME_STATE_REFUSED`) and one `turnEnd` (`error`),
cancelling open dialogs/host calls and returning to idle. Duplicate, late,
foreign-session and delegate signals are counted and ignored, so no newer
generation can be closed by a stale one.

The bridge also marks the channel mandatory (`desktop-state.required` next to
the state file) for every run it wires: from then on *every* non-owned read
(missing, unreadable, oversized, identity-less, foreign, out-of-schema)
refuses the interactive session's turn. A delegate (`hasUI=false`; `task`/
`eval` subagents initialize their extension runner with the no-op UI context)
keeps the zero-injection skip and is never refused. A fixture that never
enabled the channel keeps the T19-C degradation: no state, no injection.

### 4. Policy travels with the catalog fingerprint; the card carries the mode

The bridge's `set_host_tools` fingerprint includes each entry's risk,
plan-safe actions and origin, so a declaration change alone re-registers. The
gate's approval descriptor (additive, optional field) carries the effective
permission mode read from the same state, making the resolved policy
observable through a real consumption path (T20-C replaces this with the
execution-time decision table; the field stays for diagnostics).

## Consequences

- Leaving Plan/Goal costs one runtime restart per transition (seconds, no
  history loss). This is the only in-tree-safe route while the pinned runtime
  exposes no presentation restore to extensions; if a future pin exposes it,
  the rebuild can be replaced by an exact re-application and this ADR amended.
- T20-C can build PI's §1.3.1 decision table from validated data (state
  policy table + effective mode) instead of name-prefix guesses; this ADR does
  not implement that table and does not claim it.
- The plugin execution context still hardcodes `mode: "agent"` (`g2`), plan
  dispatch is still refused (`g3`), and `plan`/`goal` capabilities stay
  closed. The B1 channel is the prerequisite those phases consume.
- The gate script is loaded from `extensions/omp-desktop-gate.ts` by the
  pinned runtime and compiled by the product's Bun sidecar build; both keep
  working because the gate stays dependency-free at runtime (relative imports
  only).
- ADR 0304 §5's description of the state (capabilities only, tombstone on
  failure) is superseded for the runtime state; the source-ownership table
  itself is unchanged.
