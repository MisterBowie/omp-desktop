# ADR 0098: Treat every vendor OAuth account as an independent provider row

- Status: Accepted for implementation
- Date: 2026-08-18
- Deciders: PI-Desktop core
- Related: D240, ADR 0095, D027, D028, D031

## Context

The first vendor-account implementation used the pi-ai vendor id as the local
identity. Electron main kept one provider-row id and one `CredentialStore` per
vendor, so a second sign-in could only reuse the first account. The renderer
also showed OAuth rows in the AI provider list while a separate Vendor accounts
card managed the same rows. Its sign-out action cleared the credential but left
the provider row behind, which made the two surfaces disagree.

Multiple accounts are a real requirement: a user may have separate personal,
work, or team subscriptions for one vendor. The account boundary must also be
the security boundary, because refresh and access tokens must never cross from
one account into another.

## Decision

1. **The provider row id is the account identity.** Every successful login starts
   with a new `authKind: "oauth"` provider row, even if another row has the same
   `vendorKey`. Its OAuth credential is stored only at
   `secret:provider:<providerId>:oauth`.
2. **Each account gets a scoped pi-ai collection.** Electron main creates one
   `MutableModels` instance and one `CredentialStore` for each provider row. The
   store accepts the builtin vendor id only inside that instance and translates
   it to the row-specific secret ref. Refresh serialization is keyed by the row
   id, so concurrent accounts cannot read-modify-write each other's token.
3. **Vendor accounts own OAuth row lifecycle.** The Vendor accounts card lists
   every local account, allows the vendor picker to be selected repeatedly, and
   removes an account through `providers.delete`. Host-core therefore clears the
   row, OAuth secret, API-key secret, and secret metadata together. A stale row
   without a credential remains visible as `Needs sign-in` until the user
   removes it.
4. **AI services and vendor accounts are separate settings surfaces.** The AI
   services list contains API-key and custom/no-auth services only. Connected
   OAuth rows remain available to the default-model selector and runtime, but
   are edited and deleted only from Vendor accounts.
5. **Runtime bindings use provider ids end to end.** The sidecar binding table
   stores only the OAuth provider row ids allowed for a session. Its
   `provider.resolveAuth` request is checked against that set and main resolves
   the corresponding row-scoped collection. A vendor key is never used as an
   ambiguous account lookup at the sidecar boundary.
6. **Ambiguous subagent aliases fail closed.** A subagent pin may use an exact
   provider id. A vendor/name alias is accepted only when it resolves to one
   provider row; duplicate vendor accounts require an exact row id rather than
   silently selecting the first account.

## Consequences

- The account list can contain several rows for one vendor and labels duplicate
  rows with a stable ordinal for scanning.
- Removing the selected default account clears or repairs the default to the
  first remaining ready provider.
- Existing OAuth rows remain readable after upgrade; the next sign-in creates a
  new row instead of mutating the existing one.
- The IPC host protocol and SQLite schema do not need a new table or version.
  The renderer uses the Electron-main `providers/oauth/delete` invoke channel,
  which delegates to the existing host provider deletion contract.

## Alternatives

- **Keep one shared credential per vendor and add account labels.** Rejected:
  the credential store and pi-ai model collection are vendor-keyed, so one
  account would overwrite or refresh the other.
- **Keep OAuth rows in the generic AI services list.** Rejected: it presents two
  owners for one object and makes deletion semantics unclear.
- **Clear only the OAuth secret on account removal.** Rejected: it leaves an
  unusable provider row, stale default identity, and a misleading service entry.

## References

- `docs/adr/0095-vendor-account-oauth-login.md`
- `docs/spec/03-runtime/11-provider-model-system.md` §8a and §17
- `docs/spec/03-runtime/12-provider-config-schema.md` §3 and §9
- `docs/spec/03-runtime/01-ipc-protocol.md` vendor accounts
- `docs/spec/04-ux/06-settings-ia.md` Model configuration
- `docs/spec/06-delivery/04-e2e-test-plan.md` E2E-151
- `apps/desktop/electron/main/oauth.ts`
- `apps/desktop/electron/main/agent-sidecar.ts`
