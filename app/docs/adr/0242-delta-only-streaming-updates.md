# ADR 0242: Delta-only coalesced streaming updates

- Status: Accepted
- Date: 2026-09-14
- Decision: D412
- Amends: ADR 0127, ADR 0130, ADR 0149, ADR 0153
- Issue: #299

## Context

Long Agent turns streamed at 200+ tokens/s from the provider, but PI-Desktop
displayed them at a much lower rate that got worse the longer the turn ran.
Stop plus a new prompt restored speed; the same turn's later short thinking
blocks stayed slow. Subagents showed the same lag. TTFT was fine.

Each `message_update` flattened the full assistant snapshot, compared it with
`startsWith` against the accumulated string, `JSON.stringify`'d the whole
`UiMessage` onto sidecar stdout, and AgentHost `boundPayload()` stringified it
again to check frame size. Renderer batching only ran after that work. A
length-n stream therefore cost about O(n²) bytes and CPU on the hot path and
backlogged the pipeline.

The renderer already split history from the active tail, but the active
`AssistantTurn` rebuilt every activity part on each token and handed new
delegation `Map`s to every `ActivityGroup`, so historical groups in the same
turn re-rendered with the tail.

RACP already documented `item.delta` as non-durable delta text, with the full
row completed in `item.completed`. The local event still carried a full
snapshot on every update.

## Decision

Keep `currentAssistant` as the in-memory authority in the runtime. On the
append-only streaming path, emit `message_update` with:

- `stream: "delta"`
- `deltaText` / `deltaThinking`
- `resetText` / `resetThinking` when the provider replaced rather than
  appended
- a slim `message` identity (id, role, status, createdAt, model/provider,
  parentToolCallId, agentName) without growing `content` / `thinking`

A 16ms coalescer in `DesktopAgentRuntime` concatenates pending deltas and
flushes immediately before `tool_start`, `tool_end`, `message_end`, `error`,
`abort`, retry snapshots, and other semantic events so order is preserved.

`message_start` and `message_end` still carry a full `UiMessage`. Retry and
other snapshot replacements omit `stream` and still replace the live row.

First-party consumers apply deltas:

- AgentHost patches `activeItems` and skips `JSON.stringify` for small delta
  frames
- Electron main reconstructs the inflight checkpoint snapshot from deltas
- the renderer concatenates same-frame deltas, then patches the live
  `UiMessage`

The transcript projection reuses unchanged activity parts and keeps
delegation status/timing `Map`s stable when their contents did not change.
Only the live tail ActivityGroup receives `runtimeActivity`.

Protocol version remains 11. The new fields are additive. Consumers that
ignore `stream` and replace with `message` still receive `message_end` as the
authoritative row.

## Consequences

- Cross-process streaming bytes grow with the new chunk, not with the
  cumulative snapshot.
- A long turn no longer forms a serialization backlog that later short
  chunks wait behind.
- Historical activity groups in the active turn do not re-render for each
  tail token.
- Crash-recovery checkpoints still see a reconstructed full snapshot.
- Remote RACP `item.delta` payloads match the documented delta contract.

## Alternatives

- Coalesce only in the renderer: rejected; the O(n²) stringify already
  happened in the sidecar and main.
- Drop tokens or raise the debounce to 50ms: rejected; that hides backlog
  rather than removing it.
- New `message_delta` event type: unnecessary; additive fields on the
  existing `message_update` keep old consumers compiling.
