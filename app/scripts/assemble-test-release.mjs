#!/usr/bin/env node
/**
 * Assemble the one prerelease for a three-platform test-package run (M5).
 *
 * The packaging workflow uploads one Actions artifact per platform, each
 * carrying that platform's payload and its `build-record.json`. This entry is
 * the single place that turns those three into a release:
 *
 *   1. it requires exactly the platform/architecture set the stage promises
 *      (macOS arm64, Windows x64, Linux x64) and refuses anything else — a
 *      missing or duplicated platform must fail the release, not shrink it;
 *   2. it re-checks every artifact against the run's own revision, version and
 *      the controlled patch manifest, and re-hashes every payload: the release
 *      may only carry bytes this run verified;
 *   3. it writes `SHA256SUMS.txt` fresh over the payload only — never over a
 *      previous checksum file, so a rerun cannot certify its own stale digest —
 *      and it writes the combined `BUILD-RECORD.json` and the release notes.
 *
 * `gh release create` runs afterwards in the workflow; this entry never
 * contacts GitHub, so it stays runnable (and testable) offline.
 *
 * Usage:
 *   node scripts/assemble-test-release.mjs \
 *     --input <downloaded artifacts root> --out <release directory> \
 *     --tag <m5-test-*> --revision <git sha> --version <product version> \
 *     --run-url <url> [--manifest <path>] [--json]
 *
 * Exit codes: 2 for a command-line/input-contract refusal, 1 for artifacts that
 * disagree with each other or with the manifest.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultManifest = join(appRoot, "patches", "oh-my-pi", "manifest.json");

/** The platform set one M5 test-package release must contain, exactly. */
export const EXPECTED_PLATFORMS = [
  { platform: "darwin", arch: "arm64", label: "macOS arm64" },
  { platform: "win32", arch: "x64", label: "Windows x64" },
  { platform: "linux", arch: "x64", label: "Linux x64" },
];

/** Payload-looking extensions; nothing else may appear in the release. */
const PAYLOAD_PATTERN = /\.(dmg|zip|exe|AppImage|deb|rpm)$/;

/** The checksum file, which must never describe itself. */
export const CHECKSUM_FILE = "SHA256SUMS.txt";

/** Names this entry owns inside the release directory. */
const OWNED_FILES = [CHECKSUM_FILE, "BUILD-RECORD.json", "RELEASE-NOTES.md"];

class AssemblyError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function refuse(message, exitCode = 2) {
  throw new AssemblyError(message, exitCode);
}

