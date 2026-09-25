# M5/T20-R3C：Plan/Goal × Cursor 产品门 —— 证据、可达状态矩阵与实现

更新时间：2026-09-25。状态：**已实现并验证（本阶段仅交付"用户确认的产品门"）**。

- 分支：`codex/m5-cursor-plan-goal-gate`；基线（本阶段起点）：`eaf014fec34ce7780ab67ff110d17df61a479974`，本阶段为其上的**追加提交**。推送目标 `origin/codex/m5-cursor-plan-goal-gate`。
- 固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（omp/18.2.7）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`；**gitlink 与追踪内容未改动**。
- **严格 R3 仍不受支持**（R3A 补丁=风险收敛、R3B 实测 0/12），**T20-B/C/D 未开始、T20 未完成**；本阶段不声称严格 Cursor 兼容，也不重写 R3 的结论。
- 用户已明确选择产品选项 1：**Plan/Goal 模式不支持 Cursor 模型**。本阶段把该决策落成一条有文档、有边界强制、有测试的不变量。

## 0. 结论摘要

1. **PI Desktop 无先例**：模式门全部是"状态/上下文"（`PLAN_ALREADY_ACTIVE`、`PLAN_CONFIGURATION_BLOCKED`、`PLAN_REQUIRES_INTERACTIVE_SESSION`、`PLAN_KIND_MISMATCH`），模型门只有"配置/认证"（`MODEL_NOT_CONFIGURED`）；**不存在按模型/提供方拒绝模式的代码或测试**（§2.4）。
2. **固定 OMP 也没有先例**：Cursor 的规范身份是 provider id `"cursor"`（api 侧为 `"cursor-agent"`），上游**没有** `isCursor(model)` 解析器；OMP 自身有 plan/goal 概念但**没有 rpc 面**；**不存在"模式↔模型"互斥代码**（§3）。
3. **本产品当前无法表达 Cursor 传输**：`API_STYLES` 没有 cursor 传输、OMP 投影只映射 5 种 HTTP api 且拒绝 OAuth、Pi 侧 `pi-ai@0.86.1` 完全没有 cursor 传输（§4.1）。因此"Cursor 组合"在今天只可能是**持久化/导入的 provider 身份字符串**为 `cursor` 的会话，或手改数据库；门在今天就已生效，并在 Cursor 将来可投影时自动继续生效。
4. **实现**：一条共享谓词 `planGoalCursorRefusal(mode, providerId)` + 一个拒绝码 `PLAN_GOAL_CURSOR_UNSUPPORTED`，在**三个桌面边界**（新建、配置、派发）强制；渲染层做预防与本地化解释；**不自动改写**用户的模式或模型（§5）。
5. **测试**：共享谓词边界表 6 项、IPC 行为测试 10 项（含两条出路与非 Cursor 回归）、渲染层契约 4 项；**去掉门后 6/10 行为测试判红**（§6.2）。desktop 全量 **2901 项 / 2897 通过 / 0 失败 / 4 跳过**。
6. **如实记录一条被调整的路径**：Pi 会话若持久化 `provider_id = "cursor"`，其启动解析会**回退到其它提供方**，模型仍可经 `plans.enter` 写入 `mode='plan'`（该调用由 sidecar 直连 host-core，不经过桌面 IPC）。该组合由**派发前门**确定性拒绝（任何后续回合都不会在组合中运行），而不是在写入处拦截；若产品要求持久记录本身永不落入该组合，需要改 host-core 的 `PlanManager::enter`（§4.3/§7）。

## 1. 用户决策与本阶段的不变量

**不变量（唯一权威表述）**：**一个会话不得把"活跃的 Cursor 模型/提供方"与 Plan 或 Goal 模式组合在一起。**

它与固定 OMP 能力的关系（不重写 R3）：PI 的过渡工具契约要求"提交工具独占整个 assistant 批次、同批兄弟零副作用、提交后终止"；Cursor 的 exec channel 在响应流式期间**已执行**工具调用（早于承载它的 assistant 消息）且副作用不可撤销，因此该契约在固定 OMP 上**不可实现**（`docs/validation/M5-omp-transition-patch.md` §2/§9/§10；R3A 补丁只收敛 loop 可控路径，R3B 实测严格契约检查 **0/12 成立**）。用户据此选择"产品层不支持该组合"，而不是伪造兼容或缩小验收口径。

## 2. PI Desktop 证据（先）

固定检出：`upstream/pi-desktop@0111e306`。

### 2.1 模式的权威状态与全部写入者

| 事实 | 坐标 |
| --- | --- |
| 权威状态是 `sessions` 行上的一列：`mode TEXT NOT NULL DEFAULT 'agent'` | `crates/host-core/src/db/schema.rs:56-62`；`MODES = ["plan","goal","agent"]`、`normalize_mode`（`chat`→`plan`）、`is_contract_mode` | `crates/host-core/src/sessions.rs:14,21-27,36-38` |
| 会话投影字段 | `SessionSummary.mode/provider_id/model_id`：`crates/host-core/src/sessions.rs:105-107` |
| 唯一 RPC 读 | `session.get`：`crates/host-core/src/rpc/mod.rs:2130-2180` |
| TS 侧模式联合与归一 | `packages/shared/src/types/common.ts:2-10` |
| 契约种类（plan/goal）| `packages/shared/src/types/plans.ts:9,19-21`（`PROPOSAL_KINDS`、`proposalKindForMode`） |
| 模式↔产物的映射 | `crates/host-core/src/plans/model.rs:32-34`（`kind_for_mode`） |

写入者只有四处（外加迁移/fork/新建）：`PlanManager::enter`（Agent→plan/goal，CAS 要求 `mode='agent'`，`crates/host-core/src/plans/approval.rs:129-165`）、`PlanManager::resolve`（approve 时写回 `mode='agent'`，`:351-441`）、`sessions::configure_session_with_thinking`（直接配置，写点 `crates/host-core/src/sessions.rs:1632-1690` 的 `:1663-1667`）、v7→v8 迁移 `chat`→`plan`（`crates/host-core/src/db/migrations.rs:351`）。模式**只影响工具与提示词**，不影响模型：`crates/host-core/src/permissions.rs:148-153,219-243`、`packages/agent-runtime/src/runtime.ts:3453-3466`（`isToolAllowedInMode`）、`packages/agent-runtime/src/mode-prompts.ts`。

### 2.2 模型/提供方的写入与唯一校验

- 持久字段 `sessions.provider_id` / `sessions.model_id`（`crates/host-core/src/db/schema.rs:60-61`），与 mode 由**同一条 UPDATE** 写入（`crates/host-core/src/sessions.rs:1663-1667`）。
- 写入前的唯一门是**状态门** `gate_session_configure`：存在待审批 / 排队或运行中的计划执行 / 运行中的回合时拒绝 `PLAN_CONFIGURATION_BLOCKED`（`crates/host-core/src/plans/approval.rs:54-126`）。**没有任何模型/提供方交叉校验**（`provider_id`/`model_id` 是不校验的自由字符串）。
- 唯一"模型级"拒绝发生在**启动期**且理由是配置：`MODEL_NOT_CONFIGURED`（`packages/agent-runtime/src/sidecar.ts:311-319`）。

### 2.3 拒绝形状与本地化（本实现复用）

- `rpc_err(code, message, errorCode)` → `{ code, message, data: { errorCode } }`（`crates/host-core/src/rpc/mod.rs:466-472`）；plan 家族 `plan_rpc_err`（`:873-882`）。
- 渲染层按 `t(\`errors.${errorCode}\`)` 渲染，缺 key 时回退原始 message：`apps/desktop/src/components/ChatSurface.tsx:17-20,191-195`；EN/zh-CN 等 8 个 catalog 的 `errors` 块必须键集一致（`packages/i18n/src/locales/*/index.ts`，由 `packages/i18n/test/catalogs.test.mjs` 强制）。
- 既有先例：`ENGINE_CAPABILITY_UNAVAILABLE`（`packages/shared/src/errors.ts:247`）今天**没有** locale key，因此只显示原始英文消息——本阶段给新码**同时**加了错误码与本地化文案（§5）。

### 2.4 无先例（明确结论）

在固定检出中检索后**未发现**任何"因模型/提供方而拒绝或隐藏模式"或反向的代码路径与测试。检索面（全部空）：`crates/host-core/src` 上的 `MODE_NOT_SUPPORTED|INCOMPATIBLE|unsupported_mode|support.*mode`；`packages/**`、`apps/**` 上的 `mode.*incompatib|MODE_UNSUPPORTED|supportsPlan|supportsGoal|requiresModel`；`packages/agent-runtime/src`+`apps/desktop/src` 上的 `mode.*(unavailable|disabled|blocked)|only available in|not available in`（仅命中**工具级**文案与无关的模型不可用标签）；`apps/desktop/test`+`crates/host-core/src` 上的 `mode.*"model"|"model".*mode`。唯一"模式→权限"耦合是 Goal 固定权限片（`apps/desktop/src/features/chat/composer/ComposerToolbar.tsx:186`，测试 `apps/desktop/test/composer-permission-mode.test.mjs:30`），与模型无关。

### 2.5 最接近的既有测试（供本阶段对齐，非等价）

模式：`crates/host-core/src/plans/tests.rs:60,97,553,631,839`、`crates/host-core/src/rpc/mod.rs`（tests）`:7501,7774,8130,8265`、`packages/agent-runtime/src/runtime.test.ts:2043,2100,2138,2221,2287`、`apps/desktop/test/plan-mode-source-contract.test.mjs`。模型：`apps/desktop/test/session-model.test.mjs:23-79`、`crates/host-core/src/sessions.rs:3858-3891`。**"模式×模型互斥"没有直接测试，也不存在可复用的被测代码路径**（§2.4）。

## 3. 固定 OMP 证据（后）

固定检出：`upstream/oh-my-pi@d49918fab`。

### 3.1 Cursor 的规范身份（检测依据）

- **provider id = `"cursor"`**：`packages/catalog/src/compat/provider-ids.ts:21`（`KnownProvider` 联合）、`packages/catalog/src/rules/providers/cursor.kdl:3`；认证侧 `packages/catalog/src/compat/auth-ids.ts:21,107`；账号策略 `packages/ai/src/auth-storage.ts:1078-1081`。
- **api id = `"cursor-agent"`**：`packages/catalog/src/types.ts:21`、`packages/ai/src/api-registry.ts:31`、`packages/ai/src/stream.ts:1062-1063`、`packages/ai/src/providers/register-builtins.ts:282-284`、`packages/ai/src/providers/cursor.ts:1088`。
- **没有规范解析器**：上游只有窄用途谓词（`packages/ai/src/utils/block-symbols.ts:63`、`packages/ai/src/error/flags.ts:751`、`packages/catalog/src/compat/collapse.ts:744` 等），消费者一律**内联比较字面量**（`packages/agent/src/agent.ts:796`、`packages/ai/src/providers/cursor.ts:4768`）。没有 `isCursor(model)`。
- **无别名改写**：`providerAliases` 只填了 `devin`（`packages/catalog/src/rules.json:2127-2129`）；auth-gateway 不改 `Model.provider`，只回报解析结果（`packages/ai/src/auth-gateway/server.ts:593-594`）。显示名 `label="Cursor"` 只在 KDL/登录名中出现（`cursor.kdl:6`）——**不得**作为身份。

### 3.2 模型标识与目录

- 文本形态 `provider/modelId`（首个 `/` 切分 + 可选 thinking 后缀）：`packages/tui/src/overlays/model-selector.ts:59-66`；持久化用同一形态（`model_change` 条目 `model: "provider/modelId"`）：`packages/coding-agent/src/session/model-controls.ts:232`、`packages/coding-agent/src/session/session-entries.ts:103-107`。
- 结构化 `Model{id,name,api,provider}`：`packages/catalog/src/types.ts:1167-1214`。
- 目录 RPC：`get_available_models`（`packages/coding-agent/src/modes/rpc/rpc-mode.ts:1422-1425`），条带 `provider`/`id` 稳定 id（SDK 窄化为 `provider|id|contextWindow|reasoning|thinking`：`modes/rpc/rpc-client.ts:94`）。

### 3.3 会话内模型可切换，且校验与"模式能力"无关

- RPC：`set_model` / `cycle_model`（`modes/rpc/rpc-types.ts:48-49`），处理与目录查找拒绝见 `rpc-mode.ts:1393-1412`（`Model not found: <provider>/<modelId>`）。
- 核心校验是**凭证**而非能力：`hasConfiguredAuth`（`packages/coding-agent/src/session/model-controls.ts:213-226`、`:283-284`）。
- 切换**不重启**会话，只重置 provider session（`:8937-8945`）；**没有** Cursor 专属分支（`:9039-9048`）。

### 3.4 OMP 自身的 plan/goal 与 rpc 面

- 原生存在：`packages/coding-agent/src/plan-mode/state.ts:1-4`、`packages/coding-agent/src/goals/state.ts:4-8`、设置项 `packages/coding-agent/src/config/settings-schema.ts:4811,4828`、`tools.approvalMode :4083`；只读写保护 `packages/coding-agent/src/tools/plan-mode-guard.ts:139-159`。
- **rpc/rpc-ui 无模式面**：`RpcCommand` 联合（`rpc-types.ts:36-89`）与 `RpcSessionState`（`:95-117`）都没有 plan/goal/mode 字段；桌面侧诊断同样结论（`app/scripts/check-omp-plan-goal-gaps.mjs` g4：42 条命令中无 plan/goal/permission/approval，基线 exit 1、3 缺口）。
- 桌面既有的 OMP Plan/Goal 面缺口：G1（模式只持久化、不下发）、G2（插件执行硬编码 `mode:"agent"`）、G3（已批准计划执行对非 Pi 引擎拒绝），见 `docs/validation/M5-plan-goal-capability-gates.md` §5。

### 3.5 宿主工具与持久化

- `set_host_tools` 的定义与注册/校验：`rpc-types.ts:41,442-455`、`rpc-mode.ts:1335-1339,575-601`、`session/session-tools.ts:1964-1974`（重名/与既有工具冲突拒绝）；执行路径 `modes/rpc/host-tools.ts:46-65,124-180`。
- 会话头**不含** provider/model（`session-entries.ts:35-56`），模型/模式分别以 `model_change`/`mode_change` 事件记录（`:103-107`、`:265-269`）；恢复时用 `modelRegistry.find` + `hasConfiguredAuth` 重新校验（`sdk.ts:1586-1608`）。
- **不存在"因模式拒绝模型"或反向的上游代码**（NOT FOUND，检索面见子代理记录）。

## 4. 父仓库边界、可达状态矩阵与实现决策

### 4.1 今天到底可达什么（可达性证明）

| 断言 | 证据（`app/`） |
| --- | --- |
| 桌面无法表达 Cursor 传输：wire api 词表里没有 cursor 传输 | `packages/shared/src/model-catalog.ts:22-30`（`API_STYLES` = chat_completions / responses / anthropic_messages / google_generative_ai / openai_codex_responses / pi_messages / opencode_go） |
| OMP 投影只映射 5 种 api，且拒绝 OAuth | `apps/desktop/electron/main/runtime/omp-model-projection.ts:19-36`（`PI_STYLE_TO_OMP_API`、`UNSUPPORTED_STYLES`）、`:108`（auth 允许集仅 api_key/api_key_and_base_url/none）、`:116-118`（OAuth 拒绝） |
| Pi 引擎也没有 cursor 传输 | `packages/agent-runtime/src/provider-binding.ts:98-160`（`apiBindingForStyle` 无 cursor 分支）；`node_modules` 内 `@earendil-works/pi-ai@0.86.1` 中 `cursor-agent` 出现 **0** 次 |
| provider 行 id 不可由客户端指定 | 用户行 `Uuid::new_v4()`：`crates/host-core/src/providers/repository.rs:87`；插件行 `plugin:{plugin_id}:{declared_id}`：`crates/host-core/src/plugins/providers.rs:71`；预设 id 固定（`packages/shared/src/provider-presets.ts`） |
| 会话的 `provider_id` 可来自导入（可能是 `cursor`），但导入强制 `mode: "agent"` | `apps/desktop/electron/main/importers/pi.ts:147,186-191`、`opencode.ts:126,171-176` |
| OMP 侧没有任何"计划提交工具"可写模式 | g4 判定（§3.4）+ `apps/desktop/electron/main/runtime/plans.ts:447`（非 Pi 引擎拒绝派发）+ `ipc/agent-ipc.ts:1102-1105`（计划审批先要求 Pi 引擎） |
| Pi 会话即使 provider 绑定无法解析也**会**启动（回退到默认/首个提供方） | `packages/host-runtime/src/launch-resolver.ts:227-231`（`provider = ...find(请求 id) || find(默认) || find(有密钥) || providers[0]`，全空才 `MODEL_NOT_CONFIGURED`） |
| Pi 会话的模式可由模型经 `plans.enter` 写（不经桌面 IPC） | `packages/agent-runtime/src/runtime.ts:619-620,3595-3630`（`EnterPlanMode`→`host.call("plans.enter")`）、`crates/host-core/src/rpc/mod.rs:2850`、`crates/host-core/src/plans/approval.rs:129-165`；桌面不在该调用路径上 |

### 4.2 可达状态矩阵（调整后）

| # | 方向 / 场景 | 是否可达（今天） | 强制点 | 期望结果 |
| --- | --- | --- | --- | --- |
| 1 | Cursor 会话（`provider_id="cursor"`）进入 Plan/Goal | 可达（导入行）；UI 不能选到 `cursor` provider 行 | `sessionConfigure`（有效对合并后判定） | 拒绝 `PLAN_GOAL_CURSOR_UNSUPPORTED`，零写入 |
| 2 | Plan/Goal 会话切换到 Cursor | 同上 | `sessionConfigure` | 同上 |
| 3 | 新建会话时携带该组合（来自默认模式/默认模型或草稿） | 可达 | `sessionCreate` | 同上，零持久化 |
| 4 | 已持久化/导入的无效组合继续派发 | 可达（DB 既有行、导入行、fork 从陈旧父会话继承、或 §4.1 最后两行） | `agentPrompt`（任何运行时工作之前） | 确定性拒绝 + 本地化原因 + 两条出路 |
| 5 | 模型经 `EnterPlanMode` 写入 Plan（Pi 引擎、`provider_id="cursor"`） | **可达且桌面不可拦截**（sidecar 直连 host-core） | 只能由 #4 兜底 | 持久记录可落入组合，但**任何后续回合都不会在其中运行**；已知差距，下一步见 §7 |
| 6 | Agent 模式 + Cursor | — | 不拦 | 行为不变（回归测试锁定） |
| 7 | 非 Cursor + Plan/Goal | — | 不拦 | 行为不变（回归测试锁定） |
| 8 | 计划执行派发（OMP 引擎） | 不可达（既有代码先拒绝非 Pi 引擎） | `runtime/plans.ts:447` | 与本不变量无关的既有拒绝 |

### 4.3 为什么把强制放在桌面边界，而不是 host-core

- 桌面侧的三个写入/派发边界**覆盖了桌面能接受的全部组合**（需求 1/2/3/4 的"transition/model change"），且与"渲染层不做权威判断"一致（渲染层只做预防+解释）。
- host-core 的门历史上只判**状态/上下文**（§2.2），把 provider 身份策略放进持久层会让引擎专属知识散落到 Rust 边界（与 ADR 0300 / 根约定的"运行时差异集中在边界与适配层"冲突）。#5 这条不可拦截路径**已如实记录**，并给出需要改动时的确切落点（host-core `PlanManager::enter` + 跨语言字面量测试）。
- 需求 3 的"陈旧/持久化组合**不得静默运行 Cursor 工具**"由 `agentPrompt` 门保证：拒绝发生在任何 OMP/Pi 运行时工作之前（测试断言 `ompSessions.prompt`/`sidecar.call` 未被调用）。

## 5. 实现（文件与函数）

| 层 | 文件 | 变更 |
| --- | --- | --- |
| 共享（单一事实来源）| `packages/shared/src/plan-goal-model-gate.ts`（新） | `CURSOR_PROVIDER_ID="cursor"`、`isCursorProviderId`（精确比较）、`planGoalCursorRefusal(mode, providerId)`；契约模式取自 `PROPOSAL_KINDS`（新增模式不会静默变成契约模式）；拒绝载荷 `{errorCode, mode, providerId, message}` |
| 共享错误码 | `packages/shared/src/errors.ts:249-253`（新） | `PLAN_GOAL_CURSOR_UNSUPPORTED` |
| 共享导出 | `packages/shared/src/index.ts:51` | 导出上述模块 |
| main（派发门）| `apps/desktop/electron/main/ipc/agent-ipc.ts:367-377` | 引擎门之后、任何运行时/分支之前判定**持久记录**的模式与 provider |
| main（配置门）| `apps/desktop/electron/main/ipc/session-ipc.ts:723-740` | 合并 `config` 与 `session.get` 得到**有效对**后判定（渲染层发的是部分更新），先于任何 host/bridge 写入 |
| main（新建门）| `apps/desktop/electron/main/ipc/session-ipc.ts:194-203` | 新建即携带组合时拒绝，零 `session.create` 调用 |
| 渲染层（预防+解释）| `apps/desktop/src/stores/slices/session-slice.ts:577-595` | `configureActiveSession` 在 IPC 之前用同一谓词拒绝并以 `errors.<code>` 弹出本地化提示（草稿与在线会话两条分支都经过） |
| 渲染层（模型列表）| `apps/desktop/src/features/chat/composer/hooks/useComposerModelMenu.ts:108-141`、`ComposerModelPicker.tsx:239-249` | 契约模式下**隐藏** Cursor provider 组并给出原因；Agent 模式不变（`hiddenCursorProviders === 0`）|
| 渲染层（模型 pin）| `apps/desktop/src/stores/slices/session-slice.ts:412-445` | 自动 pin 会形成该组合时跳过并提示，避免乐观本地态与主进程不一致 |
| i18n | `packages/i18n/src/locales/{en,zh-CN,zh-TW,ko,tr,de,es,fr}/index.ts` | 8 个 catalog 同步新增 `errors.PLAN_GOAL_CURSOR_UNSUPPORTED`（键集一致性由既有测试强制）|
| 规范 | `docs/spec/03-runtime/08-error-codes.md` §3.2b + `docs/zh-CN/spec/...` 同形行、`docs/spec/03-runtime/02-agent-runtime.md` §16、`docs/adr/0306-plan-goal-excludes-cursor-models.md` + 索引行 | 错误码、门的设计与限制、ADR |

**没有**改动的面：host-core（Rust）、OMP/PI 子模块、patch artifact/manifest、`plans.ts`、既有错误码语义、Agent 模式与非 Cursor 提供方的任何行为。

## 6. 测试与验证

### 6.1 新增测试

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `packages/shared/src/plan-goal-model-gate.test.ts` | 6 | 谓词边界表：plan/goal×cursor 拒绝（含载荷/文案）、agent×cursor 放行、契约模式×其它 provider（含 `plugin:acme:cursor`、UUID）放行、`undefined/null/""/0/{}/[]/true` 与 legacy `chat`/`vibe` 不构成冲突、**不做名称猜测**（`Cursor`/`CURSOR`/前后空格/`cursor-agent` 均不匹配）|
| `apps/desktop/test/plan-goal-cursor-gate.test.mjs` | 10 | **真实 IPC 处理器**行为测试：持久 plan×cursor 派发拒绝且 `sidecar`/bridge 零调用；goal×cursor 在 OMP 路径同样拒绝且 `ompSessions.prompt` 零调用；新建携带组合拒绝且零 `session.create`；进入 plan/goal 与切换到 cursor 双向拒绝且零写入（含"只带 model 不带 mode"的有效对判定）；两条出路放行（改模式 / 换模型）；Agent×cursor 与非 Cursor×Plan 正常派发（回归）；近似名字不触发 |
| `apps/desktop/test/plan-goal-cursor-renderer.test.mjs` | 4 | 渲染层契约：错误码注册+中英文本、模型菜单按 `isCursorProviderId` 隐藏并渲染提示、store 守卫位于草稿分支之前且用 `errors.<code>`、pin 守卫先于乐观写入 |

### 6.2 失效性对照（RED 证据）

| 对照 | 做法 | 结果 |
| --- | --- | --- |
| 移除 `agentPrompt` 门 | 临时删除 agent-ipc 的门块并**复原** | `plan-goal-cursor-gate` 10 项中 **2 项判红**（plan×cursor、goal×cursor 派发）|
| 移除 `sessionConfigure`/`sessionCreate` 门 | 同上（注意首轮因 `index` 取到更早同名片段导致"假绿"，已用偏移定位重做） | 同一文件 **4 项判红**（进入 plan/goal、切到 cursor、model-only 有效对、新建）|
| 复原 | — | 10/10 全绿；`grep` 确认三个门块均存在 |

即：**每一个拒绝断言都在无门时失败**；4 项回归/出路断言在两种状态下都必须为绿。

### 6.3 实跑命令与结果

环境：Node v24.14.0（`$HOME/.nvm/versions/node/v24.14.0/bin`）、pnpm 10.34.5、Bun 1.4.2；工作目录 `app/`（desktop 套件在 `app/apps/desktop/`）。全部使用本地夹具/fake，**未调用任何付费或远程模型**。

| 命令 | 结果 |
| --- | --- |
| `npx vitest run --root packages/shared` | **490 通过 / 0 失败**（43 文件，含新增 6 项）|
| `npx vitest run --root packages/i18n` | **25 通过 / 0 失败**（3 文件；8 个 catalog 键集一致）|
| `node --test apps/desktop/test/plan-goal-cursor-gate.test.mjs` | **10 通过 / 0 失败** |
| `node --test apps/desktop/test/plan-goal-cursor-renderer.test.mjs` | **4 通过 / 0 失败** |
| `env -u SSH_ASKPASS node --test --test-reporter=tap test/*.test.mjs`（`app/apps/desktop/`） | **2901 项 / 2897 通过 / 0 失败 / 4 跳过**（含本阶段新增 14 项与三处测试夹具修正）|
| `node --test test/omp-subagent-e2e.test.mjs`（`app/apps/desktop/`，真实固定 OMP 18.2.7） | **3 通过 / 0 失败**（18.6 s；子代理端到端仍工作）|
| `pnpm --filter @pi-desktop/desktop typecheck` | **0 错误** |
| `pnpm build:js` | 成功（含 renderer/main 打包）|
| `pnpm lint`（biome 75 文件 + style tokens） | **0 问题** |
| `node docs/scripts/check-locales.mjs` | `Verified 79 English/Chinese specification pairs` |
| `node docs/scripts/check-docs.mjs` | 仅剩 **6 项预存在问题**（§7.2），本阶段新增页/行**零新增问题**（页数 505→506）|
| `node --test apps/desktop/test/error-code-registry.test.mjs` | **2 通过 / 0 失败**（新码已进 `08-error-codes.md`，且 host-core 发出的码全部已注册）|
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | **3 缺口 exit 1**（g1/g2/g3 未改变：本阶段不实现 OMP Plan/Goal 运行时面）|
| `node scripts/check-t20-matrix-ids.mjs` | `MATRIX-ID-OK` exit 0 |
| `git diff --check` / `git show --check HEAD` | exit 0 |
| 子模块 | OMP `d49918fab`、PI `0111e306`；gitlink 与追踪内容未改动（子模块内仅有被上游 `.gitignore` 覆盖的构建载荷：`node_modules`、`packages/natives/native`、生成文件）|

### 6.4 因本次改动修正的既有测试夹具（非产品回退）

`session-ipc.ts` 新增了对 `@pi-desktop/shared` 的导入，三个用**手写 shared 桩**转译加载 main 模块的测试文件需要让桩包含该模块（`engine-session-ipc.test.mjs`、`omp-session-configure-ipc.test.mjs`、`omp-session-ipc-result.test.mjs`）：现在通过 `helpers/ts-import-hooks.mjs` 直接加载 `packages/shared/src/plan-goal-model-gate.ts` 并展开进桩。三处均为夹具依赖面同步，断言未改。

## 7. 限制、未做与已知缺口

1. **不声称严格 Cursor 兼容**：R3 仍为硬阻塞（0/12，§引言）；本阶段不实现 Plan/Goal 的 OMP 运行时面（提示词/dir/提交/审批/派发均属 T20-B/C/D，未开始）。
2. **预存在缺陷（非本阶段引入，未修）**：`app/docs/scripts/check-docs.mjs` 在**本阶段开始前的同一提交上**即报 6 项——`adr/0301-omp-session-surface.md` 的 H1 不以 `ADR` 开头（`git show HEAD:app/docs/adr/0301-omp-session-surface.md` 第一行即 `# 0301 — …`），以及 `adr/0301`–`adr/0305` 五行缺失于 `adr/README.md` 索引。本阶段只为自己的 ADR 0306 添加索引行；其余保持原样以免混入无关改动。
3. **已知差距（#5）**：Pi 引擎下"模型经 `plans.enter` 写 Plan"这条路径**桌面不可拦截**（§4.1/§4.3）；组合可由该路径落入持久记录，但**任何后续回合都会被派发门拒绝**，用户有一条明确的出路。若产品要求持久记录本身永不落入该组合，落点是 host-core `PlanManager::enter`（`crates/host-core/src/plans/approval.rs:129-165`）+ 一条跨语言字面量等价测试；本阶段按任务约定"先证明并记录调整后的矩阵"，未改动 Rust。
4. **未做**：未做 UI E2E（`verify:ui:*` 需用户显式要求；本阶段为渲染层契约测试 + 真实 IPC 处理器行为测试）；未做 macOS 实机复核（本机 Linux）；未重跑 host-core Rust 套件（未改 Rust，且 `error-code-registry` 已覆盖"host 发出的码均已注册"）。
5. **未声称**：未声称本阶段解决了 OMP 的 Plan/Goal 能力（G1/G2/G3 仍开放）；未声称 Cursor 传输在其它引擎/未来构建中不可达（只声称**当前构建**的可达性，并已给出来源证据）。

## 8. 下一轮入口

- 无（T20 仍受阻）。若解除 R3 需要：上游 OMP 提供批次可见/终止能力、用户显式接受语义差异、或把提交移出模型循环（三者皆需上游变更或用户决定，见 `docs/validation/M5-plan-goal-capability-gates.md` §6.3/§8）。
- 仍关闭：`branch`/`steer`/`followUp`/`compact`、子代理单独停止、子代理 `hasUI=false` 工具 gating、PI agent 扩展注入。

## 9. 证据来源与核验方式

- 上游（PI/OMP）行号来自本轮**只读源码检索**（子代理 scout 的逐文件 `grep`/`read` 输出，含各自给出的空检索面）。本产品的**强制接缝与可达性断言**（§4.1、§5、§6）由本轮直接复核并在测试中实跑。
- 所有测试数字均为本机实跑输出；未运行的命令在 §7.4 明确列出，不写成"通过"。
