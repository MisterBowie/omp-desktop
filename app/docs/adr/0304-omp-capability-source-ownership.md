# ADR 0304: OMP capability-source ownership and the run-scoped source boundary

- Status: Accepted (M5/T19-A)
- Date: 2026-09-25
- Scope: M5/T19-A (runtime capability-source isolation, trusted gate loading,
  and the capability ownership contract). T19-B (host-tool RPC) and T19-C
  (desktop skills/memory/plugin user paths) are declared here as ownership
  decisions but are not implemented by this phase.
- Amends: 0301 (gate loading — `--extension` becomes `--trusted-extension`).
- Evidence: `docs/validation/M5-capability-sources.md`,
  `packages/omp-runtime/src/config-overlay.ts`,
  `packages/omp-runtime/src/supervisor.ts`,
  `apps/desktop/electron/main/runtime/engine-runtime.ts`,
  `apps/desktop/test/omp-capability-source-boundary.test.mjs`,
  `apps/desktop/test/omp-capability-source-e2e.test.mjs`,
  `packages/omp-runtime/src/config-overlay.test.ts`.

## Context

The pinned OMP runtime (18.2.7) discovers several capability sources on its
own, at startup, from the process environment and the working directory:

- **Project MCP config** — `mcp.json` / `.mcp.json` at the project root,
  `.omp/mcp.json`, `.claude/.mcp.json`, and other tools' project files. The
  gate is the `mcp.enableProjectConfig` setting, whose default is `true`
  (`settings-schema.ts:4761`; the loader filters every `level === "project"`
  server through it, `mcp/config.ts:117`).
- **Memory** — `memory.backend` (default `off`) selects a backend that reads
  memory files from disk and injects them into the developer instructions.
- **Ambient extensions** — the agent dir's `extensions/` directory, hook
  factories, installed-plugin extension entry points, and `settings.json`
  extension lists (`extensibility/extensions/loader.ts:600-650`), unless
  discovery is disabled.
- **Rules, skills, plugins, custom tools** — the same agent/project dirs,
  through their own capability providers.

The desktop's synthetic HOME (`packages/omp-runtime/src/isolation.ts`) stops
the runtime from reading the user's real home, but it does not stop *project*
sources (the runtime's cwd is the user's workspace) and does not stop
lower-priority agent config from re-enabling sources the desktop wants closed.
The M1 experiments measured exactly this shape: an isolated run still walks
the workspace.

Before T19-A the desktop loaded its pre-execution approval gate with
`--extension <gate>`, a flag that adds the gate to the *same discovery graph*
that loads ambient extensions. Nothing prevented a second extension — or a
duplicate copy of the gate — from loading and executing beside it.

Pi-Desktop (the reference at `0111e306`) shows the ownership model the desktop
must preserve: Electron main and host-core own capability *documents and
processes* (`.agents/servers`, `.agents/skills`, plugin registry), the agent
runtime owns the *model-facing surface*, and there is exactly one registration
path per capability (`session-launch.ts` assembles one `sidecarParams`; user
MCP tools are `mcp_<server>_<tool>`, plugin tools `plugin_<plugin>_…`, both
dispatched through host-core `plugins.execute`).

## Decision

### 1. Capability-source ownership contract (the phase's invariant)

| Source | Owner | Exposed | Phase |
| --- | --- | --- | --- |
| Workspace AGENTS/context files, OMP rules | OMP | native | T19-A (kept enabled) |
| OMP-native project skills | OMP | native | T19-A (kept enabled) |
| OMP-native task/LSP/debug/edit tools | OMP | native | T17/T18/T19-A |
| Desktop MCP and plugin MCP | desktop host | once, through host-tool RPC | T19-B |
| Desktop plugin Agent Tools | desktop plugin runtime | once, through host-tool RPC | T19-B |
| Desktop user/plugin/builtin skills | desktop host | on demand, scope-revalidated | T19-C |
| Desktop project memory | host-core | trusted gate, `projectMemoryPrompt()` semantics | T19-C |
| Plugin UI, themes, independent services | desktop | desktop | unchanged |
| PI agent extensions | incompatible | must not be injected into OMP | now |

Rules the contract enforces:

- **Exactly one loader per capability.** The same MCP server or tool is never
  both natively discovered by OMP and registered by the desktop host. Until
  T19-B/C ship the desktop-owned equivalents, the OMP-native sources for those
  capabilities are *closed*, not duplicated.
