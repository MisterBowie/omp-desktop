# 06. Desktop Release Runbook

> Scope: D126/D285 tag artifacts for macOS arm64 and Intel x64, Windows x64,
> and Linux x64, including the Linux system-Electron ASAR asset;
> macOS signing/notarization remains the detailed qualification lane below.
> Cross-references: [milestones](01-mvp-milestones.md) · [process model](../03-runtime/07-process-model.md) · [security](../05-security/01-security.md)

## OMP Desktop distribution identity (M6)

### 0.1.1 session and worktree release

Version 0.1.1 ships native Todo projection, `/skill:` commands, sidebar reply
dates/activity/copy actions, text steering, durable follow-ups, cancellable
manual compaction and local session worktrees. It also includes the bounded
browser screenshots. Full native conversation forks, per-child stop,
background-command controls and worktree setup/include/port/child isolation
remain unavailable.

The host upgrades schema 21 to 22 with a pre-migration database backup. Existing
sessions and native references are preserved. Returning to 0.1.0 requires closing
the application and restoring that backup; an old binary cannot read schema 22.
The native runtime stays at 18.3.0 / `62bc57b+omp-desktop.6`.

### Independent OMP releases from 0.1.0

OMP Desktop's public versions and in-app changelog start at **0.1.0**. The
pre-reset PI/OMP test-build history remains in `PRE_RESET_CHANGELOG`, outside
the current product catalog. Existing storage and protocol/schema versions do
not change. Install 0.1.0 manually once over a 0.15.x test build; the updater
does not enable downgrades to cross the reset.

The current product's download page, updater and remote-host assets all use
`https://github.com/MisterBowie/omp-desktop`. Stable updates follow
`releases/latest`, ignore historical test prereleases and require the matching
`latest.yml`, `latest-linux.yml` or `latest-mac.yml` plus installer assets.

The active release workflow is the repository-root `.github/workflows/release.yml`;
the nested `app/.github/workflows/release.yml` is the retained PI reference.
The active workflow builds both Mac architectures, Windows x64 and Linux x64,
checks packaged runtime/strict Plan/Goal/installed workflows, and validates
installer SHA512/size and remote-host SHA256 before merging Mac feeds. Only
after every build succeeds is a complete draft published as a stable release.
Branch dispatch and immutable `release-check-X.Y.Z-<candidate>` tags build
artifacts without publishing. Use a validation tag before the first stable cut;
create the stable tag at the same accepted commit. A `vX.Y.Z` tag must match
all 16 version surfaces and the current product changelog.

To publish the exact accepted candidate bytes, push an immutable
`publish-vX.Y.Z-run-<run-id>` control tag. The promotion workflow requires the
completed successful candidate run, its exact source revision, all four native
acceptance jobs and eight unexpired artifacts. The shared publisher checks out
that candidate revision, verifies the manifests and creates `vX.Y.Z` at it;
the control tag's commit is not the product source. It preserves the native
evidence and run receipt with the release. When permitted, token-based tag creation uses `GITHUB_TOKEN`,
so GitHub does not start a recursive build. Direct stable-tag builds use the
same publisher. Existing stable tags pointing elsewhere are never moved.
An operational retry may append `-attempt-N` to a new control tag; it never
requires moving the original control or stable tag. If the tag API refuses creation, an
already-authorized authenticated Git push can create the tag at the accepted
source. The one-time `cancel-validated-stable-*` control first reruns the strict
candidate gate and then permits cancellation only of the exact same-source
`v0.1.0` rebuild selected by its run id; other sources, jobs and repositories
are refused. Publication still uses the original eight accepted artifacts.
The publication receipt records the controller commit/ref and staging-script
SHA256 separately from the accepted product source.

Artifact downloads may retain a common directory root. The publisher stages
their original bytes under unique basenames, records their source paths and
hashes, and gives the Debian installer the canonical
`OMP-Desktop-X.Y.Z-x64.deb` name so every installer is covered by the checksum
record. The real builder merges AppImage, Debian and RPM entries into one Linux
feed. Staging also rewrites exact Debian references in `files[].url` and legacy
`path`, retaining every declared SHA512/size and recording original and staged
feed digests. The strict validator then checks every referenced installer.
Collisions, symlinks, stale versions and unrelated input files fail
before publication.

The initial 0.1.0 source gates passed at `f8c0e58` in run `38845176146`.
The later full-source run at `ae173d3` / `38856995305` is the current pinned
receipt. For delivery-only corrections, source verification can reuse that
completed job only after comparing every tracked product input and fixed submodule at
the repository root. The exceptions are documentation and an explicit list of
publication scripts and native acceptance harnesses. Those harnesses are
rerun on the new native candidates; they are not product build inputs. Runtime,
version, lockfile, build-entry or
submodule changes require the full source suites again; missing receipts also
fall back to full checks. Delivery tests and all four native package/installed
acceptances always run at the new candidate. Source-check reuse never means
that a failed native build is accepted.

Unsigned or ad-hoc Mac installations use GitHub check-and-link delivery and
never auto-download or install. Developer ID-signed Mac installations use
download/progress/restart delivery; Windows NSIS and Linux AppImage retain
in-app updates. Portable Windows and deb/rpm remain check-and-link. Signing
is optional for OMP's stable release, and the actual installed signature decides
the mode. When configured, the OMP workflow uses its own Apple credentials and
passes `OMP_MACOS_TEAM_ID=APPLE_TEAM_ID` to the DMG notarization helper; it does
not claim or reuse the PI publisher's signing identity. The following historical
PI signing qualification sections do not make an unsigned OMP build signed.
After enabling signing, set the repository variable `MACOS_REQUIRE_SIGNING=true`
to stop a later release if the signing secret is missing.

Publishing the local maintained OMP fork revision is a release prerequisite:
CI must be able to fetch the exact commit in `patches/oh-my-pi/manifest.json`.
No feed URL or GitHub credential can be supplied through renderer IPC.

