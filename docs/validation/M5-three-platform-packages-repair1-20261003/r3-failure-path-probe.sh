#!/usr/bin/env bash
# R3 probe (2026-10-03): prove the acceptance step's committed failure path.
#
# The probe extracts the shell body of the "Verify the packaged runtime from an
# isolated copy" step from .github/workflows/three-platform-test-packages.yml,
# swaps the real verifier for a stub that fails the way the production verifier
# fails (PACKAGED-RUNTIME-FAIL on stderr, exit 1), and runs the body under bash
# with a fake GITHUB_OUTPUT. It checks the contract the workflow test pins:
#   - the failed step keeps a non-zero exit code (never turns green);
#   - the isolated root was published to GITHUB_OUTPUT before the failure, so
#     the failure artifact condition is reachable;
#   - the verifier stderr and exit status land in the file the failure
#     artifact uploads.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
workflow="${1:-$(cd "$here/../../.." && pwd)/.github/workflows/three-platform-test-packages.yml}"

work="$(mktemp -d)"
iso=""
cleanup() {
  if [[ -n "$iso" ]]; then rm -rf "$iso"; fi
  rm -rf "$work"
}
trap cleanup EXIT

resources="$work/resources"
mkdir -p "$resources"
printf 'fixture payload\n' > "$resources/fixture.txt"

stub="$work/stub-verifier.mjs"
cat > "$stub" <<'STUB'
console.error("PACKAGED-RUNTIME-FAIL the packaged runtime did not reach idle (phase starting)");
process.exit(1);
STUB

# Extract the step's run body (10-space indent inside the step) with node.
step_body="$(node - "$workflow" <<'NODE'
const fs = require("node:fs");
const lines = fs.readFileSync(process.argv[2], "utf8").split("\n");
const start = lines.findIndex((line) => line.trim() === "- name: Verify the packaged runtime from an isolated copy");
if (start < 0) { console.error("acceptance step not found"); process.exit(1); }
let runAt = -1;
for (let i = start + 1; i < lines.length; i += 1) {
  if (lines[i].trim() === "run: |") { runAt = i; break; }
  if (/^ {2}\S/.test(lines[i]) || /^ {6}- /.test(lines[i])) break;
}
if (runAt < 0) { console.error("run body not found"); process.exit(1); }
const body = [];
for (let i = runAt + 1; i < lines.length; i += 1) {
  const line = lines[i];
  if (line.trim() !== "" && !line.startsWith("          ")) break;
  body.push(line.startsWith("          ") ? line.slice(10) : "");
}
process.stdout.write(body.join("\n") + "\n");
NODE
)"

# Point the step at the fixture Resources and the failing stub; the redirects
# and the exit-status handling stay as committed.
body="$(printf '%s' "$step_body" | sed "s|\${{ matrix.resources }}|$resources|")"
body="$(printf '%s' "$body" | sed "s|node scripts/verify-packaged-runtime.mjs --resources \"\$iso/Resources\" --json|node \"$stub\" \"\$iso/Resources\"|")"
if [[ "$body" != *"$stub"* ]]; then
  echo "FAIL: the verifier command was not substituted"
  exit 1
fi
printf '%s\n' "$body" > "$work/step.sh"

set +e
GITHUB_OUTPUT="$work/github-output" bash "$work/step.sh" > "$work/step.stdout" 2> "$work/step.stderr"
status=$?
set -e

fail() { echo "FAIL: $1"; exit 1; }
[[ "$status" -ne 0 ]] || fail "the failing verifier turned the step green (exit 0)"
grep -q "^iso=" "$work/github-output" || fail "iso was not published before the verifier ran"
iso="$(sed -n 's/^iso=//p' "$work/github-output")"
[[ -d "$iso" ]] || fail "the published iso path does not exist: $iso"
[[ -s "$iso/packaged-runtime.stderr.txt" ]] || fail "no stderr diagnostics were preserved"
grep -q "PACKAGED-RUNTIME-FAIL" "$iso/packaged-runtime.stderr.txt" || fail "the verifier failure message is missing"
grep -q "verify-packaged-runtime exit status: 1" "$iso/packaged-runtime.stderr.txt" || fail "the exit status was not preserved"
[[ -f "$iso/packaged-runtime.json" ]] || fail "the report path the failure artifact uploads does not exist"
grep -q "PACKAGED-RUNTIME-FAIL" "$work/step.stderr" || fail "the step did not surface stderr"

echo "PASS: step exit=${status}; iso published before failure"
echo "PASS: packaged-runtime.stderr.txt -> $(tr '\n' ' ' < "$iso/packaged-runtime.stderr.txt" | sed 's/ *$//')"
