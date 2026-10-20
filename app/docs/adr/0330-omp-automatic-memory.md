# ADR 0330: Native Mnemopi with desktop-owned preferences

- Status: Accepted (local native .7 build validated; not published).

## Context

The user chose native Mnemopi with separate automatic save/recall switches,
project isolation, browsing/search and clear controls. This amends ADR 0304's
blanket `memory.backend=off` rule only for explicitly enabled desktop memory.

## Decision

Use the native backend as the sole database owner. Host-core persists opt-in
preferences in its KV extensibility table; Main projects those choices and a
stable execution-directory store into the trusted overlay. Manual project notes
remain a distinct, user-authored context surface. Embeddings, remote memory services,
cross-directory sharing and Auto-Learn are excluded from this first delivery.
Memory model selection follows the bound chat model rather than ambient roles.

A native patch adds structured management RPC, a startup capability and background
work safety, a retention baseline, and compaction recall gating. Management runs
in a separately supervised credential-free process. Main never queries SQLite.
Maintenance closes prompt admission and refuses active background work before
reclaiming idle writers. Disabling preserves data; clear requires explicit,
scope-bound confirmation and cannot replay old history.

## Consequences

The native patch is committed as `edec3898d44071206ec201beebea432a2786bd8c`
after explicit user authorization and promoted to the normal `.7` provenance
manifest. The previous `.6` identity and the hashed development snapshot remain
available as history. The standard sidecar build produces the same binary and
gate bytes as the tested candidate. This is a local implementation; the fork
commit has not been pushed and no installer has been published.

See [the runtime contract](../spec/03-runtime/22-automatic-memory.md).
