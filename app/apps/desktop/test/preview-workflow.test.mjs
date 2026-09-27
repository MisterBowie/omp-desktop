/**
 * The repository-level preview workflow must package through the product's own
 * release entry (M5/T20-R4B, ADR 0307).
 *
 * GitHub only reads the workflows at the repository root, and this repository
 * keeps the product source under `app/`. So the workflow that actually runs for
 * this repository is `.github/workflows/mac-preview-package.yml`, and it has to
 * obey the same rule as every other packaging lane: the bundled sidecar is
 * built and verified from the controlled fork by `dist:mac` /
 * `scripts/release-package.mjs` *before* electron-builder runs, never injected
 * afterwards from a downloaded upstream binary.
 *
 * The file does not exist when `app/` is checked out as its own repository
 * (upstream PI-Desktop layout), so this test skips there; the rule it encodes is
 * about this repository's layout.
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const previewUrl = new URL("../../../../.github/workflows/mac-preview-package.yml", import.meta.url);
const manifestUrl = new URL("../../../patches/oh-my-pi/manifest.json", import.meta.url);

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

async function previewSource(t) {
  try {
    await access(previewUrl);
  } catch {
    t.skip("this checkout has no repository-level preview workflow (upstream layout)");
    return null;
  }
  return readFile(previewUrl, "utf8");
}

test("the preview packages through the product release entry, not an injected binary", async (t) => {
  const source = await previewSource(t);
  if (!source) return;
  const manifest = JSON.parse(await readFile(manifestUrl, "utf8"));

  // The sidecar comes from the controlled fork at the pinned commit...
  assert.match(source, new RegExp(`repository: ${escapeRegExp(new URL(manifest.fork.repository).pathname.replace(/^\//, ""))}`));
  assert.match(source, new RegExp(`ref: ${manifest.fork.commit}`));
  assert.match(source, /fetch-depth: 0/);
  assert.match(source, /uses: oven-sh\/setup-bun@v\d+/);
  assert.match(source, /bun-version: "1\.4\.\d+"/);
  assert.match(source, /working-directory: \.omp-sidecar-source\n\s+run: bun install --frozen-lockfile/);
  assert.match(source, /OMP_SIDECAR_SOURCE: \$\{\{ github\.workspace \}\}\/\.omp-sidecar-source/);

  // ...and the package is produced by the same entry every release uses.
  assert.match(
    source,
    /run: pnpm run dist:mac -- --arm64/,
    "the preview must package through the product's dist:mac entry",
  );

  // The superseded preview path is gone: no upstream release download, no
  // post-builder injection, no source-tree gate copy.
  assert.doesNotMatch(source, /can1357\/oh-my-pi/);
  assert.doesNotMatch(source, /v18\.2\.7/);
  assert.doesNotMatch(source, /gh release download/);
  assert.doesNotMatch(source, /omp-desktop-gate\.ts/);
  assert.doesNotMatch(source, /--prepackaged/);
  assert.doesNotMatch(source, /electron-builder --mac --dir/);

  // The unsigned preview keeps its purpose: renamed assets uploaded to the
  // `m5-preview` prerelease.
  assert.match(source, /OMP-Desktop-0\.15\.2-m5preview-mac-arm64\.dmg/);
  assert.match(source, /gh release upload m5-preview/);
  assert.match(source, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
});
