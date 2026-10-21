import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(new URL("../../.github/workflows/readback-published-release.yml", import.meta.url), "utf8"));
const script = workflow.jobs.readback.steps.find(step => step.id === "release").run;
const revision = "a".repeat(40);
for (const [tag, version] of [["v0.1.3", "0.1.3"], [`v0.1.2+skill.${revision}`, "0.1.2"], ["v0.1.3-extra", null]]) {
  test(`public readback binds its requested version: ${version ?? "invalid tag"}`, t => {
    const root = mkdtempSync(join(tmpdir(), "omp-readback-bind-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const envFile = join(root, "env"), outputFile = join(root, "output");
    writeFileSync(envFile, ""); writeFileSync(outputFile, "");
    const result = spawnSync("bash", ["-c", script], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
      env: { ...process.env, RELEASE_TAG: tag, RELEASE_REVISION: revision, GITHUB_ENV: envFile, GITHUB_OUTPUT: outputFile },
    });
    if (version) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(envFile, "utf8"), `RELEASE_VERSION=${version}\n`);
      assert.equal(readFileSync(outputFile, "utf8"), `version=${version}\n`);
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(envFile, "utf8"), "");
      assert.equal(readFileSync(outputFile, "utf8"), "");
    }
  });
}
