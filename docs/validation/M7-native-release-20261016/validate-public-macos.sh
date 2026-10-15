#!/bin/bash
set -euo pipefail
repo='/Users/vv/Documents/对话/omp-desktop-local-m7'
review='/Users/vv/Documents/对话/omp-local-m7-review-20261015'
cd "$repo/app"
expected='5c418433f360772714e899ead3609175655da488'
test "$(git rev-parse HEAD)" = "$expected"
test -z "$(git status --porcelain)"
export PATH='/Users/vv/Documents/对话/omp-local-toolchains/pnpm-10.34.5/bin:/Users/vv/.nvm/versions/node/v24.14.0/bin:/Users/vv/.cargo/bin:/Users/vv/.bun/bin:'"$PATH"
export OMP_E2E_PYTHON='/Users/vv/Documents/对话/omp-local-m6-review-20261015/python-e2e/bin/python'
installer="$review/public-macos-input/OMP-Desktop-0.15.3-m7.1-m7-test-20261015-46e7bf7-macos-arm64.dmg"
baseline='/Users/vv/Documents/对话/omp-local-m6-review-20261015/release-download/OMP-Desktop-0.15.2-m6-test-20261015-438b389-macos-arm64.dmg'
node scripts/e2e-installed-smoke.mjs "$installer" "$review/public-macos-installed" > "$review/public-installed.stdout.txt" 2> "$review/public-installed.stderr.txt"
node scripts/e2e-maintenance-smoke.mjs "$installer" "$review/public-macos-daily" > "$review/public-daily.stdout.txt" 2> "$review/public-daily.stderr.txt"
node scripts/e2e-maintenance-upgrade.mjs "$baseline" "$installer" "$review/public-macos-upgrade" > "$review/public-upgrade.stdout.txt" 2> "$review/public-upgrade.stderr.txt"
test "$(git rev-parse HEAD)" = "$expected"
test -z "$(git status --porcelain)"
