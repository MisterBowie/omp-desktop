# chatfix 第二候选源码门失败的定位与修复（R07，2026-10-22）

状态：**本机已修复并验证；只改测试同步，产品代码不变。** 远端新候选的结果以本页“远端候选”一节为准。

## 失败事实

第二候选 run39706079958（源码 `a8e7872f`）的 Mac ARM 与 Linux 原生作业通过，完整源码门失败。安全诊断分支
`codex/source-test-diagnostic-39706079958` 只给出位置，按该提交逐行对照：

| 位置 | 内容 |
| --- | --- |
| `omp-plan-submit-e2e.test.mjs:1988` | 测试“T20-D lifecycle (B13/B2) … no residue”的声明行 |
| `:2059` | 辅助函数 `turn()` 中 `assert.equal(settled.status, "completed")`，即持久回合行尚未结算 |
| `:2099` | 触发上一条的调用 `turn("plan-again", "plan")` |
| `omp-skill-path-e2e.test.mjs:617` | 测试“a planted symlink cannot redirect the state write …”的声明行 |
| `:679` | 第二次 `bridge.prompt(...)` 被拒绝 |

两处都在同一会话的连续回合之间，与 chatfix 改动的路径无关。

## 根因

1. **运行器空闲早于持久结算。** `omp-session.ts` 的回合结束处理先让运行器回到空闲，持久行由异步
   `endHostTurn` 结算，结算完成后才发出 `onTurnEnd` 通知（代码注释：观察者收到终止通知后不得再读到运行中的行）。
   `turn()` 只等运行器空闲就读行；本机探针显示第一回合空闲时通知尚未发出（`endsAtIdle: 0`），
   远端较慢时读到的正是未结算的行。0.1.4 的 `87894e73` 已在同文件其他用例按同一原因改为等待通知，这一处漏改。
2. **`message_end` 早于 `agent_end`。** 运行器在 `agent_end` 之前一直处于 running，期间的新提示会被拒绝。
   技能路径的两个用例只等到 `message_end` 就发下一条提示。本机 RED 探针在 `message_end` 当时发送下一条，
   得到 `not-started: the runtime is running; stop it before prompting again`，与远端第 679 行的拒绝一致。

## 修复

- `omp-plan-submit-e2e.test.mjs` 的 `turn()`：先记录 `ends.length`，等待运行器空闲且本回合的结算通知到达后再读持久行。
- `omp-skill-path-e2e.test.mjs`：记忆编辑用例的第一、二回合之后，以及符号链接用例的第一回合之后，
  等待 `bridge.status(...).isRunning === false` 再发下一条提示。
- 所有断言、计数与超时预算不变；产品代码不变。

## 本机验证

环境：macOS arm64，Node v24.14.0，Bun 1.4.2。根目录参考子模块已执行 `bun install --frozen-lockfile` 与
`bun run build:native`，供固定启动器使用；打包运行时取已安装的 0.1.4 应用资源（`62bc57b+omp-desktop.7`，
fork `edec3898`）；host-core 使用 `codex/fix-omp-first-response` 工作树的 release 构建（chatfix 与子代理修复均未改 Rust）。

| 命令（目录 `app/`） | 结果 |
| --- | --- |
| 修复前 `node --test apps/desktop/test/omp-skill-path-e2e.test.mjs` | 6/6 通过（本机较快，未触发竞态） |
| 修复前临时 RED 探针（`message_end` 当时发下一条提示，未提交） | 1 失败：`the runtime is running; stop it before prompting again` |
| 临时生命周期探针（运行器空闲瞬间读取持久行与通知数，未提交） | 第一回合空闲时 `endsAtIdle: 0`，证明结算通知晚于空闲 |
| 修复后 `node --test apps/desktop/test/omp-skill-path-e2e.test.mjs` | **6/6** 通过 |
| 修复后 `PI_DESKTOP_HOST_BIN=… OMP_E2E_PACKAGED_RESOURCES=… node --test apps/desktop/test/omp-plan-submit-e2e.test.mjs` | **15/15** 通过 |

原始输出在 [Chatfix-source-gate-races-20261022/](Chatfix-source-gate-races-20261022/)，`SHA256SUMS.txt` 记录摘要。

## 远端候选

待执行：本修复与子代理修复（R06）合入修订线 `codex/chatfix-revision` 后，以新的 `release-check-0.1.4-*`
标签重跑完整源码门与四目标构建。只有远端整轮通过且用户确认本地测试后，才按同版本修订流程发布。