The OMP fork keeps the workspace name `@pi-desktop/desktop` for internal imports
and build filters. Installed metadata uses `build.extraMetadata.name =
"omp-desktop"`. The real electron-builder configuration loader merges that name
before deriving `omp-desktop-updater`; changing only `productName` would retain
PI-Desktop's `@pi-desktopdesktop-updater` cache. Installed bundles must retain
`OMP Desktop`, `net.misterbowie.omp-desktop`, their own data/profile/credential
names, and the `MisterBowie/omp-desktop` update source.

All shipped locales name the current product OMP Desktop. Original authors,
licenses, external import-source labels, internal protocol names and host
executable filenames retain their original identities. MCP registration/handshake
labels, callback copy and diagnostics use `APP_NAME`; tool and operation ids stay
compatible. The new mark is the
controlled vector `apps/desktop/build/omp-mark.svg`: a pixel-style π with a
stepped violet–blue–cyan crossbar, cyan/magenta legs and a checkerboard tail.
The application tile is black with transparent outer corners; the transparent
renderer marks retain the same colors in both themes. Run `make-brand.py`,
`make-icon.py`, and `make-dmg-background.py` in that order to derive the master,
theme marks, documentation logos, platform icons and two-icon installer artwork. The macOS template
uses the mark's alpha geometry, without a tile or a PI-specific luminance crop.

`Resources/licenses` preserves the pinned PI-Desktop, OMP/native and Bun notices
with source coordinates and byte digests. The release entry prepares frozen Node and target-host Rust dependency
notices after the sidecar preflight and before electron-builder; failure stops
packaging. `licenses/dependencies/inventory.json` records each published notice's
original byte offset, length and SHA256 inside the notice bundle. Build-only
dependencies are included and identified as such in the scope statement; their
presence does not imply that every listed package is distributed. Electron's
own license/Chromium notices remain in its framework distribution.

`build:host-release` first runs `cargo fetch --locked`, then the locked host
release build. Cargo's offline metadata also resolves development and other
target manifests that a native release build alone need not download. A cold
build cache must therefore be prepared from the full lockfile before notice
collection. The collector remains offline and never repairs or rewrites locks.

Package acceptance must inspect actual installed metadata, update configuration,
icons and notice resources, then exercise the real renderer/host/bundled-runtime
workflow in owned data directories. Configuration and artwork checks alone do
not close M6. Test prereleases remain unsigned and do not publish update feeds;
Developer ID/notarization is qualified only when those signing steps really run.

### Controlled M5/M6/M7 test-package lane

The repository-root `three-platform-test-packages.yml` accepts only reviewed
`m5-test-*`, `m6-test-*` and `m7-test-*` tag pushes. A branch push, arbitrary tag
or manual dispatch cannot publish. The tag's peeled commit must
equal the run revision. All three native build jobs must succeed before the
single prerelease job writes anything; M5's packaged runtime and Plan/Goal
acceptance remain mandatory for all three stages.

M6 additionally runs `scripts/e2e-installed-smoke.mjs` against the actual DMG,
NSIS installer or AppImage. The native process observer pins psutil 7.2.2;
Linux uses a real Xvfb display. The closed launch environment contains no global
Bun/OMP path or runtime override. The application chooses its own default data
root under the test HOME. The eight installed workflow steps, two verified
quits and final zero-process observation must pass. `stage-test-package.mjs`
requires `--installed-report`, binds it to the same source/platform/version and
installer bytes, and produces a bounded `*-validation.json.gz` public asset
containing the report, screenshots and raw native history with individual
digests. Assembly rechecks this raw proof, not only its summary.

Windows acceptance resolves existing paths through the native filesystem API,
so short 8.3 names, long names and junction aliases cannot create contradictory
ownership or project identities. A cheap native probe runs before compilation:
an actual copied Node process is started through a short alias, an exact birth
mismatch is refused, and a sibling-prefix foreign process stays alive while the
owned process is reclaimed through a pinned Win32 handle. Failed UI assertions
first attempt ordered application shutdown; emergency cleanup continues to
refuse executables outside the owned root and still requires exact birth/image
identity. Failure annotations retain bounded owned-process metadata, never argv
or environments.

No updater feeds/blockmaps are published; the existing preview and latest
release are untouched. Native chooser/quit confirmation dialogs, OS shortcut
registration, signing/notarization and paid-provider compatibility are outside
this automated proof. Full M7 maintenance/upgrade/rollback acceptance remains a
separate stage with its own release gates.

## M7 native maintenance release gates

M7 retains the M6 installed workflow and M5 strict packaged Plan/Goal gates.
Every native platform also runs daily maintenance and the fixed old/new/backup-
restore/old installer rehearsal. The baseline is the exact public M6 asset in
its controlled JSON record; verify name, bytes and digest before installation,
never resolve latest. Copy closed profile/data trees with file inventories.
The inspector invalidates the cached ASAR header before same-path replacement.
All three actual versions must quit normally with zero owned survivors.

Staging requires both `--maintenance-report` and `--upgrade-report`. Missing raw
maintenance proof refuses M7 publication. Public `*-maintenance.json.gz` assets
retain screenshots, native histories, HTTP failure/recovery, forty-turn counts,
overlapping concurrent tool timestamps, and backup/restoration inventories.
Assembly reopens these raw files and verifies their bindings and summaries.
This qualifies manual rollback with the same pinned OMP/schema, not automatic
update delivery or arbitrary schema downgrades. Existing native-dialog,
OS-registration and signing limits remain explicit.

