# M5/T20-A：Plan/Goal 与高权限工具能力门 —— 能力审计与可执行契约

更新时间：2026-09-25。状态：**T20-A 审计与最小契约已完成，但"无硬阻塞"结论已被可行性 spike 推翻：R3 是硬阻塞，T20-B 不得开始**（分支 `codex/m5-plan-goal-capability-gates`）。**四轮提交坐标（按真实 git 历史）**：审计基线 `2ca256520980aa80bb812730fbad132e9e95f503` → T20-A 初稿 `07de0a725269486c909d36bcccb9d8bb209770de` → R1-R4 返修 `5da616f04c1ec132954785b955c1b20cc17bfc54` → F1-F7 返修 `dd2ec72cbe2dc2d338ce20467da390bb1110601e` → **F8-F12 返修 `25e0d4d254ff641df1840cfe2cd767a7e9f00eb1`**；本文件当前描述的实验与判据以 F8-F12 提交为准，其后的 F13/F14 轮为纯文档澄清（无新增实验）。T20-B/C/D 未开始，**T20 未完成、未声称**。

本轮（F8-F12）结论摘要：

| 项 | 结论 | 证据 |
| --- | --- | --- |
| F8 g1 仍可被注释假绿 | **已修（采用保守方案）**：静态符号不能证明数据流，g1 **永不自动判 closed**——基线报 `GAP-OPEN`；任何 mode-ish state 字段 / composer 接缝 / 协议键都只报 `REVIEW-REQUIRED` 并计入退出码；退场只能由 T20-B 行为测试（B2/B13）替换。**负向对照**：仅在注释里写 `composeModeSystemPrompt`/`modePrompt` → `REVIEW-REQUIRED`（exit 1）；只加 state 字段 → `REVIEW-REQUIRED`；复原后 `GAP-OPEN`。脚本头部"disjunction"表述与文档中"真实链路"措辞已删除。 | §4 g1、`app/scripts/check-omp-plan-goal-gaps.mjs` 头部/判据 |
| F9 R4-4 变化测试是假的 | **已修**：第三个 prompt 现在是**真实变化**（catalog 加 `SubmitGoal`、clamp 改为 `read,grep,glob,bash,SubmitGoal` 去掉 `HostEcho`），实测 attempts **2 / 1 / 2**，三 prompt 工具表与各自 clamp 严格相等。 | §4.2 R4-4、§7 B12 |
| F10 字节证据标错 | **已修**：`systemBytes` 改用 `Buffer.byteLength(text, "utf8")`，并新增 `prefixBytes = systemBytes − blockBytes` 断言（三 prompt 均满足且 prefix>0）；重跑后实际值 systemBytes=14608/16158/16592、blockBytes=176/1726/2156、prefixBytes=14432/14432/14436。此前"12200/13748/14178 字节"与"差值即块长"的表述已删除。 | §4.2 R2-字节 |
| F11 R4-3 证据范围过度 | **已修**：§4.2 与 B13 改称"**目标模式目录序列 / 模拟的 catalog 生命周期**"，明确它**不证明**真实持久 `sessions.mode` 切换（T20-B 尚未实现），真实模式切换仍是 B1/B13 验收项；同 session 连续 prompt、目录增删重加、无滞留的结论保留。 | §4.2 R4-3、§7 B13 |
| F12 外部路径行含义 | **已修**：矩阵该行注明**仅适用于已通过契约 allowlist 的工具**；`ask`/`accept-edits` 无 session grant 弹卡、有 grant `AllowSession`；Plan/Goal 的非许可工具仍先被契约硬拒绝。 | §1.3.1 矩阵末行 |

文档澄清（F13/F14，纯文档轮，无新增实验）：

- **g1 最终口径唯一化（F13）**：本文件所有历史行（F2、F1-F7 表、R1-R4 表）都只作为历史事实保留；凡提到"四段链路可判 `GAP-CLOSED`"的地方都已标注**该静态分支已被 F8 推翻并删除，现状以 F8 为准**。当前契约（§4 g1）：g1 **永不自动判 closed**——基线 `GAP-OPEN`，出现 mode-ish state 字段 / composer 接缝 / 协议键一律 `REVIEW-REQUIRED` 并计入退出码，退场只能由 T20-B 的 B2/B13 行为测试替换。
- **提交坐标唯一化（F14）**：四轮提交与各自基线见下表；文中凡引用这些 SHA，语义按本表判定（"基线"= 该轮开工时的提交，"返修"= 该轮的产出提交）。

| 轮次 | 产出提交 | 该轮基线 |
| --- | --- | --- |
| T20-A 初稿（审计 + 红灯诊断 + 契约） | `07de0a725269486c909d36bcccb9d8bb209770de` | `2ca256520980aa80bb812730fbad132e9e95f503`（审计基线） |
| R1-R4 返修（权限语义、mode block、R3 硬阻塞、R4 顺序） | `5da616f04c1ec132954785b955c1b20cc17bfc54` | `07de0a7` |
| F1-F7 返修（风险表、严格序列、目录生命周期、真实字节、矩阵唯一性） | `dd2ec72cbe2dc2d338ce20467da390bb1110601e` | `5da616f` |
| F8-F12 返修（g1 保守判据、R4-4 真实变化、UTF-8 不变量、范围收窄） | `25e0d4d254ff641df1840cfe2cd767a7e9f00eb1` | `dd2ec72` |
| F13/F14 澄清（纯文档，无实验） | F8-F12 之后的文档提交 | `25e0d4d` |

前一轮（F1-F7）结论摘要：

| 项 | 结论 | 证据 |
| --- | --- | --- |
| F1 风险表事实错误 | **已修**：§1.3.1 矩阵不再把 `BrowserPreview`/`new_context` 写成"Low/契约许可放行"——`BrowserPreview` 在 `plan_mode_allows` 内但**不在风险表 → Medium**（`ask`/`accept-edits` 卡、`auto` 放行、grant 可 `AllowSession`）；`new_context` 是 sidecar-side、不到 host gate。C7 并入这条验收（矩阵保持 C1-C8），C1 明确契约许可集合。 | §1.3.1、§7 C1/C7 |
| F2 g1 可假绿 | **已修（其静态判据已被 F8 推翻，现状以 F8 为准）**：F2 当时把 g1 改为"四段链路同时成立"（状态 schema 有 mode block 字段 / 引擎接缝同一文件既 compose 又写状态 / gate 读校验后状态 / gate 追加且引用该字段名，裸 `mode` 不算），并观察到"注入完整链路 → `GAP-CLOSED`"。**该静态 `GAP-CLOSED` 分支已由 F8 删除**：静态符号不能证明数据流，g1 现在**永不自动判 closed**——基线 `GAP-OPEN`，出现字段/composer 接缝/协议键一律 `REVIEW-REQUIRED`，只由 T20-B 的 B2/B13 行为测试替换退场（见下方 F8 行与 §4）。F2 保留的历史事实：裸 `mode` 字段不构成证据、协议加键走 `REVIEW-REQUIRED`。 | §4 g1（最终口径）、F8 行、`app/scripts/check-omp-plan-goal-gaps.mjs` |
| F3 R4-3 假绿 | **已修**：R4 工具表断言改为**严格序列相等**（缺失/多余/顺序/重复皆失败），不再用"子集"。重测的旧写法正是丢了 `SubmitGoal` 仍通过，现已判红。 | §4.2 R4-3、`t20-feasibility.mjs` `sameSequence` |
| F4 生命周期未覆盖 | **已修**：同一 session 上 5 个连续 prompt，每 prompt 先真实 `set_host_tools` 再夹取：Agent(无提交工具)→Plan(`SubmitPlan`)→Goal(`SubmitGoal`)→Agent(删除)→Plan(重加)；`SubmitGoal` 用真实定义注册；5 个工具表与 catalog+clamp 严格相等、无重复/滞留；反向顺序对照与 policy retry 计数保留。 | §4.2 R4-3/R4-2/R4-4 |
| F5 R2 证据过度声明 | **已修**：spike 现在追加的是**生产 `composeModeSystemPrompt(mode, "")` 的三个真实块**（Agent/Plan/Goal，UTF-8 176/1726/2156），断言各自恰出现一次、其它块 0 次、单 system 消息、PI 默认 base 不出现、块为纯追加（system = prefix + block，工具目录相同的 prompt 前缀字节相同），同时断言 `app` 与固定 PI 的 `mode-prompts.ts` 逐字节相等；**技能/记忆块内容与顺序**明确留作 T20-B 的 B2 ④，§4.2 不再声称覆盖。 | §4.2 R2-字节/R2-范围声明、§7 B2 |
| F6 矩阵重复 | **已修**：删除重复的 B6-B10 行；新增 `app/scripts/check-t20-matrix-ids.mjs`（B1-B14、C1-C8、D1-D3 每个编号恰一次），并用含重复的旧文档验证过它会判红。 | §7、`app/scripts/check-t20-matrix-ids.mjs` |
| F7 行号不一致 | **已修**：`permissions.rs:219-235` → `219-234`（与固定源码代码块一致）；本轮新增/修改的关键行号已按固定源码逐一核对（`128-141`、`148-153`、`219-234`、`238-248`、`250-269`、`4167-4172`、`442-452`、`910-922`、`8714-8725`、`2003-2005`、`407`、`6691-6760`）。 | §1.3.1、§4.2、§6.6、§7 |

