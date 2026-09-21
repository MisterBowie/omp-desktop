# Documentation and Code Alignment Audit (2026-07-30)

## Scope and method

This audit covers every Markdown document under `docs/` at commit `5891920`
(`main` before the audit branch was created): 111 documents in total.

| Area | Documents | Review method |
|---|---:|---|
| Root docs and project tracking | 3 | Links, metadata, delivery claims |
| ADRs | 38 | Index coverage, supersession and implementation references |
| Spec root | 7 | Baseline and navigation consistency |
| Product | 4 | Scope and platform claims against package/release configuration |
| Architecture | 4 | Process ownership and package boundaries against Electron/Rust code |
| Runtime | 17 | Protocol, storage, runtime, security and provider contracts |
| UX | 11 | Current component/interaction references and implementation-status claims |
| Security | 2 | Renderer, plugin and update trust boundaries |
| Delivery | 7 | Build, test, release and workflow contracts |
| Plugins | 15 | Manifest, API, installation, isolation and marketplace contracts |
| Meta | 3 | Decisions, baseline references and open-question state |

The review combined a complete static pass (relative links, document indexes,
referenced source paths, version references, and implementation-status
markers) with source-level checks of the Electron main/preload, Rust host-core,
agent runtime, shared protocol, package manifests, release workflow, and tests.
It does not claim that static source-contract tests are equivalent to a rendered
desktop end-to-end test.

## Verified alignment

- All 111 Markdown documents have valid relative Markdown links. No broken
  internal target was found.
- The implemented core topology remains the frozen architecture: a sandboxed
  Electron renderer, Electron main/preload bridge, Rust host-core over NDJSON
  JSON-RPC, and the Node pi sidecar. See
  `docs/spec/02-architecture/01-architecture.md` and
  `apps/desktop/electron/main/{host-process,agent-sidecar}.ts`.
- SQLite ownership is Rust-only in the implementation: `Database::open_in_dir`
  creates `<data_dir>/pi.sqlite`, while transcripts remain JSONL under
  `<data_dir>/sessions/` (`crates/host-core/src/{db,transcripts}.rs`).
- The current project-instruction chain, thinking-level flow, context
  checkpoint compaction, provider catalog ownership, and session-scoped work
  panel all have matching runtime code, ADRs, and E2E-plan entries.
- The recent global-search, settings IA, OS-locale, and project-instruction
  changes are covered by current specs/ADRs rather than only by source code.

## Findings

### P0 - Marketplace plugins are not capability-sandboxed

The marketplace can download and enable plugins, while each plugin executes in
an Electron `utilityProcess`. That process directly imports plugin code with
Node's `createRequire`/dynamic `import`; therefore plugin code can use Node
built-ins independently of the brokered `pi.*` API. The broker permission
checks protect only calls made through `pi.*`, not direct `node:fs`,
`node:child_process`, or network access.

Evidence:

- `docs/spec/07-plugins/01-plugin-system.md:185-192` documents the separate
  process and explicitly acknowledges that raw Node built-ins remain reachable.
- `apps/desktop/electron/main/plugin-runtime.ts:159-178` starts the process via
  `utilityProcess.fork` with a normal Node environment.
- `apps/desktop/electron/main/plugin-host-process.mjs:17-20,174-196` imports
  arbitrary plugin entry modules through Node module loaders.
- `docs/spec/07-plugins/01-plugin-system.md:230-234` still describes the host
  API boundary as if it prevents arbitrary child-process and filesystem access.

Impact: a marketplace package is effectively user-privileged native code, not
a permission-scoped plugin. The current UI and permission matrix can create a
false security expectation.

Required resolution before expanding marketplace distribution:

1. Disable remote installation/automatic enablement, or present it explicitly
   as unrestricted code execution until real isolation exists.
2. Implement a capability sandbox with an allowlisted runtime and OS-level
   resource/process restrictions, or move untrusted plugin execution into a
   separately sandboxed process.
3. Add adversarial tests proving direct Node filesystem, child-process, and
   network access cannot bypass granted permissions.
4. Record the selected security boundary in a new ADR and then update the
   plugin, security, marketplace, and acceptance docs together.

### P1 - The manifest specification is substantially stronger than enforcement

The documented manifest contract requires `schemaVersion: 1`, known
permissions, safe relative paths, contribution dependencies, and existing
skill/panel paths. The active validators only require a small subset of those
fields and use unchecked `join` operations for manifest paths.

Evidence:

- Required rules: `docs/spec/07-plugins/02-plugin-manifest-schema.md:119,
  134-142`.
- SDK validation only checks object/id/name/version/main/schemaVersion:
  `packages/plugin-sdk/src/index.ts:141-165`.
- Host validation only checks non-empty strings plus existence after
  `path.join`: `crates/host-core/src/plugins.rs:330-357`.
- Runtime loading repeats the unchecked entry join:
  `apps/desktop/electron/main/plugin-runtime.ts:245-260` and
  `plugin-host-process.mjs:188-196`.

Required resolution: make the validator authoritative (schema version equality,
permission allowlist, semver/id syntax, no absolute or `..` paths, contribution
dependency checks, and canonical containment), then add negative tests for each
rejected field. Do not weaken the documented contract to match the incomplete
validator.

### P1 - The host-ownership decision and implementation have drifted

The frozen baseline describes Electron main as a thin orchestrator and Rust as
the owner of host/system capabilities. In practice Electron main owns a large
privileged surface: PTY lifecycle, browser views, updater, plugin runtime,
filesystem panels, importers, and sidecar supervision.

