# ADR 0240: Independent session discovery and navigable collaboration projections

- Status: Accepted
- Date: 2026-09-13
- Decision: D410
- Amends: ADR 0239

## Context

The host-owned collaboration ledger already permits a delivery between any two
existing Agent Session IDs, but Session Orchestrator's private recent-reference
store is not an authority for discovering those IDs. A session created through
the normal New Task flow can therefore be a valid communication target while
remaining invisible to `SessionTask.list`.

The sidebar collaboration projection also needs to explain durable creation
provenance without exposing complete transcripts, and the existing hover card
must let the user move between related sessions.

## Decision

The reviewed `desktop.control` catalog gains the additive read operation
`session/collaboration/list`. It returns at most 100 non-deleted Agent sessions
with their real Session IDs, titles, status, updated time, readable provider
and model labels, and bounded creation links. It does not return project paths,
credentials, transcripts, or message previews. `send` remains the existing
authenticated mutation path and accepts any existing Agent Session ID; it does
not create a worker relationship or replace the target session.

The host sidebar projection adds readable `providerName` and `modelName` fields
plus at most eight `createdSessions` references. `createdBySession` and
`createdSessions` describe only durable Session Orchestrator creation links;
ordinary independently created sessions do not receive a fabricated creator.
The renderer renders these references as native keyboard-focusable buttons. An
activation opens the referenced durable session through the existing store
selection path and focuses the Composer.

The hover card remains on-demand and bounded. Its interactive portal owns the
pointer/focus grace period so moving from the row to a related-session button
does not dismiss the card before the click. Renderer code remains read-only;
Rust remains authoritative for persistence and provenance, and Electron remains
the thin projection/orchestration layer.

## Compatibility and validation

The new operation and projection fields are additive. Existing `status`,
`send`, `spawn`, result, cancellation, private references, and session data are
unchanged. Session Orchestrator retains the legacy `workers` field in `list`
while adding the host-backed `sessions` directory, so callers that used the
old recent-reference compatibility behavior continue to work.

The list is restricted to Agent sessions because the host already rejects
delivery to Plan and Goal sessions. Host-core projection tests cover readable
provider/model names, creator/created-session links, and independent session
discovery. Plugin tests cover list discovery and bidirectional delivery. The
relevant live journeys are tracked by
`E2E-SESSION-independent-top-level-communication` and
`E2E-SESSION-hover-card-model-and-links`.

## Amendment (2026-09-13): reference availability

`SessionReference` gained an optional `available` field. The host reports
`available: false` for a `createdBySession`, `createdSessions`,
`currentTask.senderSession`, or `recentExchanges[].peer` reference whose session row is
deleted or absent, and falls back to the Session ID as the title. The renderer renders an
unavailable reference as text and offers no navigation, and activating a reference whose
session no longer exists reports a visible error instead of committing an empty
selection. The field is additive and optional, so existing callers and persisted data are
unaffected.