此前（R1-R4 返修轮）结论摘要：

| 项 | 结论 | 证据 |
| --- | --- | --- |
| R1 permissionMode/风险语义 | **契约已修**：新增 §1.3.1 完整有效权限决策表；`mcp_*` = PI `Risk::Low`（此前文档称 medium 与 PI 一致，已更正）；plugin 风险按 manifest 声明、缺失/非法 → medium；browser/computer/eval 是 OMP 名，PI 无对应名（PI parity = medium/未知，现状 gate 映射为 high 属桌面选择），**Agent+auto 仍按 PI 放行**；Plan/Goal 下它们是契约硬拒绝（不在 `plan_mode_allows`），不是"仍需审批"。 | §1.3.1、§5 G9、§7 C5-C7 |
| R2 模式提示词拼接 | **契约已修**：只使用 `composeModeSystemPrompt(mode, "")` 的 mode block（base 为空串时被 `.filter(Boolean)` 丢弃），追加到 `event.systemPrompt`；不注入 `DEFAULT_RUNTIME_SYSTEM_PROMPT`、不复制 OMP 原生 prompt。spike 实测（本轮升级为真实块）：三模式块各恰一次、单 system 消息、PI 默认 base 不出现。 | §1.1、§4.2 R4-4/R2-字节 |
| R3 SubmitPlan/SubmitGoal 独占批次与终止 | **硬阻塞**：固定 OMP 无批次可见性、无 terminate 通道、host tool 无 concurrency 覆盖；spike 六场景全部失败（同批兄弟工具产生真实副作用、重复提交执行两次、提交成功后模型继续 2 步并继续执行工具、失败终支同样不终止）。唯一能阻止同批副作用的杠杆是 `ctx.abort()`，且只得到"整回合 aborted"语义，不是 PI 的 block-and-continue。**T20-B 不得开始。** | §4.2 R3-1…R3-7、§8 |
| R4 setActiveTools/set_host_tools 顺序 | **已定并实测**：每 prompt 必须**先** `set_host_tools` 完成目录替换，再由 `before_agent_start` 的 `setActiveTools` 夹取；顺序颠倒会被自动激活撤销（实测重新暴露）。收敛：首次变更恰 1 次 policy retry（attempts=2），同 clamp 的下一 prompt 恰 1 次，未出现第 3 次或 `AgentStartPolicyChangedError`。 | §4.2 R4-1…R4-4、§7 B11-B13 |

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

- 契约模式硬拒绝**先于**低风险分类、auto、grants、scratch 例外：`permissions.rs:219-234`——`is_contract_mode && !plan_mode_allows` 时，`plugin_*` 仅当转发来的 `planSafeActions` 非空才放行（执行时由 plugin-runtime 按 action 把关），其余（Write/Edit/未知）一律 `Deny`。拒绝码 `rpc/mod.rs`（上游行 3488-3497）：`WRITE_DISABLED_IN_PLAN` / `EDIT_DISABLED_IN_PLAN` / `PLUGIN_DISABLED_IN_PLAN` / `TOOL_DISABLED_IN_PLAN`（未知及其他），审计 `tool_denied`。**权威模式是持久模式**：`tools/mod.rs:559-561` 忽略边车 `mode` 字段（`_mode`），`rpc/mod.rs` 上游行 3212-3217 读 `sessions::session_mode`。
- **Bash 无命令白名单**：Bash 在 `plan_mode_allows` 内（`permissions.rs:151`），走常规风险（High）与权限模式判定（`permissions.rs:250-269`）：`auto → AllowOnce`；`accept-edits → 仅 Write|Edit`；`ask → 无（弹卡）`；grants 仍可放行。即 Plan/Goal 的 Bash 由 permissionMode 决定——**提示词要求只读使用，但硬边界是权限模式，不是命令分类**；`plan-mode-source-contract.test.mjs` 钉死“Auto 会不问即执行 Bash、可能改文件”的警示文案。模型侧只读要求是提示词层（`mode-prompts.ts:10`）。
- **强制测试**：`permissions.rs:538`（三种 permission mode 下 Write 皆拒）、`:547-556`（`plan_bash_follows_permission_mode`：ask→None、auto→AllowOnce）、`:559`（grants+auto 也不能放行 Write/Edit/plugin/未知）、`:577-605`（Goal 同语义）；`rpc/mod.rs` 上游行 8130 起 `plan_authorization_uses_durable_mode_and_keeps_bash_permission_semantics`（Plan+auto 下 Bash 真执行、切 ask 后须审批、四类工具拒绝码逐一断言）、上游行 8265 起 goal 对称测试。

### 1.3.1 有效权限决策表（R1 返修：完整、以固定 PI 为唯一证据）

**有效权限模式解析**（先于任何工具判定；`inherit` 由调用方折叠）：

| 序 | 输入 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 会话持久 `sessions.permission_mode`（`inherit\|ask\|accept-edits\|auto`，默认 `inherit`）且 ≠ `inherit` | 该值即有效模式 | `permissions.rs` doc comment（"the caller collapses `inherit` against the global default before calling"）；spec `03-tools-and-permissions.md:421-431` |
| 2 | 否则全局 `defaultPermissionMode` | 该值 | 同上 `:424` |
| 3 | 否则 | `ask` | 同上 `:425` |

**风险分类** `tool_risk_with_declared(name, declared)`（`permissions.rs:128-141`）：

| 工具名 | 声明风险 | 结果 |
| --- | --- | --- |
| `Read`/`Glob`/`Grep`/`ScheduledTaskList` | — | `Low` |
| `Write`/`Edit`/`Bash`/`GenerateImages` | — | `High` |
| `plugin_*` | `"low"`/`"medium"`/`"high"` | 同声明值 |
| `plugin_*` | 缺失或非法 | `Medium`（注释原文："A missing or malformed manifest declaration is not a low-risk grant"） |
| `mcp_*` | — | **`Low`**（R1：此前 HANDOFF/M5-host-tool-rpc 把 OMP 现状 `mcp_=medium` 说成"与 PI 一致"，错误，已更正） |
| 其它（未知，含 PI 无对应名的 OMP 工具） | — | `Medium` |

**决策顺序**（`evaluate_auto_with_permission_mode_and_risk_and_path`，`permissions.rs:195-270`）：

| 序 | 条件 | 决策 |
| --- | --- | --- |
| 1 | 契约模式（`plan`\|`goal`）且工具 ∉ `plan_mode_allows`（`Read`/`Glob`/`Grep`/`Bash`/`BrowserPreview`/`new_context`）：`plugin_*` 且**转发来的 `planSafeActions` 非空** → 落入后续常规判定（执行时由 plugin-runtime 逐 action 把关）；否则（Write/Edit/未知/`mcp_*`/无声明插件） | `Deny`（先于低风险分类、auto、grants、scratch 例外） |
| 2 | 显式外部路径（workspace/scratch 之外）：有效模式 `auto` → `AllowOnce`；该工具已有 session grant → `AllowSession`；否则 | 弹卡（无自动决策） |
| 3 | 风险 = `Low` | `AllowOnce`（所有模式） |
| 4 | 有效模式 `auto` → `AllowOnce`；`accept-edits` → 仅 `Write`/`Edit` `AllowOnce`；`ask` → 无自动决策 | 见左 |
| 5 | 该工具已有 session grant | `AllowSession` |
| 6 | 其余 | 弹卡；**无 UI 时不额外放宽**——只在本来就需要交互时 fail closed（pending 超时 120 s `send(PermissionDecision::Deny)`，`expire_stale` 同） |

**模式 × 工具矩阵**（Agent = `mode:"agent"`）：

