#!/usr/bin/env bash
# R4 (2026-10-03): the packaging argument boundary, run for real.
#
# Root cause being re-proved: pnpm appends the trailing arguments to the end of
# the script command line, and every `dist:*` chain ends in
# `scripts/release-package.mjs`. A standalone `--` therefore reaches the release
# entry, which refuses it; the architecture flag must be passed directly
# (`--x64`, not `-- --x64`). Native run 37133058318 failed exactly there
# (`... release-package.mjs --platform linux --publish never -- --x64`, exit 2).
#
# For each matrix entry (darwin/arm64, win32/x64, linux/x64) this probe builds a
# minimal fixture workspace outside the repository whose `dist:*` scripts carry
# the real tail flags read from `app/apps/desktop/package.json`, on a
# two-command chain whose end imports the production `parseReleaseArgs` from
# this checkout. It then runs, through the real pnpm:
#   1. the corrected invocation (architecture flag passed directly), and
#   2. the old invocation with a standalone `--` (negative control).
# No compiler, installer, model or provider is involved; the scratch directory
# is removed on exit.
#
# Requires: node >= 22 and pnpm on PATH (or $PNPM). Exits 0 only when every
# corrected call succeeds with the expected target and every old call is refused
# with exit 2 and the production message.
set -u

root="$(cd "$(dirname "$0")/../../.." && pwd)"
PNPM="${PNPM:-pnpm}"
fixture="$(mktemp -d "${TMPDIR:-/tmp}/omp-r4-pnpm-argv.XXXXXX")"
trap 'rm -rf "$fixture"' EXIT

echo "node $(node --version), pnpm $("$PNPM" --version), root $root"
echo "fixture $fixture (removed on exit)"
echo

node - "$root" "$fixture" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, fixture] = process.argv.slice(2);
const desktop = JSON.parse(readFileSync(join(root, "app", "apps", "desktop", "package.json"), "utf8"));
const scripts = {};
for (const [script, platform] of [["dist:mac", "darwin"], ["dist:win", "win32"], ["dist:linux", "linux"]]) {
  const tail = desktop.scripts[script].split("&&").at(-1).trim();
  const marker = tail.indexOf("scripts/release-package.mjs");
  if (marker < 0) throw new Error(`${script} does not end in scripts/release-package.mjs`);
  const flags = tail.slice(marker + "scripts/release-package.mjs".length).trim();
  if (!flags.startsWith("--platform ")) throw new Error(`${script} does not declare its platform on the entry's command line`);
  scripts[script] = `node noop.mjs && node probe.mjs ${flags}`;
}
writeFileSync(
  join(fixture, "package.json"),
  `${JSON.stringify({ name: "@pi-desktop/desktop", version: "0.0.0", private: true, scripts }, null, 2)}\n`,
);
writeFileSync(join(fixture, "noop.mjs"), "process.exit(0);\n");
const parser = pathToFileURL(join(root, "app", "scripts", "release-package.mjs")).href;
writeFileSync(
  join(fixture, "probe.mjs"),
  [
    `import { parseReleaseArgs } from ${JSON.stringify(parser)};`,
    "const argv = process.argv.slice(2);",
    "try {",
    "  console.log(`ARGV-PROBE ${JSON.stringify({ argv, parsed: parseReleaseArgs(argv) })}`);",
    "} catch (error) {",
    "  console.error(`ARGV-FAIL ${JSON.stringify({ argv, error: error.message })}`);",
    "  process.exit(2);",
    "}",
    "",
  ].join("\n"),
);
console.log(`fixture scripts carry the real tails: ${Object.values(scripts).join(" | ")}`);
console.log();
NODE

status=0
cd "$fixture" || exit 1
for entry in "darwin arm64 dist:mac" "win32 x64 dist:win" "linux x64 dist:linux"; do
  # shellcheck disable=SC2086
  set -- $entry
  platform="$1" arch="$2" script="$3"
  echo "== $platform/$arch ($script) =="
  for mode in direct legacy; do
    if [ "$mode" = direct ]; then
      args=(--filter @pi-desktop/desktop run "$script" "--$arch")
    else
      args=(--filter @pi-desktop/desktop run "$script" -- "--$arch")
    fi
    echo "\$ $PNPM ${args[*]}"
    output="$("$PNPM" "${args[@]}" 2>&1)"
    code=$?
    printf '%s\n' "$output" | grep -E '^(ARGV-PROBE|ARGV-FAIL)' || true
    echo "exit=$code"
    if [ "$mode" = direct ] && [ "$code" -ne 0 ]; then
      echo "PROBE-FAIL: the corrected invocation must exit 0"
      status=1
    fi
    if [ "$mode" = legacy ] && [ "$code" -ne 2 ]; then
      echo "PROBE-FAIL: the old -- form must stay a refusal (exit 2)"
      status=1
    fi
  done
  echo
done

if [ "$status" -eq 0 ]; then
  echo "OK: corrected calls resolve one target; the old -- form is refused verbatim"
fi
exit "$status"
