# ADR 0331: OMP as the only product execution engine

- Status: Accepted by the user on 2026-10-21.
- Supersedes: ADR 0300's dual-engine compatibility policy and ADR 0254's native Pi continuation surface.

## Context

Ordinary desktop creation omitted the engine and selected the retained Pi default,
so OMP automatic memory never ran. The user explicitly selected a fresh OMP product,
without migrating or continuing Pi sessions. Retaining a second executing engine
would leave the same category of silent routing error possible.

## Decision

All new project, temporary, isolated, scheduled and plugin-owned desktop sessions
use OMP. Host creation defaults to OMP and rejects an explicit Pi engine. The Pi
wire identifier remains recognizable as retired data, with every capability closed;
it cannot acquire execution by omission, a live status, a queue or an approval.

The composition root no longer constructs the Pi worker. Boot/restart cannot start
it, and desktop installers omit its resource bundle. OMP session supervisors retain
exclusive ownership of native execution, tools, cancellation and structured events.
Reusable model transport utilities and upstream licensing remain intact.

Do not discover, import, reopen or migrate historical Pi chats. Existing files and
rows are preserved, while desktop listing, reading and search expose OMP records.
Session import, including plugin import RPCs, is unavailable. Host boot does not
promote orphaned transcripts or in-flight Pi checkpoints into OMP history.
The old remote Pi-host bootstrap/automatic connection
and settings destination are unavailable; this change does not claim remote OMP
support. No old remote registry is opened or rewritten.

Fresh-schema engine defaults change to OMP; the row shape and protocol versions do
not change. Existing row engines and database defaults are not rewritten, and no
history or credential migration runs. Supported session creation explicitly persists
the normalized OMP engine. Installed user data is not touched during development.

## Alternatives

Keeping dual engines would preserve legacy continuation but contradict the selected
product scope. Rewriting old Pi engines to OMP would lose native context ownership
unless a real transcript migration were performed; the user explicitly excluded it.

## Consequences

The product has one execution owner. Existing OMP history, permissions, queued work,
project binding and cancellation contracts remain. Pi-only forks, native continuation,
remote hosts and transcript imports are no longer offered as product features.
Cross-session ledger deliveries with origin metadata are explicitly refused until
native persistence can retain that provenance; they never lose the metadata or
fall back to Pi. A source-level Pi identifier or package name does not advertise Pi execution.
This is a local source change until a separately validated installer is delivered.
