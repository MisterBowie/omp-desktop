# M5/T20-C：执行时权限决策与插件真实模式 —— 验证记录

更新时间：2026-10-03。状态：**T20-C 实现完成（独立复审 R1/R2 返修 + 第二次复审 R3/R4 返修后）、待根复审；T20 未完成、Plan/Goal 未实现、`plan`/`goal` 能力保持关闭。**
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



## 0.2 第二次复审返修（2026-10-03，R3 委托准入归属 / R4 证据清单）

根复审在 `4d532524` 上判 **changes-required**，只剩两条（R1/R2 已 5/5、2/2 复核通过）：R3 委托准入
归属未完成、R4 证据清单自哈希不一致。原始报告与复现脚本在
`/tmp/omp-t20-c-second-root-review-20261003/`（根机；本工作区未运行其 macOS 脚本；其要点已摘录在
本节，不假装是本工作区产物）。

**R3（登记层反例，非原生调度漏洞复现）**：根脚本 `registered-delegate-generation-review.mjs` 驱动真实
gate 的已注册回调、真实状态序列化与真实 fence/准入编解码，构造一个稳定子上下文（`hasUI=false`、自有
native 身份），在父代 A（Agent/ask）下启动它，记录 3/4：①A/ask 下子写入被 no-UI block（有效对照）；
②A 终止后迟到写入被拒（有效对照）；③**同一个旧子写入在父代 B（Agent/auto）被准入后被放行**（不通过）；
④B 下新子被放行（阳性对照）。此前 `production-delegate-turn-fc0fb298.json` 想扣住真实子代理的 provider
响应再推进父代，父回合保持非 idle，未走到代 B——该夹具**不确定**，既不是漏洞复现也不是通用隔离证明。

返修（`extensions/omp-desktop-gate.ts` `bindDelegate`；只用公开接口：生命周期事件、命令上下文
`createCommandContext().sessionManager`、公开 `ReadonlySessionManager` 的 `getSessionId`/
`getSessionFile`/`getHeader`）：

1. **委托在自身启动时绑定到那份准入**：`session_start` / `before_agent_start` / `agent_start` 中任一
   首次到达且当时存在"存活且已武装"的准入记录时，把该**记录本体**（不是 token 查询）写入以子会话 id
   为键的绑定；首次绑定生效，绝不重新指向。记录被替换（下一次 fence）或退役（终止 `agent_end`、
   启动拒绝）后，绑定过的子会话一律 `policy-unavailable`，不再借用新回合。
2. **归属文件在 fence 时捕获**：准入记录保存所属会话在命令上下文里公开的会话文件
   （`getSessionFile()`）与武装时刻。委托声明的父链（自身 header 的 `parentSession`，沿 gate 记录的
   中间委托父链上溯，链上界 32 跳）在双方都暴露文件身份时必须抵达该文件；解析到别的会话一律拒绝。
3. **延迟启动绝不"顺手"归入新回合**：子会话 header 显示其创建早于当前准入被武装时（延迟启动、
   parked/revived worker、复用旧会话文件），该会话被永久记为拒绝，既不被绑定到更新的回合，也不因后续
   更宽松的准入复活。该判定只在接口暴露可解析 header 时生效；无 header 的夹具上下文按生命周期规则绑定。
4. **退役是粘性的**：终止 `agent_end`、启动拒绝与下一次 fence 都会退役受影响的绑定并把这些会话记入
   永久拒绝集；仅在其准入退役后才被观察到的委托没有可依据的记录，fail closed。
5. **合法子代理不受损**：在当前回合内启动的子代理照旧被绑定并按其准入裁决（ask+无 UI 在审批处
   fail closed；auto/Low/grant 放行；Plan/Goal 硬拒绝与目录夹取不变）。生产 E2E 追加断言真实子会话的
   持久 header：两个真实子会话都声明 `parentSession` = 所属会话文件，且本回合的子会话创建时间晚于父代
   本回合首次 provider 请求（该请求在 fence 之后），即新鲜度判定确实接受真实子代理。
