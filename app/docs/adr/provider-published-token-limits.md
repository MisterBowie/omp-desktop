# ADR: Preserve endpoint-published model limits and capabilities

- Status: Accepted
- Date: 2026-10-20
- Amends: ADR 0134 (published limits, thinking controls and input capabilities)

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

## Capability extension (2026-10-21)

The same discovery boundary also discarded `reasoning`, `reasoning_levels`,
`supported_reasoning_levels` and `modalities`. Keep their validated normalized
facts in optional `providerCapabilities` on `ModelInfo` and saved bindings.
Explicit false wins; omitted fields keep the catalog baseline. Recognized effort
names remain canonical, `none` maps to `off` with its wire spelling, and unknown
levels remain visible as unsupported metadata rather than a fabricated level.

`thinkingLevelsSource: provider | user` separates inherited enabled levels from
manual edits. Refresh inherited levels, including old unmarked empty defaults;
preserve marked user sets (including an empty set), defaults that remain legal,
legacy non-empty choices, attachment overrides, and delegation/search opt-ins.
Null attachment overrides follow endpoint metadata even before cache hydration.

Rust stores capability snapshots in existing `kv` namespace
`provider-model-capabilities`, keyed by provider ID and then model ID, within the
same transaction as the normalized model cache. Existing `max_output_tokens`
stores the output limit. Deleting a provider clears its cache atomically with
the row; user-owned model rows remain authoritative. This adds no SQL columns,
database schema version, runtime pin, or inference call.

The Node model configuration applies facts before user overrides. The OMP YAML
projection now carries reasoning, image input, and maximum output; explicitly
published OpenAI-compatible effort controls carry their ladder and mappings.
Other APIs keep OMP's native budget/adaptive/Google mode resolution. Native OMP
does not support `ultra`; it is reported, never silently mapped to `max`.

PDF and native web search require explicit publication before being reported as
detected. Published search support does not enable searches. AI delegation is a
local user opt-in and is never derived from provider metadata.

## Consequences

Custom IDs require no guessed model-family aliases or forced 1M window. Models
with no published limits retain existing conservative defaults. API keys stay
in the existing credential path. Tests use fixture responses and the supplied
endpoint is checked only through its model-list GET, without inference.
