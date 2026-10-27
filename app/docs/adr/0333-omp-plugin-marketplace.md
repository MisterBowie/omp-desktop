# ADR 0333: OMP plugin marketplace driven by the runtime's own CLI

- Status: Proposed on 2026-10-27; implemented on `codex/omp-marketplace`.
  On 2026-10-27 the user asked to load plugin MCP servers, hooks and tools
  now and leave their approval design for later.
- Related: ADR 0304 (capability-source ownership), ADR 0331 (OMP-only product),
  ADR 0332 (desktop-owned global instructions).

## Context

After ADR 0331 the Plugins → Marketplace tab still browsed the PI-Desktop
catalog through host-core `market.*` RPCs and installed desktop extension
packages. Nothing it installed reached an OMP chat. OMP ships its own
marketplace (`omp plugin marketplace add|remove|update`, `omp plugin
install|uninstall|enable|disable|upgrade`), compatible with Claude Code plugin
catalogs. An installed OMP plugin can carry skills, commands, agents and rules,
and also MCP servers, hook scripts, custom tool modules, LSP and DAP servers.

## Decision

1. **The runtime owns the marketplace.** Every mutation runs the pinned
   runtime's own `omp plugin …` CLI (`packages/omp-runtime/src/marketplace/cli.ts`).
   The desktop never parses catalogs for writing, clones sources or edits OMP
   registries. The CLI exit status is the result; state is re-read from disk.
2. **A desktop-owned store.** The CLI runs with `HOME =
   <dataRoot>/omp-marketplace/home`, `PI_CONFIG_DIR = .omp` and cwd
   `home/work`, so project-anchor discovery stops at the store and never
   reaches the user's real `~/.omp`. It uses the session environment policy
   (`buildOmpRuntimeEnv`): no credentials, only the desktop's explicit proxy.
   Paths recorded outside the store are ignored. Native-addon extractions of
   other runtime versions are pruned after each run.
3. **Mutations are serialized and validated in main.** Sources, marketplace
   names and `name@marketplace` ids are checked before the CLI runs. One queue
   keeps two CLI runs from racing on OMP's registries. Shutdown aborts the
   running command and refuses new ones.
4. **Sessions load installed plugins in full.** Each run gets its own
   `installed_plugins.json` naming the enabled plugins' install directories in
   the store. OMP then loads every component, including MCP servers, hooks,
   tool modules, LSP and DAP servers. The UI lists the components that run
   programs on each card and in the detail sheet, and the marketplace notice
   asks users to install only plugins they trust.
5. **Changes apply at the next prompt.** The store's run snapshot is part of
   the launch fingerprint, so an idle runtime is rebuilt before it runs with a
   stale plugin set. Runs set `marketplace.autoUpdate: off`; only explicit user
   actions refresh catalogs or upgrade plugins.
6. **Clean cutover.** The PI-Desktop catalog panel, install dialog, source
   settings and `market*` IPC channels are removed from the desktop.

## Consequences

- Plugin code runs without a per-plugin approval. OMP imports tool modules
  and starts MCP servers when a session starts, before any prompt, so the
  desktop's tool approval cannot stop them. Hooks run on the runtime's tool
  events. Installing a plugin is the trust decision.
- Plugin MCP servers are started by OMP, next to the desktop's own MCP
  servers. Whether their tool calls pass through the desktop permission gate
  is not verified. A later decision should settle MCP ownership and approval.
- The store is separate from the user's OMP data. Plugins installed with a CLI
  `omp` are not visible in the desktop, and the reverse holds, matching the
  isolation rule.
- The host-core `market.*` handlers and catalog module no longer have desktop
  callers. Removing them is left to the Pi-legacy cleanup (R12).
- Network failures and catalog errors surface as OMP's own failure line,
  bounded and stripped of terminal escapes.
