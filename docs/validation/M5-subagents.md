# M5 验证记录：OMP 子代理面板与编排归属（T17）

状态：**T17 已验收**（已实现能力边界；验收代码基线 `ab07a888d6afb916561b80e5661ed27aa6be612a`，分支 `codex/m5-subagents`）。真实固定 OMP 子代理端到端验收与 macOS arm64 独立复审通过（见 §0.15 最终验收表）。验收范围仅为 T17 已实现能力边界，不代表 M5/M6/M7 全量、打包构建、付费 provider 或 Windows 已验收。历轮独立复审返修（R1-R8、S1-S4、B1-B3、C1、D1/D2、E1/E2、F1/F2）见 §0.1-§0.14。
基线提交：`d26444407fc963c2e7efd51bda7d1bd4a70e8bbd`；第二轮独立复审返修（S1-S4）以追加普通提交落在该基线上（见 `git log` 最新提交）。
固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`（本轮未修改）。
工作树：`/home/vv/person/code/omp-desktop-m5-t17`，分支 `codex/m5-subagents`。
传输/权限决策沿用 `docs/decisions/001-omp-transport.md`；本轮新增产品侧 ADR `app/docs/adr/0303-omp-subagent-surfacing.md`。

## 0.15 最终独立复审验收（2026-09-24）

T17 已按已实现能力边界验收。验收代码基线 `ab07a888d6afb916561b80e5661ed27aa6be612a`（分支 `codex/m5-subagents`）；本轮记录为单独的 docs-only 提交，验收代码 SHA 与记录提交分开，不伪造未来提交哈希。

| 平台 | 命令 / 范围 | 计数 | 退出 |
| --- | --- | --- | --- |
| macOS arm64（复审方，Node v24.14.0） | 根 `pnpm typecheck` / `build` | 全 JS 构建 + 全 workspace typecheck 通过 | 0 |
| macOS arm64 | `@pi-desktop/omp-runtime` test | 243 passed / 0 failed | 0 |
| macOS arm64 | `@pi-desktop/shared` test | 968 passed / 0 failed | 0 |
| macOS arm64 | `pnpm lint` | 75 files、style tokens OK | 0 |
| macOS arm64 | 五份真实固定 OMP E2E（本地假 provider） | 5 passed / 0 skipped | 0 |
| macOS arm64 | bridge 套件 | 58 passed | 0 |
| macOS arm64 | 全量 desktop `node --test test/*.test.mjs` | 2735 总数 / 2726 passed / 9 failed / 0 skipped | 1（9 项失败均为固定 PI 基线的 release 夹具中文路径缺陷；六份真实 OMP E2E（含并发审批）均在该全量内通过） |
| Linux x64（远程，Node v24.14.0） | 根 typecheck / build | 通过 | 0 |
| Linux x64 | `@pi-desktop/omp-runtime` test | 243 passed | 0 |
| Linux x64 | `@pi-desktop/shared` test | 968 passed | 0 |
| Linux x64 | desktop `node --test test/*.test.mjs`（`app/apps/desktop`，`SSH_ASKPASS` unset） | 2735 总数 / 2731 passed / 0 failed / 4 skipped | 0（4 项为非 darwin 显式跳过：dev-branding:141、macos-release-lane:86、macos-signing-watchdog:254/308） |
| Linux x64 | desktop style-token lint | 通过 | 0 |
| Linux x64 | 五份真实 E2E；lifecycle assertion wrapper；row 探针与 real-panel resume-poll 探针；symlink-TMPDIR bridge | 5 passed；25 passed；探针 0；50 passed | 0 |

macOS 全量 desktop 未宣称为绿：9 项失败已确认是固定 PI `0111e306c120ad5820688d7608cb37bad8fbcc1f` 基线的 release 夹具 URL.pathname/中文路径缺陷（相同测试 + 两个脚本在中文检出路径复现 0/9，未改动的 `git archive` 副本在 ASCII 路径 9/9）。该既有夹具修正登记到 M6/T22，此处不实现、不削弱其 release 检查。Linux 结果单独归属远程执行；部分旧命令管道接了 `tail` 而无 `pipefail`，不臆造独立退出码，仅记录底层测试/构建完成与计数。

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

## 0.6 C1 跟进返修（R1/R2/R3，2026-09-24）

第四轮 C1 修复了「回收成功后同会话续聊」的基本路径，但独立复审在 C1 基线上用真实 `SessionEntry` + 真实 `OmpRuntimeSupervisor`（仅外部进程边界用假 runtime）复现三项残余缺陷（repro 见 `/tmp/m5-session-restart-review.mjs`、`/tmp/m5-restore-stop-review.mjs`）。本提交修复并追加行为回归，待独立验收。

- **R1 替换后回复被覆盖**：`OmpEventConverter.mintId()` 的 `sequence` 每个 runner 从 0 起，替换 runtime 后新回复重铸 `omp:<session>:1`，渲染器按 id upsert 把旧回复覆盖（repro：`messageIds=["omp:review:1","omp:review:1"]`、`distinctMessages=false`、`projectedAssistantRows` 只剩 `reply-runtime-2`）。修复：`OmpEventConverterOptions` 增 `sequenceSeed`，runner 增 `messageSequenceSeed`（与既有 `generationSeed` 并行），`SessionEntry.retireRunner()` 捕获 `currentMessageSequence()`、`buildRunner()` 传给替换 runner，使 live 消息 id 跨替换续号；保留流式 start/update/end 同 id 与 durable-entry 稳定 id。
- **R2 停止未完成即替换并跳过恢复**：`shouldRetireRunner()` 只查 `runState()` 与 `pendingReclaim`，但 `agent_end` 已把可见 state 置 idle 而 teardown 仍拥有生命周期；且 `ensureNativeSession()` 在 `ensureRunner()` 退役/替换 runner 之前就能从 `nativeSessionBound` 早退，导致新进程跳过 `switch_session`/`get_state`（repro：`startsDuringStop=1`、`replacementCommands=["set_subagent_subscription","prompt","switch_session","get_state","prompt"]`、假 runtime 拒 `"replacement runtime was not restored before prompt"`）。修复：runner 增 `isStopping()`，`shouldRetireRunner()` 在 stop 进行中不退役、不重建；native 绑定改记 `nativeSessionRunner`（绑定到具体 runner 实例），早退需 `nativeSessionRunner === this.runner`，退役/替换后强制重发恢复。
- **R3 启动/恢复中停止被忽略**：`SessionEntry.stop()`/桥 `stop()` 在 runner 尚不存在或 `activeRunner()` 为空时立即返回 `nothing running`，既不取消 pending prompt 也不拥有正在启动/恢复的 runtime；release 后内容照常提交（repro：`stopSettledBeforeRelease=true`、`prompt.accepted=true`、`status.isRunning=true`）。修复：`SessionEntry` 增 `stopEpoch`（stop/dispose 同步自增），`prompt` 入口读 epoch、提交前复检（不一致即 typed `stopping` 拒绝）；`stop()`/`dispose()` 先 await 在途 `runnerBuild`/`nativeSessionBuild` 再停 runner/reclaim，已启动 runtime 保持被拥有并按既有合同收敛/回收，绝不复活已 dispose 的 entry。

| 借用规则 | 固定 PI 来源 | 固定 OMP 来源 |
| --- | --- | --- |
| 活跃助手身份唯一、durable 完成仅替换命名的临时行（R1 身份隔离，不移植 PI 原生持久化） | `packages/agent-runtime/src/native-pi-session.ts:390-447`、`native-pi-session.test.ts:574-606` | — |
| 同 id upsert 故意替换旧行，映射器不得复用旧消息 id（R1） | `apps/desktop/src/lib/session-transcript.ts:50-125`、`apps/desktop/test/session-transcript.test.mjs:109-119,151-178` | — |
| 生命周期所有权而非仅显示 idle；attachSidecar 旧事件/替换隔离；onExit 清陈旧句柄并请求替换（R2） | `packages/host-runtime/src/runtime-supervisor.ts`（并发 join、shutdown 不重启）、`runtime-service.ts` `attachSidecar`（约 280 行）、`apps/desktop/electron/main/runtime/sidecar.ts` onExit（约 239-300） | — |
| 恢复只经 `switch_session`+`get_state`、不重放；换会话清 per-runtime 初始化态（R2/R3） | — | `docs/rpc.md`、`packages/coding-agent/src/modes/rpc/rpc-mode.ts`（约 550 `handleRpcSessionChange`） |

新增回归（`apps/desktop/test/omp-session-bridge.test.mjs` 5 例，真实 `SessionEntry` + 真实 `OmpRuntimeSupervisor` + 外部边界可控 promise/假 runtime，先红后绿）：① R1 两次重建后三条回复保留各自 id 与原内容（经真实 `projectMessageEnd` 投影）；② R2 stop 进行中 racing prompt 以 typed `stopping` 拒绝、`startsDuringStop=0`、替换 prompt 先 `switch_session`/`get_state` 再 `prompt`；③ R3 stop 在 start/restore（含 replacement）四组合下取消 pending prompt、stop 不提前 settle、会话 idle；④ R3 dispose 在 start/restore 下取消 pending prompt 并干净回收；⑤ 两个并发 prompt 共享一个 runtime、仅其一启动 run。扩展真实固定 OMP E2E（`omp-session-e2e.test.mjs`，本地假 provider）：同会话停后续聊断言真实助手回复 `status:"complete"` 且无 `error`（不再只凭 `agent_end`）。

验证（`app/`，`nvm use v24.14.0`，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2）：`pnpm --filter @pi-desktop/omp-runtime test` **231 passed / 0 failed**；`node --test test/omp-session-bridge.test.mjs` **40 passed / 0 failed**（35 + 5 C1 跟进回归）；`session-transcript`/`omp-session-ownership`/`failclosed`/`configure`/`configure-ipc`/`delete-archive`/`ipc-result`/`host-mutation-gates`/`archive-renderer`/`subagent-bridge`/`subagent-read`/`subagent-reload-projection` **76 passed / 0 failed**；`omp-session-e2e`/`concurrent-approval-e2e`/`persistence-e2e` **3 passed / 0 failed**（真实固定 OMP + 假 provider）；`omp-subagent-e2e` **3 passed / 0 failed**；`pnpm --filter @pi-desktop/omp-runtime typecheck` 与 desktop `pnpm typecheck` 退出码 0；`git diff --check` 无输出。

## 0.7 C1 生命周期门收尾（D1/D2，2026-09-24）

第五轮独立复审在 `0092572` 上独立确认 R1/R2/R3 已修复（88 runtime + 63 desktop 定向用例通过），并进一步复现两项生命周期门残留缺陷（repro：`/tmp/m5-session-restart-review.mjs`、`/tmp/m5-restore-stop-review.mjs`，真实 `SessionEntry` + 真实 `OmpRuntimeSupervisor`，仅外部进程边界用假 runtime、无付费调用）。本提交修复并追加行为回归，**D1/D2 待独立验收**；**B2/B3 与最终 T17 验收仍待**。

- **D1 dispose 期间可启动孤儿替换**：`SessionEntry.dispose()` 只自增 `stopEpoch`、清 runner 后 `await reclaimAll`，从不同步把 entry 标记为对**新**操作关闭；epoch 只取消旧工作、不拒绝新工作。dispose 后到达的 prompt 捕获新 epoch、通过终值相等检查，在 supervisor 已释放所有权后重建 runtime；随后 `disposeSession` 报告清理成功并 `entries.delete(sessionId)`，把这个复活 entry 遗忘——替换 runtime 存活但桥已删其会话条目，`status`/`stop` 不可达（`disposeSession` 与 application dispose 皆可复现）。**关闭所有权的事实**：supervisor 自身 `setWorkingDirectory` 的门只覆盖其**自己的** stop（`runtime`/`starting`），先于外层 SessionEntry/桥接 dispose 结束，不能作为外层操作的唯一门。
- **修复（D1）**：`SessionEntry` 增 `closed`（`dispose` 首个 await 前**同步**置位，永久）；`prompt`/`ensureNativeSession` 入口 `assertOpen` 拒绝 closed entry 的新 prompt/运行时准备（`not-started`），复用/恢复的迟到完成不得重开同一 entry；桥接级增 `shuttingDown`，`dispose`（应用关闭）在取 `entries` 快照前同步置位、`entryFor` 拒绝关闭期间新建会话（`ENGINE_UNAVAILABLE`），区分"单会话 dispose 成功删除后允许新建 fresh entry"与"应用关闭一扇门关闭"；回收失败的 entry/supervisor 保留供 dispose 重试，但绝不用于再启动 runtime。
- **D2 启动/恢复停止期间的新 prompt 逃逸 stopEpoch**：stop 已自增 epoch，第二个 prompt 捕获新 epoch、在 stop 返回 `nothing running` 后照常提交（repro：`duringCancel.accepted=true`、`status.isRunning=true`）。`SessionEntry` 增 `stopping`（单飞，从同步入口贯穿 startup/restore 等待与 runner teardown/retirement）；`assertOpen` 在 stop 未决时拒绝新 prompt/运行时准备（`stopping`），先前已准入的工作仍由 epoch 复检失效；并发 stop 加入同一操作、不提前重开；stop/dispose 重叠无缝隙（dispose 先 join `stopping`），runner 显示的 idle 状态不重开准入。
- 新增回归（`apps/desktop/test/omp-session-bridge.test.mjs` 5 例，真实 supervisor + 假 runtime + 外部边界，先红后绿）：disposeSession 与 application dispose 的一微任务完成窗口各一例（dispose 期间无替换工厂调用/内容提交、成功后无孤儿、handler 全 detach）；整桥关闭期间新会话一例（`ENGINE_UNAVAILABLE`、不建 runtime）；启动/恢复 stop 四受控 case（第二个 prompt `stopping` 拒绝）；并发 stop/dispose 重叠一例（准入全程关闭、无第二 runtime）。
- **修正回复断言所属 E2E 路径**：`0092572` 的回复/无 error 断言加在 `omp-session-e2e.test.mjs`（普通续聊）。C1 的 detached-child 续聊用户路径在 `omp-subagent-e2e.test.mjs` 第三项，此前只断言 `agent_end` 与原生 id；本提交在该处补 `continued.turnId` 的非空 assistant 回复、无 `error`、同一原生 `sessionFile`（脚本化假 provider 回复"subagent finished"），保留不先 list 的 detached-child 场景与进程清理。

## 0.8 C1 全局关闭准入与入口重建身份（E1/E2，2026-09-24）

本轮基线 `24d7270`：D1/D2 的定向探针已由复审方独立通过（session bridge、ownership、subagent bridge、transcript 共 68 例 desktop，见 §0.7）。第六轮独立复审在 `24d7270` 上复现两项残留缺陷，本提交修复并追加行为回归，**E1/E2 待独立验收**；**B2/B3 与最终 T17 验收仍待**，不自证 C1/T17。

- **E1 既有会话绕过整桥关闭**（repro：`/tmp/m5-shutdown-admission-review.mjs`，两模式）：`entryFor` 在返回既有 entry **之后**才查 `shuttingDown`，且 `dispose` 顺序逐个 `entry.dispose`（逐个 await reclaim）。A 的回收被挂起时，空闲的既有 B 仍接收新 prompt、新 C 被拒但 B 放行；`OMP_REVIEW_PREADMITTED=true` 模式在关闭前已准入、仍在准备的 B prompt 在 A 回收等待期间恢复并提交内容。修复：`entryFor` 把 `shuttingDown` 检查移到既有 entry 返回之前（既有会话与新会话同拒 `ENGINE_UNAVAILABLE`）；`SessionEntry` 增 `closeAdmission()`（无 await：置 `closed` + 自增 `stopEpoch`），桥接 `dispose` 在首个回收 await 前对**所有** entry 同步调用，使所有既有与在途准备同步失效。保留单会话 dispose 语义、失败回收重试所有权、正常完成停止续聊。
- **E2 模型切换复用 live 消息/turn id**（repro：`/tmp/m5-disposal-replacement-review.mjs`）：`configure` 经 `disposeSession` 删除 `SessionEntry` 及其 `generationSeed`/`messageSequenceSeed`，新 entry 两个计数从 0 起，新回复重铸 `omp:<session>:1`/`omp-turn:<session>:1`，渲染器按 id upsert 覆盖旧回复（同会话 archive/unarchive 等其它 disposal/reopen 路径同险）。修复：`SessionEntry` 增 per-entry `contextId`（`randomUUID()`，构造时铸、entry 存活期不变），经 runner → converter 嵌入 live id（`omp:<session>:<context>:<n>`、`omp-turn:<session>:<context>:<n>`）；entry 移除/重建铸新 token，绝不与保留行冲突；同 entry 内 runtime 替换沿用同一 token + seed 续号；durable `omp:<session>:entry:<id>` 不嵌入 token、保持稳定，且不新增任何 tombstone map。

| 借用规则 | 固定 PI 来源 |
| --- | --- |
| 关闭前/后各复检 shutdown、并发操作单所有权（E1：同步关闭所有入口、在途工作失效） | `packages/host-runtime/src/runtime-supervisor.ts:80-135`、`runtime-supervisor.test.ts` |
| 唯一临时 live id + 精确 durable 替换（E2：live id 唯一，不依赖计数续号） | `packages/agent-runtime/src/native-pi-session.ts:390-447`、`native-pi-session.test.ts:574-606` |
| 同 id upsert 故意替换、映射器不得复用旧消息 id（E2） | `apps/desktop/src/lib/session-transcript.ts:50-125`、`apps/desktop/test/session-transcript.test.mjs` |
| 旧 sidecar/turn 事件不得落到替换者（E2：旧 runtime handler 全 detach） | `packages/host-runtime/src/runtime-service.ts` `attachSidecar`、`runtime-service.test.ts` |

新增回归（`apps/desktop/test/omp-session-bridge.test.mjs` 5 例，真实 `SessionEntry` + 真实 `OmpRuntimeSupervisor` + 外部边界可控 promise/假 runtime，先红后绿）：① 整桥关闭既有会话拒绝（`ENGINE_UNAVAILABLE`、无第二 prompt 命令、无 C 建 runtime、无残留 owner）；② 整桥关闭在途准备失效（`stopping`、不提交）；③ model 切换 `configure` → 下一条 prompt（distinct turn、两条回复保留、同一原生路径、restore-before-prompt）；④ `disposeSession` → 重开（同前）；⑤ 桥重建不与保留回复 live id 冲突。

验证（`app/`，`nvm use v24.14.0`，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2）：三探针先复现后通过——`/tmp/m5-shutdown-admission-review.mjs` 两模式现 `existingSession.refused=true`、`bPrompts=1`、`runtimeStarts=2`、`runtimeOwnersAfterShutdown=[]`；`/tmp/m5-disposal-replacement-review.mjs` 现 `distinctTurns=true`、两条 `projectedAssistantRows`、`oldHandlers=0`；`pnpm --filter @pi-desktop/omp-runtime test` **231 passed / 0 failed**；`node --test test/omp-session-bridge.test.mjs` **50 passed / 0 failed**（45 + 5 回归）；`omp-session-ownership`/`configure`/`configure-ipc`/`failclosed`/`delete-archive`/`session-transcript`/`omp-subagent-bridge` **52 passed / 0 failed**；`omp-session-e2e`/`omp-session-persistence-e2e` **2 passed / 0 failed**、`omp-subagent-e2e` **3 passed / 0 failed**（真实固定 OMP + 假 provider，无付费）；`pnpm --filter @pi-desktop/omp-runtime typecheck` 与 desktop `pnpm typecheck` 退出码 0；`git diff --check` 无输出。

## 0.9 B2 renderer 单飞与增量错误可见（2026-09-24）

第三轮复审拆出的 B2 指 `use-omp-subagent-read` 的单飞缺失与增量错误在真实面板中的可见性。独立复审在 `424efe8` 上用真实 `SubagentPanel`（非 HookProbe）+ 真实 `api.ts` + 受控 poll 定时器 + 外部 IPC 打桩复现：挂载 `running:true` 子代理产生两条 list/read 链（`readsAfterMount=2`），且失败续读后 `retainedRows=true` 但 `visibleError=false`/`retryVisible=false`（rows 一旦存在，增量错误与重试就从真实面板消失）。基线行为（本提交修改前，先红后绿）：

| 缺陷 | 根因 | 修复 |
| --- | --- | --- |
| 挂载即两条链（`listCalls=2`/`readCalls=2`） | `load()` 无单飞：初始 effect 与 poll effect 各自 `load()`；manual reload 亦可重叠 | hook 重写为单一协调器：`inFlightRef` 单飞 promise，初始/轮询/reload 三触发共享 `requestRead`，并发触发合并到在途读取，`requestSeq` 仅用于真正的陈旧失效（选择变更/禁用/卸载） |
| 增量错误/重试在 rows 存在时消失 | `SubagentPanel` 仅在 `delegate === undefined` 时传 `readStatus`；`SubagentDetail` 底部 `delegate ? rows : readStatus ? state : null` 互斥 | 面板对 `phase==="error"` 无论有无 rows 都传 `{phase:"error",detail,onRetry}`；详情把 `SubagentRunRows` 与 `SubagentReadState(error)` 并列渲染 |
| reset 游标未验证 | reset 响应 `{reset:true,nextByte:7}` 后未再读，未证明下一 `fromByte=7` | 测试补显式断言：reset 后下一次读 `fromByte=7` |
| 禁用 OMP 不失效在途读取 | 旧 invalidation effect 依赖 `[sessionId,delegationId]`，不含 `omp`，禁用后迟到完成仍写 state | invalidation 依赖加入 `omp`；停止轮询单独 effect（`!omp||!running` 即清已 armed poll），在途读取允许自行结算 rows |

借用语义（PI history 与 OMP 字节游标不同，非同一 API）：

| 借用规则 | 固定 PI 来源 |
| --- | --- |
| pending-read 守卫 + 完成时以对象身份判陈旧 + `reportError` 保留既有行 | `apps/desktop/src/stores/runtime/transcript-reading-runtime.ts` `loadTranscriptPage`/`reportError` |
| 测试夹具根用 `realpathSync(mkdtempSync(...))` 对齐生产 restore 边界的 canonical 化 | `apps/desktop/test/npm-executable.test.mjs:35` `fixture()` |

**PI 不提供本适配器的 2 秒轮询算法**：固定 PI `transcript-reading-runtime.ts` 及其 `transcript-reading.test.mjs` 跟随 live/persisted transcript 变更（deferred reads、coalescing、canceled ownership、new-turn transitions），不存在"完成后调度下一 poll"的定时续读端点。本适配器的 `POLL_INTERVAL_MS = 2_000` 轮询与"完成后 2s 再调度下一 poll（单飞）"是 **OMP 适配器自身的协调器行为**（`use-omp-subagent-read.ts`），仅借用 PI 的**请求归属/陈旧判据**语义（pending-read 守卫、完成时以对象身份判陈旧、错误保留既有行），而非其轮询实现；受控 deferred promise 的测试写法沿用 PI 测试约定。慢请求不被 interval 永久覆盖由 `inFlightRef` 单飞 + 完成后才调度保证。

前置（独立测试夹具提交，非产品改动）：`shutdownAdmissionHarness`/`modelSwitchHarness` 根从 `mkdtempSync(tmpdir())` 改为 `realpathSync(mkdtempSync(...))`，否则 macOS `/var` 别名与生产 restore 边界的 `/private/var` canonical 化不一致，5 项新 E1/E2 回归在 `switch_session` 抛 `incorrect session binding`。Linux 以 `TMPDIR` 指向隔离 symlink 复现（先 5 失败后通过），随后清理夹具。

新增回归（先红后绿，真实 `api.ts`/`window.piDesktop.invoke`，受控 promise/定时器，非 wall-clock）：
- `apps/desktop/test/omp-subagent-panel-mounted.test.mjs` 3 例：① running 子代理单飞——挂载恰好一次读、完成后 2s 再 poll、停止即清 armed poll；② manual reload 与在途慢读合并（不新增第三条链）；③ 禁用 OMP 失效在途读并丢弃迟到结果。
- `apps/desktop/test/omp-subagent-panel-real.test.mjs` 1 例（真实 `SubagentPanel`，非 HookProbe，仿复审脚本）：挂载 1 读 → 失败续读后 rows 保留 + 错误可见 + "Try again" 按钮 → 点击真实渲染重试恰好一次额外读、错误清除、rows 保留。
- 既有 reset 用例补 `fromByte=7` 断言（reset 后下一条请求显式续读）。

验证（`app/`，`nvm use v24.14.0`，Node v24.14.0，pnpm 10.34.5，`env -u SSH_ASKPASS`，`--test-force-exit`）：`omp-subagent-read` **5 passed**、`omp-subagent-panel-render` **2 passed**、`omp-subagent-panel-mounted` **6 passed**（3 旧 + 3 B2）、`omp-subagent-panel-real` **1 passed**；共享面板 PI 回归 `subagent-panel` 7、`subagent-transcript` 17、`transcript-search-rendering` 1、`work-panel` 24、`tool-presentation` 30、`transcript-reading` 14 全绿；`pnpm --filter @pi-desktop/desktop typecheck` 退出码 0；`git diff --check` 无输出。未重跑全量 runtime/E2E（renderer-only 变更，最终 T17 回归随 B3）。

## 0.10 B2 follow-up：运行恢复时续读与完整归属覆盖（2026-09-24）

独立复审在 B2 交付 `250fe6e` 上确认：test-only 夹具 canonical 化提交 `182f88a1939909f856ce9a0984d3e9a5ee988b1c` 被接受；真实 `SubagentPanel` 挂载探针默认模式全部通过（挂载 1 读、增量错误后 rows 保留、错误/重试可见、每次重试 1 读、恢复输出并清错误），macOS 上 132 项定向 desktop 测试全通过、退出 0。

独立复审仍复现一项残留缺陷：`use-omp-subagent-read.ts` 只在 `running` 变 false 时清 timer；`running` 随后变 true 时直接 return、不调度也不读取。无在途请求时没有任何东西能调度下一次 poll；挂载时 idle、首次读结束后会话才开始 running 的面板同样无法恢复轮询。独立复现（`/tmp/m5-real-panel-review.mjs`，真实 `SubagentPanel` + 真实 `useAppStore.runningSessions` + 真实 `api.ts`，仅 IPC/定时器受控）：`resumedPolling=false`、`readsAfterResume=3`、退出 1。

修复（本提交）：轮询跟随 `running` 的 false→true 转变恢复——新增 `prevRunningRef` 检测转变，在 `omp && running` 且先前非 running 时经同一 `requestRead` 协调器续读（有在途读则合并、否则新起一条链），该读完成后重新 armed 下一 poll；累计 rows 与游标保留（`sessionId`/`delegationId`/`omp` 变化才重置）。重复 true 渲染不重启 timer、不产生并行读；停止/禁用/卸载的取消与陈旧完成隔离保持不变。修正 §0.9 借用表——PI `transcript-reading` 不提供 2 秒轮询，该轮询是本适配器自身行为。

新增回归（先红后绿，受控 promise/定时器）：
- `omp-subagent-panel-mounted.test.mjs` +6：① idle→running 恢复（续读自保游标、恰好 1 读 + 1 poll、rows 累积）；② running→stopped→running 恢复；③ running 挂载 + deferred 初始读恰好 1 条链；④ timer armed 时 manual reload 恰好 1 次读、完成后恰好 1 poll（相对完成调度）；⑤ 同实例选择更新时旧/新读都 pending，旧成功不替换 rows、不 clear 新归属、不 re-arm 旧 poll；⑥ 旧错误不 surface 到新选择、不 re-arm。
- `omp-subagent-panel-real.test.mjs` +1：生产 `SubagentPanel` keyed 选择 remount（`TranscriptDisclosureProvider key`），旧 pending 读完成后不替换新选择 rows、不启动额外读。

验证（`app/apps/desktop`，Node v24.14.0，`node --test`）：`omp-subagent-panel-mounted` **12 passed**（6 旧 + 6 本提交）、`omp-subagent-panel-real` **2 passed**；独立探针默认与 resume 两模式退出 0（`resumedPolling=true`、`readsAfterResume=4`）。先红后绿：在 `250fe6e` 基线（`git stash` 掉本提交 hook）上 `idle→running`/`running→stopped→running` 两例复现缺陷（断言 `1 !== 2`），恢复后通过。

状态：**B2 follow-up 已实现并独立通过**；B3（总 UTF-8 预算）已独立通过、平台（macOS 夹具可移植性）已独立确认，最终 T17 验收仍待。

## 0.11 第三轮复审返修（B3，2026-09-24）：总 UTF-8 预算

独立复审在 B1/F1/F2、C1、D1/D2、E1/E2、B2 已修复的基线上复现「工具行序列化尺寸」缺陷：`events.ts` 给 `content`、复制的 envelope 文本与 `details` 各 4 MiB 上限，且按 UTF-16 `.length` 计数、`boundValue` 不计 key/数字/布尔/null/容器语法与 JSON 转义。整行序列化尺寸独立实测（pre-B1 基线）：5 MiB ASCII 字符串 4,194,514 字节；5 MiB 文本块 + 5 MiB details 12,583,183 字节；Emoji 输入 8,388,818 字节。扩大后的复审探针 `/tmp/m5-row-budget-review.mjs`（`OMP_REVIEW_APP` 指定 app 路径）进一步复现：转义控制符 7,000,210、对象键 5,338,051、标量数组 5,100,271、assistant 文本+thinking 8,388,744，且「前导 ASCII + emoji」在代理对中间被切断（`wellFormed=false`）；探针断言全部结果、基线退出 1。

参考顺序（先 PI 后 OMP，借规则而非照搬全局架构）：
- 固定 PI `apps/desktop/src/lib/tool-presentation.ts:152/171/180` `toolResultPayload`/`delegateReport`/`envelopeTextOf`：空 toolResult 读 `row.content`、结构化结果读 `details`、delegation 报告与 lifecycle 摘要读 envelope 文本块——envelope 文本不能整块丢弃。
- 固定 PI `packages/agent-runtime/src/custom-system-prompt.ts` `limitUtf8` + `custom-system-prompt.test.ts`（multibyte 边界）：按码点累计 UTF-8 字节、在码点边界切（`end += char.length`），提供 Unicode 安全字节截断语义，**不是**完整序列化 JSON 预算算法。
- 固定 OMP `packages/coding-agent/src/modes/rpc/rpc-subagents.ts` `readRpcSubagentTranscript`：durable entries（`{id,parentId,timestamp,message}`）、物理字节游标 `nextByte = startByte + byteLength(completeText,"utf8")`、未完成末行回退、`startByte > size` 时 reset。
- 固定 OMP `packages/ai/src/types.ts` `ToolResultMessage`（`{role,toolCallId,toolName,content:blocks[],details?,isError,timestamp}`）+ `packages/agent/src/agent-loop.ts` durable tool-result 构造。
- 上游 `subagent-output-limit` 测试关乎**模型 token 上限**，不作为桥字节预算证据。

修复（`app/packages/omp-runtime/src/session/events.ts`，未改固定上游）：单一共享序列化 UTF-8 预算 `ROW_BUDGET_BYTES = 4 MiB` 覆盖一行 durable UiMessage 的所有载荷字段（`content`/`thinking`/`toolResult`）。先以「空占位骨架」量出固定 envelope（id/role/时间戳/工具身份/状态 + 各载荷键与结构语法）并扣除，剩余全部分给载荷；字符串按 `JSON.stringify` 的**转义后** UTF-8 字节计费（`"`/`\`→2、五种具名控制→2、其余 C0→`\u00XX` 6、孤立代理对→6、其余按码点 UTF-8 宽度），`boundValue` 递归计费 key/引号/冒号/逗号/括号/数字/布尔/null；截断按码点行走（绝不切代理对）并追加 `…`。text-only 结果只投影 `content`（`toolResult=""`，渲染器读 `content` 字段）；结构化结果 `content=""`、文本与 `details` 共享同一预算放进 envelope——去掉重复镜像，delegation report/lifecycle summary 所需 envelope 文本块保留。工具行与 assistant 行（含字符串/数组 content、thinking）经同一 `toToolRow`/`toUiMessage` 走同一预算。整行 `Buffer.byteLength(JSON.stringify(row),"utf8")` 恒 ≤ 4 MiB（固定 envelope 已先扣除，无需额外 allowance）。

新增回归（先红后绿）：
- `packages/omp-runtime/src/session/events.test.ts` durable entry 段重写 + 8 新例：大 ASCII、多文本块、大 content+大 details 共享、CJK/emoji、前导 ASCII 不切代理对、转义引号/反斜杠/控制符、对象键、标量数组、字符串 form assistant、content+thinking 共享、小载荷结构不变、跨重读与 reset 稳定 entry id；全部断言整行序列化 UTF-8 字节 ≤ 4 MiB。
- `apps/desktop/test/omp-subagent-presentation.test.mjs`（新，6 例）：真实 `OmpEventConverter.convertEntry` 投影正常 read/bash/unknown/Task/TaskWait 结果，跑真实 PI `toolResultPayload`/`buildToolPresentation`/`hasToolDetails`/`runOutcome`，断言结构化 details 解开、text-only 走 content、delegation report 保留在 envelope 文本块、lifecycle roster 读 `details.delegations`、unknown 退化为字段。

验证（`app/`，Node v24.14.0，pnpm 10.34.5）：`pnpm --filter @pi-desktop/omp-runtime test` **239 passed / 0 failed**（+12 B3 回归，含真实固定 runtime 烟测）；`node --test test/omp-subagent-presentation.test.mjs` **6 passed**；复审探针退出 0，实测尺寸（字节，均 ≤ 4,194,304）：contentAndDetails 4,194,304、emoji 4,194,301、surrogateBoundary 4,194,302（`wellFormed=true`）、escapedControls 4,194,303、objectKeys 4,194,221、scalarArray 4,194,301、assistantString 4,194,304、assistantTextAndThinking 4,194,304；定向 desktop 回归 `omp-subagent-read` 5、`omp-subagent-bridge` 8、`subagent-reload-projection`、`omp-subagent-panel-mounted` 12、`omp-subagent-panel-render` 2、`tool-presentation` 30 全绿；`pnpm --filter @pi-desktop/omp-runtime typecheck` 与 `pnpm --filter @pi-desktop/desktop typecheck` 退出 0；`git diff --check` 无输出。

状态：**B3 字节/Unicode 证据已独立通过，两处行为缺陷由 §0.12 跟进提交修复并独立通过**；平台（macOS 夹具可移植性）已独立确认，最终 T17 验收仍待。

## 0.12 B3 follow-up：短答案保留 + 结构化截断指示（2026-09-24）

独立复审在 B3 基线上复现两项行为缺陷（探针 `/tmp/m5-row-meaning-review.mjs`，基线退出 1）：

- **大思考块擦除短答案**：`toUiMessage` 先扣 `thinking` 再扣 `content`，4 MiB+1024 字节思考 + 文本 `FINAL-ANSWER` 时整行恰 4,194,304 字节但 `content` 为空，`buildSubagentRun` 只出 `["thinking"]`；共享 helper 同样被 live `message_start`/`message_end` 调用，live 完成路径同样丢失答案。
- **结构化截断静默**：`boundValue` 对数组/对象超出预算时静默 break，300,000 个 `Number.MAX_SAFE_INTEGER` 变成 246,707 项（53,293 静默省略），行内与真实 `buildToolPresentation`/`toolResultChips` 输出均无截断指示。

修复（`app/packages/omp-runtime/src/session/events.ts`，未改固定上游、未改原生 transcript 内容/游标）：
- **分配优先级**：`toUiMessage` 先扣 `content`（最终答案）再扣 `thinking`；超大思考块不再擦除短答案，普通 reasoning+answer 在合计未超界时完整保留，整行仍 ≤ 4 MiB。该 helper 同时服务 durable `convertEntry` 与 live `message_start`/`message_end`，故 live 完成路径（含最终 `message_end`）一并修复——这是预期共享行为，非引入新执行/持久化语义。
- **结构化截断指示**：`ByteBudget` 增 `truncated` 标志（`boundString` 追加 `…`、`boundValue` 数组/对象提前 break 时置位）；`boundedToolResult` 预留 ≤32 字节、仅在确实丢弃时写入既有 PI 契约 `details.truncated:true`——record `details` 直接增补该键，非 record `details`（数组/标量）包裹为 `{truncated:true,value}`，整字段被丢弃时置 envelope 级 `truncated:true`；渲染走既有 `toolResultChips`（`details.truncated` → `truncated` chip）与 `recordBlocks`/`safeJson` 兜底，不虚构原始计数。

新增回归（先红后绿）：
- `packages/omp-runtime/src/session/events.test.ts` +4：超大思考不擦短答案、紧预算下含转义/emoji 的短答案完好、live `message_end` 保留短答案、大字符串先于后续字段（`count` 被丢弃且 `truncated:true`）；对象键/标量数组两例改为断言 `truncated:true` 与包裹后的 `value` 数组。
- `apps/desktop/test/omp-subagent-presentation.test.mjs` +3：标量数组/对象键/大字符串先于后续字段，经真实 `toolResultChips`（断言 `[{role:"truncated"}]`）与 `buildToolPresentation` 呈现截断，且整行字节 ≤ 4 MiB。

验证（`app/`，Node v24.14.0，pnpm 10.34.5）：`pnpm --filter @pi-desktop/omp-runtime test` **243 passed / 0 failed**；定向 desktop `omp-subagent-read`/`omp-subagent-presentation`/`omp-subagent-panel-render`/`omp-subagent-panel-mounted`/`tool-presentation`/`assistant-turns` **75 passed / 0 failed**；复审探针 `/tmp/m5-row-budget-review.mjs` 8/8 与 `/tmp/m5-row-meaning-review.mjs` 全断言均退出 0（`answerPreserved` 两路径 true、`presentationMarksTruncation` true、两行字节均 ≤ 4,194,304）；`pnpm --filter @pi-desktop/omp-runtime typecheck`、`pnpm --filter @pi-desktop/desktop typecheck`、`git diff --check` 退出 0。

状态：**B3 follow-up 的短答案保留与普通结构化标记已实现，两路径独立通过；整字段 details 丢弃的截断指示（§0.13）已实现并独立通过**；平台（macOS 夹具可移植性）已独立确认，最终 T17 验收仍待。

## 0.13 B3 follow-up 残余：整字段 details 丢弃时的截断指示（2026-09-24）

独立复审在 B3 follow-up 基线上复现一条残余指示路径（探针 `/tmp/m5-row-meaning-review.mjs` 新增两例，基线退出 1）：`boundedToolResult` 在 `details` 整字段装不下时把它丢弃、并把截断标志打在 envelope 顶层（`{content, truncated:true}`，§0.12 的第三分支）。但 PI 的 `toolResultPayload` 在 `details` 缺席时返回 `envelopeText`（保留的文本正文），`toolResultChips` 只读结果里的 `details` record——于是 envelope 顶层的原始标志被忽略，而保留文本又没有 `…`，整字段被丢弃时没有任何可见指示。基线实测两例 `bytes=4194283`、`envelopeKeys=["content","truncated"]`、`lateDetailsRetained=false`、`presentationMarksTruncation=false`、退出 1。

修复（`app/apps/desktop/src/lib/tool-presentation.ts`，仅演示器边界，未改 converter/预算逻辑、未改固定上游、未改原生 transcript 内容/游标）：`toolResultChips` 在 `details` 非 record 且 envelope 顶层 `truncated===true` 时仍推进 `truncated` chip，再照旧早退。保留的 content 正文仍经 `toolResultPayload` → output block 可见，不被 marker-only 对象替换；普通未截断文本/小结构化载荷不变（无 envelope 级 `truncated`，不产生假 chip）。

新增回归（先红后绿，`apps/desktop/test/omp-subagent-presentation.test.mjs` +2）：
- 近边界（content 恰好装下、`details` 装不下）与超边界（`details` 再多 1024 字节）两例，断言整行字节 ≤ 4 MiB、`toolResultChips` 为 `[{role:"truncated"}]`、`toolResultPayload` 返回保留正文且 `buildToolPresentation` 出 output block 文本一致。
- 普通未截断文本（小结构化 + text-only）不获得 chip。

验证（`app/`，Node v24.14.0，pnpm 10.34.5）：`node --test test/tool-presentation.test.mjs test/omp-subagent-presentation.test.mjs test/assistant-turns.test.mjs test/subagent-transcript.test.mjs test/session-message-presentation.test.mjs test/work-panel-presentation.test.mjs` **82 passed / 0 failed**；复审探针 `/tmp/m5-row-budget-review.mjs` 8/8 与 `/tmp/m5-row-meaning-review.mjs` 全断言退出 0（近/超边界 `presentationMarksTruncation=true`）；`pnpm --filter @pi-desktop/desktop typecheck` 退出 0；`git diff --check` 无输出。仅演示器改动、未改 converter 预算逻辑，故未重跑 243 runtime 全量与 E2E。

状态：**B3 follow-up 的短答案/普通结构化标记两路径已独立通过，整字段 details 丢弃指示已实现并独立通过**；平台（macOS 夹具可移植性）已独立确认，最终 T17 验收仍待。

## 0.14 T17 夹具可移植性返修（macOS/`/proc` 缺失 + 封闭 PATH，2026-09-24）

独立复审在 `01ce56a` 基线上于 macOS 本地复现五项夹具可移植性缺陷（Linux 全部通过、退出 0，仅 macOS 失败），本提交为 test-only 修复、已由复审方于 macOS arm64 独立确认（五份 E2E 5 passed / 0 failed、58 bridge tests、diff check、进程助手 10 轮 shell-quoting 往返与 owned-child PID/marker 存活断言均通过）；最终 T17 回归门仍待（最终独立复审待验收）。

| 缺陷 | 根因 | 修复 |
| --- | --- | --- |
| `omp-session-e2e` 的 `node run-tests.mjs`/`node long-task.mjs` 退出 127 | bash 工具在封闭运行时 PATH（`isolation.ts`）内解析不到 NVM 之外的全局 `node` | 命令改用 `shellQuote(process.execPath)`（执行测试的解释器自身），并对 long-task 路径/identity 路径做 POSIX shell 引号 |
| `omp-session-persistence-e2e:134` 前缀断言失败 | `mkdtempSync(tmpdir())` 保留 macOS `/var` 别名，产品恢复边界 `realpathSync` 成 `/private/var`，`sessionAPath.startsWith(sessionDir)` 比较不同别名 | `makeScratch` 用 `realpathSync(mkdtempSync(...))` canonical 化（沿用 `182f88a` 与 `npm-executable.test.mjs:35` 的夹具约定） |
| `omp-subagent-e2e` 第三项 `node <long-task> <identityPath>` 无法启动 | 同封闭 PATH | 同上，`process.execPath` + 引号 |
| `omp-subagent-e2e` 的 `pidAlive` 只读 `/proc/<pid>/stat`，macOS 返回 false（正向存活断言误判为死亡） | `/proc` 在 macOS 不存在 | 共享 `pidAlive`：Linux 读 `/proc/<pid>/stat` 状态以区分僵尸（`Z`/`X`），无 `/proc` 时回退 `process.kill(pid, 0)`（ESRCH=死亡、EPERM=存活），缺 `/proc` 绝不读作「死亡」 |
| `omp-session-e2e`/`omp-subagent-e2e` 的 `processAlive(marker)` 只扫 `/proc`，缺 `/proc` 静默返回 false（清理断言可空洞通过） | 同上 | 共享 `commandLineAlive(marker)`：POSIX `ps -axo pid=,command=`（BSD `-ax` 双平台有效），进程表不可读时抛错而非返回 false |

新增共享夹具助手 `app/apps/desktop/test/helpers/omp-e2e-process.mjs`（`shellQuote`/`pidAlive`/`commandLineAlive`），会话/子代理两个 E2E 共用（消除重复的存活检测代码）；`processAlive(marker)` 在子代理 E2E 原为死代码，已删除。三份 E2E 的 `finally` 改为嵌套 try/catch 收集清理错误、逐个独立回收 provider/进程/目录并以 `AggregateError` 汇总上报（不再 `.catch(() => undefined)` 静默吞掉 dispose/reclaim 失败；persistence 补上 `dispose().ok` 断言）。detached-child「停止前不预先 list」与「同会话续聊」断言原样保留。

验证（工作树 `app/apps/desktop`，Linux x64，`nvm use v24.14.0` → Node v24.14.0，pnpm 10.34.5，`env -u SSH_ASKPASS`；基线 `3a6df0df` + OMP `d49918fa` + PI `0111e306`）：
- 五份真实固定 OMP + 本地假 provider E2E（`omp-session-e2e` 1、`omp-session-persistence-e2e` 1、`omp-subagent-e2e` 3）：`node --test test/omp-session-e2e.test.mjs test/omp-session-persistence-e2e.test.mjs test/omp-subagent-e2e.test.mjs` → **5 passed / 0 failed / 0 skipped，退出 0**。
- bridge 套件在 symlink `TMPDIR` 下（复现 macOS `/var`→`/private/var` 别名）：`TMPDIR=<symlink> node --test test/omp-session-bridge.test.mjs` → **50 passed / 0 failed，退出 0**。
- `omp-subagent-bridge.test.mjs` → **8 passed / 0 failed，退出 0**。
- `git diff --check` 退出 0；未改 `.ts`，故未重跑 typecheck。

限制：macOS arm64 由复审方于本基线独立跑通（五份 E2E 5 passed / 0 failed、58 bridge tests、进程助手 10 轮往返及 PID/marker 存活断言），为夹具层面的 macOS 验收、非 Windows 或打包发布验收；Windows 未声明；本地 Linux x64 完整回归见任务看板。

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
- **转录读取的上游 EOF 行为 vs 桌面输出上界**：固定 OMP `readRpcSubagentTranscript` 是 `file.slice(fromByte).text()` 读到 EOF（子运行时内无法阻止）；桌面桥因此对返回结果加显式上界——`SUBAGENT_MAX_ENTRIES`/`SUBAGENT_MAX_MESSAGES`（各 10000）超限即 typed 拒绝、`nextByte < fromByte` 拒绝——任何无界结果都不会越过桥到渲染器或被保留。截断不静默跳过消息（超限整体拒绝，游标不推进）。单行/单工具结果的尺寸由 B3 的**单一共享序列化 UTF-8 预算**约束（§0.11）：一行 durable UiMessage 的所有载荷字段（`content`/`thinking`/`toolResult`）合计 ≤ 4 MiB，固定 envelope 先扣除，字符串按 JSON 转义后 UTF-8 字节计费、按码点截断并加 `…`，图片/仅 provider 部件丢弃，text-only 结果投影为空串（渲染器读 `content`），结构化结果的文本与 `details` 共享预算且不复制镜像。
- **详情读取的增量累积与 reset**：`get_subagent_messages` 按 `fromByte` 返回增量。渲染器按稳定 entry id 合并去重并保留旧行、reset 响应替换集合、空增量不清屏、所有成功响应把游标前进到 `nextByte`（含 reset）；poll 完成后再调度（单飞）。上游每次读仍到 EOF，桌面靠游标增量读取。
- **父 stop 的漏 lifecycle 情形**：父 stop 收敛后**始终**查 `get_subagents`（不依赖本地 registry 是否已有 running child），以覆盖订阅不可用/帧丢失/UI 从未打开 list 的场景；RPC 拒绝/畸形时保守 teardown 且记录原因，不谎报已确认无 child。teardown 未确认 `reaped` 时保留 registry/task-call 所有权（可重试），确认后才清。
- **missing parent 的 tracker 策略**：lifecycle/progress/snapshot 每一族都必须带非空 parent、与 existing child 的 owner 一致、且命中已观察 `task` call；wire schema 保持真实 optional，tracker fail-closed——missing/unknown/conflicting 均自增 `unknownParentCalls`，不改变 child、不 settlement、不重归属。
- **单独停止关闭**：固定 OMP 无 per-child stop RPC，子代理 `hasUI=false` 无可信子进程句柄；`stopSubagent` 恒拒并如实说明（停止子代理 = 停止父回合，父回合停止也会回收该子代理）。未臆造父 abort 伪成功。
- **batch `task` 的拓扑卡（能力限制，产品决定）**：Pi 模型是「一个 Task 行 = 一个 delegation」。OMP batch（`tasks[]`）会在一行下多个子代理；现有拓扑卡以首个 child 为主 `delegationId`，各子代理行仍按 `parentToolCallId` 归入该卡。**这是显式的 UI 近似，不是完整兼容**：多子代理 batch 的首个子代理详情完整，其余子代理只能作为行归入该卡、无独立详情卡。单子代理（最常见、E2E 覆盖）完整。若需完整多子代理拓扑，须在既有 `delegations[]` 模型上扩展独立详情入口（产品决定，非本轮范围）。
- **重启边界**：固定 OMP 进程退出后无法重开 live 子代理 registry；桌面不谎报旧 detached 子代理仍在运行、不重放。持久父 transcript 已记录的 completed/failed 如实呈现，其余 `running` 按 `turnLive:false` 呈现为 `aborted`。
- **子模块状态**：`upstream/oh-my-pi` 与 `upstream/pi-desktop` 均保持干净（HEAD 与固定 SHA 一致）；`bun install` 的 `tool-views.generated.js` 重生成结果与提交一致，未产生未提交改动。
