import assert from "node:assert/strict";
import test from "node:test";
import { publicationTag, stableReleaseSnapshot } from "./publication-tag.mjs";

const revision = "a".repeat(40);
const tag = `v0.1.2+skill.${revision}`;
test("ordinary stable publication still accepts only its plain version tag", () => {
  assert.equal(publicationTag({ tag: "v0.1.2", revision }).version, "0.1.2");
  assert.throws(() => publicationTag({ tag, revision }));
  assert.throws(() => publicationTag({ tag: "v0.1.2", revision, sameVersionRevision: true }));
});
test("same-version publication binds build metadata to the complete source revision", () => {
  assert.deepEqual(publicationTag({ tag, revision, sameVersionRevision: true }), {
    version: "0.1.2", tag, stableTag: "v0.1.2", sameVersionRevision: true,
  });
  assert.throws(() => publicationTag({ tag, revision: "b".repeat(40), sameVersionRevision: true }));
});
test("unsafe, abbreviated, prerelease and unrelated publication refs are refused", () => {
  for (const bad of ["v0.1.2+skill.aaaaaaa", "v0.1.2-beta.1", `v0.1.2+other.${revision}`, `refs/tags/${tag}`, tag + "/extra", tag + "\n"]) {
    assert.throws(() => publicationTag({ tag: bad, revision, sameVersionRevision: true }));
  }
  assert.throws(() => publicationTag({ tag, revision, sameVersionRevision: "true" }));
});
function release() {
  return { id: 1, tag_name: "v0.1.2", draft: false, prerelease: false, assets: [
    { id: 2, name: "b.zip", size: 2, digest: "sha256:" + "b".repeat(64) },
    { id: 3, name: "a.zip", size: 3, digest: "sha256:" + "c".repeat(64) },
  ] };
}
test("protected stable snapshots ignore ordering but detect changed tags and asset bytes", () => {
  const original = stableReleaseSnapshot("v0.1.2", revision, release());
  const reordered = release(); reordered.assets.reverse();
  assert.deepEqual(stableReleaseSnapshot("v0.1.2", revision, reordered), original);
  const changed = release(); changed.assets[0].digest = "sha256:" + "d".repeat(64);
  assert.notDeepEqual(stableReleaseSnapshot("v0.1.2", revision, changed), original);
  assert.notDeepEqual(stableReleaseSnapshot("v0.1.2", "b".repeat(40), release()), original);
});
test("incomplete, duplicate or non-public protected assets fail closed", () => {
  for (const change of [r => { r.draft = true; }, r => { r.prerelease = true; }, r => { r.assets = []; }, r => { r.assets[1] = r.assets[0]; }, r => { r.assets[0].digest = null; }, r => { r.assets[0].name = "../file"; }]) {
    const value = release(); change(value);
    assert.throws(() => stableReleaseSnapshot("v0.1.2", revision, value));
  }
});
