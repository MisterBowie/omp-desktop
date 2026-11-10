# OMP 回合反馈修复（R16）验证记录

日期：2026-10-25（前两项提交）至 2026-10-26（思考等级、验证与文档）

## 来由

R15 调查（[证据](Error-card-dismiss-20261024.md)“遗留”）发现、当时未处理的三个问题：

1. 发送被拒后的错误卡片追加在当前消息列表末尾，可能显示在后续回合下方，看起来像当前回合失败。
2. OMP 自动重试事件（`auto_retry_start` / `auto_retry_end`）未映射，服务商故障时界面长时间只显示
   “处理中”，每次失败尝试各留一张错误卡片。
3. 思考等级与模型不匹配：会话存储的等级不在绑定启用的等级里（用户实例为 `off` 对
   `factory/claude-opus-5-5`），投影以 `OMP_PROJECTION_INVALID` 拒绝发送；提示不可操作，“继续”原样重发；
   界面显示的是钳制后的等级。

## 基线与环境

- 工作树 `.worktrees/omp-turn-feedback`，分支 `codex/omp-turn-feedback`，基于 `main` `583f516b`
  （2026-10-26 fetch，`origin/main` 相同）。
- Node v24.6.0（`nvm use 24`，不改全局默认），pnpm 10.34.5。仓库与子模块均无 `.codegraph/`，未建索引。
- 参考子模块：首轮全量测试时工作树未初始化子模块，7 项依赖源码树的测试因此失败（见下）。随后从根目录
  检出本地克隆，按固定 SHA 初始化（`62bc57be`、`0111e306`），并以 APFS 克隆复制 OMP 构建产物
  （`node_modules`、`pi_natives.darwin-arm64.node`、`tool-views.generated.js`），未联网，未改共享 git 配置。
- 原生资源：本机 0.1.6 本地包 `~/Downloads/OMP-Desktop-0.1.6-arm64.dmg`，SHA-256
  `f49e862b…bcac` 与[本地包证据](Version-016-local-20261024.md)一致，只读挂载后取其 `Resources`。已安装的
  0.1.5 因运行时来源版本（0.1.5 ≠ 0.1.6）被 `verifyBundledRuntime` 拒绝，未使用。
- 全部测试使用本机假服务商，未调用真实模型。

## 实现

| 提交 | 内容 |
| --- | --- |
| `8f8421ed` fix(chat) | 没有锚点的已结束本地行（被拒发送的错误行）放在其后创建的第一条持久行之前；进行中的行和比页面新的行仍排在末尾，D317/D324 尾部保证不变。规格 `10-session-state-machine.md` |
| `6fdc929a` fix(omp) | `auto_retry_start` 映射为既有 `retrying` 活动（尝试次数、退避、服务商错误），在 `auto_retry_end`、重试请求开始输出或运行结束时清除；被取代的失败尝试经既有空失败行移除路径撤回；历史读取跳过 OMP 标记 `retryRecovery` 的条目。FakeProvider 支持 HTTP 错误与中断流。规格 `02-agent-runtime.md` |
| `b27e908f` fix(omp) | 见下节 |
| `5d743122` docs(e2e) | 为重试补登记 `E2E-OMP-provider-retry` 场景 |

### 思考等级（`b27e908f`）

- `effectiveThinkingLevel`（`omp-model-projection.ts`）：按界面同一规则解析存储等级：无等级与 `omit`
  不下发；已声明的保留；规范等级但不在启用阶梯内的取最近支持值（先向上再向下）；非规范值原样返回，
  投影仍拒绝。存储值保持用户所选。
- `projectSessionModels` 用解析后的等级做投影；`createOmpThinkingLevelResolver`（从 wiring 内联提取并导出，
  供 e2e 使用生产实现）读取主机服务商记录做同样解析。
- 会话桥接：绑定或恢复原生会话后，若解析值与 `get_state` 报告的不同，发送 `set_thinking_level`。
  拒绝或解析失败只记日志，发送继续。运行中修改发送解析值，`omit` 不发送；回滚用解析后的旧值。

与原计划的差异：调查时只知道“投影拒绝过时等级”。核对代码后发现第二个缺陷——改动前只有“运行时运行中
修改等级”才会下发，任何新进程（首次发送、换模型、空闲回收、重启）都运行在 OMP 默认 `high`
（`settings-schema.ts` `defaultThinkingLevel`）或恢复会话最后记录的等级，与界面无关。本次一并修复。

界面侧未改：菜单项来自绑定启用的等级（`thinkingProviderForModel`），即使会话快照与服务商记录不一致，
主进程现在也按同一规则钳制，不再拒绝。

## 验证

