# M5/T20-A：Plan/Goal 与高权限工具能力门 —— 能力审计与可执行契约

更新时间：2026-09-25。状态：**T20-A（能力审计 + 基线红灯探针 + 最小实现契约）已完成**（分支 `codex/m5-plan-goal-capability-gates`，基线 `2ca256520980aa80bb812730fbad132e9e95f503`）。T20-B/C/D 未开始，**T20 未完成、未声称**。

固定子模块（本轮证据基准，与任务要求一致）：

| 子模块 | SHA | 版本/分支 |
| --- | --- | --- |
| upstream/oh-my-pi | `d49918fab2dba3986927f2d46721629ed0f3a02c` | omp/18.2.7（`bun install --frozen-lockfile` + `bun run build:native` 已备，launcher 报 `omp/18.2.7`，子模块工作树干净） |
| upstream/pi-desktop | `0111e306c120ad5820688d7608cb37bad8fbcc1f` | PI Desktop 固定参考 |

环境：Node v24（nvm）、Bun 1.4.2（`~/.bun/bin`）、工作树 `app/` 与 `docs/`。未调用任何付费/远程推理模型（全部 fake/local 夹具，本轮无运行时推理调用）。

**证据引用规则（复审要求）**：PI Desktop 契约（§2）以固定 `upstream/pi-desktop/` 为主证据源，路径写 `upstream/pi-desktop/…`；与产品 fork `app/` 的逐文件 diff 结论见 §2.5——除明确列出的 fork 差异外，其余文件字节一致，`app/` 中的行号与上游相同。OMP 能力（§3）以固定 `upstream/oh-my-pi/…` 为证据源。当前差距（§6）以 `app/` 为主。行号为本机实际读取或交叉核对过的行号（范围终点未逐一核对的只写起点或符号）。

---

## 1. PI Desktop Plan/Goal 契约（固定上游证据）

### 1.1 入口、模式状态、提示词组合、工具目录过滤

**入口（两条，都汇入 `plans.enter`）**

1. UI/会话配置：composer 模式片循环 Agent→Plan→Goal——`upstream/pi-desktop/apps/desktop/src/features/chat/composer/model.ts:33` `MODE_CYCLE = ["agent","plan","goal"]`（`nextMode` `:80-83`）→ `configureActiveSession({mode: next})`（`ComposerToolbar.tsx:136-140`）→ IPC `session.configure`（`stores/slices/session-slice.ts:619`）→ host-core `rpc/mod.rs` `"session.configure"`（上游行 2174）→ `sessions::configure_session_with_thinking`（`sessions.rs:1632`，内部先调 `plans::gate_session_configure` `sessions.rs:1651`）。
2. 模型侧（Agent 模式）：`EnterPlanMode`/`EnterGoalMode` 为 Agent-only 工具（`agent-runtime/src/runtime.ts:617-620`、构造 `:3595-3616`），执行即调 `plans.enter`（`runtime.ts:3608-3612`）→ host-core `rpc/mod.rs` `"plans.enter"`（上游行 2850）。

**模式状态存储**：`sessions.mode`（`plan|goal|agent`）为唯一持久源。归一化 `sessions.rs:21-27`（`"plan"|"chat" => "plan"`）；读取 `session_mode` `sessions.rs:1309-1315`；契约模式谓词 `is_contract_mode` `sessions.rs:36-38`。`plans.enter` 要求会话当前为 `agent`、存在 running turn、无 queued/running 执行，CAS `UPDATE sessions SET mode=?`（`plans/approval.rs:129-183`，上游 `plan_approvals` 行另存 kind/status/execution_*，`db/schema.rs`）。产物文件不是模式存储：只读快照在 `<workspaceRoot>/.pi/<kind>/`。

**提示词组合**：`agent-runtime/src/mode-prompts.ts`——`PLAN_MODE_SYSTEM_PROMPT :6-16`、`GOAL_MODE_SYSTEM_PROMPT :18-32`、`AGENT_MODE_SYSTEM_PROMPT :34-36`、`composeModeSystemPrompt :58-64`；调用点 `runtime.ts:2051-2075`（base + mode block 拼入 baseSystemPrompt）。

**工具目录过滤（双面一致，主机权威）**

- 边车目录构建 `runtime.ts:3411-3438` `rebuildToolCatalog`；契约模式内置集 `runtime.ts:3314` = `Read, Glob, Grep, BrowserPreview, Bash`；提交工具 `runtime.ts:3371-3374` 仅当前 kind 一个；Task 委托仅 Agent（`runtime.ts:3379-3391`）；允许清单 `runtime.ts:3453-3467`。
- host-core 权威镜像 `permissions.rs:148-153` `plan_mode_allows` = `Read|Glob|Grep|Bash|BrowserPreview|new_context`（提交工具永不达此门）。

**强制测试**：`runtime.test.ts:2043`（同一 Agent 对象在 Agent/Plan 间切换、Plan 含 `Read/Glob/Grep/BrowserPreview/Bash/SubmitPlan` 且无 `Write/Edit/plugin_demo_run/EnterPlanMode/SubmitGoal`）、`:2100`（Goal 仅 `SubmitGoal`）、`:1892`（legacy chat 归一）、`:6374`（契约模式不给 Task）；`mode-prompts.test.ts:8,29`（Plan/Goal 块内容互斥）；`plans/tests.rs:60,97,839`（enter 写 mode+身份、stale turn 拒写、goal kind）；`plan-mode-source-contract.test.mjs:41,233`（`MODE_CYCLE` 唯一三模式、模式命令走 `configureActiveSession`）。

### 1.2 SubmitPlan vs SubmitGoal、回合终止、不可变产物、审批、派发、重启

**一种 kind 参数化 RPC**：`runtime.ts:623-626` `SUBMIT_TOOL_NAMES = { plan: "SubmitPlan", goal: "SubmitGoal" }`；`buildSubmitTool(kind)` `runtime.ts:5038-5172` 参数同为 `title/markdown/question`，空参 → `PLAN_INVALID_ARGUMENT`，随后 `plans.submit {sessionId,turnId,toolCallId,kind,title,markdown,question}`（`:5095-5103`）。host-core `rpc/mod.rs` `"plans.submit"`（上游行 2895）：kind 缺省 plan 并校验，提交后发 `plans.changed {state:"awaiting_approval"}`。`PlanManager::submit`（`approval.rs:187-290`）：kind 与**持久**会话模式对账——`None => PLAN_NOT_ACTIVE`、kind 不符 `PLAN_KIND_MISMATCH`（`:216-221`，`repository.rs` 的 `session_submit_kind`）；live-turn 校验（`:222-224`）；每会话仅一个 pending（`PLAN_ALREADY_PENDING` `:225-236`）；artifact 记录 + 审计同事务，事务失败删文件（`:283-286`）。

