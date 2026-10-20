# ADR: Preserve endpoint-published token limits

- Status: Accepted
- Date: 2026-10-20
- Amends: ADR 0134 (token limits only)

## Context

Gateway model IDs often do not match models.dev. Discovery discarded their
published context and output limits, so even an endpoint reporting an 872,000
token window appeared as the generic 128,000 token model. Saved inherited
bindings could then restore the same fallback during runtime resolution.

## Decision

Keep validated endpoint token limits through discovery, IPC decoration and model
selection. For context, accept `context_window`, `context_length`, or
`max_input_tokens`, in that order; Google uses `inputTokenLimit`. Output uses
`max_output_tokens` or Google's `outputTokenLimit`. Counts must be positive
integers fitting the existing host `u32` representation. Output never supplies
the context window.

The endpoint overrides the catalog's token-limit baseline. Explicit user limits
remain authoritative. Other metadata still comes from models.dev. Add the
optional `provider` value to `contextWindowSource` in the existing binding JSON:
it preserves the endpoint's window across generic/catalog resolution, while a
fresh endpoint response can update an inherited binding when Settings is saved.
Keep the historical rule for unmarked overrides and preserve `user`, including
an explicit 128,000. Discovery does not mutate configured bindings by itself.

Cache the normalized endpoint answer before user overrides or generic values
are applied. The existing host cache retains context; a selected binding retains
both context and output. No database column, schema version, or host protocol
version changes. Existing caches refresh through Fetch list. A downgraded host
may drop the new marker but retains its numeric limit under the legacy rule.

## Consequences

Custom IDs require no guessed model-family aliases or forced 1M window. Models
with no published limits retain existing conservative defaults. API keys stay
in the existing credential path. Tests use fixture responses and the supplied
endpoint is checked only through its model-list GET, without inference.
