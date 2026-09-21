# ADR 0096: Flatten the Settings directory and colocate marketplace source configuration

- Status: Accepted
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D166, D168, D238, ADR 0036, ADR 0058

## Context

The implemented Settings rail had grown to nine entries, including a separate
`Extensions` destination for two marketplace-source controls. The rail also
wrapped destinations in `Personal`, `Integrations`, and an implicit system
section. Those headings repeated information already expressed by the
destination labels, while `Extensions` had the same visible name as the
app-shell destination that owns plugin management.

The settings IA already defines eight useful destinations. Plugin marketplace
source selection is a marketplace concern and belongs beside the catalog it
controls, not beside appearance, providers, or project settings.

## Decision

Keep the full-page Settings shell and render one flat, searchable directory in
this exact order:

1. Basics
2. AI
3. Shortcuts
4. Instructions
5. Model configuration
6. Import
7. Project archive
8. Info

Remove navigation group headings and the Settings `Extensions` destination.
Move the official/mirror/custom marketplace source selector, including the
custom catalog URL field and active-source status, into the app-shell
`Extensions → Marketplace` surface. The shared Settings search index contains
only the eight Settings destinations; plugin marketplace search and controls
remain owned by the Extensions page.

No IPC, host protocol, storage, provider, plugin permission, or project
ownership contract changes.

## Consequences

- Settings has one visual hierarchy and fewer competing labels.
- The rail matches the frozen eight-destination IA and no longer duplicates
  the Extensions page name.
- Marketplace source changes remain available in the context where users browse
  and install packages, with the same persistence and refresh behavior.
- Settings search no longer deep-links marketplace-source rows; the Extensions
  page is the owner of that surface.
- Screenshot capture scenes and marketplace E2E steps must open the source
  selector from Extensions → Marketplace.

## Alternatives

### Keep the three group headings

Rejected because the groups do not add a second useful navigation level; they
make the rail taller and repeat the meaning of the destination labels.

### Rename Settings `Extensions` to `Marketplace`

Rejected because it would preserve a one-card Settings destination and still
split marketplace browsing from marketplace configuration.

### Remove marketplace source configuration

Rejected because mirror and custom catalog sources are required for networks
that cannot reach the official source and for development/private catalogs.

## References

- `docs/spec/04-ux/06-settings-ia.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md`
- `docs/spec/07-plugins/07-plugin-marketplace.md`