**回合终止**：提交结果所有终支携带 `terminate: true`（`runtime.ts:5166-5171` 成功、失败路径同样）；`afterToolCall` 把 terminating 批次转成 `{terminate:true}`（`:2111-2118`，批次记录 `:3145-3171`）。四个过渡工具必须独占 assistant 批次（`:2208-2222`）。桌面侧把提交回合标为 plan submission、不发“任务完成”通知（`event-persistence.ts:87-89,131-134`，消费点 `runtime/plans.ts:191` 上游行号）。最终循环停住本身在依赖 `@earendil-works/pi-agent-core` 内（未随树 vendor），标记为 `[INFERENCE]`——本树内所有 flag 管线已验证。

**不可变产物 + awaiting_approval**：`publish_artifact`（`plans/artifact.rs:99-152`）：`<workspaceRoot>/.pi/<kind>/<slug>-YYYYMMDD-HHmm[-n].md`，`create_new(true)` 碰撞加后缀（上限 10000），写后 `sync_all`，记录 sha256/大小；目录安全 `:79-97`（拒绝 symlink/reparse `.pi` 或 kind 目录）；`verify_artifact` `:182-197` 批准时复验。行写入 `artifact_relative_path/artifact_sha256/artifact_size_bytes` + `status='pending'` + `expires_at = now + 30min`（`approval.rs:241-262`）。状态命名 `state_for_session` `approval.rs:315-327` → `inactive | awaiting_approval | planning`；`active_kind` `:331-333` 供渲染层标注 kind。

**审批/选中 permissionMode/派发**：`plans.resolve`（`rpc/mod.rs` 上游行 2963）：身份（session/turn/toolCall/version）全匹配、action ∈ approve|reject、过期 → `PLAN_APPROVAL_TIMEOUT`、approve 必须有 `targetPermissionMode ∈ {ask, accept-edits, auto}`（`approval.rs:5-9,381-391`）、重复决议幂等返回已提交结果、冲突 → `PLAN_APPROVAL_CONFLICT`（`:392-402`）。**一个事务内**：approve 时 `UPDATE sessions SET mode='agent', permission_mode=? WHERE mode=<kind>`（`:428-437`）+ 行写 `action/target_permission_mode/resolved_at/execution_id/execution_state='queued'`（`:444-457`）；已有 queued/running 执行 → `PLAN_EXECUTION_ACTIVE`（`:418-426`）；审计 `plan_approval_resolved`（`:458-475`）。reject 无副作用（只翻行）。渲染层 `PlanApprovalBar.tsx:91-121` 发身份 + `targetPermissionMode ?? "ask"`（默认 `ask`，`lib/plan-mode-state.ts:8`）。谁能调：`plans.resolve/claimExecution/finishExecution/queuedExecutions` 不在边车白名单（`agent-sidecar.ts:59-63` 只放行 enter/submit/pending/abort）——只有 Electron main 与 headless host 派发器可达。

**先 claim 后执行**：`apps/desktop/electron/main/runtime/plans.ts`（上游行 413-470）：先 `plans.claimExecution`（CAS queued→running，`plans/execution.rs:65-83`），失败/已在运行则**绝不重放**（`if (claimedExecution.state !== "running") return`），之后才 `session.beginTurn` + `agent.executeApprovedPlan(mode:"agent")`；失败路径 `finishApprovedExecution(..., "interrupted")`。finish 对称 CAS（`execution.rs:110-152`）。headless 同契约第二实现 `packages/host-runtime/src/plan-dispatch.ts`。

**重启/不重放**：`db/migrations.rs` `boot_maintenance`（行 7-105 验证）：所有 `pending` 行 → `interrupted`/`PLAN_APPROVAL_INTERRUPTED`，所有 `queued/running` 执行 → `interrupted`/`PLAN_EXECUTION_INTERRUPTED`；已批准行保留 status（不复活为可运行）；审计 `reason:"host_restart"`。drain 只派发 `queued`（`plans.ts` 上游行 502-514）。配置冻结 `gate_session_configure`（`approval.rs:54-119`）：有 pending/queued/running 执行或 running turn 时任何模式/模型/思考/权限变更 → `PLAN_CONFIGURATION_BLOCKED`。

**强制测试**：`plans/tests.rs:349`（批准原子切 mode+permission 并建 queued 执行）、`:254`（reject 无副作用、新回合新产物、旧字节保留）、`:384`（重复决议幂等/冲突）、`:444`（过期拒绝）、`:518`（claim/finish CAS）、`:212`（重启打断 pending）、`:553,631`（配置冻结）、`:122,156,183,685,715,785`（产物防覆盖/大小上限/symlink 拒/按 kind 分目录/goal 回环/跨 kind 拒）；`runtime.test.ts:2138,2221,2287`（批次守卫、terminate、goal kind、错误 kind 提交拒绝）；`plan-artifact-contract.test.mjs`（终止契约、无 ExitPlanMode、reject 永不派发）。

### 1.3 只读核心工具、Bash 语义、Write/Edit/未知工具拒绝

- 契约模式硬拒绝**先于**低风险分类、auto、grants、scratch 例外：`permissions.rs:216-232`——`is_contract_mode && !plan_mode_allows` 时，`plugin_*` 仅当转发来的 `planSafeActions` 非空才放行（执行时由 plugin-runtime 按 action 把关），其余（Write/Edit/未知）一律 `Deny`。拒绝码 `rpc/mod.rs`（上游行 3488-3497）：`WRITE_DISABLED_IN_PLAN` / `EDIT_DISABLED_IN_PLAN` / `PLUGIN_DISABLED_IN_PLAN` / `TOOL_DISABLED_IN_PLAN`（未知及其他），审计 `tool_denied`。**权威模式是持久模式**：`tools/mod.rs:559-561` 忽略边车 `mode` 字段（`_mode`），`rpc/mod.rs` 上游行 3212-3217 读 `sessions::session_mode`。
- **Bash 无命令白名单**：Bash 在 `plan_mode_allows` 内（`permissions.rs:151`），走常规风险（High）与权限模式判定（`permissions.rs:250-260`）：`auto → AllowOnce`；`accept-edits → 仅 Write|Edit`；`ask → 无（弹卡）`；grants 仍可放行。即 Plan/Goal 的 Bash 由 permissionMode 决定——**提示词要求只读使用，但硬边界是权限模式，不是命令分类**；`plan-mode-source-contract.test.mjs` 钉死“Auto 会不问即执行 Bash、可能改文件”的警示文案。模型侧只读要求是提示词层（`mode-prompts.ts:10`）。
- **强制测试**：`permissions.rs:538`（三种 permission mode 下 Write 皆拒）、`:547-556`（`plan_bash_follows_permission_mode`：ask→None、auto→AllowOnce）、`:559`（grants+auto 也不能放行 Write/Edit/plugin/未知）、`:577-605`（Goal 同语义）；`rpc/mod.rs` 上游行 8130 起 `plan_authorization_uses_durable_mode_and_keeps_bash_permission_semantics`（Plan+auto 下 Bash 真执行、切 ask 后须审批、四类工具拒绝码逐一断言）、上游行 8265 起 goal 对称测试。

