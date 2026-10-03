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

## Second independent review repair (2026-10-03)

The root's second review (candidate `171754dc`) found one remaining
production gap in the `before_agent_start` continuation and one
delivery-integrity defect in the first round's manifest; this round's
evidence:

| Path | What it is |
| --- | --- |
| `repair2-20261003-scripts/` | Local copies of the root's five review scripts, adapted **only** in repo/output/host-binary paths (assertions untouched), plus `root-original-sha256.txt` (the originals as received) and `evidence-integrity-check.mjs`, the manifest/totality/tracking verifier. `SHA256SUMS.txt` covers the directory except itself. |
| `repair2-20261003-red/` | RED on `171754dc` before the fix: `gate-continuation-generation-171754dc.json` (2/4 — the stale resolve returned the successor's cached prompt, the stale reject refused with the successor's token, retired its admission and aborted it) and `product-regressions-red.txt` (the five new registered-handler cases: 4 failed / 15 passed). |
| `repair2-20261003-green/` | Post-fix runs at repair commit `06c73aa2`: all five review scripts (`-06c73aa2.json` + console; 4/4, 5/5, 2/2, 6/6, 2/2), the product regressions (19/19), the full omp-runtime vitest, the affected desktop suites incl. the real E2Es (166/166), `build-js.txt`, `typecheck.txt`, `lint.txt`, `sidecar-check.txt`, `sidecar-build.txt` (rebuilt gate bundle 53025 B / `3dd09910…`), `packaged-runtime.txt` (production verifier + smoke). |
| `evidence-integrity-repair2-20261003.txt` | The verifier's JSON report: 10 manifests, 0 mismatches, both evidence trees exactly covered. Meta-evidence, outside the manifest coverage below. |

Two green logs (`runtime-vitest.txt.gz`, `product-regressions-green.txt.gz`)
are stored as deterministic `gzip -n -9` because their raw bytes end with a
blank line that `git diff --check` rejects; decoding reproduces the capture
byte-for-byte.

## Manifest coverage rule

Applied to both rounds and enforced by
`repair2-20261003-scripts/evidence-integrity-check.mjs`:

- Every per-directory `SHA256SUMS.txt` covers its own directory's files and
  excludes itself.
- The top-level `repair-20261003-SHA256SUMS.txt` and
  `repair2-20261003-SHA256SUMS.txt` each cover **every file under their own
  `repair*-20261003-*` tree except themselves**, including the per-directory
  manifests, so each covered tree is fully attested and every listed path is
  Git-tracked.
- Documentation outside those trees — this `README.md`, the meta
  `evidence-integrity-repair2-20261003.txt`, the pre-repair `SHA256SUMS.txt`
  and the baseline files it covers — is not part of the repair manifests'
  covered sets.
