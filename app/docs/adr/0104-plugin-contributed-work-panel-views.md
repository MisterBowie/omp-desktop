# ADR 0104: Plugin-contributed work panel views

- Status: Accepted
- Date: 2026-08-19
- Deciders: PI-Desktop core
- Related: [ADR 0019](0019-work-panel-subsystems.md) ·
  [ADR 0033](0033-internal-dock-work-panel.md) ·
  [ADR 0122](0122-reserve-native-width-while-work-panel-visible.md) ·
  [ADR 0081](0081-host-owned-plugin-panel-chrome.md) ·
  [ADR 0092](0092-plugin-owned-panel-surface.md) ·
  [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [ADR 0108](0108-remove-built-in-interactive-terminal.md) ·
  [07-plugins](../spec/07-plugins/README.md) ·
  [04-ux/08-component-spec §5](../spec/04-ux/08-component-spec.md)

## Context

Before ADR 0108 removed the interactive terminal, the right work panel
exposed four capabilities — Review, Terminal, Browser, Files (ADR 0019) — as a
hard-coded list in the renderer: a `HEADER_TOOLS` constant, a closed
`WorkPanelTabKind` union, and a four-way branch on tab kind in the panel body.
Adding any new surface meant changing host code.

Plugins already have a mature and strictly bounded UI channel, but it only
produces a **separate window**: `ui.panel` opens a frameless `BrowserWindow`
with a sandboxed preload, a per-plugin persisted session partition, and a
`net.domains` egress allowlist (ADR 0092). A plugin cannot put anything inside
the main window, so capabilities that belong next to the conversation — a Git
history browser, a file manager, an issue list — either become a detached
window that competes with the app for screen space, or do not exist.

The work panel is the natural home for those surfaces. It is already the
"inspect and steer the workspace" column, it is already session-scoped
(ADR 0028), and it is an in-flow part of the client area with a temporary
native reservation while visible (ADR 0122).

## Decision

1. **A plugin declares work panel surfaces with `contributes.views`.** Each
   entry carries an `id`, a `title` (plain or `{ en, "zh-CN" }`), an optional
   `icon` token, an HTML `entry` relative to the plugin, and an optional
   `order`. A plugin may declare several: a Git plugin can ship "Changes" and
   "History" as independent entries. The new `ui.view` permission gates the
   contribution, parallel to `ui.panel`; the two are independent, so a plugin
   may have docked views without a detached window.

2. **A view is rendered as a `WebContentsView` owned by the main process**,
   attached to the main window and positioned from a renderer-measured rect —
   the mechanism the preview browser has used since ADR 0019/0033. It reuses
   the plugin's existing isolation wholesale: the same sandboxed
   `plugin-panel` preload, the same persisted `persist:pi-plugin-<id>`
   partition as that plugin's detached window, and the same `net.domains`
   egress filter. The egress policy and the partition name are extracted to
   shared functions so the docked and detached placements cannot drift into
   different security postures.

3. **The renderer is the visibility authority.** A `WebContentsView` composites
   above renderer content, so the panel hides every native surface — the
   browser and any plugin view alike — whenever it is not the active tab, the
   panel is animating, the divider is being dragged, or a blocking overlay is
   open. One `panelBlocked` condition governs all of them.

4. **An embedded view drops the window-control chrome.** A docked view has no
   window to minimize, maximize, or drag, so the preload skips the three-button
   capsule and the 46px safe area that ADR 0092 defines, and publishes
   `--pi-plugin-titlebar-height: 0px` instead of `46px`. Plugin authors read the
   variable rather than hard-coding a value, so one entry file lays out
   correctly in both placements. `window.pluginBridge` is byte-for-byte the
   same, so a view and a panel share their code.

5. **Icons are tokens from a host-owned closed list**, never plugin-supplied
   markup. The icon is drawn inside host chrome next to first-party controls;
   accepting SVG there would be an injection surface and would let a plugin
   dress up as the host. An unknown token is not an error — it degrades to a
   lettered tile — so a plugin written against a newer host still lists
   correctly on an older one.

6. **The view list is filtered by activation scope.** This differs deliberately
   from `pluginThemes`, which is *not* scope-filtered because the selected theme
   is one global app setting. A view is something a plugin does inside a
   project, so a project-scoped plugin must not offer its view in another
   project. Permission, scope, and entry existence are re-checked when a view is
   opened; the renderer is never the authority on what a plugin may show.

7. **Views are cached, bounded, and tied to the plugin's lifetime.** A view
   survives tab switches so a plugin keeps its scroll position and in-page
   state, up to four live views, evicting the least recently shown and never the
   one on screen. Disable, uninstall, reload, and crash all destroy the
   plugin's views; the tab may outlive the page, so the renderer re-opens on the
   lifecycle event rather than leaving a permanently blank pane.

## Consequences

- The work panel becomes an extension point rather than a fixed set. Third-party
  plugins reach it through the same route first-party code will use once ADR
  0103's migration lands, which is what makes that migration a real test of
  whether the plugin API is sufficient.
- A plugin's storage is one thing regardless of placement, because a view and
  that plugin's detached window share a partition. Opening a view therefore
  inherits any session state the panel window already had.
- `windowForSender` must scan windows directly instead of resolving a plugin id
  first: a docked view now also resolves to a plugin id, and routing window
  controls through that would let a docked view close the same plugin's separate
  window. This is asserted by a test rather than left to review.
- The z-order caveat ADR 0019 accepted for the browser now applies to every
  plugin view. Top-center toasts may overlap a view's corner; blocking overlays
  hide it entirely.
- Four live `WebContentsView`s is four extra renderer processes at worst. The
  bound is a deliberate trade against destroying and reloading a plugin page on
  every tab switch.

## Alternatives considered

### An `<iframe>` inside the host renderer

Rejected. It would z-order correctly and need no bounds syncing, but Electron
cannot give an iframe its own session partition, so the plugin page would share
the host renderer's process and storage. That is a strictly weaker boundary than
the one plugin windows already have, and the `net.domains` allowlist could not
be enforced on it. Isolation parity with the existing panel window is the point.

### Plugin-supplied React components rendered by the host

Rejected outright. It would put third-party code in the host renderer with
access to the app's own state and IPC bridge, discarding the entire plugin trust
boundary for a rendering convenience.

### Reuse `ui.panel` and let the host decide where to show it

Rejected. A panel is one surface per plugin with a window's dimensions and
title; a view is one of several, sized by the panel column, and needs its own
menu label, icon, and order. Overloading one field would make both worse and
leave no way to ship a plugin that offers a docked view *and* a detached window.

### Both, selected by a `isolation: "process" | "inline"` manifest field

Rejected for this change. It doubles the rendering and security paths to
maintain for a performance benefit that has not been measured, and the weaker
mode would become the default simply because it is easier to write against.
