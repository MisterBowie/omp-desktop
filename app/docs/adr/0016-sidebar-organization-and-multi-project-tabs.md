# ADR 0016: Organize the sidebar around retained multi-project tabs

- Status: Accepted
- Date: 2026-07-26

## Context

D088 replaced the mixed Recents list with one current-project group plus
path-less Temporary sessions. That made the workspace boundary visible, but it
also forced every project switch to replace the only project group and removed
basic organization controls. A user working across several repositories needs
to retain those projects in the sidebar, collapse inactive groups, and pin or
archive project and conversation rows without deleting durable data.

The host currently exposes one selected workspace through `workspace.set`
(`project.set` at the renderer bridge). Agent turns, permissions, and
transcripts are already keyed by session. Replacing the host workspace with a
multi-workspace singleton would enlarge the privileged-state surface and make
background tool execution depend on whichever tab the renderer selected most
recently.

## Decision

### Retained project tabs

- The renderer retains an ordered set of normalized project paths. Every
  retained path appears as an independently collapsible project group in the
  sidebar. A path-less Temporary group remains separate.
- Opening a project adds its path without closing other tabs. Selecting a tab
  activates that path through the existing `project.set` operation. The host
  still has exactly one active workspace for visible shell context.
- Closing a tab removes only its retained sidebar entry. It does not archive
  the project, delete sessions, or remove the host-owned `projects` row. When
  the active tab closes, the renderer activates a remaining tab or clears the
  selected workspace.

### Renderer-owned organization metadata

- Project metadata is keyed by normalized full path and contains
  `pinned`, `archived`, `collapsed`, and optional manual `order`.
- Conversation metadata is keyed by durable session id and contains
  `pinned`, `archived`, and optional manual `order`.
- User-facing sidebar ordering supports `recent`, `created`, `oldest`, and
  `name`. Pinned rows always precede unpinned rows; the selected sort is the
  secondary order. A persisted `manual` value and optional `order` fields are
  retained for compatibility, but this decision does not introduce drag or
  other manual-reorder interaction; rows without an explicit prior order use
  the stable recent-order fallback.
- Archive is non-destructive. Archived rows are omitted by default and
  recoverable through the explicit archived view. Delete remains a separate
  host operation.
- The presentation record is best-effort renderer local storage. It contains
  no transcript, tool argument, provider secret, or other privileged data.

### Session workspace isolation

- The project associated with a session is the authority for that session's
  tool root. `tools.execute` resolves the workspace from the persisted
  `session.projectPath`/`project_id`, not from the mutable active tab.
- Selecting another project or conversation never aborts a running turn.
  Per-session run state and grants remain independent, and background tool
  calls remain sandboxed to the originating session's project.
- Temporary sessions have no project root. Switching to a Temporary
  conversation clears the visible active workspace and does not inherit the
  previously selected project's tool access.

This supersedes D088's one-current-project and no-multi-project-tree
limitations, and restores scoped project/conversation row actions superseded
with D068. D088's exact-path grouping, scoped draft reuse, and Temporary
session boundary remain in force. No new renderer IPC channel is required.

## Consequences

- The sidebar can show several project groups in one independently scrollable
  region while the main pane still shows one destination/transcript.
- Project/session pin, archive, collapse, sort, and open paths
  survive app restart when renderer preferences are available. Clearing those
  preferences resets presentation only; host-owned projects and sessions stay
  intact.
- Activating a missing or inaccessible retained path reports the existing
  workspace error without silently deleting the tab or its sessions.
- Host tool execution must load the session before resolving its workspace.
  Legacy calls without a durable session may fall back to the selected host
  workspace during the compatibility window.
- The Projects index remains the durable project directory and the recovery
  path for closed or archived sidebar tabs.

## Alternatives

### Keep exactly one project group

Rejected because it discards the working set on every project switch and makes
parallel session work cumbersome.

### Store archive and pin flags in the host schema

Rejected for this iteration because the flags affect only local presentation.
Durable project/session identity and deletion continue to belong to the host.

### Add one host workspace per open tab

Rejected because only tool execution needs a workspace root, and the durable
session already identifies it. A second host workspace registry would
duplicate project/session state.

### Open each project in a separate native window

Rejected because it multiplies window/process state and does not solve
conversation organization in the primary workbench.

## References

- `docs/spec/03-runtime/03-tools-and-permissions.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/03-runtime/06-host-rpc-protocol.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/09-interaction-patterns.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/08-meta/decisions-log.md` (D093)
