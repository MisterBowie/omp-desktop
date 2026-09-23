# M5 验证记录：OMP 子代理面板与编排归属（T17）

状态：**未验收**（T17）。第三轮独立复审拆出 B1-B3 三项返修；B1 于 `9d0acde` 首实现后独立复审仍复现两项缺陷（F1 目录债二次 stop 丢失、F2 停期间短暂放行 prompt），本提交修复并追加行为回归，**B1 改定待独立验收**；第四轮独立复审拆出 C1（回收成功后的运行时替换/原生会话恢复，见 §0.5），**C1 已实现待独立验收**；**B2（renderer 单飞/错误可见）与 B3（总 UTF-8 预算）仍未解决**。M5 后续任务 T18-T20 未开始。
基线提交：`d26444407fc963c2e7efd51bda7d1bd4a70e8bbd`；第二轮独立复审返修（S1-S4）以追加普通提交落在该基线上（见 `git log` 最新提交）。
固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`（本轮未修改）。
工作树：`/home/vv/person/code/omp-desktop-m5-t17`，分支 `codex/m5-subagents`。
传输/权限决策沿用 `docs/decisions/001-omp-transport.md`；本轮新增产品侧 ADR `app/docs/adr/0303-omp-subagent-surfacing.md`。

## 0.1 独立复审返修（R1-R8，2026-09-23）

独立复审发现 8 项阻断缺陷并已在同一分支追加提交修复，全部有行为回归覆盖：

- **R1 父 stop 泄漏 detached 子代理**：`stop()` 在父回合收敛后未查 `hasRunningChildren()`，会谎报干净收敛却留下存活进程组。现改为收敛后经 `get_subagents` reconcile 确认；若仍有存活子代理则走既有 supervisor 进程组回收（reclaim 父 + 全部子进程树），teardown 后清 registry/task-call 所有权。新增真实固定 OMP E2E：子代理运行 `long-task.mjs`（真实长命令）时停父，断言 `converged=false`/`toreDown=true`、子命令树（pid + 后代）已回收、无残留。
- **R2 渲染器未接线详情桥**：`SubagentPanel` 只读 `useTranscriptView`，从未调 `ompSubagentRead`。现为 OMP 会话经 `useOmpSubagentRead` → `ompSubagentList`+`ompSubagentRead` 解析不透明子 id 并映射进既有 `SubagentRun`；Pi 会话不变、不触发 OMP IPC；含 loading/reset/游标续读/live 更新/缺失/错误/卸载失效（stale-request 序号）。读取为本地投影，不回放进主 transcript、无工具副作用；单独停止保持禁用。新增行为测试（真实 `api.ts` 经 `window.piDesktop.invoke` 打桩）+ SSR 渲染测试（Pi/OMP 分流）。
- **R3 结算破坏父 Task 行**：`settlement()` 把 `parentToolCallId` 打在结算 envelope 上，`event-persistence.subagentTagged` 把它写到原 Task 行 → reload 时 `assistant-turns` 把该行滤出根 transcript。现结算用内部 `owningToolCallId`（只恢复回合），envelope 不再带 `parentToolCallId`；子行仍带。新增 event-persistence + transcript 投影回归（Task 卡可见、子行仍挂靠）。
- **R4 所有权校验未 fail-closed**：lifecycle/progress/snapshot 把 `parentToolCallId` 当可选，tracker 不查 `taskCalls`，`unknownParentCalls` 从未自增，`emitSynthesis` 找不到父任务时回退到当前 run。现在子代理只有在其父 id 命中本 runner 观测到的 `task` 工具调用后才 surface；缺失/未知/冲突父 id 计数并拒绝；`emitSynthesis` 不再回退当前 run（找不到属主即丢弃）。覆盖 missing/unknown/conflicting 与新代开始后的迟到 child event。
- **R5 读取无界且丢工具行**：固定 OMP `readRpcSubagentTranscript` 是 `file.slice(fromByte).text()` 读到 EOF（上游实现限制，子运行时内无法阻止）；桌面桥此前无界返回。现 `validateSubagentMessages` 加显式条目/消息上界与 `nextByte < fromByte` 拒绝（typed error）；读取改迭代 `entries`（含 entry id，稳定行身份）并映射 `toolResult` 为既有 tool 行；内容按 4 MiB 截断。工具行不丢失，reopen/增量读取行身份稳定。
- **R6 快照缺失不结算被错过的终止生命周期**：固定 OMP 会把终止子代理移出活跃 registry。`reconcile` 现把「先前 running、本快照缺席」的子代理呈现为 `aborted`（Pi 拓扑词汇）并恰好结算一次父 Task 行；重复空快照/已终止子代理不重复结算。
- **R7 订阅失败与已开放能力/文档矛盾**：`list/read` 现检查订阅级别，订阅未启用时抛 typed `capability-unavailable`（bridge 映射为 `ENGINE_CAPABILITY_UNAVAILABLE`）。prompt 仍可继续（仅子代理 surface 不可用），runtime status/IPC/渲染/测试/文档一致。
- **R8 文档**：ADR 0303 已按以上实际行为改写（见下）。

## 0.2 第二轮独立复审返修（S1-S4，2026-09-23）

第二轮独立复审发现 4 项阻断缺陷，已在本分支追加普通提交修复，均有行为回归覆盖（先红后绿）：

- **S1 父 stop 完全漏掉 child lifecycle 时仍泄漏 detached 子代理**：`hasActiveChildren()` 此前先 `if (!hasRunningChildren()) return false`，本地 registry 没看到 `started` 帧时完全跳过 `get_subagents`——正是订阅不可用/帧丢失/UI 从未打开 list 时必须由 snapshot 修复的场景。现父 turn 收敛后**始终**查询 `get_subagents`，snapshot 是"无 child"的唯一权威；合法 snapshot 中父 id 命中已观察 `task` call 的 running child 会触发既有 supervisor 进程组回收。RPC 拒绝/畸形采取保守可解释策略：观察到 task call 时不得谎报已确认无 child，改为 teardown 并记录原因。teardown 返回 `reaped:false`/`cleaned:false`/抛错时不再无条件 `closeRun()`+`subagents.reset()`+`taskCallTurn.clear()`（注释曾误称"process group is gone"）：只有确认 `reaped` 才清 registry/task-call 所有权，未确认时保留（与 supervisor 的 ownership-retained-for-retry 一致），迟到子帧仍可归因、后续 stop/dispose 可重试。`toreDown` 现如实等于 `result.reaped`。真实固定 OMP E2E 已移除预先 `bridge.listSubagents()` 预热（旧第 434 行会掩盖缺陷），改为靠 snapshot 查询证明 stop，并验证 child pid + 后代回收、无残留。
- **S2 renderer 增量读取覆盖/清空详情、reset 游标错误、错误态未呈现**：`useOmpSubagentRead` 此前每次 poll `setRun(result.run)`（第二批覆盖第一批），空增量被 helper 转成 `empty` 后 `setRun(null)`（稳定 child 2 秒后空 poll 从面板消失），`cursor.reset===true` 时把游标设 0（应继续 `nextByte`）。现初次读取建立完整行集、非 reset 增量按稳定 message id 合并去重并保留旧行、reset 响应替换集合、无新行保留现有详情、所有成功响应把游标前进到 `nextByte`（含 reset）。2 秒 poll 改为完成后再调度（单飞），杜绝慢请求永远因 sequence 失效；selection change/unmount 的 stale-response 序号守卫保留。`SubagentPanel`/`SubagentDetail` 现消费 hook 的 phase/errorDetail/reload，在既有 Pi 风格内呈现 loading/empty/typed error/retry（新增 i18n `panel.subagentLoading/Error/Retry` 8 语言）；Pi 会话保持原路径、不触发 OMP IPC。新增真实 mounted renderer 测试（`react-dom/client` + 最小 DOM shim + 可控 promise，非 wall-clock sleep）：挂载 `useOmpSubagentRead`，打桩 `window.piDesktop.invoke`，断言真实 `api.ts` channel 调用，覆盖初次完整行/空增量不清屏/第二批追加/reset 替换并从 `nextByte` 续读/loading·error·retry/慢请求与 selection change 不污染/Pi 不调用 `ompSubagentList/Read`。
- **S3 已存在 child 的 missing parent 仍被放行**：`ownedParent()` 此前只在 existing child 同时带不同 parent 时拒绝，`existing` 存在且新帧 `parentToolCallId===undefined` 时直接返回 true（会产生 1 个 settlement、状态改 completed、`unknownParentCalls=0`，与 ADR/验证文档"lifecycle/progress/snapshot missing parent 全部拒绝并计数"矛盾）。现每个 lifecycle/progress/snapshot 都必须携带非空 parent、与 existing child 的 owner 一致、且有该 runner 已观察 task call 的所有权证据；missing/unknown/conflicting 均自增 `unknownParentCalls`，不改变 child、不 settlement、不重归属。wire schema 保持真实 optional，tracker fail-closed。新增 existing child 的 terminal lifecycle missing parent、progress missing parent、snapshot missing/conflicting parent 行为测试。
- **S4 toolResult 绕过 4 MiB 内容上限**：`toToolRow` 此前把显示用 `content` 截到 4 MiB，却把原始 `message.content` 原样放入 `toolResult`（5 MiB string → `content.length=4194304` 而 `toolResult.length=5242880`，整个 UiMessage 跨 IPC 到 renderer，"任何无界结果都不越过桥"不成立）。现按固定 OMP durable `ToolResultMessage`（`{ content: blocks, details }`）做结构化有界投影：文本块与 `details` 各自 4 MiB 上限（`details` 递归截断字符串），图片/仅 provider 部件丢弃，text-only 结果投影为空串（渲染器读已截断的 `content` 字段，不复制镜像）；`content`/`toolResult` 及任何由 transcript entry 带入 UiMessage 的大字段均不越过总内容边界。新增超大 string、text parts、结构化/异常 tool result 的序列化大小与可读性测试，并保持稳定 entry id。

## 0.3 第三轮独立复审返修（B1，2026-09-24）

第三轮独立复审否定了"T17 已完成"，拆出 B1-B3 三项返修。B1 首实现于 `9d0acde`（下述回归均通过）；独立复审在 `9d0acde` 上进一步复现两项残余缺陷 **F1/F2**，由本提交修复（见 §0.4）。B2、B3 仍未解决，T17 不验收。

- **B1 回收未完成时的重试（首实现于 9d0acde；残余 F1/F2 见 §0.4）**：独立复现显示 `session/runner.ts` 的 teardown 未成功时仍 `closeRun()`，第二次 stop 命中 487-490 的 `nothing running` 早退、不再调用 supervisor——实际仍有存活进程组。现改为：teardown 未确认 `reaped && cleaned` 时记录可重试义务 `pendingReclaim`；第二次 stop 直接重跑同一 `teardown`（跳过协议 abort，绝不把旧父回合的 abort 重发到新回合）；pending 时 `prompt` 以 typed `stopping` 拒绝；只有确认 `reaped && cleaned` 才清义务并清 registry/task-call 所有权（保留迟到子帧归因）。`stop()` 加单飞（并发 stop 共享一次尝试，杜绝重叠 teardown）。桥接 teardown 包装补一次 `reclaimAll()` 扫目录（该初版仅覆盖 `reaped:true/cleaned:false` 单一路径，二次 stop 的 directory-only 债务仍会丢失——即 F1）。参考顺序：固定 PI 的 `TaskStop`（`agent-runtime/src/runtime.ts` 委托停止）是模型自调工具、无桌面侧进程组重试语义，PI 的 `provider-retry.ts` 是 provider HTTP 重试、与进程回收无关；OMP 无 per-child stop RPC；可复用语义来自本仓库 M2 supervisor 的 `reaped`/`cleaned` 独立判定与 ownership-retained-for-retry（`supervisor.ts` `performStop`/`reclaimAll`），B1 直接适配该契约，未臆造新语义。
- 新增回归（`packages/omp-runtime/src/session/subagent-runner.test.ts` 的 `pending reclaim retry` 5 例，先红后绿）：首败二成后第三停 `nothing running`、连续失败仍拒 prompt、teardown 抛错仍可重试、`reaped:true/cleaned:false` 目录债保留义务、并发 stop 单飞（可控 promise，无 wall-clock sleep）。
- 验证（`app/`，`nvm use 24`）：`@pi-desktop/omp-runtime` vitest **227 passed / 0 failed**（222 + 5 B1 回归，含真实固定 runtime 烟测）；desktop `node --test` 定向 OMP 用例全绿（`omp-subagent-bridge` 8、`omp-subagent-e2e` 3、`omp-session-ownership` 2、`omp-session-bridge`/`failclosed`/`configure`/`configure-ipc`/`delete-archive`/`host-mutation-gates`/`ipc-result` 共 68、`omp-session-e2e`/`concurrent-approval-e2e`/`persistence-e2e` 3，均为假 provider / 无付费模型）；`pnpm --filter @pi-desktop/omp-runtime exec tsc --noEmit` 与 desktop `pnpm typecheck` 通过；`git diff --check` 无输出。

## 0.4 B1 残余缺陷返修（F1/F2，2026-09-24）

独立复审在 `9d0acde` 上复现两项 B1 残余缺陷，均为可独立复现（隔离 fake-runtime/本地文件系统场景，无付费模型、无真实进程信号）：

- **F1 目录债在二次 stop 丢失**：`9d0acde` 的桥接 teardown 只在 `supervisor.stop()` 返回 `reaped:true/cleaned:false` 时补 `reclaimAll()`；但二次 stop 时 supervisor 已不拥有 runtime，`stop()` 回报 `nothing owned`（`cleaned:true`）而 `pendingCleanup` 仍为 1，回调跳过扫目录、runner 清 `pendingReclaim` 后误报成功——目录与债务皆不可达。修复（`omp-session.ts` teardown）：`stop.reaped` 且（`!cleaned` 或 `supervisor.pendingCleanup.length > 0`）即补 `reclaimAll()`，以 `pendingCleanup.length === 0` 为唯一 `cleaned` 判定；连续文件系统失败保留 pending、恢复后下一次 stop 清除债务；已 reap 记录绝不再次发信号（supervisor 的 `reaped`/`pid:0` 语义不变）。回归（真实 `SessionEntry` + 真实 `OmpRuntimeSupervisor` + 外部边界 chmod 0500，`omp-session-bridge.test.mjs`）：失败→重复失败→恢复→末次 no-op，全程断言 `pendingCleanup` 与实际目录存在，并含 pending 期间 typed prompt 拒绝与债务清除后干净 dispose。
- **F2 停期间短暂放行新 prompt**：`agent_end` 在 stop 等待 `get_subagents`/teardown 前已 `closeRun()`（state=idle/run=null），`prompt()` 只查 `pendingReclaim` 与 state、未查活动 stop，导致窗口内接受新代并随后被旧 stop 关闭。修复（`runner.ts`）：`prompt()` 增加 `this.stopping` 所有权检查（typed `stopping` 拒绝），覆盖 abort/收敛/快照/teardown/重试全窗口；`closeRun()` 增加代守卫（旧代完成/失败不得关闭已取代的新 run）。回归（`runner.test.ts` 可控 promise，先红后绿）：独立 hold 快照与 teardown 各拒 prompt、并发 pending-retry 拒 prompt、stop 期间 `agent_end` 不得关闭 stop 之后的新 run。

验证（`app/`，`nvm use v24.14.0`，Node v24.14.0，pnpm 10.34.5）：`pnpm --filter @pi-desktop/omp-runtime test` **231 passed / 0 failed**（227 + 4 F2 回归）；`pnpm --filter @pi-desktop/omp-runtime build` 0；`env -u SSH_ASKPASS node --test test/omp-session-bridge.test.mjs` **29 passed / 0 failed**（28 + 1 F1 真实 supervisor 集成）；`omp-subagent-bridge` 8、`omp-subagent-e2e` 3（含不先 list 的 detached-child 场景）、`omp-session-ownership`/`failclosed`/`configure`/`configure-ipc`/`delete-archive`/`host-mutation-gates`/`ipc-result` 42、`omp-session-e2e`/`concurrent-approval-e2e`/`persistence-e2e` 3 全绿；`pnpm --filter @pi-desktop/omp-runtime typecheck` 与 `pnpm --filter @pi-desktop/desktop typecheck` 0；`git diff --check` 无输出。两个独立 repro（`/tmp/m5-stop-prompt-race.mjs`、`/tmp/m5-bridge-cleanup-retry.mjs`）在修复后均按预期输出。

## 0.5 第四轮独立复审返修（C1，2026-09-24）

第四轮独立复审在 B1/F1/F2 已修复的基线上复现「回收成功后同一桌面会话续聊」仍断裂：`prompt → task 子代理 → stop → 目录清理失败 → 重试直到 reaped && cleaned → 同会话发下一条消息`。独立复现输出 `nextPrompt={refused:true,errorCode:"NOT_STARTED"}` 且 `runtimeStarts=1`（见 `/tmp/m5-bridge-cleanup-retry.mjs`）。本提交修复并追加行为回归，C1 待独立验收。

- **C1 根因**：`SessionEntry.ensureRunner` 只要 `this.runner` 非空就直接返回，即使其 runtime 已被成功 reap；supervisor 在成功 teardown 后正确清空 `currentRuntime`，但 entry 仍保留绑定死句柄的 runner；下一条 prompt 经 `ensureNativeSession` → `runtimeHandle()` 抛 `NOT_STARTED`。桌面 `agentAbort`/`agentStop` 只调 bridge.stop、不 dispose 会话，用户无法靠再发消息恢复（先 `dispose` 再建会话的测试不是该用户路径）。
- **修复（`apps/desktop/electron/main/runtime/omp-session.ts` + `packages/omp-runtime/src/session/runner.ts` + `ui-requests.ts`）**：
  1. **成功回收后退役死 runner、下次显式 prompt 重建 runtime/runner**：`ensureRunner` 在 `shouldRetireRunner()` 成立时 `retireRunner()`（detach 帧/失败 handler、`dispose`、置 null），随后单飞 `buildRunner` 重建。协议收敛停止（runtime 仍活，`currentRuntime()` 非空）或失败 teardown（`hasPendingReclaim()`）不退役；stop 进行中（`runState()==="stopping"`）不退役、不启动第二 runtime。
  2. **换进程后必须重发 switch_session**：新增 per-runtime `nativeSessionBound` 标志；退役时清它，但保留持久 `nativeSessionId`/`nativeSessionPath`。恢复路径在换进程后重发 `switch_session` + `get_state` 身份校验，绝不新建原生会话、绝不重放旧消息/工具。
  3. **turn 身份跨替换保持不同**：runner 增加 `generationSeed`（`OmpUiRequests` 起点）；退役时取 `currentGeneration()` 作下个 runner 的种子，使新进程的 turnId 续号而非重置为 1。
  4. **并发协调**：`runnerBuild`/`nativeSessionBuild` 两个受控 promise 单飞，杜绝重复 runner 与重复内容提交；`dispose` 复位 `nativeSessionBound` 且绝不意外重启 runtime。

- **参考实现/测试（借用规则，非照搬全局架构）**：固定 PI `apps/desktop/electron/main/runtime/sidecar.ts` `onExit`（清 `runtimeState.sidecar`、崩溃清理绑定其 crash turn、`superviseRestart` 请求替换）→ 借「清陈旧句柄 + 清理绑定旧 turn + 请求替换」；固定 PI `packages/host-runtime/src/runtime-supervisor.ts` + `runtime-supervisor.test.ts`（单飞重启、shutdown 后不重启）与 `runtime-service.ts` `attachSidecar` + `runtime-service.test.ts`（旧 sidecar/turn 事件不得作用于替换者）→ 借「单飞 + 旧事件不得落到新 turn + shutdown 不重启」；固定 OMP `packages/coding-agent/src/modes/rpc/rpc-mode.ts` `handleRpcSessionChange`（`switch_session` 非 cancelled 即 `subagentRegistry.clear()`）与 `get_state` 返回 `sessionId`/`sessionFile` → 借「换会话清 per-runtime 初始化态、恢复只经 switch_session/get_state、不重放」。OMP 是 per-session runtime，不照搬 PI 全局重启系统。详见 `app/docs/adr/0303` §6。

- 新增回归（`apps/desktop/test/omp-session-bridge.test.mjs` 6 例，真实 `SessionEntry` + 真实 `OmpRuntimeSupervisor` + 外部边界 chmod，先红后绿）：① 失败→重试→成功后同会话 prompt（无 dispose），断言 `runtimes.length===2`、新 runtime 命令序列 `["switch_session","get_state","set_subagent_subscription","prompt"]`（恰好一次 prompt）、turnId `...:2` 不复用；② 立即成功 teardown 后同会话 prompt 仍重建；③ 协议收敛停止复用活 runtime（`runtimes.length===1`、turnId `...:2` 续号）；④ pending cleanup 拒 prompt 且工厂不二次调用（`runtimes.length===1`）；⑤ 退役 runtime 的 handler 已 detach、旧帧不达新 turn、新 runtime 收到新 turnId 帧；⑥ dispose 未 reclaim 时保留会话所有权（不二次启动 runtime、重试 dispose 清债）。
- 扩展真实固定 OMP E2E（`apps/desktop/test/omp-subagent-e2e.test.mjs` 第三项，保留不先 list 的 detached-child 场景与本地假 provider）：停掉仍运行的 detached 子代理后，**同会话**显式新消息续聊，断言 `accepted`、turnId 与首轮不同、新 turn 收到 `agent_end`、`get_state` 报同一 `sessionId`；finally 全量 reclaim。

验证（`app/`，`nvm use v24.14.0`，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2）：独立 repro `OMP_REVIEW_APP=/home/vv/person/code/omp-desktop-m5-t17/app OMP_REVIEW_NEXT_PROMPT=true node /tmp/m5-bridge-cleanup-retry.mjs` 现输出 `nextPrompt={accepted:true,turnId:"omp-turn:review-cleanup:2"}`、`runtimeStarts=2`、`replacementCommands=["switch_session","get_state","set_subagent_subscription","prompt"]`；`pnpm --filter @pi-desktop/omp-runtime test` **231 passed / 0 failed**（含真实固定 runtime 烟测）；`env -u SSH_ASKPASS node --test test/omp-session-bridge.test.mjs` **35 passed / 0 failed**（29 + 6 C1 回归）；`omp-subagent-e2e` 3（含同会话续聊）、`omp-session-ownership`/`failclosed`/`configure`/`configure-ipc`/`delete-archive`/`host-mutation-gates`/`ipc-result`/`subagent-bridge`/`subagent-read`/`subagent-panel-render`/`subagent-panel-mounted` 共 60、`omp-session-e2e`/`concurrent-approval-e2e`/`persistence-e2e` 3 全绿；`pnpm --filter @pi-desktop/omp-runtime exec tsc -p tsconfig.json --noEmit` 与 `pnpm --filter @pi-desktop/desktop typecheck` 0；`git diff --check` 无输出。

## 0. 环境准备（固定子模块流程，与本轮代码无关）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 工作树依赖 | `pnpm install --offline --frozen-lockfile`（app/） | Done，1.9 s（store 复用） |
| OMP 工作区 | `bun install --frozen-lockfile`（upstream/oh-my-pi） | 414 packages（`tool-views.generated.js` 重生成，见 §7） |
| OMP 原生模块 | `bun run build:native`（`CMAKE`/`PATH` 注入 pyenv 3.12.13） | `pi_natives.linux-x64-modern.node` 构建成功（2m26s） |

## 1. 三方证据位置

| 事实 | 固定 PI-Desktop | 固定 OMP | 本项目落点 |
| --- | --- | --- | --- |
| 子代理帧 | `packages/agent-runtime/src/subagent.ts`（`SubagentRun.handleEvent` 只转发 message/tool 行）、`delegation-message.ts`（`settledDelegationMessage`/`taskMessageSnapshot`） | `packages/tui/src/overlays/session-observer-registry.ts`（`SubagentLifecyclePayload`/`SubagentProgressPayload`）、`packages/tui/src/tools/task.ts:1818`（`AgentProgress`）、`packages/coding-agent/src/task/types.ts:38`（`SubagentEventPayload`）、`modes/rpc/rpc-types.ts`（`RpcSubagentSnapshot`/`RpcSubagentMessagesResult`/`set_subagent_subscription`） | `packages/omp-runtime/src/session/subagent-frames.ts`（typebox 严格校验）、`subagents.ts`（每子代理 registry/转换/结算） |
| 拓扑读取 | `apps/desktop/src/lib/subagent-topology.ts`（`delegationId`/`status`/`startedAt`/`completedAt`/`delegations[]`/`stopped[]`）、`tool-display.ts`（`isDelegationStartTool("task")`） | — | 不改拓扑；`task` 工具结果 `details` 增补 `delegationId`/`agent`/`status`/`startedAt`/`completedAt` |
| 父归属 | `AgentEventEnvelope.parentToolCallId`/`agentName`（`types/agent.ts:304`）、`event-persistence.ts`（`subagentTagged`）、`session-coordination.ts`（`isStaleTerminalEvent` 对 `parentToolCallId` 的 terminal 事件返回 true） | `parentToolCallId` 在 lifecycle/progress/snapshot；`subagent_event` 只有 `{id,event}` | runner 用 `task toolCallId → {generation,turnId}` 把迟到的子代理帧归到发起回合 |
| 快照/读取 | — | `get_subagents`（存活子代理）、`get_subagent_messages`（按 `subagentId`/`sessionFile` + `fromByte` 字节游标） | runner `listSubagents`/`readSubagentTranscript`；`sessionFile` 只在 main/runtime 内部，列表与读取结果均不透出 |
| 单独停止 | `TaskStop`（PI 专有） | 无（RPC 命令联合体无 per-subagent stop；`hasUI=false`） | `stopSubagent` 恒拒（typed `capability-unavailable`） |
| 子代理审批 | `SubagentRun` 权限作用域 | `hasUI=false`；同一 `tool_call` 钩子；门 `extensions/omp-desktop-gate.ts` 的 `no-ui` 路由在子代理会话里 block | 沿用 M3 门（session/generation/kind 校验）；子代理 gated 工具 fail closed、无副作用；`mode: allow` 下恰好执行一次 |

## 2. 归属/能力矩阵

| 关注点 | OMP 事实（证据） | Pi 行为 | 本项目决策 |
| --- | --- | --- | --- |
| 子代理编排 | OMP 原生 `task` 工具 + 三类帧（E08/E11、`rpc-subagents.ts`） | Pi `Task`/`TaskWait`/`TaskList`/`TaskStop` | OMP 会话只由 OMP 编排；绝不启动 Pi Task 运行时、不重复任务、不翻译同名工具 |
| 父归属 | lifecycle/progress/snapshot 带 `parentToolCallId`（e08 fixture） | `AgentEventEnvelope.parentToolCallId` | OMP `parentToolCallId` → envelope 字段；子代理帧按发起回合归因 |
| 子代理身份 | lifecycle `id`（不透明） | `delegationId` | OMP `id` 即 `delegationId` |
| 状态 | lifecycle `started/completed/failed/aborted` | `SubagentOutcome` | `started→running`，其余同名 |
| 帧 | 三族（lifecycle/progress/event） | `AgentEvent` 词汇 | 严格校验；event → 每子代理转换器 |
| 订阅 | `set_subagent_subscription off/progress/events` | — | readiness 后一次 `events` |
| 快照 | `get_subagents` 存活子代理 | — | 存活期内 reconcile 补漏 |
| 详情读取 | `get_subagent_messages` 字节游标 | 子代理行持久化进父 store | 桥接按不透明 id 读取；`sessionFile` 不出桥 |
| 单独停止 | 无 per-child stop RPC | `TaskStop` | 恒拒（typed refusal），按钮保持禁用 |
| 子代理审批 | `hasUI=false` → 门 `no-ui` block | 父交互 UI | fail closed；永不借用父 UI；策略允许执行一次 |
| 重启 | 终止子代理从 registry 移除 | 持久 transcript | 不谎报运行、不重放；`turnLive:false`→`aborted` 诚实呈现 |

## 3. 用户路径

- **父会话发起 `task`**：OMP 原生 `task` 工具被识别为 delegation 节点（`isDelegationStartTool`），`toolResult.details` 增补 `delegationId`/`agent`/`status`/`startedAt`/`completedAt` → 现有拓扑卡片显示 creating/running/completed/failed/aborted 状态与父子关系。
- **子代理进度/最新输出**：`subagent_event` 帧经每子代理转换器转成 `message_*`/`tool_*` 行，带 `parentToolCallId`/`agentName`，流入现有 detail/`SubagentRun` 结构；`subagent_progress` 更新 registry 快照。
- **打开子代理详情**：`ompSubagentRead` → 桥 `readSubagentTranscript` → `get_subagent_messages`（字节游标、`reset`/`nextByte` 透出），映射为 `UiMessage[]`；`sessionFile` 不跨桥。
- **单独停止**：`ompSubagentStop` 恒返回 `capability-unavailable` 与准确解释（固定 OMP 无 per-child stop；停止子代理 = 停止父回合），UI 按钮保持禁用，不静默调用父 abort。
- **重启**：registry 为空，不谎报旧 detached 子代理仍在运行、不重放；持久父 transcript 里已记录的 completed/failed 如实呈现，其余 `running` 节点按 `turnLive:false` 呈现为 `aborted`（interrupted）。

## 4. 失败/取消矩阵

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 子代理 gated 工具（`hasUI=false`，`mode: ask`） | 门 `no-ui` 路由 block，`tool_end{isError:true}`，目标文件不变 | E2E（`existsSync(marker)===false`） |
| 子代理 gated 工具（`mode: allow`） | 恰好执行一次，目标文件内容正确，`tool_end` 恰一条且归因正确 | E2E 第二项 |
| 父 stop/dispose/shutdown | 沿用 M3 门：pending 决策作废、迟到 allow 不执行；进程组回收 | 既有 M3/M4 E2E + 本轮 `reclaimAll` 断言 |
| 迟到子代理帧（父回合已关） | 按发起回合 `turnId` 归因，不落到新代 | `subagent-runner.test.ts`（late generation） |
| 格式错误/归属不明帧 | 计数拒绝，不作父事件 | `subagent-frames.test.ts`、`subagents.test.ts`（orphan） |
| 快照补漏 | `get_subagents` reconcile 修复漏掉的 started/progress，不重复子代理、不重放副作用 | `subagents.test.ts`、bridge test |
| 单独停止 | 恒拒（typed `capability-unavailable`） | bridge/IPC test |

## 5. 验证命令与结果

所有命令在 `app/` 下执行，先 `nvm use 24`（非交互 shell 加载 `~/.nvm/nvm.sh`，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2，rustc stable 1.95.0）。OMP 子模块已按 §0 构建。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test` | **222 passed / 0 failed**（含真实固定 runtime 烟测；新增 subagent-frames/subagents/subagent-runner 三套 + 两轮返修用例） | 0 |
| `node --test test/omp-subagent-bridge.test.mjs`（`env -u SSH_ASKPASS`） | **8 passed / 0 failed** | 0 |
| `node --test test/omp-subagent-e2e.test.mjs`（`env -u SSH_ASKPASS`） | **3 passed / 0 failed**（真实固定 OMP + 假 provider） | 0 |
| （全量回归见 §6） | | |

