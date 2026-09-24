# OMP Desktop 开发交接

更新时间：2026-09-25。当前状态：**M5/T19（MCP、规则、技能、记忆及插件分类适配）进行中：T19-A（运行时能力源隔离、可信网关加载、能力所有权契约）已实现并验证**（分支 `codex/m5-capability-sources`，基线 `ff4c1efed63475b9f552ace8a3f28f69b317e176`）；**T19-B（host-tool RPC）与 T19-C（桌面技能/记忆/插件用户路径）待开始**。T18 已通过独立复审并验收（验收产品基线 `a35da2f87a745fbedd8f5beb46368607c2f6b72e`，分支 `codex/m5-tool-results`；证据见 `docs/validation/M5-tool-results.md`）。T17 已验收基线 `ab07a888d6afb916561b80e5661ed27aa6be612a` 保持不动。下一阶段入口：M5/T19-B。T19-A 证据见 `docs/validation/M5-capability-sources.md`；T18 证据见 `docs/validation/M5-tool-results.md`；T17 历轮独立复审返修见 `docs/validation/M5-subagents.md` §0.1-§0.15。

## 0. M5/T19-A 交付摘要（本轮）

- 状态：**T19-A 已实现并验证**（探针先红后绿 + 定向/全量套件 + 真实固定 OMP 18.2.7 端到端；未声称 T19-B/T19-C）。实现的是**运行期能力源边界**：关闭 OMP 原生项目 MCP 与 OMP 记忆后端，并把桌面审批网关从 `--extension`（开放环境发现）迁移到 OMP 精确文件白名单 `--trusted-extension`。
- 证据：`docs/validation/M5-capability-sources.md`（上游固定源码证据、先红后绿探针、命令/退出码/计数、限制）；设计决策：`app/docs/adr/0304-omp-capability-source-ownership.md`（英文 ADR，含完整所有权契约表）+ `app/docs/spec/03-runtime/02-agent-runtime.md` §14。
- 核心变更：
  - **每运行一份配置 overlay（机械强制）**：`packages/omp-runtime/src/config-overlay.ts` 新增；`supervisor.ts` 在 `startRuntime()` 内、`prepareRun` **之后**、spawn 之前写入 `runRoot/config-overlay.yml`（先 `rmSync` 移除占位条目、再 `wx` 独占创建 mode 0600；写前校验 run root 规范**位置**未变——`prepareRun` 前记录 `realpathSync(runRoot)`、之后重解析 overlay 父目录，被删除或替换为符号链接即启动失败；比较的是解析路径而非 inode，同词法路径换新普通目录不重定向、有意放行；hook 种植的文件/符号链接/硬链接既无法削弱边界，也无法把写入重定向到 run root 之外；写/创建失败走统一清理；保证覆盖 hook 在 `prepareRun` 返回前完成的全部改动，不声称防护两类并发窗口——写者移除与独占创建之间重植末级条目（该窗口唯一防护是 `wx`）、规范位置检查与写入之间替换父目录（`wx` 无法察觉））并作为 `--config <overlay>` 追加在启动参数**最末**，强制 `mcp.enableProjectConfig: false` 与 `memory.backend: off`。按固定 OMP 18.2.7 优先级 `defaults < global < project < PI_CONFIG_FILES < --config < runtime override`（`settings.ts:3303-3307`），workspace（`.claude/settings.json`/`.omp`/`mcp.json` 等）与隔离 global 配置无法重新打开这两类来源。overlay 是 run 的属性（`OmpRunPaths.configOverlay`，run root 内），随 run root 被 stop/reclaim/启动失败清理，绝不进入静态构造参数；不读不写真实用户配置。
  - **网关改走可信白名单**：`engine-runtime.ts` 生产参数 `--extension <gate>` → `--trusted-extension <gate>`（OMP 的精确 canonical 文件白名单，关闭一切环境扩展发现，`main.ts:1597-1614`、`sdk.ts:797-805`、`loader.ts:600-650`），网关恰好加载一次、环境扩展（含网关副本）不再执行。审批/取消/会话/进程清理语义不变（M3）；夹具（session/persistence/concurrent-approval/subagent 四份 E2E）同步改用可信标志并通过。
  - **所有权契约**（ADR 0304）：workspace AGENTS/上下文、OMP 规则、OMP 原生项目技能与 task/LSP/debug/edit 归 OMP 且保持启用（未用 `--tools`/`--no-rules`/合成 HOME 替代源隔离）；桌面/插件 MCP 与插件 Agent Tools 归桌面宿主、T19-B 经 host-tool RPC 恰一次暴露；桌面技能 T19-C 按需读并复检作用域；桌面项目记忆归 host-core、T19-C 经可信网关按 `projectMemoryPrompt()` 语义注入；插件 UI/主题/独立服务归桌面；PI agent 扩展暂不兼容、不得注入 OMP；同一 MCP 服务器/工具绝不双载。
- 新增测试：`packages/omp-runtime/src/config-overlay.test.ts`（9 例：overlay 传参/位置/清理/每 run 新建/参数顺序/启动失败无残留/`prepareRun` 覆盖无效/写失败统一清理/硬链接别名不被跟随/符号链接别名不被跟随〔POSIX〕/run root 被替换为符号链接时启动失败且不写外部〔POSIX〕）、`apps/desktop/test/omp-capability-source-boundary.test.mjs`（2 例：生产接线 `--trusted-extension` 唯一参数、per-session supervisor 无静态 `--config`）、`apps/desktop/test/omp-capability-source-e2e.test.mjs`（5 例真实固定 OMP：workspace MCP 不被发现（含无边界正对照）、workspace/global 配置无法重开记忆（canary 经 fake provider 系统提示断言）、环境扩展不加载、网关副本不执行且每调用恰一次审批、空格/中文路径启动/对话/清理）。
- 先红后绿：基线 `ff4c1ef`（干净 worktree 重跑）上 vitest 探针 4/4 FAIL、接线探针 1/2 FAIL、E2E 4/5 FAIL（workspace MCP decoy 被连接、模型请求携带 canary 记忆、环境 decoy 扩展被执行、网关副本在真实网关弹审批前静默阻断 write（`isError: true`，文本 `blocked by the duplicate gate copy`）；路径守卫基线即过）；本阶段基线上对应全绿（含复核返修 2 例）。
- 验证：`@pi-desktop/omp-runtime` vitest 252/252（+9，含独立复审别名返修 2 例与 run root 规范位置守卫 1 例，红/绿见 `docs/validation/M5-capability-sources.md` §7.7/§7.8）、desktop 定向 95/95、真实固定 OMP 既有四份 E2E 6/6、新边界 E2E 5/5、desktop 全量 2781 总数/2777 通过/0 失败/4 跳过、desktop typecheck 0、style-token lint 0、Biome（75 files）0、`git diff --check` 0。固定 OMP 18.2.7 为产品面 CLI/RPC 探针运行时；未调用付费模型（全部 fake/local fixture）。
- 下一轮入口：M5/T19-B（host-tool RPC：桌面/插件 MCP 与插件 Agent Tools 恰一次暴露）；仍关闭：`branch`/`steer`/`followUp`/`compact`、子代理单独停止、子代理 `hasUI=false` 工具 gating。

