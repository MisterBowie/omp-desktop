M5 test packages for macOS (Apple Silicon), Windows x64 and Linux x64.

These are **test packages, not a stable release**: they carry the M5 functionality the root has accepted, they are unsigned, and they publish no auto-update feeds. The previous `m5-preview` release is left untouched.

## Build identity

| Field | Value |
| --- | --- |
| Stage tag | `m5-test-local-20261003` |
| Source revision | `860c264177314f5c9501f90c2ef6bcbcd6aaa11b` |
| Product version | `0.15.2` |
| Controlled patch level | `62bc57b+omp-desktop.5` |
| Sidecar fork | `https://github.com/MisterBowie/oh-my-pi` @ `36483311dfff67be7504f591974df93fc512a45a` |
| Upstream OMP base | `62bc57be1b03ef0802a33cf7f5f530e534527531` (18.3.0) |
| Build run | https://github.com/MisterBowie/omp-desktop/actions/runs/local |

Every package was built and verified from that one revision by the `Three-platform test packages` workflow; the same revision binds this tag, the payloads and `BUILD-RECORD.json`.

## Files

| File | Platform | Bytes | SHA-256 |
| --- | --- | --- | --- |
| `OMP-Desktop-0.15.2-m5-test-local-20261003-macos-arm64-fixture.dmg` | macOS arm64 | 46 | `36b169cb881c1b857c9c0146d25d67e8ee42eed2f113d40a3ab630aafe5bed23` |
| `OMP-Desktop-0.15.2-m5-test-local-20261003-linux-x64.AppImage` | Linux x64 | 250455207 | `890ef53802c16efe9013e6bd08a803c94437cd44a7e1019ec633019bccd4a375` |
| `OMP-Desktop-0.15.2-m5-test-local-20261003-linux-x64.deb` | Linux x64 | 208438940 | `9d8863cebe226bde10eb84d8b4285cab1351088fc185e355c7ec89b35d25b395` |
| `OMP-Desktop-0.15.2-m5-test-local-20261003-linux-x64.rpm` | Linux x64 | 188877517 | `f46a4f84d803f9ee2ba76303db200db737b54294be79666a182a885e44587d4d` |
| `OMP-Desktop-0.15.2-m5-test-local-20261003-windows-x64-fixture.exe` | Windows x64 | 46 | `36b169cb881c1b857c9c0146d25d67e8ee42eed2f113d40a3ab630aafe5bed23` |

Checksums: `SHA256SUMS.txt` (payload only — it never lists itself). Machine-readable provenance, verification results and per-platform pass counts: `BUILD-RECORD.json`.

## What was verified per platform

| Platform | Packaged runtime | Tool gate | Environment isolation | Plan/Goal regression |
| --- | --- | --- | --- | --- |
| macOS arm64 | omp/18.3.0, protocol v2, `get_state` ok, stopped/reaped/cleaned true/true/true | missing-gate refusal verified (`refused`) | child PATH/HOME asserted (readable) | 15 passed, 0 failed, 0 skipped |
| Linux x64 | omp/18.3.0, protocol v2, `get_state` ok, stopped/reaped/cleaned true/true/true | missing-gate refusal verified (`refused`) | child PATH/HOME asserted (readable) | 15 passed, 0 failed, 0 skipped |
| Windows x64 | omp/18.3.0, protocol v2, `get_state` ok, stopped/reaped/cleaned true/true/true | missing-gate refusal verified (`refused`) | child PATH/HOME asserted (readable) | 15 passed, 0 failed, 0 skipped |

The packaged-runtime acceptance ran the *packaged* `Resources` — copied first to a path with spaces and non-ASCII characters, under its own HOME/XDG/TMPDIR — through the production verifier, launcher, tool gate and supervisor. The Plan/Goal regression ran the same real suite the source tree runs, but against the packaged sidecar and the packaged gate bundle.

## Signing and update policy

- macOS: **unsigned and not notarized** (no Developer ID). First launch may need the quarantine removal described in the ZIP's `OMP-Desktop-macOS-opening-help.txt` / `OMP-Desktop-macOS-open.command`.
- Windows and Linux: unsigned test builds.
- No `latest*.yml` updater feeds and no blockmaps are attached, and this release is not marked "latest", so it cannot become an update source for an installed build.

## Scope

- Proven by this release: the M5 functionality accepted at the revision above, packaged and started on each platform (runtime identity, protocol v2, tool-gate loading, process reclamation, Plan/Goal gate/bridge paths inside the package).
- Not proven by this release: installer/shortcut/desktop-entry behaviour inside a real user session (T22/T23), signing/notarization, macOS Intel, Windows ARM64, and the full T21/T22/T23/T24 scope. macOS and Windows runs come from native GitHub runners; the reports for each platform are in `BUILD-RECORD.json` and in the workflow's Actions artifacts.
- Cursor + Plan/Goal remains unsupported and refused (ADR 0306).

## 中文摘要

本 Release 为 M5 阶段测试包（macOS Apple Silicon、Windows x64、Linux x64），未签名、不含自动更新 feed、不设为 latest，旧 `m5-preview` 不受影响。所有平台来自同一已验收提交（见上表），每个包都经过包内生产运行时验收与 Plan/Goal 包内回归；逐平台结果与摘要见 `BUILD-RECORD.json` 与 `SHA256SUMS.txt`。安装身份已改为 OMP Desktop，可与 PI-Desktop 并存。
