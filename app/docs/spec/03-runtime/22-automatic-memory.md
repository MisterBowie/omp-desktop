# Automatic OMP memory

OMP owns the Mnemopi database and all memory reads/writes. Rust host-core owns
`memory.settings.get/set` in its existing `ompMemory/settings` KV record. No
storage-schema migration is needed. Both `autoSave` and `autoRead` default off;
manual project notes, transcripts and upstream CLI data stay independent.

Settings > Memory exposes the two switches, project/worktree selection,
paginated browsing of conversation excerpts and extracted facts, local text search, refresh, and scope-bound clear confirmation.
Preferences are global to local OMP chats. Stores are isolated by the exact
session execution directory, including worktrees, under
`<desktopData>/omp-memory/<sha256(normalizedAbsoluteExecutionDirectory)>/memory.db`.
No credentials or data live in a project working tree. Runtime cleanup preserves
the database. Disabling either switch preserves all stored records.

The supervisor projects the native backend, both flags, the persistent path,
`retainFromSessionStart`, disabled embeddings and disabled Auto-Learn through its
trusted config overlay. Memory completion uses the chat's configured model role;
it never silently selects or downloads a tiny/embedding model. Model calls made
by memory may cost additional tokens. The first implementation uses local text
retrieval. It does not add a remote memory service or cross-project sharing.

Before enabling, a credential-free management process verifies native memory
protocol v1 and Mnemopi initialization. An old runtime fails closed before the
preference is saved or a memory-enabled conversation can start. Native management
uses bounded `memory` RPC requests, never terminal scraping or renderer SQL.
The closed local-port model fixture allows management to boot without using a
real provider. Management processes use `llmMode=none`, no automatic retention
and no automatic recall; they are serialized, owned and reclaimed on shutdown.

Changing preferences and clearing reclaim idle conversation writers. A running
turn, child, background command or pending native delivery refuses the operation.
Prompt admission waits while maintenance is active; durable follow-ups are
awakened afterward. Clearing affects only the selected automatic store, and does
not resurrect old transcript turns, remove manual notes, or delete chats.
Out-of-order page results are ignored; clear confirmation is tied to its scope.
Memory text is rendered as text. Model memory tools honor the same fixed flags,
including child calls and `read memory://…`.

IPC channels: `ompMemorySettingsGet`, `ompMemorySettingsSet`, `ompMemoryQuery`,
`ompMemoryClear`. Worktree requests carry a session id; Main obtains its execution
root from the host. Native RPC v1 adds bounded status/list/search/clear operations
and an idle-safety capability. Source, UI, host persistence and real native
process tests must pass before the native candidate is promoted to a release pin.
