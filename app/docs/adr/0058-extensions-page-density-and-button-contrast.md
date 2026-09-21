# ADR 0058: Extensions Page Density and Theme-Readable Button Surfaces

- **Status:** Accepted (IA amended by ADR 0112)
- **Date:** 2026-08-05
- **Decision:** D196

## Context

The Extensions destination is a focused two-tab plugin surface: Installed and
Marketplace. MCP, Skills, and Subagents are managed independently under
Settings > Agent. The four-number
overview band retained derived counts that were already represented by tab,
group, and update states, consuming vertical space without adding a decision
point. The shared button primitive also relied on gray-scale aliases and
transparent text-mix fills, which made secondary actions and theme transitions
too weak in dark mode.

## Decision

1. Remove the numeric overview band and its four derived counters from the
   Extensions page. Keep the two tabs, Installed and Marketplace, with relevant counts, installed
   state groups, and pending-update alerts as the actionable hierarchy.
2. Define shared primary and secondary buttons with semantic theme tokens:
   primary buttons use `--ds-accent` and `--ds-bg-primary`; secondary buttons
   use `--ds-bg-secondary`, `--ds-text-primary`, and `--ds-border-default`.
   Hover states use `--ds-accent-hover` and `--ds-bg-tertiary`.
3. Treat this as a renderer presentation change only. Plugin, MCP, skill,
   marketplace, permission, host, protocol, and storage contracts do not
   change.

## Consequences

- The page header and segmented control reach the useful content sooner and
  preserve more space for extension rows, cards, and editors.
- The source of truth for counts remains close to the surface it describes.
- Primary and secondary actions have an opaque, theme-correct surface and a
  visible semantic edge in both dark and light themes.
- Any future overview summary must introduce a distinct action or decision
  point rather than repeating tab or group state.

## Alternatives considered

- Keep the overview band and reduce it to two cards: rejected because it still
  duplicates state and leaves the four-tab hierarchy uneven.
- Fix only the Extensions page buttons: rejected because the shared `Button`
  primitive is used across the app and the contrast defect is systemic.
- Add hard-coded per-theme colors: rejected because it would bypass the
  semantic token contract and make future theme changes harder.