Qualified test distribution: [M7 `0.15.3-m7.1`](https://github.com/MisterBowie/omp-desktop/releases/tag/m7-test-20261015-46e7bf7), source `46e7bf7`,
run `38717467884`. Every native lane passed 15 strict regressions, 8 installed,
6 daily and 7 upgrade steps, with zero owned survivors. Root re-read all 15
public files and six raw proofs and reran the same public Mac installer under
review harness `5c41843`; its revision is distinct from the immutable product.
Linux CI screenshots show missing Chinese glyphs in fixture names; the inherited
system font stack does not establish bundled CJK coverage.

## 1. Build lanes

| Lane | Command | Signing | Use |
|---|---|---|---|
| Dev | `pnpm dev` | none | daily development |
| Local package | `pnpm --filter @pi-desktop/desktop pack` | unsigned without a configured certificate | packaging smoke (`--dir` output) |
| Local DMG | `pnpm --filter @pi-desktop/desktop dist` | unsigned without a configured certificate | local install test |
| Release | `scripts/release-macos.sh` | Developer ID + mandatory notarization | distributable artifact |

The static electron-builder config does not embed a certificate identity, so
contributors without certificates can still package locally. The release lane
requires an injected Developer ID identity (local) or `CSC_LINK` certificate
(CI), and fails before publication if signing or notarization verification does
not pass.

On macOS, `pnpm dev` creates and reuses a fingerprinted branded Electron host
bundle under `.cache/electron-dev/`. Its bundle name, executable, identifier,
and ICNS resource use OMP Desktop identity with the `.dev` bundle-id suffix, so AppKit shows
OMP Desktop in the application menu and uses the canonical icon in the native
About panel. The runtime also applies `build/icon_1024.png` to the Dock. Stock
files under `node_modules` are never modified. Windows/Linux development keeps
the normal electron-vite executable. Windows Main nevertheless registers the
same `net.misterbowie.omp-desktop` AppUserModelID used by the NSIS package before
Electron readiness, preventing the stock host identity from owning native
notifications or taskbar groups. The Windows package additionally pins the
`OMP Desktop` executable and Start menu shortcut names. The launcher sets
`PI_DESKTOP_DEV=1` so runtime packaging checks keep update delivery disabled
and preserve developer workspace defaults despite the branded executable name.
The first `pnpm dev` on Electron 43+ downloads the Electron binary on demand
(the package no longer installs it during `pnpm install`).
Packaged lanes use `build/icon.icns` through electron-builder on macOS and
`build/icon.ico` for the Windows executable and native window icon. The
renderer imports the same PNG through `BrandLogo`. The PNG is canonical;
`scripts/make-icon.py` derives the multi-size Windows ICO, the 512px
Windows/Linux package PNG, the
transparent monochrome `build/tray-icon-mac.png` template, and the iconset/ICNS
when macOS `iconutil` is available, without overwriting the canonical source.

## 2. Prerequisites (release lane)

1. Apple Developer account with a **Developer ID Application** certificate in
   the login keychain. Official certificate:
   `Developer ID Application: XingYu Liu (DUV63RKYTW)` (Team ID `DUV63RKYTW`).
2. Environment variables for the local signed lane:
   - `MAC_SIGNING_IDENTITY` — bare common name `XingYu Liu (DUV63RKYTW)`;
     electron-builder rejects a name that keeps the
     `Developer ID Application:` prefix, so the script strips it
   - `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` — required for
     notarization (`APPLE_TEAM_ID` must be `DUV63RKYTW`)
3. Rust toolchain and pnpm workspace installed. The Rust toolchain must run on
   the native macOS runner: arm64 for Apple Silicon or x86_64 for Intel.

## 3. What the build ships

- Electron app with hardened runtime + entitlements
  (`build/entitlements.mac.plist`: V8 JIT, unsigned-executable-memory,
  library-validation disable for Electron helpers and plugin native addons,
  and microphone input for plugin capture after user grant — ADR 0257), plus
  `NSLocalNetworkUsageDescription` and `NSMicrophoneUsageDescription` in
  Info.plist (via `apps/desktop/package.json` → `mac.extendInfo`). The local
  network string is required so macOS 15+ prompts for Local Network access and
  grants it to both the Chromium main process and the `ELECTRON_RUN_AS_NODE`
  agent sidecar — without it, LAN provider requests from the sidecar fail with
  `EHOSTUNREACH` even though the main process's Test Provider fetch succeeds
  (issue #573).
- `Resources/bin/pi-desktop-host-core` — Rust host binary (release build).
- Windows NSIS builds include an x64 `pi-desktop-host-core.exe` statically
  linked to the MSVC CRT, so a clean Windows x64 or Windows 11 ARM64
  (x64-emulated) installation does not need a separate Visual C++
  Redistributable before the local service can start.
- `Resources/agent-runtime/` — bundled sidecar, executed with
  `ELECTRON_RUN_AS_NODE=1` (no separate Node shipped).
- `Resources/licenses/` — notices that must remain distributable when the
  corresponding dependency's build-only source tree is pruned.
- `Resources/app.asar` — Electron Main, preload, renderer output, and only the
  runtime-resolved production modules. Renderer libraries are already present
  in Vite output and are not copied again as raw package trees.
- Chromium locale packs for English, Simplified Chinese, Traditional Chinese,
  Turkish, German, Spanish, French, and Korean. Product catalogs remain bundled
  independently of Chromium locales.
- App icons `build/icon.icns` and `build/icon.ico` (derived from canonical
  `build/icon_1024.png` by `scripts/make-icon.py`).
- macOS menu bar template `build/tray-icon-mac.png`, derived from the dark PI
  mark with a transparent background; Windows/Linux use the product PNG tray
  resource.

## 4. Release steps

### 4.1 Mandatory release version-surface gate (D164 + D260)

**Every product release that bumps a stable app version and cuts a tag MUST
first update every version-bearing surface: the shipped-locale in-app product
changelog and the version numbers stated in project documentation.** Tagging a
stable version while any surface still describes an older version is a
**release process failure**: packaged builds cannot show "what's new" without a
network fetch, the READMEs advertise a stale release line, and GitHub
auto-generated release bodies are **not** a substitute (extends D120 /
ADR 0022).

Surfaces in scope:

| Surface | Requirement |
|---|---|
| `apps/desktop/resources/models.dev/api.json` | Refreshed from https://models.dev/api.json before tagging; the release workflow packages this snapshot unchanged |
| `packages/shared/src/changelog.ts` | Newest-first English, zh-CN, and zh-TW entries, matching highlight counts |
| `packages/shared/src/changelog-de.ts`, `changelog-es.ts`, `changelog-fr.ts`, `changelog-ko.ts`, `changelog-tr.ts` | Same versions and highlight counts as English |
| `packages/shared/src/changelog.test.ts` | Version added at the top of the newest-first list |
| `package.json`, `apps/*/package.json`, `packages/*/package.json`, `docs/package.json` | Same version (`docs` is a third workspace root, not under `apps`/`packages`) |
| `Cargo.toml` `[workspace.package]`, `Cargo.lock` `host-core` | Same version |
| `packages/shared/src/protocol.ts` `APP_VERSION` | Same version |
| `README.md`, `README.zh-CN.md` | Status section states the current `<major>.<minor>.x` release line; toolchain, command, and roadmap claims still true |

Blocking steps:

1. Refresh `apps/desktop/resources/models.dev/api.json` **before** tagging.
   `scripts/release.mjs` does this by default for every bump, including
   prereleases. A no-op refresh (already current) still counts: the snapshot
   in the tagged tree is what artifacts ship. Do not treat a minified
   one-line JSON diff as absent.
2. Edit `packages/shared/src/changelog.ts` **before**
   `node scripts/release.mjs <version>` / `git tag`:
   - Add a **newest-first** entry under `en` and every shipped product locale
     (`zh-CN` / `zh-TW` in this file; `de` / `es` / `fr` / `ko` / `tr` in
     `packages/shared/src/changelog-*.ts`).
   - Same `version` string (semver **without** a leading `v`, matching
     `apps/desktop` / `APP_VERSION` for a stable cut).
   - Optional ISO `date` (`YYYY-MM-DD`).
   - Matching highlight counts; English is the source of truth (ADR 0009).
   - Each bullet is one short user-facing idea (not raw PR titles).
3. Do **not** catalog the prerelease identifier (`x.y.z-rc.*`,
   `x.y.z-beta.*`) as its own in-app changelog version. When the prerelease
   is a preview of the next stable line, add that **stable** version's
   entries (`x.y.z`) so testers can read "what's new" without a network
   fetch. Omit the catalog only when product explicitly ships no notes for
   this cut.
4. Sync the newest-first version list in
   `packages/shared/src/changelog.test.ts` (add the new stable version at the
   top), then run `pnpm --filter @pi-desktop/shared test` and confirm catalog
   alignment (version sets + highlight counts) still passes.
5. Update `README.md` and `README.zh-CN.md` when the release line changes
   (`0.10.x` → `0.11.x`) and whenever the release ships user-visible behavior
   the Highlights, Download, Getting started, Status, or Development sections
   now describe incorrectly. Both locales stay structurally in sync; English is
   the source of truth and the zh-CN file links the `docs/zh-CN/` mirrors.
6. Run the preflight and fix every reported surface:
   `pnpm check:release-docs [version]` (`node scripts/check-release-docs.mjs`).
   For a prerelease, run it against the **stable** version being previewed
   (`pnpm check:release-docs x.y.z`) so changelog/README alignment is
   checked even though `scripts/release.mjs` skips that preflight for
   `x.y.z-beta.*` / `x.y.z-rc.*`. The preflight compiles the TypeScript
   changelog in a temporary directory, so it does not require a prior
   workspace build. `scripts/release.mjs` still refreshes models.dev for
   prereleases; `--skip-docs-check` exists only for a deliberate
   non-release bump.
7. Commit the documentation updates so the tagged commit contains notes and
   accurate version claims for that version (alone or adjacent to the bump).
8. GitHub Release bodies may still use `generate_release_notes: true` for the
   web page; they remain web-only and are **not** the in-app notes source.

Pre-tag checklist:

- [ ] `apps/desktop/resources/models.dev/api.json` is refreshed or confirmed
      current in the tagged tree
- [ ] `packages/shared/src/changelog.ts` has English / zh-CN / zh-TW entries
      for the stable version being shipped or previewed
- [ ] `packages/shared/src/changelog-de.ts` and the other locale catalogs
      match the English version set and highlight counts
- [ ] Highlight counts match across locales
- [ ] Shared changelog tests pass
- [ ] `README.md` and `README.zh-CN.md` state the current release line and
      contain no claims the release invalidates
- [ ] `node scripts/check-release-docs.mjs` passes on the release commit
      (use the stable version when tagging a prerelease preview)
- [ ] `release.mjs` / tag runs only after the documentation commit is on the
      release branch

### 4.2 Build / package

```bash
export MAC_SIGNING_IDENTITY="XingYu Liu (DUV63RKYTW)"
export APPLE_ID=...
export APPLE_APP_SPECIFIC_PASSWORD=...
export APPLE_TEAM_ID=...
scripts/release-macos.sh
```

Artifacts land in `apps/desktop/release/` (DMG + ZIP + blockmaps).

`scripts/release-macos.sh` defaults to the host architecture and accepts
`MAC_ARCH=arm64` or `MAC_ARCH=x64` only when that architecture matches the
host. This keeps the native Rust host sidecar and Electron package aligned.

The packaging phase goes through `scripts/release-package.mjs` — the same entry
every `pack`/`dist` command ends with — so the bundled OMP sidecar preflight
runs before electron-builder on this lane too: a missing or stale
`apps/desktop/resources/omp-runtime` fails the lane instead of being signed and
notarized. The lane enters the entry through `pnpm --filter @pi-desktop/desktop
exec node ../../scripts/release-package.mjs`, which is also what puts the
desktop package's binaries on PATH for the wrapper.

### 4.3 GitHub tag and manual workflow

The GitHub Release workflow starts all native platform runners without a
separate validation-job barrier. Each runner validates that the pushed tag
matches `apps/desktop/package.json` immediately after checkout, before package
inputs are prepared.

On every platform, the release preparation step starts the locked Rust host
build in parallel with pnpm installation and native dependency rebuilding. It
then builds only the workspace dependencies selected by
`@pi-desktop/desktop^...`, failing if that dependency selection is unexpectedly
empty. The platform `dist:*` command remains responsible for bundling the agent
runtime, verifying the host build, building the Desktop application once, and
invoking electron-builder. This avoids a redundant Desktop build without
changing the package scripts or release artifacts.

**Default macOS release policy:** GitHub tag releases Developer ID-sign,
notarize, staple, and Gatekeeper-verify macOS DMG/ZIP before upload (D450 /
ADR 0289). Missing signing or notarization secrets fail the job. A
`workflow_dispatch` run may set `sign_macos: false` only to produce unsigned
debug artifacts; that path must not be used for a GitHub Release tag. Local
`scripts/release-macos.sh` remains the explicit signed local lane; `pnpm dist:mac`
stays unsigned without a configured certificate (D078).

The macOS matrix uses `macos-15` for arm64 and `macos-15-intel` for Intel x64.
Each job verifies `uname -m`, passes the matching `--arm64` or `--x64` flag to
electron-builder, and builds `pi-desktop-host-core` on that same native
runner. Tag builds and `sign_macos: true` (the dispatch default) receive
`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID` only from GitHub Actions secrets, pin the certificate through
`CSC_NAME=XingYu Liu (DUV63RKYTW)` (bare common name — electron-builder rejects
the `Developer ID Application:` prefix), force code signing and
`notarytool` notarization of `PI-Desktop.app`. The DMG is then submitted to the
same service on its own (`scripts/notarize-and-staple-macos-release-dmg.sh`),
and only an `Accepted` status allows the ticket to be stapled. Verification
then checks the identity, code-signing integrity (including
`pi-desktop-host-core`), Gatekeeper `Notarized Developer ID`, and both stapled
tickets before any artifact upload. The per-architecture `latest-mac.yml` files
are renamed before upload; the publish job merges them into one feed after
downloading both artifacts.

The shared electron-builder configuration applies the architecture-labelled
pattern at the macOS platform level for ZIPs and overrides it at the DMG target
level. Both public architectures are therefore explicit: the arm64 lane
publishes `PI-Desktop-<version>-arm64.dmg` and
`PI-Desktop-<version>-arm64-mac.zip`, while the Intel x64 lane publishes
`PI-Desktop-<version>-x64.dmg` and `PI-Desktop-<version>-x64-mac.zip`. This
applies to both unsigned and signed macOS lanes, including local release builds,
and ensures each generated updater feed references its architecture-labelled
asset names and matching checksums. Before upload, each macOS runner requires
exactly one architecture-labelled DMG and ZIP (including blockmaps) and rejects
any unlabelled or wrong-architecture macOS artifact.

The DMG uses a branded 720×440 background with a two-icon drag-to-Applications
gesture. The app and Applications link are the only items in the window. The
opening-help note and the executable command helper are not included in the DMG.

The macOS ZIP includes both `PI-Desktop-macOS-opening-help.txt` and the
executable `PI-Desktop-macOS-open.command` at the package root. After moving
`PI-Desktop.app` to `/Applications` or `~/Applications`, ZIP users can
double-click the helper. It searches only those two fixed locations, removes
only the recursive `com.apple.quarantine` attribute when present, and opens
PI-Desktop. Before doing so it verifies `CFBundleIdentifier=net.aiuo.pi-desktop`.
It does not use `sudo` or accept an arbitrary application path. The manual
fallback for the standard system location is:

```sh
xattr -r -d com.apple.quarantine /Applications/PI-Desktop.app
```

This helper is only for a trusted unsigned artifact when macOS reports that the
app is damaged. Signed and notarized builds should open without it.

DMG, ZIP, NSIS, AppImage, deb, rpm, blockmap, and updater feed outputs are already
compressed or compression-insensitive. The workflow therefore uploads their
temporary Actions artifacts with compression level zero before the publish job
assembles the GitHub Release. The Linux runner also copies
`linux-unpacked/resources/app.asar` to the versioned
`PI-Desktop-<version>-linux-x64.asar` asset before upload. This preserves the
exact archive used by the Linux installers for downstream repackaging with a
system Electron.

### 4.4 Documentation site deployment

The `pi-desktop-docs` Vercel project is published only from a published GitHub
Release ref.
`docs/vercel.json` disables Vercel Git auto-deployments, so pushes to `main`,
release branches, and pull requests do not create documentation deployments or
Vercel bot comments. The `docs-deploy` job in `.github/workflows/release.yml`
runs after the release workflow's `publish` job succeeds, checks out the exact
release tag, and deploys the production site with the Vercel CLI. Keeping this
job in the same workflow avoids relying on a second workflow being triggered by
`GITHUB_TOKEN`.

The workflow requires the repository secrets `VERCEL_ORG_ID`,
`VERCEL_PROJECT_ID`, and `VERCEL_TOKEN`.

### 4.5 CNB mirror trigger

After `softprops/action-gh-release` publishes or updates a GitHub Release,
`.github/workflows/mirror-to-cnb.yml` starts the CNB pipeline at
`aixk/Pi-Desktop`. GitHub Release remains the canonical artifact source; CNB
is a copy of the same tag for users who pull from
https://cnb.cool/aixk/Pi-Desktop.

The job:

- runs only on `vastsa/PI-Desktop`
- fires on `release` `published` / `edited`, and on `workflow_dispatch` with
  an explicit tag such as `v0.14.6`
- sends event `api_trigger_mirror` and `MIRROR_TAGS` set to that tag
- uses repository secret `CNB_MIRROR_TOKEN` (already configured) and fails
  closed if the secret is empty
- builds the JSON body with `jq` so a missing tag cannot produce an empty
  `MIRROR_TAGS` value on a manual run

Re-running the workflow for the same tag is safe if the CNB pipeline is
idempotent. It does not rebuild desktop artifacts and does not change
electron-updater feeds.

### 4.6 GitHub Actions secrets for macOS signing

Create these under GitHub → repository `vastsa/PI-Desktop` → Settings →
Secrets and variables → Actions. Never commit the p12, password, Apple ID, or
app-specific password. Never `echo` these values in CI.

| Secret | Value |
|---|---|
| `CSC_LINK` | Base64 of the exported Developer ID Application `.p12` (Certificate + Private Key). electron-builder also accepts a file path, but CI uses the secret body. |
| `CSC_KEY_PASSWORD` | Password used when exporting that `.p12` |
| `APPLE_ID` | Apple ID email that belongs to team `DUV63RKYTW` |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from https://appleid.apple.com → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | `DUV63RKYTW` |

Encode the p12 locally (do not paste the output into chat or the repo):

```bash
base64 -i developer-id-application.p12 | pbcopy
```

On Linux use `base64 -w0 developer-id-application.p12`. Files that must never
enter git: `*.p12`, `*.cer`, `*.p8`, `*.mobileprovision`.

### 4.7 macOS signing observability and timeouts

`electron-builder` prints one line before signing — `signing
file=release/mac-arm64/PI-Desktop.app platform=darwin type=distribution
identityName=...` — and then nothing until the phase is over. Three mechanisms
hide in that gap, and the macOS lanes now expose all three:

| Point in the phase | What happens | How it is visible |
|---|---|---|
| Walk | `@electron/osx-sign` walks `PI-Desktop.app/Contents` and collects every Mach-O file plus nested `.app` and `.framework` bundles | `DEBUG=electron-osx-sign*` prints `Walking... <dir>`; `scripts/macos-bundle-inventory.mjs` prints the same bundle's counts right after packaging |
| Per-file signing | `codesign --force --sign <identity> --timestamp --entitlements ... <file>` runs serially, deepest file first, the app bundle last | `DEBUG=electron-osx-sign*` prints `Signing... <file>` and `Executing... <file> codesign ...`; the codesign shim times every invocation. If a keychain ever refuses to hand the key to a wrapped `codesign`, `PI_SIGNING_NO_CODESIGN_SHIM=1` runs the phase without the shim |
| Silent retry | A failing pass is retried up to three more times with a 5s/10s/15s backoff and no log line | The watchdog's `codesign-calls` and `failures` lines expose repeated passes |
| App notarization | `@electron/notarize` zips the app, uploads it, and waits for Apple's queue (`mac.notarize=true`) | `DEBUG=electron-notarize*` prints `zipping application to`, `attempting to upload file to Apple`, `notarization success`, then electron-builder prints `notarization successful` |
| DMG notarization | The DMG carries its own signature, so the next step submits it again with `xcrun notarytool submit --wait` | The same watchdog keeps that wait observable and bounded |

`scripts/macos-signing-watchdog.mjs` wraps both long phases. It forwards every
child line with a `[sign] ` prefix and keeps the child's exit code, so the
failure semantics of the lane do not change. stdout and stderr are forwarded as
two independent streams, so their relative order can differ from a direct run,
and the child receives no stdin. It prints a heartbeat while the
child is silent (elapsed time, phase, last file, active codesign target), dumps
diagnostics when the phase produces no output and no codesign activity for
`PI_SIGNING_STALL_SECONDS` (the last file, the `ps` state of the signing
processes, the codesign log tail), and reports per-file codesign timings — call
count, total, p50, p95, maximum, and the slowest files — in a `[sign] summary`
block. The knobs:

| Setting | Default | Effect |
|---|---|---|
| `PI_SIGNING_TIMEOUT_SECONDS` | 2400 (CI: 1800 packaging, 1200 DMG) | Hard limit for the wrapped phase: diagnostics are dumped, the process group is killed, and the step exits 124 instead of hanging |
| `PI_SIGNING_STALL_SECONDS` | 300 | Silence with no codesign activity for this long triggers one diagnostics dump; the phase keeps running, because Apple's notarization queue is a legitimate wait |
| `PI_SIGNING_HEARTBEAT_SECONDS` | 60 | Heartbeat interval while the child produces no output |
| `DEBUG` | `electron-osx-sign*,electron-notarize*` | Namespaces that expose walking, per-file signing, and notarization progress |

`DEBUG` lists only the two namespaces that sanitize their own command lines,
because `electron-builder`'s namespace is not safe here: builder-util prints
every spawned command through a stem list that does not cover
`security set-key-partition-list -k <p12 password>`. On top of that the watchdog
redacts the values of `CSC_KEY_PASSWORD` and `APPLE_APP_SPECIFIC_PASSWORD` at any
length, the values of `CSC_LINK` and `APPLE_ID`, and any `--password` or `-k`
argument, from everything it emits — including the diagnostics, whose process
view prints `comm` only and never `argv`, and the summary, which carries counts
and redacted target paths. GitHub additionally masks every value that comes from
a secret.

Measured on the maintainer machine, one macOS arm64 bundle needs 93 `codesign`
invocations (91 signing, 1 verification, 1 entitlement display) and about 49s of
`codesign` wall time; only 16 of those files are Mach-O code and 5 are nested
bundles. `@electron/osx-sign` also signs binary resources — 33 `.pak` files plus
`.nib`, `.dat`, `.bin`, `.png`, `.icns`, and `app.asar` — because its walk
selects every file that looks binary, not only Mach-O. Excluding exactly those
data files with `mac.signIgnore` would remove roughly three quarters of the
calls, but it changes what the release artifacts carry and needs a notarized
release to validate, so it is deliberately not enabled.

`scripts/macos-signing-diagnostics.sh` records the runner baseline before the
certificate is imported: system version, `codesign --version`, keychain
identities/list/default, `xcrun --find notarytool`, and the reachability and
latency of `http://timestamp.apple.com/ts01`. The Developer ID identity is
expected to be absent at that point, because electron-builder imports it from
`CSC_LINK` while packaging; only `--require-identity` makes a missing identity
fatal.

Signer status: `@electron/osx-sign@1.3.3` is pinned exactly by
`app-builder-lib@26.15.3` and no override applies to it. Its
`signApplication()` awaits one `codesign` per file; it has no batch or parallel
path and no option or environment variable that enables one. A faster signer
therefore needs the `mac.sign` replacement hook, which is a rewrite rather than
a configuration switch, so the lane keeps the pinned signer and the diagnostics
above.

## 5. Verification gates

Unsigned debug artifacts (`workflow_dispatch` with `sign_macos: false`) are
not Gatekeeper-qualified. Tag releases must pass the signature, notarization,
and staple checks below or the workflow fails.

Two separate notarization submissions exist, because Apple notarizes one
artifact per submission and electron-builder only covers the app:

| Artifact | Submitted by | Ticket |
|---|---|---|
| `PI-Desktop.app` (inside the ZIP) | electron-builder `-c.mac.notarize=true` | stapled by electron-builder |
| `PI-Desktop-<version>-<arch>.dmg` | `scripts/notarize-and-staple-macos-release-dmg.sh` (`notarytool submit --wait`) | stapled by the same script after `status: Accepted` |

A DMG that was never submitted has no ticket, so stapling it fails with
`Could not find base64 encoded ticket ... Error 65`. Stapler retries are only
allowed after Apple returns `Accepted`.

Run after every signed release build:

```bash
for APP in apps/desktop/release/mac-*/PI-Desktop.app; do
  codesign -dv --verbose=4 "$APP"          # identity + hardened runtime flags
  codesign --verify --deep --strict --verbose=2 "$APP"
  spctl --assess --type execute --verbose=4 "$APP"
  xcrun stapler validate "$APP"
done
xcrun stapler validate apps/desktop/release/*.dmg
```

To read the Apple notarization log for a submission (the Release workflow does
this automatically when a submission is not accepted):

```bash
xcrun notarytool log <submission-id> \
  --apple-id "$APPLE_ID" \
  --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID"
```

### 5.1 Package footprint gate

Inspect every native-runner package before publication and record all
compressed artifact formats, unpacked application, ASAR, Electron
framework/runtime, locale, and unpacked-native sizes. Compare them with the
previous stable release; an unexplained increase above 15% blocks publication
until reviewed.

The package inventory must confirm:

- exactly one `Resources/agent-runtime/sidecar.js` and one target-native Rust
  host binary
- no raw renderer packages such as Mermaid, Shiki, React, KaTeX, or Lucide
  under packaged `node_modules`
- no dependency `*.map`, test, example, declaration, or second agent-runtime
  tree in ASAR
- required third-party license and notice files remain in ASAR or
  `Resources/licenses` when their non-runtime package trees are pruned
- only the configured English, Simplified Chinese, Traditional Chinese,
  Turkish, German, Spanish, French, and Korean Chromium locale packs

The first audited optimized package establishes the platform baseline. Keep
per-platform measurements rather than applying one budget to different
Electron target layouts.

The first macOS arm64 baseline was captured on 2026-07-30 from an unsigned
`electron-builder --dir` package. Sizes below sum regular-file bytes so they
remain comparable across filesystems; the compressed artifact is not
applicable to this directory-only validation build.

| Inventory | Bytes | MiB |
|---|---:|---:|
| Unpacked application | 251,724,810 | 240.1 |
| `Contents/Frameworks` | 218,567,792 | 208.4 |
| `Contents/Resources` | 33,102,807 | 31.6 |
| `Resources/app.asar` | 20,944,962 | 20.0 |
| `Resources/app.asar.unpacked` native payload | 137,336 | 0.1 |
| Historical English and Simplified Chinese Chromium locale packs baseline | 1,033,673 | 1.0 |
| Agent sidecar | 3,258,983 | 3.1 |
| Rust host | 7,160,000 | 6.8 |

The pre-optimization unpacked regular-file total was 559,355,716 bytes
(533.4 MiB). The audited package is 307,630,906 bytes smaller, a 55.0%
reduction. Its curated renderer output is 14.1 MiB, down from 20.5 MiB.

#### Renderer output budget

The renderer bundle carries three standing controls. Regressing any of them
shows up as renderer growth in the table above and must be explained before
publication:

- **Minification is explicit.** `electron-vite` hard-defaults the renderer
  preset to `minify: false`, unlike plain Vite, so
  `apps/desktop/electron.vite.config.ts` sets `minify: "esbuild"`. Removing it
  silently doubles emitted JS.
- **Legacy font formats are stripped.** The `pi-drop-legacy-font-fallbacks`
  plugin removes `woff` and `truetype` `src` entries before Vite registers
  them as assets. The bundled Chromium supports `woff2` universally, so those
  faces would be emitted and never served.
- **Brand marks are renderer-sized.** `src/assets/brand/logo-{light,dark}.png`
  are the renderer assets. `build/icon_1024.png` and `build/logo_dark.png` are
  electron-builder installer icons and must not be imported by the renderer.

Renderer output measured on 2026-08-26 after applying these three controls,
against the same tree at `v0.10.8`:

| Renderer group | Before | After |
|---|---:|---:|
| JavaScript (120 chunks) | 12.53 MiB | 7.72 MiB |
| `woff2` | 15.71 MiB | 15.71 MiB |
| `woff` + `ttf` legacy fallbacks (40 files) | 0.78 MiB | 0 |
| PNG brand assets | 1.23 MiB | 0.27 MiB |
| CSS | 0.42 MiB | 0.35 MiB |
| **Total `out/renderer`** | **31 MiB** | **24 MiB** |

The renderer no longer emits any application font face. D598 / ADR 0298 removed
the four bundled families (Geist, Inter, Noto Sans SC, LXGW WenKai), so the only
`woff2` files left in `out/renderer` are KaTeX's math glyphs. Measured on this
machine from a clean `pnpm install --frozen-lockfile`, with and without the
removal:

| Renderer group | Bundled fonts | After D598 |
|---|---:|---:|
| JavaScript (121 chunks) | 9.04 MiB | 9.04 MiB |
| `woff2` (23 → 19 files) | 15.71 MiB | 0.24 MiB |
| CSS (1 file) | 0.48 MiB | 0.48 MiB |
| PNG brand assets (4 files) | 0.08 MiB | 0.08 MiB |
| GIF (2 files) | 0.05 MiB | 0.05 MiB |
| **Total `out/renderer`** (152 → 148 files) | **25.36 MiB** | **9.89 MiB** |

The entire difference is the four deleted faces, at the sizes the build reports:
`lxgw-wenkai.woff2` 8,016.75 kB, `noto-sans-sc.woff2` 7,782.07 kB,
`inter.woff2` 352.24 kB, and `geist.woff2` 69.65 kB — 16,220.71 kB, which is the
whole 15.47 MiB drop in the total. Chinese text now renders from the system tier
(`PingFang SC`, `Hiragino Sans GB`, `Microsoft YaHei`), so no glyph coverage is
lost to subsetting: no face ships.
The other two controls are unchanged: minification stays explicit, and the
legacy `woff`/`truetype` strip stays because KaTeX still declares those sources.

The three-controls table above is the `v0.10.8` record and predates the removal,
so its `woff2` row is no longer current.

Manual smoke on a clean profile (`PI_DESKTOP_DATA_DIR=$(mktemp -d)`):

1. `pnpm dev` launches with `OMP Desktop` in the macOS application menu and the
   canonical icon in both the Dock and native About panel; no Electron brand is
   visible.
2. App launches from DMG install, window appears, and the application-menu,
   About-panel, and Dock branding match the development lane.
3. Empty home and expanded/collapsed sidebar show the canonical OMP Desktop
   logo; composer prompt rows have no leading brand icon; New task and
   project/Temporary create controls use the message-plus session icon.
4. Onboarding checklist appears; configure provider; one streamed chat turn.
5. One permissioned tool call (Write) allow + deny paths.
6. Quit/relaunch → session history restored, window bounds restored.
7. `<isolated data root>/logs/` contains categorized NDJSON under `app/`, `host/`,
   and `agent/`; key lifecycle, tool, provider, plugin, and error records are
   available without dedicated timing files.
8. With network access disabled, the shell still starts; English/Chinese
   switching, syntax highlighting, shell highlighting, KaTeX, Mermaid
   fallback/rendering, host health, and sidecar health continue to use packaged
   local assets.

## 6. Native-runner release packages

The repository exposes native-runner commands for every release target. Each
packaging command first runs `build:host-release`, then bundles the agent
runtime and Electron app. D126/D285 tag workflows publish these outputs and
their electron-updater manifests. Run a target command on that target OS:

```text
macOS Apple Silicon: pnpm --filter @pi-desktop/desktop run dist:mac --arm64
macOS Intel:         pnpm --filter @pi-desktop/desktop run dist:mac --x64
Windows: pnpm --filter @pi-desktop/desktop dist:win
Linux:   pnpm --filter @pi-desktop/desktop dist:linux
```

The macOS packages include `bin/pi-desktop-host-core` built for their runner
architecture; Windows includes `bin/pi-desktop-host-core.exe`; Linux includes
`bin/pi-desktop-host-core`. Signing, rollback, and installer upgrade
qualification remain release hardening work; publication is active under
D126/D285.

Native-runner output matrix:

- macOS arm64: `PI-Desktop-<version>-arm64.dmg` and
  `PI-Desktop-<version>-arm64-mac.zip`
- macOS Intel x64: `PI-Desktop-<version>-x64.dmg` and
  `PI-Desktop-<version>-x64-mac.zip`
- Windows x64: NSIS installer `PI-Desktop-Setup-<version>.exe` and portable
  exe `PI-Desktop-Portable-<version>.exe`
- Linux x64: AppImage, deb, and rpm
- Linux x64 system Electron asset: `PI-Desktop-<version>-linux-x64.asar`

The portable Windows target does not write `latest.yml`. Packaged portable
runs use notify-and-link delivery (`PORTABLE_EXECUTABLE_FILE`); NSIS keeps
the in-app download and quit-and-install lane. Data stays in the existing
application data directory. Portable requests user execution level, so launch
does not require administrator rights.

RPM targets pass `_build_id_links none` to FPM. Bundled Electron binaries live
under `/opt/PI-Desktop`; omitting global `/usr/lib/.build-id` links prevents
collisions with other applications that bundle the same Electron binaries.

The ASAR asset contains the Electron application archive, not a complete Linux
distribution. To repackage it, place it as the application archive in the
target Electron resources layout together with the native host and other
resources from the target package, then launch it with:

```bash
electron PI-Desktop-<version>-linux-x64.asar
```

Shell smoke on each native runner:

1. Confirm no File/Edit/View/Window/Help menu appears inside the window.
2. Verify F10 and Shift+F10 remain available to focused content.
3. Execute application and editing shortcuts from a focused editor.
4. Minimize, maximize, restore, and close from the custom controls.
5. Relaunch with `PI_DESKTOP_START_MAXIMIZED=1`; confirm the initial
   maximize/restore glyph matches the queried native state.
6. Verify unknown menu/window IPC actions fail with the window open and closed.

## 7. Known limitations

- Linux deb/rpm, unsigned macOS and the Windows portable exe remain notify-and-link update
  modes. Developer ID-signed macOS, Windows NSIS, and Linux AppImage use in-app
  `electron-updater`.
- Linux x64 packages are built on Ubuntu 22.04 so host-core needs glibc 2.35
  or newer (Ubuntu 22.04, Debian 12, Fedora 36+). The tag job runs
  `scripts/check-linux-host-glibc.mjs` and refuses a binary that needs a
  newer glibc.
- Rollback, staged rollout, and prerelease channel policy remain open release
  work. Existing unsigned macOS installs may need one manual signed DMG before
  in-app updates succeed.

## Post-publication bug audit

The on-demand `scripts/audit-released-bugs.mjs` exercises regression scenarios
after publication. Run it with Node 24 after `pnpm build:js`, setting
`OMP_RELEASE_HOST_BINARY` to the published host executable and
`OMP_BUNDLED_RESOURCES` to the matching installed Resources directory. It uses
owned temporary projects and loopback/mock providers. A failing assertion is
a reproduced defect; it must not be reported as a passing release check.

The `bug-check-v*` workflow currently audits published v0.1.1 on Windows. It
requires an unchanged product tree and verifies the official installer digest
before running the isolated installed scenarios. Only fixed check IDs, bounded
numeric window observations and statuses are published on a separate result
branch. Raw logs and local fixture paths are excluded. A single-monitor runner
does not qualify the physical dual-monitor fullscreen regression.
