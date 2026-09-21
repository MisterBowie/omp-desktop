# ADR 0258: Trusted extensions may provide custom agents

- Status: Accepted for implementation
- Date: 2026-09-15
- Decision: D426
- Related: ADR 0214, ADR 0215, `07-plugins/16-trusted-extensions.md`, Issue #401

## Context

Trusted extensions run beside the Agent runtime and are the appropriate surface for
providers that cannot be represented by a built-in pi-ai adapter. Issue #401 asks
for model selection and custom agent/provider registration so a plugin can integrate
services such as Command Code with its own endpoint and authentication flow.

The pinned pi-coding-agent API has `registerProvider`, but no `registerAgent`, and
its provider registry assumes coding-agent-owned credentials and model persistence.
Passing that registry through would bypass PI-Desktop's session binding and secret
ownership boundaries.

## Decision

1. Add a PI-Desktop `registerAgent` ExtensionAPI member. A trusted extension
   registers an id, bounded model metadata, and either a `stream` or `complete`
   implementation. The plugin owns endpoint, authentication, request serialization,
   and response conversion.
2. Keep the registration in the Agent sidecar. The host receives only the selected
   opaque provider id/model id and persists the session binding through the existing
   `session.configure` flow.
3. Use namespaced `extension-agent:<encoded-agent-key>` provider ids. On later turns
   the Electron launcher passes the binding as a placeholder provider; the sidecar
   reloads the trusted extension and reactivates the matching implementation.
4. Expose a read-only model registry projection to the extension context. It may
   list models and auth availability, but never returns host API keys, secret refs,
   OAuth tokens, arbitrary provider headers, or host provider internals.
5. `registerProvider` accepts the same plugin-owned streaming shape as a compatibility
   alias. Literal provider credentials are not consumed by the host and no provider
   registration is written to the Host database or global defaults.
6. Registration is session-scoped and is removed with the runtime. Custom agents are
   available only to trusted extensions holding the existing high-risk
   `agent.extension` grant.

## Consequences

- Command Code and similar integrations can implement their own auth and wire
  protocol without an app release or a new Rust transport.
- Session model selection remains host-owned and observable through the existing
  `session:modelChanged` event.
- Custom agent definitions are not visible in the ordinary provider Settings picker;
  a plugin may expose its own command or UI to select them.
- Trusted extension code has sidecar-level authority by design. Marketplace
  distribution remains subject to the existing signing/trust policy.
- The public ExtensionAPI contract is PI-Desktop-specific for `registerAgent`;
  upstream pi API upgrades must preserve the adapter contract or add a compatibility
  translation.

## Alternatives considered

### Expose pi-coding-agent ModelRegistry directly

Rejected: it exposes credential resolution and assumes pi's persistence model.

### Add every custom provider to Rust/SQLite

Rejected: the plugin owns the implementation and credentials, while Host storage
must not persist opaque plugin transport code or secrets.

### Register an executable subagent instead

Deferred to a separate API. This decision covers custom LLM/Agent transport, not a
new autonomous worker or tool-permission profile.
