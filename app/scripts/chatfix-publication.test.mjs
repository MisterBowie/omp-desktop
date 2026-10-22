import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflow = parse(readFileSync(join(root, ".github/workflows/publish-chatfix-revision.yml"), "utf8"));
const script = workflow.jobs.bind.steps.find((step) => step.id === "bind").run;
const revision = "a".repeat(40);
const stable = "87894e73dbc85d65555d3bf61c7d84caa2245a8b";
for (const scenario of ["accepted", "retry", "changed stable tag", "changed stable release", "wrong repository", "wrong control tag"]) {
  test(`chat-fix publication controller: ${scenario}`, (t) => {
    const scratch = mkdtempSync(join(tmpdir(), "omp-chatfix-control-"));
    t.after(() => rmSync(scratch, { recursive: true, force: true }));
    const output = join(scratch, "output");
    writeFileSync(output, "");
    const gh = join(scratch, "gh");
    writeFileSync(gh, `#!${process.execPath}\nconst route=process.argv[3];if(route.endsWith('/actions/runs/123'))console.log(${JSON.stringify(revision)});else if(route.endsWith('/commits/v0.1.4'))console.log(${JSON.stringify(scenario === "changed stable tag" ? "b".repeat(40) : stable)});else if(route.endsWith('/releases/tags/v0.1.4'))console.log(${scenario === "changed stable release" ? 1 : 419670366});else process.exit(1);\n`);
    chmodSync(gh, 0o755);
    const ref = scenario === "wrong control tag" ? "publish-chatfix-v0.1.3-run-123" :
      `publish-chatfix-v0.1.4-run-123${scenario === "retry" ? "-attempt-2" : ""}`;
    const result = spawnSync("bash", ["-c", script], { cwd: root, encoding: "utf8", env: {
      ...process.env, PATH: [scratch, dirname(process.execPath), process.env.PATH].join(":"),
      GITHUB_REPOSITORY: scenario === "wrong repository" ? "other/repository" : "MisterBowie/omp-desktop",
      GITHUB_REF_NAME: ref, GITHUB_OUTPUT: output,
    } });
    if (["accepted", "retry"].includes(scenario)) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(output, "utf8"), `revision=${revision}\nrun=123\ntag=v0.1.4+chatfix.${revision}\n`);
    } else {
      assert.notEqual(result.status, 0);
      assert.equal(readFileSync(output, "utf8"), "", "a refused controller cannot dispatch publication");
    }
  });
}
