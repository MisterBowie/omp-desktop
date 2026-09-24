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
  spawn — so no embedder hook can weaken or replace it, and a write failure
  takes the same cleanup path as every other start failure (the run root is
  removed and the failure recorded).
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

### 4. Not implemented in this phase (declared, not claimed)

- T19-B host-tool RPC (desktop/plugin MCP and Agent Tools through one host
  boundary).
- T19-C desktop skills and project memory through the trusted gate.
- Any user path for those capabilities.

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
- T19-B is the next task.