| 模式 | 工具/风险 | `ask` | `accept-edits` | `auto` |
| --- | --- | --- | --- | --- |
| Agent | `Write`/`Edit`/`Bash`/`GenerateImages`（High）、未知（Medium）、`plugin_*`（medium/high） | 卡 | 仅 Write/Edit 放行，其余卡 | **放行** |
| Agent | `Read`/`Glob`/`Grep`/`ScheduledTaskList`（Low）、`mcp_*`（Low）、`plugin_*`（low） | 放行 | 放行 | 放行 |
| Agent | `BrowserPreview`（**不在风险表内 → Medium**） | 卡 | 卡 | 放行 |
| Agent | `plugin_*` 声明缺失/非法（Medium） | 卡 | 卡 | 放行 |
| Plan/Goal | `Read`/`Glob`/`Grep`（Low，且在 `plan_mode_allows` 内） | 放行 | 放行 | 放行 |
| Plan/Goal | `BrowserPreview`（在 `plan_mode_allows` 内，但**不在风险表内 → Medium**）：契约硬拒绝只**绕过**它，之后仍走普通权限模式判定，session grant 可 `AllowSession` | **卡** | **卡** | 放行 |
| Plan/Goal | `new_context`（在 `plan_mode_allows` 内，但固定源码注明它是 **sidecar-side 工具**，不经过 host gate——没有风险等级/弹卡语义，bridge 两侧只为清单一致而列出） | n/a（sidecar） | n/a | n/a |
| Plan/Goal | `Bash`（High，在 `plan_mode_allows` 内） | 卡 | 卡 | **放行**（提示词只读，硬边界是权限模式） |
| Plan/Goal | `Write`/`Edit`/未知/`mcp_*`/`plugin_*` 无声明 | **Deny** | **Deny** | **Deny** |
| Plan/Goal | `plugin_*` 有非空 `planSafeActions` | 同 Agent 行（按声明 risk） | 同 | 同 |
| 任一模（**仅限已通过契约 allowlist 的工具**） | 显式外部路径：`auto` 放行；`ask`/`accept-edits` 在无 session grant 时弹卡，有该工具的 session grant → `AllowSession`；**Plan/Goal 的非许可工具仍先被契约硬拒绝（第 1 步），不会走到本行** | 卡（无 grant） | 卡（无 grant） | 放行 |

**OMP 名称映射（R1 要求明确）**：`browser`/`computer`/`eval` 是 **OMP 原生工具名**（`tools/browser.ts`、`tools/computer.ts`、`tools/eval.ts`），固定 PI 的风险表没有这三个名字——PI parity 下它们是"未知 → Medium"，桌面 gate 现状把它们映射为 `high` 属**桌面选择（更严格）**，不是 PI 证据。无论取哪一种，**Agent+auto 下 PI 语义都是放行**（auto 放行 High/Medium），`ask`/`accept-edits` 下需要卡；Plan/Goal 下它们不在 `plan_mode_allows`，**直接契约硬拒绝**（不是"仍受审批"）。若要采用比 PI 更严格的策略（例如 auto 下仍审批高权限工具），必须作为**经用户决定的兼容差异**记录；本轮无此决定，默认按 PI。

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

- **R1 返修补充（有效权限模式的运行期通道）**：桌面的 `permissionMode` 与 OMP 运行期之间**没有任何映射通道**——协议面无 permission/permissionMode 字段（§2.1 的 42 命令全列）、`configure` 只写 host DB（G1）、gate 只有启动期 `OMP_DESKTOP_GATE_MODE=ask|deny|allow`（不是 PI 权限模式，且桌面不写）。OMP 原生名 `browser`/`computer`/`eval` 在固定 PI 风险表里**没有条目**（PI parity = 未知 → Medium；桌面 gate 现映射为 high 属更严格的桌面选择，不是 PI 证据）。完整决策表见 §1.3.1：这三个工具在 **Agent+auto 下按 PI 放行**，`ask`/`accept-edits` 下弹卡，Plan/Goal 下由契约硬拒绝。**不得**把"任何模式都审批"写成契约。

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
| Plan/Goal/模式状态协议可读 | 进程内 | 有（session payload 内 modes） | 无 | **无** | `rpc-types.ts:95-117`；`acp-agent.ts:2047-2057` |
| PI 有效权限模式（`inherit/ask/accept-edits/auto`） | 有（host-core 决策） | ACP per-call 权限门 | 无 | **无**（gate 只有启动期 `ask/deny/allow` 启动策略，桌面不写） | §1.3.1、§2.5、G5 |

**rpc-ui 判定总结**：rpc-ui = rpc + 工具 UI 上下文（`ask` 等），协议面与 rpc 完全一致；**没有**任何 Plan/Goal/权限模式命令或状态。可行的是三条进程内通道（全部无需改上游）：`before_agent_start` 的 systemPrompt 追加（提示词塑造）、`setActiveTools`（工具目录过滤）、`tool_call` 执行前 fail-closed 拦截（执行时拒绝，载荷 toolCallId/toolName/input，上下文 hasUI/sessionManager/cwd）。OMP 自身的 Plan/Goal（interactive/ACP）不可复用（proposal handler、TUI overlay、elicitation、goal 定时器均绑定 UI 上下文），审批不持久、不重放。**R3 返修补充（实测边界）**：这三条通道**不覆盖**过渡工具的独占批次与提交后终止——`tool_call` 看不到同一 assistant 批次的兄弟调用，host tool 也没有 `concurrency`/`terminate` 覆盖（§4.2 六场景实测），见 G8 硬阻塞。**结论：rpc-ui 足以支撑桌面自有的 Plan/Goal 提示词/目录/执行前拦截，但不足以承载 PI 的提交-终止契约；必须由桌面自建状态机与审批闭环，不存在"原生兼容"，也不能靠提示词或结果文本假装兼容。**

---

## 4. 基线红灯探针（可执行证据）

新增 `app/scripts/check-omp-plan-goal-gaps.mjs`（跟随仓库 `check-*` 脚本约定）：**独立 opt-in 诊断**，不进默认测试套件；只读当前已发布源码接缝报告事实，不传虚构字段、不断言未定 API。无 `OMP_T20_GAP_PROBE=1` 时打印 SKIP 并退出 0；有则每缺口一行稳定输出，任何 T20 缺口开放即退出 1。

运行命令与输出（F8-F12 返修轮；当时工作树基于 `dd2ec72`，该轮产出提交为 `25e0d4d`；Node v24.14.0，工作目录 `app/`）：

```text
$ node scripts/check-omp-plan-goal-gaps.mjs
SKIP: T20-A gap diagnostic not enabled (set OMP_T20_GAP_PROBE=1 to run it)
exit=0

$ OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs
GAP-OPEN g1 (owner: T20-B) session mode/permissionMode persist to the host DB only; no OMP prompt/tool path reads them [evidence: pinned prompt command has no mode/systemPrompt/tools key: true; state mode-ish fields: none; engine seams referencing the mode composer: none; gate reads the validated state (T19-C skills/memory only, not mode): true; retirement: T20-B behavior test (B2/B13) replaces this check; g1 never auto-closes]
GAP-OPEN g2 (owner: T20-C) the host-tool adapter executes every plugin tool with a hardcoded mode 'agent'; the session's durable mode never reaches plugin execution [evidence: omp-host-tools.ts hardcoded execution-context mode literal present: true]
GAP-OPEN g3 (owner: T20-B) an approved Plan/Goal execution for an OMP session is refused before claiming; the queued row stays queued and nothing runs on the OMP engine [evidence: runtime/plans.ts refuseOutsidePiRuntime("plan execution") present: true]
VERDICT g4: pinned rpc-ui RpcCommand union has 42 commands: negotiate_protocol, prompt, steer, follow_up, abort, abort_and_prompt, new_session, get_state, set_fast_mode, get_available_commands, set_todos, set_host_tools, set_host_uri_schemes, set_subagent_subscription, get_subagents, get_subagent_messages, set_model, cycle_model, get_available_models, set_thinking_level, cycle_thinking_level, set_steering_mode, set_follow_up_mode, set_interrupt_mode, compact, set_auto_compaction, set_auto_retry, abort_retry, bash, abort_bash, get_session_stats, export_html, switch_session, branch, get_branch_messages, get_last_assistant_text, set_session_name, handoff, get_messages, get_messages_page, get_login_providers, login
VERDICT g4: no plan/goal/permission/approval command exists in the pinned rpc-ui surface (rpc-ui = rpc + tool-UI context; see the validation document)
SUMMARY: 3 gap(s) open [g1, g2, g3]
exit=1
```