- **PI agent extensions are incompatible for now.** They run on Pi's sidecar
  (`tool_call` hook of `TrustedExtensionRunner`, `--use-system-ca` sidecar
  args) and must never be injected into the OMP runtime.
- **OMP keeps its own capabilities.** Workspace AGENTS/context files, OMP
  rules, OMP-native skills and the native task/LSP/debug/edit tools stay OMP's;
  T19-A does not disable them (`--tools`, `--no-rules` and the synthetic HOME
  are not used as substitutes for source isolation).

### 2. A run-scoped, mechanically enforced source boundary

The supervisor writes a config overlay inside each run root
(`config-overlay.yml`, `config-overlay.ts`) and passes it as
`--config <overlay>` — appended last, so the pinned runtime's flag-order merge
(`settings.ts:3303-3307`: `global < project < PI_CONFIG_FILES < --config
overlays < runtime overrides`) gives it the final word over the global and
project layers. It forces:

```yaml
mcp:
  enableProjectConfig: false
memory:
  backend: off
```

Properties:

- **Mechanical, not caller-dependent.** The supervisor writes the overlay
  itself in `startRuntime()`, after `prepareRun` and immediately before
  spawn. The writer first removes whatever entry occupies the owned overlay
  path — removal acts on the entry itself and never follows a planted
  symlink or hard link — and then creates the boundary file exclusively
  (`wx`/`O_EXCL`, mode 0600). The supervisor also records
  `realpathSync(runRoot)` before the hook and re-resolves the overlay's
  parent immediately after it: a changed or unresolvable canonical location
  — a hook that deletes the run root or replaces it with a symlink to an
  outside directory — fails the start before any write. (Resolved
  locations, not inode identity, are compared: a fresh regular directory at
  the same lexical path resolves identically, cannot redirect the write,
  and is deliberately allowed.) An embedder hook therefore
  can neither weaken the overlay nor redirect the write outside the run
  root, and a write or create failure takes the same cleanup path as every
  other start failure (the run root is removed and the failure recorded).
  The guarantee covers mutations the hook completes before `prepareRun`
  returns — entries planted at the overlay path and canonical-location
  swaps of the run root. It is not a claim
  of security against arbitrary malicious hooks: concurrent filesystem
  mutation is outside it in two windows — a final-component entry
  re-planted between the writer's remove and create (the exclusive create
  is the only protection there), and a parent-directory swap between the
  post-hook canonical-location check and the write (which the exclusive
  create cannot detect).
- **Run-scoped.** `OmpRunPaths.configOverlay` is the per-run path inside the
  owned run root; it is never a static constructor argument.
- **Owned cleanup.** The existing `removeRunRoot` sweep removes the overlay
  with its run root on stop, reclaim, and failed starts.
- **No user configuration is read or written.** The overlay is generated; the
  runtime's own global config is still the isolated agent dir's `config.yml`,
  which the model projection already owns.
- **Workspace/global config cannot reopen the closed sources.** A workspace
  `.claude/settings.json`, `.omp/settings.json`, or the run's own global
  `config.yml` sits below the overlay in the merge, so it cannot re-enable
  project MCP or a memory backend. (The runtime's own *overrides* would beat
  the overlay by design; the desktop does not use them for these settings.)

This is the boundary that disables project MCP and OMP memory *before*
T19-B/C register the desktop-owned equivalents. T19-B/C must expose those
equivalents exactly once through the host-tool RPC / trusted gate; this phase
does not implement or claim them.

### 3. The gate loads through the trusted-extension allowlist

Production wiring passes `--trusted-extension <gate>`
(`engine-runtime.ts`). The pinned runtime treats this flag as an exact,
canonicalized file allowlist: absolute path, `realpath` + file check, no
combination with `--extension`/`-e`/`--hook`, `disableExtensionDiscovery =
true` — native `.omp/extensions`, hook factories, plugin extension entry
points, `settings.json` extension lists and CLI-root injection are all skipped
(`main.ts:1597-1614`, `1714-1719`; `sdk.ts:797-805`;
`extensibility/extensions/loader.ts:600-650`). The gate is therefore the only
extension module that runs, exactly once; a duplicate copy in any ambient
path cannot load a second policy.

The trusted allowlist does *not* isolate MCP, memory, skills, rules or plugin
roots — those remain governed by the config overlay (§2) and the ownership
contract (§1). The gate's pre-execution `tool_call` hook, cancellation,
session and process-cleanup semantics are unchanged (M3).

### 4. T19-B realized: host-tool RPC with gate approval (amended)

