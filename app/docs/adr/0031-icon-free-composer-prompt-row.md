# ADR 0031: Keep composer prompt rows free of brand icons

- Status: Accepted
- Date: 2026-07-28
- Related: [01-ui-ia](../spec/04-ux/01-ui-ia.md) ·
  [07-ui-design-system](../spec/04-ux/07-ui-design-system.md) ·
  [08-component-spec](../spec/04-ux/08-component-spec.md) · decision D160

## Context

D054 introduced a visible cue beside an empty draft, and D094 standardized that
cue as the canonical PI-Desktop logo in the thread-docked composer. The home
composer later removed the cue, leaving the two prompt rows visually
inconsistent. In a dense transcript, the remaining decorative logo also
consumes horizontal input space without adding navigation, status, or runtime
meaning.

Because D094 is part of the frozen product baseline, removing its docked
composer requirement needs an explicit superseding decision even though the
implementation is limited to renderer presentation.

## Decision

1. Home and thread-docked composer prompt rows render no leading brand icon.
2. Draft text and placeholder ink begin at the input row's standard content
   gutter; no layout space is reserved for a removed mark.
3. The renderer `BrandLogo` component continues to use the canonical asset for
   the home hero, expanded/collapsed sidebar, and startup splash. Native Dock,
   application-menu, and About identity continue to use their platform-specific
   forms of the same canonical asset.
4. Session-creation controls retain their dedicated message-plus icon.
5. This decision supersedes only D054's leading brand-cue requirement and
   D094's docked-composer logo placement. All product naming and remaining
   brand-asset requirements stay unchanged.

## Consequences

- Home and transcript composers share one icon-free prompt-row boundary.
- The textarea gains the width previously occupied by the 15px logo and gap.
- Removing the renderer node also removes the associated theme-specific CSS.
- Brand recognition continues through the surrounding shell without repeating
  the product mark inside a text-entry surface.

## Alternatives

### Keep the docked 15px logo

Rejected. It preserves the historical branding contract but keeps inconsistent
input-row anatomy and consumes space without conveying state or an action.

### Add the logo back to the home composer

Rejected. Repeating the mark in both text-entry surfaces adds decorative chrome
instead of simplifying the prompt path.

## References

- `docs/spec/00-baseline.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-046, US-UI-37)
- `docs/spec/08-meta/decisions-log.md` (D054, D094, D160)
