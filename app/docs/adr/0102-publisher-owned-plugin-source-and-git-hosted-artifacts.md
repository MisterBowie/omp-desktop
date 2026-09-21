# ADR 0102: Publisher-owned plugin source with a Git-hosted artifact store

> Amended 2026-08-19: artifacts are committed to the existing distribution
> repository rather than published as releases of the center repository. The
> ownership model and every other decision below are unchanged.

- Status: Accepted for implementation
- Date: 2026-08-18
- Deciders: PI-Desktop plugin and distribution maintainers
- Supersedes: ADR 0006 (marketplace postponed)
- Amends: ADR 0007 (plugin package format), ADR 0005 (user-installable plugins)

## Context

The shipped marketplace stores everything in one repository. `vastsa/pi-desktop-plugins`
holds plugin source under `plugins/<id>/`, built packages under `packages/*.piplug`,
and the `catalog.json` the client reads. Publishing means a maintainer commits
somebody else's source into the marketplace repository and regenerates the catalog
with a local script.

That model does not survive third-party publishers:

- Plugin source has no owner outside the marketplace repository. A publisher
  cannot iterate, tag, or version independently.
- The marketplace repository grows binary packages forever and its Git history
  becomes the artifact store by accident.
- Nothing binds a published package to the source that produced it. The catalog
  records a checksum, not a repository, commit, or builder.
- `verified` is a hand-edited catalog field. A publisher with commit access can
  assert it.
- `download_url` follows redirects to any host. That is acceptable while every
  package URL resolves under one known repository, and unacceptable once package
  URLs are publisher-supplied.

The plugin center design (`vastsa/pi-plugin-center`) answers the ownership half:
plugin source stays in the publisher's own repository, and the platform stores a
permission-verified snapshot, build evidence, review reports, and a signed
catalog. It specifies S3/R2 plus a CDN as the artifact store.

We want the ownership model without operating object storage.

## Decision

### 1. The publisher's repository is the source of truth

A publisher submits a repository coordinate — canonical HTTPS repository URL,
path, and a ref that resolves to a 40-hex commit. PI-Desktop never copies plugin
source into a project-owned repository. `pluginId`, `publisherId`, the linked
repository, and the packaged `manifest.json` identity must agree, and a published
version is pinned to exactly one `(repository, commit, path)` tuple.

### 2. Management and distribution are separate repositories

`vastsa/pi-plugin-center` is the management plane: submissions, ownership
verification, isolated builds, review, the policy gate, and the registry that
records what has been published.

`vastsa/pi-desktop-plugins` stays the distribution repository. It keeps serving
`catalog.json` from its root and packages from `packages/`, and the CNB copy
keeps mirroring it. There is no S3, no R2, and no separately operated CDN.

- The publisher builds and attaches `<id>-<version>.piplug` to a release in their
  own repository, or the center's isolated runner builds it from the pinned
  commit.
- The center verifies the bytes, then commits the package to
  `pi-desktop-plugins/packages/` together with a regenerated `catalog.json`, in
  one commit.
- Package URLs stay relative, so they resolve against whichever host served the
  catalog. Switching between GitHub and the CNB mirror therefore cannot send a
  download to the other provider or change the checksum being verified.

Keeping distribution where it already is means the default catalog URL never
changes and no installed client needs to migrate. It also means the artifact
bytes and the digest that describes them land in the same Git commit, which is a
stronger record than a release asset: changing published bytes requires rewriting
history rather than re-uploading a file. The residual risk is a force-push, which
branch protection on the distribution repository is expected to prevent.

The accepted cost is repository growth. Committed binaries are permanent — an
unused version can be removed from `packages/` but stays in history, so every
clone pays for every version ever published.

### 3. Catalog schema v2 is the client contract

`catalog.json` gains `schemaVersion: 2` and carries, per version: the source
repository, ref, commit and path; the builder identity; the review decision, risk
tier and policy version; `yanked` state; and an optional detached signature. The
client keeps reading v1 catalogs unchanged so the existing marketplace repository
and any custom source keep working during migration.

### 4. The host restricts where a package may come from

Because package URLs are now publisher-influenced, host-core enforces a download
host allowlist for marketplace packages: the GitHub release and raw asset hosts,
and the CNB host. Redirects are restricted to HTTPS and the final effective URL
is re-checked against the allowlist. A custom or enterprise catalog may only
download from the host that served its own catalog, unless the user has
explicitly configured additional hosts.

### 5. Trust and review verdicts are center-issued, never publisher-asserted

`trust`, `review.decision`, `review.risk`, and `policyVersion` are written by the
center's policy evaluator. Publisher-submitted metadata cannot set them. The
client renders `community` for anything it cannot attribute to the center, and
never renders an unverifiable claim as `verified`.

### 6. A yanked version is not installable

`yanked: true` removes a version from install and update selection, keeps it
visible in version history with its reason, and marks an installed copy as needing
attention.

## Consequences

- Third-party publishers can ship plugins without write access to any
  PI-Desktop-owned repository, and can version on their own schedule.
- The default catalog URL is unchanged, so no client release and no user action
  is needed to reach plugins published through the center.
- The client needs no code change for this decision: relative package URLs
  already resolve against the catalog that carried them, and the download host
  allowlist already covers both distribution hosts.
- Every installed marketplace plugin can be traced to a repository and commit,
  and the desktop can show that provenance before install.
- Losing object storage costs WORM semantics and versioned-bucket retention. The
  Git record above is tamper-evident rather than tamper-proof, and the
  distribution repository grows without bound. Both are accepted trades.
- The client must tolerate two catalog schemas while the distribution repository
  serves v1 entries alongside center-published v2 ones.
- Publisher signing keys remain out of scope. The center signs; publisher-held
  keys stay in ADR 0008's later phase.

## Rejected alternatives

- **Keep source in the marketplace repository.** Simple, already working, and
  cannot support a publisher who is not a maintainer.
- **Index only; download from publisher repositories.** Removes the center from
  the download path entirely, but a publisher can delete or replace a release
  asset out from under a published version, and the client would need an
  open-ended host allowlist.
- **Publish artifacts as releases of the distribution repository.** Keeps Git
  history free of binaries and allows pruning old versions, at the cost of a
  catalog that must declare an artifact base, and a CNB mirror that has to
  replicate release assets separately instead of riding along with the Git
  mirror that already exists.
- **Center builds every plugin from source with no publisher artifact.** Strongest
  reproducibility, and makes the center responsible for every plugin's toolchain
  and dependency supply chain from day one. Retained as the runner path for
  plugins that opt in, not as the only path.
- **S3/R2 plus CDN as specified in the plugin center document.** Gives WORM,
  object lock, and cache control, at the cost of the operational and billing
  surface this decision exists to avoid.
