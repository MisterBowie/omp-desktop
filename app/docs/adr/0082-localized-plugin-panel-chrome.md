# ADR 0082: Localized and page-adaptive plugin panel chrome

## Status

Accepted

## Context

Plugin panels are hosted in their own Electron windows. Their titlebar was
given a single string from the manifest and the preload chrome defaulted to a
dark surface. That split the panel from the active PI-Desktop language and
made light plugin pages look like they had an unrelated black header.

## Decision

1. `ui.title` accepts either the existing string form or a localized object
   containing both `en` and `zh-CN` strings. The host resolves the value using
   the active PI-Desktop UI locale and falls back to the other supplied label,
   then the manifest name.
2. The host passes the active light/dark theme to the panel window. The
   preload samples the loaded document's computed body/document background and
   foreground colors for the titlebar, using the host theme when the page is
   transparent.
3. The titlebar remains in the closed preload-owned Shadow DOM. Plugin CSS can
   choose the page surface but cannot reach or restyle the host controls.
4. Existing string manifests and existing panel dimensions remain compatible.

## Consequences

- Plugin authors can ship one manifest with English and Simplified Chinese
  panel titles.
- Panel chrome remains visually coherent with custom plugin pages and the
  host's explicit theme preference.
- A panel whose colors change after first paint is not continuously inspected;
  plugins should set their page surface before `DOMContentLoaded`.
