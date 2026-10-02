# B2 首轮复审返修的 RED 证据（Linux x64 复现）

- 来源：根复审候选 `148cfcc78e3d8a093877cba2050cb40363e5b9ba`（2026-10-03）判
  changes-required 的三份真实报告与脚本。**原始字节**保存在 `root-originals/`，
  与根证据目录 `/tmp/omp-t20-b2-first-root-review-20261003/SHA256SUMS.txt`
  一致（其中两份脚本顶部历史注释有复制残留，以其实际代码与报告 `layer` 为准：
  terminal-order 脚本没有 Stop 注入，production-approval 脚本只有其五个实际
  场景）。
- 本机移植：`host-turn-stop-review.mjs`、`host-turn-terminal-order-review.mjs`、
  `approved-terminal-order-review.mjs` 仅替换环境路径（repo/app 根、host-core
  二进制改指本机 debug 构建或 `PI_DESKTOP_HOST_BIN`、报告输出目录
  `B2_REVIEW_OUT`）；断言、seam 与注释不变，脚本头已注明。**不是 macOS 命令
  的实跑**：`root-originals/` 是复审机产物，本目录的 JSON 是本机 Linux 复跑
  产物。
- 复现环境：本工作树未修改的 `148cfcc7`（`candidate.txt`）；Linux x64 /
  Node v24.14.0 / Bun 1.4.2；host-core 由本工作树未改 Rust 源码构建
  （`app/target/debug/pi-desktop-host-core`）；patched `.4` OMP；本地
  FakeProvider。命令（依次）：

  ```sh
  B2_REVIEW_OUT=<本目录> node host-turn-stop-review.mjs
  B2_REVIEW_OUT=<本目录> node host-turn-terminal-order-review.mjs
  B2_REVIEW_OUT=<本目录> node approved-terminal-order-review.mjs
  ```

- 结果：三条 negative 全部失败且与根报告一致，正对照（control）全部通过。
  - R1 `host-turn-stop-148cfcc7.json`：`Stop during begin must cancel the
    pending prompt`（provider 请求 1 ≠ 0；行最终 completed，而要求为
    aborted、零 provider）。
  - R2 `host-turn-terminal-order-148cfcc7.json`：`real terminal event must
    close its own durable host turn even before prompt Promise delivery`
    （durable row `running` ≠ `completed`；`onTurnEnd.hostTurnId = null`）。
  - R3 `approved-terminal-order-148cfcc7.json`：`execution_state` `running`
    ≠ `completed`（两个 host turn 均已 completed、queued 为空）。
  - 原始 stdout：`r1-red.txt` / `r2-red.txt` / `r3-red.txt`。

- 证明层（与根脚本一致，不夸大）：真实 HostProcess + 真实 SQLite + 生产
  bridge / host-turn lifecycle / runner / plan dispatcher + patched `.4` OMP +
  本地 FakeProvider。R1 是公开 `hostTurns.begin` seam 内执行并等待真实
  `bridge.stop` 后再交付真实 id（受控异步边界）；R2 是公开 `runtimeFactory`
  seam 只延迟真实用户 prompt 应答至真实 terminal frame；R3 是公开
  `getOmpSessions` 组合 seam 只延迟真正的 `bridge.prompt` 结果至真实
  `onTurnEnd` 交付后。三者都不伪造 frame、返回值或 DB 行，也不是未修改传输的
  自然时序证明。
