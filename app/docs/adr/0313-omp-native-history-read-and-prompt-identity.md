# ADR 0313: OMP native history reads and one identity per submitted prompt

- Status: Accepted (M5/T20-D repair rounds 2–3; 2026-10-03). Implementation
  complete, pending the root's independent re-review. Does not claim M5/T20
  completion: the full matrix and the three-platform packages remain.
- Date: 2026-10-03
- Scope: how an OMP session's transcript reaches the renderer, and how a
  submitted prompt's user row keeps one identity across the optimistic render,
  the runtime's durable echo and a later durable read.
- Amends: ADR 0300 (engine boundary: adds the read path at the `sessionGet`
  boundary), ADR 0312 §"1" (the capability keys are unaffected; this ADR adds
  no capability). Keeps every closed capability closed. Amended in place by
  repair round 3 (§"Repair 3 amendment"): the transient read runtime of
  decision 1 was replaced by a direct, in-process file reader after measured
  byte-purity failures.
- Evidence: `docs/validation/M5-t20-d-capability-ui.md` §0 (repair 2 and
  repair 3), `app/apps/desktop/electron/main/runtime/omp-session.ts`,
  `app/packages/omp-runtime/src/session/native-session-file.ts`,
  `app/packages/omp-runtime/src/session/history.ts`,
  `app/apps/desktop/electron/main/ipc/session-ipc.ts`,
  `app/apps/desktop/electron/main/ipc/agent-ipc.ts`,
  `app/packages/omp-runtime/src/session/events.ts`,
  `app/apps/desktop/src/lib/session-transcript.ts`,
  `app/scripts/e2e-omp-plan-ui.mjs`.

## Context

The desktop kept one writer per session: an OMP session's transcript is the
runtime's own native session file, and the desktop never double-writes it into
the host's `messages`. `sessionGet` nevertheless read only the host transcript,
so an OMP session's panel showed messages produced in the current app run and
**nothing after a restart** — even though the native transcript was complete
(the provider request after a restart carried the full restored history). The
same panel painted a submitted prompt twice: Main echoed the renderer's
optimistic row under the renderer's id, and the runtime's own user frame was
projected by the converter under a freshly minted id, so the renderer's
upsert-by-id could not correlate them. Two defects, one missing contract: the
desktop had no read path into the native transcript, and no identity contract
between what the renderer showed and what the runtime persisted.

The runtime's RPC surface exposes the read this needs — `get_entries` (the
canonical append history plus the active `leafId`) — through a session the
runtime has opened. Repair round 2 used exactly that surface with a transient
"read profile" runtime. Repair round 3 measured what a session-owning reader
costs, and reversed the mechanism (not the projection).

## Decision

1. **The transcript is read read-only, through two paths, never a second
   process on a live file.** `OmpSessionBridge.readHistory` projects
   `{ entries, leafId }` into desktop rows (active-branch walk, entry ids as row
   ids, `toolCallId` for tool rows whose call id is unique on the branch) with
   the same bounded window PI's native reader applies. A session whose runtime
   is alive is asked through that runtime — the transcript's own writer, so no
   second process ever opens a live file. A session with no live runtime is
   read from its own file **in-process by a direct reader**
   (`readNativeSessionEntries`): no runtime is started, so the read has no
   writer, no lock, no lockfile, no child process and no lifecycle to leak. The
   reader parses the pinned format's contract (title slot folded, header
   identity and version validated, `hookMessage` v2 role renamed in memory,
   lenient malformed records, leaf = last physical entry), re-checks the
   header's session id itself after the path validator, and enforces explicit
   file/record byte bounds. A read therefore requires no provider credential at
   all, issues no provider request, executes no tool, leaves the transcript
   byte-identical on success *and* on every failure, and terminates the last
   uncommitted line at a record boundary. An explicit `leafId: null` is the
   runtime reporting no active branch and renders an empty page; a missing or
   malformed leaf is a protocol violation, never silently repaired to the last
   stored entry.

2. **Fail closed, except for a session that truly has nothing.** A missing,
   foreign, half-written, unreadable, oversized or version-incompatible native
   reference, a corrupt entry list and a failed reclaim all throw. An empty
   page is reserved for a session with no native reference yet, or for an
   explicit null leaf. A failed engine lookup or native-reference read at the
   IPC boundary throws too: a session that cannot be *proven* to be Pi must not
   silently show the host transcript as if it were one.