## 0. M5/T18 交付摘要（上一轮，已验收）

- 状态：**T18 已通过独立复审并验收**（验收产品基线 `a35da2f87a745fbedd8f5beb46368607c2f6b72e`）。只适配结果展示，不改执行/权限/生命周期/持久化语义；固定 OMP 拥有工具执行与权限。
- 证据：`docs/validation/M5-tool-results.md`（PI 源码/测试 → OMP 生产者形状 → 本项目适配证据、命令/计数/退出、先红后绿、限制、R1-R4 与 S1-S4 返修与环境修正）；本轮未新增 ADR（既有 `tool-presentation.ts` 边界内的纯展示适配，不改变接口/契约/权限/架构，沿用 ADR 0300/0303 的「差异集中在适配层」原则）。
- 本轮返修（S1-S4，基线 `9c9ddc2` 上 residual 探针 11 例全 FAIL 的修复）：**S1** 快照/未知 key/空 evaluation 不再抑制结果文本——`ompDebugBlocks` 的 `carried` 只在 output/evaluation/断点实际渲染后置位，空 console output（`(no output captured)`）与空断点表（`Function breakpoints:\n(none)`）的真实 producer 文本保留；**S2** 只消费已渲染的值（含嵌套/多文件）——LSP 标量 `request`、debug 非字符串 `output`/非 record `evaluation`、edit 非 record `diagnostics` 不再消失，debug `source` 只消费 `path`（`name` 等留嵌套余量）、断点行补真实 `id` 且未识别字段/条目留余量、`ompEditBlocks` 多文件分支不再丢顶层 `diagnostics`/`meta`/未知字段；**S3** 裁剪/截断/失败文件不是 no-op——只在无 diff/快照/rename 且无 `snapshotsPruned`/`truncated`/`isError` 时才生成 `no changes were made`，否则给 missing-information 提示；**S4** rename 保留 `move: a.ts → b.ts` 关系字段行（不再是扁平 `[a.ts,b.ts]`）+ 真实挂载 `ToolRow` 交互回归。
- 核心变更（`app/apps/desktop/src/lib/tool-presentation.ts`）：
  - **LSP**（`ompToolKind` + `ompResultText` + `ompLspBlocks`）：诊断文本与 all-servers-failed 失败文本从 envelope 文本块**或行 `content`** 读取渲染为 output/error 块（`success:false` 或 `toolStatus:error` 用 error tone）；`request`/未知字段走通用回退；`success` 只表示「语言服务器是否应答」，含 error 严重度的诊断仍是 `success:true`，不把源码错误当成工具失败；text-only ToolError（read-only/timeout）不再丢文本。
  - **Debug**（`ompDebugBlocks`）：`details.snapshot`/`evaluation` 扁平为字段行（id/adapter/status/cwd/program/location/stopReason/frameName/instructionPointerReference/exitCode/configuration），console output 成 output 块、断点成行（含 `message` pending 原因），未知字段走通用 record 回退；no-session terminate/空 output 的 producer 文本保留。
  - **Edit**（`ompEditBlocks`/`ompEditFileBlocks`/`ompEditDiagnosticBlocks`）：以 `oldText`/`newText` 生成只读 `diffBlock`，快照裁剪时回退 hashline 格式 `diff` 字符串；单/多文件、rename(`sourcePath`/`move` 双路径)、create/delete、no-op、per-file 错误、`snapshotsPruned`、`diagnostics`/`meta`/`firstChangedLine` 与未知字段可读；路径是点开的 `files` 块（走宿主 `fsResolveRef`）；不伪造 review 快照、不声称 revert/accept。
  - **识别收窄**：原生 edit 识别为 `ompToolBareName === "edit"` AND `details.diff`/`perFileResults`，`plugin_publisher_edit` 等插件保留自身元数据走通用回退（R3）。
  - 未全局替换 Pi 的 details 优先语义、未改 converter/预算/游标/权限；4 MiB 整行预算与 Unicode/稳定 ID 保持（大 Unicode LSP 结果 ≤ 4 MiB 且带 `truncated` chip + `…`）。
- 新增测试：`omp-tool-results.test.mjs`（25 例，真实 `convertEntry`/`convert` → 真实 `buildToolPresentation`/`runOutcome`/`toolResultChips`，覆盖 live/durable/子代理转录、Pi 兼容、插件兼容、大 Unicode 截断、R1-R4 与 S1-S4 回归）、`omp-tool-results-render.test.mjs`（1 例，SSR 渲染真实 `ToolDetailBlocks`）、`omp-tool-row-mounted.test.mjs`（2 例，真实挂载 `ToolRow` disclosure + `ToolDetails`/`useOpenPreviewTarget`/`api`：成功打开一次、missing/error 只出 toast 不打开、`autoOpen` 不打开、restored/child 行无 `toolArgs`）。
- 验证：`pnpm --filter @pi-desktop/desktop typecheck` 0、desktop style-token lint 0、`pnpm lint:biome`（75 files）0、desktop renderer build 0；presentation/file-ref/display 七套件（含 mounted）**85 passed / 0 failed**；复审探针 paths 33/33、preservation 8/8、mounted 组件交互、**residual 11/11** 与 T17 两探针 + tool-text/row-budget/row-meaning 探针均退出 0；**全量 desktop `node --test test/*.test.mjs` 2763 总数 / 2759 passed / 0 failed / 4 skipped**（固定 runtime 已备：`upstream/oh-my-pi` 内 `bun install --frozen-lockfile` + `bun run build:native`，launcher 报 `omp/18.2.7`；6 项真实固定 OMP E2E 现已通过）。
- 下一轮入口：M5/T19-T20（MCP/规则/技能/记忆及插件分类适配；Plan/Goal 与高权限工具能力门）。仍关闭：`branch`/`steer`/`followUp`/`compact`、子代理单独停止、子代理 `hasUI=false` 工具 gating。

## 0. M5/T17 交付摘要（上一轮，已验收）