### 1.4 插件 `planSafeActions` 与真实模式传播

- 定义：manifest `contributes.agentTools` 内 `planSafeActions?: readonly string[]`（`plugin-sdk/src/index.ts:109`）；运行时工具类型同字段（`:697`）。测试 `plugin-sdk/src/index.test.ts:342-367`——注意 `:367` 测试名“treats an absent planSafeActions as plan-denied”只断言清单校验通过，真正拒绝在 plugin-runtime/host-core（PI 自身的测试命名过度声明，如实记录）。
- 归一化 + 逐 action 执行把关：`apps/desktop/electron/main/plugin-runtime.ts:776-817` `normalizePlanSafeActions`（空→`[]`；非数组/非字符串条目/不在 schema `action` 枚举内 → 拒绝）；执行门 `:2504-2532`：`ctx.mode === "plan" | "goal"` 时 `allowed.length===0` 或 `toolArgs.action` 不在 allowed → `PERMISSION_DENIED`；子进程调用转发 `mode: ctx.mode`（`:2546`）。**无独立单测**（PI 缺口，T20-C 需补）。
- 真实模式传播链（端到端验证）：边车契约模式只暴露有 plan-safe 声明的插件工具并转发列表（`runtime.ts:3323-3330`、`:3078-3082` 加 `planSafeActions` 进 `tools.execute` payload）；host-core 忽略边车 mode、用持久 mode 判定并转发给 Electron `plugins.execute` 通知（`rpc/mod.rs` 上游行 1154-1158：`"mode": session_mode, "planSafeActions": …`）；Electron 解析模式进插件 ctx（`runtime/host.ts:197-215,253-254`）、`session-launch.ts:656-659` 转发列表进启动。Goal 走同一门（`plugin-runtime.ts:2508`）。测试：`runtime.test.ts:1925,1943`（无声明隐藏/有声明可见）、`bundled-plugins.test.mjs:135-139`（browser 插件必须声明四个只读 action）、`plugin-execute-notification.test.mjs:70-71`（envelope 带 mode/planSafeActions）。

### 1.5 fork 与固定上游的逐文件差异（复审后核实）

`app/` 与 `upstream/pi-desktop` 逐文件 `diff -q`：下列 PI 契约文件**字节一致**（行号互用）：`mode-prompts.ts`、`mode-prompts.test.ts`、`plans/{approval,artifact,execution,model,repository,tests}.rs`、`permissions.rs`、`tools/mod.rs`、`plugin-sdk/src/{index.ts,index.test.ts}`、`plugin-runtime.ts`、`runtime/{host,session-launch,event-persistence}.ts`、`agent-sidecar.ts`、`host-runtime/{plan-dispatch,plan-execution}.ts`、`agent-runtime/{runtime,runtime.test}.ts`、渲染层（`PlanApprovalBar.tsx`、`plan-mode-state.ts`、`composer/model.ts`、`commands.ts`、`session-slice.ts`、`interaction-slice.ts`）及 `plan-{mode-source-contract,artifact-contract,renderer-flow,approval-settings,ui-probe-contract}.test.mjs`、`bundled-plugins.test.mjs`、`plugin-execute-notification.test.mjs`。

**有差异/仅 fork 存在的文件**（fork 差异，非 PI 契约内容）：

- `crates/host-core/src/rpc/mod.rs`：fork 多 48 行（OMP 会话分支）。Plan 处理器位置一致：上游行 = fork 行 −48（`plans.enter` 2850/2898、`plans.submit` 2895/2943、`plans.resolve` 2963/3011、`plans.queuedExecutions` 3040/3088、`plans.claimExecution` 3049/3097、拒绝码 3492/3540、测试 8130/8178）。
- `crates/host-core/src/sessions.rs`：fork 多 ~250 行（引擎列/绑定），契约段已按上游行号核实（`normalize_mode` 21、`is_contract_mode` 36、`session_mode` 1309、`configure_session_with_thinking` 1632/1651）。
- `apps/desktop/electron/main/runtime/plans.ts`：fork 在 claim 前插入引擎门（`refuseOutsidePiRuntime(…, "plan execution")`，fork 行 446-461；上游同函数无此段，上游行 413 起直接 claim）。其余（claim→beginTurn→executeApprovedPlan、finishTurn 释放次序、drain 只派 queued）一致。
- `apps/desktop/electron/main/runtime/engine-router.ts`：fork-only（ADR 0300 引擎门）；`apps/desktop/test/plan-drain-engine-gate.test.mjs`：fork-only 测试（钉 fork 的引擎门行为）。

---

## 2. 固定 OMP 能力证据（`upstream/oh-my-pi` @ d49918fab）

### 2.1 rpc-ui 命令面（无 Plan/Goal 接口）

- rpc-ui 与 rpc 是**同一实现**：`main.ts:2307-2311` 两模式都调 `runRpcMode`，仅 rpc-ui 传入 `setToolUIContext`；`main.ts:2085` `hasUI = isInteractive || mode === "rpc-ui"`；`main.ts:1785-1787` rpc-ui 设 `PI_NO_PTY`。模式枚举 `cli/args.ts:23` = `text|json|rpc|acp|rpc-ui`。
- 完整命令集 = `modes/rpc/rpc-types.ts:24-95` 的 `RpcCommand` 联合（42 个变体，见 §4 探针输出）；分派 `rpc-mode.ts:1174-1663` 恰为其全集；未知类型 → `default` 返回 `"Unknown command: <type>"`（`rpc-mode.ts:1660-1661`）。控制帧侧信道仅四种：`extension_ui_response`/`host_tool_result`/`host_tool_update`/`host_uri_result`（`rpc-mode.ts:358-379`）。
- **整个 `modes/rpc/` 目录**对 `plan|goal|approval|permission` 的唯一命中是 `rpc-client.ts:158` 的 `"goal_updated"`（客户端转发事件白名单里的一个透传事件名）；`RpcSessionState`（`rpc-types.ts:95-117`）无任何 plan/goal/permission 字段（`systemPrompt` 只是 `get_state` 的只读转储）。
- 模式斜杠命令是 TUI-only：`/plan`、`/plan-review`、`/goal`、`/guided-goal`（`slash-commands/builtin-modes.ts:200-287`）只有 `handleTui` 无 `handle`；`acp-builtins.ts:57-63` 无 `handle` 直接不处理；`available-commands.ts:67-69` 跳过无 `handle` 的 builtin——即 `get_available_commands`（`rpc-mode.ts:1326-1328`）永不广告这些命令，`prompt` 里的 `/plan …` 按普通文本进会话（`rpc-mode.ts:1238-1247`、`agent-session.ts:6324-6344`）。
- 模式状态在 rpc/rpc-ui 永不恢复：只有 interactive 注册了 reconciler（`interactive-mode.ts:1657`、`:3699-3723`）。

