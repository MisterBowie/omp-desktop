# ADR: OMP session worktrees retain project identity

- Status: Accepted
- Date: 2026-10-18
- Amends: ADR 0016 and ADR 0249 for explicitly isolated local OMP sessions

## Context

A session's project path currently serves both configuration scope and execution
root. Replacing it with a Git worktree path would lose the project's Skill,
plugin, MCP and memory activation scope. Rebinding an already running OMP process
would also conflict with its native session identity and working directory.

PI-Desktop v0.21.0-beta.3 implements host-owned session worktrees. Its hardened
Git runner, repository probe, merge preview, conflict handling, registry and
link-safe removal provide the reference for this slice. Copying its full task
and background-process subsystem would add a second scheduler to OMP.

## Decision

Keep the original `session.projectPath` as project identity. Add a host-owned
worktree registry in schema v22 with a backup-producing v21 migration.
`session.create` accepts `isolated: true` only for an explicit local OMP engine
and an absolute project path. Non-isolated creation and existing session engine
bindings retain their behavior. The host creates `omp-desktop/<session-prefix>`
from the current project branch's committed tip, under the application's own
data directory. Uncommitted and ignored content stays in the original checkout.

Only host-core runs Git or chooses paths. `session.executionRoot` resolves the
registered root, including the project's repository-relative subdirectory.
Creating, missing and replaced roots refuse execution. An interrupted creation
retains a missing isolation record so a restart cannot reinterpret the session
as a normal project session. Creation failures roll back the session; failed
cleanup retains registry ownership for retry.

The OMP bridge carries separate project and execution directories. Native
processes start in the execution directory; capability snapshots, command
expansion and host tool activation continue to use project identity. Native
JSONL remains the sole transcript writer and its existing adapter/runtime
reference stays unchanged. Host file tools, plan artifacts, file previews and
chat reference resolution use the execution root when a session is isolated.

Six additive renderer channels expose probe, preview, merge, sync, pending work
and reveal. They accept session/project identifiers, never a worktree path.
Reveal hands the host-owned path directly to the OS. Main serializes worktree
controls with session operations, rejects running/preparing/compacting sessions,
and reclaims an idle OMP runtime before merge or sync. Host-core serializes Git
per repository and reserves every session tool permit while mutating/removing a
worktree. New durable turns refuse while that reservation is held.

Merge requires an explicit UI confirmation with a preview token. It checks both
branches and the current content again before committing or merging. Dirty
project files refuse; conflicts remain in the session worktree for resolution.
Deletion warns that unmerged work is discarded and reclaims the session first.
Moving an isolated session to another project is refused.

This slice supplies session creation, restore, merge/sync, reveal and removal.
It does not expose automatic setup commands, `.worktreeinclude`, allocated port
environment variables or separate worktrees for native OMP subagents. Native
subagents continue to inherit the owning session's root. Background command
control remains a separate stage with its own process ownership requirements.

## Consequences

Project-scoped configuration and native execution stay under one authority each.
A missing worktree cannot silently send a prompt or a file read to the original
project. The worktree survives session archive and normal shutdown; deleting the
session discards its registered worktree and branch.

Schema v22 is newer than the released database schema. An older application
requires the pre-upgrade database backup; no downgrade or data migration of the
user's installed application is performed during development validation.

The existing Electron/Rust/native-OMP boundaries remain unchanged. Validation
uses temporary repositories and data directories, real host and OMP processes,
and a loopback fake provider. Installed UI and other native platforms require
separate acceptance before distribution.