各检查证明什么：**g1**（红，F8 返修后的**保守判据**）——静态符号**不能**证明数据流，因此 g1 **永不自动判 closed**：(a) 基线（无 mode-ish state 字段、无 composer 接缝、无协议键）报 `GAP-OPEN`（证据串列出实测 `none`/`none`）；(b) 只要出现 mode-ish state 字段、composer 接缝（`composeModeSystemPrompt`/`mode-prompts`）或协议 `prompt` 的 mode/systemPrompt/tools 键，一律报 `REVIEW-REQUIRED` 并计入退出码，附命中符号供人工重审——**不判 GAP-CLOSED**；(c) g1 的退场方式只有一个：T20-B 的行为测试（B2/B13）替换本检查。**负向对照（本轮实做，注入后均 `git checkout` 复原）**：① 只在 `omp-session.ts` 与 gate 里各加一行**注释**提到 `composeModeSystemPrompt`/`modePrompt` → `REVIEW-REQUIRED g1`（`engine seam references the mode composer: omp-session.ts`），退出 1；② 只给 state 加 `modePrompt` 字段 → `REVIEW-REQUIRED g1`（`runtime-domain state has mode-ish field(s): modePrompt`），退出 1；③ 复原后回到 `GAP-OPEN`。即"字段 + 关键词"无论如何都进重审分支，不会被判绿。**g2**（红）——`omp-host-tools.ts` 插件执行上下文仍是硬编码 `mode: "agent"` 字面量 → 真实模式不传播；**g3**（红）——`runtime/plans.ts` 仍以 `refuseOutsidePiRuntime(…, "plan execution")` 拒绝 OMP 会话的已批准计划执行 → 队列行为 queued、永不运行；**g4**（判定，非缺口）——固定 rpc-ui 命令面 42 个变体全列，无 plan/goal/permission/approval 命令；若未来上游新增此类命令，该行变为 `REVIEW-REQUIRED` 并计入退出码。该脚本是诊断而非正确性断言：仍是 opt-in、不进默认套件，T20-B/C 落地后由真实行为测试替换，不得转正为 pin。

### 4.2 可行性 spike（R3/R4 的行为证据，固定 OMP + fake provider）

新增 `app/experiments/omp-bridge/t20-feasibility.mjs`（驱动）+ `app/experiments/omp-bridge/extensions/t20-spike-gate.ts`（可信扩展），复用 M1 的隔离夹具（`lib/base.mjs` 合成 HOME、`lib/provider.mjs` 本地 fake provider、`lib/rpc.mjs` 协议客户端、固定 launcher `omp/18.2.7`），**不调用任何付费/远程模型**；结果落 `app/experiments/omp-bridge/results/t20-feasibility.json`。每次断言的是 **PI 目标契约**，失败即该契约在固定 OMP 上不可实现的行为证据。

命令与结果（F8-F12 返修轮；工作树基于 `dd2ec72`，该轮产出提交 `25e0d4d`；Node v24.14.0）：

```text
$ cd app/experiments/omp-bridge && node t20-feasibility.mjs
FAIL t20-feasibility: 38/46 checks
```

**R3（SubmitPlan/SubmitGoal 独占批次与终止）——8 项契约检查全部失败，且失败的只有这 8 项（下表为本轮重测结果，与上一轮一致）：**

| 场景 | 观测（`results/t20-feasibility.json` artifacts） | 结论 |
| --- | --- | --- |
| R3-1 同批 `[bash, SubmitPlan]` | hook 顺序 `bash, SubmitPlan`；兄弟 `bash` 真实落盘（`bashSideEffect: true`）；`SubmitPlan` 产生 1 次 `host_tool_call`；2 次 provider 请求 | 同批兄弟有副作用、过渡工具照常执行 |
| R3-2 同批 `[SubmitPlan, bash]` | 同上（顺序颠倒不影响结论） | PI 要求"批次内任何其它调用零副作用"不成立 |
| R3-3 同批 `[SubmitPlan, SubmitPlan]` | **2 次** `host_tool_call`（同一回合两次提交） | PI 的整批阻断不存在 |
| R3-3b gate 在 `tool_call` 里 block `SubmitPlan` | `spike_block` 命中，`host_tool_call` = 0，但兄弟 `bash` 仍落盘 | `tool_call` 载荷无批次视图（payload keys 实测只有 `type`/`toolName`/`toolCallId`/`input`），逐调用 block 保护不了兄弟 |
| R3-4 提交成功后模型继续 | provider 请求 3 次（提交结果后又 2 步）；继续的工具真实执行 | 无 `terminate` 通道：提交成功不终止回合 |
| R3-5 提交失败终支 | provider 请求 3 次；继续的工具真实执行 | 失败终支同样不终止 |
| R3-6 abort 时挂起的提交 | `host_tool_cancel` 按 `targetId` 关联；1 次 `agent_end`；abort 后 `get_state` 成功（会话仍可观察） | **这三项（取消关联、终止、事后可观察）成立**，是 T20-B 可依赖的部分 |
| R3-7 唯一可用的批次杠杆：拦截过渡工具时 `ctx.abort()` | 兄弟 `bash` 零副作用，但回合以 `stopReason: "aborted"` 结束，模型不再补一个单调用 `SubmitPlan` | 得到的是"整回合取消"语义，不是 PI 的 block-and-continue |

**根因（固定源码）**：`packages/coding-agent/src/modes/rpc/host-tools.ts` `RpcHostToolAdapter.concurrency` 硬编码 `"shared"`、`RpcHostToolDefinition` 无 `concurrency`/`terminate` 字段（`rpc-types.ts:442-452`）；扩展 `tool_call` 事件载荷无批次/助手消息（`agent-session.ts:4167-4172`）；`AgentToolResult` 无 `terminate`（`packages/agent/src/types.ts:910-922`）；唯一"优雅终止"路径 `#isTerminalYieldToolResult` 只认字面 `toolName === "yield"`（`agent-session.ts:8714-8725`，`yield` 是 hidden 内置子代理工具 `tools/builtin-names.ts:35`）；扩展 `ExtensionContext.abort()` 不接收 reason 且语义是用户打断（`runtime-init.ts` `abort: () => session.abort({ reason: USER_INTERRUPT_LABEL })`）。

**R4（顺序、目录生命周期与收敛）与 R2（mode block 字节）——全部通过（R4 断言为严格序列相等：缺失、多余、顺序不符或重复都判失败）：**

| 场景 | 观测（`results/t20-feasibility.json` artifacts） | 结论 |
| --- | --- | --- |
| R4-1 先 `set_host_tools` 再 `before_agent_start` 内 `setActiveTools` | provider 实际工具表与 clamp **严格相等**：`read,grep,glob,bash,SubmitPlan`（`HostEcho` 被隐藏） | **这就是唯一正确顺序** |
| R4-2 先夹取、后注册（对照） | 第一 prompt 严格等于 `read,grep,glob,bash`；第二 prompt 出现 `SubmitPlan,HostEcho` | `#applyRpcHostToolRefresh` 的 `autoActivatedRpcToolNames`（`session/session-tools.ts:2003-2005`）会撤销先前夹取——顺序颠倒即重新暴露 |
| R4-3 **目标模式目录序列 / 模拟的 catalog 生命周期**（同一 RPC session、5 个连续 prompt，每 prompt 先真实 `set_host_tools` 再夹取）：Agent 目录(无提交工具) → Plan 目录(`SubmitPlan`) → Goal 目录(`SubmitGoal`) → Agent 目录(删除提交工具) → Plan 目录(重加 `SubmitPlan`) | 5 个 prompt 的工具表与各自 catalog+clamp **逐一严格相等**、无重复：`…,HostEcho` → `…,HostEcho,SubmitPlan` → `…,HostEcho,SubmitGoal` → `…,HostEcho` → `…,HostEcho,SubmitPlan`；prompt 3 只有 `SubmitGoal`（无 `SubmitPlan`）；prompt 4 两者都不在；prompt 5 `SubmitPlan` 回来；`before_agent_start` 各 1 次 | 同一 session 上真实增/删/重加提交工具、目录无滞留/重复、夹取收敛；**这里改变的是 catalog 与夹取，以及 prompt 文本标签——没有改变持久 `sessions.mode`（T20-B 尚未实现），因此不证明真实模式切换**；真实持久模式切换仍是 B1/B13 的 T20-B 验收项（spike 记录为"目标模式目录序列"） |
| R4-4 同一 handler 内"夹取 + 追加真实 mode block"（T20-B 的真实形态，三种模式各一次；第三个 prompt 是**真实变化**：catalog 加 `SubmitGoal`、clamp 去掉 `HostEcho`） | attempts 实测 **2 / 1 / 2**：首次变更（夹取+块）1 次 policy retry（`AGENT_START_POLICY_MAX_ATTEMPTS = 3`，`agent-session.ts:407`）后投递；第二个 prompt 同目录同 clamp → **1 次**；第三个 prompt 目录+clamp 真实变化 → **2 次**；三个 prompt 工具表与各自 clamp 严格相等 | 收敛成立（真实变化也在 1 次 retry 内），不出现第 3 次或 `AgentStartPolicyChangedError` |
| R2-字节（并入 R4-4，UTF-8） | 追加的块是生产 `composeModeSystemPrompt(mode, "")` 输出：blockBytes=**176/1726/2156**，各自恰出现 1 次、其它块 0 次；systemBytes=**14608/16158/16592**，prefixBytes=`system − block`=**14432/14432/14436**（三个 prompt 均满足 system = prefix + block 且 prefix>0）；prompt 0/1 工具目录相同 → 前缀字节相同；prompt 2 工具目录变化 → 前缀 +4 字节（`SubmitGoal` 进入原生工具清单），**块仍是纯追加**（前缀内不含任何 mode block）；`role:"system"` 恰 1 条；PI `DEFAULT_RUNTIME_SYSTEM_PROMPT` 不出现 | **mode block 的字节与追加形态**已实测（此前把 `text.length` 当字节的记述已按 F10 更正为 `Buffer.byteLength(..., "utf8")`）；`app` 与固定 PI 的 `mode-prompts.ts` 逐字节相等（spike 内断言） |
| R2-范围声明 | — | 本 spike 覆盖 **mode block 的字节与追加 transport**；技能/记忆块的**内容与相互顺序**属 T19-C 通道 + B2 的未来必测项，§4.2 只证明"块是纯追加、前缀不掺块"，不代替 B2 的 ④ |