**结论（rpc-ui）**：不存在 Plan/Goal 的 enter/exit/submit/review/approval 命令或通知；没有 permission-mode 命令；没有 plan/goal 状态读写（唯一例外是 `goal_updated` 透传事件，无状态、无创建/变更途径）。

### 2.2 每会话/每提示词的 system-prompt / mode / tool 过滤

- 协议面**没有**：`prompt` 命令整个载荷 = `message + images? + streamingBehavior?`（`rpc-types.ts:29`）；`PromptOptions`（`session/agent-session-types.ts:337-356`）无 system prompt/tools/mode。工具目录只有**增量的** `set_host_tools`（`rpc-types.ts:41`、`rpc-mode.ts:1335-1340` → `session-tools.ts:1958-1995`）。
- 进程内（受信扩展）**有**，且桌面已在用：`before_agent_start` 返回 `{systemPrompt: [...]}` 追加注入（`extensibility/extensions/types.ts:1130-1133`，应用点 `agent-session.ts:6697-6712`）；工具过滤 `pi.setActiveTools`（`modes/runtime-init.ts:105-107`，rpc/rpc-ui 共用 `initializeExtensions`，`rpc-mode.ts:1072-1087` 带真实 UI context 初始化）→ `session.setActiveToolsByName`（忽略未知名）。ACP 另有 `setSessionMode`（`acp-agent.ts:765-784`），与 rpc 无关。

### 2.3 执行前拦截（工具调用钩子）

- 事件载荷 `ToolCallEvent = {type:"tool_call", toolCallId, toolName, input}`（`extensibility/extensions/types.ts:919-963`；`extensibility/hooks/types.ts` 同形）；无 sessionId/arguments 字段（`input` 是归一化参数视图）。上下文第二参 `ExtensionContext`（`types.ts:428-444`）含 `hasUI`（`runner.ts:896-898,1174-1192` 物化）、`cwd`、`sessionManager`（`runner.ts:648-649` 取 session id）、`getSystemPrompt` 等。
- 返回 `ToolCallEventResult {block?, reason?, input?}`（`shared-events.ts:311-338`，`input` 为替换执行参数，会经 schema 复检）。
- 分派点一（agent 循环，arg-prep 时，先于调度与 wrapper 审批门）：`agent-session.ts:1781` 接线、`:4148-4190` 实现（`block → {block:true}`）；超时/异常**fail-closed**（`runner.ts:1486-1532`）。分派点二（wrapper，循环未见的派发，如 `write xd://…` 设备调用、Cursor 直连）：`wrapper.ts:184-232` 消费已发标记后补发。覆盖：全部注册工具（`sdk.ts:2971-2976`，runner 无条件构建 `sdk.ts:2848-2852`）、RPC host 工具（`session-tools.ts:1958-1961,1992-1994`）、MCP/扩展工具、子代理（父扩展工厂重绑：`task/executor.ts:3751`、`task/structured-subagent.ts:477-479`；子代理无 UI context → `ctx.hasUI=false`）。
- `tool_approval_requested/resolved`（`types.ts:901-916`）是运行时自带审批弹窗的描述事件，**不能**阻断调用——不是拦截点。

### 2.4 OMP 自身的 Plan/Goal（interactive 与 ACP），哪些不能复用于 rpc-ui

- **interactive Plan**：`/plan` 三态开关（`interactive-mode.ts:4591-4632`）；`#enterPlanMode` `:3725-3803`（setPlanModeState、**加回** `write` 工具以写 `local://<slug>-plan.md`、安装 `setPlanProposalHandler` `:3790`、`appendModeChange`）；模型被指示写计划并用 `write xd://propose` 提交（`agent-session.ts:6085-6119` 渲染 `plan-mode-active.md`）；`tools/resolve.ts:283-291`：无 proposal handler 时 `xd://propose` 写直接 `ToolError`。审批 = TUI overlay（`event-controller.ts:1950-1985` 匹配 propose 执行事件 → `handlePlanApproval` `interactive-mode.ts:5216-5343`，五个选项 + 模型滑块）。teardown `:3863-3935`。
- **ACP Plan**：模式经 `session/set_mode` 与配置项进入（`acp-agent.ts:765-784`、`:1833-1872`）；审批为客户端驱动的 elicitation（`:1887-1970`），客户端不支持表单则**自动批准**（`:2023-2050`）。
- **Goal**：仅 interactive——`/goal` 子命令（`builtin-modes.ts:250-275`、`interactive-mode.ts:4891`）、`goalRuntime` 进入/退出（`:3953-3983`）、**延续定时器**（`:2061-2100`，默认 `goal.continuationModes=["interactive"]`，`settings-schema.ts:4881-4884`）。`modes/acp/**` 无任何 goal 引用。
- **不能复用于 rpc-ui 的件**：(1) proposal handler 只有 interactive/acp/prewalk 三个安装点（`interactive-mode.ts:3790`、`acp-agent.ts:1867`、`prewalk.ts:325`），rpc-mode 从不安装 → `xd://propose` 在 rpc-ui 必然失败；(2) Plan/Goal 状态在 rpc 无设置/恢复路径；(3) 审批面是 TUI overlay/ACP elicitation，rpc-ui 只有通用 `extension_ui_request` select/confirm/input 帧（`rpc-types.ts:391-441`）；(4) 审批不持久不重放——RPC 断连时 pending UI 请求全部拒绝（`rpc-mode.ts:1710-1712`），ACP 决策在内存 Map（`session-tools.ts:318,425-434`）。
- **OMP 自身的 plan 写保护**：`tools/plan-mode-guard.ts:139-160` `enforcePlanModeWrite`（工作树只读、只允许 `local://` 沙箱，move/delete 拒）+ Rust `path_policy.rs` `enforce_write`（plan_active 阻 rename/delete/非沙箱写）。**只保护写文件，Bash 无保护**（`tools/bash.ts` 无 plan 检查；`plan-mode-active.md` 的“不运行改状态命令”只是提示词）。plan 子代理受限目录 `PLAN_MODE_TOOLS = read/grep/glob/web_search`（`structured-subagent.ts:174,205-213,412-413`）。这些全部以 `session.getPlanModeState()` 为前提——rpc-ui 无法进入 plan 态，故在该模式下全部惰性。

### 2.5 批准后执行 / 权限模式

