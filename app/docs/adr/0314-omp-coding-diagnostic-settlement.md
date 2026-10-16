# ADR 0314: Settle OMP coding diagnostics within the owning tool

- Status: Accepted for local maintenance validation
- Date: 2026-10-16
- Scope: OMP write/edit diagnostic delivery; controlled runtime patch 6

## Context

The pinned PI Desktop reference has no native LSP integration. OMP owns its
language-server discovery, processes and tools. OMP enables write diagnostics
but disables existing-file edit diagnostics by default. Its asynchronous
diagnostic delivery may enqueue a custom message after a terminal `agent_end`
and start an idle model continuation. Desktop closes that turn and correctly
rejects subsequent unowned frames. A real TypeScript server reproduced the
result: the model received error 2322 after completion while Desktop displayed
no diagnostic.

Actual installed UI validation also found that the inherited Write presenter
returned the written-source block before rendering OMP's diagnostic metadata.
The shared coding-diagnostic presenter now also supplies that Write row's
findings; the existing edit/LSP renderers and mutation success status remain.

## Decision

The controlled runtime adds optional `lsp.diagnosticsDeferred`, defaulting to
`true` to preserve standalone behavior. When false, `DeferredDiagnostics.begin`
returns no deferred handle; native writethrough uses its existing bounded,
cancellable inline diagnostic pipeline. Mutation versions still advance and
previous pending fetches are cancelled. No new LSP client, process owner, tool,
IPC channel or renderer permission path is introduced.

Desktop's run-scoped overlay sets `lsp.diagnosticsOnEdit: true` and
`lsp.diagnosticsDeferred: false`. Native write diagnostics remain enabled by
default. The native `lsp.enabled` switch and project server configuration keep
their existing semantics. Formatting remains opt-in. Server availability and
supported file types remain prerequisites; registering a tool cannot install
language servers or guarantee that a model chooses semantic navigation.

## Consequences

Write/edit results carry findings to both the model's next decision and the
existing Desktop tool projection before turn completion. A slow server can
extend the tool by the native diagnostic budget; cancellation and timeout
results retain the existing behavior. No idle diagnostic continuation is
scheduled by these tools in Desktop mode. Plan/Goal's pre-execution tool
restrictions, immutable admissions and process cleanup remain authoritative.

Validation uses the real default hashline editor, a real TypeScript language
server, the production Desktop runner and gate, a verified native binary, an
isolated HOME and a local scripted model. Paid providers are not contacted.
