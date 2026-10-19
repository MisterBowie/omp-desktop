import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** A same-version release gets its own immutable source-bound build tag. */
export function publicationTag({ tag, revision, sameVersionRevision = false }) {
  assert(typeof revision === "string" && revision.length === 40 && /^[a-f0-9]{40}$/.test(revision), "fixed source revision required");
  assert.equal(typeof sameVersionRevision, "boolean");
  const pattern = sameVersionRevision
    ? /^v(\d+\.\d+\.\d+)\+skill\.([a-f0-9]{40})$/
    : /^v(\d+\.\d+\.\d+)$/;
  const match = pattern.exec(tag);
  assert(match, "invalid publication tag");
  assert.equal(match[0], tag, "complete publication tag required");
  if (sameVersionRevision) assert.equal(match[2], revision, "revision tag source mismatch");
  return { version: match[1], tag, stableTag: `v${match[1]}`, sameVersionRevision };
}

/** Only public immutable asset fields enter the protected-release receipt. */
export function stableReleaseSnapshot(tag, revision, release) {
  assert(/^v\d+\.\d+\.\d+$/.test(tag));
  assert(typeof revision === "string" && revision.length === 40 && /^[a-f0-9]{40}$/.test(revision));
  assert.equal(release.tag_name, tag);
  assert.equal(release.draft, false); assert.equal(release.prerelease, false);
  assert(Number.isSafeInteger(release.id) && release.id > 0);
  assert(Array.isArray(release.assets) && release.assets.length > 0);
  const assets = release.assets.map(asset => {
    assert(/^[A-Za-z0-9._-]{1,160}$/.test(asset.name));
    assert(Number.isSafeInteger(asset.id) && asset.id > 0);
    assert(Number.isSafeInteger(asset.size) && asset.size > 0);
    assert(/^sha256:[a-f0-9]{64}$/.test(asset.digest));
    return { name: asset.name, id: asset.id, bytes: asset.size, digest: asset.digest };
  }).sort((a, b) => a.name.localeCompare(b.name));
  assert.equal(new Set(assets.map(a => a.name)).size, assets.length);
  assert.equal(new Set(assets.map(a => a.id)).size, assets.length);
  return { tag, sourceRevision: revision, releaseId: release.id, assets };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [tag, revision, flag] = process.argv.slice(2);
  assert(["true", "false"].includes(flag), "explicit revision flag required");
  console.log(JSON.stringify(publicationTag({ tag, revision, sameVersionRevision: flag === "true" })));
}