新增定向测试（含返修）：
- `packages/omp-runtime/src/session/subagent-frames.test.ts`（帧校验、快照/消息响应、游标归一化、上界与游标不一致拒绝）
- `packages/omp-runtime/src/session/subagents.test.ts`（含 R3/R4/R6 返修：结算无 `parentToolCallId`、missing/unknown/conflicting 父、快照缺席→aborted 且幂等）
- `packages/omp-runtime/src/session/subagent-runner.test.ts`（含 R1/R4/R5/R7 返修：stop 回收运行中子代理、迟到 event 归旧回合、tool 行稳定 id、订阅 off fail-closed）
- `apps/desktop/test/omp-subagent-bridge.test.mjs`（8 项：桥 list/read/stop + IPC 真实 handler 路径 + Pi 路由不变 + 订阅拒绝 fail-closed）
- `apps/desktop/test/omp-subagent-e2e.test.mjs`（3 项：真实固定 OMP `task` 子代理端到端——三帧族、子身份、`parentToolCallId`、子工具归因、deny 无副作用、allow 恰好一次、快照、停止回收、**父 stop 回收仍在运行的 detached 子代理**）
- `apps/desktop/test/subagent-reload-projection.test.mjs`（R3：结算为根 Task 行、子行挂靠）
- `apps/desktop/test/omp-subagent-read.test.mjs`（R2：真实 `api.ts` 经组件数据路径解析/读取/映射；S2：新增 merge 去重）
- `apps/desktop/test/omp-subagent-panel-render.test.mjs`（R2：Pi/OMP 详情桥分流 SSR；S2：loading/empty/error/retry 可见）
- `apps/desktop/test/omp-subagent-panel-mounted.test.mjs`（S2：真实 mounted renderer 行为——挂载 `useOmpSubagentRead`、运行 effects、打桩 `window.piDesktop.invoke`、断言真实 `api.ts` channel；覆盖初次完整行/空增量不清屏/第二批追加/reset 替换并从 `nextByte` 续读/error·retry/慢请求与 selection change 不污染/Pi 不调用 OMP IPC）