- 桌面持久化的 `permissionMode` 只是主机 DB 元数据（§6 g1），无 RPC 帧携带。OMP 自己的旋钮只有**启动期** `--approval-mode always-ask|write|yolo` / `--auto-approve`（`flag-tables.ts:229-238,319-320` → `main.ts:1763-1772` settings override；schema 默认 `yolo`，`settings-schema.ts:4082-4086`；RPC/ACP 默认覆盖均不触碰它，`main.ts:246-253`），**无运行时命令**改它。ACP 的 per-call 权限门（`session-tools.ts:770-877`、`acp-permission-gate.ts:6-11`）是 ACP-only。
- 当前桥接只发 `--mode rpc-ui --trusted-extension <gate> [--model …]`（`omp-runtime/src/process.ts:213-215`、`engine-runtime.ts:203-205`、`omp-runtime.ts:159-161`）；桌面从未写 `OMP_DESKTOP_GATE_MODE`（仅 E2E 夹具经 extraEnv 写）。

---

## 3. rpc-ui 能力判定（与 interactive/ACP 分开）

| 能力 | interactive | ACP | rpc | rpc-ui | 证据 |
| --- | --- | --- | --- | --- | --- |
| 进入/退出 Plan | 有（`/plan` 三态） | 有（`set_mode` + 配置项） | 无 | **无** | builtin-modes.ts:200-219；acp-agent.ts:765-784,1833-1872 |
| Plan 提交（`xd://propose`） | 有（handler 已装） | 有（handler 已装） | 无（handler 永不装 → ToolError） | **无** | interactive-mode.ts:3790；acp-agent.ts:1867；resolve.ts:283-291 |
| Plan 审批面 | 有（TUI overlay） | 有（elicitation，无表单自动批准） | 无 | **无**（仅通用 `extension_ui_request`） | interactive-mode.ts:5216-5343；acp-agent.ts:1887-1970,2023-2050 |
| Plan 只读保护 | 写/编辑硬守卫 + 提示词（Bash 不保护） | 同态 + ACP 权限门 | 不可达 | **不可达** | plan-mode-guard.ts:139-160；path_policy.rs |
| Plan 子代理限制目录 | 有 | 有（同代码路径） | 不可达 | **不可达** | structured-subagent.ts:174,205-213,412 |
| Goal 进入/设置/暂停/丢弃 | 有（`/goal`） | 无 | 无 | **无** | builtin-modes.ts:250-275 |
| Goal 延续回合 | 有（定时器，默认 interactive） | 无 | 无 | **无** | interactive-mode.ts:2061-2100 |
| `goal_updated` 通知 | 有 | 有 | 透传 | **透传** | rpc-client.ts:158 |
| 每提示词 system prompt 覆盖 | 扩展 | 扩展 | 仅受信扩展 | **仅受信扩展**（桌面 gate 已用） | types.ts:1130-1133；agent-session.ts:6697-6712 |
| 每会话/提示词工具过滤 | `setActiveTools` 等 | 同 | 协议仅增量 `set_host_tools`；进程内 `setActiveTools` | **同 rpc** | runtime-init.ts:105-107；rpc-types.ts:41 |
| 执行前工具拦截 | 有（`tool_call` 全工具） | 有 | 有 | **有**（桌面 gate；hasUI=true） | agent-session.ts:1781,4148-4190；wrapper.ts:184-232；runner.ts:1486-1532 |
| 权限/审批模式选择 | 设置/CLI + 运行时审批 | ACP 权限门 | 仅启动期 `--approval-mode`；无 RPC 命令 | **仅启动期；无 RPC 命令** | main.ts:1763-1772；session-tools.ts:770-877 |
| 批准后以选定权限模式启动执行 | 有（Pi 侧 plan 管线） | n/a | 无（非 Pi 引擎计划执行被拒） | **无**（`refuseOutsidePiRuntime(…,"plan execution")`） | app runtime/plans.ts:446-461 |
| Plan/Goal/模式状态协议可读 | 进程内 | 有（session payload 内 modes） | 无 | **无** | rpc-types.ts:95-117；acp-agent.ts:2047-2057 |

**rpc-ui 判定总结**：rpc-ui = rpc + 工具 UI 上下文（`ask` 等），协议面与 rpc 完全一致；**没有**任何 Plan/Goal/权限模式命令或状态。可行的是三条进程内通道（全部无需改上游）：`before_agent_start` 的 systemPrompt 追加（提示词塑造）、`setActiveTools`（工具目录过滤）、`tool_call` 执行前 fail-closed 拦截（执行时拒绝，载荷 toolCallId/toolName/input，上下文 hasUI/sessionManager/cwd）。OMP 自身的 Plan/Goal（interactive/ACP）不可复用（proposal handler、TUI overlay、elicitation、goal 定时器均绑定 UI 上下文），审批不持久、不重放。**结论：rpc-ui 足以支撑桌面自有的 Plan/Goal 适配（提示词/目录/执行前拦截三通道齐备），但必须由桌面自建状态机与提交/审批闭环，不存在"原生兼容"。**

---

## 4. 基线红灯探针（可执行证据）

新增 `app/scripts/check-omp-plan-goal-gaps.mjs`（跟随仓库 `check-*` 脚本约定）：**独立 opt-in 诊断**，不进默认测试套件；只读当前已发布源码接缝报告事实，不传虚构字段、不断言未定 API。无 `OMP_T20_GAP_PROBE=1` 时打印 SKIP 并退出 0；有则每缺口一行稳定输出，任何 T20 缺口开放即退出 1。

运行命令与输出（基线 `2ca2565`，Node 24，工作目录 `app/`）：

```text
$ node scripts/check-omp-plan-goal-gaps.mjs
SKIP: T20-A gap diagnostic not enabled (set OMP_T20_GAP_PROBE=1 to run it)
exit=0

$ OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs
GAP-OPEN g1 (owner: T20-B) session mode/permissionMode persist to the host DB only; no OMP prompt/tool path reads them [evidence: omp-session.ts persistence-only branch present: true; pinned prompt command has no mode/systemPrompt/tools key: true (| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" })]
GAP-OPEN g2 (owner: T20-C) the host-tool adapter executes every plugin tool with a hardcoded mode 'agent'; the session's durable mode never reaches plugin execution [evidence: omp-host-tools.ts hardcoded execution-context mode literal present: true]
GAP-OPEN g3 (owner: T20-B) an approved Plan/Goal execution for an OMP session is refused before claiming; the queued row stays queued and nothing runs on the OMP engine [evidence: runtime/plans.ts refuseOutsidePiRuntime("plan execution") present: true]
VERDICT g4: pinned rpc-ui RpcCommand union has 42 commands: negotiate_protocol, prompt, steer, follow_up, abort, abort_and_prompt, new_session, get_state, set_fast_mode, get_available_commands, set_todos, set_host_tools, set_host_uri_schemes, set_subagent_subscription, get_subagents, get_subagent_messages, set_model, cycle_model, get_available_models, set_thinking_level, cycle_thinking_level, set_steering_mode, set_follow_up_mode, set_interrupt_mode, compact, set_auto_compaction, set_auto_retry, abort_retry, bash, abort_bash, get_session_stats, export_html, switch_session, branch, get_branch_messages, get_last_assistant_text, set_session_name, handoff, get_messages, get_messages_page, get_login_providers, login
VERDICT g4: no plan/goal/permission/approval command exists in the pinned rpc-ui surface (rpc-ui = rpc + tool-UI context; see the validation document)
SUMMARY: 3 gap(s) open [g1, g2, g3]
exit=1
```

