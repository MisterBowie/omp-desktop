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
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflowUrl = new URL("../../../../.github/workflows/three-platform-test-packages.yml", import.meta.url);
const manifest = JSON.parse(
  await readFile(new URL("../../../patches/oh-my-pi/manifest.json", import.meta.url), "utf8"),
);
const desktopPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/**
 * The pinned package manager, as this suite can actually invoke it.
 *
 * When the suite runs through `pnpm run test`, `npm_execpath` names pnpm's own
 * CLI entry, so the child is the same package manager the repository pins;
 * otherwise fall back to `pnpm` from PATH (a `node --test` run outside a pnpm
 * script still needs pnpm to build the product).
 */
function pnpmInvocation() {
  const execPath = process.env.npm_execpath;
  if (execPath && /pnpm/i.test(execPath)) {
    return { command: process.execPath, prefix: [execPath], shell: false };
  }
  return {
    command: process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    prefix: [],
    shell: process.platform === "win32",
  };
}

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

  assert.match(
    build,
    /working-directory: app\n[\s\S]{0,900}?run: pnpm --filter @pi-desktop\/desktop run \$\{\{ matrix\.dist \}\} --\$\{\{ matrix\.arch \}\}/,
    "the packaging step must run the product dist script from app/ and pass the matrix architecture directly",
  );
  // A standalone `--` would be forwarded by pnpm to the release entry, which
  // refuses it: the separator would hide the command line from electron-builder.
  assert.doesNotMatch(executableSource(build), / -- --/);
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

/**
 * The packaging step's argument boundary is a real pnpm invocation.
 *
 * `pnpm run <script> <args>` appends `<args>` to the end of the script command
 * line, and every `dist:*` chain ends in `scripts/release-package.mjs` — so the
 * architecture flag must be passed directly. A standalone `--` is forwarded to
 * the release entry as well, and the entry refuses it (the separator would hide
 * the rest of the command line from electron-builder); the first native CI run
 * failed exactly there (`... --publish never -- --x64`, exit 2).
 *
 * The static regex above pins the invocation text; this test executes it. A
 * fixture workspace outside the repository gives each `dist:*` script the real
 * tail flags read from the desktop package.json, on a two-command chain whose
 * end is a probe importing the production `parseReleaseArgs` from this
 * checkout. The matrix entries and the invocation template are read from the
 * workflow, so a re-added `--` makes the probed argv fail the production parser
 * instead of only a string match.
 */