## 6. 全量回归

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test` | **222 passed / 0 failed**（含真实固定 runtime 烟测） | 0 |
| `pnpm --filter @pi-desktop/shared test` | **968 passed / 0 failed** | 0 |
| `node --test test/*.test.mjs`（`env -u SSH_ASKPASS`，desktop 全量） | **2687 passed / 0 failed / 4 skipped**（2691 项） | 0 |
| `pnpm typecheck`（12/13 workspace 包） | 通过 | 0 |
| `pnpm build:js` | 通过（含 desktop renderer 打包） | 0 |
| `git diff --check` | 无输出 | 0 |

## 7. 关键限制与边界

- **`subagent_event` 需要 `--model`**：固定 OMP 仅在显式 `--model provider/model` 时转发子代理事件流；仅靠 `models.yml` 发现则子代理有 lifecycle/progress 但无 event（详情/转录不流）。M4 投影已钉住单一 provider/model，故 `omp-session-wiring.ts` 现同时传 `--model` 与投影。这是本轮发现的真实上游行为，已用 E2E 前后对照复现。
- **转录读取的上游 EOF 行为 vs 桌面输出上界**：固定 OMP `readRpcSubagentTranscript` 是 `file.slice(fromByte).text()` 读到 EOF（子运行时内无法阻止）；桌面桥因此对返回结果加显式上界——`SUBAGENT_MAX_ENTRIES`/`SUBAGENT_MAX_MESSAGES`（各 10000）超限即 typed 拒绝、`nextByte < fromByte` 拒绝、内容按 4 MiB 截断——任何无界结果都不会越过桥到渲染器或被保留。截断不静默跳过消息（超限整体拒绝，游标不推进）。`toolResult` 同样经结构化有界投影（`{ content, details }` 各 4 MiB，图片/仅 provider 部件丢弃，text-only 结果投影为空串），不复制镜像。
- **详情读取的增量累积与 reset**：`get_subagent_messages` 按 `fromByte` 返回增量。渲染器按稳定 entry id 合并去重并保留旧行、reset 响应替换集合、空增量不清屏、所有成功响应把游标前进到 `nextByte`（含 reset）；poll 完成后再调度（单飞）。上游每次读仍到 EOF，桌面靠游标增量读取。
- **父 stop 的漏 lifecycle 情形**：父 stop 收敛后**始终**查 `get_subagents`（不依赖本地 registry 是否已有 running child），以覆盖订阅不可用/帧丢失/UI 从未打开 list 的场景；RPC 拒绝/畸形时保守 teardown 且记录原因，不谎报已确认无 child。teardown 未确认 `reaped` 时保留 registry/task-call 所有权（可重试），确认后才清。
- **missing parent 的 tracker 策略**：lifecycle/progress/snapshot 每一族都必须带非空 parent、与 existing child 的 owner 一致、且命中已观察 `task` call；wire schema 保持真实 optional，tracker fail-closed——missing/unknown/conflicting 均自增 `unknownParentCalls`，不改变 child、不 settlement、不重归属。
- **单独停止关闭**：固定 OMP 无 per-child stop RPC，子代理 `hasUI=false` 无可信子进程句柄；`stopSubagent` 恒拒并如实说明（停止子代理 = 停止父回合，父回合停止也会回收该子代理）。未臆造父 abort 伪成功。
- **batch `task` 的拓扑卡（能力限制，产品决定）**：Pi 模型是「一个 Task 行 = 一个 delegation」。OMP batch（`tasks[]`）会在一行下多个子代理；现有拓扑卡以首个 child 为主 `delegationId`，各子代理行仍按 `parentToolCallId` 归入该卡。**这是显式的 UI 近似，不是完整兼容**：多子代理 batch 的首个子代理详情完整，其余子代理只能作为行归入该卡、无独立详情卡。单子代理（最常见、E2E 覆盖）完整。若需完整多子代理拓扑，须在既有 `delegations[]` 模型上扩展独立详情入口（产品决定，非本轮范围）。
- **重启边界**：固定 OMP 进程退出后无法重开 live 子代理 registry；桌面不谎报旧 detached 子代理仍在运行、不重放。持久父 transcript 已记录的 completed/failed 如实呈现，其余 `running` 按 `turnLive:false` 呈现为 `aborted`。
- **子模块状态**：`upstream/oh-my-pi` 与 `upstream/pi-desktop` 均保持干净（HEAD 与固定 SHA 一致）；`bun install` 的 `tool-views.generated.js` 重生成结果与提交一致，未产生未提交改动。
