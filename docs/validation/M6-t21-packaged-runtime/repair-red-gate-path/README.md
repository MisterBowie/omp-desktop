# M6/T21-A repair RED: same-prefix different-path gate refusal (2026-10-01)

The gate control must accept only the runtime's own refusal naming **exactly**
the missing `--trusted-extension` path. The pre-repair entry matched a
substring, so a refusal naming `<missing>.another-file` — a different file
sharing the prefix — satisfied the control.

- `regression-red.txt` — readable transcript of the failing run (trailing
  spaces/tabs stripped; nothing else changed).
- `regression-red.txt.gz` — the byte-exact capture, deterministic gzip
  (`mtime` 0, no original file name): `gunzip -c regression-red.txt.gz`.
  Decompressed SHA-256:
  `7acf60aeca51b54615840cbe2b7d7bbd0c593bbea1e9601b376ac61239043ab6`.

Reproduction: the harness is the shipped entry **unchanged** at `6ee99ecb`
(`verify-packaged-runtime.mjs` sha256
`1ae7161c1dce674f17304ee38fdc5ae5a1bd628c61f005246751418e16b59692`) plus
`apps/desktop/test/packaged-runtime-verify.test.mjs` carrying the new
same-prefix assertion, run as `node --test test/packaged-runtime-verify.test.mjs`
from `app/apps/desktop`. Expected RED: `1 failed / 6 passed / 8 skipped`,
`exit=1`, `AssertionError: Missing expected rejection` — the `.another-file`
refusal was accepted as naming the gate.

After the fix (`namesMissingGate`, full path boundary) the same tree is GREEN:
`7 passed / 8 skipped` always-on, `15/15` with `OMP_T21_RESOURCES`
(`../regression-repair2-always-on.txt`, `../regression-repair2.txt`), and both
real Linux resource trees still accept with `gateLoadControl: refused`
(`../acceptance-staged-repair2.txt`, `../acceptance-unpacked-repair2.txt`).
