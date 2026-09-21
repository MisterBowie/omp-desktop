# ADR 0026: Move the Projects Index into Settings as an Archive

- Status: Superseded in part by ADR 0036 (destination count/order)
- Date: 2026-07-27
- Deciders: PI-Desktop core
- Related: D066, D090, D093, D133, ADR 0013, ADR 0016

## Context

The home sidebar currently exposes both an independent Projects destination and
retained project groups. Active work happens through the retained groups, while
the Projects destination primarily acts as a durable directory for discovering,
archiving, restoring, reopening, and closing historical project records.

Keeping both surfaces in primary navigation duplicates the project concept and
gives archival management the same prominence as task creation and Plugins. The
frozen four-destination Settings directory from ADR 0013 has no place for this
project-management surface, so moving it changes the settings information
architecture and requires a baseline revision.

## Decision

1. Remove the standalone Projects destination from the home sidebar, app page
   state, and global page-search results.
2. Add **Project archive** (`项目归档`) to Settings after Import and before Info.
   Settings now has five destinations: Basics, Model configuration, Import,
   Project archive, and Info.
3. Reuse the durable Projects index in the archive. It keeps search, add,
   activate, project-session expansion, pin, archive/restore, and close actions.
4. The Settings archive always includes archived project records. Archived
   project rows retain their muted presentation and can be restored from their
   existing action menu. Expanded project details do not apply the sidebar's
   archived-session visibility filter.
5. Activating a project or project session leaves Settings and returns to chat.
   Archiving or closing a project keeps the Project archive destination visible,
   including when a fallback workspace must be selected.
6. The home sidebar keeps retained project groups and the persistent new-project
   action. Project storage, renderer presentation metadata, and the one-visible-
   workspace activation model remain unchanged.
7. Settings and global settings search index Project archive and its archive,
   restore, project-title, and project-search terms.

## Consequences

- The home sidebar has one fewer primary destination and gives more visual
  priority to active project and session work.
- Historical and closed projects remain recoverable through Settings, including
  imported paths that are not retained as sidebar tabs.
- Settings grows from four to five destinations, superseding ADR 0013 only for
  the destination count and ordering.
- No IPC, host RPC, database, security, or project-activation contract changes.
- Existing persisted project/session archive metadata remains compatible.

## Alternatives

### Keep Projects in both the home sidebar and Settings

Rejected because duplicate navigation leaves ownership unclear and does not
reduce the home sidebar's primary menu.

### Show only archived rows

Rejected because closed but unarchived durable projects would lose their only
index-based recovery path. The archive is a complete historical directory, with
archived rows always included rather than an archived-only filter.

### Put project management inside Basics

Rejected because a full searchable project index is a destination-scale tool,
not an application-default row or compact settings card.

## References

- `docs/spec/00-baseline.md`
- `docs/spec/03-runtime/04-data-storage.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-038)
- `docs/spec/08-meta/decisions-log.md` (D133)
