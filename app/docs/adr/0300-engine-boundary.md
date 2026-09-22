# ADR 0300: Engine boundary, session routing, and the OMP runtime package

- Status: Accepted
- Date: 2026-09-23
- Issues: —
- Relates to: D002 (agent loop placement), [ADR 0094](0094-single-instance-per-data-directory.md),
  `docs/spec/03-runtime/02-agent-runtime.md`, `docs/spec/03-runtime/07-process-model.md`,
  `docs/spec/03-runtime/08-error-codes.md`

## Context

This product is a fork of PI-Desktop that must eventually run OMP sessions next
to the Pi sessions it already runs. Until now the question "which runtime
executes this session" had exactly one answer, so it was never written down: the
agent sidecar ran every session, `SessionSource` described who owned the
transcript (`desktop` | `pi-native` | `remote`), and the desktop's data
directory, app id and update feed were the fork's.

Adding a second engine makes three things load-bearing that were previously
implicit:

1. **A session must know which engine owns it**, durably, or a restart hands it
   to whichever engine happens to be wired first.
2. **A capability that an engine does not have must be refused**, not served by
   the other engine: the two runtimes have different transcripts, permission
   paths and working directories.
3. **Two products must be able to coexist on one machine**, since this fork is
   installed beside the original and beside the OMP CLI it embeds.

The OMP runtime is not a library the desktop links against. The compatibility
experiments (`docs/validation/M1-compatibility.md`) established that the
supported integration is a child process speaking NDJSON over stdio in
`--mode rpc-ui`, with tool approval on a trusted extension's pre-execution hook,
and that the process must be stopped in-protocol before its pipe or process
group is torn down.

## Decision

### 1. `EngineId` is its own axis

`EngineId` (`pi` | `omp`) records the runtime that executes a session. It is
deliberately separate from `SessionSource`, which continues to record transcript
authority: a `pi-native` or `remote` session is still executed by an engine, and
neither value names one. Existing records have no engine field, and their
correct reading is Pi — a missing field never selects the newest engine
(`normalizeEngineId`). The persisted column is added with a constant `pi`
default (`sessions.engine`, schema v20), so the migration states a fact rather
than a placeholder.

### 2. Capabilities are declared, and closed means closed

`EngineCapabilities` declares what each engine can do, with every key required
so a new capability cannot be added without stating both engines' answers. A
runtime that is not up closes its statically supported capabilities as well:
`liveEngineCapabilities` folds phase into the declaration. A caller that asks
for a capability the session's engine does not have is refused with
`ENGINE_CAPABILITY_UNAVAILABLE`, naming the engine and the capability; there is
no fallback branch, because falling back would execute a session on a runtime
that does not own it.

The M2 release declares every OMP capability closed. The runtime process can be
started, supervised and inspected, but this release drives no conversation
through it: turn streaming, tool cards and approval are the next slice, and
shipping the declaration first is what keeps the UI honest while they are
missing.

### 3. The routing decision lives at one boundary

`apps/desktop/electron/main/runtime/engine-router.ts` is the only place that
answers "which engine serves this session, and may it do this?". It is pure: it
takes a status provider and reads the engine out of a session record the caller
already has, so it is testable without Electron and cannot be bypassed by a
convenience import elsewhere. Every IPC path that would execute work asks it
first. Renderer code never starts a process and never sends an engine-specific
command to another engine's transport.

### 4. The OMP runtime is its own package

`packages/omp-runtime` owns process resolution, environment isolation, the
framing contract, request lifecycle, process-group termination and cleanup
verdicts. It does not own sessions, transcripts, permissions or UI. Keeping it a
package rather than a folder inside Electron main is what lets the protocol and
lifecycle rules be tested against a mock child and against the pinned runtime
directly, without a display or an Electron process.

Three rules it enforces, each from a measured failure:

- **Stop in protocol, then break the bridge.** A command runs in its own process
  group; killing the bridge group first leaves it orphaned. The runtime's own
  `abort` is what reclaims it.
- **A leader's exit is not the group's exit.** Termination is decided by group
  liveness, and a stop that leaves the group populated reports `reaped: false`
  instead of success.
- **Chunk decode failure is fatal.** The protocol decoder cannot resynchronise,
  so a corrupt sequence ends the stream and the runtime must be rebuilt.

The launcher is never resolved from `PATH`: a global `omp` points at whatever
checkout installed it last. A packaged build uses a bundled runtime; a
development build resolves the launcher inside the pinned reference checkout by
walking up from the app directory.

### 5. The runtime is verified, not assumed

Startup probes the executable's version and refuses to continue when it differs
from the pin this build was validated against. This is not ceremony: in this
very worktree the launcher reported `18.2.9` from a cached published copy of a
workspace dependency while the pinned checkout was `18.2.7`, because the
submodule had no dependencies of its own installed. A desktop that trusted the
launcher would have run a runtime nobody validated.

### 6. The product owns its own names

`PRODUCT_IDENTITY` (`packages/shared/src/app-identity.ts`, deriving name and app
id from `protocol.ts`) carries the installation's own app id, data directories,
`userData` names, deep-link scheme, credential namespace and update source, and
`assertIndependentIdentity` refuses a candidate that collides with the fork it
came from or with the OMP runtime's own home directories. The update source is
this product's repository; the packaged-app feed no longer points at the
upstream project. Icon, installer artwork, Windows executable/shortcut naming
and the packaged runtime are release work and stay open.

## Consequences

- A session carries its engine from creation (host `session.create`) to routing
  and to the UI; branches and spawned workers inherit their parent's engine.
- Adding an engine capability is a deliberate act: the declaration, the runtime
  that backs it, and the refusal path all have to agree, and a test asserts both
  engines declare every key.
- The OMP runtime is started on request and reclaimed on quit; nothing starts it
  at boot while no conversation surface exists.
- Data safety: a development profile, a shipped profile and the fork's profile
  have distinct directories (`~/.omp-desktop`, `~/.omp-desktop-dev`, and the
  fork's own), and the child runtime gets a synthetic `HOME` inside a run
  directory it owns — so it cannot read the user's `~/.omp`, `~/.agents` or
  provider keys.
- Not decided here: how a packaged build ships the runtime (ADR for M6),
  conversation-level protocol handling (M3), and session restore/compaction
  (M4).
