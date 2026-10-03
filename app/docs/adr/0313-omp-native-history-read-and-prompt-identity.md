# ADR 0313: OMP native history reads and one identity per submitted prompt

- Status: Accepted (M5/T20-D repair round 2; 2026-10-03). Implementation
  complete, pending the root's independent re-review. Does not claim M5/T20
  completion: the full matrix and the three-platform packages remain.
- Date: 2026-10-03
- Scope: how an OMP session's transcript reaches the renderer, and how a
  submitted prompt's user row keeps one identity across the optimistic render,
  the runtime's durable echo and a later durable read.
- Amends: ADR 0300 (engine boundary: adds the read path at the `sessionGet`
  boundary), ADR 0312 §"1" (the capability keys are unaffected; this ADR adds
  no capability). Keeps every closed capability closed.
- Evidence: `docs/validation/M5-t20-d-capability-ui.md` §0 (repair 2),
  `app/apps/desktop/electron/main/runtime/omp-session.ts`,
  `app/apps/desktop/electron/main/runtime/omp-model-projection.ts`,
  `app/apps/desktop/electron/main/ipc/session-ipc.ts`,
  `app/apps/desktop/electron/main/ipc/agent-ipc.ts`,
  `app/packages/omp-runtime/src/session/history.ts`,
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

The runtime's RPC surface already exposes exactly the read this needs —
`get_entries` (the canonical append history plus the active `leafId`) — and its
own documentation blesses the structural subset (`id`/`parentId` plus message
entries) for permissive clients. Re-implementing the session file format in the
desktop would be a second parser of a format the runtime owns; dumping the file
without a running runtime would trade one duplication for another.

## Decision

1. **The transcript is read from the runtime, read-only, through a transient
   read profile.** `OmpSessionBridge.readHistory` projects `get_entries` into
   desktop rows (active-branch walk, entry ids as row ids, `toolCallId` for
   tool rows whose call id is unique on the branch) with the same bounded
   window PI's native reader applies. A session whose runtime is alive is asked
   through that runtime (the transcript's own writer, no second process on one
   file); otherwise a transient supervisor is started from a **read profile**:
   the session's model identity projected *without* its credential (`auth:
   none`, or a loopback placeholder when the provider row cannot be projected),
   no `--model` selector, no run-scoped state, and no prompt ever sent. The
   reader is switched to the persisted transcript, verifies the identity the
   runtime reports, reads, steps off the transcript (`new_session`) and is
   reclaimed — so the runtime's own `session_exit` diagnostic cannot land in
   the transcript it just read. A read therefore requires no usable provider
   credential, issues no provider request, executes no tool and leaves the
   transcript byte-identical.

2. **Fail closed, except for a session that truly has nothing.** A missing,
   foreign, half-written or version-incompatible native reference, an
   unreachable runtime, a malformed entry list and a failed reclaim all throw.
   An empty page is reserved for a session with no native reference yet. A
   partially reclaimed reader is reported as a failure, never as a silent leak.

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
- A history read costs one runtime start when the session has no live runtime.
  That is the price of reading the transcript through its owner instead of
  parsing the file in the desktop; the runtime is the same one the next prompt
  would have started, and the read profile is transient by construction.
- `SessionDetail.replacedLiveMessageIds` joins the shared session types as an
  optional field: engines whose live and durable ids already agree (Pi native,
  desktop) never set it, and a reader that ignores it loses nothing.
- The reader's model catalogue names the session's model without a credential.
  It can never serve a request (no prompt reaches the reader), and the secret
  never enters a process whose only job is to parse a transcript.
- Known limit: a live row older than the returned tail window — possible only
  when a single app run produced more rows than the ledger bound — is not named
  while the window does not contain its twin; its durable row arrives with the
  older page, and the row is never dropped from storage.

## Alternatives

- **Parse the native JSONL in the desktop.** Rejected: a second implementation
  of branch/leaf/compaction semantics the runtime owns, kept in sync by hope.
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
