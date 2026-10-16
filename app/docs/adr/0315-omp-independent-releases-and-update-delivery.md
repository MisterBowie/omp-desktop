# ADR 0315: Independent OMP versions and capability-based update delivery

- Status: Accepted
- Date: 2026-10-16
- Related: ADR 0022, ADR 0289, ADR 0314

## Context

The user starts OMP Desktop's own release series at 0.1.0 and requests GitHub
updates. Existing OMP packages use PI-era 0.15.x versions. The GitHub updater
identity already points at MisterBowie/omp-desktop, but only historical test
prereleases exist, the release workflow is nested below app/ and therefore
inactive, and unsigned Mac builds incorrectly promise in-app installation.
Remote-host assets and feedback still resolve through the PI repository.

## Decision

Use 0.1.0 on every current version surface and an independent eight-locale
changelog. Keep pre-reset history archived in source. Data directories, database
schema, protocol versions and bundled OMP version stay unchanged. The initial
version reset uses one manual install; automatic downgrades remain disabled.

Use the OMP GitHub repository for downloads, updates, remote-host bundles and
feedback. Activate a repository-root stable release workflow. Validate actual
installer hashes and sizes, both Mac architecture feeds and the remote-host
checksum before publishing the complete stable release. Historical test lanes
and prereleases remain separate.

Detect the installed Mac executable's Developer ID authority and team before
choosing in-app delivery. Unsigned, ad-hoc or uninspectable Mac builds check
and link to GitHub, with automatic download and install-on-quit disabled.
Signed Mac, NSIS and AppImage keep the existing in-app flow. Squirrel retains
its own downloaded-signature validation. The renderer cannot supply feed URLs.
OMP signing uses the release operator's credentials and explicitly configured
Apple team rather than the PI publisher's identity.

## Consequences

Version numbers and release notes describe OMP's own history. An old 0.15.x
test build does not automatically downgrade into 0.1.0; user data remains
compatible when the new package is installed manually. Future stable versions
are discovered from the same GitHub repository.

Unsigned Mac users have a working check-and-download-page path. Automatic Mac
replacement requires the operator's Developer ID certificate; no security
validation is bypassed to simulate that capability. Publication additionally
requires the exact maintained OMP fork commit to be fetchable by CI.
