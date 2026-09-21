# ADR 0110: Version the plugin panel chrome spacing contract

- Status: Accepted
- Date: 2026-08-20
- Deciders: PI-Desktop core
- Related: [ADR 0092](0092-plugin-owned-panel-surface.md) ·
  [ADR 0093](0093-plugin-panel-strict-drag-band.md) ·
  [ADR 0104](0104-plugin-contributed-work-panel-views.md) ·
  [07-plugins](../spec/07-plugins/03-plugin-api.md)

## Context

The host-owned plugin capsule reserves a strict 46px drag band. Older plugin
pages used ordinary body padding and relied on the preload to add that band.
Newer pages also read `--pi-plugin-titlebar-height`, which made additive host
padding duplicate the safe area and left excessive blank space above the
plugin-owned toolbar or card. The bundled Files page and the authoring
templates need one deterministic contract that works in both detached and
docked placements.

## Decision

1. A current plugin page declares `<meta name="pi-plugin-chrome" content="v2">`.
2. The preload publishes `--pi-plugin-titlebar-height` before page layout:
   `46px` for a detached panel and `0px` for a docked view.
3. v2 pages own their normal-flow spacing and must use that variable. The host
   does not add another top padding. Pages without the marker keep the legacy
   additive offset so existing installed plugins remain compatible.
4. The host capsule remains a closed, page-adaptive three-control capsule in
   the top-right of the 46px band; plugin pages own their title, toolbar, and
   surfaces. The host re-samples page colors after appearance changes.
5. First-party examples, bundled plugins, and generated panel templates use
   the neutral PI-Desktop token ramp and the v2 marker.

## Consequences

- Plugin pages no longer need to guess whether the host already inserted the
  safe area, and detached/docked entries can share their layout.
- Existing third-party pages continue to render while authors migrate.
- The marker is a small public HTML contract rather than a manifest schema
  change, so plugins can adopt it without a package format revision.