6. **不再声称摘要本身是密码学认证**：fence 回执的 SHA-256 是同一受信运行时进程内 runner 与 gate 之间的
   **应用自有一致性校验**（证明 gate 安装的正是 runner 发出的那份参数），不是对桌面端的认证/签名；
   ADR 0309 §7.1、spec 中英同步更正。

**R3 证据分层（如实）**：代数规则（旧子在 A 下被拒、A 终止后被拒、B 下仍被拒；B 下新子放行）由
`packages/omp-runtime/src/session/gate-delegate-ownership.test.ts` 经**真实注册回调 + 真实状态序列化 +
真实准入编解码**（与根复审同一控制层）固定；打包产物侧由 `omp-sidecar.test.mjs` 新增的真实 Bun 打包
gate 子进程探针固定（同一子会话在 ask→自动准入序列下三次均 block，理由分别为 no-UI 与 policy-unavailable）。
跨代**原生调度**仍未证明：扣住真实子响应推进父代的做法不可达（固定运行时把未抑制的运行中子代理保持为
`willContinue`，`agent-session.ts` `#hasPendingAsyncWake`/settle），该事实只解释那一个夹具，**不推广**
为所有延迟回调、resumed/parked worker 或生命周期边界——本阶段不做原生跨代 E2E 声称。已知保守边界：
合法 revived/parked worker 的会话文件保留原始创建时间，公开接口无法把它与"延迟启动"区分，因此其受控
调用 fail closed（ADR 0309 §7.2 记录了恢复它所需的形式化信号设计）。

**R4（证据清单）**：根 `archive-check-4d532524.json` 校验父清单全部 28 条：27 匹配、1 不匹配——
`root-review-20261003/SHA256SUMS.txt` 把自身哈希写进列表（自引用恒不匹配），父清单又内嵌同一段。
返修见 §6：子清单不再包含自身，父清单改为**单一 sha256sum 兼容列表**（相对路径含子目录前缀），
两个清单的基准目录在文档与 README 中写明；逐条以记录基准验证"文件受 Git 跟踪 + 摘要匹配"。根原始
RED/GREEN 报告与日志字节保持原样（未规范化空白）。



## 0.3 第三次复审返修（2026-10-03，R5 祖先准入）

根第三次复审（候选 `e0d03cd7`；结论 `third-review-summary-e0d03cd7.json`）确认原 4 项直接子任务代际反例
4/4、真实授权隔离/同回合文件变更/真实 PluginRuntime 子进程、B1 终态/恢复与清单 46/46 全部通过，仅剩 R5：
新加的嵌套父链实现没有把既有的"不能借用更早/更新/foreign 准入"要求落实到中间祖先。根脚本
`registered-delegate-lineage-review.mjs`（真实 gate 注册回调、真实 state/fence/准入编解码，并为 context
提供公开 `getSessionFile`/`getHeader`；不执行 provider 或工具体）7 步中 6 通过、1 失败：①childA 在父代
A（ask）下绑定并拒绝；②A 终止后 childA 拒绝；③B（auto）准入后 childA 仍拒绝；④B 下全新 childB 放行；
⑤无生命周期观察的 unknown 子拒绝；**⑥B 已准入后新创建、header `parentSession` = 已退休 childA 文件、
时间戳晚于 B 的 grandchildA 被放行**（借用了 B）；⑦B 的 childB 下新 grandchildB 阳性对照放行。源码
原因：`delegateParents` 只存 file→parent 且跨准入保留，`delegateDescendsFrom` 只要求能走到同一 owner
会话文件；A/B 属同一原生父会话，旧 childA 链因此仍能走到该文件，新后代的时间戳又通过新鲜度检查，
于是被绑定到 B。

