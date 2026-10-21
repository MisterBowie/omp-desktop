#!/usr/bin/env node
/** Build-only memory candidate. It deliberately cannot produce release provenance. */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bunBinary } from "./omp-patch.mjs";
const app = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const descriptorPath = join(app, "patches/oh-my-pi/memory-candidate.json");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${(result.stderr || result.stdout || result.error || "").toString().slice(-2000)}`,
    );
  return result.stdout.trimEnd();
}
export function validateMemorySnapshot(source, descriptor) {
  for (const file of descriptor.files) {
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes(".."))
      throw new Error("Invalid memory snapshot path");
    if (sha(readFileSync(join(source, file.path))) !== file.sha256)
      throw new Error(`Memory snapshot differs: ${file.path}`);
  }
}
export function checkMemoryCandidate(source) {
  const descriptor = JSON.parse(readFileSync(descriptorPath, "utf8"));
  const patch = join(dirname(descriptorPath), descriptor.patch.file);
  if (sha(readFileSync(patch)) !== descriptor.patch.sha256) throw new Error("Memory patch digest differs");
  const promoted = descriptor.promotedForkCommit;
  if (run("git", ["rev-parse", "HEAD"], source) !== (promoted ?? descriptor.baseForkCommit))
    throw new Error("Memory candidate requires its exact controlled fork base");
  validateMemorySnapshot(source, descriptor);
  run("git", ["apply", "--check", "--reverse", patch], source);
  const status = run("git", ["status", "--porcelain", "--untracked-files=all"], source);
  if (promoted && status) throw new Error("Promoted memory checkout must be clean");
  const changed = (promoted
    ? run("git", ["diff", "--name-only", descriptor.baseForkCommit, promoted], source)
    : status)
    .split("\n")
    .filter(Boolean)
    .map((line) => (promoted ? line : line.slice(3)))
    .sort();
  if (JSON.stringify(changed) !== JSON.stringify(descriptor.files.map((file) => file.path).sort()))
    throw new Error("Unexpected native candidate changes");
  return descriptor;
}
async function main() {
  const args = process.argv.slice(2);
  const value = (name) => {
    const index = args.indexOf(name);
    return index < 0 ? null : args[index + 1];
  };
  for (let i = 0; i < args.length; i++) {
    if (["--source", "--out"].includes(args[i])) {
      if (!args[++i]) throw new Error("Missing option value");
    } else if (!["--check", "--build"].includes(args[i])) throw new Error("Unknown memory candidate option");
  }
  if (!value("--source")) throw new Error("--source is required");
  const source = resolve(value("--source"));
  const descriptor = checkMemoryCandidate(source);
  if (!args.includes("--build")) {
    console.log(JSON.stringify({ ok: true, schema: descriptor.schema, release: false }));
    return;
  }
  const out = resolve(value("--out") ?? join(app, ".artifacts/omp-memory-native"));
  mkdirSync(out, { recursive: true });
  const bun = bunBinary();
  run(bun, ["scripts/build-binary.ts", "--bytecode"], join(source, "packages/coding-agent"));
  checkMemoryCandidate(source);
  const binary = join(out, process.platform === "win32" ? "omp.exe" : "omp");
  copyFileSync(
    join(source, "packages/coding-agent/dist", process.platform === "win32" ? "omp.exe" : "omp"),
    binary,
  );
  chmodSync(binary, 0o700);
  run(
    bun,
    [
      "build",
      "omp-desktop-gate.ts",
      "--target=bun",
      "--format=esm",
      "--outfile",
      join(out, "omp-desktop-gate.js"),
    ],
    join(app, "packages/omp-runtime/extensions"),
  );
  const receipt = {
    schema: descriptor.schema,
    release: false,
    baseForkCommit: descriptor.baseForkCommit,
    patchSha256: descriptor.patch.sha256,
    binarySha256: sha(readFileSync(binary)),
    gateSha256: sha(readFileSync(join(out, "omp-desktop-gate.js"))),
  };
  writeFileSync(join(out, "candidate.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, ...receipt }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
