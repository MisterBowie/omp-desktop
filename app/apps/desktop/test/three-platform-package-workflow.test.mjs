/**
 * The repository-level three-platform packaging workflow (user goal #9).
 *
 * GitHub reads workflows only from the repository root, and this repository
 * keeps the product source under `app/`, so `.github/workflows/` holds the
 * pipelines that actually run. This one is the only lane that may publish a
 * macOS/Windows/Linux test package, which makes its contract worth pinning:
 *
 *   - one entry point (a controlled `m5-test-*` tag) and one revision (the
 *     tag's own commit), never the default branch and never "any tag";
 *   - three native runners with asserted platform/architecture, each building
 *     through the product's own `dist:*` entry so the sidecar preflight runs
 *     before electron-builder and `--publish never` stays in force;
 *   - the pinned OMP fork (repository/commit read from the patch manifest) with
 *     full history, frozen dependencies, its own Rust toolchain — and the
 *     desktop's stable toolchain kept separate;
 *   - the packaged `Resources` from *this* build verified by the production
 *     acceptance entry, in an isolated copy under its own HOME/XDG/TMPDIR;
 *   - the this-stage Plan/Goal regression run against those packaged artifacts;
 *   - a publish job that needs all three platforms, binds the release to the
 *     triggering tag, stays a prerelease, ships no updater feed, and never
 *     touches the older `m5-preview` release.
 *
 * The file does not exist when `app/` is checked out as its own repository
 * (upstream PI-Desktop layout), so these tests skip there.
 */
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const workflowUrl = new URL("../../../../.github/workflows/three-platform-test-packages.yml", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("../../../patches/oh-my-pi/manifest.json", import.meta.url), "utf8"),
);
const desktopPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

async function workflowSource(t) {
  try {
    await access(workflowUrl);
  } catch {
    t.skip("this checkout has no repository-level three-platform packaging workflow (upstream layout)");
    return null;
  }
  return readFile(workflowUrl, "utf8");
}

/**
 * The workflow without its full-line comments.
 *
 * The negative assertions ("no `workflow_dispatch`, no `--publish`, no
 * `m5-preview`") are about what the workflow *does*, and the file explains those
 * very refusals in prose; matching the prose would make them unfalsifiable.
 */
function executableSource(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

/** One job's block, so a step cannot satisfy a check from another job. */
function job(source, name) {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `the workflow must declare the ${name} job`);
  const block = [];
  for (let index = start; index < lines.length; index += 1) {
    if (index > start && /^(?: {2}\S|\S)/.test(lines[index])) break;
    block.push(lines[index]);
  }
  return block.join("\n");
}

test("the packaging lane runs from a controlled m5-test-* tag only", async (t) => {
  const source = await workflowSource(t);
  if (!source) return;

  assert.match(source, /^on:\n  push:\n    tags: \["m5-test-\*"\]\n/m);
  const executable = executableSource(source);
  // No manual dispatch: the button only exists on the default branch, which this
  // work must not write, and a branch dispatch would bind the release to no
  // reviewed revision. The tag push is the entry point.
  assert.doesNotMatch(executable, /workflow_dispatch/);
  assert.doesNotMatch(executable, /^\s+branches:/m, "a branch push must not start a package run");

  const guard = job(source, "guard");
  assert.match(guard, /\[\[ "\$\{GITHUB_EVENT_NAME\}" != "push" \|\| "\$\{GITHUB_REF\}" != refs\/tags\/m5-test-\* \]\]/);
  assert.match(guard, /git rev-parse "refs\/tags\/\$\{GITHUB_REF_NAME\}\^\{commit\}"/);
  assert.match(guard, /tag_commit" != "\$\{GITHUB_SHA\}"/);
  assert.match(guard, /echo "revision=\$\{GITHUB_SHA\}" >> "\$GITHUB_OUTPUT"/);
  // The pins the release advertises come from the product and the manifest.
  assert.match(guard, /app\/apps\/desktop\/package\.json/);
  assert.match(guard, /app\/patches\/oh-my-pi\/manifest\.json/);
});

test("the matrix is the three native platforms with asserted architectures", async (t) => {
  const source = await workflowSource(t);
  if (!source) return;
  const build = job(source, "build");

  for (const [name, os, platform, arch] of [
    ["macOS arm64", "macos-15", "darwin", "arm64"],
    ["Windows x64", "windows-latest", "win32", "x64"],
    ["Linux x64", "ubuntu-22.04", "linux", "x64"],
  ]) {
    assert.match(
      build,
      new RegExp(
        `name: ${escapeRegExp(name)}[\\s\\S]{0,400}?os: ${escapeRegExp(os)}[\\s\\S]{0,120}?platform: ${platform}[\\s\\S]{0,80}?arch: ${arch}`,
      ),
      `${name} must run on ${os} for ${platform}/${arch}`,
    );
  }
  assert.doesNotMatch(build, /macos-15-intel|arm64\)/);

  // The runner must be what the package claims: the OS-level check and the
  // runtime-level check both exist, and macOS stays arm64-only.
  assert.match(build, /machine="\$\(uname -m\)"/);
  assert.match(build, /\[\[ "\$machine" != "arm64" \]\]/);
  assert.match(build, /\[\[ "\$\{PROCESSOR_ARCHITECTURE:-\}" != "AMD64" \]\]/);
  assert.match(build, /\[\[ "\$machine" != "x86_64" \]\]/);
  assert.match(build, /process\.platform !== expectedPlatform \|\| process\.arch !== expectedArch/);
  assert.match(build, /\[\[ "\$\(git rev-parse HEAD\)" != "\$\{\{ needs\.guard\.outputs\.revision \}\}" \]\]/);

  // Ubuntu 22.04 is the glibc floor decision, and it is verified, not assumed.
  assert.match(build, /if: matrix\.platform == 'linux'[\s\S]{0,200}check-linux-host-glibc\.mjs/);
});

