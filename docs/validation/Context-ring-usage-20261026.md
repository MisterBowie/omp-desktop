# 上下文圆环思考中显示 100%（R17）验证记录

日期：2026-10-26

## 来由

用户反馈：输入框工具栏的上下文圆环在模型思考期间一直显示 100%，回合结束后才变为 90% 之类的实际值
（默认“剩余”显示模式，100% 即“已用 0”）。

## 根因

- OMP 各服务商在每次模型请求开始时创建流式助手消息，`usage` 预置为全 0，请求结束才填入真实值（上游
  `packages/ai/src/providers/openai-shared.ts` `createInitialResponsesAssistantMessage`；
  `packages/agent/src/agent-loop.ts` 在 `start` 时以该快照发出 `message_start`）。
- 桌面 OMP 适配层 `usageOf`（`app/packages/omp-runtime/src/session/events.ts`）把这份占位原样转成
  `{ inputTokens: 0, outputTokens: 0, …, totalTokens: 0 }`，挂在 `message_start` 的行上。
- 渲染端 `latestMessageUsage` 取“最新带 usage 的消息”（D355），流式行因此抢占圆环：占用 0 → 剩余 100%；
  `message_end` 带来真实用量后跳回实际值。工具循环中每次新请求都会再跳一次。中止的请求结束时仍是全 0，
  也会让圆环停在 100%。
- 原 Pi 路径的 `usageFromPi`（`packages/agent-runtime/src/agent-messages.ts`）会丢弃全 0 用量；OMP 适配层
  缺少同样的判断，属于切换到 OMP 后的回归。

## 基线与环境

- 工作树 `.worktrees/context-ring-usage`，分支 `codex/context-ring-usage`，基于 `main` `583f516b`。
- Node v24.6.0（`nvm use 24`，不改全局默认），pnpm 10.34.5。仓库与子模块均无 `.codegraph/`，未建索引
  （CodeGraph MCP 也未连接）。
- 参考源码：工作树内两个子模块路径按固定 SHA（`62bc57be`、`0111e306`）从根目录本地检出克隆，并以 APFS
  克隆复制 OMP 构建产物（`node_modules`、`pi_natives.darwin-arm64.node`、`tool-views.generated.js`），
  未联网，未改共享 git 配置；`cargo build -p host-core --locked` 供 `omp-worktree-e2e` 使用。
- 原生资源：本机 0.1.6 本地包 `~/Downloads/OMP-Desktop-0.1.6-arm64.dmg`，SHA-256 `f49e862b…bcac` 与
  [本地包证据](Version-016-local-20261024.md)一致，只读挂载后取其 `Resources`。
- 全部测试使用本机假服务商，未调用真实模型。

## 实现

| 提交 | 内容 |
| --- | --- |
| `fc01746f` fix(omp) | `usageOf` 把全 0 用量视为未报告并省略 `usage`，对实时帧、`turn_end` 和历史条目一致生效，与 `usageFromPi` 相同；假服务商支持按 `stream_options.include_usage` 方式输出流式用量；新增原生 e2e 与单元用例；规格 `02-agent-runtime.md`（OMP usage projection）与 E2E 场景 `E2E-OMP-context-ring-keeps-last-usage` |

修复后：请求流式期间圆环保持上一次真实读数，新请求报告用量后才更新。渲染端未改。OMP 会话打开时历史
经同一 `usageOf` 从原生转录重放（`session-ipc.ts` `withOmpHistory`），已有会话中中止请求留下的全 0 用量
也不再出现，不需要数据迁移。

## 验证

