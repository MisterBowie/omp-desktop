# ADR 0109: Open Files entries with the OS-associated application

- Status: Accepted
- Date: 2026-08-20
- Deciders: PI-Desktop maintainers
- Related: [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [ADR 0088](0088-declared-file-scope-for-plugins.md) ·
  [07-plugins/03-plugin-api](../spec/07-plugins/03-plugin-api.md) · E2E-153

## Context

The bundled `pi.files` view can inspect text in its isolated viewer, but image,
document, archive, and other files are better handled by the operating system's
associated application. The existing `shell.openExternal` API intentionally
accepts only web and mail URLs, so converting a workspace path into a `file:` URL
would either weaken that boundary or give the plugin an unscoped file opener.

## Decision

1. Add `pi.fs.openDefault(pathFromRoot)` and the matching panel bridge channel
   `fs.openDefault`.
2. The API is covered by the existing `fs.read` permission. The host resolves
   the root-relative path through the complete read gate: workspace/user-selected
   root, real-path containment, protected paths, deny-list, and declared scope
   or user consent. It accepts existing regular files only.
3. Electron Main calls `shell.openPath` after the gate, causing the operating
   system to choose the file association. The plugin never receives an absolute
   path and cannot choose an executable or command line.
4. The bundled Files view exposes the action only from its selected-file viewer,
   including for binary and image files. Success and failure are audited by the
   plugin id and root-relative path.
5. This is an additive plugin API change; the desktop IPC and host protocol
   versions do not change. The existing `shell.openExternal` URL restrictions
   remain unchanged.

## Consequences

- Files can hand off content that the in-app text viewer cannot render.
- The default application may copy, transform, or sync the file according to its
  own behavior; the user explicitly initiates the handoff from the viewer.
- Plugins with `fs.read` still cannot open credentials, repository internals,
  protected app data, arbitrary absolute paths, or directories through this API.
- A failed OS handoff is reported to the plugin as `OPEN_FAILED` and is visible
  through the Files view's error toast.

## Alternatives considered

### Reuse `shell.openExternal` with a `file:` URL

Rejected: that API is for external links and would blur URL egress with local
file access. It also makes the file scope difficult to enforce consistently.

### Add a private bundled-plugin IPC channel

Rejected: Files is intentionally a public plugin API consumer. A private bridge
would recreate the trust-boundary exception that ADR 0105 removed.

### Add a new permission separate from `fs.read`

Rejected for this action: the host does not expose an arbitrary opener. The path
must already be a readable file in the plugin's declared scope, and the UI action
does not let the plugin select an executable or URL. The operation remains
audited so later policy changes have an explicit boundary to revise.
