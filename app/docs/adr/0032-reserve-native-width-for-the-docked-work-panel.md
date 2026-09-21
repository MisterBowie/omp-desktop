# ADR 0032: Reserve native width for the docked work panel

- Status: Accepted (amended by ADR 0033 and ADR 0122)
- Date: 2026-07-29
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D163
- Supersedes in part: ADR 0029 and decision D156

## Context

ADR 0029 removed a circular ownership model in which work-panel changes and
native resize events rewrote each other. It made the panel a responsive column
inside the existing client area. That removed races and post-release jumps, but
opening the panel still consumed chat width, collapsing it expanded chat again,
and a native window-edge resize could temporarily compress the panel.

The intended docked behavior is closer to Codex: the panel has a committed
width of its own, the normal window reserves native width for that panel while
it is visible, and native window edges resize the conversation surface rather
than the tool surface. This requires controlled BrowserWindow geometry without
restoring the old delta-based circular ownership.

## Decision

Renderer panel layout and Electron window geometry remain separate owners, but
they coordinate through an idempotent target-state reservation:

1. The renderer owns one committed preferred panel width in the inclusive
   `364..720` range. An open docked panel renders at that fixed width; viewport,
   sidebar, and native-edge changes never clamp or rewrite it.
2. The preload exposes only
   `window/setWorkPanelReservation({ width: 0 | 364..720 })`. Electron Main
   returns `{ requested, reserved }`, where `requested` is the normalized
   current target and `reserved` is the native width currently added for it.
   Repeating a target has no cumulative effect.
3. In normal window state, Main derives visible bounds from persisted base
   bounds plus the target reservation. It expands toward the right first and
   shifts left only as far as required to keep the result inside the current
   display work area. `reserved` is capped by available work-area width.
4. Opening the visible panel requests its committed width. Collapsing it or
   closing its final resource requests zero and symmetrically removes both the
   added width and any reservation-induced x shift. A committed divider change
   updates the reservation target to the new committed width.
5. When the work area can supply the complete target, panel visibility and
   divider commits do not change chat width. When it cannot, Main reserves the
   available width, the panel still renders at its fixed committed width, and
   chat absorbs the unavoidable `requested - reserved` shortfall.
6. While a reservation is active, native edge resizing changes base window
   bounds and therefore chat width only. The reserved native width and the
   renderer's fixed panel width remain unchanged.
7. Maximized and fullscreen windows record the latest requested target but
   defer reservation geometry. Returning to normal state reconciles that target
   once against the restored base bounds and current display work area.
8. Moving the window to another display or changing display work-area geometry
   reconciles the same target against the new available width. Ordinary movement
   within one unchanged work area does not reapply reservation geometry.
9. Persisted normal bounds are base bounds with the active reservation width
   and reservation-induced x shift removed. Relaunch therefore never restores
   a panel-expanded shell as the chat-only window size.
10. Only the currently visible session context may set the reservation.
   Background-session artifacts may update their retained tabs but never alter
   visible reservation geometry.

The divider's anchored pointer math, frame-coalesced preview, commit-on-release,
and cancellation rollback from ADR 0029 remain in force. Live preview remains a
renderer layout operation; only a successful commit changes the native target.

## Consequences

- Opening and collapsing a panel preserve the conversation width whenever the
  display work area has enough unused width.
- Native edge gestures have one predictable effect: they resize the
  conversation while the panel remains fixed.
- Small displays can make chat narrower than its 360px readability target, but
  never silently compress the panel or corrupt its committed preference.
- Main owns a narrow, allowlisted geometry capability rather than an arbitrary
  delta resize channel. Target-state calls are safe to repeat during rapid
  session and resource transitions.
- Window-state persistence and maximize/fullscreen transitions must distinguish
  base bounds from temporary reservation geometry.

## Alternatives

### Keep all columns inside the current client area

Rejected because panel open/collapse would continue to resize the conversation,
and native edge gestures could continue to compress the panel.

### Restore renderer-supplied resize deltas

Rejected because deltas are not idempotent and recreate the stale-request,
double-resize, and persistence ambiguity removed by ADR 0029.

### Force the full reservation outside the display work area

Rejected because a fixed panel must not move native chrome off screen. Reserving
available width and assigning only the unavoidable shortfall to chat preserves
both panel fidelity and operable window chrome.

## References

- `docs/adr/0029-separate-window-and-panel-resize-ownership.md`
- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-056)
- `docs/spec/08-meta/decisions-log.md` (D163)