test("the packaging invocation reaches the production parser for each matrix target", async (t) => {
  const source = await workflowSource(t);
  if (!source) return;
  const build = job(source, "build");

  const matrix = build.match(/^      matrix:\n[\s\S]*?^    runs-on:/m)?.[0];
  assert.ok(matrix, "the build job must declare its strategy matrix");
  const entries = matrix
    .split(/^ {10}- name: /m)
    .slice(1)
    .map((block) => {
      const field = (key) => block.match(new RegExp(`^ {12}${key}: (.+)$`, "m"))?.[1]?.trim();
      return {
        name: block.slice(0, block.indexOf("\n")).trim(),
        platform: field("platform"),
        arch: field("arch"),
        dist: field("dist"),
      };
    });
  for (const entry of entries) {
    assert.ok(entry.platform && entry.arch && entry.dist, `${entry.name}: the matrix entry must name platform, arch and dist`);
  }
  assert.deepEqual(
    entries.map((entry) => `${entry.platform}/${entry.arch}`).sort(),
    ["darwin/arm64", "linux/x64", "win32/x64"],
    "the fixture must cover exactly this matrix: macOS arm64, Windows x64, Linux x64",
  );

  const template = build.match(/^\s+run: (pnpm --filter @pi-desktop\/desktop run \$\{\{ matrix\.dist \}\}.*)$/m)?.[1];
  assert.ok(template, "the packaging step must run the product dist script through pnpm");

  const parserUrl = new URL("../../../scripts/release-package.mjs", import.meta.url);
  const fixture = mkdtempSync(join(tmpdir(), "omp-pnpm-argv-"));
  try {
    const scripts = {};
    for (const { dist } of entries) {
      const chain = desktopPackage.scripts[dist];
      assert.ok(chain, `${dist} must exist in the desktop package.json`);
      const tail = chain.split("&&").at(-1).trim();
      const marker = tail.indexOf("scripts/release-package.mjs");
      assert.ok(marker >= 0, `${dist} must end in scripts/release-package.mjs`);
      const flags = tail.slice(marker + "scripts/release-package.mjs".length).trim();
      assert.match(flags, /^--platform /, `${dist} must declare its platform on the entry's command line`);
      scripts[dist] = `node noop.mjs && node probe.mjs ${flags}`;
    }
    writeFileSync(
      join(fixture, "package.json"),
      `${JSON.stringify({ name: "@pi-desktop/desktop", version: "0.0.0", private: true, scripts }, null, 2)}\n`,
    );
    writeFileSync(join(fixture, "noop.mjs"), "process.exit(0);\n");
    writeFileSync(
      join(fixture, "probe.mjs"),
      [
        `import { parseReleaseArgs } from ${JSON.stringify(parserUrl.href)};`,
        "const argv = process.argv.slice(2);",
        "try {",
        '  console.log(`ARGV-PROBE ${JSON.stringify({ argv, parsed: parseReleaseArgs(argv) })}`);',
        "} catch (error) {",
        '  console.error(`ARGV-FAIL ${JSON.stringify({ argv, error: error.message })}`);',
        "  process.exit(2);",
        "}",
        "",
      ].join("\n"),
    );

    const pnpm = pnpmInvocation();
    for (const { name, platform, arch, dist } of entries) {
      const rendered = template
        .replace("${{ matrix.dist }}", dist)
        .replace("${{ matrix.arch }}", arch)
        .split(/\s+/);
      assert.equal(rendered[0], "pnpm", `${name}: the packaging step must invoke pnpm`);
      const args = rendered.slice(1);

      const packed = spawnSync(pnpm.command, [...pnpm.prefix, ...args], {
        cwd: fixture,
        encoding: "utf8",
        shell: pnpm.shell,
      });
      assert.equal(
        packed.status,
        0,
        `${name}: pnpm ${dist} --${arch} must reach the release entry with a usable target\n${packed.stdout}${packed.stderr}`,
      );
      const probeLine = packed.stdout.match(/^ARGV-PROBE (.*)$/m)?.[1];
      assert.ok(
        probeLine,
        `${name}: the probe must report the production parser result\n${packed.stdout}${packed.stderr}`,
      );
      const probed = JSON.parse(probeLine);
      assert.deepEqual(
        probed.parsed,
        { platform, arch, dir: false, publish: "never", forwarded: [] },
        `${name}: the entry must resolve exactly this one target`,
      );
      // Each owned axis is declared exactly once on the command line the entry saw.
      assert.equal(probed.argv.filter((arg) => arg === "--platform").length, 1, `${name}: one platform declaration`);
      assert.equal(probed.argv.filter((arg) => arg === "--publish").length, 1, `${name}: one publish declaration`);
      assert.equal(probed.argv.filter((arg) => arg === `--${arch}`).length, 1, `${name}: one architecture declaration`);
      assert.ok(!probed.argv.includes("--"), `${name}: a standalone -- must never reach the entry`);

      // Negative control: inserting the old standalone `--` before the
      // architecture flag stays a production refusal, with the exact message.
      const legacy = [...pnpm.prefix, ...args.slice(0, -1), "--", args.at(-1)];
      const refused = spawnSync(pnpm.command, legacy, { cwd: fixture, encoding: "utf8", shell: pnpm.shell });
      assert.equal(refused.status, 2, `${name}: the old -- form must stay a refusal\n${refused.stdout}${refused.stderr}`);
      const failedLine = refused.stderr.match(/^ARGV-FAIL (.*)$/m)?.[1];
      assert.ok(
        failedLine,
        `${name}: the refusal must come from the release entry\n${refused.stdout}${refused.stderr}`,
      );
      const failed = JSON.parse(failedLine);
      assert.deepEqual(failed.argv.slice(-2), ["--", `--${arch}`], `${name}: pnpm must forward the separator verbatim`);
      assert.equal(
        failed.error,
        'the release entry does not support "--": it would hide the rest of the command line from electron-builder',
      );
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
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

test("a refused package fails the lane and its diagnosis stays uploadable", async (t) => {
  const source = await workflowSource(t);
  if (!source) return;
  const build = job(source, "build");

  const acceptance = build.slice(
    build.indexOf("name: Verify the packaged runtime from an isolated copy"),
    build.indexOf("name: Run the packaged Plan/Goal regression"),
  );
  assert.ok(acceptance.length > 0, "the acceptance step must sit inside the build job");

  // The isolated root is published before the verifier can refuse, so the
  // failure path can still reach the reports it collects.
  const published = acceptance.indexOf('echo "iso=$iso" >> "$GITHUB_OUTPUT"');
  const verified = acceptance.indexOf("node scripts/verify-packaged-runtime.mjs");
  assert.ok(published >= 0, "the acceptance step must publish the isolated root");
  assert.ok(verified > published, "iso must be published before the verifier can fail");

  // A refused package must keep its non-zero exit code (no `|| true` around
  // the verifier, no green-washing; the step's earlier `ls ... || true` is a
  // diagnostic for the missing-Resources branch, not the verifier), and the
  // verifier's stderr plus exit status are preserved inside the isolated root
  // where the failure artifact uploads.
  const verifierTail = acceptance.slice(verified);
  assert.doesNotMatch(verifierTail, /\|\|/, "the verifier must not be masked");
  assert.doesNotMatch(build, /continue-on-error/);
  assert.match(
    acceptance,
    /set \+e\n\s+node scripts\/verify-packaged-runtime\.mjs[^\n]*2> "\$iso\/packaged-runtime\.stderr\.txt"\n\s+verify_status=\$\?\n\s+set -e/,
  );
  assert.match(acceptance, /exit "\$verify_status"/);

  const failure = build.slice(build.indexOf("name: Report diagnostics when a step failed"));
  assert.match(failure, /if: failure\(\) && steps\.acceptance\.outputs\.iso != ''/);
  assert.match(failure, /packaged-runtime\.stderr\.txt/);
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