export function parseArgs(argv) {
  const options = { json: false, manifest: defaultManifest };
  const values = new Set([
    "--input",
    "--out",
    "--tag",
    "--revision",
    "--version",
    "--run-url",
    "--manifest",
    "--release-json",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (!values.has(arg)) refuse(`unknown argument: ${arg}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) refuse(`${arg} requires a value`);
    index += 1;
    options[arg.slice(2).replace(/-(.)/g, (_, c) => c.toUpperCase())] = value;
  }
  // `--release-json` switches the entry into verifying a published release
  // against the directory an earlier assembly wrote; it needs no artifacts.
  const required = options.releaseJson
    ? ["out", "tag", "revision"]
    : ["input", "out", "tag", "revision", "version", "runUrl"];
  for (const field of required) {
    if (!options[field]) refuse(`--${field.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  if (!options.tag.startsWith("m5-test-")) {
    refuse(`the release tag must be the m5-test-* tag that triggered the run; got ${options.tag}`);
  }
  return options;
}

/** SHA-256 of a file, read in bounded chunks. */
export function sha256OfFile(path) {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/** Every file below a directory, as paths relative to it, sorted. */
function walk(root, prefix = "") {
  const entries = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) entries.push(...walk(root, relative));
    else entries.push(relative);
  }
  return entries.sort();
}

/** Collect the per-platform build records the build jobs uploaded. */
export function collectRecords(input) {
  const records = [];
  for (const relative of walk(input)) {
    if (relative.endsWith("build-record.json")) {
      records.push({ path: join(input, relative), record: JSON.parse(readFileSync(join(input, relative), "utf8")) });
    }
  }
  if (records.length === 0) refuse(`no build-record.json under ${input}; the build jobs uploaded nothing to assemble`);

  const expected = EXPECTED_PLATFORMS.map(({ platform, arch }) => `${platform}/${arch}`).sort();
  const actual = records.map(({ record }) => `${record.platform}/${record.arch}`).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    refuse(
      `the release needs exactly ${expected.join(", ")}; the artifacts hold ${actual.join(", ") || "nothing"}`,
      1,
    );
  }
  const platforms = new Set();
  for (const { record } of records) {
    const key = `${record.platform}/${record.arch}`;
    if (platforms.has(key)) refuse(`two build records claim ${key}`, 1);
    platforms.add(key);
  }
  return records;
}

/** The pins and run identity every record must agree on. */
function assertRecordIdentity(record, manifest, options) {
  const fail = (message) => refuse(message, 1);
  if (record.revision !== options.revision) fail(`${record.platform}/${record.arch} was built from ${record.revision}, this run is ${options.revision}`);
  if (record.version !== options.version) fail(`${record.platform}/${record.arch} is version ${record.version}, this run is ${options.version}`);
  if (record.stage !== options.tag) fail(`${record.platform}/${record.arch} was packaged for ${record.stage}, this run is ${options.tag}`);
  if (record.pins?.patchLevel !== manifest.patchLevel) fail(`${record.platform}/${record.arch} pins patch level ${record.pins?.patchLevel}, the manifest is ${manifest.patchLevel}`);
  if (record.pins?.forkCommit !== manifest.fork.commit) fail(`${record.platform}/${record.arch} pins fork ${record.pins?.forkCommit}, the manifest is ${manifest.fork.commit}`);
  if (record.packagedRuntime?.provenance?.patchLevel !== manifest.patchLevel) {
    fail(`${record.platform}/${record.arch} carries a runtime at patch level ${record.packagedRuntime?.provenance?.patchLevel}, the manifest is ${manifest.patchLevel}`);
  }
  if (record.packagedRuntime?.acceptance?.stop?.reaped !== true) {
    fail(`${record.platform}/${record.arch} did not report a reaped packaged runtime`);
  }
}

/**
 * Assemble the release directory.
 *
 * Reruns are safe by construction: the checksum list is written over the
 * payload it just collected, so a previous `SHA256SUMS.txt` in the output
 * directory is removed first and never appears among its own entries.
 */
export function assembleRelease(options) {
  const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
  const input = resolve(options.input);
  if (!existsSync(input)) refuse(`the artifact input directory does not exist: ${input}`);
  const out = resolve(options.out);
  if (existsSync(out)) rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  const records = collectRecords(input);
  const payload = [];
  for (const { record, path } of records) {
    assertRecordIdentity(record, manifest, options);
    const recordDir = dirname(path);
    const referenced = new Set();
    for (const asset of record.assets ?? []) {
      const assetPath = join(recordDir, asset.name);
      if (!existsSync(assetPath)) refuse(`${record.platform}/${record.arch} declares ${asset.name}, which the artifact does not contain`, 1);
      const bytes = statSync(assetPath).size;
      const sha256 = sha256OfFile(assetPath);
      if (bytes !== asset.bytes || sha256 !== asset.sha256) {
        refuse(
          `${asset.name} does not match its record: on disk ${bytes} B/${sha256}, recorded ${asset.bytes} B/${asset.sha256}`,
          1,
        );
      }
      referenced.add(asset.name);
      payload.push({ ...asset, platform: record.platform, arch: record.arch, path: assetPath });
    }
    // Anything else in a platform artifact directory is either a record or a
    // stray: a stray payload would ship unverified, and a stray non-payload
    // would publish without being described.
    for (const relative of walk(recordDir)) {
      // `walk` joins with the host separator: split on both so the Windows lane
      // reads the same names as the POSIX ones.
      const name = relative.split(/[\\/]/).pop();
      if (referenced.has(name) || name === "build-record.json") continue;
      if (PAYLOAD_PATTERN.test(name)) refuse(`${name} is in the ${record.platform}/${record.arch} artifact but no record describes it`, 1);
      refuse(`${name} is in the ${record.platform}/${record.arch} artifact but this release only publishes its payload and record`, 1);
    }
  }

  payload.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const { name, path } of payload) copyFileSync(path, join(out, name));

  const checksum = payload.map(({ sha256, name }) => `${sha256}  ${name}`).join("\n");
  writeFileSync(join(out, CHECKSUM_FILE), `${checksum}\n`, "utf8");

  const combined = {
    schema: "omp-desktop.test-package-release/1",
    tag: options.tag,
    revision: options.revision,
    version: options.version,
    run: { url: options.runUrl },
    pins: {
      patchLevel: manifest.patchLevel,
      forkRepository: manifest.fork.repository,
      forkCommit: manifest.fork.commit,
      forkTree: manifest.fork.tree ?? null,
      baseSha: manifest.base.sha,
      baseVersion: manifest.base.version,
    },
    platforms: records
      .map(({ record }) => ({
        platform: record.platform,
        arch: record.arch,
        run: record.run,
        packagedRuntime: record.packagedRuntime,
        planGoalRegression: record.planGoalRegression,
        assets: (record.assets ?? []).map(({ name, bytes, sha256, kind }) => ({ name, kind, bytes, sha256 })),
      }))
      .sort((a, b) => (a.platform < b.platform ? -1 : 1)),
  };
  writeFileSync(join(out, "BUILD-RECORD.json"), `${JSON.stringify(combined, null, 2)}\n`, "utf8");
  writeFileSync(join(out, "RELEASE-NOTES.md"), releaseNotes(combined), "utf8");
  return combined;
}

/** The release description: what these files are, what was proven, what was not. */
export function releaseNotes(combined) {
  const platformLabel = (platform) =>
    ({ darwin: "macOS", win32: "Windows", linux: "Linux" })[platform] ?? platform;
  const lines = [
    `M5 test packages for macOS (Apple Silicon), Windows x64 and Linux x64.`,
    "",
    "These are **test packages, not a stable release**: they carry the M5 functionality the root has accepted, they are unsigned, and they publish no auto-update feeds. The previous `m5-preview` release is left untouched.",
    "",
    "## Build identity",
    "",
    "| Field | Value |",
    "| --- | --- |",
    `| Stage tag | \`${combined.tag}\` |`,
    `| Source revision | \`${combined.revision}\` |`,
    `| Product version | \`${combined.version}\` |`,
    `| Controlled patch level | \`${combined.pins.patchLevel}\` |`,
    `| Sidecar fork | \`${combined.pins.forkRepository}\` @ \`${combined.pins.forkCommit}\` |`,
    `| Upstream OMP base | \`${combined.pins.baseSha}\` (${combined.pins.baseVersion}) |`,
    `| Build run | ${combined.run.url} |`,
    "",
    "Every package was built and verified from that one revision by the `Three-platform test packages` workflow; the same revision binds this tag, the payloads and `BUILD-RECORD.json`.",
    "",
    "## Files",
    "",
    "| File | Platform | Bytes | SHA-256 |",
    "| --- | --- | --- | --- |",
  ];
  for (const platform of combined.platforms) {
    for (const asset of platform.assets) {
      lines.push(`| \`${asset.name}\` | ${platformLabel(platform.platform)} ${platform.arch} | ${asset.bytes} | \`${asset.sha256}\` |`);
    }
  }
  lines.push(
    "",
    `Checksums: \`${CHECKSUM_FILE}\` (payload only — it never lists itself). Machine-readable provenance, verification results and per-platform pass counts: \`BUILD-RECORD.json\`.`,
    "",
    "## What was verified per platform",
    "",
    "| Platform | Packaged runtime | Tool gate | Environment isolation | Plan/Goal regression |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const platform of combined.platforms) {
    const acceptance = platform.packagedRuntime?.acceptance ?? {};
    const regression = platform.planGoalRegression ?? {};
    // The verifier reads the child's environment only when the host exposes it
    // (`readChildEnvironment` returns null without /proc). The isolated launch
    // configuration is used either way, so the unobserved case must not be
    // written as if the child PATH/HOME had been asserted.
    const childEnvironment = acceptance.childEnvironmentReadable
      ? "child PATH/HOME asserted (child environment readable)"
      : "child env not observed (host does not expose /proc; isolated launch config used, PATH/HOME not asserted)";
    lines.push(
      `| ${platformLabel(platform.platform)} ${platform.arch} | omp/${platform.packagedRuntime?.provenance?.ompVersion ?? "?"}, protocol v${acceptance.protocolVersion ?? "?"}, \`get_state\` ok, stopped/reaped/cleaned ${acceptance.stop?.stopped}/${acceptance.stop?.reaped}/${acceptance.stop?.cleaned} | missing-gate refusal verified (\`${acceptance.gateLoadControl}\`) | ${childEnvironment} | ${regression.pass ?? 0} passed, ${regression.fail ?? 0} failed, ${regression.skipped ?? 0} skipped |`,
    );
  }
  lines.push(
    "",
    "The packaged-runtime acceptance ran the *packaged* `Resources` — copied first to a path with spaces and non-ASCII characters, under its own HOME/XDG/TMPDIR — through the production verifier, launcher, tool gate and supervisor. The isolated launch configuration is used on every platform; where the host does not expose the child environment (no `/proc`), the table records the child PATH/HOME as not observed instead of claiming they were verified. The Plan/Goal regression ran the same real suite the source tree runs, but against the packaged sidecar and the packaged gate bundle.",
    "",
    "## Signing and update policy",
    "",
    "- macOS: **unsigned and not notarized** (no Developer ID). First launch may need the quarantine removal described in the ZIP's `OMP-Desktop-macOS-opening-help.txt` / `OMP-Desktop-macOS-open.command`.",
    "- Windows and Linux: unsigned test builds.",
    `- No \`latest*.yml\` updater feeds and no blockmaps are attached, and this release is not marked "latest", so it cannot become an update source for an installed build.`,
    "",
    "## Scope",
    "",
    "- Proven by this release: the M5 functionality accepted at the revision above, packaged and started on each platform (runtime identity, protocol v2, tool-gate loading, process reclamation, Plan/Goal gate/bridge paths inside the package).",
    "- Not proven by this release: installer/shortcut/desktop-entry behaviour inside a real user session (T22/T23), signing/notarization, macOS Intel, Windows ARM64, and the full T21/T22/T23/T24 scope. macOS and Windows runs come from native GitHub runners; the reports for each platform are in `BUILD-RECORD.json` and in the workflow's Actions artifacts.",
    "- Cursor + Plan/Goal remains unsupported and refused (ADR 0306).",
    "",
    "## 中文摘要",
    "",
    "本 Release 为 M5 阶段测试包（macOS Apple Silicon、Windows x64、Linux x64），未签名、不含自动更新 feed、不设为 latest，旧 `m5-preview` 不受影响。所有平台来自同一已验收提交（见上表），每个包都经过包内生产运行时验收与 Plan/Goal 包内回归；逐平台结果与摘要见 `BUILD-RECORD.json` 与 `SHA256SUMS.txt`。安装身份已改为 OMP Desktop，可与 PI-Desktop 并存。",
    "",
  );
  return lines.join("\n");
}

/**
 * Verify the live release against the assembled directory.
 *
 * `gh release view --json` is the only source here: if the published asset set,
 * its sizes, the tag and the prerelease/latest flags do not match what this
 * run assembled, the delivery is not what was verified and must be reported
 * instead of announced.
 */
export function verifyPublishedRelease(releaseView, options) {
  const fail = (message) => refuse(message, 1);
  if (releaseView.tagName !== options.tag) fail(`the live release is on ${releaseView.tagName}, expected ${options.tag}`);
  if (releaseView.isPrerelease !== true) fail("the live release is not a prerelease");
  if (releaseView.isDraft === true) fail("the live release is still a draft");
  if (releaseView.isLatest === true) fail("the live release is marked latest; a test package must not become the update target");
  const live = (releaseView.assets ?? []).map((asset) => ({ name: asset.name, size: asset.size, url: asset.url ?? "" }));
  const expected = readdirSync(options.out)
    .filter((entry) => entry !== "RELEASE-NOTES.md")
    .sort();
  const names = live.map((asset) => asset.name).sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    fail(`the live release carries ${names.join(", ")}; this run assembled ${expected.join(", ")}`);
  }
  for (const asset of live) {
    const local = statSync(join(options.out, asset.name)).size;
    if (asset.size !== local) fail(`${asset.name} is ${asset.size} B on the release, ${local} B in the assembled directory`);
    if (asset.url.length > 0 && !asset.url.includes(`/releases/download/${options.tag}/`)) {
      fail(`${asset.name} has a download URL outside the ${options.tag} release: ${asset.url}`);
    }
    if (/^latest.*\.yml$/.test(asset.name) || /\.blockmap$/.test(asset.name)) {
      fail(`${asset.name} would publish an updater feed from a test package`);
    }
  }
  if (!names.includes(CHECKSUM_FILE)) fail(`the release has no ${CHECKSUM_FILE}`);
  return { tag: options.tag, revision: options.revision, assets: live.length };
}

