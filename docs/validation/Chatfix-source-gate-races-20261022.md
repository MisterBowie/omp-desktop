# chatfix 第二候选源码门失败的定位与修复（R07，2026-10-22）

状态：**已修复并验证；只改测试，产品代码不变。** r3 远端失败已补修，r4 远端候选整轮通过，见“远端候选”一节。

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

### r3：run39718937256（源码 `37fff5c4`）失败

- Linux x64、Windows x64、macOS arm64 构建通过；`publish` 跳过，没有发布。
- `verify` 作业的完整源码门 `pnpm -r --if-present test` 退出 1。
- macOS x64 构建完成后，两次 `actions/upload-artifact` 均报
  `Failed to CreateArtifact: Unable to make request: ENOTFOUND`，属托管运行器网络故障，与源码无关。
- 公开 API 只给出作业、步骤结论与注释，读不到日志（摘要见 `r3-run-39718937256.json`）。本轮没有再推送诊断
  分支或标签，改为在本机补齐完整源码门环境后复现。

### 本机复现与根因

上一轮本机工作树没有初始化参考子模块，`omp-execution-policy-e2e`、`omp-runtime-state-e2e` 在
`preparePatchedTree` 处先失败，掩盖了真实问题。本轮用根目录参考子模块的本地克隆初始化工作树子模块（固定
SHA、不联网、不改共享配置），以 APFS 克隆复制运行时构建载荷（`node_modules`、原生模块、生成的工具视图）。
打包运行时改用摘要与已发布 v0.1.4 资产一致的 DMG（`f5340b27…`）中的资源：`/Applications` 当前安装的是
0.1.3，其 provenance 会被 0.1.4 构建拒绝。

在 `37fff5c4` 上两项均失败：`unexpected host call: agents.active`。R06 让每次 OMP 启动前经宿主
`agents.active` 读取设置中启用的用户子代理，这两个补丁运行时 e2e 的宿主夹具对未列出的调用直接抛错，没有
同步新增调用。产品代码无误。

### 修复与本机验证

两处夹具对 `agents.active` 返回空目录 `{ subagents: [] }`；断言、计数与超时不变。

| 命令（目录 `app/`） | 结果 |
| --- | --- |
| 修复前 `node --test apps/desktop/test/omp-execution-policy-e2e.test.mjs apps/desktop/test/omp-runtime-state-e2e.test.mjs` | 0/2，均为 `unexpected host call: agents.active` |
| 修复后同上 | **2/2** 通过 |
| `pnpm build:js` 后 `OMP_BUNDLED_RESOURCES=… OMP_E2E_PACKAGED_RESOURCES=… env -u SSH_ASKPASS pnpm -r --if-present test` | 其余各包全部通过；desktop 3232 项：3221 通过、0 失败、10 跳过、1 取消 |
| 取消项单独复跑 `node --test apps/desktop/test/npm-executable.test.mjs` | **12/12** 通过 |

取消的一项是 `npm-executable.test.mjs` 的 “npm --version nonzero and timeout …”：整套并发时超过本用例
15 秒预算，单独运行约 10.7 秒通过，与本修复无关。10 项跳过需要专用资源：8 项 `OMP_T21_RESOURCES` 篡改用例、
1 项真实 typescript-language-server、1 项 `OMP_MEMORY_TEST_RUNTIME`。

环境：macOS arm64，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2；host-core 为同源 debug 构建（crates 自
`119e2d29` 未变）。原始输出 `r3-*.log.gz` 在同名子目录。

### r4：run39807879685（源码 `852ca1b9`）通过

guard、`verify`（完整源码门）与 Linux x64、Windows x64、macOS arm64、macOS x64 四个构建全部成功；`publish` 按
`release-check-*` 规则跳过，没有发布。产物 `release-darwin-arm64`、`release-darwin-x64`、`release-win32-x64`、
`release-linux-x64` 及对应 `validation-*` 保留到 2027-01-20，可在该运行页面登录 GitHub 后下载。发布前仍须用户
在本机安装 r4 产物测试确认，再按同版本修订流程执行。
