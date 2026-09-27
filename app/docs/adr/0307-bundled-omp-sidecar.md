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
`desktopVersion`, `platform`, `arch`, `binary.{filename,bytes,sha256}`, and
`build.{tool,bunVersion}`. Every value is read from the validated checkout, the
patch manifest, the host, or the produced file — none is entered by hand.

Both land in the application's Resources at the fixed location
`omp-runtime/{omp|omp.exe, provenance.json}`, declared once in
`apps/desktop/package.json` under `build.extraResources`; the built files are
gitignored. The same build copies the tool gate to
`omp-runtime/extensions/omp-desktop-gate.ts`, so a packaged build loads the gate
from Resources instead of a source tree.

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

## Consequences

- A shipped application cannot be pointed at another runtime by an environment
  variable, a stray `omp` on `PATH`, or a directory that happens to look right.
- The build gains one gate and one manifest; developers must pass `--source`
  (or `OMP_SIDECAR_SOURCE`) pointing at the controlled fork checkout. Packaging
  is not wired into `pack:dist`, which would require that checkout at package
  time; `pnpm build:sidecar` is the explicit entry point M6/T21 consumes.
- The artifact is large (~280 MB) and **not bit-reproducible**: two builds of the
  same commit produced different SHA-256s on this machine (recorded in
  `docs/validation/M5-bundled-sidecar.md`). The manifest therefore describes one
  build rather than claiming reproducible bytes, and must be regenerated with
  every build. `--check` remains deterministic: it validates inputs, not
  compiler output.
- Verification costs one hash of the binary at boot (~0.13 s for 280 MB); it
  only runs in packaged builds.
- The tool gate under `omp-runtime/extensions/` is copied by the same build but
  is still resolved by existence, unchanged from M5/T19-A. Its integrity rests
  on the application bundle's own signing, not on the provenance manifest; this
  is recorded as a limit, not a claim.
- The patch level's semantics are untouched (ADR 0305): R3 stays blocked, the
  Cursor product gate (ADR 0306) stands, and T20-B/C/D remain unimplemented.
