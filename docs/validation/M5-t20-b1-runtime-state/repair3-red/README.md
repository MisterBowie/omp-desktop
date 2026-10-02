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

| 文件 | 复现的失败（未修复行为） | 解码后 SHA-256（= 捕获字节） | 归档 SHA-256 |
| --- | --- | --- | --- |
| `runner-tests-red.txt` | runner 层 4 个新用例全失败：discovery / 握手响应 / ACK 三个边界上被取消的 prompt 仍被提交（`accepted=true`），dispose 后仍继续准备 | `83ed30b501167ea88c1627cb8cc8763bbfd908be3621f0f80c6d4349766e56b5`（明文原样） | 同左（未压缩） |
| `bridge-test-red.txt.gz` | bridge 层新用例失败：`stop during turn-fence preparation...` 的 prompt 未被取消（`refused` 未定义） | `975875e11cde84effff37a58444d64b668a679a2c86b055aabd7963f53a2512e` | `0727b12e4cb9b9978ef973401cbe034640091d6efb34ef1ee9d085a36d75197d` |
| `e2e-test-red.txt.gz` | 生产层反例失败：`stop-on-command-discovery` 策略下被取消的 prompt `accepted`（未拒绝）——即复审 `production-fence-stop-race-*.json` 的同一行为在本机可复现 | `ddb5a4829a70961bcc22bcb0e170b5a213139843266144263727c2cab4fc6d24` | `f5e18c14d8ce2c638d59e2b220d7820c558c1f3d8fc75411a1ea21a22927f350` |

## 2026-10-03 归档格式整理（B1 最终区间 `git diff --check` 的收尾）

`git diff --check 7fa4be0 bff27e1` 唯一未通过项是 `bridge-test-red.txt` 第 67/70 行与
`e2e-test-red.txt` 第 17/20 行各含一个只由两个空格组成的原始输出空行（`node --test` TAP 输出原样字节，
捕获时必须保持未编辑）。为保留字节同时让新增差异通过空白检查，这两份日志改为
**确定性 gzip**（`gzip.compress(raw, compresslevel=9, mtime=0)`；头部无原始文件名、
`MTIME=0`，故 `.gz` 字节只是捕获字节的纯函数），跟踪的明文本文件删除；解码验证由
`gzip.decompress`（以及 `gunzip -c <file>.gz | cmp - <原始 Git blob>`）对本目录逐字节确认：

```text
$ git show bff27e1:docs/validation/M5-t20-b1-runtime-state/repair3-red/bridge-test-red.txt | sha256sum
975875e11cde84effff37a58444d64b668a679a2c86b055aabd7963f53a2512e  -
$ gunzip -c bridge-test-red.txt.gz | sha256sum
975875e11cde84effff37a58444d64b668a679a2c86b055aabd7963f53a2512e  -
$ git show bff27e1:docs/validation/M5-t20-b1-runtime-state/repair3-red/e2e-test-red.txt | sha256sum
ddb5a4829a70961bcc22bcb0e170b5a213139843266144263727c2cab4fc6d24  -
$ gunzip -c e2e-test-red.txt.gz | sha256sum
ddb5a4829a70961bcc22bcb0e170b5a213139843266144263727c2cab4fc6d24  -
```

`runner-tests-red.txt` 无空白问题，保持明文原样。这不是 B1 行为失败的重开：回退行为与
GREEN 修复的结论都不变，原始捕获字节也未被剥离空白或重写；`7fa4be0..bff27e1` 这段历史
区间本身仍按原样保留（其 `git diff --check` 退出码仍为 2 是既成事实），修正后的最终区间
`7fa4be0..<归档提交>` 空白检查为 0，在验证记录 §12 记录。

`SHA256SUMS.txt` 覆盖本目录全部文件（含复审侧原始文件与上述 RED 日志），列出每个**跟踪文件**的实际
SHA-256（`.gz` 行即压缩字节摘要）。
