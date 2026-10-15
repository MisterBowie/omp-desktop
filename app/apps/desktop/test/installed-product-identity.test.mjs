import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const { Packager } = builderRequire("app-builder-lib/out/packager.js");
const { AppInfo } = builderRequire("app-builder-lib/out/appInfo.js");
const desktopDir = fileURLToPath(new URL("..", import.meta.url));

test("installed metadata gives OMP its own updater cache through the real builder", async () => {
  // Load the production configuration: changing productName alone leaves the
  // inherited workspace name in the updater cache on every packaged platform.
  const packager = new Packager({ projectDir: desktopDir, publish: "never" });
  await packager.validateConfig();
  const appInfo = new AppInfo(packager, null);

  assert.equal(appInfo.updaterCacheDirName, "omp-desktop-updater");
  // Fixed PI-Desktop 0111e306 derives this cache from @pi-desktop/desktop.
  assert.notEqual(appInfo.updaterCacheDirName, "@pi-desktopdesktop-updater");
  assert.equal(packager.nodePackageName, "@pi-desktop/desktop");
  assert.equal(packager.metadata.name, "omp-desktop");
  assert.equal(appInfo.productName, "OMP Desktop");
  assert.equal(appInfo.id, "net.misterbowie.omp-desktop");
  assert.equal(appInfo.linuxPackageName, "omp-desktop");
  assert.deepEqual(packager.config.publish, [
    { provider: "github", owner: "MisterBowie", repo: "omp-desktop" },
  ]);
});
