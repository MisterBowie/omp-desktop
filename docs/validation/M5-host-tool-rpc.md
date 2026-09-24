# M5/T19-B：Desktop host tools 经 OMP host-tool RPC 恰一次暴露

更新时间：2026-09-25。状态：**T19-B 已实现并验证（分支 `codex/m5-host-tool-rpc`，基线 `93ee82b61bd8191722db199e0fb8f1c74ddfaa12`）**。固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（18.2.7）、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`。T19-C（桌面技能/记忆/插件用户路径）与 T20（Plan/Goal/高权限能力门）未实现、未声称。

## 1. 上游证据（固定源码，非推断）

### 1.1 OMP 18.2.7（`upstream/oh-my-pi` @ `d49918fab`）

**Host-tool 帧**（`packages/coding-agent/src/modes/rpc/rpc-types.ts:441-486`）：

- `RpcHostToolDefinition { name, label?, description, parameters, hidden?, loadMode?, readsSkillUris? }`。
- `host_tool_call { type, id, toolCallId, toolName, arguments }`（`id` 为桥生成的 Snowflake 帧 id，`toolCallId` 为 agent 工具调用 id）。
- `host_tool_cancel { type, id, targetId }`：**仅 OMP→桌面**，`targetId` 关联原调用；`RpcCommand` 联合中没有桌面发往 OMP 的 cancel。
- `host_tool_result { type, id, result: AgentToolResult, isError? }` 与 `host_tool_update { type, id, partialResult }`（桌面→OMP）。
- `AgentToolResult`（`packages/agent/src/types.ts:910-928`）：`content: (TextContent|ImageContent)[]`、`details?`、`isError?`、`providerMetadata?`、`useless?`；内层 `isError` 表示「非抛出式失败」。
- `ImageContent { type:"image", data(base64), mimeType }`（`packages/ai/src/types.ts:801-805`）。
- OpenAI 线格式中工具结果消息 `role: "tool"`（`packages/ai/src/providers/openai-completions.ts:2421-2425`）。

**注册与校验**（`packages/coding-agent/src/modes/rpc/rpc-mode.ts`）：

- `normalizeHostToolDefinitions`（575-596）：对 name/description **trim**，空白 name 拒绝，description 为空拒绝，parameters 非对象拒绝；`loadMode: defaultLoadModeForToolName(name, tool.loadMode)`——未声明时未知名 → `"discoverable"`（`tools/essential-tools.ts:45-47`），即**移出顶层 schema**、经 xd:// 或 BM25 暴露；桌面必须显式传 `loadMode: "essential"` 才能保证模型可见。
- `set_host_tools`（1335-1339）：`hostToolBridge.setTools` + `session.refreshRpcHostTools`，响应 `{ toolNames }`；命令处理器的 catch（466-480）把异常变为 `success:false` 响应。
- `#applyRpcHostToolRefresh`（`session/session-tools.ts:1963-2016`）：同请求内重名 → `"RPC host tool names must be unique"`；与**非 RPC-host 所有**的 registry 名冲突 → `"RPC host tool ... conflicts with an existing tool"`——原生工具/原生 MCP 与 host tool 重名由 OMP 拒绝（fail closed 依据）。
- 断开时 `hostToolBridge.close("RPC client disconnected...")`（1712-1713）拒绝全部 pending；`handleResult` 对未知 id 返回 false（无副作用）。
- `tool_execution_start/end` 为 agent 通用事件（`session/agent-session.ts:4354-4377`）：host tool 与原生工具同样经过 extension `tool_call` 钩子（M1 E08 实测 `toolCallsSeenByExtension` 含 `m1_host_echo`），`--trusted-extension` 网关因此**先于** `host_tool_call` 帧看到调用。

### 1.2 PI-Desktop（`upstream/pi-desktop` @ `0111e306`）