3. **One identity per submitted prompt.** The renderer's optimistic row id
   rides the prompt (`userMessageId`, UUID-validated at the same boundary the
   desktop host uses); the converter binds it to the next user frame and reports
   that frame as PI's `user_message_persisted` against the optimistic row
   instead of minting a second row. Main no longer echoes the user row itself.
   A binding whose run never echoed its frame is discarded with the run, so a
   later prompt can never be re-keyed onto an older row.

4. **A durable read names the live rows it replaces.** Because the runtime's
   live frames carry no entry id, a streamed row and its durable twin cannot
   share an id. The bridge keeps an exact, single-writer ledger of the live
   rows it announced for a session (the renderer derives its rows from those
   same envelopes), settles them from their own terminal events, and a *tail*
   read returns `replacedLiveMessageIds` — the settled rows whose durable twins
   the read contains — widened to cover them. The renderer drops exactly those
   rows before merging and never consults text or timestamps: two identical
   prompts stay two rows with two ids. An in-flight row is never named, and an
   older page (or a centered read) never names any row, because it does not
   contain the twins.

## Consequences

- Restarting the application shows an OMP session's transcript before the user
  types anything; the panel no longer depends on a prompt to fill itself.
- A history read with no live runtime now costs one file read and zero
  processes: it cannot leak a process, a run directory or an ownership debt,
  and it needs no provider catalogue (let alone a credential) to run.
- The desktop now owns a small, bounded reader for the pinned session format
  (title slot, header identity/version, entry records, leaf). It is the only
  place that knows the on-disk shape, it never writes, and its equivalence to
  the runtime's own `get_entries` projection is pinned against the real
  runtime (`omp-history-e2e.test.mjs`).
- `SessionDetail.replacedLiveMessageIds` joins the shared session types as an
  optional field: engines whose live and durable ids already agree (Pi native,
  desktop) never set it, and a reader that ignores it loses nothing.
- Known limit: a live row older than the returned tail window — possible only
  when a single app run produced more rows than the ledger bound — is not named
  while the window does not contain its twin; its durable row arrives with the
  older page, and the row is never dropped from storage.
- Known limit: blob-backed image payloads (`blob:sha256:` refs) are not
  resolved by the direct reader. The transient runtime could not resolve them
  either after a restart (the blob store lives inside the deleted run root), so
  no behavior regressed; a future round can point the blob store at the
  persistent session root.

## Repair 3 amendment (2026-10-03)

Repair round 2's transient read profile was measured against the real pinned
runtime with the production bridge and a fault-injecting writer. Successful
reads were byte-pure, but **every failure path appended a native `session_exit`
record to the file being browsed**: a refused `get_entries` (+207 B), a
`get_state` identity mismatch (+207 B), a cancelled or timed-out detach (+207 B
each, while the read still reported success), because the runtime is disposed
while still holding the session. The same reader was invisible to the bridge's
lifecycle: it was not registered before start, so `dispose` reported success
while its start was still in flight, and a stop that never reaped left no
retryable handle. A read path that can mutate user data must not exist.

The transient runtime was therefore removed, not patched: `readHistory` reads
the file directly in-process (`readNativeSessionEntries`), the read-profile
wiring and model projection were deleted, and the acceptance compares real
native bytes and the session directory across success, corrupt-version,
identity-mismatch, missing-file and in-flight-write cases. The alternative —
keep a process but guarantee a detach/kill ordering that can never write — was
rejected because it preserves the failing architecture to satisfy its own
tests.

## Alternatives

- **Keep the transient read runtime and harden its teardown (detach-first,
  SIGKILL fallback).** Rejected by repair round 3: measured evidence shows the
  graceful dispose writes into whatever session the runtime holds, and a
  kill-based guarantee is one signal-timing change away from writing again.
  The direct reader makes the failure impossible instead of unlikely.
- **Use the runtime's high-level `loadSessionMessagesReadOnly` via a fork
  change.** Rejected: it returns folded `AgentMessage`s without entry ids, so
  it cannot feed the desktop's stable-row projection, and it would change the
  fixed fork/patch for a read the desktop can perform itself.
- **Return the whole branch without a window.** Rejected: unbounded payloads;
  the renderer already reads bounded pages.
- **Deduplicate the user row by content or a time window.** Rejected: two
  identical submissions are two submissions, and the acceptance requires both.
- **Persist a desktop-chosen identity into the runtime's transcript (fork
  change).** Rejected for this round: it would change a fixed input to solve a
  correlation the desktop can solve with the protocol that already exists
  (`user_message_persisted`, `replacesMessageId`).
- **Keep the live-durable duplicate and hide it in the renderer by content.**
  Rejected for the same reason as content dedupe, and because it makes a
  different engine's future rows collapse unpredictably.
