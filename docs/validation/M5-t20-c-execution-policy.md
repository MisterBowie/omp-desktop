# M5/T20-C：执行时权限决策与插件真实模式 —— 验证记录

更新时间：2026-10-03。状态：**T20-C 实现完成（独立复审 R1/R2 返修后）、待根复审；T20 未完成、Plan/Goal 未实现、`plan`/`goal` 能力保持关闭。**
本阶段只实现执行时权限与模式传播（矩阵 C1-C8），不注册 `SubmitPlan`/`SubmitGoal`、不接通审批/派发（B4-B9/B2 仍开放）、不改 Pi-only 审批派发、不发布包、不合并 main。

- 分支 `codex/m5-t20-c-execution-policy`；基线 `bff27e11363d3a60b59265ff91d2fb3d814b574a`（B1 独立验收提交；根复审证据已归档在 `M5-t20-b1-runtime-state/root-acceptance-20261003/`）。
- 归档整理提交 `95023d5`（RED 日志确定性 gzip；详见 B1 记录 §12）与 `02bf603`（根复审验收证据归档）；**实现提交 `a7d0291bf500918e754b6a7e9870e3b8961d4e71`（代码/测试/脚本），文档与证据提交 `6d15d32`，坐标提交 `c3e274e`，根验收日志 gzip 保持 `571679f`**（追加提交，不 amend/rebase/强推；最终远端 `571679fa36e71274629a2491455c7941f37eb30c`）。
- 环境：Linux x64；Node v24.14.0（nvm 24.14.0 bin）；Bun 1.4.2；固定子模块 OMP `62bc57be1b03ef0802a33cf7f5f530e534527531`（omp/18.3.0，patch `.3`）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`。
- 全部运行使用**本地 FakeProvider / 固定已补丁 OMP 运行时 / 生产 wiring**，未调用任何付费或远程模型；未重跑 Rust host-core 606、未做 283 MB 打包（本阶段未改 Rust、patch 构件、pins/manifest）。

## 0. 独立复审返修（2026-10-03，R1/R2；原始 RED 归档见 §6）

根复审在原始远端提交 `fc0fb298` 上复现两条 P1（原始报告与脚本逐字节归档在
`docs/validation/M5-t20-c-execution-policy/root-review-20261003/`）：

- **R1（session grant 丢失）**：真实 UI 的 `allow-session` 在 `responseFor` 被折叠成第一个选项
  （`Allow once`），gate 只在收到第二个选项（`Allow for this session`）时授予会话范围，因此真实决定
  从未授权；且 grant 只存在于运行时进程内，B1 的同会话 Plan→Agent 运行时替换会丢掉它。原始反例：
  首个 Plan/ask 回合 allow-session 后，同 native 身份的下一个 Plan 回合仍弹卡、body0；切到 Agent
  （重建）仍弹卡。
- **R2（准入策略被可变文件覆盖）**：gate 的 `tool_call` 在**每次调用**重新读取运行域状态文件并覆盖
  准入快照；同一 Plan/ask 提示词内第一个 Bash 被 allow-once 后，该工具体只把文件里的
  `permissionMode` 改成 `auto`，同一提示词的下一个 Bash 便无卡执行并改写了哨兵文件。原始反例：
  mutation 用例仅 1 张卡、3 次 provider 请求、哨兵被改写；未改动文件的 control 用例 2 张卡。

返修（提交见 §6；ADR 0309 §6、spec 中英同步）：

1. **真实 wire 修正**：`responseFor` 对 gate 审批按用户所选选项原样回传——`allow-session` →
   `OMP_APPROVAL_OPTIONS[1]`，`allow-once` → `[0]`，`deny` → `[2]`；运行时自身审批
   （`["Approve","Deny"]`）保持原有映射、无会话范围。原注释"会话范围由 gate 保持"不实，已更正。
2. **grant 归桌面会话所有**：bridge 注册表按桌面会话 id 保存（对应 PI 内存态
   `AppState.session_grants`），仅在 `resolvePermission(..., "allow-session")` **确实写入成功**且请求是
   真实 gate 审批（描述符带 toolName）时记账；过期/取消/发送失败/重复裁决都不产生或重放 grant。
   记录带 native 身份标签，native 身份更换即丢弃；删除会话走 `clearSessionGrants`（对应 PI
   `permissions.clearSessionGrants`，已接 `session-ipc` 删除路径）；归档保留（会话行与 native 身份不变，
   与 PI 对 configured session 的行为一致）。grant 只随每次提示词的准入下发，不落盘。
3. **每提示词一份不可变准入**：新增 `session/turn-admission.ts`，把 `{nativeSessionId, mode,
   permissionMode, hostTools, grants}` 编码后附在既有 `/omp-desktop-turn` 握手参数上；gate 只为该
   token 安装该准入，并以参数原文 SHA-256 回执（ack v2），runner 收到匹配回执后才提交用户提示词。
   `tool_call` 只使用该回合的被准入记录（所属会话自身调用与 `hasUI=false` 委托），产品路径**不再**
   为策略回读状态文件；`agent_start` 武装、终止性 `agent_end` 退役（`willContinue` 续跑保留）、启动
   拒绝清空。无 payload 的夹具退化为"该回合第一次校验通过的读取即冻结"。已准入回合忽略 legacy
   `OMP_DESKTOP_GATE_MODE`，`OMP_DESKTOP_GATE_TOOLS` 只能增加 gated 名字、不能缩小。
4. **委托与旧回调**：委托无记录/记录已退役/他会话交互上下文一律 `policy-unavailable`；不再借用
   更早回合或他会话的策略。bridge 的 `admittedTurnPolicy` 在 stop/dispose 同步清空。
5. **tool-paths 注释更正**：相对逃逸（`../outside`）确实走外部路径分支（PI 同样先并入 workspace），
   旧注释"相对路径永远不是外部"不成立，已更正并由 `tool-paths.test.ts` 固定；macOS `/var` 别名行为
   与 PI 的"先词法根、后 realpath"一致（canonical 变体全部通过，未削弱符号链接/相对逃逸包含）。

复现（根脚本的便携化产品测试）：`packages/omp-runtime/src/session/gate-review-matrix.test.ts`
（canonical 20 用例 + 两条 extended 边界：legacy allow 对已准入回合无效、未裁决的未知名字不弹卡）、
`gate-admission.test.ts`、`turn-admission.test.ts`、`ui-requests.test.ts`、`runner.test.ts`（回执绑定）、
`apps/desktop/test/omp-session-bridge.test.mjs`（grant 记账/清除）与
`apps/desktop/test/omp-execution-policy-e2e.test.mjs` 场景 10/11（真实 native body：allow-session 跨同会话
下一提示词与 Plan→Agent 重建、他会话不继承、显式清除后重新弹卡；mutation/control 与"下一提示词按宿主
设置重新解析"）。



## 1. 实现

### 1.1 单一策略快照 → 一张决策表

`decideToolCall`（`packages/omp-runtime/extensions/omp-desktop-gate.ts`）改为消费 B1 写入的运行域状态快照
（`mode` / 已解析 `permissionMode` / 每宿主工具 `{risk, planSafeActions, origin}`），按 PI §1.3.1 顺序执行：

1. **合约硬拒绝最先**：`plan`/`goal` 下 PI allowlist 之外的任何工具、无非空 `planSafeActions` 的插件工具，
   在任何 permissionMode、legacy `allow`、Low 风险、session grant、外部路径、无 UI 判断之前 block；
   拒绝码 `WRITE_DISABLED_IN_PLAN` / `EDIT_DISABLED_IN_PLAN` / `PLUGIN_DISABLED_IN_PLAN` /
   `TOOL_DISABLED_IN_PLAN`。合约许可：`read`/`glob`/`grep`/`bash` + `ask`（OMP 非变更型提问工具；
   PI 的提问通道是宿主 UI、无模型工具）+ PI 专名 `BrowserPreview`/`new_context`（本运行时不注册，不虚构）；
   声明非空 `planSafeActions` 的插件工具落入常规判定，逐 action 由插件运行时 guard 把守。
2. **显式外部路径**：`auto` 放行、session grant 放行、否则弹卡（无 UI → fail closed）。
3. **风险**：Low 放行；`auto` 放行；`accept-edits` 仅 Write/Edit 自动；session grant 放行；其余弹卡。
4. **无 UI 只在"本就需要交互"处 fail closed**；`policyUnavailable`（强制通道开启但无可信策略）block 每个调用。

`OMP_DESKTOP_GATE_MODE` 降级为夹具开关，位于合约拒绝之下（不能复活合约拒绝的工具）；生产启动器从不写它。
**复审返修（§0.3）后**，产品路径的决策输入不再是"每次调用重读状态文件"，而是随握手安装、由 `agent_start`
武装/`agent_end` 退役的单份准入记录（payload 来自 bridge；无 payload 夹具取该回合第一次校验通过的读取）；
状态文件只提供内容（mode 块/技能/记忆）与强制存在性证明。

### 1.2 风险保真（G9 收口）

- 原生名按 PI `tool_risk_with_declared`：`read`/`glob`/`grep`（+PI `ScheduledTaskList`）Low；`write`/`edit`/`bash`
  （+`GenerateImages`）High；其余含 `apply_patch`/`eval`/`browser`/`computer`/`BrowserPreview` 一律 Medium。
- 宿主工具取状态策略表的**声明**风险：插件 `low|medium|high`，缺失/非法/未注册 → Medium；用户 MCP → Low
  （仅在非合约模式生效，合约模式先被硬拒绝）。
- 默认 gated 原生名单增加 `browser`/`computer`/`browserpreview`，使 PI 未命名的 Medium 能力在 ask/accept-edits
  弹卡而不是无审批执行（`browserpreview` 在本运行时不存在，只为按 PI 契约名判定而列入）。
- 卡片 risk/reason/mode/permissionMode 与决策来自同一对象；描述符新增可选 `mode` 字段（`approval-protocol.ts`）。

### 1.3 外部路径：host-core 语义移植

新增 `packages/omp-runtime/src/session/tool-paths.ts`，逐条移植 `crates/host-core/src/workspace.rs`：
词法 `.`/`..` 归一与根钳制、按组件包含（Windows 大小写不敏感）、最深已存在祖先 canonicalize、
有界（32 跳）悬空符号链接跟随、workspace/scratch 双根解析与"广告拼写 ≠ 规范拼写"的前缀重写、
`requires_external_path_permission`（`Read|Glob|Grep|Write|Edit` + 显式 `path`）。OMP 会话当前没有 scratch 根
（scratch 是 Pi sidecar 概念），gate 传 `null`；参数保留并有专门测试，语义与 PI 一致。复审返修更正了
"相对路径永远不是外部"的不实注释：相对路径与 PI 一样先并入 workspace，`../outside` 确实走外部路径分支
（`tool-paths.test.ts` 固定）；macOS `/var` 别名与 PI 的"先词法根、后 realpath"行为一致，未削弱包含检查。

### 1.4 插件真实模式（g2 退场）与上游缺口修复

- bridge 在每次被准入 prompt 后记录 `{turnId, mode}`；`OmpHostToolBinding.modeForTurn(turnId)` 只对该
  **精确回合**作答（未知/陈旧/委托回合 → `null`），适配器在 `dispatchable()` 之后、任何派发之前读取：
  `null` → 拒绝；用户 MCP 在非 `agent` 模式拒绝（`TOOL_DISABLED_IN_PLAN`，PI host-core 在插件桥之前同样拒绝）；
  插件工具收到**真实 mode**，PI 的逐 action `planSafeActions` guard（`plugin-runtime.ts:2504-2532`）因此在执行时生效。
- **修复一处可证实的上游缺口**：`plugin-host-process.mjs` 的 `pi.agent.registerTool` 此前只转发
  `{name, description, risk, schema}`，丢掉了 `planSafeActions`——host 侧注册表与 guard 读的是该字段，导致
  子进程声明的 plan-safe 列表永远到不了 guard、合约模式下插件工具永远不可用。现按声明转发
  （`planSafeActions !== undefined` 时带上）；该文件与固定 PI 上游逐字节相同，属 fork 修复，已在 ADR 0309 记录。
- 委托（`hasUI=false`）在**所属回合的被准入记录**下裁决（复审返修前是"进程级最近一次文件读取"）；记录缺失、
  已退役（stop/终止回合/拒绝）或属于他会话时一律 `policy-unavailable`，绝不借用更早回合或他会话的策略；
  不弹卡、不注入、不提权。

### 1.5 与 B1 的兼容性变更（有意为之，均已记录）

- **Agent+auto 不再为 Write/Edit/Bash/Medium 弹卡**（PI 语义）：B1 E2E 的"approval descriptor"阶段把
  permissionMode 固定为 `ask` 再驱动 write 审批，phase 4 的 `auto` 继承证据保留；
- **用户 MCP 在 Agent+ask 不再弹卡**（PI `mcp_*` = Low 自动放行）：`omp-host-tool-e2e` 的 MCP 用例改为断言
  "零弹卡、恰好执行一次"；
- **默认 gated 名单**新增三个 PI 未命名 Medium 名称（原 5 个不变）；
- **g2 静态检查退场**为 C 的行为测试（见 §2）；g3 仍 open，gap 探针 exit 1 为预期。

## 2. C1-C8 证据映射

| 行 | 场景 | 证据（层） | 结果 |
| --- | --- | --- | --- |
| C1 | 合约硬拒绝：Write/Edit/apply_patch/未知/`mcp_*`/无声明插件在**所有** permissionMode 与 legacy `allow` 下 block；合约许可集合正确 | gate 单元 `gate-permissions.test.ts`（plan/goal × ask/accept-edits/auto × 9 工具 + allow/grants/外部路径组合；拒绝码逐类）；编译产物探针 `omp-sidecar.test.mjs`（Bun 打包的真实 gate：plan Write block、无卡）；生产 E2E 以目录层如实标注隐藏工具的 not-found（不冒充 gate 拒绝） | 全绿 |
| C2 | Bash 无命令分类：inherit→默认、ask→卡、accept-edits→卡、auto→放行、Plan+auto 放行 | gate 单元（`ls` 与 `rm -rf /` 决策逐项相同）；生产 E2E（Agent+ask 批准后真实写文件；Plan+auto 真实写文件；Plan+ask 拒绝后零副作用） | 全绿 |
| C3 | 插件：无声明合约拒绝；有声明逐 action 允许/拒绝；`ctx.mode` = 真实模式 | 真实 `PluginRuntime` 子进程测试 `omp-plugin-plan-safe.test.mjs`（agent→`"mode":"agent"`；plan+`inspect` 允许、`write` 拒绝、无声明拒绝；goal 拒绝；未知回合拒绝；MCP plan 拒绝且 `callTool` 零调用）；生产 E2E（plan+auto 下 `plugin_demo_inspect` 实际执行并记录 `ctx.mode="plan"`） | 全绿 |
| C4 | 子代理 `hasUI=false`：合约模式 fail closed、Agent 语义不提高权限 | gate 单元（委托快照 + plan/goal 硬拒绝 + no-UI fail closed）；注册层测试（委托缓存/年龄界/无缓存 block）；生产 E2E（agent+ask 子代理 write → 无 UI block、文件不存在；agent+auto 子代理 write → 恰好一次） | 全绿 |
| C5 | browser/computer/eval：Agent+auto 放行、ask/accept-edits 弹卡、Plan/Goal 硬拒绝 | gate 单元（三种模式 × 三种 permissionMode × 三个名字；卡 risk=medium）；默认 gated 名单断言 | 全绿 |
| C6 | 四条有效权限模式：inherit 桌面侧解析、gate 只读结果；ask/accept-edits/auto 行为 | B1 生产 E2E（`inherit`→默认 `accept-edits`→`auto` 的逐轮解析与描述符消费，本阶段更新为 ask 弹卡断言语义）；gate 单元（快照 verbatim 消费）；wiring 单元沿用 | 全绿（B1 E2E 1 passed） |
| C7 | 风险保真：plugin 声明/缺失→medium、未知→medium、`mcp_*=low`（仅非合约）、BrowserPreview=medium 且合约许可 | gate 单元（`nativeRiskForTool` 逐名、策略表优先、mcp 在 plan 下即使 `auto`/`allow` 也硬拒绝、BrowserPreview 合约 ask 弹卡/auto 放行）；生产 E2E（plugin 声明 medium 卡、MCP Low 零卡执行） | 全绿 |
| C8 | 外部路径：auto 放行、ask/accept-edits 卡（除非 grant）、无 UI 只在需要交互时 fail closed；`..`/symlink/别名 | 路径移植测试 `tool-paths.test.ts`（Rust 测试逐条镜像 + scratch 拼写重写 + 工具名限定）；gate 单元（外部读 ask 卡/auto 放行/grant 放行/no-UI 语义）；生产 E2E（项目外真实文件：ask 拒绝零内容、auto 读出内容） | 全绿 |

## 3. 生产 E2E（`apps/desktop/test/omp-execution-policy-e2e.test.mjs`，真实已补丁 OMP + 生产 wiring/gate + FakeProvider）

12 个场景一次跑完 **1 passed（12.1s）**，逐场景断言决策与副作用计数（场景 10-12 为复审返修新增）：

1. Agent+ask：plugin_demo_echo（声明 medium）→ 卡（risk=medium、reason=审批理由）、拒绝 → 零执行、模型看到
   "denied by user"；2. Agent+ask：`mcp_alpha_lookup`（Low）→ **零卡**、恰好执行一次、结果回到模型；
3. Agent+ask：`bash printf … > marker` → 卡（risk=high）→ 批准 → 文件恰好写入一次；描述符实测
   `{mode:"agent", permissionMode:"ask"}`；4. Agent+ask：项目外 `read` → 卡（reason=external path）→ 拒绝 →
   后续请求无外部内容；5. default 改 `auto`（`inherit` 解析）→ 同一外部读**零卡**且内容回到模型；
6/7. 子代理（`hasUI=false`）：ask 下 write 被 no-UI block（模型收到理由、文件不存在）；auto 下同 write 恰好一次；
8. Plan+auto：隐藏的 `write` 尝试 → 目录层 `Tool write not found`、零副作用、**不声称 gate 拒绝**；
   `bash` 无卡执行；`plugin_demo_inspect` 无卡执行且 `ctx.mode="plan"`；隐藏 MCP 尝试同样目录层；
9. Plan+ask：`bash` 弹卡 → 拒绝 → 零副作用；
10. **grant 生命周期（R1）**：Plan/ask 首次 `bash` 弹卡 → `allow-session` → `listSessionGrants=[bash]` 且文件追加一次；
    同会话下一提示词**零卡**再追加一次；切到 Agent（B1 进程重建）后仍**零卡**追加一次；另一桌面会话（显式 ask）
    仍弹卡且拒绝后零副作用；`clearSessionGrants` 后同会话重新弹卡、文件不再增长；
11. **回合内 mutation（R2）**：control 与 mutation 两个回合各 3 次 provider 请求、恰好 2 张卡（首张 allow-once、
    第二张 deny）；mutation 回合的第一个工具体只改运行域状态 `permissionMode=auto`（输出 `MUTATION-OK`），
    同一提示词的第二个 `bash` 仍弹卡、拒绝后哨兵保持 `untouched`；两者的"下一提示词"按宿主 Plan/ask 重新解析、
    再次弹卡；
12. **canonical native write**：Agent/ask deny（无文件）→ allow-once（写入一次）→ auto（零卡）→ accept-edits（零卡）。

**分层诚实声明**：被 B1 目录夹取隐藏的工具（write/mcp/无声明插件）在真实运行时里**不会到达** gate
（`Tool <name> not found`），生产 E2E 只把它记为目录层证据；gate 层对这些工具的合约硬拒绝由
`gate-permissions.test.ts` 与 Bun 打包产物探针 `omp-sidecar.test.mjs`（真实 `bun build` 出的
`omp-desktop-gate.js`，子进程驱动 handler；plan Write block、plan Bash 卡字段、agent MCP 零卡、
缺状态 policy-unavailable）证明。

## 4. 验证命令与计数（复审返修后重跑；Linux x64 / Node v24.14.0 / Bun 1.4.2）

| 命令 | 结果 | exit | 原始日志 |
| --- | --- | --- | --- |
| `pnpm -C packages/omp-runtime test` | **30 files / 460 passed / 6 skipped**（+23：turn-admission 5、gate-admission 12、gate-review-matrix 2、runner 回执 1、ui-requests/其它更新） | 0 | `omp-runtime-vitest-repair.txt` |
| `node --test test/*.test.mjs`（`apps/desktop` 全量，`env -u SSH_ASKPASS`） | **2984 tests / 2973 pass / 0 fail / 11 skipped**（+1：bridge grant 记账/清除） | 0 | `desktop-suite-repair.txt` |
| `node --test test/omp-execution-policy-e2e.test.mjs`（场景 10/11/12 新增：grant 生命周期、回合内 mutation、canonical native write 模式） | **1 passed**（12.1s） | 0 | `c-execution-policy-e2e-repair.txt` |
| `node --test test/omp-runtime-state-e2e.test.mjs test/omp-session-turn-fence-e2e.test.mjs test/omp-plugin-plan-safe.test.mjs`（B1 生产回归、fence-Stop 反例、真实 PluginRuntime 子进程） | **4 passed** | 0 | `b1-fence-plugin-repair.txt` |
| T17-T19 定向回归（subagent e2e/bridge/read、tool-results(+render)、skill-path e2e/bridge/adapter、capability-source e2e/boundary、sidecar 编译产物探针、patch） | **122 passed / 0 failed** | 0 | `t17-t19-regression-repair.txt` |
| `pnpm build:js` / `pnpm typecheck` / `pnpm lint` | 全绿 | 0 / 0 / 0 | `build-typecheck-lint-repair.txt` |
| matrix ids / gap 探针 / omp-patch / release-docs / agent-policy / locales / check-docs | `MATRIX-ID-OK` / `GAP-RETIRED g1`+`g2`+`g3 open`（**exit 1 预期**）/ `OMP-PATCH-OK 62bc57b+omp-desktop.3` / 0.15.2 / 通过 / **79 对** / **6 项预存在**（509 页，exit 1 预存在） | 0 / **1（预期）** / 0 / 0 / 0 / 0 / **1（预存在）** | `checks-repair.txt` |
| `git diff --check <C 基线>..<返修 HEAD>`（完整提交区间，非仅工作区） | 干净（见 §6 尾部提交坐标） | 0 | `checks-repair.txt` |

历史（返修前，`fc0fb298` 上的接受基线，保留不改）：omp-runtime 27 files / 437 passed / 6 skipped；desktop 2983 / 2972 / 0 / 11；C E2E 1 passed；B1 E2E 1 passed；plugin-plan-safe 2 passed；编译产物 gate 探针 10 passed；T17-T19 定向 70 passed —— 见同名 `*-c.txt`/`*-repair` 之外的文件。

未跑：Rust host-core（本轮未改 Rust/构件/pins）、283 MB sidecar 打包（本阶段不发布）、macOS/Windows 实机（根复审的 macOS 原始报告已归档但不由本工作区重跑）。

## 5. 未做 / 不声称

- 不注册 `SubmitPlan`/`SubmitGoal`、不实现提交/审批/派发（B4-B9/B2 未动；g3 仍 open）；不开放 `plan`/`goal`
  能力或 UI；不改 Pi-only 审批派发与 Cursor 门（ADR 0306）。
- R3（Cursor exec channel 的批次零副作用）仍是既有范围外硬阻塞事实；本阶段不触碰。
- 未验证真实 OMP 在 stdout 上重放帧；未验证 macOS/Windows；未调用真实模型。
- 隐藏工具的 gate 层硬拒绝只在单元与编译产物层证明；生产层是目录夹取（如实标注，不冒充）。
- 委托快照是"所属回合的被准入记录"（进程级、随 `agent_start` 武装、终止 `agent_end`/stop/拒绝退役）；
  子代理在父回合结束后的迟到调用没有记录可用，会 fail closed（比 B1 的文件通道更严）。仍不声称能区分
  "detached 子代理的调用属于哪一代"：若父回合之后又有新提示词被准入，子代理调用会按该**新准入**裁决
  （同一桌面会话、用户显式准入的策略），本阶段将此如实记为边界。
- fence 安装准入后、`agent_start` 之前被 Stop/拒绝的窄窗口内记录保持未被武装，任何调用 fail closed；
  但"命令已送达而回执丢失"这种异常下 gate 会短暂持有一份不会被使用的准入，下一次握手整体替换它。

## 6. 证据文件

`docs/validation/M5-t20-c-execution-policy/` 下：返修前证据 `*-c.txt`（保持原样）与返修后证据
`omp-runtime-vitest-repair.txt`、`desktop-suite-repair.txt`、`c-execution-policy-e2e-repair.txt`、
`b1-fence-plugin-repair.txt`、`t17-t19-regression-repair.txt`、`build-typecheck-lint-repair.txt`、
`checks-repair.txt`；`root-review-20261003/` 逐字节保存根复审提交的 R1/R2 原始报告、脚本与总结（其自身
`SHA256SUMS.txt` 与 README 说明来源），本工作区未在 macOS 上运行它们。所有本工作区日志为对应命令原始
stdout/stderr 直接落盘（无尾部空白，未编辑字节）并追加 `EXIT=`；`SHA256SUMS.txt` 覆盖本目录全部证据
文件并附根复审子目录清单。

### 6.1 提交坐标（返修）

- 返修代码/测试提交 `34d2ffa`（父提交 `fc0fb29`，8 位缩写；完整 SHA 见 `git log`），文档/证据提交 `6d26530`；
  随后一个仅证据/坐标的提交记录完整区间 `git diff --check bff27e1..HEAD` 的结果（`EXIT=0`），本工作区未
  amend/rebase/强推。远端分支 `codex/m5-t20-c-execution-policy`。