- **命名**：`pluginToolName = plugin_<safePlugin>_<safeTool>`、`userMcpToolName = mcp_<safeServer>_<safeTool>`（`packages/plugin-sdk/src/index.ts:1957-1977`）；plugin MCP 工具经 `pluginMcpToolKey(server.id, tool.name)` → `pluginToolName`，与 agent tools 同进一个 `tools` Map（`plugin-runtime.ts:3507-3519`）。
- **目录组装**：`resolveAgentRuntimeLaunch` **每次 launch** 重新组装 `plugins.getTools().filter(pluginActiveInProject)` + `userMcp.toolsForProject(projectPath)`（`session-launch.ts:439-440,644-667`）——插件装卸/作用域/MCP 配置变化下一 turn 可见。OMP 侧据此在每个 prompt 前重装配并以目录指纹跳过完全相同的注册。
- **执行与复检**（`host.ts:161-281`）：`mcp_` 分支**直接** `userMcp.callTool(name, args, projectPath)`（无 turn gate）；plugin 分支查 `getTools()` → `pluginActiveInProject` → 最后同步派发点 `isTurnDispatchable(sessionId, turnId)`（`session-coordination.ts:185-192`：live turn 身份 + 无 abort 记录 + 未 finalizing）→ `tool.execute(args, {sessionId, turnId, mode, modelKey, thinkingLevel})`；执行后 `plugins.drainToasts()` → `sendToRenderer(IPC.event.toast)`（289-291），**先 resolveExecution 后 drain**，toast 失败不影响已回传结果。
- **MCP 协议错误**：`McpServerClient.callTool` 对 `{isError:true, content:...}` **throw** `TOOL_FAILED`（`plugin-mcp.ts:477-479`），user/plugin MCP 协议错误因此已是异常（`mcpError` 携带 `.code`，`plugin-mcp.ts:62-65`）。
- **取消边界**：`McpServerClient.callTool(name, args)` **无 signal 参数**；plugin 工具经 `RegisteredPluginTool.execute` 的 `ctx.signal` → `sendToChild` 真实中止子进程调用（`plugin-runtime.ts:2200-2222,2536-2558`）。
- **turn 生命周期**：`finishTurn` → `announceTurnEnded({sessionId, turnId, reason: completed|aborted|error})` → `plugins.broadcastEvent("session:turnEnded")`（`plans.ts:240-272`、`plugin-services.ts:523-546`）；`agent-ipc.ts` abort 路径**先锁 abort reason 再发取消 RPC**，finally `finishTurn(..., "aborted", TURN_ABORTED)`——用户取消意图优先于迟到的 `agent_end`；`event-persistence.ts` 仅普通 `agent_end` 为 completed。
- **审批**：host-core `tools.execute` 先 `evaluate_auto`/`permissions.request` 再 `execute_plugin_tool`（`crates/host-core/src/tools/mod.rs:956-960`；`mcp_` 与 `plugin_` 同按声明 risk 评估）。OMP 侧等价物是 trusted gate 的 `tool_call` 钩子。

## 2. 设计决策（摘要）

