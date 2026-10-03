# M5/T20-D-Enter evidence index

Raw logs and fixtures behind `docs/validation/M5-t20-d-mode-entry.md`.

## First independent review repair (2026-10-03)

| Path | What it is |
| --- | --- |
| `repair-20261003-scripts/root-original-sha256.txt` | SHA-256 of the root's four review scripts exactly as received (`/tmp/omp-t20-d-enter-repair-root-20261003/`). |
| `repair-20261003-scripts/red/`, `green/` | The local copies used for the reproduction runs, adapted **only** in repo/output/host-binary paths (root expectations untouched); the two variants differ only in the output directory. `SHA256SUMS.txt` in each directory. |
| `repair-20261003-red/` | Raw RED reproductions of the review findings on `f56fe838` (before the fix): the three script JSONs + consoles, plus the three new product E2E regressions failing against the pre-fix source. |
| `repair-20261003-green/` | Post-fix runs: the three script JSONs + consoles, `plan-submit-e2e.txt` (13/13), `desktop-affected.txt` (164/164), the omp-runtime vitest log (499 pass/6 skip), `mode-entry-unit.txt`, `model-entry-flow-f56fe838.console.txt`, `build-js.txt`, `typecheck.txt`, `lint.txt`, `sidecar-build.txt` (rebuilt gate bundle), `packaged-runtime.txt`. |
| `repair-20261003-corrections/turn-status-expectation.json` | Reviewer-expectation correction: the durable turn vocabulary is `running | completed | aborted | error`; requesting `"failed"` over `session.endTurn` stores `completed`, so the failed post-commit transition settles as the host's `error` terminal. |
| `repair-20261003-corrections/turn-status-probe.mjs` / `.txt` | The probe that drives the real host binary and reads `turns.status` back, plus its captured output. |

Two raw node logs (`repair-20261003-green/runtime-vitest.txt.gz`,
`repair-20261003-red/product-e2e-prefix-red.txt.gz`) are stored as
**deterministic gzip** (`gzip -n -9`): their raw bytes contain trailing
whitespace / a blank line at EOF that `git diff --check` rejects, and gzip
preserves the capture byte-for-byte on decode (`gzip -dc`). The `SHA256SUMS`
entries hash the stored `.gz` files.

The `entry-failure-boundary-f56fe838.json` `passed` flag in the green run is
false solely because the original script asserts the unrepresentable
`'failed'` status (the `failures` arrays name that one assertion; provider
count, side effects and recovery all pass). See the correction record above.

| File | What it is |
| --- | --- |
| `baseline-probe.json` | RED capture on baseline `2d96fa1e8bf3848021d1f265c0a258a9c455ef4c`: the Agent catalogue without `EnterPlanMode`/`EnterGoalMode`, the trusted extension API surface without a live system-prompt action, and a mid-turn `setActiveTools(["read"])` that narrows the next provider request while the system prompt stays unchanged. Real fixed patched runtime + real host + FakeProvider + a trusted probe extension. |
| `baseline-probe.mjs.txt`, `baseline-probe-gate.ts.txt` | The (non-product) probe driver and probe extension, verbatim, so the capture can be reproduced. |
| `green-e2e-full.txt` | `node --test apps/desktop/test/omp-plan-submit-e2e.test.mjs` — 7 accepted T20-B2 cases + 3 T20-D-Enter cases, 10 passed / 0 failed. |
| `green-runtime-vitest.txt` | `pnpm --filter @pi-desktop/omp-runtime test` (gate/transition/runner units, including the 11 new gate transition cases and the record codec). |
| `green-desktop-units.txt` | The affected desktop node:test suites (mode-entry unit, submit unit, host-tool adapter/bridge, skill-path adapter, plugin plan-safe, sidecar, patch, plan-drain, session failclosed). |
| `green-build-js.txt` | `pnpm build:js` (product `app/`). |
| `green-typecheck.txt` | `pnpm typecheck` (product `app/`). |
| `green-lint.txt` | `pnpm lint` (product `app/`). |
| `green-sidecar-check.txt` | `node scripts/omp-sidecar.mjs --check --source <fork>` — `OMP-SIDECAR-OK 62bc57b+omp-desktop.5`. |
| `green-sidecar-build.txt` | `node scripts/omp-sidecar.mjs --build --source <fork>` — real Linux x64 binary + rebuilt gate bundle + provenance `.5`. |
| `green-sidecar-smoke.txt` | `node scripts/verify-packaged-runtime.mjs --resources apps/desktop/resources` — production verifier: protocol v2 negotiated, `get_state` ok, gate-load control refused, minimal child PATH/isolated HOME, stopped+reaped+cleaned. |
| `SHA256SUMS.txt` | Hashes of the files above (this list and `SHA256SUMS.txt` itself excluded). |

Reproduce the baseline probe (from a clean extraction of the baseline commit,
with the pinned submodule linked and the workspace built):

```text
git archive 2d96fa1e8bf3848021d1f265c0a258a9c455ef4c | tar -x -C /tmp/omp-t20d-baseline
ln -s <repo>/upstream/oh-my-pi /tmp/omp-t20d-baseline/upstream/oh-my-pi
cd /tmp/omp-t20d-baseline/app && pnpm install --frozen-lockfile && pnpm build:js
cp <this dir>/baseline-probe.mjs.txt        apps/desktop/test/zz-baseline-probe.mjs
cp <this dir>/baseline-probe-gate.ts.txt    apps/desktop/test/zz-baseline-probe-gate.ts
PI_DESKTOP_HOST_BIN=<app>/target/debug/pi-desktop-host-core \
  node apps/desktop/test/zz-baseline-probe.mjs
```

The probe writes its JSON to stdout (the file kept here) and removes its
scratch directories and the probe output file on exit. Nothing in it is
product code.
