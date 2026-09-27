# ADR 0307: The bundled OMP sidecar is a verified build product

- Status: Accepted (M5/T20-R4B). Adds a packaged-runtime admission rule; it does
  **not** lift the R3 blocker, does not implement Plan/Goal runtime surfaces,
  and does not change the pinned patch level's semantics (ADR 0305).
- Date: 2026-09-27
- Evidence: `docs/validation/M5-bundled-sidecar.md`,
  `app/scripts/omp-sidecar.mjs`, `app/packages/omp-runtime/src/bundled.ts`,
  `app/patches/oh-my-pi/manifest.json`,
  `apps/desktop/test/omp-sidecar.test.mjs`,
  `packages/omp-runtime/src/bundled.test.ts`,
  `packages/omp-runtime/src/bundled-smoke.test.ts`.

## Context

A packaged desktop application runs one OMP runtime, and that executable decides
what the product can do. Three facts make "which executable" a decision worth an
ADR rather than a convention:

1. **The upstream product does not verify its bundled resources.** PI Desktop at
   `0111e306c120ad5820688d7608cb37bad8fbcc1f` resolves its agent sidecar and its
   Rust host by existence only, and its development override is not gated on
   `app.isPackaged`:

   * `apps/desktop/electron/main/agent-sidecar.ts:18-27` — candidates are
     `process.resourcesPath/agent-runtime/sidecar.js`, then two `__dirname`
     development paths, each accepted with `existsSync`, with no integrity or
     version check.
   * `apps/desktop/electron/main/host-process.ts:22-38` — `PI_DESKTOP_HOST_BIN`
     wins whenever it exists (no `isPackaged` gate), then
     `process.resourcesPath/bin/…`, then development `target/{debug,release}`.

   The audit of `nornzach/oh-my-pi-gui@313279965` found the same shape for the
   OMP sidecar: `OMP_BUNDLED_OMP` (read before any `isPackaged` check), an
   upward resource scan, and `OMP_SIDECAR=source` all apply in packaged builds
   (`docs/validation/M5-omp-18-3-fork-audit.md` §2.2). PI has no precedent here,
   so this is a new concept, argued rather than inherited.

2. **The runtime this product ships is not the upstream tag.** It is
   `omp/18.3.0` plus the patch level maintained in
   `app/patches/oh-my-pi/manifest.json` (`62bc57b+omp-desktop.2`), carried by a
   self-maintained fork commit. A packaged build therefore has to be able to say
   *which* runtime it shipped, and refuse a resource tree that says something
   else.

3. **The repository is not shipped.** The patch manifest, the fork checkout and
   the patch artifact exist at build time only. Whatever the packaged
   application checks must therefore be baked into the application itself.

## Decision

### 1. One build entry, one recorded source

`scripts/omp-sidecar.mjs` is the only way a bundled sidecar is produced. It
refuses to compile unless the source checkout is the controlled fork:

- `origin` normalizes to `manifest.fork.repository` (SSH, `ssh://`, and HTTPS
  spellings compare equal),
- `HEAD` is exactly `manifest.fork.commit`,
- the worktree is clean,
- `packages/utils/package.json` reports `manifest.base.version`,
- `git diff --name-only <base.sha> HEAD` is exactly the manifest's file list and
  `git apply --check --reverse` accepts the controlled patch — which together
  prove `HEAD == base + patch level` and nothing else.

The compile itself is OMP's own `packages/coding-agent/scripts/build-binary.ts`
(Bun single-file compile), so the artifact is the official one for that commit
rather than a desktop-side reimplementation.

### 2. A provenance manifest the packaged application can re-prove

The build writes `provenance.json` next to the executable:
`schema` (`omp-desktop.bundled-sidecar/1`), `fork.{repository,commit,tree}`,
`upstreamBase.{sha,version}`, `patchLevel`, `capabilities`, `ompVersion`,
`desktopVersion`, `platform`, `arch`, `binary.{filename,bytes,sha256}`,
`extensions[]` (`{path,bytes,sha256}`), and `build.{tool,bunVersion}`. Every
value is read from the validated checkout, the patch manifest, the host, or the
produced file — none is entered by hand.

**Verified at startup** (a mismatch refuses the runtime): the schema, the
platform and architecture, the OMP version, the patch level, the upstream base
SHA and version, the fork repository (normalized) and fork commit, the desktop
release the artifact was built for, the binary's file name, and the byte count
and SHA-256 of both the binary and every declared extension.

**Recorded, not verified**: `fork.tree`, `capabilities` and `build.*`. A
packaged application cannot re-derive them — it has no repository and no
compiler — so they are audit/provenance information and must never be presented
as checked. The trust anchors are the pins plus the digests.

Both land in the application's Resources at the fixed location
`omp-runtime/{omp|omp.exe, provenance.json, extensions/}`; the built files are
gitignored, and the `extraResources` entry filters the directory's own
`.gitignore` out of the packaged copy.