---

## 5. 当前差距表（OMP Desktop 产品代码基线 `2ca2565`；T20-A 至今各轮返修均未改产品代码，差距仍以该状态为准）

| 编号 | 差距 | 证据（app/，行号已验证） | 归属 |
| --- | --- | --- | --- |
| G1 | mode/permissionMode 仅持久化 | 诊断 g1（R1 返修后判据）：固定协议 prompt 无 mode 键、`desktop-state.ts` 快照无 mode 字段、引擎接缝不含 `composeModeSystemPrompt`；`omp-session.ts:1847-1849` 的持久化分支仅为旁证，不再作为判据 | T20-B |
| G2 | 插件执行硬编码 agent 模式 | `apps/desktop/electron/main/runtime/omp-host-tools.ts:356` `mode: "agent"`（执行上下文字面量）；`planSafeActions`（PI `plugin-runtime.ts:2505-2525`）在 OMP 路径因此惰性 | T20-C |
| G3 | 已批准计划执行 Pi-only 拒绝 | `apps/desktop/electron/main/runtime/plans.ts:446-461` `refuseOutsidePiRuntime(engineRouter.require(session,"prompt"), "plan execution")`（引擎判定先于任何持久变更，`:424-427`）；拒绝实现 `runtime/engine-router.ts:61-71` | T20-B |
| G4 | 能力表无 plan/goal 键 | `app/packages/shared/src/engine.ts:131-143` `OMP_ENGINE_CAPABILITIES` 只有 prompt/stop/resume/branch/steer/followUp/modelSwitch/structuredQuestions/toolApproval/subagentEvents | T20-B |
| G5 | 网关策略无模式/权限模式输入 | `app/packages/omp-runtime/extensions/omp-desktop-gate.ts` `decideToolCall` policy 仅 `{gated, mode: ask/deny/allow, timeoutMs, sessionAllowed}`（`:245-258` 决策表）；`OMP_DESKTOP_GATE_MODE` 桌面从不写（仅 E2E extraEnv）→ 每会话恒 ask | T20-B |
| G6 | 桥接无提交/审批 RPC 面 | `omp-session.ts` 无 `plans.*`；`ipc/agent-ipc.ts:1099-1105` 审批前要求 Pi 引擎（`refuseOutsidePiRuntime(…, "plan approval")`） | T20-B |
| G7 | OMP 自身 Plan/Goal 不可达 | 见 §2.4/§3：proposal handler 无 rpc 安装点、审批不持久、goal 定时器仅 interactive | 事实，设计前提 |
| **G8** | **过渡工具独占批次与回合终止不可实现（硬阻塞）** | §4.2：R3-1/2/3 同批兄弟有真实副作用、重复提交执行 2 次；R3-4/5 提交成功或失败后模型继续 2 步并继续执行工具；根因 `RpcHostToolAdapter.concurrency` 硬编码 shared、`RpcHostToolDefinition` 无 concurrency/terminate、`AgentToolResult` 无 terminate、扩展 `tool_call` 载荷无批次、`#isTerminalYieldToolResult` 只认 `"yield"`。唯一杠杆 `ctx.abort()` 只得到整回合 aborted | **T20-B 不得开始**；需上游能力或用户接受的语义差异 |
| **G9** | **网关风险靠名字猜，无法表达 PI 声明风险** | `omp-desktop-gate.ts:75-93` `riskForTool`：`plugin_*`→high、`mcp_*`→medium、其余按名字 switch；PI 侧 `plugin_*` 取 manifest 声明（缺失/非法→medium）、`mcp_*` 是 **Low**（§1.3.1）。协议面没有任何声明风险通道，gate 也看不到 manifest | T20-B/C（见 §6.10） |

可复用（已验证）：host-core plans 模块（产物/审批/claim/boot_maintenance，与引擎无关的 Rust 状态机）、`PlanApprovalBar.tsx` + `plan-mode-state.ts`（引擎无关渲染）、`composeModeSystemPrompt`（纯函数）、composer `MODE_CYCLE`（已持久化到 OMP 会话）、T19-C 的运行域状态文件 + `before_agent_start` 注入通道、受信 gate 的 `tool_call` 执行前拦截与 `setActiveTools` 目录通道。

---

## 6. 最小后续实现（设计决策，供 T20-B/C/D 执行）

**原则**：复用 Pi 的 host 自持产物/审批/状态机与渲染层，不建第二套审批流；不手抄提示词；权限模式语义照抄 PI。

