# ADR 0088: Plugin file access is declared per mode, and deletion is recoverable

- Status: Accepted (Implemented 2026-08-15)
- Date: 2026-08-15

## Context

ADR 0008 put plugin main code in its own `utilityProcess`, but noted that the
process is a full Node environment: permissions gate the `pi.*` surface, not
`require("node:fs")`. Capability sandboxing is still the open half (ADR 0008,
D009). Until it lands, the `pi.*` gate is what a well-behaved plugin is held to
and what a review can be based on, so its granularity is the whole design.

That granularity was three workspace-wide switches:

- `fs.read.workspace` → any file in the workspace, including `.env` and
  `.git/config`
- `fs.write.workspace` → any path in the workspace
- `fs.delete.workspace` → `fs.remove` with `recursive: false`, which bounds one
  call and not the blast radius: `fs.glob("**/*")` followed by a loop empties a
  workspace as thoroughly as `rm -rf` does

Two implementation faults made it worse than the design admitted. Containment
was a lexical prefix comparison, so a symlink inside the workspace pointing at
`~/.ssh` satisfied it; and the runtime fell back to
`grantedPermissions ?? manifest.permissions`, which auto-granted everything the
manifest asked for whenever a caller omitted the grants.

`07-plugins/13-plugin-permissions-matrix.md` had always specified "Confirm on
first use" / "Confirm each time or per session" for these permissions. None of
it was implemented. The narrowing below is that spec being delivered, not a new
direction.

Tightening cannot be the whole answer, because a plugin system that can only
read is not worth installing. The risks are not symmetric, and the response
should not be either:

- A **read** is dangerous when the bytes can leave. That half is closed
  separately by the egress allowlist (`manifest.net.domains`), which confines
  the panel session, `pi.net.fetch`, and remote MCP endpoints to declared
  hostnames. With egress closed, a broad read is a much smaller problem.
- A **write** is dangerous on its own, and the damage is bounded by where it can
  land.
- A **delete** is dangerous on its own and, unlike the other two, is
  unrecoverable — unless the deletion goes to the operating system's trash, in
  which case it is fully recoverable and no worse than a write.

## Decision

### 1. `manifest.fs` declares scope; permission names stay flat strings

`permissions` remains `readonly string[]` and gains `fs.read`, `fs.write`,
`fs.delete` — "may this plugin touch files at all". A separate `fs` block says
"which files":

```json
{
  "permissions": ["fs.read", "fs.write", "fs.delete"],
  "fs": {
    "read": { "root": "workspace", "scope": ["**/*"] },
    "write": { "root": "workspace", "scope": ["docs/**", "*.md"] },
    "delete": { "own": true, "scope": ["dist/**"] }
  }
}
```

A separate field rather than objects inside `permissions` because permissions
are handled as strings end to end — install review, chips, grant round-trips,
catalog validation — and the marketplace catalog format is versioned separately.

`fs.read` may declare the whole tree; `fs.write` and `fs.delete` may not, and a
whole-tree pattern (`**`, `**/*`, `*/**`, `./*`) is refused at validation time.
An absent or empty scope is not an error: it means the plugin has no standing
reach and every access falls to the user.

### 2. Four gates, in a fixed order

Every `pi.fs.*` call passes, in order:

1. `assertPermission` — is `fs.<mode>` declared **and** granted (intersection,
   so a revoked permission actually stops working)
2. Containment — `realpath` on both the root and the target; for a path being
   created, `realpath` of the nearest existing ancestor. A symlink out of the
   root fails here, and a path that simply does not exist is reported
   `NOT_FOUND` rather than as an escape attempt
3. Unconditional deny-list — credentials and history refused under every root,
   scope, and grant: `.env*`, `.npmrc`, `.netrc`, `.git-credentials`, `id_rsa*`,
   `*.pem`/`*.p12`/`*.pfx`/`*.keystore`, and anything inside `.git`, `.ssh`,
   `.aws`, `.gnupg`, `.kube`, `.docker`, plus the host's own data directory
   (provider keys, session store)
4. Declared scope, else user consent

`pi.fs.glob` answers to the same rules: results are filtered by the read scope,
denied paths and reserved trees are omitted (a name is a read too), and
`node_modules` / `.git` / `.venv` / `__pycache__` are not walked at all.

### 3. Deletion has two tiers, and always goes to the trash