返修（`extensions/omp-desktop-gate.ts`；仍只用公开接口，不触私有字段、不 monkeypatch、不改 pin）：
`delegateLineage` 取代 `delegateParents`——每个被观察的委托文件记录 `{parentFile, admission}`，`admission`
初值为 `null`（被观察但未归属），只在该会话**首次成功绑定**时一次性写入那份准入记录本体；已绑定会话的
后续生命周期事件绝不重写它（header 的 `parentSession` 在会话创建时固定），退役绑定保留原记录引用。
`delegateDescendsFrom` 逐跳要求 `link.admission === 正在被绑定的准入记录`（记录身份比较，不是 token）：
中间跳属于已退役/别代记录、或从未归属（延迟启动、链未解析）时，与未知中间跳一样 fail closed；时间戳
新鲜度不再是嵌套链的唯一门槛。直接子代理不受影响（其声明的父就是 owner 文件）；当前回合 child 的后代
仍可沿绑定到同一记录的本体中间跳解析；更深的合法嵌套只要每跳都指向同一记录即可。既有
`delegateBindings`/`refusedDelegates` 语义不变：绑定仍只在其自身启动时一次作出，退役后仍粘性拒绝；
未归属中间跳的新后代同样永久拒绝。

**证据层（如实）**：这是"登记回调层反例 + 同层修复"，不是原生跨代调度漏洞复现——脚本与便携化测试都不
执行 provider 或工具体；原生 held-child 夹具不能推进到代 B 的限制保持原样，本轮不重跑它、也不把它当作
"安全"结论（ADR 0309 §7.3）。便携化回归：`gate-delegate-ownership.test.ts` 新增根脚本同序的 7 步用例与
边界用例（未归属 stale 中间跳的新后代、未知中间跳、child→grandchild→great-grandchild 多跳阳性、下一
准入下重观察旧链后新后代仍拒绝、新回合直接子放行），并保留全部原有直接子任务/父链/legacy 夹具用例；
`omp-sidecar.test.mjs` 的编译产物探针扩为同样 7 步（childA 在 ask/终态/auto 三态、childB、unknown、
grandchildA 拒绝、grandchildB 允许）。**RED（仅把 gate 文件临时还原为修复前 HEAD 版本、新测试不动）：
`gate-delegate-ownership.test.ts` 2 failed / 7 passed——7 步用例在 grandchildA 处失败，边界用例在
stale 中间跳的新后代处失败（该例在修复前同样可借道）；修复后 9/9 通过、整套 31 files/471 passed/6
skipped。** RED/GREEN 原始日志见 §6。

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
- 委托（`hasUI=false`）在**其自身启动时绑定到的那份被准入记录**下裁决（见 §0.2）；绑定缺失、记录已退役
  或被替换、父链不指向所属会话文件、header 显示创建早于本准入时一律 `policy-unavailable`，绝不借用更早、
  更新或他会话的策略；不弹卡、不注入、不提权。

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
| C4 | 子代理 `hasUI=false`：合约模式 fail closed、Agent 语义不提高权限、且只依据其启动时绑定的那份准入（不借用更早/更新/他会话准入；嵌套链的每个中间祖先也必须属于同一准入记录） | gate 单元（委托快照 + plan/goal 硬拒绝 + no-UI fail closed）；**代际归属回归** `gate-delegate-ownership.test.ts`（A 下绑定→A 中拒绝→A 终止拒绝→B 下仍拒绝、B 下新子放行；session_start 单独即可绑定、不复指向、过期 header 永久拒绝、父链检查/嵌套链、无观察者 fail closed、legacy 夹具缓存不变；第三次返修新增根脚本同序 7 步嵌套链与边界：退休中间祖先的新后代拒绝、未归属 stale 中间跳的新后代拒绝、未知中间跳拒绝、多跳合法嵌套、下一准入下重观察旧链后仍拒绝、新回合直接子放行）；编译产物探针（同一子会话 ask→auto 三态 + childB/grandchildB 允许 + grandchildA 拒绝）；生产 E2E（agent+ask 子代理 write → 无 UI block、文件不存在；agent+auto 子代理 write → 恰好一次；真实子会话 header `parentSession`=所属会话文件、创建时间在父代首次 provider 请求之后） | 全绿 |
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
6/7. 子代理（`hasUI=false`，第二次返修后先经自身生命周期绑定到当前准入）：ask 下 write 被 no-UI block
   （模型收到理由、文件不存在）；auto 下同 write 恰好一次；场景 7 另断言真实子会话的持久 header——
   两个真实子会话都声明 `parentSession` = 所属会话文件，本回合子会话的创建时间晚于父代本回合首次
   provider 请求（该请求在 fence 之后），即归属链与新鲜度判定在真实运行时确有其据；
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