test("every build lane prepares the pinned fork and the two toolchains", async (t) => {
  const source = await workflowSource(t);
  if (!source) return;
  const build = job(source, "build");

  // Fork checkout: repository and commit come from the patch manifest.
  assert.match(build, new RegExp(`repository: ${escapeRegExp(new URL(manifest.fork.repository).pathname.replace(/^\//, ""))}`));
  assert.match(build, new RegExp(`ref: ${manifest.fork.commit}`));
  assert.match(build, /path: \.omp-sidecar-source/);
  assert.match(build, /fetch-depth: 0/);
  assert.match(build, /OMP_SIDECAR_SOURCE: \$\{\{ github\.workspace \}\}\/\.omp-sidecar-source/);
  assert.match(build, /working-directory: \.omp-sidecar-source\n\s+run: bun install --frozen-lockfile/);
  // A clean checkout has no host N-API addon; the fork's own setup step builds
  // it, and without it the Bun single-file compile cannot embed one.
  assert.match(build, /working-directory: \.omp-sidecar-source\n\s+run: bun run build:native/);
  assert.match(build, /uses: oven-sh\/setup-bun@v2[\s\S]{0,400}bun-version: "1\.4\.2"/);

  // The fork's nightly toolchain is installed from its own rust-toolchain.toml,
  // and the desktop's Rust toolchain stays the stable one its CI uses.
  assert.match(build, /rust-toolchain\.toml/);
  assert.match(build, /rustup toolchain install "\$channel" --profile default --no-self-update/);
  assert.match(build, /uses: dtolnay\/rust-toolchain@stable/);
  assert.doesNotMatch(build, /dtolnay\/rust-toolchain@nightly/);

  // Node and pnpm: the versions the product itself pins.
  assert.match(build, /uses: pnpm\/action-setup@v6[\s\S]{0,200}package_json_file: app\/package\.json/);
  assert.match(build, /node-version: 24/);
  assert.match(build, /cache-dependency-path: app\/pnpm-lock\.yaml/);
  assert.match(build, /pnpm install --frozen-lockfile/);
  assert.match(build, /cargo build --release --locked -p host-core/);
});

test("every build lane packages through the product entry with publish disabled", async (t) => {
  const source = await workflowSource(t);
  if (!source) return;
  const build = job(source, "build");

  assert.match(build, /working-directory: app\n[\s\S]{0,400}?run: pnpm --filter @pi-desktop\/desktop run \$\{\{ matrix\.dist \}\} -- --\$\{\{ matrix\.arch \}\}/);
  for (const script of ["dist", "dist:mac", "dist:win", "dist:linux"]) {
    assert.match(desktopPackage.scripts[script], /--publish never/, `${script} must pass --publish never`);
  }
  // The workflow itself must not re-declare a target, a config override or a
  // publish flag: those are the wrapper's owned axes.
  const executable = executableSource(source);
  assert.doesNotMatch(executable, /--publish/, "the release entry owns the publish axis");
  assert.doesNotMatch(executable, /--prepackaged|--projectDir/);
  assert.doesNotMatch(executable, /-c\.[a-zA-Z]/);
  // Unsigned test lane.
  assert.match(source, /CSC_IDENTITY_AUTO_DISCOVERY: "false"/);
  assert.doesNotMatch(source, /CSC_LINK|CSC_NAME|APPLE_ID/);
});

