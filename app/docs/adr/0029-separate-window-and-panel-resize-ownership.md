# ADR 0029: Separate native-window and work-panel resize ownership

- Status: Superseded in part by ADR 0032
- Date: 2026-07-28
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [08-component-spec §5](../spec/04-ux/08-component-spec.md) ·
  [09-interaction-patterns §8](../spec/04-ux/09-interaction-patterns.md) ·
  [01-ipc-protocol](../spec/03-runtime/01-ipc-protocol.md) · decision D156

> ADR 0032 supersedes the clauses that responsively clamp the panel inside the
> existing client area and prohibit all panel-driven native geometry changes.
> Main ownership of BrowserWindow geometry, renderer ownership of committed
> panel width, and the divider gesture/commit rules remain in force.

## Context

Work-panel visibility and divider commits previously called
`window/resizeBy` so Electron could grow or shrink the native window. Renderer
`window.resize` events then inferred whether the user moved the native right
edge and wrote part of that delta back into the panel width. Time-limited
attribution tickets attempted to distinguish those programmatic events from
real window gestures.

This formed a circular ownership model: the panel changed the native window,
and the native window changed the panel. It produced a second layout jump after
divider release, stale asynchronous growth on rapid open/close, window-position
drift near a display edge, platform-specific behavior, and preference values
that changed during an unrelated native resize.

## Decision

Native window geometry and renderer column geometry have independent owners:

1. Electron Main exclusively owns `BrowserWindow` bounds and persists the
   actual normal bounds. The supported minimum is 1040x700.
2. The renderer owns one preferred work-panel width in localStorage. The
   effective width is derived by clamping that preference against the current
   viewport, visible sidebar, and MainChat reserve.
3. Native window-edge gestures resize the shell only. They may temporarily
   clamp the effective panel width but never overwrite its preference.
4. The work-panel divider resizes internal columns only. Pointer math is
   anchored to the gesture start; move rendering is frame-coalesced; release
   commits once; Escape, pointer cancellation, and lost capture roll back.
5. Opening, collapsing, session-switching, and closing the panel never change
   native bounds on any platform.
6. The renderer-to-Main `window/resizeBy` IPC method, programmatic resize
   attribution tickets, panel growth tracking, and persisted-width offset are
   removed.

## Consequences

- Divider feedback remains continuous through release instead of triggering a
  second native resize.
- Native edge behavior is symmetric and matches platform window conventions.
- Windows, macOS, and Linux share one panel interaction model.
- A temporarily constrained panel returns to its preferred width when space
  becomes available.
- The preload surface is smaller, and Electron window-state persistence no
  longer needs a panel-specific offset.
- Normal bounds are read independently of maximized/fullscreen state and are
  flushed synchronously on close so a pending debounce cannot lose them.
- Opening a panel reallocates the existing client area, so MainChat can become
  narrower until the operator resizes either the divider or native window.

## Alternatives

### Keep delta IPC and add request identifiers

Rejected. Request identifiers can reject stale replies but do not remove the
circular geometry ownership or the post-release layout jump.

### Let Electron own the complete three-column layout

Rejected. Main does not know renderer sidebar state or content constraints, and
moving split-pane layout across IPC would add latency and duplicate DOM truth.

### Keep native right-edge ownership for the work panel

Rejected. Edge-source inference is not reliable across frameless windows,
display scaling, macOS window chrome, and Wayland. A native edge should retain
its standard meaning: resize the window.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-056)
- `docs/spec/08-meta/decisions-log.md` (D156)
