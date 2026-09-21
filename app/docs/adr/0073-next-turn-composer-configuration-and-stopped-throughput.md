# ADR 0073: Stage next-turn composer configuration and preserve stopped throughput

- Status: Accepted for implementation
- Date: 2026-08-11
- Deciders: PI-Desktop core
- Amends: D189
- Related: D212 · [Agent runtime](../spec/03-runtime/02-agent-runtime.md) ·
  [Component spec](../spec/04-ux/08-component-spec.md) · E2E-120

## Context

The composer previously made its draft, mode, thinking, and permission controls
read-only for an entire agent run. That prevented preparing the next prompt and
next-turn configuration while preserving the correct safety rule: host-core
must not mutate the configuration pinned by an in-flight turn.

A user-initiated Stop could also arrive before the provider's final usage
record. The partial assistant answer was retained, but its stream duration and
output count were absent from durable transcript metadata, so conversation
statistics could not show generation throughput.

## Decision

1. During an active turn, the composer draft and mode, thinking, and permission
   selectors remain editable. Send alone remains disabled and the Stop action
   remains available. A pending Plan/Goal approval continues to block the draft
   and configuration controls because it owns the session decision boundary.
2. The renderer stores the latest full session configuration per running
   session and projects it optimistically. On `agent_end`, `error`, or manual
   compaction completion it submits that configuration through the existing
   idle-only `session/configure` API. New selections replace older queued ones;
   they never modify the running runtime.
3. Runtime terminal messages preserve `responseDurationMs`. If an aborted
   response has no positive provider-reported output usage, runtime and renderer
   reconciliation estimate visible thinking plus answer text at four Unicode
   code points per token and attach optional `responseOutputTokens`.
4. Rust transcript conversion persists both optional fields in message metadata.
   Exact provider usage wins over the estimate; an estimate is labeled as such
   in conversation metadata. Older records without either field remain valid.

## Consequences

- Users can prepare the next request and adjust its operating profile without
  waiting for the current answer, but cannot send a concurrent prompt.
- Host idle-only admission, one-turn-per-session, Plan/Goal approval, and
  permission enforcement remain unchanged.
- Stopped partial answers show a stable approximate tokens-per-second value and
  retain it after reload; complete answers continue to use exact provider usage.
- `responseOutputTokens` is an additive shared field stored inside existing
  message metadata, so neither protocol v9 nor storage schema v11 changes.

## Alternatives considered

### Configure the host immediately while running

Rejected. It would either violate idle-only admission or risk changing the
permission/tool/model configuration already pinned for the active turn.

### Keep controls disabled but allow only draft typing

Rejected. Mode, thinking, and permission are part of preparing the next prompt;
making only text editable leaves the workflow unnecessarily serialized.

### Hide throughput when final usage is missing

Rejected. The visible partial output and measured stream interval provide a
useful estimate, and the UI can distinguish it from provider-reported usage.