1. **目录与注册**：桌面适配器 `omp-host-tools.ts` 按 PI `session-launch` 语义组装 `plugin_*`/`mcp_*`（description/schema 原样、`loadMode: "essential"`）；bridge 在**每个 prompt 提交前**重装配并以 `(runner, nativeSession, 目录指纹)` 跳过完全相同的注册——`set_host_tools` 整体替换，装卸插件/作用域/MCP 变化下一 turn 可见、被移除工具随之消失、绝不重复暴露。响应 `toolNames` 与请求**严格一致**否则 fail closed；OMP 拒绝（重名/冲突）同样 fail closed，绝不静默覆盖。
2. **执行**（omp-runtime `host-tools.ts` `OmpHostToolCalls` + 桌面 executor）：`host_tool_call` 绑定当前 run；**at-most-once 覆盖 owned generation 内的执行**（记录按 generation 无限保存、generation 显式结束后回收，无 LRU 驱逐）；fail-closed 拒绝（无活跃 run/无 executor）不执行任何东西，重放的被拒帧再次 fail-closed 应答（执行数仍为 0，OMP 对未知 id 的应答无副作用）；未知 targetId/迟到 result/cancel 全部计数丢弃；`host_tool_cancel` 只按 `targetId` 关联、绝不进事件转换器；stop/abort/dispose/传输失败/run close 时取消全部 pending，迟到完成丢弃。执行前复检：插件仍加载、作用域仍允许（`pluginActiveInProject`）、MCP `callTool` 内部复检（scope/连接/最新工具表）、**最后同步派发点**检查 `signal.aborted` 与 binding 的 `dispatchable(turnId)`（OMP runner 实时状态；Pi 谓词因 OMP turn 从不进 `activeTurns` 而恒拒，故不混用）。binding 的 `modelKey`/`thinkingLevel` 为**执行时 getter**（configure 的 thinking-only 路径原位改 `entry.binding`，执行必须见新值）。**执行上下文限制（T20）**：adapter 固定传 `mode: "agent"`；固定 PI `host.ts` 传持久会话 mode，`plugin-runtime.ts:2505-2525` 依 `ctx.mode` 执行声明 `planSafeActions`——OMP prompt/spec 当前无 mode 且 Plan/Goal 推迟，本阶段**不声称**与 PI 执行上下文完全兼容，T20 必须先传播并执行真实 mode。
3. **审批**：host tool 经既有 trusted gate（无并行审批系统）。`isHostToolName(plugin_*/mcp_*)` **无条件受控**（`OMP_DESKTOP_GATE_TOOLS` 只调原生名，host tool 只能经 `OMP_DESKTOP_GATE_MODE` 显式放行/拒绝），副作用前产生真实 `tool_permission_request`；risk：`plugin_*` = **high（保守上界）**、`mcp_*` = medium（与 PI 一致）。**协议限制**：pinned 协议无声明 risk 通道，本阶段低/中风险插件会得到高风险提示，未声称与 PI risk 完全等价（T20 不提前做）。
4. **turn 生命周期**：source of truth 在 runner 的 `closeRun(generation, reason)`——普通 `agent_end`=completed；stop 中的 `agent_end`/teardown=aborted（用户取消意图优先）；prompt/transport failure=error（含无 dialog 的 prompt RPC 失败）；dispose 活跃 turn=aborted。每 turn 恰一次（runner 单调 generation 守卫 + bridge entry 级全集，无 LRU）；bridge 转发给 `announceTurnEnded` 广播 `session:turnEnded`。converter 中途错误**不是** turn 终态。
5. **结果保真**：两层 isError 区分——抛错与内层 `{content, isError:true}` 都映射为外层 `host_tool_result.isError`；text block 透传；MCP image block 与 OMP `ImageContent` 同形**保真透传**；audio/resource/embedded/structuredContent/未知键（含插件返回的 `details`/`providerMetadata`/`useless`——PI 契约是插件完整返回值对模型可见，故以 JSON 文本保留，**绝不**映射到 OMP 结果自身的这些字段）确定性文本化，不因旁有 text block 而静默丢失，裸 base64 不跨线。**预算**：所有 outcome 路径统一过共享的 `boundHostToolContent`（runtime 包），以最终 `JSON.stringify(candidateContent)` 的 UTF-8 字节判定（数组括号/逗号/块信封/引号/转义全计入，≤768 KiB），超限对首个放不下的 text 块做二分截断、标记计入同一块；后续放不下时优先缩短最后一个 text 块为独立标记让位、**保留结果头部**，只有确实无可缩短文本才丢不可表示块。同一函数是 `OmpHostToolCalls` 的**最终权威写入边界**——执行器抛出超大 message 的错误同样在此受限并保留外层 `isError: true`，任何路径都无法写出超过行限制的帧。
6. **toast**：生产 adapter 执行后按 PI 顺序 drain + 逐条 emit，drain/emit 异常隔离并 warn，**绝不**把成功工具结果改写为失败。
7. **MCP 取消边界**：客户端无调用级 signal，且 `UserMcpRuntime.callTool` 在真正派发 `tools/call` 前还要 await 连接握手——承诺严格为「进入 MCP 调用路径**之前**已观察到的取消会拒绝该调用（路径入口同步 gate）；一旦进入路径，连接或请求可能继续进行，只能取消本地 pending 并丢弃迟到完成」，**不声称阻止或撤回远端副作用**（固定 PI 客户端同此限制）；plugin Agent Tool 经 signal 真实中止。文档/测试均按此表述。