- 状态：**T17 已验收**（已实现能力边界；验收代码基线 `ab07a888d6afb916561b80e5661ed27aa6be612a`，分支 `codex/m5-subagents`，含真实固定 OMP 子代理端到端验收与 macOS arm64 独立复审）。历轮独立复审返修（R1-R8、S1-S4、B1-B3、C1、D1/D2、E1/E2、F1/F2）的历史记录见 §0.1-§0.14。验收范围仅为 T17 已实现能力边界，不代表 M5/M6/M7 全量、打包构建、付费 provider 或 Windows 已验收；仍关闭的能力（`branch`/`steer`/`followUp`/`compact`、子代理单独停止无 per-child stop RPC、子代理 `hasUI=false` 工具 gating）见 ADR 0303。
- 证据：`docs/validation/M5-subagents.md`（PI 实现/测试 → 固定 OMP 能力 → 本项目决策证据表、归属矩阵、用户路径、失败/取消矩阵、命令与计数、限制；顶部 §0.1-§0.5 为返修记录）；设计决策：`app/docs/adr/0303-omp-subagent-surfacing.md`（英文 ADR）。
- 核心变更：
  - **严格帧校验 + 所有权 fail-closed**（`subagent-frames.ts`/`subagents.ts`）：typebox 校验三族帧与 `get_subagents`/`get_subagent_messages` 响应；缺子身份/状态/`agentSource` 拒绝并计数。所有权单独 fail-closed：子代理只有在其父 id 命中本 runner 观测到的 `task` 调用后才 surface；missing/unknown/conflicting 父 id 计 `unknownParentCalls` 拒绝；`emitSynthesis` 找不到属主即丢弃，不回退当前 run。
  - **每子代理 registry**（`subagents.ts`）：每子代理独立 `OmpEventConverter`，只转发 message/tool 行；`task` 结果 `details` 增补 `delegationId`/`agent`/`status`/…；终止 lifecycle 发 `message_end`(tool) 结算，结算为根 Task 行（内部 `owningToolCallId` 恢复回合，envelope 不带 `parentToolCallId`，防 reload 丢卡）；`reconcile` 把「先前 running、快照缺席」呈现为 `aborted` 且幂等结算；`sessionFile` 不进 list/读取结果。
  - **runner**（`session/runner.ts`）：readiness 后一次 `set_subagent_subscription events`；`task toolCallId → {generation,turnId}` 归因迟到帧；`listSubagents`（reconcile 补漏）/`readSubagentTranscript`（显式上界、稳定行身份、tool 行映射、`nextByte<fromByte` 拒绝）/`stopSubagent`（恒拒）；**父 `stop` 收敛后始终查 `get_subagents`（不依赖本地 registry 是否已有 running child），有存活子代理即走 supervisor 进程组回收（reclaim 父 + 子进程树）；RPC 拒绝/畸形保守 teardown 且不谎报无 child；teardown 未确认 `reaped && cleaned` 时记录可重试义务 `pendingReclaim`（第二次 stop 重跑同一 teardown、pending 时 prompt typed `stopping` 拒绝、确认后才清 registry/task-call 所有权；`stop()` 单飞）**；订阅 off 时 list/read 抛 typed `capability-unavailable`。
  - **桥/IPC**（`omp-session.ts`/`agent-ipc.ts`/`api.ts`）：`listSubagents`/`readSubagentTranscript`/`stopSubagent`；新 IPC `ompSubagentList`/`ompSubagentRead`/`ompSubagentStop`（OMP-only，Pi 会话 typed 拒绝）；订阅不可用映射为 `ENGINE_CAPABILITY_UNAVAILABLE`。桥接 teardown 包装在组已回收但目录残留时补一次 `reclaimAll()` 扫目录。
  - **回收成功后的运行时替换/原生会话恢复（C1，`omp-session.ts`/`runner.ts`/`ui-requests.ts`）**：`ensureRunner` 在 supervisor 不再拥有可复用 runtime 且无重试义务/无进行中 stop 时退役死 runner（detach 帧/失败 handler），下次显式 prompt 经单飞 `buildRunner` 重建；per-runtime `nativeSessionBound` 标志保证换进程后重发 `switch_session`+`get_state`（保留持久 `nativeSessionId`/`nativeSessionPath`，不新建、不重放）；runner 增 `generationSeed` 使 turn 身份跨替换续号不重复；`runnerBuild`/`nativeSessionBuild` 受控 promise 单飞，杜绝重复 runner/重复提交。
  - **渲染器详情桥接线**（`use-omp-subagent-read.ts` + `omp-subagent-read.ts` + `SubagentPanel.tsx`）：OMP 会话经 `ompSubagentList`+`ompSubagentRead` 解析不透明子 id 并映射进既有 `SubagentRun`；按稳定 entry id 增量合并、reset 替换、空增量不清屏、游标始终前进到 `nextByte`、poll 完成后再调度（单飞）；loading/empty/error/retry 在既有 Pi 风格内呈现；Pi 不变、不触发 OMP IPC；读取为本地投影不回写主 transcript。
  - **`--model` 必要性**：固定 OMP 仅在显式 `--model provider/model` 时转发 `subagent_event`；`omp-session-wiring.ts` 现同时传 `--model`（E2E 前后对照复现）。
  - **能力**：`OMP_ENGINE_CAPABILITIES.subagentEvents` 开放；`branch`/`steer`/`followUp`/`compact` 保持拒绝；`stopSubagent` 恒拒（无 per-child stop RPC）。
  - **总 UTF-8 预算（B3，`events.ts`）**：一行 durable UiMessage 的所有载荷字段（`content`/`thinking`/`toolResult`）共享单一 4 MiB 序列化 UTF-8 预算；固定 envelope 先扣除，字符串按 `JSON.stringify` 转义后字节计费（引号/反斜杠/C0 控制/多字节码点/key/分隔符/标量均计费），按码点截断并加 `…`（绝不切代理对）；text-only 结果只投影 `content`、结构化结果文本进 envelope（delegation report/lifecycle summary 所需文本块保留、不复制镜像），整行 `Buffer.byteLength(JSON.stringify(row))` 恒 ≤ 4 MiB。**B3 follow-up**：`toUiMessage` 分配优先级改为先扣 `content`（最终答案）再扣 `thinking`，超大思考块不再擦除短答案——该 helper 同时服务于 durable `convertEntry` 与 live `message_start`/`message_end`，故 live 完成路径一并修复（含最终 `message_end`，有回归覆盖）；`boundedToolResult` 在预算内预留并渲染结构化截断指示——被丢弃的 key/项/整字段以及长字符串 `…` 之外，record `details` 增补 `truncated:true`、非 record `details` 包裹为 `{truncated:true,value}`，走既有 PI `details.truncated`（chip）与 `recordBlocks`/`safeJson` 兜底呈现，不虚构原始计数。**B3 follow-up 残余（整字段 details 丢弃指示）**：整字段 `details` 装不下时标志落在 envelope 顶层 `truncated:true`，但 PI `toolResultPayload` 在 `details` 缺席时返回保留的 envelope 文本、`toolResultChips` 只读 `details` record，原标志被忽略——`toolResultChips` 现改为在 `details` 非 record 且 envelope 顶层 `truncated===true` 时仍推进 `truncated` chip，保留正文仍经 output block 可见，普通未截断文本不产生假 chip（§0.13）。
