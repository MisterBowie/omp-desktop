# mac-review: independent-review macOS arm64 captures (M6/T21-A, 2026-10-01)

Byte-for-byte archive of the evidence an independent reviewer produced on a real
macOS arm64 host (uploaded as `/tmp/omp-t21-mac-review-evidence-20261001/`).
Every file here is an unmodified copy except `sidecar-smoke.txt`, whose exact
bytes live in `sidecar-smoke.txt.gz` (see below); `diff -r` against the source
directory reports no differences for the rest.

These are **review-side measurements**, not results of this Linux workspace: the
unsigned/unpacked `pack`, the `.app` boot harness and the 15/15 regression all
ran on the reviewer's machine. Nothing here changes the local record's "not
done" list (no installer, no signing/notarization, no OMP chat/tool UI).

## What was measured (from `review-inventory.json`)

- Tested desktop commit `bec20b21…`, latest acceptance commit `6ee99ecb…`;
  `platform darwin`, `arch arm64`; `installerBuilt`/`codeSigned`/`notarized`
  all `false`.
- `Bec20b21` `pack` output: `release/mac-arm64/OMP Desktop.app`
  (`pack-bec20b21.txt`), copied with `ditto` to
  `/private/tmp/omp-t21 Mac 打包验收/OMP Desktop.app`.
- Artifact digests: `Contents/Resources/omp-runtime/omp` 216435968 B /
  `501cc225…`, gate 9897 B / `89c2d844…`, provenance 1141 B / `2d4896a1…`,
  `app.asar` 20495298 B / `e6173140…`, host-core 10591088 B / `96371560…`.
- `sidecar-build.txt` is that artifact's provenance (schema `/3`, darwin/arm64).
  `sidecar-smoke.txt` is the bundled-smoke run (**9 passed**); the reviewer's
  first attempt used an upstream `node_modules` symlink with an empty native
  archive (7 pass / 2 fail) — that binary was discarded as an environment error.
- `acceptance-unpacked-bec20b21.json` and `acceptance-staged-6ee99ecb.json` are
  exit-0 acceptance runs (`gateLoadControl: refused`, `stopped/reaped/cleaned`,
  `leftoverRuns 0`); macOS has no `/proc`, so `child.readable` is `false` — that
  is the host's default branch, not an OS-level child-environment proof.
- `regression-6ee99ecb.txt`: `OMP_T21_RESOURCES=<real Resources> node --test
  test/packaged-runtime-verify.test.mjs` → 15 passed / 0 failed / 0 skipped.
- `packaged-boot-harness.mjs` + `packaged-boot.txt`: a temporary reviewer
  harness (based on PI's `scripts/e2e-electron-boot.mjs`) that starts the
  packaged `OMP Desktop.app/Contents/MacOS/OMP Desktop` with argv `[]`, a
  throwaway profile outside the repository, an empty PATH and no renderer URL.
  It is a Pi/default-host IPC boot proof (0.15.2 / protocol 11 / 6 menus, 800
  sessions refresh, `projectRemove` boundary), **not** an OMP conversation/tool
  smoke, and the harness keeps the reviewer's absolute paths — it is evidence,
  not a cross-platform product entry point.

## Raw bytes and digests

| File | Bytes | SHA-256 (raw bytes) |
| --- | --- | --- |
| `acceptance-staged-6ee99ecb.json` | 971 | `7ff23b24cbbd5aca71c5d6f88d6bd81e55367004071f75ff467803fb073ad2f6` |
| `acceptance-staged-bec20b21.json` | 971 | `7ff23b24cbbd5aca71c5d6f88d6bd81e55367004071f75ff467803fb073ad2f6` |
| `acceptance-unpacked-bec20b21.json` | 1121 | `ce0436d64b0ed188c7f5c0d85806e8de77d46b0177793575a986f5ce44dce6ad` |
| `pack-bec20b21.txt` | 17727 | `4b96b8b3ecc011b072d2b4b219071177c5e970a36ba10e9fee83777006e38fed` |
| `packaged-boot-harness.mjs` | 5621 | `ac3b2ba195c93dc4741ec09e644213fa218539d3083b5e5f3734eb7eb4d850db` |
| `packaged-boot.txt` | 669 | `e437403a051e256d93084b808aedd100f4d466fae3e68102d44818c23e9554a6` |
| `regression-6ee99ecb.txt` | 1261 | `a6abd41190aedd799b8eeda5bb955bb0b6ea3cfb986e56bd663aeab6c20c7111` |
| `review-inventory.json` | 3050 | `5b56d6016db97d91cfc047dd2aaef30d56b34f83741c165aeeb3e6d427404648` |
| `sidecar-build.txt` | 944 | `135c6c7917c003dfc430fc1de25b47bf42ccae075c5bb8014bab6b695bcc52c3` |
| `sidecar-smoke.txt` | 262 → see `.gz` | raw `fbe7b9bbba62ce3ad99d46b652c9facdae3d423b0a2e53df3f3934eda02313b2` |

`sidecar-smoke.txt` ended with a blank line, which `git diff --check` rejects for
a newly added file, so its exact bytes are kept as the deterministic gzip
`sidecar-smoke.txt.gz` (`mtime` 0, no original name; `gunzip -c
sidecar-smoke.txt.gz` reproduces the 262-byte capture). The committed
`sidecar-smoke.txt` is a display copy with only that trailing blank line
removed (261 bytes, `d7e17618dda3bcf5f4bfae11a53ad102f80baa9ae3cbabf01ba5fbd03ef53c48`);
the source directory retains the original.
