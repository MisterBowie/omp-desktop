# ADR 0302: OMP session persistence and the per-session runtime registry

- Status: Accepted
- Date: 2026-09-23
- Scope: M4 (T14–T16). Amends 0301 (conversation surface) by opening the
  capabilities those tasks ship, and 0300 (engine boundary) by replacing the
  single supervised runtime with a per-session registry.
- Evidence: `docs/validation/M4-persistence.md`,
  `packages/omp-runtime/src/supervisor.ts`,
  `apps/desktop/electron/main/runtime/omp-session.ts`,
  `apps/desktop/electron/main/runtime/omp-model-projection.ts`,
  `apps/desktop/electron/main/runtime/omp-session-wiring.ts`,
  `crates/host-core/src/db/migrations.rs`.

## Context

M3 shipped one conversation surface: a single supervised runtime bound to the
first session that prompted it, with the native transcript living under
`PI_CODING_AGENT_DIR` — which the supervisor placed inside the transient run
root that a stop/reclaim deletes. That made two product facts impossible:

1. A session could not survive a stop, a reclaim or an application restart,
   because its native transcript was deleted with the run root.
2. Only one OMP session could run at a time, because there was one supervisor
   and the bridge refused a second session.

M4 has to make sessions durable and concurrent without teaching the renderer
about a second engine, without letting the desktop and OMP write the same
transcript, and without leaking the user's credentials into a child process or
a log.

## Decision

### 1. One writer per transcript, and the desktop persists only a reference

The OMP runtime remains the single writer of a native transcript. The desktop
persists a *versioned reference* to it, never the transcript itself. Host-core
schema v21 adds four nullable columns to `sessions` —
`engine_adapter_version`, `engine_runtime_version`, `native_session_id`,
`native_session_path` — typed rather than a JSON blob, so each field can be
validated independently and an unknown value is a decode error. A Pi session
(and every session that predates the boundary) has no native handles and reads
back `engine: "pi"` with every reference field null.

The reference is exposed through two host RPCs that the renderer never calls:
`session.bindEngine` (persist a validated reference after `new_session`) and
`session.getEngineRef` (read it back for restore). The native path deliberately
does not appear on the renderer-facing `SessionSummary`: it is an absolute
main/host-boundary value, and the UI reads the `engine` field and the title, not
the path.

### 2. A persistent native-session directory, separate from the run root

The supervisor gains a `sessionDir` option and launches the runtime with
`--session-dir <dir>` (the pinned runtime's `--session-dir`, resolved through
`session-paths.ts`). The directory is app-owned
(`<dataRoot>/omp-sessions`, `ensureSessionStateDir`), created before the child
starts, and never removed by stop/reclaim. The transient run root continues to
hold the synthetic HOME, config root, logs, models.yml and any short-lived
credential material — those are what the stop path deletes, and the native
transcript is deliberately not among them.

### 3. Restore is reopen, not replay

A session with a persisted reference reopens it with `switch_session(sessionPath)`
before any prompt; a session without one creates it with `new_session` and
persists the validated `get_state` handles through `persistNativeSession`. A
cancelled switch or a create that returns no handles is a typed failure — never
a freshly created "looks-restored" empty session. The `runner`'s existing run
generation already guarantees that reopening does not replay old tool calls or
old approvals (M3); M4 adds the durable path to reach that state.

### 4. A per-session runtime registry

`createOmpSessionBridge` becomes a registry keyed by desktop session id. Each
entry owns its supervisor, its runtime process, its working directory, its
native reference and its dialog bookkeeping. The foreground sidebar switch never
moves another session's runtime: a session's project directory and model binding
are fixed when its runtime first starts, and a prompt naming a different project
is refused. Stopping or disposing one session never touches another session's
pending state, process or directory, and shutdown reclaims every session,
reporting each failure individually.

### 5. Model and credential projection

The desktop's provider catalog and secret store are the authority. The session's
explicit provider/model binding is projected into the minimal `models.yml` the
runtime understands (`omp-model-projection.ts`), written into the transient
agent directory by the supervisor's `prepareRun`. Exactly one provider and one
model are projected; an API style this build cannot map fails closed before a
prompt is sent. The credential is read at the main boundary
(`providers.getSecret`) and lands only in that transient `models.yml` — never in
a log, a renderer event, the persisted reference, or a fixture. Ambient
credential stripping and the synthetic HOME from M1 continue to apply, so the
child sees neither `~/.omp`, `~/.agents` nor the parent's API keys.

### 6. Capabilities open one at a time

`OMP_ENGINE_CAPABILITIES` opens `resume` and `modelSwitch`, each backed by the
behaviour above and its tests. `branch`, `steer`, `followUp` and `compact` stay
closed with the typed refusal.

`branch` is closed for a stated reason rather than shipped half-correct: the
pinned runtime's `branch(userEntryId)` is a *redo-from-user* fork — it forks at
the parent of the selected user entry and returns the selected text for the
caller to re-prompt — whereas PI's `fork_session_through` copies the transcript
*through* a message. The rpc-ui event stream also does not carry OMP entry ids,
so the desktop cannot yet persist a desktop-message-id → OMP-entry-id mapping,
and the branch RPC switches the running runtime to the new child, which forks
the parent's in-process state. A faithful full-fork needs an adapter extension;
until then an OMP fork is refused rather than silently producing a wrong child.

## Consequences

- A session's native transcript survives stop, reclaim and restart; the desktop
  restores it by path, so two application launches show the same history, name
  and model without replaying side effects.
- Two OMP sessions in different projects run concurrently with independent
  processes, working directories, model projections and approval registries.
- The renderer never receives a native absolute path, and the credential never
  leaves the main/host boundary except into the transient `models.yml`.
- `steer`, `followUp` and `compact` remain visibly closed (typed refusal) until
  their queue behaviour is implemented and tested; M5/T17 owns subagent events.