**The gate is shipped as a bundle.** The runtime loads it with
`--trusted-extension`, so it must be a module the runtime can import from where
it sits. A copy of the source is *not*: the source gate imports `../src/...`,
which does not exist beside the sidecar in Resources, and the runtime refuses to
start (`Trusted extension failed to load: Cannot find module
'../src/session/approval-protocol.ts'`, measured against the compiled
artifact). The build therefore bundles the gate into one self-contained file
(`extensions/omp-desktop-gate.js`), proves it retains no relative imports,
clears the build-owned `extensions/` directory first so a stale file from an
earlier build cannot be shipped, and records its digest — which the desktop then
verifies with the same rules as the binary.

### 3. A packaged build admits exactly one runtime, and verifies it

`resolveRuntimeLauncher` answers differently for the two build shapes:

- **Packaged** (`app.isPackaged`): the only candidate is
  `process.resourcesPath/omp-runtime/<platform name>`, and it is used only if
  `verifyBundledRuntime` accepts it. `OMP_DESKTOP_RUNTIME`, an upward scan from
  the app path, and `PATH` are not candidates at all.
- **Development**: an explicit `OMP_DESKTOP_RUNTIME`, else the launcher in the
  pinned reference checkout found by walking up from the app path. Never `PATH`.

`verifyBundledRuntime` refuses: a missing or symlinked directory, a directory
that resolves outside the resources root, a missing/symlinked/non-executable
binary, a missing or malformed manifest, any pin mismatch (schema, platform,
arch, OMP version, patch level, upstream base, fork repository, fork commit,
binary file name), and any byte-count or SHA-256 disagreement with the file on
disk. Every refusal is `OmpRuntimeError("bundled-runtime-invalid")`; a packaged
build with no usable sidecar reports an unavailable engine instead of running
something else.

### 4. Identity and protocol are asserted before a session exists

The existing start path already probes `--version` before spawning and
negotiates `negotiate_protocol` v2 after `ready`; a failure there leaves the
engine `failed` with a stable reason (`version-mismatch`,
`protocol-unsupported`) and no capabilities, so no usable session can be
created. This ADR relies on that path rather than adding a second protocol
handshake, and the reason mapping now distinguishes `protocol-unsupported`
instead of folding it into `start-failed`.

### 5. The desktop pins mirror the patch manifest

`@pi-desktop/shared` carries `OMP_RUNTIME_BASE_SHA`, `OMP_RUNTIME_PATCH_LEVEL`,
`OMP_RUNTIME_FORK_REPOSITORY` and `OMP_RUNTIME_FORK_COMMIT` because a packaged
build has no repository to read. They are not hand-maintained evidence:
`apps/desktop/test/omp-sidecar.test.mjs` asserts each equals the controlled
manifest, and `scripts/omp-sidecar.mjs --check` refuses a checkout that
disagrees with either.

### 6. Every packaging command runs the preflight

`pack`, `dist`, `dist:mac`, `dist:win` and `dist:linux` each run
`pnpm run verify:sidecar[:<platform>]` between `bundle:runtime` and
`electron-vite build`. This mirrors upstream PI Desktop, whose `pack`/`dist*`
commands build the sidecar bundle in-chain (`bundle:runtime`) before
`electron-builder`, rather than trusting whatever happens to be on disk; the OMP
runtime needs a stricter form of the same step because it is a native,
platform-specific artifact:

- **Host target**: the preflight builds the sidecar (`--build`), so a missing or
  stale artifact cannot be packaged.
- **Non-host target**: it refuses to compile (there is no cross-compiler here)
  and requires an artifact staged for exactly that platform and architecture
  that verifies against *the controlled manifest being released* — a foreign
  patch level, fork commit, base or desktop version is refused. The host binary
  is never reused for another platform, and a cross-target release without an
  explicit `--arch` is refused instead of defaulting to the host's.

`apps/desktop/test/omp-release-gate.test.mjs` asserts each release command still
runs the right preflight in the right position, and exercises the refusals with
fixture artifacts.

## Consequences

- A shipped application cannot be pointed at another runtime by an environment
  variable, a stray `omp` on `PATH`, or a directory that happens to look right.
- The build gains one gate and one manifest; developers must pass `--source`
  (or `OMP_SIDECAR_SOURCE`) pointing at the controlled fork checkout. Packaging
  runs the preflight in-chain, so a release host needs that checkout and a
  staged artifact for every non-host target it builds.
- **Reproducibility is not achieved.** Builds of the same commit produce
  different binary SHA-256s on this machine (four observed in this round,
  recorded in `docs/validation/M5-bundled-sidecar.md`), so the R4-3 acceptance
  clause "identical inputs produce an identical manifest" is **not satisfied**
  and is carried as an open, blocking item for M6/T21 rather than reported as
  green. `--check`/`--preflight` remain deterministic: they validate inputs and
  staged artifacts, not compiler output.
- Verification costs one hash of the binary at boot (~0.13 s for 280 MB) plus
  one hash of each extension; it only runs in packaged builds.
- The tool gate is bundled, digest-recorded and verified like the binary; its
  refusal path is the same `bundled-runtime-invalid`.
- The patch level's semantics are untouched (ADR 0305): R3 stays blocked, the
  Cursor product gate (ADR 0306) stands, and T20-B/C/D remain unimplemented.