1. **模式提示词（R2 返修：只追加 mode block，绝不带 base）**：桥接每 prompt 前把 **`composeModeSystemPrompt(mode, "")`** 的输出（`app/packages/agent-runtime/src/mode-prompts.ts`，与固定 PI 字节平价；`""` 经 `.filter(Boolean)` 被丢弃，返回值就是纯 mode block）写入运行域状态（扩展现有 `desktop-state.json` 快照，v2），gate `before_agent_start` 以 `{systemPrompt: [...event.systemPrompt, block]}` 追加。**禁止**：注入 `DEFAULT_RUNTIME_SYSTEM_PROMPT`、任何形式的 base prompt 复制或替换 OMP 原生 prompt（`event.systemPrompt` 是权威 base，只能追加）。**模式不是 best-effort**：状态写入失败 → 该 prompt 拒绝（沿 `OMP_CAPABILITY_STATE_FAILED` 语义），绝不把契约模式意图当 agent 跑。子代理零注入保持。§4.2 R4-4 实测的是**本契约的 transport 与块字节**：追加的块等于生产 `composeModeSystemPrompt(mode, "")` 输出、三模式各恰一次、单 `role:"system"` 消息、PI 默认 base 不出现、块为纯追加（`system = prefix + block`，工具目录相同的 prompt 前缀字节相同）；**技能/记忆块的内容与相互顺序**仍由 T19-C 通道与 B2 的未来必测项覆盖，§4.2 不代替。
2. **工具目录（R4 返修：顺序是契约的一部分）**：每个 prompt **先**完成 `set_host_tools` 目录替换，**再**由 `before_agent_start` 内的 `pi.setActiveTools`（`runtime-init.ts:105-107`，rpc 可用）夹取——`#applyRpcHostToolRefresh` 会把新注册的非 hidden host tool 自动激活（`session/session-tools.ts:2003-2005`），顺序颠倒会撤销夹取（R4-2 实测重新暴露）。首次夹取允许 1 次 prompt-policy retry（`AGENT_START_POLICY_MAX_ATTEMPTS=3`），第二次起必须稳定（R4-3/R4-4 实测 1–2 次）；目录内容：原生只读核 + 提交工具 + 声明了非空 `planSafeActions` 的插件 host 工具；Agent 模式目录不变（T17-T19 回归）。
3. **提交工具（R3 返修：硬阻塞，不得开工）**：PI 要求过渡工具独占 assistant 批次且提交终支终止回合；§4.2 已用固定 OMP 实测证明**当前通道做不到**：host tool `concurrency` 硬编码 shared、无 terminate 字段、扩展 `tool_call` 无批次视图、唯一优雅终止只认 `"yield"`。因此 T20-B **不得**按"结果文本 + 提示词 + 一次提交规则"实现并声称兼容。开工前置条件（任一）：(a) 上游 OMP 给 host tool 目录/结果加 `concurrency`/`terminate` 能力（或等价的批次可见钩子）；(b) 用户明确接受"整回合 abort"作为过渡工具的强制手段并接受其与 PI 的语义差异（模型看不到 block 结果、无法同回合重试单调用提交）；(c) 桌面把提交移出模型循环（例如由审批卡驱动的显式用户动作），并重新定义与 PI 的差异。三条都需用户决定或上游变更，本轮无此决定。
4. **审批**：渲染层继续用 `PlanApprovalBar` → `plansResolve` IPC（去掉 OMP 拒绝分支）→ host-core `plans.resolve`（批准原子写 mode=agent + permission_mode + queued 执行；reject/过期/打断语义全部复用）。
5. **派发（OMP 路径）**：把 `plans.ts` 的 OMP 拒绝替换为：claim CAS（复用）成功后，经 OMP 桥接启动一个 agent 模式回合——该 prompt 前写状态（agent 提示词 + 网关权限模式 = 选定 permissionMode），`finishApprovedExecution` 复用；drain/boot_maintenance/配置冻结不变（host-core 自持，恰一次与不重放天然成立）。
6. **执行时强制（gate，实现 §1.3.1 的固定 PI 决策表）**：按 §1.3.1 的**顺序**实现，不得简化：(a) 契约模式硬拒绝**先于一切**——Write/Edit/apply_patch/未知原生工具、`mcp_*`、无非空 `planSafeActions` 的插件工具一律 block（PI `permissions.rs:219-234`）；契约许可的 `Read`/`Glob`/`Grep`/`Bash`/`BrowserPreview`/`new_context` 继续走后续判定——其中 `BrowserPreview` 风险为 **Medium**（不在风险表内），`new_context` 是 sidecar-side、根本不到 host gate；(b) 显式外部路径：`auto` 放行、其余弹卡；(c) `risk=Low` 放行（**Agent/非契约判定**下含 `mcp_*`；Plan/Goal 下 `mcp_*` 已在 (a) 被硬拒绝）；(d) 有效模式 `auto` 放行、`accept-edits` 仅 Write/Edit、`ask` 无自动决策；(e) session grant；(f) 其余弹卡，无 UI 时 fail closed（PI 超时 120 s → Deny）。**Bash 不做命令分类/只读解析**（`inherit` → 解析全局默认；`ask`/`accept-edits` 弹卡；`auto` 放行；契约硬拒绝高于任何权限模式）。**明确不等于现状**：`OMP_DESKTOP_GATE_MODE=ask|deny|allow`（启动期 env）与 OMP `tools.approvalMode=always-ask|write|yolo`（启动期设置）都不是 PI 权限模式；T20-B 必须把 per-session/per-turn 的有效权限模式经运行域状态传入 gate，并让 browser/computer/eval 在 Agent+auto 下按 PI 放行（Plan/Goal 下由契约硬拒绝处理），不得沿用"任何模式都审批"的表述。
7. **插件模式传播与风险保真**：adapter 执行上下文 `mode` 改为执行时读取会话持久模式（替换 G2 硬编码），`planSafeActions` 逐 action 把关照抄 `plugin-runtime.ts:2504-2532`；子代理 `hasUI=false` 保持 fail-closed。风险**不得**继续由名字猜（G9）：见 §6.10。
8. **能力声明**：`EngineCapability` 增 plan/goal（T20-B 决定键名与门控面），渲染层模式片/审批卡按能力显示；Pi 会话零变化。
9. **扩展点清单**（确切符号）：`omp-session.ts` `configure()`/`persistConfig`（读模式进状态写入）、`OmpHostToolProvider.catalog`（提交工具注册）、`omp-host-tools.ts` executor（`mode` 来源 + `planSafeActions` 把关）、`omp-desktop-gate.ts` `decideToolCall`（模式感知决策表）、`desktop-state.ts` 快照（模式块字段）、`runtime/plans.ts` `dispatchApprovedPlan`（OMP 派发分支）、`ipc/agent-ipc.ts` `plansResolve`（去 Pi-only 门）、`packages/shared/src/engine.ts` 能力表、`PlanApprovalBar.tsx`（零改动，纯复用）。
10. **运行域状态必须携带 host tool 策略（R1 评估结论：必须）**：gate 只见 `toolName`+`input`，看不到插件 manifest，协议面也没有声明风险通道；而 PI 的 `plugin_*` 风险来自 manifest 声明、`mcp_*` 恒为 `Low`（§1.3.1），因此**靠名字猜风险无法达到 PI 语义**（G9，实测 `riskForTool` 现状 plugin_→high、mcp_→medium）。`desktop-state.json` v2 除 mode block 外必须携带：(a) 已解析的**有效权限模式**（`inherit` 在桌面侧解析完成，gate 不解析）；(b) **每 host tool 的策略表** `name → { risk: low|medium|high, planSafeActions?: string[] }`（risk 取 manifest 声明，缺失/非法 → medium；`mcp_*` → low；原生工具名字不进该表，仍由 gate 的原生分支判定，但两者取值由同一生成器产出以免漂移）；(c) 契约模式下是否注册提交工具及目录（可由 (b) 推导，显式列出便于测试）。gate 每 prompt 经与技能/记忆同一原子替换通道读取该状态，`tool_call` 决策完全由表驱动。B13/C7 钉这条。

---

## 7. 验收矩阵（T20-B/C/D 归属）

图例：层 = 测试所在层（host-core Rust / desktop main 单元 / gate 单元 / 桥接夹具 / 真实固定 OMP E2E / 渲染层）。先例 = 既有 PI 源/测试或本仓库既有语义。

> **R3 硬阻塞（§8）**：T20-B **不得开始**。下表 B4-B8 与 D1/D3 中任何依赖"模型经 host tool 提交过渡工具"的行，其 PI 语义（独占批次 + 提交后终止）在固定 OMP 上不可实现（§4.2）；这些行在硬阻塞解除前只能以"用户决定接受的差异"重新定义，不得作为 PI parity 验收。

### T20-B（模式状态机、提示词、目录、提交/审批/派发闭环）

