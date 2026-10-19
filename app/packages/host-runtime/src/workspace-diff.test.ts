import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { collectWorkspaceDiff } from "./workspace-diff.js";

it("reads tracked and untracked patches without executing a Git textconv helper", async () => {
  const root = await mkdtemp(join(tmpdir(), "omp-diff-textconv-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  try {
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Fixture");
    git("config", "user.email", "fixture@example.invalid");
    git("config", "commit.gpgsign", "false");
    const hooks = join(root, ".git", "empty-hooks");
    await mkdir(hooks);
    git("config", "core.hooksPath", hooks);
    await writeFile(join(root, ".gitattributes"), "*.txt diff=fixture\n");
    await writeFile(join(root, "tracked.txt"), "before\n");
    const helper = join(root, ".git", "converter.cjs");
    const marker = join(root, ".git", "converter-ran");
    await writeFile(helper, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(marker)},'ran');process.stdout.write(fs.readFileSync(process.argv[2]));\n`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    git("config", "diff.fixture.textconv", `${quote(process.execPath)} ${quote(helper)}`);
    git("add", "tracked.txt", ".gitattributes");
    git("commit", "-qm", "baseline");
    await writeFile(join(root, "tracked.txt"), "after\n");
    await writeFile(join(root, "new.txt"), "new content\n");
    const diff = await collectWorkspaceDiff(root);
    expect(diff.repo).toBe(true);
    expect(diff.files.map((file) => file.path)).toEqual(["new.txt", "tracked.txt"]);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(diff)).toContain("new content");
    expect(JSON.stringify(diff)).toContain("after");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
