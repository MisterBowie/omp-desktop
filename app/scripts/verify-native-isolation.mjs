#!/usr/bin/env node
/** Exercise the production environment policy with the native Node runtime. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { buildOmpRuntimeEnv } from "../packages/omp-runtime/src/isolation.ts";

const root = mkdtempSync(join(tmpdir(), "omp-native-home 中文 space ' -"));
const home = join(root, "runtime home");
const entries = [join(root, "owned bin"), join(root, "project tools")];
for (const path of [home, ...entries]) mkdirSync(path, { recursive: true });
try {
  const policy = buildOmpRuntimeEnv({
    home, codingAgentDir: join(home, ".omp"), launchDir: root, pathEntries: entries,
  });
  // The full absolute executable avoids masking a broken native PATH with the
  // launcher's shell. Only synthetic, non-secret identity fields are reported.
  const child = spawnSync(process.execPath, ["-e", `
    const os = require("node:os");
    console.log(JSON.stringify({home:os.homedir(),HOME:process.env.HOME,
      USERPROFILE:process.env.USERPROFILE,PATH:process.env.PATH,
      APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA,
      SystemRoot:process.env.SystemRoot,windir:process.env.windir}));
  `], { cwd: root, env: policy.env, encoding: "utf8", timeout: 15_000 });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  const observation = JSON.parse(child.stdout);
  console.log(JSON.stringify({ platform: process.platform, arch: process.arch, expectedHome: home, observation }));
  assert.equal(resolve(observation.home), resolve(home), "native homedir escaped the runtime HOME");
  assert.deepEqual(observation.PATH.split(delimiter), entries, "native PATH entries were corrupted");
  if (process.platform === "win32") {
    assert.equal(resolve(observation.USERPROFILE), resolve(home));
    assert.equal(observation.APPDATA, join(home, "AppData", "Roaming"));
    assert.equal(observation.LOCALAPPDATA, join(home, "AppData", "Local"));
    const systemRoot = Object.entries(process.env).find(([key]) => key.toUpperCase() === "SYSTEMROOT")?.[1];
    assert(systemRoot, "Windows runner has no SystemRoot");
    assert.equal(observation.SystemRoot, systemRoot, "native system DLL/tool lookup root was dropped");
    const defaults = buildOmpRuntimeEnv({
      home, codingAgentDir: join(home, ".omp"), launchDir: root,
      baseEnv: { ...process.env, PATH: "foreign-user-tools" },
    }).env.PATH.split(delimiter);
    assert(defaults.includes(join(systemRoot, "System32")) && defaults.includes(systemRoot));
    assert(!defaults.includes("foreign-user-tools"), "inherited user PATH escaped the closed system list");
  }
  console.log("Native runtime environment isolation passed.");
} catch (error) {
  const message = String(error.stack ?? error).slice(0, 5000)
    .replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  console.error(`::error title=Native runtime environment isolation::${message}`);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
