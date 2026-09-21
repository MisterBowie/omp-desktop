# ADR 0030: Turn-boundary context checkpoint compaction

- Status: Accepted; soft-boundary, model-tool, and visibility clauses
  superseded in part by ADR 0061, then partly restored by ADR 0064
- Date: 2026-07-28
- Last amended: 2026-08-06
- Amended by: ADR 0049 (failure recovery), ADR 0061 (background compaction;
  removes the soft-boundary nudge, the `CompactContext` tool, and the
  visibility of compaction activity), ADR 0064 (Codex parity; compaction is
  inline again, the model-facing tool and budget reminders return, and every
  compaction is visible)

## Context

A long pi agent run can contain many model/tool turns before `agent_end`.
Compacting only between user prompts or after the run is already terminal does
not protect the next provider request inside that loop. The observed Bedrock
failure reached 1,077,172 tokens against a 1,000,000-token provider maximum,
so the provider rejected the request before PI-Desktop had a recovery point.

pi-agent-core already supplies session-context reconstruction, token
estimation, cut-point selection, summary generation, retained-tail handling,
and compaction records. It does not define PI-Desktop's renderer lifecycle,
Rust-owned persistence, provider-headroom policy, or long-loop guard.

OpenCode Dynamic Context Pruning (DCP), inspected at commit
`85b6f5ceba144fee9e65eb28dc36cab1b960e418`, demonstrates useful behavioral
patterns: evaluate context each turn, inject deduplicated guidance before the
emergency boundary, and let the model request context management. It is an
OpenCode plugin under AGPL-3.0, so directly linking or copying it would add an
incompatible runtime and licensing boundary to PI-Desktop.

## Decision

PI-Desktop uses pi-agent-core's public compaction primitives and independently
implements the desktop-specific controller.

- The controller runs after every `turn_end` and before pi starts another
  provider request. `turn_end` is a model/tool-turn boundary; only `agent_end`
  or `error` ends the overall desktop run.
- Budgeting uses the pi-ai model context/output limits. Request headroom is at
  least the configured reserve, the model output allowance capped at 25% of
  context, or 5% of context. A configured reserve cannot consume more than
  half the window. The retained-tail target cannot exceed half the remaining
  hard budget, so small-window models remain compactable. *(ADR 0061 keeps
  this headroom rule and derives the reserve and retention targets from the
  model window instead of settings. ADR 0064 removes ADR 0061's background
  limit and replaces the retained tail with recent user messages only, capped
  at 20,000 tokens.)*
- At the soft boundary, a transient system instruction asks the model to call
  `CompactContext` with the active-task focus. It is eligible only after tool
  turns and repeats at most once every three qualifying turns. The instruction
  is not persisted and does not mutate the durable system prompt. *(Superseded
  by ADR 0061: the soft boundary and this instruction are removed.)*
- `CompactContext` bypasses the Rust tool/permission bridge because it changes
  model context, not the workspace. Its call and result use normal tool events
  and remain visible/durable as a tool activity row. The requested checkpoint
  is generated only after that tool turn finishes, preserving provider-valid
  call/result pairing. *(ADR 0061 removed the tool; ADR 0064 restores it as
  `new_context` with these same semantics, and restores a transcript row —
  a divider owned by the checkpoint rather than the tool's activity row.)*
- At the hard boundary, the runtime generates a checkpoint deterministically.
  The candidate context is re-estimated before persistence and again before
  continuation. Automatic summary failure or an ineffective checkpoint first
  attempts the retained-tail recovery defined by ADR 0049; if that recovery
  cannot be prepared, durably appended, or brought below the safe budget, the
  loop stops before another provider request with
  `CONTEXT_COMPACTION_FAILED`. *(ADR 0061 keeps this path unchanged as the
  safety net; under ADR 0064 it is again the only path.)*
- A final tool-result batch is kept with its assistant tool-call carrier. If
  that atomic batch exceeds the normal retained-tail target, the runtime lets
  pi move the cut point to the carrier. If the batch itself reaches half the
  hard budget, PI-Desktop creates a checkpoint-only bounded copy: each result
  keeps its tool identity/error envelope and a fair share of head/tail text
  with an explicit checkpoint-truncation marker, while duplicate diagnostic
  details are omitted. The original durable messages and visible transcript
  remain complete. The bounded copy is re-estimated before persistence and can
  never authorize an oversized provider request.
- An exact provider overflow is a final safety net. The failed assistant stays
  visible for diagnosis but is removed from model context; the runtime creates
  one checkpoint and retries the model request once. A second overflow is
  terminal.
- Automatic protection is enabled by default. Disabling it removes the model
  tool and disables threshold and overflow recovery. Manual `/compact` remains
  available for an idle session. *(ADR 0061 removes the user-facing switch:
  protection is always on and persisted `enabled: false` values are ignored.)*
- Protocol v6 adds a host-owned `session.appendCompaction` operation and
  compaction lifecycle events. The host appends a typed checkpoint line to the
  session JSONL file. Visible messages are never deleted, rewritten, or hidden
  by context compaction.
- Only the newest valid checkpoint rebuilds model context. Transcript rewrites
  preserve it only while its boundary remains present. Forks copy and remap it
  only when the fork includes that boundary.

## Consequences

- Long tool loops receive context checks at the only boundary that can protect
  the next request without interrupting an active model or tool call.
- The deterministic hard guard does not depend on the model obeying a reminder.
- Restart and model changes retain compacted working context without changing
  the human-readable conversation.
- Compaction itself is one extra provider request and can fail. Automatic
  failures have a deterministic, durable retained-tail recovery, while manual
  compaction remains fail-fast; the lifecycle is explicit, abortable, and
  surfaced through stable events/error codes.
- A checkpoint may retain a shortened model-facing copy of an oversized atomic
  tool-result batch. This is a loss of future model detail under pressure, but
  it is explicit in context, preserves every call/result pair, and does not
  alter the user-visible or diagnostic transcript.
- Provider token accounting on retained assistant messages is cleared while
  reconstructing a checkpoint, because that usage described the pre-compacted
  request and would otherwise overcount the restored context.
- OpenCode DCP updates do not flow into PI-Desktop automatically. Any future
  behavioral adoption requires a fresh independent implementation review.

## Alternatives

### Integrate OpenCode DCP directly

Rejected because it targets OpenCode's plugin hooks and persistence model and
is AGPL-3.0. PI-Desktop needs a Rust-host durability contract and pi-specific
turn lifecycle, so an adapter would retain most of the implementation cost
while adding license and upgrade coupling.

### Use pi compaction only at `agent_end`

Rejected because no `agent_end` occurs between tool turns in one long run. The
next provider request can already be oversized.

### Rely only on a model reminder

Rejected because the model may ignore, postpone, or repeat the request. Soft
guidance is useful for summary focus but cannot enforce the provider limit.
*(ADR 0061 goes further and removes the reminder entirely: with pre-computed
checkpoints its only remaining effect was a spent turn and a transcript row.
ADR 0064 brings reminders back in a different shape — two budget notices tied
to the remaining token count rather than a request to call a tool — and keeps
the hard boundary as the enforcement point, exactly as this rejection
requires.)*

### Delete older visible transcript messages

Rejected because context management must not destroy user history, revision
families, fork inputs, searchability, or diagnostics.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/04-ux/04-builtin-commands.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D158)
- `https://github.com/Opencode-DCP/opencode-dynamic-context-pruning`
