# M5/T20-D-Enter evidence index

Raw logs and fixtures behind `docs/validation/M5-t20-d-mode-entry.md`.

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