Evidence:

- Frozen roles: `docs/spec/00-baseline.md:50-53` and
  `docs/spec/02-architecture/01-architecture.md:31-37,61-73`.
- Electron main imports these services directly:
  `apps/desktop/electron/main/index.ts:51-70`.

This is a maintainability and security-boundary risk rather than a claim that
the current app is nonfunctional. Choose and document one coherent direction:
move terminal/browser/plugin host services behind Rust host-core contracts, or
explicitly revise the frozen boundary so Electron main is the privileged
desktop-service owner while Rust owns only the listed durable services. The
choice requires an ADR because it changes a frozen security/data boundary.

### P1 - Remote marketplace integrity is not provenance verification

Marketplace packages are fetched from a remote catalog and checked against a
SHA-256 value supplied by that same catalog. This detects transfer corruption
but cannot establish publisher provenance after a catalog-source compromise.
The current implementation intentionally has no mandatory signature check.

Evidence:

- Remote provider and `curl` fetch are documented in
  `docs/spec/07-plugins/07-plugin-marketplace.md:27-40`.
- The code fetches and installs marketplace packages in
  `crates/host-core/src/plugins.rs:641-723,898-997`.
- Signature verification remains planned in
  `docs/spec/07-plugins/08-plugin-signing-updates.md:142-156`.

Resolution: keep the marketplace explicitly experimental until signed catalog
and package provenance are enforced, or use a package source that supplies
independently pinned trust material. This issue compounds the P0 execution
boundary.

### P2 - Plugin API, lifecycle, storage, and IPC documents mix target and shipped contracts

Several plugin documents expose APIs or behaviors that do not exist, while
some current behavior is not represented accurately.

- `pi.events.on/off` are documented as MVP events, but are no-ops in
  `plugin-host-process.mjs:166-170`.
- The overview documents `pi.agent.invokeSkill` and
  `pi.agent.appendSystemHint`, which are absent from the SDK and host process;
  `packages/plugin-sdk/src/index.ts:95-118` is the implemented API surface.
- Manifest fields such as themes, entrypoints, `resizable`, rich author data,
  and per-tool timeout/permission metadata are described but ignored by the
  Rust manifest representation (`crates/host-core/src/plugins.rs:81-99`).
- Plugin settings are stored in per-plugin `settings.json` by Electron main
  (`plugin-runtime.ts:650-671`), not in the host `kv` namespace described as
  the recommended current mechanism in
  `docs/spec/07-plugins/11-plugin-storage-isolation.md:61-73`.
- The IPC list includes target endpoints such as reload, logs, and open data
  directory without a corresponding shared IPC declaration. The shipped API
  must be generated from or tested against `packages/shared/src/protocol.ts`.

Resolution: mark unimplemented fields/APIs as planned, generate public plugin
types and validation from one schema, and add a contract test that compares
manifest/API/IPC documentation examples with the shipped SDK and protocol.

### P2 - Product and release posture is stale in several places

- `docs/spec/01-product/01-product-scope.md:42-60,95-103` still frames macOS
  as the sole required platform and Windows/Linux as planned. The baseline and
  electron-builder configuration publish macOS arm64, Windows x64, and Linux
  x64 lanes.
- `docs/spec/02-architecture/02-tech-stack.md:22-26` says pnpm 10.x and allows
  SQLite through a Node adapter. Root `package.json` requires pnpm 11.18.0,
  and Rust `rusqlite` owns storage.
- `docs/spec/05-security/01-security.md:78-84` states that plugins are local
  only, but the marketplace performs remote package installation.

The unambiguous metadata and index corrections from this audit are applied in
the accompanying documentation commit. The platform and security wording must
continue to track the final trust-boundary decision above.

### P3 - Metadata, navigation, and tracking drift

- `docs/README.md`, `docs/spec/README.md`, and
  `docs/spec/08-meta/open-questions.md` referenced older baseline versions
  despite `00-baseline.md` being 0.4.12.
- `docs/adr/README.md` omitted accepted ADR 0036 even though the ADR file is
  present.
- `docs/project/BOARD.md` is an explicitly dated historical snapshot and does
  not reflect the 2026-07-30 delivery state. It should be either maintained as
  a live board or clearly archived in favor of a single current tracker.
- `docs/project/README.md` contained Simplified Chinese prose despite the
  repository's English-first documentation rule.

## Test and delivery-route assessment

The source-contract test suite is extensive, but the documented E2E plan is
largely a specification with unit/source tests as partial evidence. The plan
itself correctly marks many rendered journeys as Draft or manual. Before
declaring M5 hardening complete, prioritize real packaged-app coverage for:

1. renderer/preload permission boundaries;
2. marketplace installation and disabled-plugin recovery;
3. workspace escape/symlink behavior across all file entry points;
4. updates on each published platform; and
5. concurrent session/permission focus behavior.

No local E2E command was run for this audit because repository instructions
prohibit manually triggering local E2E jobs without an explicit request.

## Immediate documentation corrections included with this audit

- Updated stale baseline metadata to 0.4.12.
- Added ADR 0036 to the ADR index.
- Corrected the stated pnpm and SQLite ownership in the tech-stack document.
- Corrected the product platform table and remote-plugin security statement.
- Linked this report from project tracking and made that index English-first.

## Follow-up gate

Do not close P0/P1 findings by editing prose alone. The next implementation
request must start with the plugin execution/trust decision, update the
relevant ADR and specifications, implement the boundary, and add the targeted
negative and packaged-app tests.