| 行 | 场景 | 层 | 期望 | 先例 |
| --- | --- | --- | --- | --- |
| B1 | OMP 会话 Agent/Plan/Goal 模式片切换持久化（现有 T15 语义回归） | desktop main 单元 + host-core | configure 原子持久 mode+permissionMode；无 pending/queued/running 才允许（`PLAN_CONFIGURATION_BLOCKED`） | `sessions.rs:1651`、`approval.rs:54-119` |
| B2 | 模式提示词注入（R2 返修后的确切契约）：**只**用 `composeModeSystemPrompt(mode, "")` 的 mode block，经状态文件→`before_agent_start` **追加**到 `event.systemPrompt` | gate 单元 + 真实 OMP E2E（fake provider 断言 system 消息） | 四条同时成立：① plan/goal/agent 三块与固定 PI 逐字节一致；② OMP 原生 prompt 恰保留一次（单 `role:"system"` 消息）；③ PI `DEFAULT_RUNTIME_SYSTEM_PROMPT` 不出现；④ 技能/记忆块内容与相互顺序稳定；状态文件失败 → prompt 拒绝（不按 agent 跑契约意图）。§4.2 R4-4 已实测 ①（块=生产 composer 输出，且 `mode-prompts.ts` 与固定 PI 逐字节相等）、②、③ 与"块为纯追加（system = prefix + block）"；**④ 仍须 T20-B 自测**（spike 不覆盖技能/记忆块内容） | `mode-prompts.ts:58-64`（`""` 被 `.filter(Boolean)` 丢弃）；§4.2 R2-字节/R2-范围声明 |
| B3 | 契约模式工具目录：只读核 + 提交工具 + 非空 planSafeActions 插件 host tool；Write/Edit/apply_patch/未知不可见 | 桥接夹具（`set_host_tools` 帧）+ gate `setActiveTools` 单元 | 目录与 PI `plan_mode_allows` + 目录过滤一致；Agent 模式目录不变 | PI `runtime.ts:3314,3453-3467`、`permissions.rs:148-153`；OMP `runtime-init.ts:105-107` |
| B4 | SubmitPlan/SubmitGoal 可见性与错误模式拒绝 ⚠ 受 G8 阻塞 | host-core + 桥接夹具 | 仅当前 kind 的提交工具注册；`SubmitPlan` 于 Goal / 无契约时 → `PLAN_NOT_ACTIVE`/`PLAN_KIND_MISMATCH`；每会话恰一 pending（`PLAN_ALREADY_PENDING`） | `approval.rs:216-236`、`plans/tests.rs:785` |
| B5 | 提交产物：`.pi/<kind>/<slug>.md` 不可变、sha256/大小记录、防覆盖、symlink 拒；`awaiting_approval` 状态可见 ⚠ 受 G8 阻塞（触发路径） | host-core + 渲染层 | 与 PI 相同路径/内容契约；pending 行驱动审批卡 | `artifact.rs:99-152`、`plans/tests.rs:122,156,183,685` |
| B6 | 审批：reject/过期/打断回 planning（新回合新产物，旧产物不可变）；approve 原子写 mode=agent+permission_mode+queued 执行；重复决议幂等、冲突/过期拒绝 | host-core + 渲染层 IPC | 与 PI 状态机一致；无第二套审批 | `approval.rs:351-471`、`plans/tests.rs:254,349,384,444` |
| B7 | 恰一次执行：claim CAS queued→running 先于任何 OMP prompt；finish CAS；drain 只派 queued；boot 重启打断 pending 与 queued/running、不重放；执行期间配置冻结 | host-core + desktop main 单元 + 桥接夹具 | OMP 派发路径复用全部既有 CAS；无重复执行、无重放 | `execution.rs:65-83,110-152`、`migrations.rs` boot_maintenance、`plan-drain-engine-gate.test.mjs`（fork 语义：OMP 会话也要 claim） |
| B8 | 批准后执行：选定 permissionMode 到达该回合 gate（agent 提示词 + 权限策略），执行失败 → interrupted 且可观察 | 桥接夹具 + 真实 OMP E2E（fake provider） | 回合以选定权限模式运行；失败清理不留 running 行 | 上游 `plans.ts:413-470`（Pi 侧）；§6.5 映射 |
| B9 | 能力声明：`OMP_ENGINE_CAPABILITIES` 增 plan/goal；渲染层按能力显隐；Pi 会话行为零变化 | shared 单元 + 渲染层 | 能力表准确；Pi 全绿回归 | `engine.ts` 既有表 |
| B10 | Agent 模式回归 + T17-T19 回归（子代理/工具结果/MCP/技能/记忆不受影响） | 既有套件 | 全绿；无模式相关行为变化 | T17-T19 验收记录 |
| **B11** | **R4 顺序契约**：每 prompt 先完成 `set_host_tools` 目录替换，再由 `before_agent_start` 内 `setActiveTools` 夹取；**反向顺序必须有对照断言** | 桥接夹具 + 真实固定 OMP E2E | provider 实际工具表与 clamp **严格序列相等**（含 host tool 被隐藏）；反向顺序时新注册 host tool 重新出现（证明顺序不是可选） | §4.2 R4-1/R4-2；`session-tools.ts:1999-2010`（`autoActivatedRpcToolNames`） |
| **B12** | **R4 收敛契约**：首次夹取允许 1 次 prompt-policy retry，第二次起稳定；不得出现 `AgentStartPolicyChangedError` | 桥接夹具（`before_agent_start` attempts 计数）+ 真实固定 OMP E2E | 首次变更 attempts ≤2 且 prompt 被投递；同 clamp 的下一 prompt attempts ==1 | §4.2 R4-4（实测 2/1/2）；`agent-session.ts:407,6691-6760` |
| **B13** | **R4 生命周期**：同一 session 上按目录计划真实增/删/重加提交工具、**目标模式目录序列**（spike 中的 catalog 生命周期，非真实持久模式切换）、续写与模型重试后目录仍收敛；host tool 策略表（risk/planSafeActions）随目录一起替换；**真实持久 `sessions.mode` 切换**（Agent/Plan/Goal 配置后按新目录重建）另由 B1 + 本行共同验收 | 真实固定 OMP E2E | 每 prompt 工具表与 catalog+clamp**严格序列相等**、无滞留、无重复、无未注册名字冒充；策略表与目录同源 | §4.2 R4-3（实测 5 prompt 序列，仅证明目录/夹取生命周期）；§6.10 |
| **B14** | **R2 反例守卫**：任何把 base prompt（PI 默认或 OMP 原生）写进状态或作为 second block 的实现在 B2 的四条断言下必须判红 | gate 单元 | 反例实现被 B2 断言捕获（不是仅正向断言） | §1.1、§6.1；R2 复审要求 |

### T20-C（执行时强制与模式传播）

| 行 | 场景 | 层 | 期望 | 先例 |
| --- | --- | --- | --- | --- |
| **C1** | 契约模式执行时硬拒绝：Write/Edit/apply_patch/未知工具/`mcp_*`/无非空 `planSafeActions` 的插件工具 block，**任何**权限模式下（含 auto/allow）；契约许可的只有 `Read`/`Glob`/`Grep`/`Bash`/`BrowserPreview`/`new_context` | gate 单元 + 真实 OMP E2E | 执行前 block、无副作用；`auto` 也不能复活 | `permissions.rs:219-234,538,559`；`rpc/mod.rs:3488-3497` 拒绝码 |
| C2 | Bash 按有效权限模式（**不做命令分类**）：inherit→解析默认；ask→审批；accept-edits→Bash 仍审批；auto→放行；契约硬拒绝之上 | gate 单元 + 真实 OMP E2E | 与 PI `plan_bash_follows_permission_mode` 语义一致；Auto 警示文案保留 | `permissions.rs:250-269,547-556`；`plan-mode-source-contract.test.mjs` |
| C3 | 插件 `planSafeActions`：无非空声明的插件工具契约模式拒绝；有声明逐 action 允许/拒绝；ctx.mode = 真实模式（替换硬编码 agent） | desktop main 单元 + 桥接夹具 | 与 PI `plugin-runtime.ts:2504-2532` 同语义；补充 PI 缺失的专测 | ADR 0211；`plugin-runtime.ts:776-817` |
| C4 | 子代理 `hasUI=false`：契约模式策略 fail-closed（无交互审批，按策略拒绝）；Agent 模式与既有 T17 语义不变 | gate 单元 + 真实 OMP E2E | 子代理不因模式改变而获得更高权限；无 UI 无审批通道 | gate no-UI 分支；M1/T17 结论 |
| **C5** | **高权限工具（browser/computer/eval）按 §1.3.1 决策表**：Agent+`auto` **放行**（PI `auto` 放行 High/Medium）；`ask`/`accept-edits` 弹卡；Plan/Goal 下不在 `plan_mode_allows` → **契约硬拒绝**（先于权限模式） | gate 单元 + 真实 OMP E2E | 与 §1.3.1 逐格一致；**不得**要求"任何模式都审批"（那是 PI 冲突表述，R1 已推翻） | §1.3.1；PI `permissions.rs:250-269`、`:219-234` |
| **C6** | **普通 Agent 会话的四条有效权限模式**：`inherit` 解析全局默认；`ask` 弹卡；`accept-edits` 仅 Write/Edit 自动；`auto` 放行 High/Medium；解析在桌面侧完成，gate 只读结果 | gate 单元 + 桥接夹具 | 与 §1.3.1 矩阵一致；`inherit` 不经 gate 解析 | §1.3.1；spec `03-tools-and-permissions.md:421-425`；R1 复审要求 |
| **C7** | **风险保真（含 F1 的契约许可工具）**：`plugin_*` 取 manifest 声明（low/medium/high，缺失/非法→medium）；未知 → medium；`mcp_*` = low **仅在 Agent/非契约的常规风险判定下自动放行**（Plan/Goal 下 `mcp_*` 先被 C1 契约硬拒绝，Low 不适用）；**`BrowserPreview` 在契约模式内被 `plan_mode_allows` 许可，但它不在风险表 → Medium**：`ask`/`accept-edits` 弹卡、`auto` 放行、grant 可 `AllowSession`（不得写成 Low/契约许可放行）；`new_context` 是 sidecar-side、不到 host gate（无风险等级）；host tool 风险来自状态里的策略表而非名字前缀 | gate 单元 + 桥接夹具（目录带 risk） | 决策与宿主声明的 risk 一致；名字前缀不再决定 host tool 风险；契约模式下 Low 不能让 `mcp_*`/Write/Edit 复活；`BrowserPreview` 与 `Read`/`Glob`/`Grep` 行为不同 | §1.3.1；PI `permissions.rs:128-141,148-153,219-234,250-269`；R1/F1 复审要求 |
| **C8** | **外部路径例外**：`auto` 放行；`ask`/`accept-edits` 弹卡（除非该工具已有 session grant）；无 UI 时**只在本来需要交互时** fail closed | gate 单元 | 与 §1.3.1 第 2/6 步一致；无 UI 不等于所有调用都拒绝 | PI `permissions.rs:238-248`；`PERMISSION_TIMEOUT_MS = 120_000` |

### T20-D（Goal 差异与整体验收）

| 行 | 场景 | 层 | 期望 | 先例 |
| --- | --- | --- | --- | --- |
| D1 | SubmitGoal：`.pi/goal/*.md` 产物、goal 提示词（验收标准措辞）、批准后 agent 模式自主执行并自停 | host-core + 真实 OMP E2E | 与 PI goal 契约一致；**无延续定时器**（OMP interactive 专属，桌面 goal = 单回合契约 + 批准后普通 agent 回合，如实记录差异） | `mode-prompts.ts:18-32`；`plans/tests.rs:715` |
| D2 | goal_updated 透传事件的展示（可选，只读） | 桥接/渲染层 | 可呈现、不可驱动；不伪造 goal 状态 | `rpc-client.ts:158` |
| D3 | 端到端用户路径：切 Plan → 对话 → 审批卡 → approve(ask/accept-edits/auto) → agent 执行；reject → 修改重提；重启 → 无重放 | 真实固定 OMP E2E + 渲染层 | 完整闭环；T20 整体验收时执行 | `upstream/pi-desktop/docs/spec/03-runtime/10-session-state-machine.md` 状态机 |

