# ADR 0241: Ship the file view as a vendored, updatable plugin

- Status: Accepted (supersedes ADR 0105; issue #304)
- Date: 2026-09-13
- Deciders: PI-Desktop core
- Related: [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [ADR 0105](0105-files-as-a-bundled-plugin.md) ·
  [ADR 0109](0109-open-files-with-the-os-associated-application.md) ·
  [ADR 0111](0111-reveal-files-in-file-manager.md) ·
  [ADR 0169](0169-classified-file-preview-and-live-workspace-events.md) ·
  [07-plugins/07-plugin-marketplace](../spec/07-plugins/07-plugin-marketplace.md)

## Context

The bundled `pi.files` view (ADR 0105) browsed and previewed the workspace and
nothing else: no editing, no image, CSV, JSON, or SQLite surface, and a line cap
on text preview. Anything more than looking at a file meant leaving the app.

`pi.file-manager` is a third-party plugin that covers exactly that surface on the
same public channel — `contributes.views`, a sandboxed page over
`pluginBridge`, `ui.view` plus `fs.read` with root `workspace` and scope `**`,
no host-only capability. It is also published through the official marketplace.

Shipping it raises two questions this ADR answers: how the editor's writes are
mediated, and how a copy inside the application stays consistent with the copy
in the marketplace.

## Decision

1. The bundled file view is `pi.file-manager`, vendored into
   `apps/desktop/resources/plugins/`. The vendored files are the upstream
   release's own artifacts, byte for byte, except for a `license` field added to
   the manifest; `UPSTREAM.md` records the repository, tag, commit, and
   checksums. `pi.files` is removed, and a build that stops shipping a bundled
   plugin leaves no orphan registry row (ADR 0104).
2. It declares only `ui.view` and `fs.read` (`root: workspace`, `scope: ["**"]`)
   — the same permissions the view it replaces declared. The page is sandboxed
   and reaches the host only through the public bridge.
3. Editing writes are the plugin's own: its host process keeps the path jail,
   atomic writes, `mtime`/size conflict detection, and the write audit. The host
   permission gateway does not mediate them. A manifest cannot express a
   whole-tree write, and this host does not sandbox a plugin process's `fs`
   access to begin with, so bundling the plugin grants no capability a
   third-party plugin does not already have. The boundary is stated in the
   manifest's `safetyNotes` and is part of why this record exists.
4. **Bundled means default and non-removable, not frozen.** A bundled plugin
   cannot be uninstalled, but it can be updated from the marketplace, and that
   update survives the next launch:
   - `sync_builtin` keeps an installed row whose source is not `builtin` for as
     long as this build does not ship a *strictly newer* version. An app update
     still reaches a user who never installed anything, and a stale install
     cannot pin the plugin.
   - `uninstall` refuses by id against the set of plugins this build ships,
     rebuilt from disk on every launch. An updated bundled plugin stays
     uninstallable, and a plugin this build stops shipping becomes removable
     again.
5. A catalog version is offered as an update only when it is strictly newer than
   what is installed. Equality is not an update, and an older catalog entry is
   not one either — it would be a downgrade wearing the update affordance.
6. The panel title is the manifest's localized title, as for any plugin. The
   renderer does not carry a label for it, and no view id is hardcoded.

## Consequences

- The work panel's file surface is a vendor copy, so the application's own
  release cycle no longer decides when the view improves; upstream releases do,
  and users can take them without waiting for an app update.
- Maintaining the copy is a deliberate act: `UPSTREAM.md` and
  `apps/desktop/test/bundled-plugins.test.mjs` pin the vendored release, so a
  silent edit or a half-done re-sync fails the build.
- "Cannot be uninstalled" is now separate from "came from `resources/plugins`".
  `PluginSummary.bundled` carries that distinction; it is recomputed on every
  launch and defaults to false in registries written before it existed.
- The marketplace keeps listing a bundled plugin and offers its updates. That
  entry is the supported path for a newer version, not a confusing duplicate.
- A plugin the user updated keeps a marketplace/`local` source while remaining
  bundled. Anything that reasons about `source == "builtin"` must not be used to
  answer "is this protected" — see the registry rules above.
- The bundled view's filesystem reach is the plugin's own; a defect in the
  plugin's path jail is not caught by the host gateway. This is the same trust
  position as any installed plugin, taken deliberately in exchange for a
  capable, updatable file view.

## Alternatives considered

### Reimplement the missing viewers and editing in `pi.files`

Rejected: it duplicates a maintained third-party plugin, and the line cap,
media viewers, structured viewers, and SQLite browsing are a large surface to
keep in the host. The public channel exists so first-party surfaces do not have
to live there.

### Bundle it read-only and leave editing to the marketplace copy

Rejected: the same plugin cannot offer two capability levels without forking it,
and a read-only default would leave the most common request — change this line —
unanswered. The write path is unchanged either way.

### Let the bundled copy always win, with no updates

Rejected: a user could then only get a newer upstream release by updating the
application, which defeats the point of vendoring a published plugin. The
strictly-newer rule keeps both directions honest.

### Hide the marketplace entry for a bundled id

Rejected: the entry is where a newer upstream release is published. Hiding it
would remove the update path this ADR establishes.