各检查证明什么：**g1**（红）——`omp-session.ts` 仍含“A pure mode/permissionMode change has no runtime impact; persist it.”分支，且固定协议的 `prompt` 命令载荷无任何 mode/systemPrompt/tools 键 → 模式只持久化、进不了运行时；**g2**（红）——`omp-host-tools.ts` 插件执行上下文仍是硬编码 `mode: "agent"` 字面量 → 真实模式不传播；**g3**（红）——`runtime/plans.ts` 仍以 `refuseOutsidePiRuntime(…, "plan execution")` 拒绝 OMP 会话的已批准计划执行 → 队列行为 queued、永不运行；**g4**（判定，非缺口）——固定 rpc-ui 命令面 42 个变体全列，无 plan/goal/permission/approval 命令；若未来上游新增此类命令，该行变为 `REVIEW-REQUIRED` 并计入退出码，强制重审本判定。该脚本是诊断而非正确性断言：T20-B/C 落地后由真实行为测试替换，不得转正为 pin。

---

## 5. 当前差距表（OMP Desktop，基线 2ca2565）

| 编号 | 差距 | 证据（app/，行号已验证） | 归属 |
| --- | --- | --- | --- |
| G1 | mode/permissionMode 仅持久化 | `apps/desktop/electron/main/runtime/omp-session.ts:1847-1849`（"A pure mode/permissionMode change has no runtime impact; persist it."）；`configure` 全字段单次 `persistConfig` `:1756-1766`；桥接无任何 plans 接口（全文件 `plan` 零命中） | T20-B |
| G2 | 插件执行硬编码 agent 模式 | `apps/desktop/electron/main/runtime/omp-host-tools.ts:356` `mode: "agent"`（执行上下文字面量）；`planSafeActions`（PI `plugin-runtime.ts:2505-2525`）在 OMP 路径因此惰性 | T20-C |
| G3 | 已批准计划执行 Pi-only 拒绝 | `apps/desktop/electron/main/runtime/plans.ts:446-461` `refuseOutsidePiRuntime(engineRouter.require(session,"prompt"), "plan execution")`（引擎判定先于任何持久变更，`:424-427`）；拒绝实现 `runtime/engine-router.ts:61-71` | T20-B |
| G4 | 能力表无 plan/goal 键 | `app/packages/shared/src/engine.ts:131-143` `OMP_ENGINE_CAPABILITIES` 只有 prompt/stop/resume/branch/steer/followUp/modelSwitch/structuredQuestions/toolApproval/subagentEvents | T20-B |
| G5 | 网关策略无模式/权限模式输入 | `app/packages/omp-runtime/extensions/omp-desktop-gate.ts` `decideToolCall` policy 仅 `{gated, mode: ask/deny/allow, timeoutMs, sessionAllowed}`（`:245-258` 决策表）；`OMP_DESKTOP_GATE_MODE` 桌面从不写（仅 E2E extraEnv）→ 每会话恒 ask | T20-B |
| G6 | 桥接无提交/审批 RPC 面 | `omp-session.ts` 无 `plans.*`；`ipc/agent-ipc.ts:1099-1105` 审批前要求 Pi 引擎（`refuseOutsidePiRuntime(…, "plan approval")`） | T20-B |
| G7 | OMP 自身 Plan/Goal 不可达 | 见 §2.4/§3：proposal handler 无 rpc 安装点、审批不持久、goal 定时器仅 interactive | 事实，设计前提 |

可复用（已验证）：host-core plans 模块（产物/审批/claim/boot_maintenance，与引擎无关的 Rust 状态机）、`PlanApprovalBar.tsx` + `plan-mode-state.ts`（引擎无关渲染）、`composeModeSystemPrompt`（纯函数）、composer `MODE_CYCLE`（已持久化到 OMP 会话）、T19-C 的运行域状态文件 + `before_agent_start` 注入通道、受信 gate 的 `tool_call` 执行前拦截与 `setActiveTools` 目录通道。

---

## 6. 最小后续实现（设计决策，供 T20-B/C/D 执行）

**原则**：复用 Pi 的 host 自持产物/审批/状态机与渲染层，不建第二套审批流；不手抄提示词；权限模式语义照抄 PI。

1. **模式提示词（字节平价）**：桥接每 prompt 前把 `composeModeSystemPrompt(mode, base)`（复用 `app/packages/agent-runtime/src/mode-prompts.ts` 输出，与固定 PI 字节平价）写入运行域状态（扩展现有 `desktop-state.json` 快照，v2），gate `before_agent_start` 与技能/记忆同通道追加；**模式不是 best-effort**：状态写入失败 → 该 prompt 拒绝（沿 `OMP_CAPABILITY_STATE_FAILED` 语义），绝不把契约模式意图当 agent 跑。子代理零注入保持。
2. **工具目录**：契约模式下由 gate/桥接用 `pi.setActiveTools`（`runtime-init.ts:105-107`，rpc 可用）夹取目录——原生只读核 + 提交工具 + 声明了非空 `planSafeActions` 的插件 host 工具；Agent 模式目录不变（T17-T19 回归）。
3. **提交工具**：`SubmitPlan`/`SubmitGoal` 注册为**桌面 host tool**（`set_host_tools`，仅契约模式注册；host tool 同受 `tool_call` 拦截），执行器直调既有 `plans.submit` RPC（host-core 复用）→ 不可变 `.pi/<kind>/*.md` 产物 + pending 行 + `awaiting_approval`；错误 kind 提交由 host-core 报 `PLAN_KIND_MISMATCH`（PI 语义原样）。提交后回合终止语义由 host tool 结果文本承载（OMP 无 terminate flag，模型指令"提交后停手"由模式提示词 + 一次提交规则约束——T20-B 需实测并记录与 PI `terminate:true` 的差异）。
4. **审批**：渲染层继续用 `PlanApprovalBar` → `plansResolve` IPC（去掉 OMP 拒绝分支）→ host-core `plans.resolve`（批准原子写 mode=agent + permission_mode + queued 执行；reject/过期/打断语义全部复用）。
5. **派发（OMP 路径）**：把 `plans.ts` 的 OMP 拒绝替换为：claim CAS（复用）成功后，经 OMP 桥接启动一个 agent 模式回合——该 prompt 前写状态（agent 提示词 + 网关权限模式 = 选定 permissionMode），`finishApprovedExecution` 复用；drain/boot_maintenance/配置冻结不变（host-core 自持，恰一次与不重放天然成立）。
6. **执行时强制（gate，照抄 PI `permissions.rs` 语义）**：契约模式硬拒绝**先于一切**——Write/Edit/apply_patch/未知原生工具、无非空 `planSafeActions` 的插件工具一律 block（PI `permissions.rs:216-232`）；**Bash 由有效权限模式决定，不做命令分类/只读解析**（复审要求，PI `permissions.rs:250-260` + `plan-mode-source-contract` Auto 警示语义）：`inherit` → 解析到全局默认；`ask` → 审批；`accept-edits` → Bash 仍须审批（仅 Write/Edit 自动放行）；`auto` → 放行；契约硬拒绝高于任何权限模式。**明确不等于现状**：当前 `OMP_DESKTOP_GATE_MODE=ask|deny|allow` 是启动期 env 策略、OMP `tools.approvalMode=always-ask|write|yolo` 是启动期设置，二者都不是 PI 权限模式，不得宣称现有 env 门已提供该映射——T20-B 必须把 per-session/per-turn/per-tool 的有效权限模式经运行域状态传入 gate 并实现上表。
7. **插件模式传播**：adapter 执行上下文 `mode` 改为执行时读取会话持久模式（替换 G2 硬编码），`planSafeActions` 逐 action 把关照抄 `plugin-runtime.ts:2504-2532`；子代理 `hasUI=false` 保持 fail-closed；高权限工具（browser/computer/eval）无论模式仍受审批。
8. **能力声明**：`EngineCapability` 增 plan/goal（T20-B 决定键名与门控面），渲染层模式片/审批卡按能力显示；Pi 会话零变化。
9. **扩展点清单**（确切符号）：`omp-session.ts` `configure()`/`persistConfig`（读模式进状态写入）、`OmpHostToolProvider.catalog`（提交工具注册）、`omp-host-tools.ts` executor（`mode` 来源 + `planSafeActions` 把关）、`omp-desktop-gate.ts` `decideToolCall`（模式感知决策表）、`desktop-state.ts` 快照（模式块字段）、`runtime/plans.ts` `dispatchApprovedPlan`（OMP 派发分支）、`ipc/agent-ipc.ts` `plansResolve`（去 Pi-only 门）、`packages/shared/src/engine.ts` 能力表、`PlanApprovalBar.tsx`（零改动，纯复用）。

