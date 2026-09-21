# ADR 0061: Imperceptible background context compaction

- Status: Accepted (clauses 2, 4, 6, 7, 8 amended by ADR 0064)
- Date: 2026-08-06
- Deciders: PI-Desktop core
- Amends: ADR 0030 / ADR 0049 / D158

## Context

The turn-boundary guard from ADR 0030 is correct: no provider request is issued
above the hard budget, and ADR 0049 gives every automatic failure a durable
retained-tail recovery. What it is not is invisible. Compaction announced
itself to the user in five ways:

- every successful automatic compaction raised an info toast;
- `compaction_start` set `isRunning`, so the run state and spinner jumped
  while nothing the user asked for was running;
- the soft boundary injected a transient instruction asking the model to call
  `CompactContext`, which spent a model turn and left a tool-activity row in
  the transcript;
- compaction ran only at `tokens >= hardLimit`, so it always happened at the
  moment the user was waiting for a reply, with a summary input close to the
  whole window in the worst case;
- Settings exposed `reserveTokens`, `keepRecentTokens`, and an enable switch,
  making the user responsible for tuning a safety mechanism.

Codex (`codex-rs/core/src/session/context_window.rs`,
`state/auto_compact_window.rs`) shows two ideas worth adopting: grade the
trigger instead of using one hard edge, and measure the trigger over the
*increment* since the current context prefix rather than the total
(`AutoCompactTokenLimitScope::BodyAfterPrefix`).

> Corrected by ADR 0064: this section originally added "Codex also has no
> model-side compaction tool at all — the host decides and executes." That is
> wrong. Codex has `new_context`
> (`tools/handlers/new_context_window_spec.rs`), gated by
> `Feature::TokenBudget`, and neither of the two ideas above is Codex's default:
> `BodyAfterPrefix` is opt-in and Codex has no pre-computation to grade a
> trigger for.

One property of the existing implementation makes background work cheap:
`entriesWithCompaction()` locates a checkpoint by `throughMessageId` and
splices it into the entry list, leaving everything after the anchor intact. A
checkpoint computed early therefore stays installable as the tail keeps
growing, so pre-computation needs no new invariant.

The fixed `reserveTokens: 16_384` / `keepRecentTokens: 20_000` defaults were
also a real defect independent of visibility: they applied the same absolute
numbers to a 32k window and a 1M window.

## Decision

Compaction becomes a host-owned background activity that the user cannot
perceive. The blocking hard boundary is unchanged and remains the safety net.

1. **Tiered budget, derived from the model window.** `contextBudget()` keeps
   `hardLimit` and `requestHeadroom` exactly as ADR 0030 defined them, and adds
   `backgroundLimit = floor(hardLimit * 0.7)` as the pre-computation trigger.
   `keepRecentTokens` is derived as `clamp(hardLimit * 0.2, 8k, 64k)`, still
   capped at half the hard budget. The soft boundary and its `softGap` are
   deleted.
2. **Incremental trigger scope.** Background pre-computation requires both
   `tokens >= backgroundLimit` and growth of at least `keepRecentTokens` since
   the baseline recorded when the newest checkpoint was installed. Without the
   increment test a large retained tail sitting above the background limit
   would request a fresh summary every turn while reducing nothing. The hard
   boundary keeps measuring the total, because that is the provider's actual
   constraint.
3. **Generation is separated from installation.** `buildCheckpoint()` runs the
   preparation, budget preflight, and summary request without persisting
   anything or touching `activeCompaction`. `installCheckpoint()` re-estimates,
   appends through host-core, updates `activeCompaction`, and emits
   `compaction_end`. The blocking path is the two composed back to back, so
   threshold, overflow, and manual behavior are unchanged.
4. **Provider-idle windows only.** Background summary requests are started from
   exactly two places: `tool_execution_start`, where the model stream has ended
   and the next request has not been issued, and the `finally` of `prompt()`,
   where the user is reading the result. A background summary never shares the
   provider connection with a streaming turn: `prepareNextTurn()` awaits any
   in-flight build before the next request. Background work deliberately does
   not set `compactionInProgress`, because that flag feeds
   `getStatus().isRunning`.
