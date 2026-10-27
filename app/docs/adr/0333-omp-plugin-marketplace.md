# ADR 0333: OMP plugin marketplace as declarative-only run views

- Status: Proposed on 2026-10-27; implemented on `codex/omp-marketplace`, awaiting
  user acceptance before merge.
- Related: ADR 0304 (capability-source ownership), ADR 0331 (OMP-only product),
  ADR 0332 (desktop-owned global instructions).

## Context

After ADR 0331 the Plugins → Marketplace tab still browsed the PI-Desktop
catalog through host-core `market.*` RPCs and installed desktop extension
packages. Nothing it installed reached an OMP chat. OMP ships its own
marketplace (`omp plugin marketplace add|remove|update`, `omp plugin
install|uninstall|enable|disable|upgrade`), compatible with Claude Code plugin
catalogs. An installed OMP plugin can carry skills, commands, agents and rules,
but also MCP servers, hook scripts, custom tool modules, LSP and DAP servers.
OMP imports tool modules at session start, even with `--trusted-extension`, so
loading a plugin directory as-is would run third-party code outside the
desktop's approval path.

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
4. **Sessions see declarative views only.** Each run gets its own
   `installed_plugins.json` pointing at a view directory in the run root. A view
   holds links to `skills/`, `commands/`, `agents/`, `rules/`, manifest-declared
   skill/command paths inside the plugin root, and a sanitized manifest. MCP
   servers, hooks, tool modules, LSP/DAP and `package.json` extension entries
   are absent, so they cannot load. The UI lists which components load and
   which are withheld.
5. **Changes apply at the next prompt.** The store's run snapshot is part of
   the launch fingerprint, so an idle runtime is rebuilt before it runs with a
   stale plugin set. Runs set `marketplace.autoUpdate: off`; only explicit user
   actions refresh catalogs or upgrade plugins.
6. **Clean cutover.** The PI-Desktop catalog panel, install dialog, source
   settings and `market*` IPC channels are removed from the desktop.

## Consequences

- Marketplace skills, commands, agents and rules work in OMP chats. Plugins
  whose value is an MCP server, hook or tool module install but contribute
  only their declarative parts. Opening those would need a separate approval
  design.
- The store is separate from the user's OMP data. Plugins installed with a CLI
  `omp` are not visible in the desktop, and the reverse holds, matching the
  isolation rule.
- The host-core `market.*` handlers and catalog module no longer have desktop
  callers. Removing them is left to the Pi-legacy cleanup (R12).
- Network failures and catalog errors surface as OMP's own failure line,
  bounded and stripped of terminal escapes.
