# OMP 会话 token/s 生成速度显示（R19）

日期：2026-10-27。工作树 `.worktrees/token-throughput`，分支 `codex/token-throughput`，基于本地 `main`
`62a47f93`（含未推送的 R17/R18）。用户要求后提交并快进合并到本地 `main`，未推送、未打包。

## 需求与现状

用户要求显示 token/s。0.15.2 基线其实已有两处展示：输入框上下文检查器里的“生成速度”，以及停止且无
用量回合的“约 N tokens/s”标签；上游 PI-Desktop 0.21.0 又新增每轮用量胶囊（`6c90bf42`，`ecd9ea9f` 修正
浮层方向），在答案下方常驻显示“速度 · 总量”。

## 根因：OMP 适配层从不提供响应时长

- 生成速度 = 输出 token ÷ `responseDurationMs`。OMP 会话里这个字段始终为空，检查器显示“—”。
- `OmpEventConverter.onMessageEnd` 先执行 `this.streaming = null`，再调用依赖 `this.streaming` 计时的
  `finishAssistant`，秒表结果恒为 undefined。唯一能写入时长的 `message_update{done}` 分支，OMP 18.3.0
  从不发送：agent-loop 在 done/error 时只推 `message_end`（`packages/agent/src/agent-loop.ts` 约 2011–2087 行）。
- 历史投影（`get_entries` → `convertEntry`）也不映射时长，重新打开会话同样没有速度。
- OMP 原生 `AssistantMessage` 带 provider 实测的 `duration`（请求总时长）和 `ttft`
  （`packages/ai/src/types.ts` 1121–1126 行），随 `message_end` 帧和原生 JSONL 一起提供。
- 修复前用真实 0.1.6 运行时复现：`message_end` 有 `usage.outputTokens = 80`，但
  `responseDurationMs` 为 undefined（见下方 native-red）。

## 实现

| 范围 | 内容 |
| --- | --- |
| `packages/omp-runtime/src/session/events.ts` | 助手行把原生 `duration` 映射为 `responseDurationMs`，四舍五入为整数毫秒（host-core 以 i64 持久化该字段），实时 `message_end` 与历史条目同一路径；原生缺失时（例如供应商结算前被中止）退回转换器秒表，并修正先清空 `streaming` 再计时的顺序；删除把 `usage.outputTokens` 重复写进 `responseOutputTokens` 的无效代码 |
| 渲染层 | 移植上游每轮用量胶囊：新增 `TurnUsageCapsule.tsx`（`portalToBody` 改为我们已在用的 `createPortal(…, document.body)`；上游的 portal-visibility 模块不在本基线），`context-usage.ts` 新增 `turnUsageBreakdown`，`MessageMeta` 有用量时显示胶囊、无用量的停止回合仍显示“约 N tokens/s”，`AssistantTurn` 传入估算标记，`messages.css` 增加 `.turn-usage-*` 样式，8 种语言各加 `usageTurnAria`、`usageTotal` |
| 规格 | `02-agent-runtime.md` 新增 “OMP response duration projection”；`08-component-spec.md`、`10-workbuddy-benchmark-ux.md` 与 E2E-060d（中英文）记录胶囊；新增 `E2E-OMP-turn-generation-speed` |
| 测试 | `events.test.ts` 3 项（原生时长与取整、秒表回退、历史映射）；`omp-context-usage-e2e.test.mjs` 新增原生 e2e（真实运行时 → 桥接 → 渲染投影 → 检查器 → 原生历史）；`context-usage.test.mjs` 4 项 `turnUsageBreakdown` 边界 |

速度口径与上游和 OMP 自身一致：输出 token ÷ 请求总时长（含首 token 等待）。OMP TUI 的
`calculateTokensPerSecond` 也用 `duration`，上游 PI-Desktop 用 pi-ai 的 `durationMs`。

上游的 `turn-usage-capsule.test.mjs` 全部是对源码和 CSS 文本的正则断言，没有移植；改用下方真实 Electron
渲染验证交互与显示。

### 与上游相同的统计边界

胶囊汇总的是该回合**已渲染的助手消息片段**（`assistantTurnUsage`），与上游 `getAssistantTurnSummary`
相同：只产生思考行或什么都不渲染的模型请求（例如没有正文的工具调用，DeepSeek 常见）不计入合计和速度。
因此在多次工具调用的回合里，胶囊显示的通常是最终回答那次请求的速度与用量。规格已按此写明；是否改为
统计全部请求需要改动转录条目模型，未在本次处理。

## 验证

环境：macOS arm64，Node v24.6.0，pnpm 10.34.5，Electron 43.6.0，Rust nightly 1.99（`cargo build -p host-core
--locked`）。原生资源为已安装 `/Applications/OMP Desktop.app` 0.1.6 的 `Resources`（fork `edec3898`，
`62bc57b+omp-desktop.7`，二进制 SHA-256 `98a005a6…`）。全部测试使用本机 FakeProvider，未调用真实模型。
工作树内两个子模块按固定 SHA（`62bc57be`、`0111e306`）从根目录本地克隆，并以 APFS 克隆复制 OMP 构建产物，
供依赖参考源码的套件使用；未联网，未改共享 git 配置。

