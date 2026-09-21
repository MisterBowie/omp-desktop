# ADR 0243: Skill market public-HTTPS catalog fetch

- Status: Accepted
- Date: 2026-09-13
- Decision: D413
- Amends: ADR 0009
- Issue: #287
- PR: #290

## Context

Settings → Skills gained a Market view that installs community `SKILL.md`
documents through the existing `skills.create` write path. The renderer CSP
only allows localhost, so catalog discovery and document fetch run in Electron
main. Users can add arbitrary source URLs. A naive `net.fetch` would follow
redirects onto loopback or RFC1918 space.

The plugin marketplace already uses a **fixed host allowlist**. A skill market
that accepts user GitHub repos cannot reuse that allowlist. MCP market (#285)
needs the same public-HTTPS classifier; duplicating `isPublicHostname` under
two `export *` names would collide.

Host-core `valid_capability_id` accepts `[a-z0-9][a-z0-9-]{0,63}`. A scan that
kept underscores produced ids the host rewrote, so the Market "Installed"
badge never matched.

User skills are a single markdown file capped at 128 KiB. Inlining sibling
`.md` files can exceed that cap after preview succeeded.

## Decision

1. Keep a single I/O-free classifier in `packages/shared` (`isSafePublicHttpsUrl`,
   `isPublicHostname`, `isPublicIpLiteral`). Skill market wraps it as
   `isSafeSkillSourceUrl`. Future MCP market imports the same module.
2. Main-process fetches go through `createPublicHttpsClient`: HTTPS only,
   DNS classification of every resolved address, `redirect: "manual"` with
   per-hop re-validation, and retries only for non-policy failures.
3. The renderer never fetches catalog or document URLs. Install remains
   `skills.create`. Host-core stays unaware of the market.
4. Scanned and catalog ids are sanitized to host `valid_capability_id` before
   they reach the UI.
5. Preview shows the assembled body (skill text plus inlined sibling markdown).
   A document that would exceed `MAX_SKILL_BYTES` cannot be installed.
6. Builtin catalog titles are English (ADR 0009).

## Consequences

- User-added `https://github.com/org/repo` sources make main walk the git tree
  and pull jsDelivr copies. The boundary is "public HTTPS + public resolved
  IPs", not a host allowlist. DNS rebinding between lookup and Chromium
  `net.fetch` remains a residual risk.
- Installing a skill still writes model instructions. Preview is the
  disclosure; `verified` on builtin rows is not a signature.
- MCP market must import `public-network.ts` instead of copying the
  classifier.

## Alternatives

- Plugin-marketplace host allowlist: too narrow for user GitHub sources.
- Directory install (`~/.agents/skills/<slug>/`): incompatible with the
  current single-file user-skill model.
- Pin fetched IPs into undici: stronger against rebinding, but would skip
  Chromium's proxy stack that `net.fetch` honors.
