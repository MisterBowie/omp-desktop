import {
  readMainModuleSync,
  readPluginsSourceSync,
  readStoreModuleSync,
  readMainSourceSync,
} from "./helpers/source-contracts.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { en } from "../../../packages/i18n/src/locales/en/index.ts";
import { zhCN } from "../../../packages/i18n/src/locales/zh-CN/index.ts";
import { tr } from "../../../packages/i18n/src/locales/tr/index.ts";
import { ko } from "../../../packages/i18n/src/locales/ko/index.ts";

const catalogs = { en, "zh-CN": zhCN, tr, ko };

const here = dirname(fileURLToPath(import.meta.url));
const desktopRoot = join(here, "..");
const repoRoot = join(desktopRoot, "../..");

const runtimeSrc = readFileSync(join(desktopRoot, "electron/main/plugin-runtime.ts"), "utf8");
const panelSrc = readFileSync(join(desktopRoot, "electron/main/plugin-panel-host.ts"), "utf8");
const mainSrc = readMainSourceSync();
const pageSrc = readPluginsSourceSync();
const protocolSrc = readFileSync(join(repoRoot, "packages/shared/src/protocol.ts"), "utf8");
const ompMarketIpcSrc = readMainModuleSync("ipc/omp-market-ipc.ts");
const catalogSliceSrc = readStoreModuleSync("slices/catalog-slice.ts");
const registrySrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins/registry.rs"), "utf8");
const marketplaceSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins/marketplace.rs"), "utf8");
const validationSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins/validation.rs"), "utf8");
const installSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins/install.rs"), "utf8");
const modelSrc = readFileSync(join(repoRoot, "crates/host-core/src/plugins/model.rs"), "utf8");

test("plugin runtime exposes gated high-risk host APIs", () => {
  for (const token of [
    "fs.write",
    "fs.delete",
    "fs.openDefault",
    "fs.reveal",
    "net.fetch",
    "agent.complete",
    "desktop.control",
    "session.read",
    "models.list",
    "shell.openExternal",
    "clipboard.read",
    "clipboard.write",
    "assertPermission",
  ]) {
    assert.match(runtimeSrc, new RegExp(token.replaceAll(".", "\\.")));
  }
});

test("large-file host reads stay behind the fs.read gateway", () => {
  for (const api of ["fs.stat", "fs.readRange", "fs.registerDropped"]) {
    assert.match(runtimeSrc, new RegExp(`\\"${api}\\"`));
  }
  assert.match(runtimeSrc, /MAX_FS_READ_RANGE_BYTES/);
  assert.match(runtimeSrc, /dropped-file grants are read-only/);
  assert.match(runtimeSrc, /new Map\(\)/);
});