test("the packaged Resources are verified in isolation and then exercised in-package", async (t) => {
  const source = await workflowSource(t);
  if (!source) return;
  const build = job(source, "build");

  // The acceptance entry runs against the electron-builder output's Resources,
  // never against the source-tree resources directory.
  assert.match(build, /node scripts\/verify-packaged-runtime\.mjs --resources "\$iso\/Resources" --json/);
  assert.match(build, /resources: apps\/desktop\/release\/mac-arm64\/OMP Desktop\.app\/Contents\/Resources/);
  assert.match(build, /resources: apps\/desktop\/release\/win-unpacked\/resources/);
  assert.match(build, /resources: apps\/desktop\/release\/linux-unpacked\/resources/);
  assert.doesNotMatch(build, /--resources apps\/desktop\/resources/);

  // The verified tree is a copy outside the repository, on a path with spaces
  // and non-ASCII characters, with its own HOME/XDG/TMPDIR.
  assert.match(build, /omp-packages 隔离 with spaces-/);
  assert.match(build, /mkdtempSync\(join\(tmpdir\(\)/);
  assert.match(build, /export HOME="\$iso\/home"/);
  assert.match(build, /XDG_CONFIG_HOME="\$iso\/xdg-config"/);
  assert.match(build, /TMPDIR="\$iso\/tmp"/);
  assert.match(build, /cp -R "\$resources\/\." "\$iso\/Resources\/"/);

  // The this-stage regression drives the packaged sidecar and gate bundle.
  assert.match(build, /OMP_E2E_PACKAGED_RESOURCES: \$\{\{ steps\.acceptance\.outputs\.iso \}\}\/Resources/);
  assert.match(build, /node --test --test-reporter=tap apps\/desktop\/test\/omp-plan-submit-e2e\.test\.mjs/);
  assert.match(build, /tee "\$iso\/plan-goal\.txt"/);

  // Staging re-checks the package against the manifest before anything is
  // published, and both the package and the raw reports are uploaded.
  assert.match(build, /node scripts\/stage-test-package\.mjs/);
  assert.match(build, /--verify-report "\$iso\/packaged-runtime\.json"/);
  assert.match(build, /--plan-goal-log "\$iso\/plan-goal\.txt"/);
  assert.match(build, /--revision "\$\{\{ needs\.guard\.outputs\.revision \}\}"/);
  assert.match(build, /name: package-\$\{\{ matrix\.artifact \}\}/);
  assert.match(build, /name: reports-\$\{\{ matrix\.artifact \}\}/);
});

test("the release is one prerelease gated on all three platforms", async (t) => {
  const source = await workflowSource(t);
  if (!source) return;
  const publish = job(source, "publish");

  assert.match(publish, /needs: \[guard, build\]/);
  assert.match(publish, /if: github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/m5-test-'\)/);
  // Least privilege: the workflow default is read-only, and exactly one job
  // raises it to write (the publish job).
  assert.match(source, /^permissions:\n  contents: read\n/m, "the workflow default token stays read-only");
  assert.equal(source.match(/contents: write/g)?.length, 1, "only the publish job may write to the repository");
  assert.match(publish, /permissions:\n\s+contents: write/);

  assert.match(publish, /uses: actions\/download-artifact@v8[\s\S]{0,120}pattern: package-\*/);
  assert.match(publish, /node scripts\/assemble-test-release\.mjs/);
  assert.match(publish, /--tag "\$\{\{ github\.ref_name \}\}"/);
  assert.match(publish, /--revision "\$\{\{ github\.sha \}\}"/);

  // Publishing is explicitly bound to the existing tag and stays a prerelease.
  assert.match(publish, /gh release create "\$\{\{ github\.ref_name \}\}"/);
  assert.match(publish, /--verify-tag/);
  assert.match(publish, /--prerelease/);
  assert.doesNotMatch(publish, /--latest/);
  assert.doesNotMatch(publish, /--clobber/);

  // The older macOS preview release is not touched by this lane.
  assert.doesNotMatch(executableSource(source), /gh release (?:upload|edit|delete|create)[^\n]*m5-preview/);

  // What was published is verified: the live release against the assembled
  // directory, the latest-release flag, and every downloaded byte.
  assert.match(publish, /releases\/tags\/\$\{\{ github\.ref_name \}\}/);
  assert.match(publish, /releases\/latest/);
  assert.match(publish, /gh release download "\$\{\{ github\.ref_name \}\}"/);
  assert.match(publish, /sha256sum -c SHA256SUMS\.txt/);
  assert.match(publish, /--release-json/);
});
