import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Flatten upload-artifact's common-root layout without silently overwriting files. */
export function stageReleaseInputs(source, destination, version) {
  source = resolve(source); destination = resolve(destination);
  assert(/^\d+\.\d+\.\d+$/.test(version), "stable version required");
  assert(destination !== source && !destination.startsWith(source + sep), "separate staging directory required");
  assert(!existsSync(destination) || readdirSync(destination).length === 0, "staging directory must be empty");
  const files = [], names = new Set();
  function visit(directory) {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry), stat = lstatSync(path);
      assert(!stat.isSymbolicLink(), "linked release input refused");
      if (stat.isDirectory()) { visit(path); continue; }
      assert(stat.isFile(), "regular release input required");
      let name = entry;
      const deb = /^omp-desktop_(\d+\.\d+\.\d+)_(?:amd64|x64)\.deb$/.exec(entry);
      if (deb) {
        assert.equal(deb[1], version, "stale Debian installer");
        name = `OMP-Desktop-${version}-x64.deb`;
      }
      const feed = /^latest(?:-linux|-mac(?:-arm64|-x64)?)?\.yml$/.test(name);
      assert(feed || /^(?:OMP-Desktop-|omp-desktop-)/.test(name), `unexpected release input: ${name}`);
      assert(feed || name.includes(`-${version}`), `stale release input: ${name}`);
      assert(!names.has(name), `duplicate release basename: ${name}`); names.add(name);
      files.push({ input: relative(source, path).split(sep).join("/"), name, bytes: stat.size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    }
  }
  visit(source); assert(files.length, "release inputs are empty");
  mkdirSync(destination, { recursive: true });
  for (const file of files) copyFileSync(join(source, file.input), join(destination, file.name));
  const renamed = new Map(files.filter(file => basename(file.input) !== file.name).map(file => [basename(file.input), file.name]));
  const linux = files.find(file => file.name === "latest-linux.yml");
  if (renamed.size && linux) {
    // The publisher copies this module outside the checkout before selecting
    // the accepted source. Its installed YAML dependency stays in app/.
    let yaml;
    try { yaml = createRequire(import.meta.url)("yaml"); }
    catch { yaml = createRequire(resolve(process.cwd(), "package.json"))("yaml"); }
    const path = join(destination, linux.name), feed = yaml.parse(readFileSync(path, "utf8"));
    assert(feed && feed.version === version && Array.isArray(feed.files), "valid Linux feed required for renamed installers");
    let references = 0;
    for (const file of feed.files) {
      if (renamed.has(file?.url)) { file.url = renamed.get(file.url); references++; }
    }
    if (renamed.has(feed.path)) { feed.path = renamed.get(feed.path); references++; }
    if (references) {
      // Only names change. The strict release validator still checks every
      // declared SHA512/size against the original installer bytes afterwards.
      const bytes = Buffer.from(yaml.stringify(feed)); writeFileSync(path, bytes);
      linux.publishedSha256 = createHash("sha256").update(bytes).digest("hex");
      linux.publishedBytes = bytes.length; linux.renamedReferences = references;
    }
  }
  writeFileSync(join(destination, `omp-desktop-validation-${version}-staging.json`), JSON.stringify({ version, files }, null, 2) + "\n");
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination, version] = process.argv.slice(2);
  assert(source && destination && version, "usage: stage-release-inputs.mjs <downloaded-directory> <empty-staging-directory> <version>");
  console.log(`Staged ${stageReleaseInputs(source, destination, version).length} release files`);
}