- **`fs.delete` with `own: true`** — the host appends every successful
  `fs.writeText` to a write ledger in the plugin's own data directory (path plus
  mtime, host-owned, not reachable from the plugin API). A path in the ledger can
  be removed with no scope and no prompt: cleaning up your own output surprises
  nobody. If the file's mtime has moved past the recorded one, the user has
  touched it since and it is no longer the plugin's — the delete falls to
  consent.
- **`fs.delete` with `scope`** — deleting somebody else's file requires the
  globs up front, and they are shown to the user where the permissions are
  shown.

Both tiers additionally:

- go through `shell.trashItem`, never `rm`. This is the backstop that makes the
  whole delete path survivable: any single gate above can be wrong without the
  user losing data
- keep `recursive: false`; a non-empty directory is refused rather than emptied
- answer to a rolling brake of 50 deletes per 60s per plugin. Past it the user
  is asked once, with the reason stated as "this many, this fast" rather than
  being asked to adjudicate one file. This is the only thing that separates a
  cleanup routine from a wipe

### 4. Consent is a native dialog, and never more durable than the session

Out-of-scope access calls `dialog.showMessageBox`: **Deny** / **Allow once** /
**Allow this session**. A session grant covers the containing directory and dies
with the process; nothing is persisted. A rate-brake prompt is offered no
session option at all. A host with no consent service refuses — a host that
cannot ask must not assume yes.

### 5. `root: "userSelected"`

`pi.fs.requestDirectory()` opens the native directory picker and returns a
handle. Inside that directory the plugin needs no manifest scope — the user just
pointed at it, which *is* the grant — while containment and the deny-list still
apply. The handle is memory-only and dies with the process.

This is where the capability comes back. "Organize my whole photo folder",
"bulk import/export" plugins become possible with **zero standing power**,
modelled on the browser's File System Access API.

### 6. Migration is a breaking downgrade

| Legacy permission | What it is worth now |
|---|---|
| `fs.read.workspace` | `fs.read`, `scope: ["**/*"]` — unchanged, because egress is closed |
| `fs.write.workspace` | `fs.write` with an empty scope — every write asks the user |
| `fs.delete.workspace` | `fs.delete` with `own: true` — only its own output goes without asking |

Capability is reduced; no hole is left open. An explicit rule always beats the
legacy default, so an author upgrades by adding `fs`, never by renaming
anything. The Plugins page marks a downgraded plugin so the user knows why it
stopped working and what the author has to do.

## Consequences

- A plugin that writes or deletes outside its declared scope now prompts, and a
  prompt the user denies is audited as `PERMISSION_DENIED`. Authors who never
  declared scope see writes fail until they do.
- Installed plugins that predate `manifest.fs` lose write and delete reach on
  the next load. This is intentional and visible rather than silent.
- Reads stay generous, which keeps the interesting plugins possible. That is a
  bet on the egress allowlist: if egress were reopened, read scope would have to
  be revisited.
- Deletion is recoverable through the OS trash on every platform Electron
  supports it, and we store none of the user's data to achieve that — no
  quarantine copy, no undo journal.
- The rate brake is per plugin and rolling, so a legitimate large cleanup is
  interrupted once rather than refused.
- None of this binds a *malicious* plugin, which can still call
  `require("node:fs")` directly. It bounds what a plugin can do through the API
  it is supposed to use, and gives review something concrete to read. The
  malicious case remains ADR 0008 D009 — capability sandboxing inside the plugin
  process — and is the next item on this line of work.

## Alternatives considered

- **A host-owned quarantine directory with an undo UI** instead of the OS trash:
  rejected. It would mean copying and retaining the user's files inside app
  storage to provide a recovery path the operating system already provides.
- **Objects inside `permissions`** (`{ "name": "fs.write", "scope": [...] }`):
  rejected. Permissions are strings across the install review, the grant
  round-trip, the registry, and the marketplace catalog; the change would touch
  all of them to express something a sibling field expresses cleanly.
- **Prompt on every file access, no manifest scope**: rejected. Consent fatigue
  turns into blanket approval, and a plugin that legitimately writes 40 files
  becomes unusable.
- **Keeping `recursive: false` as the only delete bound**: rejected. It bounds a
  call, not a loop, which is what the rate brake exists to catch.
- **Denying `fs.write` outright and offering only the plugin's data directory**:
  rejected as too narrow — an export or formatter plugin has to be able to put a
  file where the user asked for it.