## 4. 验证命令与计数（第三次返修后重跑；Linux x64 / Node v24.14.0 / Bun 1.4.2）

| 命令 | 结果 | exit | 原始日志 |
| --- | --- | --- | --- |
| `node_modules/.bin/vitest run src/session/gate-delegate-ownership.test.ts`（RED：仅把 gate 文件临时还原为修复前 HEAD 版本，新测试不变） | **2 failed / 7 passed**（7 步用例在 grandchildA 处失败；边界用例在 stale 中间跳的新后代处失败） | 1 | `gate-delegate-ownership-red-repair3.txt` |
| `pnpm -C packages/omp-runtime test` | **31 files / 471 passed / 6 skipped**（第三次返修 +2 例） | 0 | `omp-runtime-vitest-repair3.txt` |
| `node --test test/omp-execution-policy-e2e.test.mjs`（C 真实 child ask/auto + 真实子会话 header） | **1 passed**（13.0s） | 0 | `c-execution-policy-e2e-repair3.txt` |
| `node --test test/omp-runtime-state-e2e.test.mjs test/omp-session-turn-fence-e2e.test.mjs test/omp-plugin-plan-safe.test.mjs`（B1 生产回归、fence-Stop 反例、真实 PluginRuntime 子进程） | **4 passed** | 0 | `b1-fence-plugin-repair3.txt` |
| `node --test test/omp-sidecar.test.mjs`（真实 Bun 打包产物；探针扩为 7 步嵌套链） | **10 passed / 0 fail** | 0 | `compiled-gate-repair3.txt` |
| `node --test test/omp-session-bridge.test.mjs test/omp-host-tool-bridge.test.mjs test/omp-subagent-bridge.test.mjs`（受影响桥接套件：grant 记账、宿主工具模式、子代理投影） | **76 passed / 0 fail** | 0 | `desktop-bridges-repair3.txt` |
| `pnpm build:js` / `pnpm typecheck` / `pnpm lint` | 全绿 | 0 / 0 / 0 | `build-typecheck-lint-repair3.txt` |
| 证据清单自校验（§6） | 子清单排除自身、父清单单一列表；逐条 sha256 匹配 + 全部受 Git 跟踪 | 0 | `manifest-verify-repair3.txt` |

历史（第二次返修后，`e0d03cd7`，保留不改）：omp-runtime 31 files / 469 passed / 6 skipped；desktop 全量 2984 / 2973 / 0 / 11；C E2E 1 passed；B1+plugin 4 passed；sidecar 10 passed；build/typecheck/lint 全绿；清单 46/46 —— 见 `*-repair2.txt`（本节旧表）。
历史（R1/R2 返修后，`4d532524`，保留不改）：omp-runtime 30 files / 460 passed / 6 skipped；desktop 2984 / 2973 / 0 / 11；C E2E 1 passed；B1+plugin 4 passed；T17-T19 定向 122 passed；build/typecheck/lint 全绿 —— 见 `*-repair.txt`。
更早（首稿 `fc0fb298`）：omp-runtime 27 files / 437 passed；desktop 2983 / 2972 / 0 / 11；C E2E 1 passed；编译产物 gate 探针 10 passed —— 见 `*-c.txt`。

未跑：Rust host-core（本轮未改 Rust/构件/pins）、283 MB sidecar 打包（本阶段不发布）、macOS/Windows 实机（根复审的 macOS 原始报告已归档但不由本工作区重跑）。

## 5. 未做 / 不声称

- 不注册 `SubmitPlan`/`SubmitGoal`、不实现提交/审批/派发（B4-B9/B2 未动；g3 仍 open）；不开放 `plan`/`goal`
  能力或 UI；不改 Pi-only 审批派发与 Cursor 门（ADR 0306）。