| 命令（目录） | 结果 | 附件 |
| --- | --- | --- |
| `npx vitest run src/session/events.test.ts -t "duration\|first frame"`（`app/packages/omp-runtime`），修复前 | exit 1：新增 3 项全部失败，`responseDurationMs` 缺失 | [unit-red](Token-throughput-20261027/unit-red.txt) |
| `npx vitest run src/session/events.test.ts src/session/history.test.ts`，修复后 | exit 0，55/55 | [unit-green](Token-throughput-20261027/unit-green.txt) |
| `pnpm --filter @pi-desktop/omp-runtime test`（`app`） | exit 0，39 个文件，583 通过、6 跳过 | [omp-runtime-suite](Token-throughput-20261027/omp-runtime-suite.txt) |
| `OMP_BUNDLED_RESOURCES=<0.1.6 Resources> node --test --test-name-pattern="generation speed" test/omp-context-usage-e2e.test.mjs`（`app/apps/desktop`），`events.ts` 换回 `HEAD` 并重建 `@pi-desktop/omp-runtime` | exit 1：实时 `message_end` 的 `responseDurationMs` 为 undefined | [native-red](Token-throughput-20261027/native-red.txt) |
| 同文件全部用例，修复后 | exit 0，2/2：实时行为整数毫秒且 ≥ 供应商挂起的 400 ms，检查器读到同一时长，速度为正且不超过 80 token / 0.4 s，原生历史行时长与实时一致；R17 圆环用例仍通过 | [native-green](Token-throughput-20261027/native-green.txt) |
| `node --test` context-usage、latest-turn-context、assistant-turns、transcript-style、turn-process、context-inspector-position（`app/apps/desktop`） | exit 0，84/84 | [renderer-targeted](Token-throughput-20261027/renderer-targeted.txt) |
| `pnpm --filter @pi-desktop/i18n test` | exit 0，25/25 | [i18n](Token-throughput-20261027/i18n.txt) |
| `pnpm --filter @pi-desktop/desktop typecheck && pnpm --filter @pi-desktop/omp-runtime typecheck` | exit 0 | [typecheck](Token-throughput-20261027/typecheck.txt) |
| `pnpm lint` | exit 0（biome 94 个文件，样式令牌通过） | [lint](Token-throughput-20261027/lint.txt) |
| `pnpm docs:check` | exit 0，80 对中英文规格、524 页 | [docs-check](Token-throughput-20261027/docs-check.txt) |
| `pnpm --filter @pi-desktop/desktop build` | exit 0（既有大 chunk 提示） | [desktop-build](Token-throughput-20261027/desktop-build.txt) |
| 真实 Electron 渲染（临时探针，未入库）：生产 `AssistantTurn` + 已构建 CSS，真实鼠标/键盘事件 | exit 0：胶囊“81 tokens/s · 17.2K”紧跟模型徽章；悬停打开浮层（缓存读取 12,096 / 输入 3,402 / 输出 1,704 / 合计 17,202），指针离开与 Escape 关闭；zh-CN 与 en 可访问名称正确；流式回合无胶囊；合成的无用量停止回合显示“约 45 tokens/s”（见下方边界） | [probe](Token-throughput-20261027/capsule-electron-probe.txt)、[暗色浮层](Token-throughput-20261027/capsule-popover-zh-dark.png)、[亮色浮层](Token-throughput-20261027/capsule-popover-en-light.png)、[胶囊](Token-throughput-20261027/capsule-zh-dark.png) |
| 首次全量 `env -u SSH_ASKPASS OMP_BUNDLED_RESOURCES=… node --test test/*.test.mjs`（参考源码未检出、host-core 未构建） | exit 1，3251 项：3220 通过、6 失败、25 跳过。6 项均为环境：5 项找不到工作树 `upstream/` 源码，1 项要求先构建 host-core | [diagnostics](Token-throughput-20261027/desktop-failing-files-rerun.txt) |
| 补齐参考源码与 host-core 后全量重跑（同命令） | 3251 项：3240 通过、0 失败、10 跳过、1 取消（254 s）。跳过项都需另设环境变量（LSP 编码、Mnemopi 原生 e2e、`OMP_T21_RESOURCES` 篡改用例）；取消的是 `npm-executable` 的 15 s 超时用例，与本改动无关，单独运行时该文件 12/12 通过。补丁运行时 e2e（T20-B1/B2/C/D、turn fence）和 worktree e2e 均在其中通过 | [desktop-full](Token-throughput-20261027/desktop-full.txt.gz)、[npm-rerun](Token-throughput-20261027/desktop-plan-submit-npm-rerun.txt) |

上游参考：`upstream/` 下保存了 `6c90bf42`、`ecd9ea9f` 的完整提交与 HEAD `5aa25388` 的组件源码（gzip）。
证据文件的 SHA-256 见 [SHA256SUMS](Token-throughput-20261027/SHA256SUMS)。

## 未执行与边界

- 没有在安装包或开发版完整应用窗口里跑真实 OMP 会话；可见层由真实 Electron 渲染生产组件验证，数据层由原生
  e2e 覆盖运行时到渲染投影。
- 没有调用真实模型，速度数值来自假服务商；真实服务商的 `duration` 由 OMP provider 写入（同一字段）。
- 未推送、未打包；没有新增更新记录条目（发布时决定版本）。
- 中断且供应商未报告用量的 OMP 回合不显示速度：适配层不估算输出 token，渲染层的估算分支只服务 Pi 路径。上面的 `stoppedWithoutUsage` 场景使用合成数据（`responseOutputTokens: 90`），只证明渲染分支，不代表 OMP 的真实输出。
- 旧会话的历史速度取决于原生记录是否保存了 `duration`；本次只在新建会话上验证。
- 临时渲染探针未入库（按 `app/AGENTS.md` 清理临时脚本）；截图与输出保留为证据。