## 3. 先红后绿

### 3.1 红（最终测试文件 + 纯基线 `93ee82b`，本地对象硬链接准备的临时 worktree，已确认基线 HEAD 并事后清理）

- `host-tool-runner.test.ts`：**9/9 行为失败**——executor 从未被调用、无 `host_tool_result` 写出、帧落入 `unmappedFrames`、stop/dispose/传输失败不中止任何执行（输出 `/tmp/t19b-red/final-red-runner2.txt`）。
- `turn-end.test.ts`：**9/9 行为失败**——`onTurnEnd` 从不触发（含无 dialog 的 prompt RPC 失败、stop+agent_end、teardown、dispose、converter 错误不误报等全部空缺）。
- `host-tools.test.ts`：module-not-found（次要，记实为「类不存在」）。
- `omp-host-tool-bridge.test.mjs`：**16/16 行为失败**——`set_host_tools` 从未发送、回显不匹配/拒绝不 fail closed、host_tool_call 0 次执行、每会话目录不存在、turn-end 从不广播、dispatch gate 不存在。
- `omp-host-tool-adapter.test.mjs`：module-not-found（次要）。
- `omp-host-tool-e2e.test.mjs`（真实固定 OMP）：**6/6 行为失败**——plugin/MCP 工具 0 次执行、结果 canary 从不进入模型上下文、取消场景从不被调用、decoy 场景桌面工具 0 次执行。

### 3.2 绿（本阶段产品基线）

- omp-runtime vitest **289/289**（基线 252 + host-tool-runner 9 + host-tools 16 + turn-end 9 + gate host-tool 3）。
- bridge 16/16、adapter 28/28（含目录增删注册、空白名拒绝、预算/保留头部、toast 隔离、live thinking getter、两层 isError、image 透传、structuredContent/非文本确定性、Unicode/转义预算、details 文本化）。
- 真实固定 OMP host-tool E2E **6/6**：plugin Agent Tool 审批先到→allow 恰一次→结果专属 canary 进入 `role:"tool"` 消息；deny 零执行零副作用；user MCP / plugin MCP 恰一次（真实 stdio 服务器各恰一次 tools/call）；取消无迟到副作用（迟到完成不进入模型上下文与转录）；decoy 项目 MCP 不被原生发现。全部经生产 `createOmpHostToolAdapter`（无测试专用映射实现）。
- 回归：T19-A capability-source 5/5、session/approval/persistence/subagent 6/6、desktop 定向 139/139、desktop 全量 2831/2827/0/4 skip。
- typecheck 2×0、build 0、style-token lint 0、Biome 0、`git diff --check` 0、secret canary 扫描 0、子模块固定 SHA、无残留进程/临时目录。

## 4. 实现文件

| 文件 | 变更 |
| --- | --- |
| `app/packages/omp-runtime/src/session/host-tools.ts` | 新增：`OmpHostToolCalls`（generation 作用域 at-most-once、cancelAll/closeGeneration/clearGenerations、两层 isError 写出、计数器）与帧校验 |
| `app/packages/omp-runtime/src/session/runner.ts` | host_tool_call/cancel 路由（不进转换器）；stop/dispose/transport failure/closeRun 取消与回收；`onTurnEnd` + `closeRun(generation, reason)` 恰一次公告 |
| `app/packages/omp-runtime/extensions/omp-desktop-gate.ts` | `isHostToolName` 无条件受控；`riskForTool` plugin_=high/mcp_=medium |
| `app/packages/omp-runtime/src/index.ts` | host-tools 导出 |
| `app/apps/desktop/electron/main/runtime/omp-host-tools.ts` | 新增：生产适配器（目录/校验/执行复检/dispatch gate/live getter/toast 隔离/结果映射/序列化预算） |
| `app/apps/desktop/electron/main/runtime/omp-session.ts` | bridge：per-prompt 指纹注册 + 回显校验 fail closed；executor binding（dispatchable/live getters）；turn-end 转发（entry 级全集守卫） |
| `app/apps/desktop/electron/main/runtime/omp-session-wiring.ts` | `hostTools`/`onTurnEnd` 传递 |
| `app/apps/desktop/electron/main/index.ts` | 生产装配：adapter deps（plugins/userMcp/pluginActiveInProject/drainToasts/emitToast）、`onTurnEnd: announceTurnEnded` |
| 测试 | `host-tools.test.ts`、`turn-end.test.ts`、`host-tool-runner.test.ts`（vitest）；`omp-host-tool-{adapter,bridge,e2e}.test.mjs`（desktop） |

