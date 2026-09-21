# ADR 0081: Host-owned cross-platform plugin panel chrome

- Status: Accepted
- Date: 2026-08-13
- Deciders: PI-Desktop core
- Related: D118, D129, D218, ADR 0021, ADR 0025

## Context

Plugin panels run in separate sandboxed `BrowserWindow` instances and load
plugin-owned HTML. Those windows previously used Electron's default frame, so
their titlebar did not match the main PI-Desktop window and differed materially
between macOS, Windows, and Linux.

The panel page cannot be trusted with the main renderer preload or an arbitrary
window-control bridge. The host chrome also must not depend on plugin CSS,
while existing plugin layouts need to begin below the new titlebar without
losing their original top padding.

## Decision

1. Plugin panels use the same platform split as the main window: macOS uses
   `hiddenInset` with traffic lights at `{x:16,y:16}`, while Windows and Linux
   use a frameless window with renderer-drawn controls.
2. The existing sandboxed plugin-panel preload installs a host-owned 46px
   titlebar in a closed Shadow DOM. It renders the manifest panel title and
   offsets the plugin body by 46px in addition to its computed top padding. It
   also publishes `--pi-plugin-titlebar-height: 46px` for fixed/sticky plugin
   UI that must sit below the host chrome.
3. Windows/Linux expose minimize, maximize/restore, and close through one
   Electron-local fixed action tuple. Electron Main accepts the action only
   when the sender belongs to a live plugin panel and publishes maximize state
   only back to that panel.
4. The public `window.pluginBridge` surface does not gain window primitives.
   The existing per-plugin session partition, sandbox, context isolation, and
   permission-checked panel bridge remain unchanged.
5. Controls carry localized accessible names, visible keyboard focus, theme-
   aware light/dark surfaces, and reduced-motion behavior. Reopening an already
   minimized panel restores and focuses the existing window.
6. Development panels receive a host-only titlebar reminder for the 46px safe
   area. Installed panels do not show this authoring hint.

## Consequences

- Plugin panels visually align with the main application chrome on all three
  release platforms without granting plugins broader Electron access.
- Plugin CSS cannot style the closed titlebar tree, although a plugin can still
  replace its own document and therefore remove the preload-injected visual
  element. That does not grant a capability or cross the panel sandbox.
- The host reserves 46px above plugin content. Panels that deliberately pin
  viewport-fixed content to `top: 0` must account for the titlebar, using the
  injected `--pi-plugin-titlebar-height` variable.
- The private window-control channel remains outside host-core protocol v9.

## Alternatives

### Keep Electron's default panel frame

Rejected because it preserves inconsistent product chrome and leaves
Windows/Linux panels visually detached from the main application.

### Expose the main window-control API to plugin JavaScript

Rejected because the plugin bridge should remain limited to declared plugin
capabilities and must not acquire generic native-window authority.

### Host plugin content inside the main renderer DOM

Rejected because it would weaken the existing separate-window, separate-
partition isolation model for a visual-only change.

## References

- `docs/spec/03-runtime/01-ipc-protocol.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-024D)
- `docs/spec/07-plugins/01-plugin-system.md`
- `docs/spec/07-plugins/04-plugin-security.md`
