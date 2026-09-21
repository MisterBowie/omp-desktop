# ADR 0086: Keep macOS on the regular activation policy

- Status: Accepted
- Date: 2026-08-14
- Deciders: PI-Desktop core
- Related: D223, E2E-127, ADR 0072, ADR 0078, ADR 0080

## Context

The global plugin launcher (ADR 0072) is a frameless always-on-top panel that
should appear over whatever the user is doing, so its window asked Electron for
`setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })`. On macOS that
option is not a per-window flag: Electron implements it by calling
`TransformProcessType(kProcessTransformToUIElementApplication)` on the whole
process, because macOS 10.14 and later only let accessory applications float
windows above another app's fullscreen Space. The process therefore became a
UIElement app and PI-Desktop disappeared from the Dock and from Cmd+Tab.

ADR 0080 then moved launcher creation into boot warm-up, so the transform ran on
every launch even when the launcher was never opened. The window itself was
still on screen, which made the symptom look like a window-manager bug rather
than an activation-policy change.

Minimize hides the main window into the tray (ADR 0078), and macOS only emits
Electron's `activate` event from `applicationShouldHandleReopen:` — a Dock click
or a relaunch. Cmd+Tab and App Exposé do not reach it, so a tray-hidden window
had no keyboard route back even once the app was listed again.

## Decision

1. PI-Desktop is a regular (foreground) macOS application for its entire
   lifetime. No code path may transform the process type: the launcher passes
   `skipTransformProcessType: true`, and `app.dock.hide()` and
   `app.setActivationPolicy` stay out of the main process. Dock and Cmd+Tab
   presence is an invariant, not a side effect of one window's options.
2. The launcher keeps its collection behavior: it joins every regular Space and
   floats above PI-Desktop's own fullscreen window. It does not overlay another
   application's fullscreen Space; macOS reserves that for accessory apps, and
   activation switches Spaces there instead.
3. macOS activation restores the shell through `did-become-active` as well as
   `activate`, gated on a booted, non-quitting app with no visible window. Cmd+Tab
   and App Exposé bring a tray-hidden window back, while showing the launcher or a
   plugin panel does not drag the main window forward with it.
4. Tests assert the launcher call shape and the activation handler, so a future
   window option cannot silently make the app accessory again.

## Consequences

- The app is always reachable from the Dock, Cmd+Tab, App Exposé, and the tray.
- The launcher cannot overlay another app's fullscreen Space. Invoking it from
  one activates PI-Desktop and switches Spaces, which is ordinary foreground-app
  behavior.
- Panel focus is unchanged: `show()` activates the app and makes the panel key
  under both policies, so ADR 0080's latency work is untouched.

## Alternatives

- Toggle the policy around each launcher show (`app.dock.hide()` before,
  `app.dock.show()` after). It restores fullscreen overlay, but it flickers the
  Dock icon on every invocation, adds work to the path ADR 0080 optimized, keeps
  a window where Cmd+Tab cannot see the app, and leaves the app permanently
  accessory if the restore is ever missed.
- Drop `visibleOnFullScreen` entirely. Same Dock fix, but the launcher would also
  stop covering PI-Desktop's own fullscreen window for no gain.
- Ship PI-Desktop as an `LSUIElement` tray app. That contradicts ADR 0078's
  resident main window and the product's main-window shape. Overlaying other
  apps' fullscreen Spaces would need a separate accessory helper process, not a
  process-wide transform in the app that owns the main window.
