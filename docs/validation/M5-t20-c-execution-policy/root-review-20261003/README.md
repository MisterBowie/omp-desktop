# 根复审原始证据（macOS arm64，2026-10-02/03）

来源：根复审方在其本机（`/Users/vv/Documents/对话/omp-desktop-review-m5-r4b`）对**原始远端提交**
`fc0fb29842516b191b704d37d21c44e489b8c167` 独立运行后的原始产物，逐字节复制进本目录（`SHA256SUMS.txt`
为本目录内各文件哈希；`.json` 与 `.txt` 两份报告在其原始运行中即为同一字节内容）。本工作区未在 macOS
上运行这些脚本，也未把它们当作本工作区的执行证据——它们记录的是返修前的 RED 事实。

| 文件 | 内容 |
| --- | --- |
| `production-session-grant-fc0fb298.json` / `.txt` | **R1**：真实 UI `allow-session` 被折叠成 allow-once，同会话下一个 Plan 回合与 Plan→Agent 重建后仍弹卡、body0；首个 allow-session 反例 body1 |
| `production-turn-policy-fc0fb298.json` / `.txt` | **R2**：同一 Plan/ask 提示词内第一次 Bash allow-once 后，工具体只改运行域状态 `permissionMode=auto`，下一个 Bash 无卡改写哨兵；未改动文件 control 正常弹卡 |
| `production-session-grant-review.mjs` | R1 原始脚本（Mac 绝对路径、`preparePatchedTree` + 真实 bridge/runner/gate + FakeProvider） |
| `production-turn-policy-review.mjs` | R2 原始脚本（同上） |
| `gate-policy-review.mjs` | 受控注册 handler 的 20 用例决策矩阵（canonical 变体 20/20；Mac `/var` 别名变体 7/8） |
| `gate-policy-extended-review.mjs` | 扩展夹具：legacy `allow` 覆盖 Agent/ask、合成未知原生名不被 gated 等 helper 边界 |
| `production-native-policy-review.mjs` | 真实 native body 的 8 用例（write/bash/read × ask/auto/accept-edits） |
| `first-review-summary-fc0fb298.json` | 根复审总结（裁决 changes-required、R1/R2、两条 additional observation、accepted 基线） |

返修后的 GREEN 对应：`packages/omp-runtime/src/session/gate-review-matrix.test.ts`（canonical 20 + 两条
extended 边界）、`gate-admission.test.ts`、`turn-admission.test.ts`、`ui-requests.test.ts`、
`runner.test.ts`、`apps/desktop/test/omp-session-bridge.test.mjs` 与
`apps/desktop/test/omp-execution-policy-e2e.test.mjs` 场景 10/11（真实 native body 的 grant 生命周期与
回合内文件 mutation 反例）。原始 20/20 的 `production-native-policy` 与 `gate-policy` canonical 变体
所观察到的行为在返修后仍然通过（同一边界，见本目录上级验证记录的计数）。