---

## 7. 验收矩阵（T20-B/C/D 归属）

图例：层 = 测试所在层（host-core Rust / desktop main 单元 / gate 单元 / 桥接夹具 / 真实固定 OMP E2E / 渲染层）。先例 = 既有 PI 源/测试或本仓库既有语义。

### T20-B（模式状态机、提示词、目录、提交/审批/派发闭环）

| 行 | 场景 | 层 | 期望 | 先例 |
| --- | --- | --- | --- | --- |
| B1 | OMP 会话 Agent/Plan/Goal 模式片切换持久化（现有 T15 语义回归） | desktop main 单元 + host-core | configure 原子持久 mode+permissionMode；无 pending/queued/running 才允许（`PLAN_CONFIGURATION_BLOCKED`） | `sessions.rs:1651`、`approval.rs:54-119` |
| B2 | Plan/Goal 模式提示词注入：与 `composeModeSystemPrompt` 字节一致、经状态文件→`before_agent_start` 追加、绝不替换原生提示词 | gate 单元 + 真实 OMP E2E（fake provider 断言系统提示词） | plan/goal/agent 三模式块与 PI 逐字节一致；状态文件失败 → prompt 拒绝（不按 agent 跑契约意图） | `mode-prompts.ts`；T19-C 注入通道 |
| B3 | 契约模式工具目录：只读核 + 提交工具 + 非空 planSafeActions 插件 host tool；Write/Edit/apply_patch/未知不可见 | 桥接夹具（`set_host_tools` 帧）+ gate `setActiveTools` 单元 | 目录与 PI `plan_mode_allows` + 目录过滤一致；Agent 模式目录不变 | PI `runtime.ts:3314,3453-3467`、`permissions.rs:148-153`；OMP `runtime-init.ts:105-107` |
| B4 | SubmitPlan/SubmitGoal 可见性与错误模式拒绝 | host-core + 桥接夹具 | 仅当前 kind 的提交工具注册；`SubmitPlan` 于 Goal / 无契约时 → `PLAN_NOT_ACTIVE`/`PLAN_KIND_MISMATCH`；每会话恰一 pending（`PLAN_ALREADY_PENDING`） | `approval.rs:216-236`、`plans/tests.rs:785` |
| B5 | 提交产物：`.pi/<kind>/<slug>.md` 不可变、sha256/大小记录、防覆盖、symlink 拒；`awaiting_approval` 状态可见 | host-core + 渲染层 | 与 PI 相同路径/内容契约；pending 行驱动审批卡 | `artifact.rs:99-152`、`plans/tests.rs:122,156,183,685` |
| B6 | 审批：reject/过期/打断回 planning（新回合新产物，旧产物不可变）；approve 原子写 mode=agent+permission_mode+queued 执行；重复决议幂等、冲突/过期拒绝 | host-core + 渲染层 IPC | 与 PI 状态机一致；无第二套审批 | `approval.rs:351-471`、`plans/tests.rs:254,349,384,444` |
| B7 | 恰一次执行：claim CAS queued→running 先于任何 OMP prompt；finish CAS；drain 只派 queued；boot 重启打断 pending 与 queued/running、不重放；执行期间配置冻结 | host-core + desktop main 单元 + 桥接夹具 | OMP 派发路径复用全部既有 CAS；无重复执行、无重放 | `execution.rs:65-83,110-152`、`migrations.rs` boot_maintenance、`plan-drain-engine-gate.test.mjs`（fork 语义：OMP 会话也要 claim） |
| B8 | 批准后执行：选定 permissionMode 到达该回合 gate（agent 提示词 + 权限策略），执行失败 → interrupted 且可观察 | 桥接夹具 + 真实 OMP E2E（fake provider） | 回合以选定权限模式运行；失败清理不留 running 行 | 上游 `plans.ts:413-470`（Pi 侧）；§6.5 映射 |
| B9 | 能力声明：`OMP_ENGINE_CAPABILITIES` 增 plan/goal；渲染层按能力显隐；Pi 会话行为零变化 | shared 单元 + 渲染层 | 能力表准确；Pi 全绿回归 | `engine.ts` 既有表 |
| B10 | Agent 模式回归 + T17-T19 回归（子代理/工具结果/MCP/技能/记忆不受影响） | 既有套件 | 全绿；无模式相关行为变化 | T17-T19 验收记录 |

### T20-C（执行时强制与模式传播）