| 命令（目录） | 结果 | 附件 |
| --- | --- | --- |
| `npx vitest run src/session/events.test.ts -t placeholder`（`app/packages/omp-runtime`），修复前 | exit 1：`message_start` 行带 `usage` | [unit-red](Context-ring-usage-20261026/unit-red.txt) |
| 同上，修复后整文件 | exit 0，40/40 | — |
| `OMP_BUNDLED_RESOURCES=<0.1.6 Resources> node --test test/omp-context-usage-e2e.test.mjs`（`app/apps/desktop`），`events.ts` 换回 `HEAD` 并重建 `@pi-desktop/omp-runtime` | exit 1：第二次请求流式期间检查器读数为全 0（`inputTokens: 0`），期望保持第一次请求的 12000/400/12400，即用户看到的 100% | [native-red](Context-ring-usage-20261026/native-red.txt) |
| 同上，修复后 | exit 0，1/1 | 含于全量 |
| `pnpm --filter @pi-desktop/omp-runtime test`（`app`） | exit 0，38 个文件，562 通过、6 跳过 | [omp-runtime](Context-ring-usage-20261026/omp-runtime.txt) |
| `pnpm --filter @pi-desktop/omp-runtime typecheck`、`pnpm --filter @pi-desktop/desktop typecheck`（`app`） | 均 exit 0 | [typecheck](Context-ring-usage-20261026/typecheck.txt) |
| `pnpm lint`（`app`） | exit 0（biome 92 个文件、样式令牌通过） | [lint](Context-ring-usage-20261026/lint.txt) |
| `node scripts/check-architecture.mjs`（`app`） | exit 0 | [architecture](Context-ring-usage-20261026/architecture.txt) |
| 首轮 `env -u SSH_ASKPASS OMP_BUNDLED_RESOURCES=… node --test test/*.test.mjs`（`app/apps/desktop`，参考源码未检出、host-core 未构建） | exit 1，3250 项：3219 通过、6 失败、25 跳过。6 项均为环境：5 项找不到工作树 `upstream/` 源码（`ERR_MODULE_NOT_FOUND`、`source does not look like the OMP checkout`、launcher 指向根目录），1 项 `build the current host before running this acceptance test` | — |
| 检出参考源码、构建 host-core 后单独重跑这 6 个文件 | 23/23 通过、0 失败、0 跳过 | [source-e2e](Context-ring-usage-20261026/source-e2e.txt)、[host-core-build](Context-ring-usage-20261026/host-core-build.txt) |
| 提交后 `HEAD`（`fc01746f`）全量重跑（同上命令，环境已补齐） | 3251 项：3240 通过、0 失败、10 跳过、1 取消（247 s）。跳过项均需另设环境变量（LSP 编码、Mnemopi 原生 e2e、`OMP_T21_RESOURCES` 篡改用例 8 项）；新增原生 e2e 在其中通过。取消的是 `omp-plan-submit-e2e.test.mjs` 文件级：其中 15 项均已通过后报 `Promise resolution is still pending but the event loop has already resolved`。会话在汇总写出后中断，shell 退出码未记录（有取消时 `node --test` 退出码为 1） | [desktop-final](Context-ring-usage-20261026/desktop-final-summary.txt) |
| `omp-plan-submit-e2e.test.mjs` 单独复跑三次：`fc01746f`、基线（`events.ts` 换回 `583f516b` 并重建 `@pi-desktop/omp-runtime`）、`fc01746f` | 第一次 exit 1，14/15：T20-D“Enter 已提交但目录重建失败”在恢复提示时报 `the run was stopped while the prompt was being prepared`（`refuseCanceledPreparation`，停止收尾与下一次提示的时序），该项在全量中通过；基线 exit 0，15/15；第二次 exit 0，15/15 | [plan-submit-reruns](Context-ring-usage-20261026/plan-submit-reruns.txt) |

## 未执行

- 未在真实窗口（开发版或安装包界面）中复现和确认；改动经单元与原生运行时 e2e 验证，e2e 使用渲染端同一
  `latestTurnContextInspector` 计算读数。发版前的界面验收需覆盖：思考与工具循环期间圆环保持上次读数。
- 用户 2026-10-26 要求并入 `main` 并本地打包：分支快进并入本地 `main`，未推送 `origin`，未发布。是否随 0.1.7 或
  同版本修订发布由用户决定，届时补更新记录（八种语言）。本地包的记录另见下方“本地包”一节。

## 本地包（2026-10-26）

用户要求并入 `main` 后本地打包。包未签名、未公证，版本面仍为 0.1.6，只用于本机测试，不是发布产物。

