# ADR 0065: Smooth shell layout and stream feedback

- Status: Accepted for implementation
- Date: 2026-08-07
- Deciders: PI-Desktop core
- Related: ADR 0033, ADR 0122, D146, D163, D255

## Context

The shell's sidebar and work panel already used enter/exit keyframes, but the
keyframes changed only opacity and a small transform. Their flex allocations
changed to the final width as soon as the element mounted, so MainChat moved
before the first visible frame and moved back after the exit animation. This
made panel and sidebar actions feel like a jump followed by a cosmetic fade.

Agent streams had a similar timing problem. Every `message_update` and
`tool_update` replaced the renderer message array immediately, while the
transcript rebuilt its grouped entry projection and follow-scroll work. A fast
provider could therefore spend several updates in one frame on historical
transcript work instead of presenting the newest tail smoothly.

The docked composer also painted a full-width gradient veil over the lower
transcript. The composer already reserves its measured height and owns an
opaque elevated surface, so the veil added visual noise without carrying state.

## Decision

1. Sidebar and work-panel mount/exit animations animate both `width` and
   `flex-basis` from zero to the committed dock width, in addition to the
   bounded opacity/transform feedback. The panel remains an in-flow fixed-width
   column and the OS window reservation contract does not change.
2. The renderer coalesces high-frequency `message_update` and `tool_update`
   events by stream target until the next animation frame. Only the newest
   event for each target is applied. Any non-stream control or terminal event
   flushes the pending batch first, so lifecycle ordering and final states stay
   synchronous.
3. `ChatTranscript` uses React's deferred value for the heavy grouped-entry
   projection and minimap input. Immediate controls, permission state, running
   state, and terminal outcomes remain synchronous.
4. The docked composer uses a transparent outer dock with bottom space reserved
   by the transcript; the composer shell remains the only elevated surface.
5. An activity group only receives terminal failure styling after its active
   run settles. Intermediate error rows remain visible, but a provider/tool
   retry does not make the whole still-running group look finished.

## Consequences

- Opening and closing auxiliary columns now reflows MainChat continuously over
  the bounded motion duration instead of jumping before the animation.
- A stream may display the newest partial content one paint later when events
  arrive faster than the display refreshes, but redundant intermediate payloads
  are discarded and terminal events are never delayed.
- Long transcripts still need a future true virtualization pass; this decision
  reduces update pressure without changing message persistence or grouping.
- Removing the dock veil makes the transcript surface visually quieter and
  keeps the composer separation dependent on its measured layout and elevation.

## Alternatives considered

### Transform-only dock animation

Rejected because it leaves the flex allocation at its final value before the
first painted frame, which is the source of the visible layout jump.

### Overlay the work panel above MainChat

Rejected for this change because the current frozen shell contract is a docked
third column with a fixed committed width. Overlaying it would hide transcript
content and require a broader responsive and accessibility decision.

### Debounce all agent events

Rejected because lifecycle, permission, planning, and terminal events need
immediate ordering. Only replaceable partial stream updates are coalesced.