- 新增/改动测试：`subagent-frames.test.ts`(16)、`subagents.test.ts`、`subagent-runner.test.ts`（含 B1 `pending reclaim retry` 5 例：首败二成后第三停 `nothing running`、连续失败、teardown 抛错、`reaped:true/cleaned:false` 目录债、并发单飞）、`omp-subagent-bridge.test.mjs`(8)、`omp-subagent-e2e.test.mjs`(3 真实固定 OMP，含父 stop 回收运行中 detached 子代理，且不再预先 `listSubagents` 预热；第三项扩展为停后**同会话**续聊并断言响应与同一原生身份)、`subagent-reload-projection.test.mjs`(R3)、`omp-subagent-read.test.mjs`(R2/S2 真实 api + merge 去重)、`omp-subagent-panel-render.test.mjs`(R2/S2 SSR 分流 + loading/empty/error/retry 可见)、`omp-subagent-panel-mounted.test.mjs`(S2 真实 mounted renderer：挂载 hook、运行 effects、打桩 `window.piDesktop.invoke`、断言真实 `api.ts` channel)、`omp-session-bridge.test.mjs`(+6 C1 回归：失败→重试→成功后同会话 prompt、立即成功 teardown 重建、收敛停止复用、pending 拒 prompt 不二次启动、退役 handler 已 detach、dispose 未 reclaim 保留所有权)、`events.test.ts`(+8 B3：整行序列化 UTF-8 预算、大 ASCII/多块/共享 details/CJK/emoji/代理对边界/转义/对象键/标量数组、稳定 entry id)、`omp-subagent-presentation.test.mjs`(6 B3：真实 PI `toolResultPayload`/`buildToolPresentation` 跑投影结果)。
- 全量回归：`@pi-desktop/omp-runtime` **243 通过 / 0 失败**（本轮 +12 B3 回归 +4 B3 follow-up 回归）、`@pi-desktop/shared` 968 通过、desktop 2687 通过/0 失败/4 跳过、`pnpm typecheck`/`build:js`/`git diff --check` 通过。B3 follow-up 定向：`events.test.ts`（短答案保留/转义边界/live `message_end`/大字符串先于后续字段）+ `omp-subagent-presentation.test.mjs`(+3：标量数组/对象键/大字符串先于后续字段经真实 `toolResultChips`/`buildToolPresentation` 呈现 `truncated`）全绿；复审探针 `/tmp/m5-row-budget-review.mjs` 8/8 与 `/tmp/m5-row-meaning-review.mjs` 全断言退出 0。§0.13 残余（整字段 details 丢弃指示）：`omp-subagent-presentation.test.mjs` +2（近/超边界整字段 details 丢弃 chip + 普通未截断文本无假 chip），连同 `tool-presentation`/`assistant-turns`/`subagent-transcript`/`session-message-presentation`/`work-panel-presentation` 定向 **82 passed / 0 failed**；两探针均退出 0；`pnpm --filter @pi-desktop/desktop typecheck` 0。
- **夹具可移植性返修（本轮最后一道门，§0.14，test-only）**：macOS 复审复现五项夹具缺陷——封闭运行时 PATH 内 `node` 退出 127（`omp-session-e2e` 与 `omp-subagent-e2e` 第三项的 `node …` 命令）、`mkdtempSync(tmpdir())` 的 `/var` 别名与产品恢复边界的 `/private/var` canonical 化不一致（`omp-session-persistence-e2e:134` 前缀断言）、`pidAlive`/`processAlive` 只读 `/proc` 使 macOS 存活断言误判/清理断言空洞通过。修复：新增共享夹具助手 `apps/desktop/test/helpers/omp-e2e-process.mjs`（`shellQuote`/跨平台 `pidAlive`/`commandLineAlive`，进程表不可读时抛错而非返回 false）；三份 E2E 的 bash 命令改用 `process.execPath` + shell 引号、`makeScratch` 用 `realpathSync(mkdtempSync(...))`、`finally` 改为嵌套清理收集错误并以 `AggregateError` 上报（不再静默吞 dispose/reclaim 失败）。Linux x64 实测：五份真实固定 OMP E2E **5 passed / 0 failed 退出 0**、bridge 套件在 symlink `TMPDIR` 下 **50 passed 退出 0**、`omp-subagent-bridge` **8 passed 退出 0**、`git diff --check` 退出 0；macOS 由复审方拉取后运行，未声明 macOS/Windows 通过。未改 `.ts`，未重跑 typecheck。
- 下一轮入口：M5/T18-T20（edit/LSP/DAP 展示、MCP/规则/技能/记忆、Plan/Goal 能力门）。

## 0. M4 交付摘要（上一轮）

- 状态：**T14-T16 已完成并提交**（分支 `codex/m4-persistence`），含五轮独立复审（R1-R9、F1-F8、G1-G3、H1-H4、J1-J5）返修，等待复审确认。
- 第五轮复审返修（J1-J5）：`inconsistent` 标记从 Error 顶层移入既有 data/details 契约并穿透真实 `registerIpcHandlers`/`wrap`（renderer `error.details.inconsistent === true`，rename 同步补齐此前丢弃的标记）；rename/configure 在 `engine=omp` 但桥接未接线时 fail closed（先于任何 host 变更）；moveProject/replaceMessages/saveRevision/listRevisions/activateRevision 对 OMP 抛 typed refusal（host 变更前），`scratch` 判定为 host 所有、非原生 transcript、保持引擎无关；renderer `archiveSession` 改真实可执行 store 测试（reject 时保持未归档、不落盘、不创建 fallback）；validation §3.6 改写为最终 model/thinking 行为。详见 `docs/validation/M4-persistence.md` §0.4。
- 第四轮复审返修（H1-H4）：reclaim 失败后 registry 保留 entry/supervisor（第二次 dispose 命中同一 supervisor 可重试，失败后 prompt 不创建第二个 runtime）；renderer archive 改为 await 事务（失败保持未归档且进入 reportError，不创建 fallback session）；sessionConfigure 错误携带 `inconsistent`，delete/archive 在 engine=omp 但 runtime 未接线时 fail closed；修正 validation/task-board/HANDOFF 中 branch/model/计数等过期表述。
- 第三轮复审返修（G1-G3）：modelSwitch 改为「先成功回收旧 runtime，再原子 persist」离线切换事务（reclaim 失败 DB 完全不变、persist 失败按旧 binding 重启、thinking 应用→persist→回滚且回滚失败 `inconsistent`、persistConfig 缺失 fail-closed）；delete/archive 回收失败抛 typed error 不删 row/不谎报完成，renderer archive 改 async 且失败保持未归档；删除过期 branch 序号猜测实现（`branch` 改 typed refusal）。详见 `docs/validation/M4-persistence.md` §0.3。
- 第二轮复审返修（F1-F8）：恢复路径用 `realpath` canonicalize（拒直接/中间目录 symlink 逃逸）、有界读 header、switch 后 `get_state` 必须同时返回 id+canonical path；delete 先取 engine 再回收 OMP runtime 且 `cleanupFailed` 可观察、新增 `sessionArchive` IPC（archive 回收目标、unarchive 不启动）；**branch capability 关闭**（固定 OMP `branch` 是 redo-from-user fork 而非 PI copy-through fork，rpc-ui 事件流不带 entry id，无法可靠映射）；modelSwitch 用单一 `persistConfig` 原子持久化全字段（含 mode/permissionMode）并处理 dispose 失败；投影 authKind 明确 allowlist、空 key fail-closed、provider id 结构化引号；rename 空标题回滚 + cleanup 失败可观察；新增真实 runtime 并发审批 E2E（A/B 同时卡审批、回答 A 不释放 B）。详见 `docs/validation/M4-persistence.md` §0.1/§0.2。
- 证据：`docs/validation/M4-persistence.md`（功能→PI/OMP/本项目 证据表、验证命令与结果、先红后绿证据）；设计决策：`app/docs/adr/0302-omp-session-persistence-and-runtime-registry.md`（英文 ADR）。
- 核心变更：
  - **schema v21**（`crates/host-core`）：`sessions` 加 4 个可空列（`engine_adapter_version`/`engine_runtime_version`/`native_session_id`/`native_session_path`），`session.bindEngine`/`session.getEngineRef` 两个主机边界 RPC；旧 Pi 记录读回 `engine=pi`、引用全 `None`。
  - **持久原生目录**：supervisor 加 `sessionDir`，以 `--session-dir <dataRoot>/omp-sessions` 启动 runtime（原生 transcript 与临时 runRoot 分离），stop/reclaim 不删。
  - **per-session registry**（`omp-session.ts` 重写）：每 session 独立 supervisor/runtime/cwd/模型投影/审批注册表；`new_session`→`get_state`→`bindEngine` 或 `switch_session` 恢复；`set_session_name` 成功并持久化后才生效；model change 为离线 reclaim-first/persist-second restart（不调用 OMP `set_model`），thinking-only 在线 `set_thinking_level` 并回滚。
  - **模型投影**（`omp-model-projection.ts` + `omp-session-wiring.ts`）：只投影目标 provider/model 到临时 `models.yml`，secret 只在 main/host 边界读取、只落进临时文件，canary 扫描覆盖日志/帧/持久引用/文档。
  - **能力**：`resume`/`modelSwitch` 开放；`branch`（语义不兼容，见 F3/G3）/`steer`/`followUp`/`compact` 保持 typed refusal。
- 新增测试：`omp-session-persistence-e2e.test.mjs`（真实 runtime 持久化/恢复 1 项）、`omp-session-concurrent-approval-e2e.test.mjs`（F7 真实并发审批 1 项）、`omp-session-failclosed.test.mjs`（17 项 R1/F1/R5/F6/R7）、`omp-session-delete-archive.test.mjs`（5 项 F2）、`omp-session-configure.test.mjs`（5 项 G1）、`omp-session-configure-ipc.test.mjs`（3 项 H3）、`omp-session-ownership.test.mjs`（2 项 H1）、`omp-session-archive-renderer.test.mjs`（5 项 H2）、`omp-model-projection.test.mjs`（17 项 R4/F5）、`omp-secret-redaction.test.mjs`（canary 2）、`omp-session-bridge.test.mjs`（28）、host-core `db/tests.rs`（迁移 v21 + bindEngine）。
- 下一轮入口：M5/T17-T20（子代理面板、edit/LSP/DAP 展示、MCP/规则/技能/记忆）；`steer`/`followUp`/`compact` 与 `subagentEvents` 在 M5 逐项开放。

## 0. M3 交付摘要（上一轮）
- 证据：`docs/validation/M3-workflow.md`（三方证据位置、权限竞争矩阵、停止顺序、端到端夹具时间线与残留检查）；设计决策：`app/docs/adr/0301-omp-session-surface.md`。
- 新增/改动核心：`app/packages/omp-runtime/src/session/`（events 转换器、ui-requests 决策注册表、runner 生命周期）、`app/packages/omp-runtime/extensions/omp-desktop-gate.ts`（随产品发布的执行前网关）、`app/apps/desktop/electron/main/runtime/omp-session.ts`（桌面桥接）、`agent-ipc.ts` 的 OMP 分支、`packages/shared/src/engine.ts` 的能力开放（prompt/stop/structuredQuestions/toolApproval）。
- 新增测试：`events.test.ts`(16)、`ui-requests.test.ts`(19)、`gate.test.ts`(13)、`runner.test.ts`(14)、`omp-session-bridge.test.mjs`(13)、`omp-session-e2e.test.mjs`(真实固定 OMP 端到端 1 项：读→拒绝→批准一次→跑测试→长任务停止→无残留)。
- 本轮环境补充（新工作树必需）：`bun install --frozen-lockfile` 与 `bun --cwd=packages/natives run build`（未安装时 Bun 会解析到全局缓存 18.2.9，pinned 校验失败）。
- 返修（独立复审 R1-R2，基线 `cb6f728`）：R1 `prompt(projectPath)` 现在会在 `start()` **之前**把经过校验的绝对项目目录交给监督器（空/相对/不存在一律 fail closed，绑定后不同目录明确拒绝），E2E 不再手工设置 cwd；R2 权限决定改走专用 `resolvePermission`/`resolveAsk`，身份取自桥接保存的 session+generation+kind，重复/停止后/跨 kind/未知一律 fail closed（基线实测缺陷：ask 请求 id 可被权限路径消费并写帧）。详见 `docs/validation/M3-workflow.md` §5.1。
- 第二轮返修（独立复审 R1-R3，基线 `60e0f7e`）：R1 跳过/拒绝提问与无法投递的自定义答案现在 fail closed 完成（写 `{cancelled:true}` 并清两层 pending），不再让 OMP 永久等待；R2 旧 generation 的 UI 请求在回合结束/停止/失败/被新 run 替代后一律失效，旧决定绝不写入新 run；R3 `stop(sessionId)` 先校验会话所有权再清理，错误会话的停止不再破坏正确会话的 pending/状态/wire。详见 `docs/validation/M3-workflow.md` §5.2。
- 第三轮返修（独立复审 F1-F3，基线 `ce2bf01`）：F1 只有存在 active run 时才呈现 approval/question，idle/stopping 期间到达的交互帧按 OMP 协议立即 `{cancelled:true}`（不呈现、不留 pending、不可事后放行）；F2/F3 prompt 被拒绝或抛错时统一走幂等的 `closeGeneration()`（取消该代 dialog、通知桥接、回到 idle、保留原异常），与传输失败并发时最多取消一次。详见 `docs/validation/M3-workflow.md` §5.3（含 PI-Desktop/OMP 参考文件与测试检索证据）。
- 第四轮返修（独立复审 F1-F2，基线 `db89c88`）：删除 `omp-session-bridge.test.mjs` 中的永真断言 `|| true`；prompt 被拒绝或请求抛错且该回合已呈现过卡片时，runner 现在发出**恰好一次** terminal `error` envelope（带正确 `sessionId`/`turnId`，与传输失败共享单次守卫，原异常与拒绝原因保持不变），使 renderer 的 `pendingPermissions`/`pendingAsks` 按 PI-Desktop 既有契约被清空，不再留下孤儿卡片；terminal 之后的迟到交互请求仍 fail closed。附带修正 E2E 自身两处时序假设（僵尸进程判定、回合结算等待），全量 desktop 连续 8 次 0 失败。详见 `docs/validation/M3-workflow.md` §5.4。
- 下一轮入口：M4/T14-T16（会话字段与恢复、模型与凭证投影、并发项目）；M3 未开放的入口（附件、steer/follow-up、压缩、分支、子代理交互审批、会话切换）保持显式拒绝。

## 1. 用户已确定的方向

- 基于 `vastsa/PI-Desktop` 实现 OMP 桌面端，界面和主要交互尽量保持一致。
- 按 `can1357/oh-my-pi` 的能力修改或增加功能。
- 由本轮模型负责规划，用户选择其他模型执行实现。
- 用户已有 NVM，使用 **`nvm use 24`**，不要重复安装 Node。

## 2. 已准备好

| 位置 | 内容 |
| --- | --- |
| `app/` | 本项目直接管理的产品源码，导入自 PI-Desktop 0.15.2 |
| `upstream/pi-desktop/` | PI-Desktop 原始源码子模块，固定基线提交 |
| `upstream/oh-my-pi/` | OMP 18.2.7 源码参考子模块，固定基线提交 |
| `docs/source-baseline.json` | 精确 SHA、工具版本与准备状态 |
| `docs/00-scope-and-decisions.md` | 范围和技术决策 |
| `docs/01-source-audit.md` | 本地源码入口、真实协议和兼容性边界 |
| `docs/02-target-architecture.md` | 目标架构、接口、会话和权限实现路径 |
| `docs/03-implementation-plan.md` | M0-M7 阶段计划与验收门 |
| `docs/04-task-board.md` | 24 个实现任务，当前全部待开始 |
| `docs/05-validation-and-release.md` | 测试矩阵、用户路径和发布验收 |
| `docs/06-executor-prompts.md` | 分阶段执行提示词 |
| `docs/07-environment-and-upstream.md` | 环境准备和上游维护 |
| `docs/validation/M0-baseline.md` | M0 验证记录（命令、版本、退出码、SHA、截图） |
| `docs/validation/M0-screenshots/` | M0 代表性界面基线截图（项目列表/设置/模型/扩展） |
| `docs/validation/M1-compatibility.md` | M1 验证记录（E01-E13、413 项检查、传输能力矩阵、未执行项、三轮复审返修 R1-R6 / F1-F6 / R1-R4） |
| `docs/decisions/001-omp-transport.md` | 接入传输路径决策（含 M2 必须遵守的十二条约束） |
| `app/experiments/omp-bridge/` | M1 实验套件：`node run-all.mjs` 可复现，含 `tools/long-task.mjs`、`lib/runtime-registry.mjs`（按运行标识回收资源）、fixtures/results |

PI-Desktop SHA：`0111e306c120ad5820688d7608cb37bad8fbcc1f`

OMP SHA：`d49918fab2dba3986927f2d46721629ed0f3a02c`

项目 GitHub 地址：`git@github.com:MisterBowie/omp-desktop.git`，主分支 `main`。根目录直接管理文档和 `app/`，上游参考采用固定提交的子模块。使用 `git clone --recurse-submodules` 或在克隆后运行 `git submodule update --init --recursive`。

首次规划的 `app/` worktree 结构已为 GitHub 交付调整；原始 worktree 仅在本机 `.local-worktrees/pi-desktop-baseline/` 保留，不是后续开发入口。`source-baseline.json` 中的初始化记录保持历史原样，当前布局以上述说明为准。

## 3. M0 已完成的工作

- 建立专用分支 `codex/m0-baseline` 与 worktree，初始化参考子模块到固定 SHA（pi-desktop `0111e306`、oh-my-pi `d49918fab`）。
- 准备并记录环境：Node 24、pnpm 10.34.5、Bun 1.4.2、rustc stable + nightly-2026-08-12、cmake/ninja。
- 原 PI-Desktop 按锁文件安装依赖并完成 `build:js`、typecheck、lint、host-core 构建与测试（`cargo test -p host-core` 577 通过）。
- 隔离开发数据/数据库/凭证/更新源（`PI_DESKTOP_DATA_DIR`）与全局 `.agents`（`PI_DESKTOP_AGENTS_DIR`），启动开发版，CDP 截取代表性界面基线。
- OMP `bun setup` 构建成功；`docs/validation/M0-rpc/verify-rpc.mjs` 绑定 `upstream/oh-my-pi` 内的启动器（repo 路径，非全局链接），核对 gitlink=submodule SHA 与版本 18.2.7，全量隔离（每次运行唯一的 `PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR`/`OMP_DEV_LAUNCH_DIR`）下完成 `ready`/`negotiate_protocol`(v2)/`get_available_models` 协议启动，无付费模型调用；隔离路径为验收条件，流错误统一清理，默认无临时目录/进程残留。配套 `verify-rpc.test.mjs`（18 项假进程测试）+ fixture `models.yml` + `fake-omp.mjs`。
- 证据：`docs/validation/M0-baseline.md`（含顶部“返修记录”）与 `docs/validation/M0-screenshots/`；任务看板 T01-T03 已标记完成。

## 3.1 仍然没有做的工作

- 没有修改应用源码或 OMP 源码（M0 全部通过已有配置完成，未改产品代码；仅根 `.gitignore` 增加 `.dev-data/`）。
- 没有调用真实模型或付费 API（OMP 协议启动用 `auth: none` 的本地 mock 模型）。
- 没有创建 PR、发布安装包或部署产品，没有自动提交或推送。
- 没有做 macOS arm64 打包（本机为 Linux x64，与规划假设不同）。
- M1 未覆盖：真实子代理事件（需真实 `task` 调用，T17）、MCP 工具进入模型工具表（T19）、macOS/Windows 进程终止语义（T23）、真实付费模型烟测（需用户指定）。

## 3.2 M1 已完成的工作

- 在 `app/experiments/omp-bridge/` 建立可复现实验套件 E01-E13(本地假 provider、每实例合成 HOME 与隔离配置根、进程组回收)。`node run-all.mjs`:**13/13 实验、413/413 检查通过,退出码 0,约 210 秒**;汇总按「退出码 0 + 无信号 + PASS + 结果文件命名/`ok` 一致 + 本轮运行标识」判定,并回收被强杀实验的 detached 运行时与隔离目录。
- 权限链路实测:受信扩展的 `tool_call` 钩子在**执行前**拿到工具名与具体目标,拒绝时无文件/进程副作用,批准后只执行一次;宿主工具(`set_host_tools`)同样经过该钩子。审批问答通过 `extension_ui_request` 的 `select/confirm/input` 往返,并覆盖取消与超时。
- 取消链路实测(复审 R1 后重做):顶层会话里 `abort` 就能回收**真实运行的命令进程及其子进程**(用自行写 PID 的外部程序验证);**不先停止就杀桥接进程组会留下孤儿**,因为命令运行在自己的 session/进程组;挂起对话被 `cancel` 且解析为 deny、会话保持可响应。停止顺序因此定为"先协议内停止,再拆桥接"。
- 子代理挂起审批的取消(第三轮 R1):**OMP 不提供**——父 `abort` 成功后子代理仍 `running`、无取消帧、延迟 300 ms 的 allow 会真的执行;E11 改为由**桥接侧取消标记**实现"停止后旧审批不能再放行",并区分取消/拒绝/超时。桌面须在 M2/T09 自建该机制。
- 子代理(R3 新增 E11,复审 F1 后按会话身份路由重做):子代理的工具调用**会**进入同一条 `tool_call` 钩子,但钩子在子代理会话里 `hasUI=false`,不可能向用户弹窗——纯 UI 依赖的审批会被立即拒绝,审批必须由桌面策略或带外通道决定;策略批准时由子代理恰好执行一次。父会话 `abort` **不会**回收 detached 子代理正在运行的命令树(子代理仍被报为运行中),需要显式的进程树终止。
- 配置隔离(R2 加固):子进程 `HOME` 指向运行目录内的合成家目录,并剥离额外重定向变量;正对照(合成 HOME 里的全局规则生效)与反对照(decoy HOME 的规则/技能不生效)都已验证,测试不再读取真实用户配置。
- 协议分片(R4 新增 E13,复审 F3 后接入客户端):关闭自动压缩后 1.2 MB 提示产生真实 `rpc_chunk`,解码器现接在**响应匹配之前**,`rpc.request()` 能拿到 1,200,650 字节的完整重组响应;分片写回 stdin 会被拒绝(`Unknown command: rpc_chunk`),而单行超限命令可直接接受;分片故障不可恢复(固定实现亦视为致命),桌面应重启运行时。
- 取消语义(第四轮 R1):取消对尚未执行的调用具有决定权——每轮先查取消标记,决定按 `toolCallId` 归属且单次消费,不再用文件 mtime 判断(真实 OMP 探针证伪了旧规则);E12 覆盖取消先到、allow 先落盘后被取消、正常允许、显式拒绝、真实超时与作用域不匹配。
- 回收验收(第四轮 R2):回收异常/`clean=false`/存活资源进入验收判定,失败时非零退出且 summary 保留结构化诊断;清理失败的登记保留可重试;`--keep-artifacts` 不算失败。
- 审批消费 fail-closed(第五轮 F1):决定文件的**读取或消费写入**失败都不放行(显式 block;`child-consume-failed`/`child-decision-unreadable`),否则一份只读 `allow` 会授权后续所有调用(真实子代理已复现)。
- 代理环境归一化(第五轮 F2):隔离环境按 PI `PROXY_ENV_KEYS` 先全量剥离大小写四组代理变量与 `NODE_USE_ENV_PROXY`,再施加本测试策略;真实 bun 子进程实测假代理 0 请求、loopback 仍可达。
- 离线烟测(第四轮 C1):M0 隔离环境显式离线(出站指向关闭端口、loopback 直连),默认命令恢复通过且**未放宽超时**;原因见验证报告 §8.3。
- 回收语义(第三轮 R2/R3):按**进程组存活**决定 SIGKILL 升级(组长退出不豁免,对照 `npm-executable.ts` 的 `settle()`),存活成员按 `/proc` 的 `pgrp` 精确枚举,清理未完成保留登记且不谎报;按所有权删除本轮 `.dev-data/m1/<run>-*` 临时根并遵循 `--keep-artifacts`。
- 传输错误分类(第三轮 R4):等待中的协议/流错误按真实错误返回(`errorKind="transport"`),只有真正超时才归类 timeout。
- 工具链加固(E12,R5/R6 与复审 F2-F5):帧结构校验、启动失败有界清理;汇总按「退出码 0 + 无信号 + PASS + 结果文件命名/`ok` 一致 + 本轮运行标识」判定;被超时杀死的实验,其 detached 运行时、后代与隔离目录按**环境归属**有界回收(不按进程名);参数选择集合正确。
- 宿主工具与子代理:`host_tool_call`/`host_tool_result` 往返可用,放弃未应答调用会收到 `host_tool_cancel`(**按 `targetId` 关联**);真实 `task` 调用产生 `subagent_lifecycle`/`subagent_progress`/`subagent_event` 三类帧,存活期快照含 `parentToolCallId` 与 `sessionFile`。
- 会话与隔离实测:原生会话按 `sessionFile` 恢复且不重放副作用、不重新审批;`branch` 生成新的原生会话文件;子进程实际环境无凭证与 steering 变量;模型/规则/MCP 都从隔离根加载。
- 传输边界实测:跨块 UTF-8、半帧、CRLF、非法 JSON 恢复、超长行显式报错、180 KB 多字节消息往返;缺失可执行文件/立即崩溃/永不 ready 三类降级运行时均可分类回收;stdin EOF 与 stdout EPIPE 都会让 OMP 自行退出且进程组被回收。
- 模式差异实测(纠正了仅凭源码的初判):两种模式都能投递扩展对话,但只有 `rpc-ui` 装配 `setToolUIContext` 并广告 OMP 自身的 `ask` 工具(12 项 vs 11 项)。
- 版本协商实测:ready 广告 `supportedProtocolVersions: [1,2]`,但 `negotiate_protocol: 1` 被明确拒绝,只能协商 v2。
- 回归:M0 的 `verify-rpc.test.mjs` 18/18 通过,`verify-rpc.mjs` 真实无费用 RPC 通过。
- 证据:`docs/validation/M1-compatibility.md`、`docs/decisions/001-omp-transport.md`、`app/experiments/omp-bridge/fixtures|results/`;任务看板 T04-T07 已标记完成。

未通过/未执行:MCP 工具未进入模型工具表(归属 T19);子代理的交互式审批**不支持**(无 UI,须由桌面策略替代)与单独停止(T17);macOS/Windows 进程终止未验证(T23);ACP/SDK 仅源码比对。

## 3.3 M2 已完成的工作（T08-T10）

- **T08 引擎边界**：`packages/shared/src/engine.ts` 定义 `EngineId`（`pi` | `omp`，与 `SessionSource` 不同维度）、全键必需的 `EngineCapabilities`、`SessionEngineRef`（含 `ENGINE_ADAPTER_VERSION`）、`EngineRuntimeStatus` 与协议/版本常量。`normalizeEngineId` 对缺省与未知值一律回 `pi`：旧会话永远属于 Pi，不会被新默认值接管。
- **T09 运行时包**：新增 `app/packages/omp-runtime`（已入 pnpm workspace 与锁文件）。模块职责：`protocol`（typebox 帧校验、ready 判定、v2 分片重组）、`ndjson`（显式行长上限 + `line-too-large` 重同步）、`transport`（ID 匹配、流错误按真实原因返回、挂起请求全量 settle、拒绝写回 `rpc_chunk`）、`launcher`（显式/打包内/固定子模块，**绝不从 PATH 解析**，`--version` 校验）、`isolation`（合成 HOME、剥离重定向/代理/凭证变量）、`process`（停止顺序 abort → abort_bash → EOF → TERM 组 → KILL 组，按**进程组存活**判定）、`supervisor`（运行根所有权、单飞启动、`stopped`/`reaped`/`cleaned` 三独立判定、`terminateOwnedTree`、`prepareRun` 配置投影）。
- **实际运行证据**：该包 62 项测试全部通过，其中含**真实固定 OMP 运行时**的无费用烟测（版本 18.2.7 校验 → ready → negotiate v2 → 停止后进程组与运行根均已回收）；mock 子进程覆盖永不 ready、拒绝 v2、帧上限不符、分片损坏、忽略 TERM/EOF、组长退出但后代存活等情形。
- **T10 路由与身份**：host-core schema 升级到 v20（`sessions.engine TEXT NOT NULL DEFAULT 'pi'` + 迁移与备份，既有会话读出 `pi`；fork 与协同 spawn 继承来源引擎）；`session.create` 校验引擎；桌面侧 `runtime/engine-router.ts` 是唯一判定点（`prompt`/`steer`/`stop` 三个执行入口统一过 gate），OMP 会话在能力关闭时被**拒绝而非回退到 Pi**；`runtime/engine-runtime.ts` 汇总两引擎状态并持有 OMP 运行时；退出时 reclaim 未完成会写 error 日志。
- **应用身份**：`packages/shared/src/app-identity.ts` 定义产品身份并与上游 PI-Desktop 及 OMP 自身目录做冲突断言（`assertIndependentIdentity`）；数据根改为 `~/.omp-desktop` / `~/.omp-desktop-dev`，appId `net.misterbowie.omp-desktop`，productName `OMP Desktop`，更新源指向本项目仓库，开发构建禁用自动更新，开发 bundle 的名称/bundle id 由 package.json 派生。
- **复审返修（R1-R7，见验证记录 §8）**：① 生产组合此前**没有**接入会话→引擎查询，steer/stop 等按 id 的 gate 实际永远读作 Pi——现已由 host 的 `session.get` 提供唯一持久化来源并在组合测试中断言（OMP 会话抛能力拒绝且不触碰 sidecar）；② 查询失败不再 fail-open 到 Pi，只有“读取成功且无 engine 字段”才算旧会话，其余一律 `ENGINE_UNAVAILABLE`；③ 逐条审计并 gate 了 abort/compact/status/队列/ask 解析/计划批准与恢复排空，ADR 0300 增补审计表与三条不 gate 的依据；④⑤ supervisor 在 `reaped:false` 后保留可重试所有权并禁止二次启动，stop/reclaim 单飞以消除并发竞态（含 start 与 reclaim 的竞态）；⑥ shutdown 对 reclaim rejection 写 error 日志并有行为测试；⑦ 测试夹具 PATH 追加解释器目录，修复 macOS/`~/.nvm` 下的 127 失败（生产 PATH 仍封闭）。
- **第二轮复审返修（S1-S6，见验证记录 §9）**：① 队列 reorder 补上唯一 gate；② 计划批准与恢复排空改为“先 gate 再改动持久状态”（被拒的执行跳过且保持 queued）；③ 所有执行/控制 handler 改为“参数校验 → 读引擎并 gate → 才要求 Pi 运行时”，并把 gate 语义定为**按声明**判定（运行时是否在跑由状态面回答，避免一次重启被读成永久拒绝，队列也才能在重启期间暂存）；④ 启动失败若进程未能回收，错误携带所有权、supervisor 采纳并保留目录与 pid/pgid，拒绝第二次启动，重试可清理；⑤ 记录区分“进程已回收（只欠目录）”与“仍拥有活组”，前者绝不再发信号；⑥ 删除任务临时文件，交付以 `git status --porcelain` 为空为准。第三轮（S7）：扫描回收成功后按同一 runRoot 精确释放所有权（`ownsRun`），使 `status` 回到 `stopped`、`start()` 可再次成功；成功回收的 `stop` 同时删除扫描为同一运行保留的记录，扫描确认进程已回收但目录仍在时把记录降级为 cleanup-only 并停止发信号。cleanup failure 语义不变：只要仍有未清理记录，`status` 为 `failed`/`unreclaimed`、`start()` 继续拒绝。第四轮（S8）：进程组确认回收后，无论目录删除成败都先替换同 runRoot 的旧保留记录，保证一次运行最多一条记录（删净则 0 条，否则恰 1 条 cleanup-only）。
- **环境事实（重要）**：子模块依赖必须**按 worktree 单独安装**（`bun install` + `bun run build:native`，不执行 `link omp`）。未安装时固定启动器会把 `@oh-my-pi/pi-utils` 解析到 bun 缓存里的已发布包，`--version` 报出与固定检出不同的版本——这正是运行时包坚持启动前校验版本的理由。
- 证据：`docs/validation/M2-runtime-boundary.md`、`docs/decisions/001-omp-transport.md`（沿用）、`app/docs/adr/0300-engine-boundary.md`（英文 ADR）、`app/docs/spec/03-runtime/02-agent-runtime.md` §13。任务看板 T08-T10 已标记完成。

## 4. 下一执行模型从哪里开始

T17 已通过最终独立复审并验收（验收代码基线 `ab07a888d6afb916561b80e5661ed27aa6be612a`，分支 `codex/m5-subagents`；含真实固定 OMP 端到端验收与 macOS arm64 独立复审，证据见 `docs/validation/M5-subagents.md` §0.15 与 §0.14）。T18 已通过独立复审并验收（验收产品基线 `a35da2f87a745fbedd8f5beb46368607c2f6b72e`，分支 `codex/m5-tool-results`，证据见 `docs/validation/M5-tool-results.md`）。T19-A（运行时能力源隔离、可信网关加载、能力所有权契约）已实现并验证（分支 `codex/m5-capability-sources`，基线 `ff4c1efed63475b9f552ace8a3f28f69b317e176`，证据见 `docs/validation/M5-capability-sources.md`）。

下一阶段入口：M5/T19-B（host-tool RPC：桌面/插件 MCP 与插件 Agent Tools 经单一宿主边界恰一次暴露；桌面技能/记忆/插件用户路径为 T19-C）。仍在关闭的能力：`branch`/`steer`/`followUp`/`compact`、子代理单独停止（固定 OMP 无 per-child stop RPC）、子代理 `hasUI=false` 工具 gating（产品策略），留待对应阶段逐项开放。

## 6. 下一轮必须保持的取舍

- 保留桌面 UI 和既有 Pi 行为，变更集中在运行时边界。
- 引擎 ID 与现有 `SessionSource` 分开；原生 Pi/远程会话不受新默认值误影响。
- OMP 原生工具和桌面宿主工具不是同一执行路径，权限覆盖需要证据。
- OMP 原生会话由 OMP 管理；桌面数据库仍归 Rust host-core，不做双重 transcript 写入。
- 使用结构化事件，复用已有协议/组件/测试；不解析终端输出，不预先设计多引擎大平台。
- 阶段失败如实记录，保持可回退的小范围变更，不将未运行验证标为通过。
