# ADR 0332: OMP input attachments and desktop-owned global instructions

- Status: Accepted by the user on 2026-10-22 ("wire what can be wired").
- Related: ADR 0304 (capability-source ownership), ADR 0313 (native history
  reads), ADR 0331 (OMP-only product).

## Context

After ADR 0331 made OMP the only engine, three settings still looked usable but
did nothing for OMP chats. Main refused every OMP prompt with attachments, so a
pasted image failed. Settings → Instructions edited the user's real
`~/.pi/agent/AGENTS.md`, which OMP runs never read and which belongs to another
product. Vendor OAuth sign-in created providers that the OMP model projection
refuses.

## Decision

1. **Attachments use the earlier preparation rules.** Prompts, steering input
   and host-queued follow-ups prepare attachments in Electron main with the
   existing session-root checks. Images go inline through the runtime's own
   `prompt`/`steer` `images` field only for a model projected with image input,
   at most 10 MB each and `MAX_SESSION_RECORD_BYTES / 2` per input. The runtime
   stores a user message as one base64 record, and the history reader refuses a
   larger record. Other attachments and images past the budget become file
   references in the text.
2. **Rows show the image the runtime kept.** OMP may re-encode an image before
   storing and sending it. The event converter takes an injected store. For
   live and restored user rows it writes those bytes once under
   `attachments/<sha256>` and names that ref, instead of guessing the original
   upload's digest.
3. **Global instructions are desktop data.** The editor writes
   `<data>/AGENTS.md`. Each run receives the bounded content (32 KiB, labelled
   truncation) as `<synthetic HOME>/.agents/AGENTS.md`, which OMP loads natively
   as user-level context. It joins the subagent catalog in the launch
   fingerprint, so an edit rebuilds an idle runtime before the next prompt.
   Nothing is read from, written to or migrated out of `~/.pi`.
4. **OAuth sign-in is hidden** until the projection can carry OAuth
   credentials. Existing accounts stay listed for testing and removal.

## Consequences

- Image-capable models receive images in OMP chats. A restored transcript
  shows the re-encoded copy the model saw, at the cost of one content-addressed
  write per distinct image when a row is first converted.
- Users who kept global instructions in `~/.pi/agent/AGENTS.md` start with an
  empty editor and must re-enter them. This follows the no-migration rule of
  ADR 0331.
- The 32 MiB inline budget is tied to the reader's record ceiling. Raising one
  without the other would let a native session become unreadable.
- Collaboration-message origins are still refused for OMP. OAuth providers
  still cannot drive OMP chats; the hidden entry only stops creating new ones.
