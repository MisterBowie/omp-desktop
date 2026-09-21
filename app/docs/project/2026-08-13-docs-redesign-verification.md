---
title: Documentation redesign visual verification
description: Desktop and mobile rendering baselines for the bilingual VitePress documentation system.
---

# Documentation redesign visual verification

These browser-rendered captures record the responsive baseline introduced by
the August 2026 documentation redesign. They are evidence for E2E-125, not a
replacement for rebuilding and checking the current site.

## Desktop landing page

The 1440×900 capture verifies the centered hero, compact navigation, system
visual, feature row, and the beginning of the intent-based content map.

![PI-Desktop documentation landing page at 1440 by 900](/screenshots/docs-home-desktop.png)

## Mobile Chinese landing page

The 390×844 capture verifies that the translated hero leads the reading order,
the system visual follows the primary actions, and the page has no horizontal
overflow.

![PI-Desktop Chinese documentation landing page at 390 by 844](/screenshots/docs-home-mobile-zh.png)

## Chinese specification page

The desktop specification capture verifies the generated Chinese sidebar,
bounded reading column, source notice, and deep outline for a long runtime
contract.

![PI-Desktop Chinese specification page at 1440 by 900](/screenshots/docs-spec-zh-desktop.png)

## Verification contract

- Viewports: 1440×900 desktop and 390×844 mobile.
- Locales: English and Simplified Chinese.
- Appearance: light and dark mode are checked during the browser run; the
  committed captures use light mode for legibility in repository viewers.
- Overflow: the document root must match the viewport width; wide tables and
  code blocks may scroll only inside their own containers.
