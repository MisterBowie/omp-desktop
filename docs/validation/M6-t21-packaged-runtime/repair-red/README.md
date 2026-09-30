# repair-red: byte-exact RED captures (M6/T21-A review repair, 2026-10-01)

The regression RED for the first repair round must stay verifiable, but the
captures tripped `git diff --check` (four trailing-whitespace lines in
`regression-red.txt`, two in `semantic-revert.diff`). Both originals are kept
here as **byte-exact deterministic gzip** instead of as normalized text, so the
patch stays applicable and the capture stays auditable.

| File | Contents | Decompressed SHA-256 |
| --- | --- | --- |
| `regression-red.txt.gz` | byte-exact `node --test` output (exit 1) on the semantic-revert harness | `4360e51441053788e58ce1d7f43f342b8456e91565630cbf2c3b6fbf305f814a` |
| `semantic-revert.diff.gz` | byte-exact revert patch of the two repaired hunks | `0516a82c4f54fab1fc5962011f334971dd6d5d5c52a08df280d193d29296c1c1` |
| `regression-red.txt` | readable display copy: trailing spaces/tabs stripped, a note header added; not byte-exact | — |

Decompress with `gunzip -c <file>.gz` (or `gunzip -k <file>.gz`); the gzip
header carries no original name and `mtime` 0, so the `.gz` bytes are a pure
function of the captured bytes. The decompressed SHA-256 values equal the Git
blobs these files replaced at `6ee99ecb` (`git show
6ee99ecb:docs/validation/M6-t21-packaged-runtime/repair-red/<file> | sha256sum`),
and `semantic-revert.diff.gz` decompresses to a complete unified diff — the two
whitespace lines are diff body lines (a context blank line and an added blank
line), so normalizing them would have made the patch inapplicable. The diff has
no `a/` prefix, so decompress and apply with `-p0` from `app/`:
`gunzip -c semantic-revert.diff.gz > /tmp/semantic-revert.diff && git apply
--check -p0 /tmp/semantic-revert.diff` against the `6ee99ecb` version of
`scripts/verify-packaged-runtime.mjs`; verified `exit 0`, and applying it yields
the pre-repair semantics (reverted file sha256 `f367d37b50b95f9bea0e073a5609d3069b02aacfe7e76e0eb49486b356cf857c`,
`15 insertions(+), 59 deletions(-)`).