| 行 | 场景 | 层 | 期望 | 先例 |
| --- | --- | --- | --- | --- |
| C1 | 契约模式执行时硬拒绝：Write/Edit/apply_patch/未知工具 block，**任何**权限模式下（含 auto/allow） | gate 单元 + 真实 OMP E2E | 执行前 block、无副作用；`auto` 也不能复活 | `permissions.rs:216-232,538,559`；`rpc/mod.rs:3488-3497` 拒绝码 |
| C2 | Bash 按有效权限模式（**不做命令分类**）：inherit→解析默认；ask→审批；accept-edits→Bash 仍审批；auto→放行；契约硬拒绝之上 | gate 单元 + 真实 OMP E2E | 与 PI `plan_bash_follows_permission_mode` 语义一致；Auto 警示文案保留 | `permissions.rs:250-260,547-556`；`plan-mode-source-contract.test.mjs` |
| C3 | 插件 `planSafeActions`：无非空声明的插件工具契约模式拒绝；有声明逐 action 允许/拒绝；ctx.mode = 真实模式（替换硬编码 agent） | desktop main 单元 + 桥接夹具 | 与 PI `plugin-runtime.ts:2504-2532` 同语义；补充 PI 缺失的专测 | ADR 0211；`plugin-runtime.ts:776-817` |
| C4 | 子代理 `hasUI=false`：契约模式策略 fail-closed（无交互审批，按策略拒绝）；Agent 模式与既有 T17 语义不变 | gate 单元 + 真实 OMP E2E | 子代理不因模式改变而获得更高权限；无 UI 无审批通道 | gate no-UI 分支；M1/T17 结论 |
| C5 | 高权限工具（browser/computer/eval）：任何模式下保持审批（含 auto 时按 T20 决策表，默认仍受控） | gate 单元 | 高权限工具不被模式切换静默放行 | `riskForTool` 高位表 |

### T20-D（Goal 差异与整体验收）

| 行 | 场景 | 层 | 期望 | 先例 |
| --- | --- | --- | --- | --- |
| D1 | SubmitGoal：`.pi/goal/*.md` 产物、goal 提示词（验收标准措辞）、批准后 agent 模式自主执行并自停 | host-core + 真实 OMP E2E | 与 PI goal 契约一致；**无延续定时器**（OMP interactive 专属，桌面 goal = 单回合契约 + 批准后普通 agent 回合，如实记录差异） | `mode-prompts.ts:18-32`；`plans/tests.rs:715` |
| D2 | goal_updated 透传事件的展示（可选，只读） | 桥接/渲染层 | 可呈现、不可驱动；不伪造 goal 状态 | `rpc-client.ts:158` |
| D3 | 端到端用户路径：切 Plan → 对话 → 审批卡 → approve(ask/accept-edits/auto) → agent 执行；reject → 修改重提；重启 → 无重放 | 真实固定 OMP E2E + 渲染层 | 完整闭环；T20 整体验收时执行 | `upstream/pi-desktop/docs/spec/03-runtime/10-session-state-machine.md` 状态机 |

---

## 8. 阻塞与未知（无未支持假设）

- **无硬阻塞**：rpc-ui 的三条进程内通道（`before_agent_start` systemPrompt 追加、`setActiveTools`、`tool_call` fail-closed 拦截）足以承载提示词塑造、目录过滤与执行前强制，全部已验证可达，**不需要修改上游 OMP**。T20-B 可以开始。
- **已知限制（设计前提，非假设）**：OMP 原生 Plan/Goal 状态机（interactive/ACP）不可复用；审批不持久不重放（桌面经 host-core `plan_approvals` 自持，语义由 §6.4 覆盖）；无 per-turn 权限模式 RPC——per-turn 权限策略只能经运行域状态 → gate 通道（§6.6）；`terminate:true` 的循环停住属于未 vendor 的 `pi-agent-core`（`[INFERENCE]`，OMP 侧无对应 flag，提交后停手语义的实测差异记 B4 验收）。
- **未知（T20-B/C 实测确认）**：`setActiveTools` 在延续回合/模型重试间是否持久（需实验）；gate 侧目录夹取与 `set_host_tools` 指纹重装配的交互顺序（需实验）；`inherit` 解析的全局默认读取点在 host-core 已有（PI），OMP 路径的投影时机待定（T20-B 决策）；goal 契约在 OMP 的"自停"表现（无定时器，依赖提示词与工具结果，D1 实测）。
- **如实声明**：当前 `OMP_DESKTOP_GATE_MODE`（ask|deny|allow，启动期）与 OMP `--approval-mode`（always-ask|write|yolo，启动期）**都不是** PI 权限模式（inherit/ask/accept-edits/auto）；在 §6.6 映射落地前，不得宣称既有 env 门已提供权限模式。

---

## 9. 验证命令与结果（Node 24，本轮记录）

环境修正（复审要求）：`source /home/vv/.nvm/nvm.sh && nvm use system`（本机 system → v24.14.0；`nvm use 24` 别名在本机为 N/A，已按 system 使用 v24.14.0）+ `export PATH="/home/vv/.bun/bin:/home/vv/.nvm/versions/node/v24.14.0/bin:$PATH"`；Bun 1.4.2。

| 命令（工作目录 `app/`） | 结果 |
| --- | --- |
| `node scripts/check-omp-plan-goal-gaps.mjs` | SKIP 行，退出 0（opt-in 未启用） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | 3×`GAP-OPEN` + g4 判定，退出 1（§4 记录完整输出） |
| `pnpm install --frozen-lockfile` | 完成（共享 store，1.9s；pi-host/pi-plugin dist 缺失的 bin 警告为本工作树构建前状态，与本次变更无关） |
| `pnpm build:js` | 0（renderer 5.85s；chunk>500kB 为既有提示） |
| `node --test apps/desktop/test/plan-drain-engine-gate.test.mjs apps/desktop/test/omp-session-configure.test.mjs apps/desktop/test/engine-router.test.mjs apps/desktop/test/plan-artifact-contract.test.mjs apps/desktop/test/plan-mode-source-contract.test.mjs` | **37 通过 / 0 失败 / 0 跳过**（相邻套件：派发引擎门/会话配置/引擎路由/产物契约/模式源码契约） |
| `pnpm lint:biome` | Checked 75 files，0 问题（`scripts/` 目录按仓库 biome.json 配置被排除，新诊断脚本不在 lint 面内） |
| `git diff --check` | 0 |
| `git submodule status` | OMP `d49918fab`、PI `0111e306` 未动；OMP 内 `bun install --frozen-lockfile` + `bun run build:native` 后 launcher 报 `omp/18.2.7`，子模块工作树干净 |

本轮未运行全量 desktop 套件（`node --test apps/desktop/test/*.test.mjs`）：T20-A 不修改任何 `app/` 产品代码（仅新增独立诊断脚本与文档），相邻五套件 37/37 已覆盖受影响接缝的默认行为；全量套件留待 T20-B 生产变更轮次。

---

## 10. T20 完成状态

**T20-A 已完成（本阶段：能力审计、固定基线证据、可执行红灯诊断、最小实现契约与验收矩阵）。T20-B/C/D 未开始；Plan/Goal 与高权限工具门未实现、未声称完成。** `branch`/`steer`/`followUp`/`compact`/子代理单独停止保持关闭（T17-T19 延续）。
