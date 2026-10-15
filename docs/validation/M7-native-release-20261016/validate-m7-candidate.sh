#!/bin/bash
set -euo pipefail
repo='/Users/vv/Documents/对话/omp-desktop-local-m7'
review='/Users/vv/Documents/对话/omp-local-m7-review-20261015'
cd "$repo"
candidate="$(git rev-parse HEAD)"
test -z "$(git status --porcelain)"
short="${candidate:0:7}"
planned_tag="m7-test-20261015-$short"
out="$review/candidate-$short"
mkdir -p "$out"
export PATH='/Users/vv/Documents/对话/omp-local-toolchains/pnpm-10.34.5/bin:/Users/vv/.nvm/versions/node/v24.14.0/bin:/Users/vv/.cargo/bin:/Users/vv/.bun/bin:'"$PATH"
export OMP_E2E_PYTHON='/Users/vv/Documents/对话/omp-local-m6-review-20261015/python-e2e/bin/python'
export OMP_SIDECAR_SOURCE='/Users/vv/Documents/对话/omp-runtime-fork'
phase='prepared'
update() {
  phase="$1"
  python3 - "$review" "$candidate" "$planned_tag" "$out" "$phase" <<'PY'
import json,sys
from pathlib import Path
r,c,t,o,p=sys.argv[1:];(Path(r)/'m7-active-state.json').write_text(json.dumps({'candidate':c,'plannedTag':t,'output':o,'phase':p,'mode':'same-candidate local qualification; not yet a native three-platform release'},ensure_ascii=False,indent=2)+'\n')
PY
}
finish() {
  code=$?
  if [[ "$code" != 0 ]]; then update "failed:$phase:$code"; fi
}
trap finish EXIT
cd "$repo/app"
update 'production Mac build'
HTTP_PROXY=http://127.0.0.1:7897 HTTPS_PROXY=http://127.0.0.1:7897 ELECTRON_GET_USE_PROXY=1 GLOBAL_AGENT_HTTP_PROXY=http://127.0.0.1:7897 GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:7897 NO_PROXY=127.0.0.1,localhost CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pi-desktop/desktop run dist:mac > "$out/dist-mac.txt" 2>&1
resources="$repo/app/apps/desktop/release/mac-arm64/OMP Desktop.app/Contents/Resources"
installer="$repo/app/apps/desktop/release/OMP-Desktop-0.15.3-m7.1-arm64.dmg"
update 'actual packaged runtime verification'
node scripts/verify-packaged-runtime.mjs --resources "$resources" --json > "$out/packaged-runtime.json" 2> "$out/packaged-runtime.stderr.txt"
update 'strict packaged PlanGoal'
OMP_E2E_PACKAGED_RESOURCES="$resources" node --test --test-reporter=tap apps/desktop/test/omp-plan-submit-e2e.test.mjs > "$out/plan-goal.txt" 2>&1
update 'M6 actual installed workflow'
node scripts/e2e-installed-smoke.mjs "$installer" "$out/installed" > "$out/installed.stdout.txt" 2> "$out/installed.stderr.txt"
update 'M7 actual daily workflow'
node scripts/e2e-maintenance-smoke.mjs "$installer" "$out/daily" > "$out/daily.stdout.txt" 2> "$out/daily.stderr.txt"
update 'M7 actual upgrade backup rollback'
node scripts/e2e-maintenance-upgrade.mjs '/Users/vv/Documents/对话/omp-local-m6-review-20261015/release-download/OMP-Desktop-0.15.2-m6-test-20261015-438b389-macos-arm64.dmg' "$installer" "$out/upgrade" > "$out/upgrade.stdout.txt" 2> "$out/upgrade.stderr.txt"
update 'production Mac staging with raw evidence'
node scripts/stage-test-package.mjs --platform darwin --arch arm64 --release-dir apps/desktop/release --resources "$resources" --verify-report "$out/packaged-runtime.json" --plan-goal-log "$out/plan-goal.txt" --installed-report "$out/installed/installed-smoke.json" --maintenance-report "$out/daily/maintenance-smoke.json" --upgrade-report "$out/upgrade/maintenance-upgrade.json" --out "$out/stage" --version '0.15.3-m7.1' --stage "$planned_tag" --revision "$candidate" --run-id local --run-attempt 1 --run-url "local://m7/$candidate" --json > "$out/staging.json" 2> "$out/staging.stderr.txt"
test "$(git rev-parse HEAD)" = "$candidate"
test -z "$(git status --porcelain)"
update 'local qualification passed; native three-platform run remains required'
