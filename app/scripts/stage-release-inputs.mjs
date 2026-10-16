import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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
      assert(feed || /^(?:OMP-Desktop-|omp-desktop-|pi-host-)/.test(name), `unexpected release input: ${name}`);
      assert(feed || name.includes(`-${version}`), `stale release input: ${name}`);
      assert(!names.has(name), `duplicate release basename: ${name}`); names.add(name);
      files.push({ input: relative(source, path).split(sep).join("/"), name, bytes: stat.size, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
    }
  }
  visit(source); assert(files.length, "release inputs are empty");
  mkdirSync(destination, { recursive: true });
  for (const file of files) copyFileSync(join(source, file.input), join(destination, file.name));
  writeFileSync(join(destination, `omp-desktop-validation-${version}-staging.json`), JSON.stringify({ version, files }, null, 2) + "\n");
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [source, destination, version] = process.argv.slice(2);
  assert(source && destination && version, "usage: stage-release-inputs.mjs <downloaded-directory> <empty-staging-directory> <version>");
  console.log(`Staged ${stageReleaseInputs(source, destination, version).length} immutable release files`);
}
