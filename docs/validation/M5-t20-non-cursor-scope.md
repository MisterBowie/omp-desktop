# M5/T20 范围修正：排除 Cursor + Plan/Goal —— 当前范围、验证与下一阶段拆分

更新时间：2026-10-02。状态：**范围决策已落盘；T20 未完成、Plan/Goal 未实现。** 本文件是用户于 2026-10-02 作出范围调整后的**当前范围**权威说明；历史报告保持原样，只在文件顶部加日期化范围说明并链接本文件。

- 分支：`codex/m5-t20-non-cursor-scope`，基线 `c8b358706417d2f8fa1949fe589f1d5f5512ce8d`（上一阶段已验收提交；追加提交，不 amend/rebase/强推，不创建 PR、不发布产品）。
- 工作树：`/home/vv/person/code/omp-desktop-m5-t20-scope`；固定子模块：OMP `62bc57be1b03ef0802a33cf7f5f530e534527531`（omp/18.3.0）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`。
- 本阶段**只做范围决策落盘、现有拒绝机制回归、非 Cursor 路线的就绪性验证与下一阶段拆分**：不实现 T20-B/C/D、不改产品运行时行为、不开放任何未完成能力。

## 1. 用户决定与当前范围

2026-10-02 用户指示：**先排除 Cursor + Plan/Goal**。本记录把该指示落成当前产品范围，解释如下：

1. **Cursor + Plan/Goal = 不支持且拒绝。** ADR 0306 的既有门全部保留并继续生效：host-core 持久写入守卫（每连接 TEMP 触发器）、Main 进程 `sessionConfigure`/`sessionCreate`/`agentPrompt` 的写入前拒绝、派发门（`runtime/plans.ts` 的 Pi-only 拒绝）与渲染层预防；错误码 `PLAN_GOAL_CURSOR_UNSUPPORTED` 不变。**不移除任何既有门或回归，也不全局禁用 Cursor**：组合门不拒绝 Cursor + Agent，但当前桌面尚未接通 Cursor 传输，本轮不新增该能力；所有非 Cursor 提供方不受影响。
2. **非 Cursor 路线仍在范围内，契约不降级。** 对"受支持 HTTP 模型、工具派发由已补丁 agent loop 裁决"的会话，Plan/Goal 仍必须满足 PI 严格契约：提交工具独占**全部 `toolCall` 块**的批次；混合批次整批拒绝、所有兄弟零副作用；声明 `sole` 的会话关闭工具投机；提交终支 terminate 且无后续 provider 步。**不得**把验收降成"尽量阻断"，也不得缩小批次计数。
3. **这是用户授权的范围调整，不是上游能力变化。** Cursor 通道的严格 RED 证据（R3B 实测 **0/12**）继续有效，其含义是"该组合被范围排除的事实"，**不表示已修复或已通过**。桌面模型投影本来就不含 `cursor-agent` 传输（`packages/shared/src/model-catalog.ts` 的 `API_STYLES` 无该样式；`apps/desktop/electron/main/runtime/omp-model-projection.ts` 无 Cursor 传输映射，两文件源码中 `cursor` 零出现），产品当前不调用 Cursor；Cursor 实验只导入本地代码/模拟帧，无真实服务请求（本轮执行器与远端模型仍为用户指定的 DeepSeek）。
4. **T20 整体未完成、Plan/Goal 未实现。** 现存缺口 g1/g2/g3 与 B/C/D 矩阵全部未实现（§3），`plan`/`goal` 能力保持关闭，OMP 会话的 Plan/Goal 入口不开放。

| 组合 | 当前范围 | 现状 |
| --- | --- | --- |
| Cursor + Agent 模式 | 组合门不拒绝；**当前桌面尚未接通 Cursor 传输，本轮不新增该能力** | 无新改动；18 项门回归为 mock runtime，只证明不被门拒绝，不代表产品已支持 Cursor 会话 |
| Cursor + Plan/Goal | **不支持、拒绝** | ADR 0306 门已实现并测试（host-core + Main + 渲染层） |
| 非 Cursor + Plan/Goal | **在范围内、尚未实现** | T20-B/C/D 未开始；能力关闭 |
| 非 Cursor `sole`/terminate 的 loop 受控路径 | 在范围内、必须严格 | 本轮在 18.3.0 + patch `.3` 上复测（§2）；宿主审批/恰一次/重启不重放仍未实现 |
| Cursor 通道的严格契约（R3） | **范围外** | 历史 0/12；不声称修复 |

## 2. 本轮验证（2026-10-02）

环境：Linux x64；Node v24.14.0；Bun 1.4.2（`/home/vv/.bun/bin`）。所有运行使用**本地 FakeProvider**、**真实固定 OMP 运行时**与**真实补丁 scratch 树**，未调用 DeepSeek/Cursor 或任何付费/远程模型。子模块按固定 SHA 初始化（OMP 对象取自受控 fork `MisterBowie/oh-my-pi` 本地对象库），补丁通过 `app/scripts/omp-patch.mjs` 的 `preparePatchedTree({ prepareBuild: true, keep: true })` 应用；该脚本拒绝脏工作树与 HEAD≠`base.sha`，构建载荷（`node_modules`、`packages/natives/native`、tool-views）从固定 SHA 源码复制，因此不会误用未补丁源码。

### 2.1 非 Cursor loop 受控路线：`node t20-feasibility.mjs --patched` → **46/46，exit 0**

运行坐标（结果 JSON 内 `artifacts["patched.runtime"]`）：patch level `62bc57b+omp-desktop.3`、base `62bc57be1b03ef0802a33cf7f5f530e534527531`、launcher 为 scratch 树内 `packages/coding-agent/scripts/omp`、`carriesPatch` 三项（`batchPolicy`/`concurrency`/`terminate`）均为 true。运行时间 `2026-10-02T12:59:22Z → 13:00:04Z`（42 s）。

| 场景 | 观测（`t20-feasibility-patched-20261002.json` artifacts） | 结论 |
| --- | --- | --- |
| s1 同批 `[bash, SubmitPlan]` | `hookOrder: []`（批次被拒后不咨询 hook）、`bashSideEffect: false`、`submitHostCalls: 0`、`executions: []`、`providerRequests: 2` | 混合批次零副作用、整批阻断、模型只看到被 block 的结果 |
| s2 同批 `[SubmitPlan, bash]` | `bashSideEffect: false`、`submitHostCalls: 0`、`executions: []` | 顺序颠倒结论相同 |
| s3 同批 `[SubmitPlan, SubmitPlan]` | `submitHostCalls: 0`、`hookCalls: 0` | 重复提交执行 0 次 |
| s3b gate 只 block 过渡工具 | 兄弟 `bashSideEffect: false`、`submitHostCalls: 0`；note：`tool_execution_start` 对 blocked 调用也会发，副作用信号是兄弟文件与 `host_tool_call` | 逐调用 block 保护不了兄弟——批次级裁决才是契约（与 T20-A 一致） |
| s4 提交成功后 | `providerRequestsAfterSubmit: 1`（即提交结果后 0 个新 provider 请求）、`continuedToolRan: false`、`executions: ["SubmitPlan"]` | 成功终支 terminate，无后续 provider 步、无后续工具执行 |
| s5 提交失败终支 | `providerRequests: 1`（0 后续）、`continuedToolRan: false` | 失败终支同样 terminate |
| s6 abort 挂起提交 | `host_tool_cancel.targetId == call.id`、`agentEndCount: 1`、abort 后 `get_state` 成功 | 取消按 targetId 关联、回合终止、会话仍可观察 |
| s7 拦截时 `ctx.abort()` | 兄弟零副作用；帧序列以 `agent_end` 结束 | 兜底手段仍是"整回合 aborted"语义（不等于 PI block-and-continue） |
| r4a 先 `set_host_tools` 后夹取 | provider 工具表 == clamp 严格相等 `read,grep,glob,bash,SubmitPlan` | 唯一正确顺序 |
| r4b 反向顺序对照 | 第一 prompt == clamp；第二 prompt 重新出现 `SubmitPlan,HostEcho` | 顺序颠倒会撤销夹取（证明顺序是契约） |
| r4c 目录生命周期（同 session 5 prompt） | 5 个 prompt 工具表与各自 catalog+clamp 逐一严格相等、无重复、无滞留；`startAttempts` 全为 1 | 增/删/重加提交工具收敛 |
| r4d 夹取 + mode block（3 prompt，第三个为真实变化） | `attemptsPerPrompt: [2,1,2]`；工具表严格等于 clamp；`systemMessagesPerPrompt: [1,1,1]` | 首次变更 1 次 policy retry、稳定后 1 次、真实变化仍在 1 次 retry 内收敛 |
| r4d mode block 字节（UTF-8） | `blockBytes: [176,1726,2156]`（Agent/Plan/Goal）、各恰出现 1 次、其它块 0 次、`piDefaultBasePresent: [false,false,false]`、`systemBytes: [12827,14377,14811]`、`prefixBytes: [12651,12651,12655]`，满足 `system = prefix + block` | 生产 `composeModeSystemPrompt(mode, "")` 输出的块为纯追加（与 18.2.7 轮数值不同是因为 base 已升 18.3.0） |

**这与历史 46/46 的关系**：T20-R3A 曾在 18.2.7 + patch `.1` 上得到同样的 46/46；本轮是**同一 spike 在现基线（18.3.0 + patch `.3`）上的复核**，证明 loop 受控能力在补丁迁移与可复现构建改动之后仍然成立。它**只覆盖 loop 可控路径**：FakeProvider 不产生 Cursor exec 通道、不启用工具投机；批次计数、投机门禁、Cursor-resolved 兄弟等由补丁的单元测试覆盖（见 `docs/validation/M5-omp-transition-patch.md` §3/§4）。

### 2.2 Cursor 拒绝机制回归（不支持组合依旧提前拒绝）

工作目录 `app/`，Node v24.14.0：

| 命令 | 结果 |
| --- | --- |
| `pnpm build:js`（运行测试前的必要构建，exit 0） | 全部 workspace 包构建成功 |
| `node --test apps/desktop/test/plan-goal-cursor-gate.test.mjs apps/desktop/test/plan-goal-cursor-renderer.test.mjs apps/desktop/test/plan-goal-cursor-constant-parity.test.mjs` | **18 passed / 0 failed / 0 skipped，exit 0**（含真实 IPC handler 边界：配置/创建/模型变更的写入前拒绝、两条修复路径、渲染层预防、跨语言字面量一致性） |
| `pnpm exec vitest run src/plan-goal-model-gate.test.ts`（`app/packages/shared`） | **7 passed / 0 failed，exit 0**（共享 predicate） |
| `cargo test -p host-core --locked plan_goal_guard`（复用 m6-t21 的 target 缓存） | **15 passed / 0 failed**（590 filtered out），exit 0——持久写入守卫、连接作用域、升级顺序、旧记录修复全部通过 |
| `node --test apps/desktop/test/packaging-sidecar-source.test.mjs apps/desktop/test/preview-workflow.test.mjs apps/desktop/test/omp-sidecar.test.mjs` | **13 passed / 0 failed，exit 0**——证明 manifest 只新增 `status.scopeNote` 后，pin 校验、CLI `--check`、工具门深度确定性与打包来源测试不受影响 |
| `node scripts/omp-patch.mjs --check` | `OMP-PATCH-OK 62bc57b+omp-desktop.3`，exit 0（patch sha256 `ad63ced9…`、87190 字节、7673 文件） |

以上回归**没有新增产品逻辑、没有新增镜像实现的新测试**，只重跑既有测试证明：不支持组合继续被提前拒绝；普通 Agent/非 Cursor 路径不受误拒。**Cursor 门 18/18 只证明 provider=cursor + agent 的组合不会被该门拒绝（mock runtime），不证明产品支持 Cursor 会话**——当前桌面没有 `cursor-agent` 传输映射（§1、§7）。

### 2.3 文档/矩阵/静态检查（2026-10-02，`app/`）

| 命令 | 结果 |
| --- | --- |
| `node scripts/check-t20-matrix-ids.mjs` | `MATRIX-ID-OK: B1-B14, C1-C8, D1-D3 each appear exactly once`，exit 0 |
| `node scripts/check-omp-plan-goal-gaps.mjs` | `SKIP`（未启用 opt-in），exit 0 |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | **`SUMMARY: 3 gap(s) open [g1, g2, g3]`，exit 1**——本阶段未改产品代码，缺口保持红灯（未静态假绿；g4 报告称当前 pin 的 rpc-ui 有 45 个命令、仍无 plan/goal/permission/approval 命令） |
| `node docs/scripts/check-docs.mjs` | exit 1：**6 项预存在问题、共 507 页，与本轮起点一致、零新增**——1 项 ADR 目录 H1（`0301`）+ 5 项 ADR index 缺失（`0301`-`0305`，其中 0305 为本项目既有的历史问题）；**不是全量绿** |
| `node docs/scripts/check-locales.mjs` | `Verified 79 English/Chinese specification pairs.`，exit 0 |
| `node scripts/check-release-docs.mjs` | aligned with 0.15.2，exit 0 |

## 3. 历史证据与未实现项（保持历史原样）

| 日期 | 记录 | 结论 | 当前定位 |
| --- | --- | --- | --- |
| 2026-09-25 | `M5-omp-transition-patch.md` §1-§8（R3A） | 补丁降级为风险收敛；严格契约在含 Cursor exec channel 的组合上不可满足 | Cursor 组合范围外的事实依据；非 Cursor 路线继续使用同一补丁能力 |
| 2026-09-25 | `M5-omp-transition-patch.md` §9/§10（R3B） | 真实 Cursor exec 派发器 + 真实桥接：严格检查 **0/12** | 范围外组合的历史 RED，不声称修复 |
| 2026-09-25 | `M5-cursor-plan-goal-gate.md` + ADR 0306（R3C） | 产品门：host-core 持久写入门 + Main/渲染层拒绝 | **当前范围的一部分**，门继续生效 |
| 2026-09-27 | `M5-omp-18-3-fork-audit.md`（R3D） | 18.3/fork 架构审计；不得用原生 Plan/Goal 冒充 PI parity | 历史结论继续有效 |
| 2026-09-25 | `M5-plan-goal-capability-gates.md`（T20-A） | 审计、契约、`check-omp-plan-goal-gaps.mjs`（g1/g2/g3）与 B1-B14/C1-C8/D1-D3 验收矩阵 | **矩阵是下一阶段权威验收面**；`g1/g2/g3` 仍未实现（探针仍报 `3 gap(s) open [g1,g2,g3]`） |
| 2026-09-27/28 / 10-01 | `M5-omp-18-3-patch-migration.md`、`M6-r4-3-reproducible-sidecar.md`、`M6-t21-packaged-runtime.md` | patch `.2` → `.3`、可复现构建、打包资源验收 | 现行构建产物坐标（本阶段未改） |

未实现项（本阶段**不变**）：

- **g1**：`mode`/`permissionMode` 仅持久化在 host DB，没有任何 OMP prompt/工具路径读取它们（归属 T20-B1）。
- **g2**：插件执行上下文硬编码 `mode: "agent"`，会话持久模式不到达插件执行（归属 T20-C）。
- **g3**：已批准的 Plan/Goal 执行在 claim 前被 Pi-only 拒绝，OMP 会话的 queued 执行不运行（归属 T20-B2）。
- **能力表**：`OMP_ENGINE_CAPABILITIES` 无 `plan`/`goal` 键；OMP 会话 Plan/Goal 入口不开放（归属 T20-D 前的最后一个门）。
- 宿主审批闭环、恰一次派发、重启不重放、执行时权限表（风险/`planSafeActions`/有效模式）**全部未实现**。

## 4. 下一阶段拆分（小任务；未完成前不开放能力）

原则（来自用户指示与 T20-A §6）：**先完成生产 mode/policy 通道与契约硬拒绝，才可接通提交/批准，最后才开放 capabilities**。每个任务只有一个可验证结果；矩阵行是权威验收面（`M5-plan-goal-capability-gates.md` §7）。

### T20-B1 运行域 mode/policy 状态与目录（不接通提交）

- **范围**：`desktop-state` 快照 v2（mode block + 已解析有效权限模式 + 每 host tool 的 `{risk, planSafeActions}` 策略表，`inherit` 在桌面侧解析完成）；gate 以同一原子替换通道读取；mode block 只追加 `composeModeSystemPrompt(mode, "")`；每 prompt 先 `set_host_tools`、后 `before_agent_start` 内 `setActiveTools`；子代理零注入；状态写入失败 → prompt 拒绝。
- **矩阵行**：B1、B2、B3、B10（Agent/T17-T19 回归）、B11、B12、B13、B14；g1 与本任务的行为测试（B2/B13）退场。
- **可观察退出口径**：真实固定 OMP + FakeProvider 下，契约模式 prompt 只含生产 mode block（恰一次、单 system、前缀为纯 base）、目录与 clamp 严格相等、真实 `sessions.mode` 切换后按新目录重建、策略表与目录同源；`OMP_T20_GAP_PROBE=1` 的 g1 由"REVIEW-REQUIRED"退场为行为测试覆盖。
- **明确不做**：不注册 `SubmitPlan`/`SubmitGoal`（提交入口保持关闭）；不动 g3 的派发拒绝与 `plan`/`goal` 能力键。

### T20-B2 提交/审批/派发闭环（依赖 B1）

- **范围**：提交工具注册与 kind 校验；产物（`.pi/<kind>/…` 不可变、sha256/大小、防覆盖/symlink 拒）；审批卡（`PlanApprovalBar` 复用）、reject/过期/打断语义、approve 原子写 mode=agent+permission_mode+queued；claim CAS 先于任何 OMP prompt、finish CAS、drain 只派 queued、boot 打断不重放、执行期配置冻结；批准后以选定 permissionMode 运行的 agent 回合；Goal 无延续定时器（如实记录差异）。
- **矩阵行**：B4-B9、D1（提交/审批/派发部分）、D3 的闭环；g3 与本任务退场。
- **前置**：B1 的 mode/policy 通道与 T20-C 的契约硬拒绝**必须先完成**（用户指示：硬拒绝先于提交/批准接通）。B2 开工前必须先做 C1 级 gate 硬拒绝，否则不得注册提交工具。
- **可观察退出口径**：真实固定 OMP E2E——同意/拒绝/重启三条路径副作用正确；提交成功与失败终支都无后续 provider 步；`plans.claimExecution` 恰一次；无重放。
- **明确不做**：不开放 `plan`/`goal` 能力键；不声称 Cursor 兼容。

### T20-C 执行时权限与模式传播（先于 B2 的提交接通）

- **状态（2026-10-03）**：**已实现、待独立复审**（分支 `codex/m5-t20-c-execution-policy`，提交 `a7d0291`）。gate 决策表、`tool-paths` 移植、风险保真、插件真实 mode（含子进程 `planSafeActions` 转发修复）与委托策略均已落地；行为证据：gate/路径单元测试、真实 Bun 打包工具门探针、真实 `PluginRuntime` 子进程测试、真实已补丁 OMP 生产 E2E、B1 回归与 T17-T19 定向回归。证据 `docs/validation/M5-t20-c-execution-policy.md`；设计见 ADR 0309。g2 已退场为行为测试。
- **范围**：gate 按 PI §1.3.1 决策表实现（契约硬拒绝先于一切；`Read`/`Glob`/`Grep`/`Bash`/`BrowserPreview`/`new_context` 例外；`mcp_*`=Low 仅在非契约常规判定；`plugin_*` 按 manifest 声明风险，缺失/非法→medium；`BrowserPreview`=Medium；外部路径例外；无 UI 时只在本来需要交互时 fail closed）；插件执行 ctx.mode 取真实持久模式 + `planSafeActions` 逐 action；子代理 `hasUI=false` fail-closed；风险来自状态策略表而非名字猜测。
- **矩阵行**：C1-C8；g2 与本任务退场。
- **可观察退出口径**：gate 单元 + 真实 OMP E2E 逐格匹配 §1.3.1；`auto` 不能复活契约模式下的 Write/Edit/未知/`mcp_*`；`planSafeActions` 逐 action 生效；反向/边界对照（如无声明插件在 auto 下仍被契约拒绝）。
- **明确不做**：不放开高权限工具在 Agent 模式下的既有 PI 语义（按 §1.3.1 原样）。

### T20-D 整体验收与能力开放（依赖 B1/B2/C）

- **范围**：D1（Goal 契约与差异记录）、D2（`goal_updated` 只读展示，可选）、D3（端到端用户路径：切模式 → 对话 → 审批 → approve(ask/accept-edits/auto) → agent 执行；reject → 修改重提；重启无重放）；最后一步才把 `plan`/`goal` 加入 `OMP_ENGINE_CAPABILITIES` 并按能力显隐入口；Pi 会话零变化回归。
- **矩阵行**：D1-D3 + B9（能力声明）的最后开放动作。
- **可观察退出口径**：真实固定 OMP 全链路 E2E + 渲染层；能力键只在上述全部通过后开放；未通过的能力保持关闭并如实记录。
- **明确不做**：不因功能可用而删除 Cursor 门或缩小契约。

## 5. 本阶段不声称的内容

- **T20 未完成、Plan/Goal 未实现、能力未开放**；本记录不把任何 B/C/D 行标为完成。
- 46/46 只覆盖 **loop 受控路径**：不覆盖真实 Cursor 服务端、不覆盖真实付费/远程模型、不覆盖 Windows、未跑 `packages/agent` 全量套件、未证明宿主审批/恰一次/重启不重放（这些仍是 B/C/D 的验收项）。
- 本阶段**未改产品运行时代码**（`app/` 的代码与测试无行为变化）；变更只有文档、ADR/spec 镜像与 `manifest.status` 的日期化范围说明（不改 patchLevel、patch/hash/bytes、fork commit/tree、capability ids 或构建产物 pin）。
- **不声称 Cursor 会话可用**：组合门不拒绝 Cursor + Agent；当前桌面尚未接通 Cursor 传输，本轮不新增该能力（18 项门回归为 mock runtime，§1、§7）。
- 历史 RED（Cursor 0/12）逐字保留；"T20-B 不得开始"类旧结论只在 Cursor 组合的语境下继续成立，不作为非 Cursor 路线的现行规划。

## 6. 证据文件

| 文件（`docs/validation/M5-t20-non-cursor-scope/`） | 内容 | SHA-256 |
| --- | --- | --- |
| `t20-feasibility-patched-20261002.json` | 本轮 spike 结果（46/46，含 `patched.runtime` 坐标与全部 artifacts） | `89400edb4bf838addeaa876eaec84c50596ef376cc1d410c0edf8816a573f01b` |
| `t20-feasibility-patched-20261002.log` | spike 原始 stdout（未编辑；`*.log` 命中根 `.gitignore`，本轮复审返修用 `git add -f` 单独归档为**受跟踪文件**，字节与摘要不变） | `eba1ce725958323ce1b6390458507d9b87168b8c6eebcfb4bfc9081a5f290c7e` |
| `cursor-gate-tests-20261002.txt` | 三份 Cursor 门 desktop test 输出（18/18） | `d6885a77870063ff21a68abaca2bafaf713173c760204de19a0841bde1d33275` |
| `shared-predicate-20261002.txt.gz` | `plan-goal-model-gate` vitest 输出（7/7）**原始字节**（确定性 `gzip -n -9`） | `761b96b72337c0088ff8ab267d249703629c31a3afe31896765c820405e4dd7f` |
| `shared-predicate-20261002.txt` | 上述原始输出的**可读副本**（去掉 EOF 一个空行；文件头注明归一化，原始 `.txt` sha256 `7525b49b…e453`） | `88bc053ec7e131b65dce99666dfaee3771c85072b18a5d4cadfc67e09579c046` |
| `hostcore-plan-goal-guard-20261002.txt.gz` | host-core `plan_goal_guard` 输出（15/15）**原始字节**（确定性 `gzip -n -9`） | `df73bc9f203e9624730df71f2b16357bf09b4ed43c0f293419aede21a30aa32a` |
| `hostcore-plan-goal-guard-20261002.txt` | 上述原始输出的**可读副本**（去掉 EOF 一个空行；文件头注明归一化，原始 `.txt` sha256 `49f084c5…4a2d`） | `b050e4fa62020917adf0adc0ca2aa5631df663a6bace57c425c9641f77843e24` |
| `manifest-consumers-20261002.txt` | manifest 消费方回归输出（13/13） | `ebe6d17f854a3b65feb73b1fd023a7aabf951f0a0b03b8d1f74041cb2e1eae26` |
| `checks-20261002.txt` | 矩阵 lint、gap 探针（默认/启用）、docs/locales/release-docs 检查的原始输出与退出码 | `554d5e8ae7db4a06a067695e33f6090035ab9220ecad04a041664f7e465b2d44` |

两份日志的原始输出以 EOF 空行结尾，`git diff --check` 会将其判为 "new blank line at EOF"；按仓库既有做法**不改写原始输出**，而是保存确定性 gzip（`gzip -n -9`，含 SHA-256）并保留**清楚标注归一化**的可读副本，未新增任何 whitespace 忽略规则。其余日志未做归一化（原始即通过 `--check`）。本表 9 个引用文件在最终提交中的存在性与 SHA-256 已用 `git ls-files` 与 `git show HEAD:<path> | sha256sum` 逐项核对（§7）。

运行后已用 `git checkout --` 恢复脚本写出的已跟踪结果文件 `app/experiments/omp-bridge/results/t20-feasibility-patched.json`（旧历史不被本轮覆盖）；本轮输出以上表副本为准。

## 7. 独立复审返修（2026-10-02；仅文档/证据）

独立复审要求两项修正，均只改文档与证据归档：不改产品代码、测试、patch 构件、pin 或 manifest 其他字段；不重跑已绿的 46/46 与 18/18，只做静态与摘要核验（历史计数与结论保持原样）。

1. **证据引用缺失（归档）**：§6 引用 `t20-feasibility-patched-20261002.log`（SHA-256 `eba1ce72…`），但前稿提交不含该文件——`*.log` 命中根 `.gitignore` 第 11 行，文件只存在于工作树。本轮**未改写日志字节**，用 `git add -f` 把该原始文件单独归档为受跟踪文件（SHA-256 不变，见 §6）；未修改 ignore 规则、未新增忽略例外、未手写或重建日志。该日志无行尾空白、无 EOF 空行，无需 gzip/可读副本（复审提示的 `/tmp/t20-feasibility-patched-20261002.log` 在本机已不存在；证据目录中的同名文件 SHA-256 与前稿记录完全一致，归档的就是该记录的原始字节）。最终提交以 `git ls-files docs/validation/M5-t20-non-cursor-scope/` 与 `git show HEAD:<path> | sha256sum` 核对 §6 全部 9 个引用文件在提交中真实存在且摘要一致（不只存在于工作树）。
2. **门许可误写为传输可用**：前稿新增范围说明多处把"组合门不拒绝 Cursor + Agent（18 项 mock runtime 测试）"写作 Cursor 会话保持可用/保留可用。源码事实：`packages/shared/src/model-catalog.ts` 的 `API_STYLES` 无 `cursor-agent`；`apps/desktop/electron/main/runtime/omp-model-projection.ts` 无 Cursor 传输映射（两文件 `cursor` 零出现）。桌面当前不调用 Cursor 服务，18 项门回归只证明该组合不被门拒绝，不证明产品支持 Cursor 会话。本轮把新增范围说明统一改为 **"组合门不拒绝 Cursor + Agent；当前桌面尚未接通 Cursor 传输，本轮不新增该能力"**（HANDOFF、`00-scope-and-decisions`、任务看板、ADR 0305/0306、英文/中文 spec、R3C 报告顶部说明、本文件 §1 组合表/§2.2/§5）。用户仅排除 Plan/Goal 组合的范围意图不变，Cursor 未被全局禁用；历史原文保持原样，其"不受门影响"表述只按门判定理解，并由新说明补上当前 transport 状态，不把旧历史改写为"已通过调用服务"。