test("native plugin notifications stay behind the existing notify permission", () => {
  for (const channel of [
    "ui.getNotificationPermission",
    "ui.requestNotificationPermission",
    "ui.showNativeNotification",
  ]) {
    assert.match(runtimeSrc, new RegExp(`\\"${channel}\\"`));
  }
  assert.match(runtimeSrc, /getNotificationPermission: async \(\) => \{/);
  assert.match(runtimeSrc, /requestNotificationPermission: async \(\) => \{/);
  assert.match(runtimeSrc, /showNativeNotification: async \(input/);
  assert.match(runtimeSrc, /this\.assertPermission\(loaded, "notify"\)/);
});

test("workspace deletion and panel operations stay bounded", () => {
  assert.match(runtimeSrc, /PANEL_SKILL_CHANNELS/);
  assert.match(runtimeSrc, /method: "panel.invoke"/);
  assert.match(runtimeSrc, /"fs.remove"/);
  assert.match(runtimeSrc, /recursive: false/);
  assert.match(runtimeSrc, /cannot remove the root itself/);
  // Deleting goes to the OS trash, so a delete this gate got wrong is still
  // recoverable; `rmSync` survives only as the fallback for a host that has no
  // trash to offer.
  assert.match(runtimeSrc, /this\.services\.trashItem\(full\)/);
  // A single-file remove in a loop empties a workspace as well as `rm -rf`;
  // the rolling window is what tells the two apart.
  assert.match(runtimeSrc, /MAX_DELETES_PER_WINDOW/);
});

test("the plugins page shows the file scope behind a file permission", () => {
  // A permission name says "may touch files"; only the scope says which ones,
  // so the row has to carry it or the user is approving a blank cheque.
  assert.match(pageSrc, /"fs\.write": "high"/);
  assert.match(pageSrc, /"fs\.read": "medium"/);
  assert.match(pageSrc, /function FsScopeChips\(/);
  assert.match(pageSrc, /t\("plugins\.fsAsksEachTime"\)/);
  assert.match(pageSrc, /t\("plugins\.legacyFsDowngraded"\)/);
  // The scope reaches the renderer from the registry, not from a second read
  // of the manifest, so an old record simply has no scope to show.
  assert.match(registrySrc, /fs: manifest\.fs\.clone\(\)/);
  for (const catalog of Object.values(catalogs)) {
    assert.equal(typeof catalog.plugins.legacyFsDowngraded, "string");
    assert.equal(typeof catalog.plugins.fsMode.delete, "string");
    assert.equal(typeof catalog.plugins.permissions["fs.delete"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["fs.delete"], "string");
    assert.equal(typeof catalog.plugins.permissions["agent.complete"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["session.read"], "string");
    assert.equal(typeof catalog.plugins.permissions["models.list"], "string");
    assert.equal(typeof catalog.plugins.permissions["ui.microphone"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["ui.microphone"], "string");
    assert.equal(typeof catalog.plugins.permissions["desktop.control"], "string");
    assert.equal(typeof catalog.plugins.permissionHelp["desktop.control"], "string");
  }
});

test("plugin panels use sandboxed isolated host windows", () => {
  assert.match(panelSrc, /session\.fromPartition/);
  assert.match(panelSrc, /sandbox:\s*true/);
  assert.match(panelSrc, /nodeIntegration:\s*false/);
  assert.match(panelSrc, /plugin-panel\.js/);
  assert.match(panelSrc, /allowMicrophone/);
  assert.match(runtimeSrc, /this\.assertPermission\(loaded, "desktop\.control"\)/);
  assert.match(runtimeSrc, /desktop\.listOperations/);
  assert.match(runtimeSrc, /desktop\.invoke/);
});

test("the plugins page marketplace tab drives the OMP marketplace (ADR 0333)", () => {
  assert.match(pageSrc, /tabMarket/);
  assert.match(pageSrc, /api\.ompMarketInstall\(/);
  assert.match(pageSrc, /api\.ompMarketUpgrade\(/);
  assert.match(pageSrc, /api\.ompMarketSetEnabled\(/);
  // The PI catalog, its downloads and its update flow are no longer reachable.
  assert.doesNotMatch(pageSrc, /api\.market[A-Z]|grantedPermissions: pendingInstall/);
  assert.match(ompMarketIpcSrc, /IPC\.invoke\.ompMarketInstall, \(id\) => changed\("ompMarket\.install", marketplace\.install\(id\)\)/);
});

test("plugins page re-reads installed plugins when it opens", () => {
  assert.match(pageSrc, /useEffect\(\(\) => \{\s*void refreshPlugins\(\);\s*\}, \[refreshPlugins\]\)/);
  assert.match(
    catalogSliceSrc,
    /const existing = catalogRuntime\.getPluginRefresh\(\);\s*if \(existing\) return existing/,
  );
});

test("shared protocol declares the OMP marketplace and package install IPC", () => {
  for (const channel of [
    "pluginInstallFromPackage",
    "ompMarketState",
    "ompMarketAddSource",
    "ompMarketRemoveSource",
    "ompMarketUpdateSources",
    "ompMarketInstall",
    "ompMarketUninstall",
    "ompMarketSetEnabled",
    "ompMarketUpgrade",
    "pluginOpenPanel",
    "pluginSetAutoUpdate",
  ]) {
    assert.match(protocolSrc, new RegExp(channel));
  }
  for (const retired of ["marketSearch", "marketInstall", "marketCheckUpdates", "marketApplyUpdates", "marketRefresh", "marketGetDetail", "marketCancelInstall"]) {
    assert.doesNotMatch(protocolSrc, new RegExp(`\\b${retired}:`));
  }
});

// A publisher can list a version before uploading its package. The host then
// refuses the download, so the UI must not offer an install that can only end
// in PLUGIN_MARKET_INVALID.
// The host-core catalog still serves the bundled plugins (ADR 0241) after the
// PI marketplace UI was retired (ADR 0333), so its install rules stay guarded.
test("host-core blocks install for a catalog version with no published package", () => {
  const hostSrc = marketplaceSrc;
  assert.match(hostSrc, /fn has_package_metadata\(version: &MarketVersion\) -> bool/);
  // `installable` is the single answer every install affordance reads, so it
  // has to cover every reason the host would refuse the download: no package
  // yet, a host too old for the version, or a package URL off the allowlist.
  assert.match(hostSrc, /installable: latest_version\s*\n\s*\.map\(\|version\| \{/);
  assert.match(hostSrc, /has_package_metadata\(version\)\s*\n\s*&& host_supports_version\(version\)/);
  assert.match(hostSrc, /package_host_allowed\(&version\.url, &catalog_url\)\.is_ok\(\)/);
});

// Plugin source now lives in publisher repositories, so a package URL is no
// longer guaranteed to sit under one repository the project controls. The
// download boundary is what keeps a catalog entry from aiming a request
// anywhere it likes.
test("marketplace package downloads stay inside the host allowlist", () => {
  const hostSrc = validationSrc + "\n" + installSrc;
  assert.match(
    hostSrc,
    /const PACKAGE_HOST_ALLOWLIST: &\[&str\] = &\["github\.com", "githubusercontent\.com", "cnb\.cool"\]/,
  );
  assert.match(hostSrc, /fn package_host_allowed\(package_url: &str, catalog_url: &str\) -> Result<\(\)>/);
  // Refuse before the request leaves the machine, then hold the redirect
  // chain to the same rule: a release asset always redirects. Every package
  // URL passes through this one path, whichever channel named it — the
  // official channel's mirror list included.
  assert.match(hostSrc, /package_host_allowed\(url, &catalog_url\)\?;/);
  // The observed downloader is the same boundary: it refuses an off-allowlist
  // host before the request and re-checks the effective URL after redirects.
  assert.match(
    hostSrc,
    /download_url_observed\(\s*url,\s*Some\(&catalog_url\),\s*expected_size,\s*report\)/,
  );
  assert.match(hostSrc, /"--proto-redir"\.into\(\)/);
  assert.match(hostSrc, /"%\{url_effective\}"\.into\(\)/);
  assert.match(hostSrc, /must not embed credentials/);
});

// A withdrawn version is a distribution signal, not permission to disable
// software somebody is relying on.
test("host-core never offers a withdrawn version and never silently disables it", () => {
  const hostSrc = marketplaceSrc + "\n" + modelSrc;
  assert.match(hostSrc, /\.filter\(\|version\| !version\.yanked\)/);
  assert.match(hostSrc, /PLUGIN_MARKET_YANKED/);
  assert.match(hostSrc, /PLUGIN_HOST_TOO_OLD/);
  assert.match(hostSrc, /pub struct PluginYankNotice/);

});

// The verified shield is a claim about a publisher, so it must come from the
// center rather than from text a publisher can write.
test("host-core verified trust is not something a catalog entry can grant itself", () => {
  const hostSrc = marketplaceSrc;
  assert.match(hostSrc, /fn resolve_trust\(&self, entry: &MarketCatalogEntry\) -> String/);
  assert.match(hostSrc, /"verified" if self\.is_trusted_channel\(\) => "verified"/);
  assert.match(hostSrc, /"verified" => "community"/);

});