5. **Staleness is checked at install, and failure is silent.** A pre-computed
   checkpoint is consumed at the next turn boundary or user prompt only if the
   checkpoint it was based on is still active, its `throughMessageId` anchor is
   still present in `fullEntries`, and it still fits the *current* model's
   budget. Any miss discards it and falls through to the existing blocking
   path. A failed background build is discarded without persisting, without an
   event, and without the ADR 0049 fallback: the retained tail belongs to the
   hard boundary, which is still there to catch whatever background work
   misses.
6. **No model-facing compaction.** `CompactContext`, the
   `<context_management>` nudge, and the `"CompactContext"` entry in the
   host-core no-confirmation allowlist are removed. Triggering is entirely
   deterministic and host-driven.
7. **Silence.** `compaction_start` and `compaction_end` carry an optional
   `phase?: "background" | "blocking"` (absent means `blocking`; additive per
   ADR 0047, so the protocol version does not change). A successful automatic
   compaction — background or blocking — notifies nobody: no toast, no run
   state change, no transcript row. Three toasts remain, each following
   something the user already saw: a `retained_tail` fallback (warning), an
   overflow retry (warning), and a manual `/compact` result.
8. **The context inspector is the only visible trace.** `compaction_end`
   carries `status: { generation, summaryTokens }`, and the durable
   `SessionDetail.compaction` provides the same on session open or fork. The
   inspector renders one line — `Compacted N× · summary ≈X` — and nothing when
   there is no checkpoint. The generation counter rides inside the checkpoint's
   opaque `details` value, which host-core persists verbatim, so no record
   schema change is needed.
9. **No settings.** The Settings compaction card, its search keywords, its
   i18n keys, and the main-process passthrough are removed. Persisted
   `contextCompaction` values are ignored, deliberately: a user who once turned
   compaction off would otherwise have no switch left to turn it back on. The
   `ContextCompactionSettings` type survives as the runtime's
   construction-time override so tests can build a compaction-disabled
   session.

Manual `/compact` is unchanged and remains fail-fast.

## Consequences

- In the common case the user never waits for compaction. The summary request
  overlaps a tool execution or an idle session, and the turn boundary only
  installs an already-finished checkpoint.
- Summary inputs are smaller and cheaper, because 0.7 of the hard limit is a
  much smaller history than the hard limit itself.
- A session that crosses the background limit pays for a summary it might not
  have needed. 0.7 is the cost trade: past that point reaching the hard limit
  is close to inevitable, so the tokens are rarely wasted, while a lower ratio
  would bill short sessions for summaries they never use.
- Small-window and large-window models now get proportionate budgets instead of
  one pair of absolute token counts.
- Losing the model-side tool removes a class of wasted turns and a transcript
  artifact, and removes the possibility of the model ignoring, deferring, or
  repeating the request. Nothing is lost that the deterministic trigger did not
  already cover.
- Compaction is no longer auditable from the transcript. The inspector line,
  the durable checkpoint record, and the lifecycle events remain, so
  diagnosis is possible; casual observation is not. This is an accepted
  reversal of ADR 0030's "remain visible/durable as a tool activity row".
- Users can no longer disable automatic compaction from the UI. Since a
  disabled guard means an oversized provider request, that is the intended
  outcome.
- Two provider-idle windows are not all of them. A session that never runs a
  tool and never goes idle between prompts still compacts synchronously at the
  hard boundary, exactly as before.

## Alternatives

### Compact concurrently with the streaming turn

Rejected. It would remove the last of the latency, but two simultaneous
requests on one provider connection invite rate limiting (observed on Bedrock)
and double the visible cost of a single user action.

### Keep the soft-boundary nudge alongside background compaction

Rejected. With deterministic pre-computation the nudge adds only the failure
modes it always had — a spent turn, a transcript row, and a model free to
ignore it.

### Keep the settings knobs but hide them behind a developer toggle

Rejected. The values are now derived from the model window; an override would
be a way to reintroduce the small-window/large-window defect, and a hidden
switch to disable a safety guard is worse than no switch.

### Show a subtle inline indicator while compacting

Rejected. Any persistent indicator makes the user aware of a mechanism they
cannot act on. The inspector already answers the question for anyone who
thinks to ask it.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/03-runtime/02-agent-runtime.md`
- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D158, D200)
- `codex-rs/core/src/session/context_window.rs` (behavioral reference)