- R3（Cursor exec channel 的批次零副作用）仍是既有范围外硬阻塞事实；本阶段不触碰。
- 未验证真实 OMP 在 stdout 上重放帧；未验证 macOS/Windows；未调用真实模型。
- 隐藏工具的 gate 层硬拒绝只在单元与编译产物层证明；生产层是目录夹取（如实标注，不冒充）。
- **委托归属**：委托只在其自身启动时绑定到的那份准入下裁决（进程级记录、随 fence 安装、`agent_start`
  武装、终止 `agent_end`/stop/拒绝退役）；未观察到启动、绑定已被退役/替换、父链不达所属会话文件、
  header 显示创建早于本准入，或**嵌套链的任一中间祖先不属于正在被主张的那份准入记录本体**（已退役/
  别代/从未归属）的委托一律 fail closed（第三次返修补齐；该要求不缩小任何 §7 已放行的正例，只拒绝
  祖先可证明属于别代的后代）。**不声称**能区分合法 revived/parked worker 与延迟启动——公开接口对两者
  给出相同的旧 header，因此两者在受控调用上一律拒绝（恢复它需要的形式化生成信号见 ADR 0309 §7.2）。
  **不声称**原生跨代调度不可达：根复审早先扣住真实子响应的夹具因父回合保持非 idle 而未走到代 B，
  那只是该夹具的事实（固定运行时把未抑制的运行中子代理保持为 `willContinue`），不作为所有延迟回调/
  parked worker/生命周期边界的证明；本阶段不做原生跨代 E2E 声称，R5 同样是登记回调层反例与同层修复
  （脚本与便携化测试都不执行 provider/工具体，ADR 0309 §7.3）。
- fence 回执的 SHA-256 是同一受信运行时进程内 runner 与 gate 之间的应用自有一致性校验，**不是**对桌面端
  的密码学认证，也不如此声称（ADR 0309 §7.1、spec 中英同步）。
- fence 安装准入后、`agent_start` 之前被 Stop/拒绝的窄窗口内记录保持未被武装，任何调用 fail closed；
  但"命令已送达而回执丢失"这种异常下 gate 会短暂持有一份不会被使用的准入，下一次握手整体替换它。

## 6. 证据文件

`docs/validation/M5-t20-c-execution-policy/` 下：首稿证据 `*-c.txt`、R1/R2 返修证据 `*-repair.txt`、
第二次返修证据 `*-repair2.txt`、第三次返修证据 `*-repair3.txt`（`gate-delegate-ownership-red-repair3.txt`、
`omp-runtime-vitest-repair3.txt`、`c-execution-policy-e2e-repair3.txt`、`b1-fence-plugin-repair3.txt`、
`compiled-gate-repair3.txt`、`desktop-bridges-repair3.txt`、`build-typecheck-lint-repair3.txt`、
`checks-repair3.txt`、`manifest-verify-repair3.txt`）；
`root-review-20261003/` 逐字节保存根复审提交的 R1/R2 原始报告、脚本与总结（本工作区未在 macOS 上运行它们）。
所有本工作区日志为对应命令原始 stdout/stderr 直接落盘（未编辑字节）并追加 `EXIT=`；RED 日志带一小段
过程前言（说明临时还原修复前 gate 版本、两边摘要），测试输出本身未编辑。

**清单基准（R4/R5 返修）**：

- 子清单 `root-review-20261003/SHA256SUMS.txt` 以**该子目录**为基准（`cd` 进去即可
  `sha256sum -c SHA256SUMS.txt`），只列本目录中除自身以外的 11 个文件——自引用条目已移除，根复审先前
  观察到的"自身哈希不匹配"即由此消失（本次未变，逐字节相同）。
