# ADR 0092: Use a plugin-owned surface with a host window-control capsule

- Status: Accepted
- Date: 2026-08-17
- Deciders: PI-Desktop core
- Related: D234, ADR 0081, ADR 0082

## Context

The first plugin-panel chrome revision made the host render a complete 46px
titlebar. It still split behavior by platform: macOS retained native traffic
lights, while Windows and Linux received a flat 112px control band. The host
also rendered the manifest title and a development-only safe-area reminder.

That chrome consumes the visual top-level hierarchy of a plugin panel. Plugin
authors cannot build their own toolbar without competing with a host title, and
the platform split makes the same plugin feel different on each desktop.

## Decision

1. Plugin panels use frameless `BrowserWindow` instances on macOS, Windows, and
   Linux. Native traffic lights and native panel menus are not part of the
   panel window surface.
2. The sandboxed preload reserves a transparent 46px safe area and renders one
   fixed capsule at the top-right. The capsule contains exactly three buttons:
   minimize, maximize/restore, and close. The host renders no panel title and
   no development reminder.
3. The plugin owns its title, toolbar, background, content, and all other
   visible panel UI. Normal-flow content is offset automatically; fixed or
   sticky plugin UI uses `--pi-plugin-titlebar-height: 46px`. A plugin-owned
   toolbar may opt into `-webkit-app-region: drag`, with interactive children
   opting out through `no-drag`.
4. The capsule remains in a closed preload-owned Shadow DOM. Its localized
   accessible labels, theme-adaptive colors, keyboard focus, reduced-motion
   behavior, and sender-validated private window-control channel remain
   unchanged. `window.pluginBridge` does not gain window primitives.

## Consequences

- A panel presents the same compact top-right control grammar on all supported
  platforms while giving each plugin complete ownership of its visible header.
- The 46px safe area remains a stable layout contract, so existing normal-flow
  panels do not move behind the controls and fixed plugin toolbars have a
  documented anchor.
- The manifest title remains useful as native window identity and launcher
  metadata, but it is no longer a host-rendered visual element.
- Development panels no longer need a host-only reminder; the devkit and plugin
  documentation must teach the safe-area variable and drag-region contract.

## Alternatives

### Keep native macOS controls and a host titlebar

Rejected because it keeps the platform split and reserves the plugin's primary
visual hierarchy for host chrome.

### Expose window controls to the plugin bridge

Rejected because plugin JavaScript still does not need generic native-window
authority; the preload-local, sender-validated channel is sufficient.

### Remove the safe area entirely

Rejected because a host control overlay still needs a stable hit and drag band,
and existing fixed/sticky plugin layouts would collide with the capsule.