- 源码：`main` `90cdafa8`（`fc01746f` 修复加验证记录），在本工作树构建。
- 命令：`OMP_SIDECAR_SOURCE=<根目录>/.omp-sidecar-edec389 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pi-desktop/desktop run dist:mac --arm64`，
  exit 0（131 s）。Node v24.6.0、pnpm 10.34.5、Bun 1.4.2、Electron 43.6.0。
- 运行时：受控 fork `edec3898`，OMP 18.3.0、`62bc57b+omp-desktop.7`；二进制 SHA-256 `98a005a6…`，与 0.1.6 本地包记录相同。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.6-arm64.dmg | 221366582 | 8cbbefcbe778975e44c878ca6d03ee7fbc50ed5aa5ca95cf6fe3219dd1b2af78 |
| OMP-Desktop-0.1.6-arm64-mac.zip | 220275515 | 19f4d5bdaba86792ed6b15f6c65616b9d4b101ed464476cf8a178ff9cdfb0050 |

DMG 复制为 `~/Downloads/OMP-Desktop-0.1.6-ctxring-90cdafa8-arm64.dmg`（SHA-256 相同），不覆盖已发布 0.1.6 的
`~/Downloads/OMP-Desktop-0.1.6-arm64.dmg`；ZIP 在工作树 `app/apps/desktop/release/`。

| 检查 | 结果 | 附件 |
| --- | --- | --- |
| DMG `hdiutil verify` / ZIP `unzip -tq` | VALID / 无错误 | [archive-verify](Context-ring-usage-20261026/local-package/archive-verify.txt) |
| 解出 DMG 内 `app.asar`，查看 `out/main/index.js` 的 `usageOf` | 含全 0 用量返回 `undefined` 的判断（注释已被构建去除） | — |
| `verify-packaged-runtime --resources <DMG 内 Resources>` | exit 0：18.3.0、协议 v2、`get_state` 通过、缺少 gate 被拒绝、停止/回收/清理完成 | [verify-packaged-runtime](Context-ring-usage-20261026/local-package/verify-packaged-runtime.txt) |
| `verify-installed-product --app <DMG 内应用>` | exit 0，`verified: true`，版本 0.1.6 | [verify-installed-product](Context-ring-usage-20261026/local-package/verify-installed-product.txt) |
| 安装态冒烟 `scripts/e2e-installed-smoke.mjs <DMG> <证据目录>` | exit 0，**8/8**（36 s）：建项目与 OMP 会话；拒绝写入后原字节不变；允许一次后真实写入；项目命令结果回到模型；Stop 回收外部进程树；重启恢复同一原生历史且不重放；恢复后新回合完成；默认数据根为隔离 HOME 下的 `.omp-desktop` | [installed-smoke](Context-ring-usage-20261026/local-package/installed-smoke.txt)、[原始输出](Context-ring-usage-20261026/local-package/installed-smoke/) |

所有模型都是 127.0.0.1 FakeProvider，没有真实模型调用。冒烟的假服务商不报告用量：包内运行时写入原生转录的 8 条
助手消息都是全 0 `usage`（`native-after-restart.jsonl`），即服务商不报告时运行时保留的占位，与根因一致。圆环行为
因此在包内没有自动覆盖，需用户安装后用真实模型确认：思考与工具循环期间圆环保持上次读数。

## 遗留

- `omp-plan-submit-e2e.test.mjs` 不稳定：本分支三次运行中两次各有一项（不同用例）失败或取消，基线一次通过。失败均为
  停止/提示准备的时序，用例不读取用量；0.1.6 远端候选 r1 也在该文件的 T20-B2 用例出现过时序失败
  （[证据](Version-016-local-20261024.md)）。未改代码，建议另立任务收紧该用例的等待条件。

- 与 R16（`codex/omp-turn-feedback`，未并入）同时改动 `events.ts`、`provider.mjs`、两份规格、看板与 HANDOFF；
  代码与规格插入位置不同，看板和 HANDOFF 并入时预计需要手工合并相邻行。