- 父清单 `SHA256SUMS.txt` 是**单一 sha256sum 兼容列表**（无 `---` 分节、无内嵌同名段），以
  **本证据目录**为基准，用显式相对路径（含 `root-review-20261003/…` 前缀）收录 44 个文件：本目录
  全部文件（除父清单自身与 `manifest-verify-repair3.txt` 这份校验日志——清单无法收录自身哈希）以及
  子目录全部 12 个文件（含子清单自身，其摘要稳定是因为子清单不再自引用；第二次返修的校验日志
  `manifest-verify-repair2.txt` 已固定为普通文件，现被收录）。
- 逐条独立校验（原始输出见 `manifest-verify-repair3.txt`）：两个基准下 `sha256sum -c` 全部 OK；
  所列文件全部受 Git 跟踪（按各自基准目录解析路径）；父清单条目集合与磁盘文件集合**逐一相等**；
  根复审原始报告/脚本与其归档提交 `6d26530` 的 Git blob 逐位相同（未规范化空白）。

### 6.1 提交坐标（第三次返修）

- 代码/测试提交 `30ff735a0ebde879ebb7dac6651119d6f3685c56`：gate 的 `delegateLineage` 逐跳准入身份与
  `delegateDescendsFrom` 的同记录比较、`gate-delegate-ownership.test.ts` 新增 7 步与边界用例、
  `omp-sidecar.test.mjs` 的 7 步编译产物探针。
- 文档/证据提交 `35836b59ce96afe0c606ae0f8c177392e8d01792`：ADR 0309 §7.3、spec 中英的祖先准入规则、
  本记录（§0.3/§2 C4/§4/§5）、`docs/04-task-board.md`、`HANDOFF.md` 与 `*-repair3.txt` 原始日志
  （含 RED 与 `checks-repair3.txt`）。
- 随后的清单/坐标提交（见 `git log`）把子清单（11 条，未变）、父清单（44 条）与
  `manifest-verify-repair3.txt` 固定在上述字节之上（生成顺序：先写完整日志 → 再生成清单 → 最后生成
  校验日志），并把本节坐标写实。
- 完整区间 `git diff --check bff27e1..30ff735` 与 `bff27e1..35836b5` 均 `EXIT=0`（原始输出在
  `checks-repair3.txt` 尾部）。本工作区只追加提交，不 amend/rebase/强推；远端分支
  `codex/m5-t20-c-execution-policy`。

### 6.2 提交坐标（第二次返修）

- 代码/测试提交 `feb4e111afa7a1c1e737ad057e4c469a8a429c20`：gate 的 `bindDelegate` 与公开上下文事实
  （`SessionManagerFacts`/`DelegateLifecycleContext`）、`gate-handler-testkit.ts` 的委托事实与 `lifecycle`
  驱动、新增 `gate-delegate-ownership.test.ts`（7 例）、`gate-admission.test.ts`/`gate-permissions.test.ts`/
  `gate-review-matrix.test.ts`/`gate.test.ts` 的代际语义更新、C E2E 的真实子会话 header 归属/新鲜度断言、
  `omp-sidecar.test.mjs` 的打包产物代际探针、`check-omp-plan-goal-gaps.mjs` 的 g2 证据清单。
- 文档/证据提交 `ce419ec82fcd757473975bb33f10ad0ce2ae0588`：ADR 0309 §7（含 §7.1 摘要定位与 §7.2 已知
  限制）、spec 中英（§14/§11 的委托规则与摘要定位）、本记录（§0.2/§2 C4/§3/§4/§5/§6）、`docs/04-task-board.md`、
  `HANDOFF.md` 与 `*-repair2.txt` 原始日志。
- 随后的清单/坐标提交（见 `git log`）把子清单（11 条）、父清单（35 条）与 `manifest-verify-repair2.txt`
  固定在上述字节之上（生成顺序：先写完整日志 → 再生成清单 → 最后生成校验日志），并把本节坐标写实。
- 完整区间 `git diff --check bff27e1..feb4e11` 与 `bff27e1..ce419ec` 均 `EXIT=0`（原始输出在
  `checks-repair2.txt` 尾部）。本工作区只追加提交，不 amend/rebase/强推；远端分支
  `codex/m5-t20-c-execution-policy`。
