# ADR 0072: Add a global plugin launcher

- Status: Accepted for implementation
- Date: 2026-08-11
- Deciders: PI-Desktop core
- Related: D211 · [Settings IA](../spec/04-ux/06-settings-ia.md) ·
  [Interaction patterns](../spec/04-ux/09-interaction-patterns.md) · E2E-120

## Context

Installed plugin panels are reachable from the Plugins destination, but opening
one interrupts the user's current work and requires pointer navigation. A
system-wide shortcut needs a dedicated native window: the normal renderer
cannot receive keys while PI-Desktop is unfocused, and the existing plugin panel
host should remain the only authority that opens plugin UI.

Chinese plugin names also need useful keyboard search without requiring an
author to add aliases to every manifest.

## Decision

1. Add the shared, customizable `openPluginLauncher` shortcut, defaulting to
   `Alt+Space`. Electron renders it as Option+Space on macOS and Alt+Space on
   Windows/Linux and registers it with `globalShortcut` after application boot.
   Windows reserves Alt+Space for the active window system menu, so host-core
   also installs a narrow low-level keyboard hook for that exact default
   binding. The hook consumes the chord and emits a host notification to
   Electron, allowing the launcher to work while another application is
   focused. The focused main window remains a last-resort fallback.
2. Electron main owns one centered, frameless 620×440 utility window on the
   display nearest the pointer. ADR 0080 supersedes its original first-use lazy
   creation with hidden post-boot warm-up. It is non-resizable, absent from the
   taskbar, always on top while visible, and hides on blur or Escape. macOS uses
   a panel window visible across workspaces; no platform receives native window
   controls.
3. The sandboxed launcher renderer uses the existing preload and the additive
   Electron-only toggle, dismiss, and shown channels. It lists plugins through
   the existing plugin API and opens a result through the existing sandboxed
   panel host; no plugin permission or host-core boundary changes.
4. Only enabled, ready plugins with a panel are candidates. Search normalizes
   name, id, and description and derives tone-free full pinyin and pinyin
   initials from the display name. Up/Down selects, Enter or click opens, Escape
   dismisses, and IME composition never dispatches. Successful opens are
   remembered in renderer-local device storage (D219): an empty query lists the
   plugins in most-recently-used order, while a typed query ranks relevance
   first and uses recency only as a tiebreaker.

## Consequences

- A plugin panel can be opened without navigating away from the current task.
- The shortcut remains visible and resettable in Settings → Shortcuts.
- `pinyin-pro` is bundled into renderer output rather than shipped as a runtime
  package tree.
- A custom shortcut continues to use Electron's global shortcut API. The
  host-core hook is enabled only for Windows' reserved default chord, and a
  hook installation failure is logged; the focused-window fallback remains
  usable in that case.
- The renderer IPC additions remain Electron-local and additive; the native
  fallback adds one host method/notification without changing protocol v9 or
  storage schema v11.

## Alternatives considered

### Reuse global search

Rejected. Global search is part of the main renderer and cannot appear while
the application is unfocused without first restoring the entire main window.

### Open plugins directly from a native menu

Rejected. A static menu cannot provide Chinese/pinyin fuzzy search and would
need to be rebuilt for every plugin lifecycle change.

### Put pinyin aliases in plugin manifests

Rejected. It makes search quality depend on every plugin author and duplicates
data that can be derived consistently at query time.
