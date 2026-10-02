# 根复审独立验收证据（B1 `bff27e11363d3a60b59265ff91d2fb3d814b574a`，2026-10-03 归档）

**来源与归属**：本目录是**根复审方（root reviewer）**对 B1 候选 `bff27e1` 的独立验收原始证据，
经 `/tmp/omp-t20-c-root-handoff-20261003/` 移交并在 2026-10-03 由本工作区（T20-C 执行者）
**字节原样复制**到仓库内，避免 `/tmp` 易失。这些文件**不是本工作区（T20-C）产出**：
本工作区未运行 macOS、未导入根复审的独立环境；T20-C 只做归档与哈希核对（复制前后逐字节相等）。
判定摘要：`b1-acceptance-bff27e11.json` — `B1 behavior accepted`；`remoteHead`/`githubRef`/`localHead`
三者同为 `bff27e11…` 且 clean；唯一遗留为归档级 gzip 收尾（已在 `repair3-red/` 与本记录 §12 完成）。

| 文件 | 内容 | SHA-256 |
| --- | --- | --- |
| `b1-acceptance-bff27e11.json` | 根复审判定：候选 SHA、remote/GitHub/local 一致性、clean、验证计数与证据清单、follow-up（archive only） | `f34618eb81669d7c3433cedf211e43cb3db60cba60fac0397eb47d3792e1182d` |
| `build-runtime-bff27e11-escalated.txt` | 复审机 `@pi-desktop/omp-runtime` 构建（tsc）原始输出 | `9229d9a9f605597573b31d838653196b11bafdafb729928270ef6a93592d963a` |
| `runtime-tests-bff27e11.txt` | 复审机 omp-runtime vitest：25 files / **404 passed / 6 skipped**（exit 0，17.91s） | `cbe55d67e58eb09fc75712cb30178eea0f125c0055307d2adb1d13c36e02fc86` |
| `desktop-targeted-bff27e11.txt` | 复审机定向 desktop 套件（bridge+B1+fence E2E，**53 passed**，含 B1 生产 E2E 41.6s） | `cfc067a1b059c545d196957a77d8f02b50d383a10ce1ecc34b8b122df997b2d6` |
| `production-fence-stop-recovery-bff27e11.json` | 复审机生产探针：Stop 两个边界 provider0/恰一 aborted/idle；恢复 provider1 completed 同一 native 身份；control provider1 | `d4dbfeae3dfa946c96c180df99d6772e10475fbd20ffef745c180a071654d13f` |
| `production-state-failure-probe-bff27e11.json` | 复审机生产状态失效探针：invalid/missing/both-files-removed → provider0/error/idle/retry；Agent 目录恢复 | `4041420595ce034e9257956825d9af79d914d95a4ec4fff946af8290be2f5aec` |
| `start-refusal-generation-bff27e11.json` | 复审机拒绝描述符分代矩阵（旧代迟到/重复/他会话只计数；本代真实拒绝关本代；正对照） | `5628ce0b036e1dac54f8a66ec11e1a84e73e48790d627106fa57eae69690dcfb` |
| `repair3-evidence-bff27e11.json` | 复审机对 17 份跟踪证据逐文件 SHA-256 核对（全部 matches=true，passed=true） | `ace621c1ab6b08dfacecda937946a6acf9248995cacd71f007251314a8ddb953` |

`SHA256SUMS.txt` 覆盖本目录全部文件（含本 README）。上述摘要与
`b1-acceptance-bff27e11.json` 内 `evidence` 清单一致；复制后再次逐字节比较通过。
