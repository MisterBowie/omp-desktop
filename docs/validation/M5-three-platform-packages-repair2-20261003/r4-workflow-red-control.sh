#!/usr/bin/env bash
# R4 red control (2026-10-03): the new execution test must catch a workflow
# regression to the old `-- --arch` spelling.
#
# The script re-inserts the standalone `--` into the packaging run line, runs
# only the execution test, requires it to fail with the production refusal
# message, then restores the file byte-identically (cmp-verified). It exits 0
# only for "failed for the right reason AND the file came back unchanged".
set -u

root="$(cd "$(dirname "$0")/../../.." && pwd)"
workflow="$root/.github/workflows/three-platform-test-packages.yml"
test="$root/app/apps/desktop/test/three-platform-package-workflow.test.mjs"
backup="$(mktemp "${TMPDIR:-/tmp}/omp-r4-workflow-red.XXXXXX")"
log="$(mktemp "${TMPDIR:-/tmp}/omp-r4-workflow-red-log.XXXXXX")"
cp "$workflow" "$backup"
trap 'cp "$backup" "$workflow"; rm -f "$backup" "$log"' EXIT

node - "$workflow" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const path = process.argv[2];
const source = readFileSync(path, "utf8");
const from = "run: pnpm --filter @pi-desktop/desktop run ${{ matrix.dist }} --${{ matrix.arch }}";
const to = "run: pnpm --filter @pi-desktop/desktop run ${{ matrix.dist }} -- --${{ matrix.arch }}";
if (!source.includes(from)) {
  console.error("RED setup: the corrected run line was not found");
  process.exit(3);
}
writeFileSync(path, source.replace(from, to));
console.log("RED setup: the workflow now passes a standalone -- again");
NODE
setup=$?

status=0
if [ "$setup" -ne 0 ]; then
  echo "RED CONTROL FAILED: could not stage the regression (exit $setup)"
  status=1
else
  (cd "$root/app" && node --test --test-name-pattern="reaches the production parser" \
    "apps/desktop/test/three-platform-package-workflow.test.mjs") > "$log" 2>&1
  red=$?
  cat "$log"
  echo "RED run exit=$red (expected: non-zero)"
  if [ "$red" -eq 0 ]; then
    echo "RED CONTROL FAILED: the execution test passed with the old -- spelling"
    status=1
  fi
  # The assertion's stdout embeds the probe's JSON, where `--` arrives escaped,
  # so match the refusal text around the quotes rather than a quoted literal.
  if ! grep -q 'must reach the release entry with a usable target' "$log"; then
    echo "RED CONTROL FAILED: the execution test did not fail on the packaging invocation"
    status=1
  fi
  if ! grep -q 'the release entry does not support' "$log"; then
    echo "RED CONTROL FAILED: the failure was not the production refusal"
    status=1
  fi
fi

cp "$backup" "$workflow"
if cmp -s "$workflow" "$backup"; then
  echo "restored: workflow byte-identical to the corrected version"
else
  echo "RED CONTROL FAILED: the workflow was not restored"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "OK: the old spelling is caught by the execution test; the file is restored"
fi
exit "$status"