## 5. 验证命令与结果

环境：Node v24.14.0（nvm）、pnpm 10.34.5、Bun 1.4.2、固定 OMP 18.2.7（`upstream/oh-my-pi` 仓库内启动器）。全部命令 `set -o pipefail` 或不经管道；未调用付费模型（fake/local fixture）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| omp-runtime 全量 | `cd app/packages/omp-runtime && npx vitest run` | 286 passed / 0 failed |
| bridge 探针 | `node --test apps/desktop/test/omp-host-tool-bridge.test.mjs`（apps/desktop 目录） | 16 passed / 0 failed |
| adapter 探针 | `node --test apps/desktop/test/omp-host-tool-adapter.test.mjs` | 28 passed / 0 failed |
| host-tool E2E | `node --test --test-concurrency=1 apps/desktop/test/omp-host-tool-e2e.test.mjs` | 6 passed / 0 failed（真实固定 OMP） |
| 回归 E2E | capability-source + session + concurrent-approval + persistence + subagent | 17 passed / 0 failed（真实固定 OMP，含 host-tool 6） |
| 桌面定向 | bridge/adapter/session-bridge/capability-boundary/engine-runtime/launcher/ipc-gates/failclosed | 139 passed / 0 failed |
| 桌面全量 | `cd app/apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | 2831 总数 / 2827 passed / 0 failed / 4 skipped |
| typecheck | `pnpm --filter @pi-desktop/omp-runtime typecheck`、`pnpm --filter @pi-desktop/desktop typecheck` | 退出 0 / 退出 0 |
| 构建 | `pnpm build:js` | 退出 0 |
| lint | `pnpm --filter @pi-desktop/desktop lint`、`pnpm lint:biome`（75 files） | 退出 0 / 退出 0 |
| 空白 | `git diff --check` | 退出 0 |
| 扫描 | secret/canary 正则扫 diff | 0 命中 |

## 6. 限制与已知边界

- **风险保真**：pinned 协议无插件声明 risk 通道——`plugin_*` 一律 high（保守上界，低/中风险插件会得到更严格提示）、`mcp_*` 一律 medium；不声称与 PI 风险完全等价。
- **description/name 归一化**：桌面原样转发；固定 OMP 的 `normalizeHostToolDefinitions` 在注册时 trim——该归一化是 OMP 的行为，桌面不重复实现、不伪造「注册原样」承诺。
- **MCP 取消**：客户端无调用级 AbortSignal 且 `callTool` 前有连接握手 await；仅承诺「进入 MCP 调用路径前已观察到的取消会拒绝该调用；进入后连接/请求可能继续，只能丢弃迟到完成」，不声称阻止或撤回远端副作用。plugin Agent Tool 的 signal 中止是真实的。
- **at-most-once 口径**：覆盖 owned generation 内的**执行**；generation 结束后帧无属主 run、fail closed 而非执行；fail-closed 拒绝本身不记忆，重放会被再次 fail-closed 应答（执行数恒为 0）。
- **执行上下文（T20 前置）**：adapter 固定 `mode: "agent"`；`planSafeActions`（`plugin-runtime.ts:2505-2525`）在 OMP 路径因此惰性。T20 传播并执行真实 mode 之前不声称 Plan/Goal 或完整 PI 执行上下文兼容。
- 子代理 `hasUI=false`：子代理会话中 host tool 会被网关以 no-UI 拒绝（既有 M1/T17 语义保持）。
- T19-C（桌面技能/记忆/插件用户路径）与 T20（Plan/Goal/高权限能力门）未实现；`branch`/`steer`/`followUp`/`compact`/子代理单独停止保持关闭。
