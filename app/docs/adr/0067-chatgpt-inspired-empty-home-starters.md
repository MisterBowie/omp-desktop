# ADR 0067: ChatGPT-inspired empty-home starter guidance

- Status: Superseded by D206
- Date: 2026-08-07
- Deciders: PI-Desktop core
- Amends: D204 and the card-specific clause of ADR 0066

> This historical decision is retained for traceability. The starter grid was
> removed after review; D206 restores the empty home to the hero, optional
> onboarding checklist, and direct bottom composer.

## Context

The direct bottom composer introduced by D204 fixed the empty-home layout, but
left the center of the conversation surface visually sparse. A first-time
developer still had to invent a prompt before seeing what PI-Desktop could do.
The requested direction is the approachable hierarchy of ChatGPT's empty
conversation surface, adapted for local coding work rather than consumer
content or promotional templates.

## Decision

1. Add a four-card starter grid between the empty-home hero and optional
   onboarding checklist: Explore a codebase, Build a feature, Fix a bug, and
   Review a change.
2. Keep the cards compact, monochrome, localized, and developer-specific.
   They use the shared icon, border, surface, shadow, and motion tokens.
3. Activating a card only prefills and focuses the existing bottom composer.
   It never sends a prompt, creates a session turn, or changes the current
   session mode.
4. Keep D204's single scrollable home content region and bottom-reserved
   composer unchanged. Short windows must still scroll the content instead of
   allowing the composer to cover it.

## Consequences

- Empty home has useful visual hierarchy without moving or duplicating the
  primary composer action.
- Starter prompts remain editable, so users can add project-specific context
  before sending.
- The four cards add only renderer-local presentation and localized copy; no
  IPC, storage, or protocol changes are required.
- The starter grid collapses to one column on narrow windows and remains inside
  the existing home scroller.

## Alternatives considered

### Keep the hero-only empty state

Rejected. It preserves direct entry but leaves the middle surface needlessly
sparse and gives new users no task vocabulary.

### Automatically submit a selected starter

Rejected. A starter is guidance, not an implicit action. Prefilling preserves
user control and lets the user add paths, constraints, or acceptance criteria.

### Restore the former ambient suggestion row

Rejected. The former row was too decorative and used a different prompt
selection model. The new grid is compact, explicitly developer-focused, and
keeps the composer as the only send surface.

## References

- `docs/adr/0066-empty-home-direct-bottom-composer.md`
- `docs/spec/04-ux/01-ui-ia.md`
- `docs/spec/04-ux/07-ui-design-system.md`
- `docs/spec/04-ux/08-component-spec.md`
- `docs/spec/04-ux/10-workbuddy-benchmark-ux.md`
- `docs/spec/06-delivery/04-e2e-test-plan.md` (E2E-063, US-UI-31, US-UI-34, US-UI-48, US-UI-64)
- `docs/spec/08-meta/decisions-log.md` (D204, D205, D206)