| 命令（目录） | 结果 | 附件 |
| --- | --- | --- |
| `node --test test/omp-session-configure.test.mjs test/omp-model-projection.test.mjs`（`app/apps/desktop`），三个源文件临时换回 `HEAD` | exit 1，29 项中 6 项新用例失败：过时 `off` 被拒、`omit`/未知值处理、新进程未下发等级、拒绝时不记录、运行中未钳制、`omit` 被下发 | [unit-red](OMP-turn-feedback-20261026/unit-red.txt) |
| 同上，恢复改动 | exit 0，29/29 | — |
| `OMP_BUNDLED_RESOURCES=<0.1.6 Resources> node --test test/omp-thinking-level-e2e.test.mjs`，去掉投影钳制 | exit 1：`thinking level off is not supported by model local-model`（与用户报错一致） | [native-red-projection](OMP-turn-feedback-20261026/native-red-projection.txt) |
| 同上，去掉绑定时下发 | exit 1：`get_state` 为 `'high'`，期望 `'low'` | [native-red-bind](OMP-turn-feedback-20261026/native-red-bind.txt) |
| 同上，完整改动 | exit 0，1/1：首次发送接受，`get_state` 为 `low`，请求 `reasoning_effort: "low"`；运行中改 `medium` 后请求为 `medium` | 含于全量 |
| `pnpm --filter @pi-desktop/desktop typecheck`（`app`） | exit 0 | [typecheck](OMP-turn-feedback-20261026/typecheck.txt) |
| `pnpm lint`（`app`） | exit 0（biome 92 个文件、样式令牌通过） | [lint](OMP-turn-feedback-20261026/lint.txt) |
| `node scripts/check-architecture.mjs`（`app`） | exit 0 | [architecture](OMP-turn-feedback-20261026/architecture.txt) |
| `pnpm --filter @pi-desktop/omp-runtime test`（`app`） | exit 0，39 个文件，568 通过、6 跳过（含重试的 runner/history/retry-activity 用例） | [omp-runtime](OMP-turn-feedback-20261026/omp-runtime.txt) |
| 首轮 `OMP_BUNDLED_RESOURCES=… node --test test/*.test.mjs`（`app/apps/desktop`，去掉 `SSH_ASKPASS`，子模块未初始化） | exit 1，3246 项：3229 通过、7 失败、10 跳过。7 项均为找不到工作树 `upstream/` 源码（`ERR_MODULE_NOT_FOUND`、`source does not look like the OMP checkout`、launcher 指向根目录） | — |
| 初始化子模块后单独重跑这 7 个文件 | exit 0，38/38，0 跳过（含经过 `wireOmpSessions` 的执行策略、运行时状态、turn-fence、计划提交原生 e2e） | [source-e2e](OMP-turn-feedback-20261026/source-e2e.txt) |
| 提交后 `HEAD`（`5d743122`）全量重跑（同上命令，子模块已初始化） | exit 0，3260 项：3250 通过、0 失败、10 跳过（235 s）。跳过项均需另设环境变量：LSP 编码与 Mnemopi 原生 e2e、`OMP_T21_RESOURCES` 篡改用例 8 项。新增思考等级用例与重试、思考等级两个原生 e2e 均在其中通过 | [desktop-final](OMP-turn-feedback-20261026/desktop-final-summary.txt) |

前两项提交（`8f8421ed`、`6fdc929a`）由上一轮在 2026-10-25 完成，当时没有写入证据；本轮的全量测试覆盖了
`session-transcript.test.mjs` 与 `omp-provider-retry-e2e.test.mjs`（原生），`omp-runtime` 包测试覆盖了重试映射。

## 未执行

- 未在真实窗口中复现三个问题（开发版或安装包界面）；改动经单元、桥接与原生运行时 e2e 验证。
  发版前的界面验收需覆盖：被拒卡片位置、重试中状态、过时思考等级可发送。
- 未打包、未推送、未并入 `main`，未发布。是否随 0.1.7 或同版本修订发布由用户决定，届时补更新记录（八种语言）。

## 遗留

- OMP 没有 `omit` 等级：运行中选 `omit` 不发送命令，当前进程保持原等级，下一个进程起才回到 OMP 默认。
- 持久化失败的回滚：旧值解析为空（`omit` 或无等级）时仍按原逻辑回到 `off`，不一定等于运行时此前的实际等级。
  只在主机写入失败时发生。

## 变基到 0.1.7 之后的 `main` 并复验（2026-11-10）

用户 2026-11-10 要求把 R16 变基合并，随 0.1.8 发布。

- `git rebase main`（`main` 为 0.1.7 发布后的 `2cc27eb3`）。代码冲突只有一处：`packages/omp-runtime/src/session/events.ts`
  的助手 `message_end` 分支，R19 给 `finishAssistant` 增加了 `startedAt` 参数，R16 在同一处记录失败尝试；合并后两者都保留
  （`finishAssistant(id, message, status, streaming?.startedAt)` 并设置 `failedAttempt`）。其余冲突为 HANDOFF 与看板行，手工合并。
- 变基后提交：`b76961cd`、`90f51b5c`、`9223e482`、`4ec21bea`、`6ae8c22c`。`pnpm-lock.yaml` 未变，沿用原依赖。
- 原生资源：0.1.7 本地包 Resources 副本（OMP 18.3.0，fork `edec3898`）。全部使用本机假服务商。

| 命令 | 结果 |
| --- | --- |
| `pnpm build:js`、desktop 与 omp-runtime typecheck、`cargo +stable build -p host-core --locked` | 均 exit 0 |
| `vitest run` 4 个文件（`retry-activity`、`runner`、`history`、`events`，`packages/omp-runtime`） | exit 0，113/113 |
| `node --test` 5 个文件（`session-transcript`、`omp-model-projection`、`omp-session-configure`、`omp-provider-retry-e2e`、`omp-thinking-level-e2e`） | exit 0，49/49（含两个真实运行时 e2e） |
| 工作区全量 `pnpm -r --if-present test` | exit 1：其余包全部通过；desktop 3296 项 3285 通过、10 跳过、1 失败 |
| 上述失败 `omp-marketplace-e2e`（R18）：与 R24 的 e2e 同时运行时卡住 45 分钟，测试自带的 240 秒超时未生效；手动结束后报“插件的 MCP 服务器未启动” | 单独重跑 exit 0，1/1，8.7 秒（`rebase-20261110-…` 与 `Release-018-20261110/r16-marketplace-e2e-rerun.txt`）。该测试直接驱动运行时，不经过 R16 改动的代码；记为负载下的测试稳定性问题，待查 |
| `cargo test -p host-core --locked` | exit 0，653 通过 |

复验通过后，与叠在其上的 R24 一起快进并入本地 `main`（`d8bef50b`）。