The desktop-owned tools declared in §1 now arrive through the pinned
runtime's host-tool RPC, exactly once per session:

- **Catalog**: `plugin_<plugin>_…` (Agent Tools and plugin-declared MCP) and
  `mcp_<server>_<tool>` are assembled from the live plugin registry and the
  user MCP runtime per prompt (Pi `session-launch` semantics) and registered
  with `loadMode: "essential"`; the bridge re-registers on any catalog change
  (fingerprint skip when identical) and fails closed on a refused registration
  or an echoed `toolNames` mismatch. A name colliding with an OMP native tool
  is refused by the pinned runtime (`session-tools.ts`); the desktop never
  overrides it silently.
- **Execution**: `host_tool_call` frames bind to the owning run;
  **at-most-once covers execution** within the owning generation (no evictable
  cap; the record is reclaimed when the generation ends). Fail-closed
  rejections (no active run, no wired executor) execute nothing; a replayed
  rejected frame is answered fail-closed again — still zero executions, and
  the runtime drops answers to ids it no longer tracks. Re-checks at the last
  synchronous dispatch point cover plugin load, activation scope, the user MCP
  server state and the live turn (`dispatchable` over the OMP runner — the Pi
  predicate is not used, OMP turns never enter the Pi turn registry).
  Cancellation: the abort signal reaches plugin executions; MCP calls have no
  call-level signal, so the guarantee is "not dispatched after cancel, late
  results dropped" — remote side effects are never claimed retracted.
- **Execution context (limitation, T20)**: the adapter passes `mode: "agent"`
  to plugin tools. The Pi host passes the durable session mode and the plugin
  runtime enforces declared `planSafeActions` from `ctx.mode`
  (`plugin-runtime.ts:2505-2525`); OMP prompt/spec carry no mode today and
  Plan/Goal is deferred, so this phase does NOT claim full Pi execution-context
  compatibility. T20 must propagate and enforce the real mode before Plan/Goal
  is claimed.
- **Approval**: host tools are controlled by this same gate, before any
  execution — `plugin_*`/`mcp_*` are gated unconditionally (the
  `OMP_DESKTOP_GATE_TOOLS` list only tunes native names) and raise a real
  `tool_permission_request`. Risk: `plugin_*` = `high` (conservative upper
  bound; the pinned protocol carries no declared-risk channel, so a
  low/medium-declared plugin sees a stricter prompt this phase), `mcp_*` =
  `medium` (matching the Pi host's fixed MCP classification). No parallel
  approval system exists.
- **Turn lifecycle**: the runner's `closeRun(generation, reason)` announces
  `session:turnEnded` exactly once per turn — completed for a normal
  `agent_end`, aborted for a user-requested stop (including a late `agent_end`
  under stop) or a dispose of a live turn, error for prompt/transport failure
  (including a prompt RPC failure that presented no dialog). A mid-run
  converter error is not a turn end.
- **Results**: two isError layers (thrown errors and inner
  `AgentToolResult.isError`) both map to an outer failed `host_tool_result`;
  text and MCP image blocks pass through faithfully; non-text blocks,
  `structuredContent` and any other key (including a plugin's own
  `details`/`providerMetadata`/`useless` — the Pi contract shows the plugin's
  whole return value to the model) become deterministic text, never mapped
  onto OMP-internal result metadata. Every outcome funnels through one budget
  pass measured on the final serialized `content` JSON (≤ 768 KiB), which
  keeps the frame under the 1 MiB line limit and preserves the head of an
  over-budget result.

Evidence: `docs/validation/M5-host-tool-rpc.md`.

### 5. Not implemented (declared, not claimed)

- T19-C desktop skills and project memory through the trusted gate.
- Any user path for those capabilities.
- T20 Plan/Goal and high-privilege capability gating.

## Consequences

- Every OMP runtime this product starts is closed to project MCP config and
  OMP memory backends; the desktop-owned equivalents arrive later and once.
- Only the shipped gate runs as an extension; ambient extension code in the
  isolated agent dir is inert.
- `--config` overlay path handling is exercised through paths with spaces and
  non-ASCII characters; the overlay is removed with the run root.
- Existing approval, session, persistence, subagent and concurrent-approval
  fixtures now run under the trusted boundary and must keep passing.
- ADR 0301's gate-loading description is amended (`--trusted-extension`).
- Desktop host tools are approved through the same gate as native tools; the
  declared-risk limitation (§4) is recorded, not hidden.
- T19-C is the next task.
