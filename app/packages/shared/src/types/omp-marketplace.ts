/**
 * The OMP plugin marketplace as the desktop presents it (ADR 0333).
 *
 * The OMP runtime owns the marketplace: its CLI adds sources, installs and
 * upgrades plugins, and writes the registries these shapes are read from. The
 * desktop only projects that state for display and runs the CLI on request.
 */

/** How a marketplace source was added, as OMP classifies it. */
export type OmpMarketSourceType = "github" | "git" | "url" | "local";

/**
 * Plugin components. The first four are declarative content; the rest run
 * programs or connect to servers when a session loads the plugin.
 */
export type OmpMarketComponentKind =
  | "skills"
  | "commands"
  | "agents"
  | "rules"
  | "mcp"
  | "hooks"
  | "tools"
  | "lsp"
  | "dap"
  | "extensions";

export type OmpMarketLoadedComponent = "skills" | "commands" | "agents" | "rules";

export const OMP_MARKET_LOADED_COMPONENTS: readonly OmpMarketLoadedComponent[] = [
  "skills",
  "commands",
  "agents",
  "rules",
];

export type OmpMarketSource = {
  name: string;
  sourceType: OmpMarketSourceType;
  /** The source exactly as OMP recorded it (repo shorthand, URL or path). */
  sourceUri: string;
  updatedAt: string;
  description?: string;
  ownerName?: string;
  pluginCount: number;
  /** Set when the cached catalog could not be read. */
  error?: string;
};

/** Why a catalog entry cannot be installed by the pinned runtime. */
export type OmpMarketUnavailableReason =
  | "npm-source"
  | "relative-source-in-url-catalog"
  | "unknown-source";

export type OmpMarketPlugin = {
  /** `name@marketplace`, OMP's plugin id. */
  id: string;
  name: string;
  marketplace: string;
  description?: string;
  version?: string;
  authorName?: string;
  /** Only http(s) URLs survive projection. */
  homepage?: string;
  repository?: string;
  license?: string;
  category?: string;
  keywords: string[];
  installable: boolean;
  unavailableReason?: OmpMarketUnavailableReason;
  /** Executable component kinds the catalog entry itself declares. */
  declaresExecutable: OmpMarketComponentKind[];
};

export type OmpMarketInstalledComponents = {
  loaded: Partial<Record<OmpMarketLoadedComponent, number>>;
  executable: OmpMarketComponentKind[];
};

export type OmpMarketInstalledPlugin = {
  id: string;
  name: string;
  marketplace: string;
  version: string;
  installedAt: string;
  lastUpdated: string;
  enabled: boolean;
  components: OmpMarketInstalledComponents;
  /** Catalog version when it is newer than the installed one. */
  updateVersion?: string;
  /** The recorded install path is missing or outside the plugin cache. */
  broken?: boolean;
};

export type OmpMarketState = {
  /** False when this build has no usable OMP runtime to manage plugins with. */
  available: boolean;
  unavailableReason?: string;
  sources: OmpMarketSource[];
  plugins: OmpMarketPlugin[];
  installed: OmpMarketInstalledPlugin[];
};
