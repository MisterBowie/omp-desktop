import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readInstalledPackageMetadata } from "../../../scripts/e2e/installed-product.mjs";
const require = createRequire(new URL("../package.json", import.meta.url));
const builder = createRequire(require.resolve("electron-builder/package.json"));
const lib = createRequire(builder.resolve("app-builder-lib/package.json"));
const { createPackage } = lib("@electron/asar");

test("installed metadata follows an actual archive replaced at the same path", async () => {
  const root = mkdtempSync(join(tmpdir(), "omp-installed-archive-"));
  try {
    const resources = join(root, "resources"); mkdirSync(resources);
    const archive = join(resources, "app.asar");
    for (const [name, version, padding] of [["baseline", "0.15.2", 100_000], ["current", "0.15.3-m7.1", 1000], ["rollback", "0.15.2", 10_000]]) {
      const source = join(root, name); mkdirSync(source);
      writeFileSync(join(source, "000-padding.txt"), "x".repeat(padding));
      writeFileSync(join(source, "package.json"), JSON.stringify({ name: "omp-desktop", version }));
      await createPackage(source, archive);
      assert.deepEqual(readInstalledPackageMetadata(resources), { name: "omp-desktop", version });
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