---

## 8. 阻塞与未知

- **硬阻塞（R3）**：固定 OMP 18.2.7 上**无法**实现 PI 的过渡工具契约——(a) 过渡工具独占 assistant 批次、同批其它调用零副作用；(b) 提交成功或失败后不再继续模型循环；(c) 不依赖结果文本或模型服从。§4.2 六场景实测：同批兄弟真实落盘、同批两次提交执行两次、gate 逐调用 block 保护不了兄弟、提交结果后再走 2 个 provider step 并继续执行工具。根因是上游能力缺口（`RpcHostToolAdapter.concurrency` 硬编码 `"shared"`、`RpcHostToolDefinition` 无 `concurrency`/`terminate`、扩展 `tool_call` 载荷无批次视图、`AgentToolResult` 无 `terminate`、唯一优雅终止只认字面工具名 `"yield"`）。**T20-B 不得开始**（§6.3 列出解除条件：上游能力、或用户明确接受的语义差异、或把提交移出模型循环）。解除前不得声称 Plan/Goal 与 PI 兼容。
- **已解决（R4，本轮扩大实测范围）**：顺序、收敛与**目录生命周期**都不再是"未知"——唯一稳定顺序是每 prompt 先 `set_host_tools`、后 `before_agent_start` 内夹取；首次夹取恰 1 次 policy retry、之后稳定；同一 session 上 5 个连续 prompt 真实增/删/重加 `SubmitPlan`/`SubmitGoal` 并与 catalog+clamp **严格序列相等**、无滞留/重复（§4.2 R4-1…R4-4）。撤销夹取的路径（先夹取后注册）与"严格相等而非子集"的断言方式都有对照证据。
- **已解决（R2，范围明确）**：模式提示词拼接不再是"含糊契约"——只用 `composeModeSystemPrompt(mode, "")` 的 mode block 追加；spike 用**三个真实块**实测：各自恰一次、其它块 0 次、单 system 消息、PI 默认 base 不出现、`system = prefix + block`（UTF-8；工具目录相同的 prompt 前缀字节相同），并断言 `app` 与固定 PI 的 `mode-prompts.ts` 逐字节相等（§4.2 R2-字节）。**技能/记忆块的内容与相互顺序不在本证据范围内**，仍由 T19-C 通道与 B2 ④ 在 T20-B 覆盖。
- **已知限制（设计前提，非假设）**：OMP 原生 Plan/Goal 状态机（interactive/ACP）不可复用；审批不持久不重放（桌面经 host-core `plan_approvals` 自持，语义由 §6.4 覆盖）；无 per-turn 权限模式 RPC——per-turn 权限策略与 per-tool 风险只能经运行域状态 → gate 通道（§6.6/§6.10）；`ctx.abort()` 是用户打断语义（整回合 aborted），只能作为"零副作用"的兜底而不能替代 PI 的 block-and-continue。
- **未知（留给解除阻塞后的轮次实测）**：goal 契约在 OMP 的"自停"表现（无延续定时器，依赖提示词与工具结果，D1 实测）；`pi.setActiveTools` 对 `xd://` 挂载类工具的夹取边界（本轮只测了顶层工具表）。
- **如实声明**：当前 `OMP_DESKTOP_GATE_MODE`（ask|deny|allow，启动期）与 OMP `--approval-mode`（always-ask|write|yolo，启动期）**都不是** PI 权限模式（inherit/ask/accept-edits/auto）；在 §6.6 映射落地前，不得宣称既有 env 门已提供权限模式。`mcp_*=medium`/"与 PI 一致"的旧表述已按 §1.3.1 更正（PI 为 `Low`）。

---

## 9. 验证命令与结果（F8-F12 返修轮，Node v24.14.0 / Bun 1.4.2）

环境：`source /home/vv/.nvm/nvm.sh && nvm use system`（本机 system → v24.14.0；`nvm use 24` 别名在本机为 N/A）+ `export PATH="/home/vv/.bun/bin:/home/vv/.nvm/versions/node/v24.14.0/bin:$PATH"`；固定 launcher 报 `omp/18.2.7`。未调用任何付费/远程模型。

| 命令（工作目录） | 结果 |
| --- | --- |
| `node scripts/check-omp-plan-goal-gaps.mjs`（`app/`） | SKIP 行，**退出 0**（opt-in 未启用） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs`（`app/`） | 3×`GAP-OPEN`（g1 为保守判据证据串）+ g4 判定，**退出 1** |
| g1 假绿对照 ①（注释关键词；注入后 `git checkout` 复原） | 仅在 `omp-session.ts` + gate 加注释 → `REVIEW-REQUIRED g1`（`engine seam references the mode composer: omp-session.ts`），**退出 1**（不判 closed） |
| g1 假绿对照 ②（仅加 state 字段） | `modePrompt` 字段注入 → `REVIEW-REQUIRED g1`（`runtime-domain state has mode-ish field(s): modePrompt`），**退出 1**；复原后回到 `GAP-OPEN` |
| `node scripts/check-t20-matrix-ids.mjs`（`app/`） | `MATRIX-ID-OK: B1-B14, C1-C8, D1-D3 each appear exactly once`，**退出 0** |
| `node t20-feasibility.mjs`（`app/experiments/omp-bridge/`） | **38/46 checks**，失败恰为 **8 项 R3 契约**；R4-4 attempts=**2/1/2**，blockBytes=**176/1726/2156**，systemBytes=**14608/16158/16592**，prefixBytes=**14432/14432/14436**（均 `Buffer.byteLength(..., "utf8")`）；结果 JSON 落 `results/t20-feasibility.json`（§4.2） |
| `node --check`（3 个脚本：`check-omp-plan-goal-gaps.mjs`、`check-t20-matrix-ids.mjs`、`t20-feasibility.mjs`） | 全部通过 |
| `node --test apps/desktop/test/plan-drain-engine-gate.test.mjs apps/desktop/test/omp-session-configure.test.mjs apps/desktop/test/engine-router.test.mjs apps/desktop/test/plan-artifact-contract.test.mjs apps/desktop/test/plan-mode-source-contract.test.mjs`（`app/`） | **37 通过 / 0 失败 / 0 跳过** |
| `pnpm lint:biome`（`app/`） | 0 问题（`scripts/`、`experiments/` 不在 `biome.json` 的 `files.includes` 面内，故以 `node --check` 兜底） |
| `git diff --check`（根） | 0 |
| `bun test packages/coding-agent/test/rpc-host-tools.test.ts`（`upstream/oh-my-pi/`） | **5 pass / 0 fail** |
| `bun test packages/agent/test/agent-loop.test.ts -t concurren`（`upstream/oh-my-pi/`） | **3 pass / 0 fail** |
| `bun test packages/agent/test/agent-loop.test.ts -t terminal`（`upstream/oh-my-pi/`） | **3 pass / 0 fail** |
| `git submodule status`（根） | OMP `d49918fab`、PI `0111e306` 未动；两个子模块工作树 `git status --short` 均为空 |
| spike 资源回收 | 每次 `runScenario` 校验「process group reaped」；scratch 目录全部删除，无残留进程/临时目录 |

## 10. T20 完成状态

**T20-A 的审计、契约与验收矩阵已完成三轮返修（R1-R4、F1-F7、F8-F12），并由 F13/F14 纯文档轮统一了 g1 最终口径与提交坐标（不改变任何结论），但 T20-A 不能标为"已完成、无硬阻塞"：R3 是硬阻塞（§8），T20-B 不得开始。** T20-B/C/D 未开始；Plan/Goal 与高权限工具门未实现、未声称完成。F1-F7（风险表/验收、g1 判据、严格序列、目录生命周期、mode block 字节与范围、矩阵唯一性、行号）与 **F8-F12**（g1 改为永不自动 closed 的保守判据 + 注释假绿对照、R4-4 真实变化、UTF-8 字节与前缀不变量、R4-3 证据范围收窄为目录序列、外部路径行限定 allowlist）已按固定源码与无费用实验修正；R3 需要上游能力、或用户明确接受的语义差异、或把提交移出模型循环三者之一，才能解除。`branch`/`steer`/`followUp`/`compact`/子代理单独停止保持关闭（T17-T19 延续）。
