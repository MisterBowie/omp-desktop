# B2 首轮复审返修的 GREEN 证据（Linux x64，修复 commit）

- 修复 commit：`d07d4f95f55a9d3aaa7da9eaadc9cd8fdf3e41f0`（见 `candidate.txt`；
  含 R1-R3 修复、三个新增控制性 E2E 回归与两个 omp-runtime 单测）。三个移植
  脚本（与 `repair-red/` 同一份、仅环境路径替换，此处为自包含副本）在该
  commit 上全部 `passed: true`，每例 control/负例都通过；报告 JSON 的
  `candidate` 字段即该 commit（`host-turn-stop-d07d4f95.json` 等）。
- 复跑命令（依次，Node v24.14.0 / Bun 1.4.2；host-core 为本工作树未改 Rust
  源码的 debug 构建）：

  ```sh
  B2_REVIEW_OUT=<本目录> node host-turn-stop-review.mjs
  B2_REVIEW_OUT=<本目录> node host-turn-terminal-order-review.mjs
  B2_REVIEW_OUT=<本目录> node approved-terminal-order-review.mjs
  ```

  原始 stdout：`r1-green.txt` / `r2-green.txt` / `r3-green.txt`。

- 同一 commit 的定向验证原始日志：
  - `plan-submit-e2e.txt`：产品 E2E **7 passed / 0 failed，exit 0**（含
    Stop-during-begin、terminal-before-response、dispatch-hold+begin-refused
    三个新回归）。
  - `desktop-affected.txt`：受影响 desktop 套件（24 文件）**252 passed /
    0 failed，exit 0**。
  - `omp-runtime-vitest.txt`：**31 files / 476 passed / 6 skipped，exit 0**。
  - `build-js.txt` / `typecheck.txt` / `lint.txt` / `diff-check.txt`：全部
    exit 0（`diff-check` 覆盖工作树与 staged diff）。

- 证明层与限制同 `repair-red/README.md`：公开 seam 的控制性异步边界，不是
  未修改传输的自然时序证明；仅 Linux x64 本机；未使用真实外部模型。
