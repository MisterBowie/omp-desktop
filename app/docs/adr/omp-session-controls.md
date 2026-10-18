# ADR: OMP text steering, follow-up turns and manual compaction

- Status: Accepted for the implemented text-control scope
- Date: 2026-10-18
- Runtime: OMP 18.3.0, existing patch level `62bc57b+omp-desktop.6`

## Context

Desktop already has steering, a durable host queue and a manual-compaction
entry point. OMP exposes `steer` and `compact`, but forwarding its sessions
to Pi would use another engine's context, permissions and transcript.
Native `follow_up` also bypasses the desktop's per-turn host lifecycle and
queue controls. A manual compaction has no agent turn for cancellation to own.

## Decision

Text steering uses the existing OMP process and validates the expected live
turn before submission. The runner keeps the terminal boundary closed until
the native command answers. Native non-terminal ends remain continuations;
optimistic prompt and steering identities are consumed separately. A transport
failure makes admission uncertain, so the process is reclaimed before reuse.
The owning native admission and Plan/Goal permission contract remain in force.

Follow-up turns use the existing host-owned durable FIFO. Its dispatcher calls
the regular engine-routed prompt entry point, so each OMP turn restores its own
native reference, refreshes policy and opens/settles its own durable host turn.
Queue reads, remove, reorder and prioritize share the existing control plane.
The runtime busy predicate includes OMP preparation, stopping and compaction.
No second native follow-up queue is introduced.

Manual compaction restores the session on its owning OMP process and calls
`compact`. A separate controller owns preparation, UI lifecycle and cancellation
without inventing a conversation turn. Stop sends native `abort`, then uses
the supervisor's existing bounded process reclamation when needed. A cancelled
operation cannot report success. An uncertain request retains a reclamation
obligation until Stop successfully retries it. The native session remains the
only transcript writer; no desktop compaction record is fabricated.

## Boundaries

Steering and queued inputs support text only. Attachments and collaboration
queue payloads are rejected before durable admission. Native `branch` is a
redo-from-user operation that changes the parent's active native session, not
a copy-through-message fork; `branch` stays closed. The pinned RPC has no
targeted child-stop command; that operation also stays closed. Neither is
approximated using parent abort or direct native-transcript writes.

No runtime patch, package identity, updater or installation is changed. The
representative real-runtime scenario uses verified packaged resources, a
fixture-owned HOME/project and a loopback scripted model, with no paid calls.

## Validation

See `E2E-OMP-session-controls` in the E2E plan and
`apps/desktop/test/omp-session-operations-e2e.test.mjs`. Runtime contract tests
cover stale input, overlapping operations, delayed terminal frames, optimistic
identity, cancellation during preparation, uncertain requests and retryable
reclamation. IPC tests preserve Pi routing and reject unsupported OMP payloads.

## Consequences

The shared queue must attribute pre-response events to the record actually
being dispatched, rather than the next queued head, and must preserve terminal
status when a fast native run ends before its prompt response. The admission
tests reproduce both prior failures. OMP completion also informs the existing
Host finalizer, and a released preparation or cleanup retries the queue drain.
These paths do not create another turn or rewrite native history.

The entry already exceeded its 1500-line architecture ceiling. OMP service
composition now lives in `bootstrap/omp-sessions.ts`; existing error helpers
and the workspace branch label helper move unchanged to their owning modules.
The application entry is 1491 lines and retains only wiring for these services.

## Session UI amendment (2026-10-18)

The Todo dock projects OMP's native `todo` tool results and `user_todo_edit`
entries on the active branch. It preserves phases, blockers and native statuses;
the whole branch is examined before transcript paging. The optional
`SessionDetail.todoPhases` field transports that snapshot. Live successful
mutations update the owning session, child results do not replace the parent's
list, and a late history read cannot overwrite a newer live result. No Todo
database, write tool, scheduler or manual editing path is added. Native Todo
continuation reminders keep their existing behavior.

Composer skills use `/skill:<exact-id>` for every skill source. The namespace
is reserved; ordinary app/template names retain priority over legacy bare skill
aliases. The main boundary resolves the owning project's current catalog on
prompt/steer dispatch, including when a queued follow-up becomes a turn. Bodies
remain on demand through the existing Skill tool and its live scope checks.
An explicit skill request refuses admission if its turn has no Skill loader.
Pi keeps typed-command metadata; OMP persists the actual expanded instruction
in its native transcript. No second transcript writer is introduced. A failed
native-reference read now refuses dispatch instead of creating a new context.

Sidebar rows display localized calendar-day labels from `updatedAt`, matching
the reference release's date source. Project activity includes folded sessions
and prioritizes pending permissions. Copy title, project path (when present)
and session ID are normal actions; opening the raw session path remains a
developer action. These are presentation changes and never rebind a session's
project or engine.

Component/Store tests exercise disclosure, background isolation, stale reads,
running input and command discovery across a session switch. The native
scripted-provider scenario covers Todo init/done, history restoration outside
the returned page, namespaced Skill follow-up/body loading, steering and
compaction cancellation. Host persistence is a controlled RPC fixture; database
restart recovery and installed GUI acceptance remain separate checks.
