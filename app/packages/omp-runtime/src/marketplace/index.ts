/** The desktop's view of the OMP plugin marketplace (ADR 0333). */
export {
  ensureOmpMarketplaceStore,
  isOmpNameSegment,
  isStoreInstallPath,
  MAX_MARKETPLACE_FILE_BYTES,
  OMP_MARKETPLACE_CONFIG_DIR,
  OMP_MARKETPLACE_DIR,
  ompMarketplaceStore,
  parseOmpPluginId,
  readStoreCatalog,
  readStoreInstalled,
  readStoreMarketplaces,
  storeCatalogPath,
  type OmpMarketplaceStore,
  type StoreCatalog,
  type StoreCatalogPlugin,
  type StoreInstalledPlugin,
  type StoreMarketplace,
} from "./store.js";
export {
  buildDeclarativeView,
  inspectPluginComponents,
  MARKETPLACE_VIEW_DIR,
  marketplaceRunSnapshot,
  projectMarketplacePlugins,
  safeDeclaredPath,
  VIEW_CONVENTIONAL_DIRS,
  type MarketplaceRunPlugin,
  type MarketplaceRunSnapshot,
} from "./view.js";
export {
  DEFAULT_PLUGIN_CLI_TIMEOUT_MS,
  marketplacePathEntries,
  ompPluginCliFailure,
  pruneStaleNatives,
  runOmpPluginCli,
  type OmpPluginCliOptions,
  type OmpPluginCliResult,
} from "./cli.js";
export { isNewerCatalogVersion, readOmpMarketState, type OmpMarketStateOptions } from "./state.js";