function formatSummary(combined, out) {
  const lines = [`TEST-RELEASE-ASSEMBLED ${combined.tag} from ${combined.revision}`, `  version : ${combined.version}`, `  pins    : ${combined.pins.patchLevel}, fork ${combined.pins.forkCommit}`];
  for (const platform of combined.platforms) {
    lines.push(`  platform: ${platform.platform}/${platform.arch} — ${platform.assets.length} asset(s)`);
  }
  lines.push(`  output  : ${out} (${[...OWNED_FILES].join(", ")})`);
  return lines.join("\n");
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`TEST-RELEASE-ASSEMBLE-FAIL ${error.message}`);
    return error.exitCode ?? 2;
  }
  try {
    if (options.releaseJson) {
      const view = JSON.parse(readFileSync(options.releaseJson, "utf8"));
      const result = verifyPublishedRelease(view, options);
      console.log(
        options.json ? JSON.stringify(result) : `TEST-RELEASE-VERIFIED ${result.tag} — ${result.assets} asset(s) at ${result.revision}`,
      );
      return 0;
    }
    const combined = assembleRelease(options);
    console.log(options.json ? JSON.stringify(combined) : formatSummary(combined, resolve(options.out)));
    return 0;
  } catch (error) {
    console.error(`TEST-RELEASE-ASSEMBLE-FAIL ${error?.message ?? error}`);
    return error?.exitCode ?? 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
