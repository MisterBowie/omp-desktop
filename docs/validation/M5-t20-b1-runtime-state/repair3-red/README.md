# 第三次独立复审返修 RED 证据（原样归档，未编辑）

2026-10-02，第三次独立复审（Mac arm64 / Node v24.14.0 / Bun 1.4.2，候选提交
`7fa4be024e16c0a1cbafa752052ee46829a7fab3`，被测源码 `50e4f6ee4d7222fbdd47f078f74a28d0a185cb1b`，
两者只差 HANDOFF/验证记录两行 Markdown）在 F1-F4、R1、R3 复核 GREEN 之外判 `changes-required`
一条（P1/R4）：**新的异步 turn-fence 准备会忽略准备期间到达的 Stop**。

## 复审侧原始文件（复审机产出，字节未编辑，绝对路径仅供参考）

| 文件 | 内容 |
| --- | --- |
| `third-review-summary-7fa4be02.json` | 复审判定（changes-required、已解决项、剩余 R4、证据清单与哈希） |
| `production-fence-stop-race-50e4f6ee.json` | **R4 生产反例**：真实已补丁 OMP + 生产 bridge/runner/gate + 本地 FakeProvider；`get_available_commands` 提交后同步触发 Stop。真实线序 `get_available_commands → abort → 内部绑定 prompt → 用户 prompt`，`stateAtStopRequest=stopping`、`providerAtStopRequest=0`，但 `accepted=true` / **`providerRequests=1`**（被取消的 prompt 在 Stop 之后仍被提交并执行） |
| `production-fence-stop-race-probe.mjs` | 复审机可读脚本（import 绝对路径，不直接运行；seam 只包裹 runtimeFactory 的公开 request 转发，不延迟/伪造/重排任何帧） |
| `start-refusal-generation-50e4f6ee.json` | 同批复核：第 1 代真实拒绝、下一代 awaiting-start 期间精确重复/未见迟到/他会话描述符只计数，真实本代拒绝仍只关本代（**正对照**） |
| `start-refusal-generation-review.mjs` | 复审机 runner/codec 脚本（正式 RPC 帧、按固定 OMP `RpcInputDispatcher` 串行化普通命令；abort 在 agent_start 前不产生 agent_end） |
| `production-state-failure-probe-50e4f6ee.json` | F1-F4/R1/R2 的生产状态探针复核结果（本批回归对照） |

## 本轮返修自身的新测试 RED（本机 Linux x64 / Node v24.14.0 / Bun 1.4.2）

捕获方式：`app/packages/omp-runtime/src/session/runner.ts` 临时还原为 HEAD（未含本次修复）并重建该包
`dist`，随后运行三份**最终版**新测试；原始 stdout/stderr 直接落盘（仅追加一行 `EXIT=1`，未做其它归一化），
之后恢复修复源码并重建。

| 文件 | 复现的失败（未修复行为） |
| --- | --- |
| `runner-tests-red.txt` | runner 层 4 个新用例全失败：discovery / 握手响应 / ACK 三个边界上被取消的 prompt 仍被提交（`accepted=true`），dispose 后仍继续准备 |
| `bridge-test-red.txt` | bridge 层新用例失败：`stop during turn-fence preparation...` 的 prompt 未被取消（`refused` 未定义） |
| `e2e-test-red.txt` | 生产层反例失败：`stop-on-command-discovery` 策略下被取消的 prompt `accepted`（未拒绝）——即复审 `production-fence-stop-race-*.json` 的同一行为在本机可复现 |

`SHA256SUMS.txt` 覆盖本目录全部文件（含复审侧原始文件与上述 RED 日志）。
