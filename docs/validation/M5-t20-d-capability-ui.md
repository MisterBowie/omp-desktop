# M5/T20-D：能力键、真实桌面闭环与完整矩阵

更新时间：2026-10-03。状态：**首稿 `8a1dd8fc` 的 R1–R4 已由根独立复验闭合；根随后判
changes-required（R5：一次提交的用户气泡渲染两次；R6：重启后会话面板看不到已产生的历史）；
第二轮定向返修（§1.6）后根再以真实 macOS arm64 原生运行时故障注入与受控边界探针判
changes-required（R7–R10）；第三轮定向返修（§1.7）后根再判 changes-required（R11：完整
无换行末行被丢弃；R12：损坏/半写记录被伪装成成功历史），第四轮定向返修（§1.8）完成、本机
验证通过、待根复审**。证据：首稿与第一轮返修见 `docs/validation/M5-t20-d-capability-ui/`
（`repair-20261003/`），第二轮见 `repair2-20261003/`，第三轮见 `repair3-20261003/`，第四轮见
`repair4-20261003/`。分支 `codex/m5-t20-d-capability-ui`
（普通追加提交，不 amend/rebase/强推，不发布、不合 main、不建 PR），本返修基于
`e33bc98c1e16500ad9f1b9b068fb1ceb9a70600c`（根复审判 changes-required 的候选），首个基线
`68519ea19f6fee37fec2c5817256f3a68ea8606e`。固定子模块 OMP `62bc57be`、PI `0111e306`
（未动）；补丁级保持 `62bc57b+omp-desktop.5`（fork commit
`36483311dfff67be7504f591974df93fc512a45a`，本阶段不改 fork、不改 patch）。

本阶段在用户授权范围内交付矩阵 **B9**（能力声明与入口）、**D3**（真实用户路径）、
**D1**（Goal 闭环）与 **B13/B2** 的生命周期回归，并给出 B1–B14 / C1–C8 / D1–D3 共 25 行的
逐行证据映射。Cursor + Plan/Goal 排除与 ADR 0306 门全部保留；非 Cursor 严格契约不变。
D2（`goal_updated` 只读展示）按矩阵为可选，本阶段未实现，不伪造 Goal 状态。

## 1. 交付

### 1.1 B9：`plan`/`goal` 能力键与三个边界（ADR 0312）

- `packages/shared/src/engine.ts`：`EngineCapability` 与 `ENGINE_CAPABILITY_KEYS` 新增
  `plan`/`goal`；`PI_ENGINE_CAPABILITIES` 与 `OMP_ENGINE_CAPABILITIES` 均声明开放
  （OMP 的理由与证据写入注释：B1/C/B2/D-Enter 的契约整体已存在）。新增
  `contractModeCapability(mode)`、`engineSupportsContractMode(engine, mode)`、
  `engineCapabilityError(refusal)`；`ENGINE_CAPABILITY_KEYS` 与 `PROPOSAL_KINDS`
  的一致性由 `engine.test.ts` 断言，防止新增契约模式绕过能力声明。
- `engine-router.ts`：`EngineRouter` 新增 `requireContractMode(engine, mode)`（判定
  **声明**，不判定进程阶段；Agent/非契约值不设门），并允许注入声明表以便测试覆盖
  "已声明关闭"分支。
- Main 三个边界（仅隐藏按钮不算边界）：`session-ipc` 的 `sessionCreate`（创建模式）与
  `sessionConfigure`（写入前，合并后的持久模式）都先过 `requireContractMode`，未通过即抛
  共享类型化拒绝（`ENGINE_CAPABILITY_UNAVAILABLE` + engine + capability），不发生任何
  host/runtime 写入；`agent-ipc` 的 `agentPrompt` 在 `require("prompt")` 之后核对**持久
  会话行的模式**（导入/陈旧记录同样被拒）。
- 渲染层：`offeredModes(engine)` 由同一张表派生 composer 模式循环
  （`Composer.tsx` 传入 `ComposerToolbar`）；不支持的模式不出现在循环里，只剩当前模式时
  按钮禁用，无可用模式时不渲染该控件；`nextMode(mode, cycle)` 支持受限循环。Pi 行为零变化
  （两个引擎都声明三模式，循环与既有一致）。

### 1.2 D3：真实 Electron 用户路径（新脚本 `app/scripts/e2e-omp-plan-ui.mjs`）

实际链路：**真实 Electron Renderer → preload/Main IPC → 真实 host-core（SQLite/WAL）→
生产 bridge/gate → 固定 patched 运行时装（`OMP_DESKTOP_RUNTIME`，绝不使用全局 `omp`）+
本地 FakeProvider**。无付费/远程模型；隔离 data/user-data/workspace/artifacts；
结束时回收 Electron 进程树与 scratch（失败也不留进程）。

流程与断言（一次运行，`docs/validation/M5-t20-d-capability-ui/omp-plan-ui-run.txt`）：

1. 经真实 preload 创建本地 provider 与 **`engine:"omp"`** 会话，`reload` 后在真实侧边栏
   选中；模式 chip 可见、初始 Agent、未禁用。
2. 点击真实 **mode chip** 切 Plan：UI `data-mode="plan"`、preload `session.get` 与
   SQLite `sessions.mode` 三处一致。
3. 在真实 composer 输入并以真实 send 发送；模型（FakeProvider）经**真实 `SubmitPlan`
   宿主工具**提交；真实 `PlanApprovalBar` 变为 `pending`，卡片标题与 durable proposal 的
   question/markdown 来自模型；`.pi/plan/<slug>.md` 工件按 durable sha256/size 校验；
   该回合的 provider 请求含 Plan mode block 与 `SubmitPlan` 工具（无 Write/Edit）。
4. 真实 Reject → composer 恢复可编辑、**渲染层收到 `agent_end`（终止事件回归断言）**、
   停止按钮消失、Main `agentGetStatus.isRunning=false`；修改后重提得到**新 proposal 与新
   工件**，第一份工件字节不变、第一行 `rejected`；期间新建的无关会话不继承审批卡，
   返回本会话后卡片恢复（审批状态不串会话）。
5. 以 **ask** 批准 → 真实 `PermissionCard`（"Allow write to run?"）出现 → Allow once →
   `marker-one.txt` 真实写入 → execution 行 `completed`、无遗留 running。
6. 第二轮 Plan → 以 **accept-edits** 批准 → `marker-two.txt` 写入且**无**权限卡 →
   execution 行 `completed`。
7. 第四份 proposal 保持 pending，**真实重启应用**（终止 Electron 进程树后以同一数据目录
   重新启动）：pending 行变 `interrupted`/`PLAN_APPROVAL_INTERRUPTED`，UI 不再提供批准；
   已完成的 execution 仍为 `completed`；重启前后 provider 请求数不变（**不重放**）。
   8 个关键截图见 `omp-plan-ui-artifacts/omp-plan-ui-01..08-*.png`。

本机运行命令与结果见 §2；真实 native session 身份、工件路径、执行行 id 与请求数记录在
`omp-plan-ui-run.txt`。

### 1.3 D1/B13：Goal 闭环与模式/目录生命周期（真实 runtime + 真实 Host）

在 `apps/desktop/test/omp-plan-submit-e2e.test.mjs` 追加两个真实 E2E（沿用该文件既有的
patched 运行时、真实 host-core、生产 bridge/gate 夹具）：

- **D1 Goal**：`SubmitGoal` 经真实 `plans.submit` 发布 `.pi/goal/<slug>.md`，字节/大小/
  sha256 与 durable 行一致；goal 回合的 system prompt 携带 PI Goal block（含验收标准
  措辞）且无 Plan block，工具表只有 `SubmitGoal`（无 Write/Edit，谈判阶段只读）；approve
  原子翻转 `mode=agent` 后以普通 Agent 回合执行（真实 Write 落盘），最终文本自停：
  提交 1 次 + 执行 2 次 provider 请求后再无第 4 次（**无交互式 Goal 延续定时器**），
  两行 durable turn 均 `completed`。
- **B13 生命周期**：同一 native session 上 `session.configure` 依次写
  Agent→Plan→Goal→Agent→Plan，五个真实回合断言：agent catalog 有 Enter 工具与
  write/edit、无 Submit*；Plan/Goal catalog 有对应 Submit 工具、无 write/edit/task/Enter；
  回到 Agent 后目录与首个 Agent 回合**完全一致**，再次 Plan 与首个 Plan 回合**完全一致**
  （无残留、无重复名字）；每个回合恰一个 system 消息、恰一个 mode block 且与
  `composeModeSystemPrompt(mode, "")` **逐字节相等**、PI 默认 base 不出现、base 非空且
  mode block 纯追加。

### 1.4 本阶段发现并修复的产品缺陷：OMP 终止事件被 Pi 所有权过滤器丢弃

**现象（原始 RED，见 §2）**：真实 UI 中计划提交回合结束后，渲染层永远停留在
"Processing/Planning"：`agent_end` 从未送达。因此 Reject 后的重提被当作"运行中"排队
（`sendPrompt` → `enqueuePrompt`），队列又等不到终止事件，用户无法完成 D3 的
"reject 后修改重提"。证据：UI harness 的渲染层事件记录器只看到
`… turn_end` 而没有 `agent_end`，且 M2 重提在 240s 内没有任何 provider 请求。

**根因**：`sidecar.ts` 的 `emitAgentEvent` 对终止事件施加 Pi 回合所有权过滤
（`isStaleTerminalEvent` ↔ `activeTurns`，只装 Pi 回合）。OMP 会话没有 Pi 条目，其
live 回合 id（`omp-turn:*`）也不可能等于 durable Pi 回合 id，于是 OMP 的
`agent_end`/`error` **全部**被判定为陈旧并丢弃。OMP bridge 的 runner 本身已按代际
守卫（只为 live generation 发事件、迟到帧在 runner 内丢弃），该 Pi 过滤器对 OMP 既多余
又有害。

**修复**：抽出 `runtime/agent-event-fanout.ts`（`createAgentEventFanout`），
`guardPiTurnOwnership` 默认开启；`index.ts` 的 `wireOmpSessions` 以
`{ guardPiTurnOwnership: false }` 扇出，Pi 路径语义不变（陈旧 Pi 终止与 delegate 终止仍
被丢弃）。ADR 0312 记录该边界与适用条件。

**GREEN**：`omp-terminal-delivery.test.mjs`（用真实 coordination 的过滤器）证明 OMP 终止
在默认门下被丢弃、在关闭门下送达、Pi 陈旧/delegate 终止仍被丢弃、非终止事件不受影响；
`main-wiring-contract.test.mjs` 断言组合根确实以关闭门接线；D3 UI E2E 现在断言渲染层收到
`agent_end`、停止按钮消失、重提经真实 composer 送达并产生新工件。

### 1.5 定向返修（2026-10-03，R1–R4）

根在 `8a1dd8fc` 判 changes-required：R1 缺 auto 批准与"已批准执行中"的应用/Host 重启；
R2 测试子进程未隔离 HOME、回收失败只静默超时；R3 唯一产物是 PNG、无原始请求/身份/DB/清理
证据，且摘要把 proposal id 当 accept-edits 的 execution id 打印；R4 现行 spec 与矩阵仍写
"T20-D 未开始/能力关闭"、把已接受的 C 写成待复审。返修只改测试 harness（
`app/scripts/e2e-omp-plan-ui.mjs`）与文档，**未改产品代码、gate、fork、补丁或固定子模块**。

**R1 完整真实 UI 路径（三种批准权限 + running 重启）**。就在既有流程上补齐：

- **auto**：第三轮经真实审批菜单选 `auto` 批准；执行回合跑两条 high-risk `bash`（`accept-edits`
  只覆盖 write/edit、`ask` 会弹卡），全程无权限卡、两条副作用都真实落盘；durable 行
  `target_permission_mode=auto`、会话行 `mode=agent`/`permission_mode=auto`，execution
  `completed`（`scenarios.auto`；权限模式与执行行见下表）。
- **running 执行中的应用/Host 重启**：第四轮批准后，第一步 `bash` 追加 `held-run` 到副作用
  文件，第二步 `/bin/sleep 600`（绝对路径强制真实外部进程；固定运行时的 brush-core 会把裸
  `sleep` 当内建，不产生子进程）把执行保持在确定状态；断言持久 `execution_state=running`、
  durable turn 行 `running`、真实运行身份（OMP runtime 独立进程组 + `/bin/sleep` 子进程的
  PID/PGID），再终止旧应用及其拥有的全部进程并**核对退出**，最后以同一数据目录重启：execution
  → `interrupted`/`PLAN_EXECUTION_INTERRUPTED`、turn → `aborted`、audit
  `plan_execution_interrupted`、provider 请求数不变（16，零重放）、副作用文件仍只有一行、UI
  无待决审批；随后一个真实 Agent 回合完成（恰好 +1 provider 请求）证明 UI 恢复可用
  （`scenarios.runningHold`/`runningRestart`）。pending 重启一仍保留（第四份 pending →
  `interrupted`/`PLAN_APPROVAL_INTERRUPTED`、completed 不重放）。

本轮 UI E2E 关键身份（`repair-20261003/omp-plan-ui-raw.json`，全部来自真实 API/DB/进程表）：

| 项 | 值 |
| --- | --- |
| session / native | `d4ef1a60-617e-473f-b9cb-8161203c1d64` / `01a10019-c350-7153-accf-c961227a90e0`（runtime 18.3.0，host 侧 `native_session_path` 在 data 目录内） |
| ask execution | `9e655938-6130-4cb3-a25a-109381e01775`（write 真卡 + Allow once） |
| accept-edits execution | `eb86767b-6a65-493c-acc2-80364d6db226`（无卡落盘） |
| auto execution | `d754330e-5af2-4e3c-a5d0-05272d301a9a`（两条 bash 无卡） |
| held execution / turn | `1b9905ce-f8cc-4b80-87d6-e10abeb1afe8` / `df5327f5-f1fc-42d6-bbcf-c63a80862d15`（重启前 running → 重启后 interrupted/aborted） |
| held 进程身份 | OMP runtime pid 2074418（pgid 2074418，独立组，cmdline 含 patched 树与 config overlay）/ `/bin/sleep` pid 2074520（pgid 2074520） |
| provider 请求 | 16（重启前后不变；恢复回合恰 +1） |
| 清理 | 三次回收（running-restart/pending-restart/final）`ok=true`、`electronExited=true`、stages 仅 `SIGTERM`、leftover 0；scratch 已删除、无幸存自有进程 |

**R2 HOME 隔离与回收证明**。子进程环境从零构造（`HOME`、`XDG_CONFIG/DATA/STATE/CACHE_HOME`、
`TMPDIR` 全在本次 scratch 内），只透传 DISPLAY/XAUTHORITY 与绝对 Node/Bun/系统 PATH；产品运行
时把继承 HOME 的 `~/.bun/bin` 放在子 PATH 首位，故在专属 HOME 内以符号链接指向绝对 bun/node
（不写用户 HOME、不复制任何用户配置/技能/凭据）。每次重启与最终清理都记录 Electron/Main、
host-core、OMP runtime 及其工具子进程的 PID/PPID/PGID/starttime/cmdline，并按身份（pid +
starttime，防 PID 复用）确认退出；宽限后升级 SIGTERM→SIGKILL 只作用于**这些自有进程组**；
仍存活即判失败、保留 scratch 并非零退出（本轮从头全绿）。不以宽泛进程名杀用户其它实例。

**R3 原始证据与准确身份**。`repair-20261003/omp-plan-ui-raw.json` 保存：runtime provenance
（manifest base/fork/patch sha/大小、launcher sha、隔离 HOME 下 `omp --version` 探针 `omp/18.3.0`）、
专属环境与工具链链接、全部 16 条 fixture provider 请求、逐步 UI 快照、真实 session/native/
live/durable/proposal/execution id、只读 SQLite（sessions/plan_approvals/turns/audit_log）快照、
工件与截图的路径/字节/大小/sha256、进程与回收报告、最终清理结论；凭据形状字段统一 redact。
摘要行已改为打印真实 execution id（原缺陷：把 proposal id 当 accept-edits execution id）。
**证据分层**：renderer（截图/DOM 快照/`uiAgentEvents` 中 `omp-turn:…` live id）、Host/runtime
（SQLite 行、audit、进程表）、受控 handler（FakeProvider 请求、session/native 行）、历史接受证据
（B1/C/B2/D-Enter 原始报告）分别标注，不互相冒充。重启恢复的准确陈述：**执行不重放、副作用不
重复、UI 可用**由上述断言证明；native 转录完整（恢复回合的 provider 请求携带 M1–M6/EXEC1–4 全部
历史、38 条消息）；同时如实记录该时点渲染层会话面板只显示重启后的回合
（`scenarios.runningRestart.recovery.ui`），**不以刚启动的空界面推断历史丢失**——转录面板的
恢复渲染不在本阶段验收范围。

**R4 现行状态同步**。`app/docs/spec/03-runtime/02-agent-runtime.md`（英）与
`app/docs/zh-CN/spec/03-runtime/02-agent-runtime.md`（中）的用户路径与 §16 Cursor 段改为当前
事实：`plan`/`goal` 能力已声明开放（ADR 0312），能力**声明**与运行时**阶段**是两个轴；旧
"T20-B/C/D 未开始"改为带日期的历史表述并新增 2026-10-03 状态说明；
`docs/validation/M5-plan-goal-capability-gates.md` 状态说明 3 改为"C/B2/D-Enter 已验收、
D 首稿判 changes-required、定向返修完成待复审"。带日期的历史记录与原失败证据保留。

### 1.6 第二轮定向返修（2026-10-03，R5/R6）

根在 `2093f271` 独立复跑真实 Linux UI 后确认 R1–R4 闭合，同时以 `scenarios.runningRestart.
recovery.ui.bodyText` 与截图 `omp-plan-ui-10-running-recovered.png` 指出两个未被既有断言覆盖的
产品缺陷，并说明旧 M4 persistence E2E 只向恢复 bridge 继续 prompt、没有真实 Renderer 历史断言。
本轮只修这两个缺口及其测试/证据，产品代码集中在 OMP 适配层与必需的会话读取路径；不接通 Cursor、
不扩大任何关闭能力、不改 fork/补丁/固定子模块、不改 main。

**R5：一次提交的用户气泡渲染两次。** 起因是身份分裂：`agent-ipc` 的 OMP 分支用 `req.messageId`
自行发 `message_start`/`message_end` 回显，而 `OmpEventConverter` 又为运行时的 user frame 另铸
一个 id，渲染层按 id 合并自然无法关联。修复沿用 PI 的共享协议而不是新造协议：渲染层乐观行 id 经
`userMessageId` 随 prompt 进入 bridge/runner（只接受 UUID，与桌面宿主同一条规则），转换器把它绑定
到随后第一帧 user frame 并报成 `user_message_persisted`（乐观行原地换键），Main 不再自行回显；
绑定一次性、随 run 关闭丢弃，后续 prompt 绝不会被换键到旧行。同文本两次提交仍按 id 各行其是
（不做任何按内容/时间的去重）。

**R6：重启后桌面历史不可见。** OMP 正确遵守"唯一原生 transcript 写者"，`sessionGet` 却只读宿主
`messages`，因此重启后面板只剩新回合。修复新增只读历史投影（ADR 0313）：`get_entries`（runtime
自身文档为宽松客户端背书的 `id`/`parentId` + message 结构子集）→ 从 `leafId` 沿 `parentId` 走活动
分支 → 用同一个转换器投影成 `omp:<session>:entry:<entryId>` 行（工具行在其 `toolCallId` 于分支内
唯一时用它作行 id，与实时工具行同键），窗口照抄原生读取器的 `messageLimit`/`messageBefore`/
`messageAround`/`contentLimit` 语义。运行时来源二选一：已有存活运行时就用它（转录属主进程，绝不让
第二个进程碰同一文件）；否则用**只读配置**启动一个瞬时 supervisor——投影会话的模型身份但**不带
凭据**（`auth: none`；提供商行不可投影时用回环占位项）、不传 `--model`、不写 run 级状态，读完后
先 `new_session` 离开该转录再回收（否则运行时会在被读的转录里追加 `session_exit`）。因此读取不需要
可用凭据、不发出 provider 请求、不执行工具、不改写原生文件；缺失/属于他者/只写一半/版本不符的引用、
畸形 entry、不可达运行时、回收失败一律 fail-closed，只有"尚无原生引用"才是空页。

**实时/持久合并的身份归属。** 运行时实时帧不带 entry id，所以流式行与其持久孪生不可能同 id。
bridge 因此维护一份精确的、单一写者的实时行台账（渲染层的行就来自同一批 envelope，包含已受理
prompt 的乐观行），按各自终止事件结算（自身终止缺失时由该 run 的 `agent_end`/`error` 结算）；
**尾部**读取返回 `replacedLiveMessageIds`（窗口内确有其持久孪生的已结算行，窗口自动加宽覆盖它们），
渲染层在合并前精确丢弃这些行——绝不比较文本或时间；在飞行行、较旧页与居中读取都不点名。
`SessionDetail.replacedLiveMessageIds` 为可选字段，Pi 原生/桌面会话从不设置。

**本轮真实 UI 证据（`repair2-20261003/omp-plan-ui-run.txt` + `omp-plan-ui-raw.json`，18 条 provider 请求、13 张截图）**：

| 断言 | 证据 |
| --- | --- |
| running 重启后、发新 prompt 前看到历史 | `scenarios.history.beforeHeldRestart` 9 条 user 行 → `afterHeldRestart` 9 条，overlap 9；`afterHeldRestartRoles` = 9 assistant turn / 14 assistant 消息 / 11 tool 行 / 9 process 组；全部行 id 为 `omp:<session>:entry:<id>`（无 live 行） |
| 每个输入恰一个气泡 | 重启前后、恢复回合后、两次重启之间均无重复文本行（每次捕获都由 `assertTranscriptStable` 校验） |
| 同文本两次提交都保留且 id 不同 | 提交两次 `E2E-SAME-TEXT-TWICE`：live 行 `…:<ctx>:1` 与 `…:<ctx>:3`（2 条、id 不同；provider 16→18 恰 +2）；重选后合并为 `…:entry:b44e5f94` 与 `…:entry:ece26759`（仍 2 条，未变 4 条、未被吞并）；第二次重选后 entry id 不变 |
| 持久与实时合并不重复/不消失 | 重选后无重复行、无 durable id 变化（live→entry 属预期换键）；`scenarios.historyRows` 记录两次捕获的完整行集 |
| 读取/重选不改原生字节 | `nativeTranscriptAfterPendingRestart.sha256` == `nativeTranscriptAfterReselect.sha256`（`3add7787…`） |
| 重启不增请求、恢复后新 prompt 才增 | held 重启 14→14；恢复回合 +1（15）；pending 重启 16→16；两次同文本提交 +2（18） |
| 清理 | `scratchRemoved=true survivingOwnedProcesses=0 errors=0`（三次重启回收 + 最终回收） |

**本轮新增/修改的测试与证据**（`repair2-20261003/`）：

| 层 | 文件 | 断言要点 |
|---|---|---|
| 共享事件 + 渲染层 reducer（可执行 RED/GREEN 回归） | `r5-r6-regression.mjs` + `r5-r6-regression-baseline-2093f271.json` / `r5-r6-regression-fixed.json` | 同一脚本对两棵树：基线 `2093f271` 下 R5 = 一次提交渲染 **2** 行（渲染层 id + 转换器铸的 `omp:session-omp:1`）、R6 = OMP `sessionGet` 返回 **0** 条消息；修复后 R5 = **1** 行、R6 = 2 条 entry 行且宿主行元数据保留 |
| 转换器 | `packages/omp-runtime/src/session/events.test.ts`（+3） | 绑定后 user frame 报 `user_message_persisted`（带乐观 id）且 `message_end` 复用同一行 id；绑定只消费一次；无绑定/已丢弃绑定时行为不变 |
| 历史投影 | `packages/omp-runtime/src/session/history.test.ts`（新，10 例） | 活动分支/顺序/entry id 稳定；工具行 `toolCallId` vs 重复时回退 entry id；窗口/居中/内容上限；畸形/重复 id/未知父/环/leaf 缺失全部抛错；空列表才是空 |
| bridge 读取 | `apps/desktop/test/omp-history-read.test.mjs`（新，8 例） | 冷读只用只读配置、命令序 `switch_session→get_state→get_entries→new_session`、stop/reclaim；无原生引用不启动任何进程；引用/版本/身份/`get_entries` 失败 fail-closed；回收失败判失败；存活运行时被复用；`replacedLiveMessageIds` 只含已结算行、在飞行行不入列、旧页不点名 |
| 真实 runtime 读取 | `apps/desktop/test/omp-history-e2e.test.mjs`（新，1 例，真固定运行时+FakeProvider） | 冷读拿到 user/assistant/tool 行与真实入口 id；重复读 id 稳定；分页窗口；**字节纯度**（读取前后与回收后 transcript sha/文件集不变）；provider 请求数不变；无凭据（`hasSecret:false`）仍可读；外来/缺失引用被拒且不触碰文件 |
| sessionGet/renderer 边界 | `apps/desktop/test/engine-session-ipc.test.mjs`（+5）、`session-transcript.test.mjs`（+3）、`session-switch-performance/transcript-style/transcript-reading/composer-send-state`（随契约同步） | OMP 会话的 `sessionGet`/`sessionOpen` 用原生投影覆盖宿主空 messages 且保留元数据、窗口与 `replacedLiveMessageIds` 透传；读取失败上抛；Pi 会话不触发原生读取；合并只按 `replacedLiveMessageIds` 丢弃（在飞行行保留）、两条同文本仍是两行 |
| 桌面只读投影 | `apps/desktop/test/omp-model-projection.test.mjs`（+2） | 读配置保留模型身份、`auth:"none"`、无 `apiKey`；`hasSecret:false` 输出相同（从不读密钥）；不可投影/无提供商行→回环占位项 |
| 真实 UI E2E | `apps/scripts/e2e-omp-plan-ui.mjs`（+断言） | 重启后、发新 prompt 前：面板显示重启前的 user 行（同 id、同文本、各恰一次）与 assistant/tool 历史；恢复 prompt 只渲染一个气泡；重新选中（经另一个会话往返）后行 id/文本不变、原生 transcript sha 不变；两段逐字节相同的提交都保留且 id 不同、provider 恰好 +2；重启本身 provider 不增、无重放（既有断言保留） |

### 1.7 第三轮定向返修（2026-10-03，R7–R10）

根在 `b6a9e4c2` 上用**真实 macOS arm64 编译的 `.5` 原生运行时 + 生产 bridge + 真实 writer 的
故障注入**（`/tmp/omp-t20-d-ui-repair3-root-20261003/…/history-failure-native-mac.json`）与
**注册后 IPC handler + 受控 host/runtime 接缝的边界探针**（`history-boundary.json`）判定四组
缺陷；两组证据都是已执行的真实失败，不是草稿猜测。本轮不改 fork/补丁/gate/host-core，产品改动
集中在历史读取路径与其 IPC 边界。

**R7（P1）：失败的历史浏览改写被浏览的原生文件。** 第二轮的非存活会话读取会先启动一个瞬时
runtime、`switch_session` 绑到目标转录；成功路径靠 `new_session` 先离开再回收，但
`get_entries` 拒绝、`get_state` 身份不符会跳过切离，`new_session` 返回 `success:false` 或被取消
也没有检查（抛错仅 warn），随后 graceful stop 在仍持有会话时向被浏览文件追加
`customType:session_exit`（根实测四种失败路径各 **+207 B**，detach 取消/超时两项还错误地返回了
成功历史）。修复不是补 detach 顺序，而是**删除瞬时 runtime 读取路径**：无存活运行时会话改由
进程内直读器 `readNativeSessionEntries` 读取（`packages/omp-runtime/src/session/native-session-file.ts`）
——没有写者、没有锁、没有子进程，因此"失败时改写文件"在结构上不可能；成功/异常/取消/超时/
无凭据语义统一由"我们从不打开写句柄"取代（"取消/超时"作为运行时行为随之消失，同类失败现在
表现为文件级/格式级拒绝且不改字节，见证据）。

**R8（P1）：临时 reader 不属于 bridge 生命周期。** 同一路径的 reader 未登记进 `entries`；
production supervisor 在 `stop.reaped=false` 时仍持有 runtime/ownership（`pendingCleanup` 可为
0），而 bridge 只看 `pendingCleanup`；探针显示 stop 明确未 reaped 时 `readHistory` 仍返回成功、
`dispose` 报 `{ok:true}`，start 悬停时 dispose 提前 ok、释放后 reader 继续启动读取。随着 R7 的
路径删除，reader 进程、run 目录与所有权都不再存在（"无子进程的新设计按实际所有权验证"）：本轮
用真实计数证明冷读 **0** 次 supervisor 构造、**0** 个 run 目录、`dispose` 无失败，并保留
shutdown 后拒绝读取的闸门。

**R9（P1）：host 元数据读取失败被伪装成成功空历史。** `session-ipc` 的 `withOmpHistory` 把
`engineForSession` 异常 catch 成 `pi`、把 `session.getEngineRef` 异常 catch 成 `null`，于是可信
OMP 会话因一次 lookup 异常退化为宿主空转录。修复：两处都不再降级——引擎判定失败与原生引用
读取失败都向上抛（渲染层可见、可重试），只有**成功读到"无引用"**（会话尚未跑过原生回合）才是
空历史；Pi 既有行为不变。

**R10（P2）：显式 null 活动叶回退到最后存储分支。** `history.ts` 把非法/缺失 leaf 与 `null`
一并归并后 `leafId ?? 最后 entry`。修复：显式 `leafId: null`（运行时的 `resetLeaf`，固定
`buildSessionContext` 正是渲染为空消息）→ 空活动分支；缺失/非字符串/空串等畸形叶 → 协议拒绝，
绝不猜测旧 tip（不因此开放 branch 能力）。

**本轮真实 UI 证据（`repair3-20261003/omp-plan-ui-*.png` 13 张 + `omp-plan-ui-raw.json` 1039569 B，
真实 Electron 渲染层 + 生产 bridge/gate + patched `.5` 运行时 + 本地 FakeProvider）**：

| 断言 | 证据 |
| --- | --- |
| 重启后、发新 prompt 前看到历史（R6 保持） | `scenarios.history.afterHeldRestart` 9/9 user 行 overlap；roles = 9 assistant turn / 14 assistant 消息 / 11 tool 行 / 9 process 组 |
| 读取/重选不改原生字节（R7 保持） | `nativeTranscriptAfterPendingRestart.sha256` == `nativeTranscriptAfterReselect.sha256` = `ec6e32b7…` |
| 同文本两次提交：两个气泡、两个持久 entry、二次重选稳定（R5 保持） | live `…:1` / `…:3` → entry `3e6bbb95` / `dfec4207`（重选两次不变）；provider 16→18 恰 +2 |
| 重启不重放 | 三次重启 provider 请求数不变（总 16） |
| 清理 | `CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0` |
| 全闭环 | 三种审批权限、reject/重提、running/pending 重启、工件/CAS 断言全部保留并通过；`SUMMARY 1 passed, 0 failed` |

**本轮新增/修改的测试与证据**（`repair3-20261003/`）：

| 层 | 文件 | 断言要点 |
|---|---|---|
| 直读器（新，unit） | `packages/omp-runtime/src/session/native-session-file.test.ts`（13 例） | title slot 折叠；header 在后也可读；仅 header 为空；畸形记录跳过；未落幕尾行忽略；metadata 尾 entry 仍是叶；CRLF；v2 `hookMessage`→`custom` 内存改名；身份不符 `OMP_RESTORE_FAILED`；无 header/空文件/版本 1/版本 4/畸形版本 `OMP_HISTORY_INVALID`；文件上界与单记录上界拒绝；缺文件 `OMP_HISTORY_READ_FAILED` |
| 投影叶语义（改） | `packages/omp-runtime/src/session/history.test.ts`（+2，共 10） | 显式 `null` → 空页（entry 不复活）；`undefined`/空串/数字/对象/数组叶全部拒绝 |
| bridge 读取（重写） | `apps/desktop/test/omp-history-read.test.mjs`（8 例） | 冷读**不构造任何 supervisor**、文件原地读；失败类别（外部路径/他者 header/缺文件/版本 1/结构破损）不改字节；shutdown 后拒绝读取；显式 null 叶空页（存活 runtime 路径）；存活 runtime 复用与 `replacedLiveMessageIds` 台账不变 |
| 真实 runtime（重写） | `apps/desktop/test/omp-history-e2e.test.mjs`（1 例，真固定运行时 + FakeProvider） | **等价性**：同一转录，存活 runtime 的 `get_entries` 投影与冷读的 id/角色/内容完全一致（`3b31aa12`/`7fcbb16e`/`history-call-1`/`7f83dd33`）；字节纯度跨成功读取、版本拒绝、身份拒绝、最终态（`a176c4a2…`、3371 B）；**0** 次 reader supervisor 构造、**0** 个 run 目录；provider 请求不变；并发 writer 行边界语义（未落幕尾行不可见、补上换行后可见） |
| IPC 边界（+3） | `apps/desktop/test/engine-session-ipc.test.mjs`（12 例） | 引擎 lookup 失败与 `session.getEngineRef` 失败都上抛（sessionGet/sessionOpen，readHistory 不被调用）；成功"无引用"是唯一空历史；读取失败仍上抛；Pi 不触发原生读取 |
| 读配置投影（删） | `apps/desktop/test/omp-model-projection.test.mjs`（15 例） | 随瞬时读取路径删除 `projectReadOnlyModelsYaml` 及其 2 例；其余投影断言不变 |
| 真实 UI E2E | `apps/scripts/e2e-omp-plan-ui.mjs`（未改） | R1–R6 完整闭环在本轮源码上复跑通过（上表） |

**被删除的旧实现（干净切换）**：`omp-session.ts` 的 `readEntriesWithReadOnlyRuntime` 与
`createReadSupervisor` 选项、`omp-session-wiring.ts` 的只读 supervisor 装配、
`omp-model-projection.ts` 的 `projectReadOnlyModelsYaml`/`READ_ONLY_MODEL_PROVIDER_ID` 及其测试；
`omp-history-read.test.mjs` 中针对旧命令序（`switch_session→get_state→get_entries→new_session`）、
只读 profile、reader 回收失败的行随路径一起删除，替换为直读路径的等价断言。

**直读器的已知边界（如实记录，不回归）**：只接受 session 格式版本 2 与 3（版本 1 无稳定 entry
id、未知未来版本拒绝，均显式报错）；`blob:sha256:` 图片引用不由直读器解析——旧瞬时 runtime 在
重启后同样无法解析（blob 存储位于已删除的 run root 内），行为未回归（ADR 0313 已记录该限制）。

### 1.8 第四轮定向返修（2026-10-03，R11/R12）

根在 `e33bc98c` 的独立复审（`/tmp/omp-t20-d-ui-repair4-root-20261003/review-e33bc98c/`，
真实 macOS arm64 compiled `.5` + production bridge + 原生 writer 的读取探针 5/8；R7–R10
的具体缺陷维持闭合）判定两条读取缺陷，都是直读器尾部处理把"损坏或写到一半的转录"变成
"看起来成功的完整历史"。

**R11（P2）：完整 JSON 末行没有换行时，最后一条消息从界面消失。** 旧实现对 EOF 处所有未落下
换行的片段一律丢弃。根从真实 writer 字节构造私有快照，恰好截在第二条完整 user 记录末尾（记录
JSON 与 parent 链完整，唯一差异是末尾无 LF）：production bridge 返回 2 行/1 个 user，期望
3 行/2 个 user，最后一条 user `8fa50d76` 不可见；文件未被删除或改写，是显示截断。固定参考
（`native-jsonl-tail-reference.json`）实测同字节有 LF（327 B）与无 LF（326 B）在固定 loader
下 `malformedRecords` 均为 0、返回同一 user 且原字节不变，因此不能把"无 LF"一律当成未落幕
写入。修复：EOF 片段不再无条件丢弃——完整 JSON 的尾片段按普通记录解析，并走同一 header
身份/版本/结构校验路径（末尾记录也算叶，保持稳定 id）；读取者绝不向用户文件补写换行。

**R12（P2）：损坏完整行/不完整尾部被伪装成成功历史。** `consumeLine` 的 `JSON.parse` catch
直接 `return`，EOF 尾部也直接丢弃。根实测 production bridge：真实完整文件后追加一个以 LF
结尾的畸形记录仍成功返回 4 行；合法 header 加不完整 JSON 尾部成功返回 0 行（与真正空会话
无法区分）。修复：两者都以 `OMP_HISTORY_INVALID` typed 错误明确拒绝，消息区分"非法 JSON
记录"与"未终止记录"，沿 bridge/IPC 可见、可重试；并发写者写到一半时拒绝本次快照而不是静默
截断或猜测，写者提交后同一次读取即可成功。合法空白行、header-only 与显式空结果语义不变。
固定 OMP 底层的宽松加载保留在 `parseSessionContent`（`malformedRecords` 信号保留），桌面读取
契约不再复制其宽松而丢掉错误信号，这是有意且文档化的分歧。读取者仍然只读：不删除、不改写、
不截断、不恢复备份。

**本轮产品改动（最小面）**：`packages/omp-runtime/src/session/native-session-file.ts` 的
`consumeLine`/`consumeText`/EOF 尾部；同步单测、bridge 单测、真实 runtime E2E 与规格/ADR。
未改 fork/补丁（仍 `.5`）、gate、host-core、固定子模块与 UI E2E 脚本；未重新引入任何 reader
进程；未触碰 R1–R10 已闭合的行为。

**本轮新增/修改的测试与证据**（`repair4-20261003/`）：

| 层 | 文件 | 断言要点 |
|---|---|---|
| 直读器 unit（改/增） | `packages/omp-runtime/src/session/native-session-file.test.ts`（16 例） | 完整无 LF 尾记录可见且字节不变；尾记录同样做身份/版本校验（header-only/外来 id/版本 4）；畸形完整记录 typed 拒绝且文件不变（含 header 前）；未终止残尾 typed 拒绝、补成完整记录后同读成功；空白尾部忽略；多字节字符跨 64 KiB chunk 的尾记录完整；单记录上界同样作用于无 LF 尾部 |
| bridge 读取（+1） | `apps/desktop/test/omp-history-read.test.mjs`（9 例） | R11：去 LF 后 3 行（含 `call-1`）可见、文件 sha 不变、不构造 supervisor；R12：畸形行与残缺尾 `OMP_HISTORY_INVALID` 拒绝、拒绝前后 sha 不变；补全记录后重试读出 `entry:m4` |
| 真实 runtime（改） | `apps/desktop/test/omp-history-e2e.test.mjs`（1 例，真固定运行时 + FakeProvider） | 真实 writer 记录去掉末尾 LF 与冷读 id 全等；残缺追加被拒且 torn sha 不变；提交后重试恰 +1 行；损坏副本被拒且 sha 不变；原转录 sha 跨成功/拒绝/final 不变（`7892f203…`、3371 B）、provider 2、supervisor 构造 1/0、run 目录 `[]` |
| 真实 UI E2E | `apps/scripts/e2e-omp-plan-ui.mjs`（未改） | R1–R6 闭环在最终源码复跑：`SUMMARY 1 passed, 0 failed`、exit 0；13 张截图；重启后发新 prompt 前 9/9 user 行 overlap（9 assistant turn / 14 assistant 消息 / 11 tool 行 / 9 process 组）；pending 重启与重选后原生 sha 均为 `42b51045…`（28357 B）；同文本两次提交 live `…:1`/`…:3` → entry `6618fd7a`/`fe11412c`（二次重选稳定）、provider 16→18 恰 +2；三次重启 provider 不增（无重放）；`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0` | `repair4-20261003/omp-plan-ui-run.txt`、`ui/omp-plan-ui-raw.json`、`ui/omp-plan-ui-01..13-*.png` |

### 1.9 第五轮定向返修（2026-10-03，R13）

根在原始 `80ce94ac6cb2a04b883a1062e0ac984b11939c70` 上独立复核：构建、类型检查、lint、
docs、产品 source diff 通过；runtime 定向 108、desktop 定向 133、IPC/null 叶边界 8/8；真实
macOS arm64 compiled `.5` writer + production bridge 冷读 8/8（完整无 LF 末条消息可见、畸形
完整行与半写尾部 typed 拒绝、全部 byte-pure、`providerDelta=0`、reader 工厂 0、清理干净）。
**R11/R12 判定闭合，本轮不重复返修。**

但根随后以**未改的已提交** UI 脚本在 Linux 真 Electron/Host/OMP 上运行两次，两次业务断言
都是 `1 passed, 0 failed`，两次都**误杀外围复验父进程**：

| 轮次 | `running-restart.before` 误纳 | 记录的发信号 | 后果 |
|---|---|---|---|
| 首轮（SSH 内） | `python3` PID/PGID `2279095` | `SIGTERM-owned-groups [2279095]`（07:53:39.619Z） | SSH exit 255，外围 `root-review.json` 缺失 |
| 脱离 SSH 重跑 | `python3` PID `2282200` / PGID `2282199` | `SIGTERM-owned-groups [2282199]`（07:58:09.366Z） | 外围报告与其 shell exit 文件均缺失 |

内部报告仍宣布 clean/passed，所以不能据此忽略误杀。归档摘要：
`ui-process-ownership-failure.json`（archive 2085818 B、sha256 `74ff72c2…`）。

**R13（P1）根因**：`app/scripts/e2e-omp-plan-ui.mjs:554-557` 的
`const markers = [state.tempRoot, state.patchedTree]` 对全部 `/proc` 命令行做 substring 匹配。
`state.patchedTree` 是**共享构建树**（固定 `/tmp/omp-patched-t20d-ui-repair1`），外围复验器
以 `--patched-tree /tmp/omp-patched-t20d-ui-repair1` 启动 harness，于是父级 Python 进程的命令行
命中该标记被归入自有集合；`terminateOwnedApp` 再对 `remaining` 的 PGID 发信号，父进程组被杀，
外围报告无法写出。凡是与本次运行共享同一 patched tree 的无关进程（例如并发的另一轮测试）
都可能被误杀，因此这是所有权判据本身的问题，不是参数、SSH 权限或 macOS 历史读取的问题。

**修复（只改 harness、新增归属 helper/回归与文档；产品代码、gate、host-core、fork、补丁级
`.5`、固定子模块未动）**

- 新增 `app/scripts/e2e/process-ownership.mjs`。归属只看本次运行的真实证据：
  1. 记录的 spawn 根本体（Electron 的 `pid` + `starttime`，spawn 后立即读取）及其 ppid 后代；
  2. argv 元素或环境值中出现的**本次唯一 scratch root**（`mkdtemp` 原始路径与 realpath 两种
     拼写）——逐 argv 元素（含 `--key=value` 的 value）、逐 `KEY=VALUE` 环境值按**路径元素
     边界**匹配（`/tmp/run` 命中 `/tmp/run/data`，不命中 `/tmp/run-2`），供被 reparent 的脱离
     OMP 运行时归属。
  **共享 patched tree 不再参与任何所有权判定**；harness 自身与全部祖先（外层启动器、父 shell、
  父进程）无条件排除，祖先即使携带 run root 也只记入 `ignored` 而不发信号。
- 发信号改为"计划 + 执行"：每个阶段重读进程表，只有"该组当前全部存活成员都是已核对
  `starttime` 的自有目标"的进程组才 `kill(-pgid)`；混合组、自身组、祖先组与显式排除组一律
  退化为对自有成员逐 PID 发信号，绝不扩大为整组终止。PID 消失/复用按 `starttime` 重查并记为
  `stale`（不猜测）；`ESRCH` 视为目标已退出，其他 kill 错误（如 `EPERM`）随阶段原样上报。
- 重启第一阶段仍只拆 Electron 组（`onlyGroups: [electron pgid]`），但纯度判定使用**完整自有
  集合**（否则 Electron 的渲染层子进程会被误判为 foreign）；脱离幸存者留给后续
  SIGTERM→SIGKILL 升级阶段，升级阶段同样排除 Electron 组并按混合组规则处理。
- raw JSON 继续记录 `processes.runRoots`/`roots`/`protectedAncestors`/`excludedAncestors` 与每个
  stage 的 `groups`/`pids`/`mixedGroups`/`protectedTargets`/`stale`/`results`，外围可逐项复核
  归属与信号决策。
- 三种审批权限、running/pending 真实重启、不重放、稳定消息身份、重启/重选历史、原生字节不变、
  隔离 HOME/XDG/TMPDIR、scratch 回收与"残留即失败"语义全部保留，未通过禁用清理或弱化断言换取
  通过。

**本轮回归（`app/scripts/e2e/process-ownership.test.mjs`，`node --test`，16 例全过）**

| 类别 | 断言要点 |
|---|---|
| 归属（受控进程表） | 归档复现：外围 Python 复验器（argv 含 `--patched-tree <共享树>`）与共享树使用者都不入自有；祖先即使携带 run root 也被记录为 `ancestor-run-root` 且不入集合；被 reparent 的 `omp` 仅凭环境中的 run root 归属；根 PID 复用（starttime 不符）时连其后代一并不认领；`/tmp/run` 与 `/tmp/run-2`、`/tmp/runner` 的边界区分 |
| 信号计划 | 纯自有组 → 组信号；混合组（自有 leader + 无关成员）→ 仅逐 PID、`mixedGroups` 记录 foreign；自身组/祖先组/`excludedGroups` 绝不作为组目标；`onlyGroups` 收窄阶段仍按完整自有集合判纯度（含真实混合反例）；PID 消失/复用 → `stale` 且零信号；kill spy 验证 `-pgid` 取反、`ESRCH` 归"已退出"、`EPERM` 如实上报 |
| 真实 sentinel 冒烟（仅本任务自建子进程） | ①自有脱离组（argv 携带 run root + `sleep` 子进程）被整组回收；②仅环境携带 run root、已被 reparent 的 `sleep` 被归属并回收；③混合组只杀自有 leader、**无关成员存活**（本机实测确认其确实未被信号命中） |
| 活表自检 | 真实 `/proc` 表能描述本进程（pid/ppid/pgid/starttime/argv/环境），`sameProcess` 对同 pid 不同 starttime 判否 |

**提交候选复跑（根脚本原样、主证据）**：`a4c1903` 上外围 `passed: true`、exit 0，`root-review.json`
与外壳退出正常——即 R13 的直接症状（父级被信号、外围报告缺失、SSH 255）不再出现。raw JSON 里
父 Python 进程只出现在 `protectedAncestors`，`before` 中 `python3` 计数为 0，三个终止阶段的
信号决策都是"整组信号"（`groups=[<electron pgid>]`、`pids=[]`、`mixed=[]`、`stale=[]`、无失败
结果）。同候选的首轮复跑因本任务在运行进行中并发把证据文件写入仓库而使外围 `statusAfter` 非空
（`passed: false`），与 harness 无关，报告按原样归档为
`repair5-20261003/root-review-superseded-dirty-tree.json`。

被复跑的候选是 `a4c190313fcf592c55c88b3803989a55a1bca610`；其后的归档提交只新增本轮文档与
证据（`git diff` 不含任何 harness/产品文件），harness 在两个提交上字节相同
（sha256 `4d02057022df4f6fdf0eb7fafb7ea8b5cbe3a2adb8b9444fd8358ce81c8c44a5`）。

## 2. 验证（命令、退出码、原始日志）

所有命令在 `/home/vv/person/code/omp-desktop-m5-t20-d-ui/app`，Node v24.14.0、
Bun 1.4.2、Linux x64；固定 patched 运行时树由 `scripts/omp-patch.mjs --apply
--prepare-build` 现成构建（首稿放 `/tmp/omp-patched-t20d-ui`，返修轮重新构建为专属树
`/tmp/omp-patched-t20d-ui-repair1`，manifest `.5`、launcher sha256
`1bc44850…`、隔离 HOME 下 `--version` = `omp/18.3.0`）。UI E2E 使用用户会话显示端点
（`DISPLAY=:1` + `XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.JKWYV3`，Xwayland
2560x1440）与 `--no-sandbox`；Electron 43.6.0 二进制由 `~/.cache/electron` 的
`electron-v43.6.0-linux-x64.zip` 离线安装。

证据全集：首稿 20 个原始文件由 `M5-t20-d-capability-ui/SHA256SUMS.txt` 覆盖
（**不包含清单自身**，`sha256sum -c` 全通过，本轮未改）；返修轮证据放子目录
`M5-t20-d-capability-ui/repair-20261003/`，由该子目录自己的 `SHA256SUMS.txt` 覆盖
（同样自排除、`sha256sum -c` 全通过）；第二/三/四轮分别在 `repair2-20261003/`、
`repair3-20261003/`、`repair4-20261003/`，各自清单同样自排除（旧三份 92 件本轮复跑全部
`OK`，见 `repair4-20261003/old-evidence-integrity.txt`）。本文件本身由 Git 追踪，不在任何
清单内。

| 验证 | 命令（要点） | 结果 | 原始日志 |
| --- | --- | --- | --- |
| B9 RED | 暂存实现后运行 `vitest run src/engine.test.ts`、`node --test engine-router/engine-session-ipc/omp-mode-capability-render` | shared 2 失败/12 通过；desktop 3 失败（router 门、IPC 边界、渲染层 offeredModes） | `red-b9-shared-engine.txt`、`red-b9-desktop-boundaries.txt` |
| B9 GREEN | 同上（实现恢复后） | shared 14/14；desktop 20/20（含 `omp-mode-capability-render.test.mjs` 的 chip 显隐/受限循环 SSR 断言与 IPC/create+configure 的关闭声明拒绝） | `green-b9-shared-engine.txt`、`green-b9-desktop-boundaries.txt` |
| D3 UI E2E（首稿，历史） | `DISPLAY=:1 … OMP_DESKTOP_RUNTIME=<patched> node scripts/e2e-omp-plan-ui.mjs` | `SUMMARY 1 passed, 0 failed`、exit 0，8 张截图（仅 ask/accept-edits/ pending 重启，见 §1.5 返修原因） | `omp-plan-ui-run.txt`、`omp-plan-ui-artifacts/` |
| **D3 UI E2E（返修：三种权限 + running/pending 重启 + 隔离/回收/raw 证据）** | `DISPLAY=:1 XAUTHORITY=… PI_DESKTOP_E2E_PATCHED_TREE=/tmp/omp-patched-t20d-ui-repair1 PI_DESKTOP_E2E_ARTIFACT_DIR=…/repair-20261003 node scripts/e2e-omp-plan-ui.mjs` | `SUMMARY 1 passed, 0 failed`、exit 0；12 张截图；`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`；raw JSON 929889 B | `repair-20261003/omp-plan-ui-run.txt`、`repair-20261003/omp-plan-ui-raw.json`、`repair-20261003/omp-plan-ui-01..12-*.png` |
| R5/R6 RED/GREEN 回归（同脚本双树） | `node r5-r6-regression.mjs --tree <baseline 2093f271>/app --expect red`、`--tree <fixed>/app --expect green` | RED：R5 一次提交渲染 2 行、R6 OMP `sessionGet` 0 条消息；GREEN：R5 1 行、R6 2 条 entry 行 | `repair2-20261003/r5-r6-regression-baseline-2093f271.json`、`r5-r6-regression-fixed.json`、`r5-r6-regression.mjs` |
| bridge 历史读取单测 | `cd apps/desktop && node --test test/omp-history-read.test.mjs` | 8/8 通过、exit 0 | `repair2-20261003/omp-history-read.txt` |
| 真实 runtime 历史读取 E2E | `cd apps/desktop && node --test test/omp-history-e2e.test.mjs` | 1/1 通过、exit 0（含字节纯度、无凭据读取、fail-closed） | `repair2-20261003/omp-history-e2e.txt` |
| **R5/R6 UI E2E（第二轮断言）** | `DISPLAY=:1 … PI_DESKTOP_E2E_PATCHED_TREE=/tmp/omp-patched-t20d-ui-repair1 PI_DESKTOP_E2E_ARTIFACT_DIR=…/ui node scripts/e2e-omp-plan-ui.mjs` | `SUMMARY 1 passed, 0 failed`、exit 0；13 张截图；`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`；raw JSON 1039684 B | `repair2-20261003/omp-plan-ui-run.txt`、`omp-plan-ui-raw.json`、`omp-plan-ui-01..13-*.png` |
| runtime 包（第二轮） | `pnpm --filter @pi-desktop/omp-runtime test` | **34 files / 517 passed / 6 skipped**、exit 0 | `repair2-20261003/runtime-vitest.txt` |
| shared 包（第二轮） | `pnpm --filter @pi-desktop/shared test` | **86 files / 986 passed**、exit 0 | `repair2-20261003/shared-vitest.txt` |
| desktop 全量（第二轮） | `cd apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | 见日志 | `repair2-20261003/desktop-full.txt` |
| lint / docs / 矩阵 ID（第二轮） | `pnpm lint`；`pnpm docs:check`；`node scripts/check-t20-matrix-ids.mjs` | 均 exit 0（docs 513 页，新增 ADR 0313） | `repair2-20261003/lint.txt`、`docs-check.txt`、`matrix-ids.txt` |
| typecheck（第二轮） | `pnpm typecheck`（先 `-r build`） | exit 0（desktop/pi-host 全绿） | `repair2-20261003/typecheck.txt` |
| OMP bridge 定向（第二轮） | `cd apps/desktop && node --test test/omp-session-bridge.test.mjs test/omp-history-read.test.mjs test/omp-session-ownership.test.mjs test/omp-session-failclosed.test.mjs test/omp-session-configure.test.mjs test/omp-host-tool-bridge.test.mjs test/omp-terminal-delivery.test.mjs` | 109/109 通过、exit 0 | 命令输出 |
| Goal/生命周期真实 E2E（第二轮复跑） | `cd apps/desktop && node --test --test-name-pattern "T20-D" test/omp-plan-submit-e2e.test.mjs` | 8/8 通过、exit 0 | `repair2-20261003/goal-lifecycle-e2e.txt` |
| desktop 全量（第二轮结果） | 同上 | **3045 tests / 3034 passed / 0 failed / 11 skipped**、exit 0 | `repair2-20261003/desktop-full.txt` |
| docs 门（返修轮新增） | `pnpm docs:check`（`check:locales` 79 对 + `check:docs` 512 页） | exit 0；顺带修复该门此前已有的 ADR 目录问题（0301 H1 前缀、0301–0305/0312 索引缺失、0306–0311 过期状态词） | 命令输出（§2 末尾） |
| 矩阵 ID 检查 | `node scripts/check-t20-matrix-ids.mjs` | exit 0（B1–B14/C1–C8/D1–D3 编号仍各恰一次） | 命令输出（§2 末尾） |
| 返修轮 lint/typecheck | `pnpm lint`、`pnpm --filter @pi-desktop/desktop typecheck` | 均 exit 0（产品代码未改，重跑确认 harness/文档改动无影响） | 命令输出（§2 末尾） |
| D1/B13 E2E | `node --test --test-name-pattern "T20-D lifecycle\|T20-D Goal" apps/desktop/test/omp-plan-submit-e2e.test.mjs` | 2/2 通过、exit 0 | `goal-lifecycle-e2e.txt` |
| 终止事件修复单测 | `node --test apps/desktop/test/omp-terminal-delivery.test.mjs apps/desktop/test/main-wiring-contract.test.mjs` | 8/8 通过（2 + 6） | 输出见命令 |
| B1 state E2E（含 D-Enter 过期断言修正后） | `cd apps/desktop && node --test test/omp-runtime-state-e2e.test.mjs` | 1/1 通过、exit 0 | `b1-state-e2e.txt` |
| runtime | `cd packages/omp-runtime && npx vitest run` | **33 files / 504 passed / 6 skipped**、exit 0 | `runtime-vitest.txt` |
| shared | `cd packages/shared && npx vitest run` | **86 files / 986 passed**、exit 0 | `shared-vitest.txt` |
| desktop 全量 | `cd apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | **3026 tests / 3015 passed / 0 failed / 11 skipped**、exit 0（含全部 OMP E2E 与 T17–T19 套件） | `desktop-full.txt` |
| 类型/构建/lint | `pnpm typecheck`（先 `pnpm -r build`）、`pnpm lint` | 均 exit 0（`typecheck.txt`、`lint.txt`） | `typecheck.txt`、`lint.txt` |

**首次全量运行的调用错误（如实记录）**：第一次以 `app/` 为 CWD 运行 `node --test apps/desktop/test/*.test.mjs`，3 个按包内相对路径读取文件的测试（`browser-cdp`、`bundled-plugins`、`plugin-work-panel-views`）因 CWD 不符而整文件失败；改用仓库约定 CWD（`apps/desktop`）后三者全绿。其余 3 个失败为真实的过期断言/桩问题（见下段），已修正并以本表为准。

**D-Enter 遗留的过期断言修正（全量套件暴露）**：`omp-runtime-state-e2e.test.mjs`（Agent 目录基线 1 处 + 策略表 1 处 + MCP 变化后目录 2 处）与 `omp-skill-path-bridge.test.mjs`（宿主工具策略 2 处）的期望仍停留在 D-Enter 之前（不含 `EnterPlanMode`/`EnterGoalMode`），`plan-goal-cursor-gate.test.mjs` 的手工 `@pi-desktop/shared` 桩缺 `normalizeEngineId`（本阶段 Main 边界新增调用）。均已按 D-Enter 已接受的实际行为修正；核对：`git show 68519ea1:app/apps/desktop/electron/main/runtime/omp-host-tools.ts | grep -c EnterPlanMode` = 1 而两个测试文件在基线处为 0 ⇒ 这两处断言在基线即为红、只是不在根验收的 10 文件子集内。

### 2.1 返修轮命令输出（docs/lint/typecheck/matrix）

```text
$ pnpm docs:check        # 第一次（返修前状态）
Verified 79 English/Chinese specification pairs.
ADR catalog:
  - adr/0301-omp-session-surface.md: H1 must start with "ADR", found "0301 — The OMP conversation surface: events, dialogs and stopping"
ADR index:
  - adr/0301-…0305-….md: missing from the adr/README.md index        （5 条，历史阶段遗漏）
  - adr/0312-omp-mode-capabilities-and-terminal-delivery.md: missing from the adr/README.md index
docs:check exit=1

$ pnpm docs:check        # 修复 0301 H1 与 0301–0305/0312 索引行并清除 0306–0311 的过期状态词后
Verified 79 English/Chinese specification pairs.
Verified 512 documentation pages.
docs:check exit=0

$ node scripts/check-t20-matrix-ids.mjs
MATRIX-ID-OK: B1-B14, C1-C8, D1-D3 each appear exactly once
exit=0

$ pnpm lint
Checked 75 files in 37ms. No fixes applied.
lint exit=0

$ pnpm --filter @pi-desktop/desktop typecheck
tsc -p tsconfig.json --noEmit
typecheck exit=0
```

`docs:check` 的失败项在返修前即存在（0301 H1 前缀与 0301–0305 索引是更早阶段就有的遗漏；
0312 由本分支首稿引入），本轮全部修复，门恢复 exit 0；这属于"运行仓库自带的文档门后发现并
修正现行目录事实"，未改任何 ADR 正文语义（0301 仅标题格式对齐其余 ADR；README 索引行是元数据）。

### 2.2 第三轮返修命令与结果（R7–R10）

所有命令在 `/home/vv/person/code/omp-desktop-m5-t20-d-ui/app`（UI/真实 E2E 在仓库内亦同），
Node v24.14.0、Bun 1.4.2、Linux x64；UI E2E 使用 `DISPLAY=:1` +
`XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.JKWYV3`（Xwayland 2560x1440）与 `--no-sandbox`；
patched 运行时树 `/tmp/omp-patched-t20d-ui-repair1` 在跑前跑后核验（launcher sha256
`1bc44850…`、隔离 HOME 下 `--version` = `omp/18.3.0`，见 `repair3-20261003/patched-tree-input.txt`）。

| 验证 | 命令（要点） | 结果 | 原始日志 |
| --- | --- | --- | --- |
| 直读器 + 投影单测（新/改） | `packages/omp-runtime && vitest run src/session/native-session-file.test.ts src/session/history.test.ts` | **2 files / 23 passed**、exit 0 | `repair3-20261003/native-history-unit.txt` |
| runtime 包全量 | `packages/omp-runtime && vitest run` | **35 files / 530 passed / 6 skipped**、exit 0 | `repair3-20261003/runtime-vitest.txt` |
| shared 包全量 | `pnpm --filter @pi-desktop/shared test` | **86 files / 986 passed**、exit 0 | `repair3-20261003/shared-vitest.txt` |
| bridge 读取单测（重写） | `apps/desktop && node --test test/omp-history-read.test.mjs` | 8/8 通过、exit 0 | `repair3-20261003/omp-history-read.txt` |
| 真实 runtime 读取 E2E（重写） | `apps/desktop && node --test test/omp-history-e2e.test.mjs` | 1/1 通过、exit 0；结构化行：sha 前后与拒绝后均 `a176c4a2…`（3371 B）、provider 2、supervisor 构造 1/0、live/cold 行 id 全等、run 目录 `[]` | `repair3-20261003/omp-history-e2e.txt` |
| IPC 边界 | `apps/desktop && node --test test/engine-session-ipc.test.mjs` | 12/12 通过、exit 0 | `repair3-20261003/engine-session-ipc.txt` |
| 投影套件 | `apps/desktop && node --test test/omp-model-projection.test.mjs` | 15/15 通过、exit 0 | `repair3-20261003/omp-model-projection.txt` |
| OMP bridge 定向合集 | `apps/desktop && node --test test/omp-session-bridge.test.mjs test/omp-history-read.test.mjs test/omp-session-ownership.test.mjs test/omp-session-failclosed.test.mjs test/omp-session-configure.test.mjs test/omp-host-tool-bridge.test.mjs test/omp-terminal-delivery.test.mjs test/engine-session-ipc.test.mjs test/omp-model-projection.test.mjs` | **136/136 通过**、exit 0 | `repair3-20261003/omp-bridge-directed.txt` |
| Goal/生命周期真实 E2E | `apps/desktop && node --test --test-name-pattern "T20-D" test/omp-plan-submit-e2e.test.mjs` | 8/8 通过、exit 0 | `repair3-20261003/goal-lifecycle-e2e.txt` |
| **真实 UI E2E（R1–R6 复跑）** | `DISPLAY=:1 … PI_DESKTOP_E2E_PATCHED_TREE=/tmp/omp-patched-t20d-ui-repair1 PI_DESKTOP_E2E_ARTIFACT_DIR=…/ui node scripts/e2e-omp-plan-ui.mjs` | `SUMMARY 1 passed, 0 failed`、exit 0；13 张截图；`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`；raw JSON 1039569 B；provider 16 无重放 | `repair3-20261003/omp-plan-ui-run.txt`、`omp-plan-ui-raw.json`、`omp-plan-ui-01..13-*.png` |
| desktop 全量 | `apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | **3045 tests / 3034 passed / 0 failed / 11 skipped**、exit 0 | `repair3-20261003/desktop-full.txt` |
| typecheck / lint / docs / 矩阵 | `pnpm typecheck`、`pnpm lint`、`pnpm docs:check`、`node scripts/check-t20-matrix-ids.mjs` | 均 exit 0（docs 79 对语言 + 513 页） | `repair3-20261003/typecheck.txt`、`lint.txt`、`docs-check.txt`、`matrix-ids.txt` |
| 旧证据完整性 | `sha256sum -c`（首稿 `SHA256SUMS.txt`、`repair-20261003/`、`repair2-20261003/`） | 三份清单全部 `OK`（旧 20/14/28 件未改写） | 命令输出 |
| 第三轮证据清单 | `repair3-20261003/ && sha256sum -c SHA256SUMS.txt` | 30 件全 `OK`（自排除 manifest） | `repair3-20261003/SHA256SUMS.txt` |

不带 `env -u SSH_ASKPASS` 首次运行 desktop 全量时，唯一失败是
`remote-host-ssh-password.test.mjs` 的"key-auth 不携带 askpass 材料"——本会话环境里存在
`SSH_ASKPASS=/usr/bin/false`（与产品改动无关，前几轮同样以 `env -u SSH_ASKPASS` 运行）；
以该环境重跑该文件 14/14 通过，并以同样的方式取得上表全量结果，如实记录。

### 2.3 第四轮返修命令与结果（R11/R12）

本轮命令均在 `/home/vv/person/code/omp-desktop-m5-t20-d-ui/app`（Node v24.14.0、Linux x64、
本地 FakeProvider）。注意：桌面测试经 `@pi-desktop/omp-runtime` 消费 workspace **构建产物**，
改动 `packages/omp-runtime` 后须先 `pnpm build:js`；首跑未重建时 bridge 测试仍读到旧 dist，
如实记录该调用顺序要求（重建后全部定向测试复跑通过）。

| 检查 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| 直读器 + 投影 unit | `packages/omp-runtime && npx vitest run src/session/native-session-file.test.ts src/session/history.test.ts` | **2 files / 27 passed**、exit 0 | `repair4-20261003/native-history-unit.txt` |
| runtime 包全量 | `packages/omp-runtime && npx vitest run` | **35 files / 534 passed / 6 skipped**、exit 0（较第三轮 +4：新增 R11/R12 直读器用例） | `repair4-20261003/runtime-vitest.txt` |
| bridge 读取 | `apps/desktop && node --test test/omp-history-read.test.mjs` | 9/9 通过、exit 0（新增 R11/R12 例，见 §1.8） | `repair4-20261003/omp-history-read.txt` |
| 真实 runtime 读取 E2E | `apps/desktop && node --test test/omp-history-e2e.test.mjs` | 1/1 通过、exit 0；结构化行 sha `7892f203…`/3371 B 跨成功/拒绝/final 不变；provider 2 不增；supervisor 构造 1/0；run 目录 `[]`；目录 delta = `corrupt.jsonl`/`tail.jsonl`/`v1.jsonl` | `repair4-20261003/omp-history-e2e.txt` |
| OMP bridge 定向合集（9 文件） | `apps/desktop && node --test test/omp-session-bridge.test.mjs test/omp-history-read.test.mjs test/omp-session-ownership.test.mjs test/omp-session-failclosed.test.mjs test/omp-session-configure.test.mjs test/omp-host-tool-bridge.test.mjs test/omp-terminal-delivery.test.mjs test/engine-session-ipc.test.mjs test/omp-model-projection.test.mjs` | **137/137 通过**、exit 0 | `repair4-20261003/omp-bridge-directed.txt` |
| IPC 边界 | `apps/desktop && node --test test/engine-session-ipc.test.mjs` | 12/12 通过、exit 0 | `repair4-20261003/engine-session-ipc.txt` |
| **真实 UI E2E（R1–R6 闭环复跑于最终源码）** | `DISPLAY=:1 XAUTHORITY=… PI_DESKTOP_E2E_PATCHED_TREE=/tmp/omp-patched-t20d-ui-repair1 PI_DESKTOP_E2E_ARTIFACT_DIR=…/repair4-20261003/ui node scripts/e2e-omp-plan-ui.mjs` | `SUMMARY 1 passed, 0 failed`、exit 0；13 张截图；`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`；raw JSON 1040427 B；provider 16 无重放（同文本后总 18） | `repair4-20261003/omp-plan-ui-run.txt`、`ui/omp-plan-ui-raw.json`、`ui/omp-plan-ui-01..13-*.png` |
| typecheck / lint / docs / 矩阵 | `pnpm typecheck`、`pnpm lint`、`pnpm docs:check`、`node scripts/check-t20-matrix-ids.mjs` | 均 exit 0（docs 513 页；矩阵 B1–B14/C1–C8/D1–D3 各恰一次） | `repair4-20261003/typecheck.txt`、`lint.txt`、`docs-check.txt`、`matrix-ids.txt` |
| 源码格式 | `git diff --check -- app` | exit 0 | 命令输出 |
| 旧证据不变 | 四份清单 `sha256sum -c` | **92/92 `OK`**（20+14+28+30；旧件未改写） | `repair4-20261003/old-evidence-integrity.txt` |
| 第四轮证据清单 | `cd repair4-20261003 && sha256sum -c SHA256SUMS.txt` | **27/27 `OK`**（自排除 manifest，覆盖日志、13 张截图与 raw JSON） | `repair4-20261003/SHA256SUMS.txt` |

### 2.4 第五轮返修命令与结果（R13）

| 验证 | 命令（要点） | 结果 | 原始日志 |
| --- | --- | --- | --- |
| 语法 | `node --check scripts/e2e-omp-plan-ui.mjs`、`scripts/e2e/process-ownership.mjs`、`scripts/e2e/process-ownership.test.mjs` | 三者 exit 0 | `repair5-20261003/syntax-check.txt` |
| 归属/信号回归 + 真实 sentinel 冒烟 | `node --test scripts/e2e/process-ownership.test.mjs` | **16/16 通过**、exit 0；真实 sentinel 三例（脱离组回收、被 reparent 进程按环境 run root 归属、混合组只杀自有成员且无关成员存活）；运行后 `ps` 无遗留 `sleep 300` | `repair5-20261003/process-ownership-test.txt` |
| 源码状态预检第 1 轮（等价包装器，未提交状态） | `python3 /tmp/omp-t20-d-ui-r13-precheck-wrapper.py --candidate 80ce94ac… --output /tmp/omp-t20-d-ui-root-review-r13-precheck --ended-runner 2266833 --harness-sha256 7909a4b7… --patched-tree /tmp/omp-patched-t20d-ui-repair1 --xauthority …`（与根脚本仅差 HEAD/clean/harness-hash 三条一次性断言） | 外围 `passed: true`、exit 0；`timedOut=false`、`forcedCleanup=[]`、`survivors=[]`；harness `1 passed, 0 failed`、provider 16 无重放、`scratchRemoved=true`、`survivingOwnedProcesses=[]`；raw 中 `before` 无 `python3`、父级列入 `protectedAncestors` | `/tmp/omp-t20-d-ui-root-review-r13-precheck/root-review.json`（预检，不归档） |
| 源码状态预检第 2 轮（修正第一阶段 onlyGroups 后） | 同上，输出目录 `/tmp/omp-t20-d-ui-root-review-r13-precheck2` | 外围 `passed: true`、exit 0、无 forcedCleanup/survivors；harness `1 passed, 0 failed`；`running-restart` 第一阶段 `onlyGroups=[<electron pgid>]`、`groups=[<electron pgid>]`、`pids=[]`（整体组信号），`before` 15 个自有进程且无 `python3` | `/tmp/omp-t20-d-ui-root-review-r13-precheck2/root-review.json`（预检，不归档） |
| **提交候选 `a4c1903` 的根脚本原样复跑（主证据）** | `python3 /tmp/omp-t20-d-ui-repair5-root-20261003/run-ui-review-linux-candidate.py --candidate a4c190313fcf592c55c88b3803989a55a1bca610 --output /tmp/omp-t20-d-ui-root-review-a4c19031-clean --ended-runner 2266833 --harness-sha256 4d020570… --patched-tree /tmp/omp-patched-t20d-ui-repair1 --xauthority /run/user/1000/.mutter-Xwaylandauth.JKWYV3` | 外围 `passed: true`、exit 0，`root-review.json` 与外壳退出正常（父级未被信号）；`timedOut=false`、`forcedCleanup=[]`、`survivors=[]`、`statusAfter=''`；harness `SUMMARY 1 passed, 0 failed`、exit 0、13 张截图，`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`；三次重启 provider 不增（held 重启前后 16、无重放；同文本两次提交后总 18 = 恰 +2）；raw 1 070 283 B/`a893d3b8…`，`before` 15/14/13 且 `python3` 计数 0，父 Python 只出现在 `protectedAncestors`，三个阶段 `onlyGroups` 均判为整组信号（`groups=[<electron pgid>]`、`pids=[]`、`mixed=[]`、`stale=[]`、`results` 无失败）；读取/重选后原生 sha 均为 `11af8beb…`（28887 B）不变 | `repair5-20261003/root-review.json`、`omp-plan-ui-run.txt`、`ui/omp-plan-ui-raw.json`、`ui/omp-plan-ui-01..13-*.png`、`preflight.json` |
| 同候选首轮复跑（被本任务自身并发写脏工作树，非主证据） | 同上，输出 `/tmp/omp-t20-d-ui-root-review-a4c19031` | harness 断言与主证据一致（`1 passed, 0 failed`、无 forcedCleanup/survivors、`before` 无 `python3`、父级列 `protectedAncestors`、阶段 1 为整组信号），但外围 `passed: false`：本任务在运行进行中把 `old-evidence-integrity.txt` 写入仓库，`statusAfter` 非空。属任务侧并发写，不是 harness 缺陷；报告按原样归档说明原委 | `repair5-20261003/root-review-superseded-dirty-tree.json` |
| 旧证据不变 | 五份清单 `sha256sum -c` | **119/119 `OK`**（20+14+28+30+27；旧件未改写） | `repair5-20261003/old-evidence-integrity.txt` |
| 第五轮证据清单 | `cd repair5-20261003 && sha256sum -c SHA256SUMS.txt` | **21/21 `OK`**（自排除 manifest，含根报告、日志、preflight、13 张截图与 raw JSON） | `repair5-20261003/SHA256SUMS.txt` |

## 3. 全矩阵映射（B1–B14 / C1–C8 / D1–D3）

证据层级：**unit**（纯函数/单元）、**handler**（受控 handler/夹具）、**runtime/Host**
（真实固定 patched OMP + 真实 host-core）、**renderer**（真实 Electron 渲染层）。
"已接受"指根已独立验收的 B1/C/B2/D-Enter 阶段；本表引用它们的原始证据，不重跑即改为
引用；凡本阶段新影响面（能力键、Main 边界、模式生命周期、Goal、UI 终止事件）都在本阶段
重新跑过。

| 行 | 场景 | 本阶段证据 | 层级 | 状态 |
| --- | --- | --- | --- | --- |
| B1 | 会话 Agent/Plan/Goal 模式片切换持久化 | 已接受 B1（`M5-t20-b1-runtime-state.md`）+ `omp-session-configure-ipc.test.mjs`、`omp-session-configure.test.mjs` 回归 | handler + runtime/Host | 通过 |
| B2 | 模式提示词注入（块字节/单一 system/无 PI base/技能记忆顺序） | 已接受 B1/B2 + 本阶段 B13 生命周期 E2E：每回合单 system、mode block 与 `composeModeSystemPrompt` 逐字节相等、PI 默认 base 不出现、块纯追加；技能/记忆内容与顺序由 B1/T19-C 证据覆盖 | runtime/Host | 通过 |
| B3 | 契约模式工具目录 | B13 生命周期 E2E（Plan/Goal 目录与 Agent 严格对照、无 Write/Edit/Task/Enter）+ 已接受 B1/C gate 单测 | runtime/Host + unit | 通过 |
| B4 | SubmitPlan/Goal 可见性与错模式拒绝 | 已接受 B2（`omp-plan-submit-e2e` 提交/错 kind/重复 pending）+ 本阶段 D1 Goal 用例 | runtime/Host + host-core | 通过 |
| B5 | 提交产物不可变、sha/大小、防覆盖、awaiting 驱动审批卡 | 已接受 B2 + 本阶段 D1（`.pi/goal` 字节/sha/大小）与 D3 UI（pending 真实卡片 + 工件路径） | host-core + renderer | 通过 |
| B6 | 审批 reject/过期/打断、approve 原子、重复/冲突 | 已接受 B2 + 本阶段 D3 UI（真实 Reject → 可编辑 → 重提新工件、旧工件字节不变、审批不串会话） | host-core + renderer | 通过 |
| B7 | 恰一次执行/CAS/drain/boot maintenance/配置冻结 | 已接受 B2 + 本阶段 D3 UI 两条真实应用重启：pending→`interrupted`/`PLAN_APPROVAL_INTERRUPTED`；**running**（真实 `/bin/sleep` 子进程持住）→`interrupted`/`PLAN_EXECUTION_INTERRUPTED` + turn `aborted` + audit 行；两条重启 provider 请求数都不变、副作用日志不重复（§1.5） | host-core + renderer + OS 进程 | 通过 |
| B8 | 批准后按选定权限执行 | 已接受 B2 + 本阶段 D3 UI 三种真实批准：ask → 真实权限卡 → Allow once → 落盘；accept-edits → 无卡落盘；**auto** 经真实审批菜单 → high-risk `bash` 无卡执行、durable 行 `target_permission_mode=auto`、会话 `mode=agent`/`permission_mode=auto`；三条 execution 均 `completed`、无遗留 running（§1.5） | runtime/Host + renderer | 通过 |
| B9 | 能力声明：plan/goal 键、渲染层显隐、Pi 零变化 | 本阶段 §1.1（shared 14/14 + router/IPC/renderer 20/20 + RED 记录）；Pi 循环与行为不变 | unit + renderer + handler | 通过 |
| B10 | Agent 回归与 T17–T19 不受影响 | desktop 全量 **3045 tests / 3034 passed / 0 failed / 11 skipped**（第三轮复跑，含 T17–T19 全部用例与全部 OMP E2E） | 既有套件 | 通过 |
| B11 | `set_host_tools`→`before_agent_start` 顺序契约 | 已接受 spike R4-1/R4-2（`M5-plan-goal-capability-gates.md` §4.2）+ B13 生命周期 E2E（每回合目录与 clamp 一致、无自动激活残留） | runtime/Host | 通过 |
| B12 | 首次夹取 1 次 policy retry、其后稳定 | 已接受 spike R4-4（attempts 2/1/2）+ 本阶段 B13 五回合均不出现 `AgentStartPolicyChangedError`（回合全部正常完成） | runtime/Host | 通过 |
| B13 | 目录生命周期与真实持久模式切换 | 本阶段 B13 生命周期 E2E（Agent→Plan→Goal→Agent→Plan，重加与首轮逐项相等、无重复/残留、策略表由 host 行驱动） | runtime/Host | 通过 |
| B14 | R2 反例守卫（base 注入必须判红） | 已接受 B2 单元（`mode-prompt-counterexamples` 类断言在 B2 记录）+ 本阶段 E2E 的"无 PI base / 块字节相等"断言保持同一契约 | unit | 通过 |
| C1 | 契约模式硬拒绝（含 auto/allow） | 已接受 C（`M5-t20-c-execution-policy.md`）+ 本阶段 desktop 全量回归 | unit + runtime/Host | 通过 |
| C2 | Bash 按有效权限模式（不做命令分类） | 已接受 C + 本阶段回归（`omp-execution-policy-e2e` 等随全量套件执行） | unit + runtime/Host | 通过 |
| C3 | 插件 `planSafeActions` 与 `ctx.mode` | 已接受 C + 回归 | handler + unit | 通过 |
| C4 | 子代理 `hasUI=false` fail-closed | 已接受 C/T17 + 回归 | unit + runtime/Host | 通过 |
| C5 | 高权限工具（browser/computer/eval）决策表 | 已接受 C + 回归 | unit + runtime/Host | 通过 |
| C6 | 四条常规权限模式 | 已接受 C + 本阶段 D3 UI 的 ask/accept-edits/**auto** 实际执行路径（auto 与 accept-edits 的差别以 `bash` 对照：accept-edits 只放 write/edit，bash 在 auto 下才无卡） | unit + renderer | 通过 |
| C7 | 风险保真（含 BrowserPreview/`mcp_*`） | 已接受 C（F1 修正后的表）+ 本阶段 D3 权限卡真实 risk 文案 | unit + renderer | 通过 |
| C8 | 外部路径例外 | 已接受 C + 回归 | unit | 通过 |
| D1 | SubmitGoal、goal 提示词、批准后自主执行自停 | 本阶段 Goal E2E（§1.3）；无延续定时器 | runtime/Host + host-core | 通过 |
| D2 | `goal_updated` 只读展示 | 未实现（矩阵可选）；不伪造 Goal 状态，不新建第二套 Goal | — | 可选未实现 |
| D3 | 端到端用户路径 | 本阶段 UI E2E（§1.2 首稿 + §1.5 返修：三种批准权限、真实 Reject/重提、真实 running 与 pending 应用重启、专属 HOME 隔离、PID/进程组级回收验证、单份 raw JSON 证据 + §1.6 第二轮：重启后历史先于新 prompt 可见、每输入一次气泡、同文本两次提交、重选/分页身份稳定、读取不改原生字节 + §1.7 第三轮：同一闭环在直读实现上复跑 + §1.8 第四轮：R11/R12 修复后的最终源码复跑，13 张截图 + raw JSON，provider 无重放、读取/重选 sha 不变 + §1.9 第五轮：R13 后按本次运行唯一证据判定自有进程、按组纯度发信号（混合组只发自有成员）、外围复验父进程不被纳入也不被 signal，16 例归属/信号回归 + 真实 sentinel 冒烟 + 根通用外围脚本原样真跑）+ 已接受 B2 的派发证据 | renderer + runtime/Host + host-core + OS 进程 | 通过 |

## 4. 未做与不声称

- D2 未实现（矩阵可选）；无 OMP interactive Goal 延续定时器，也不声称有。
- 不声称 M5/T20 全部完成：T21 整体、T22、T23、T24/M7 与用户三平台真实 GitHub 测试包未交付；
  本阶段的编译/运行验证是源码树资源（patched launcher + 源码 gate），不是安装包验收。
- 未在 macOS/Windows 实机运行本阶段 E2E；UI 证据仅 Linux x64 + Xwayland 会话显示。返修轮的
  进程身份/回收验证依赖 Linux `/proc`（非 Linux 会降级为只验证 Electron 子进程，代码路径在，
  但本轮未实跑）。
- 未修改/未升级 fork 与补丁级（保持 `.5`）；未改 Cursor 门（ADR 0306）与其它已关闭能力。
- 第一轮返修（R1–R4）只改 `app/scripts/e2e-omp-plan-ui.mjs` 与文档（含 ADR 目录/索引的机械修复），
  产品代码、gate、host-core、fork、补丁与固定子模块未动。第二轮（R5/R6）改了产品代码：OMP 会话
  的只读历史投影、prompt 身份绑定、实时行台账与共享 `SessionDetail.replacedLiveMessageIds`
  （ADR 0313）；fork、补丁级（仍 `.5`）、gate 与 host-core 未动。第三轮（R7–R10，§1.7）改了产品
  代码：删除瞬时只读 runtime 与只读模型投影，新增进程内直读器
  `packages/omp-runtime/src/session/native-session-file.ts`，修 `history.ts` 的叶语义与
  `session-ipc.ts` 的元数据失败传播；fork、补丁级（仍 `.5`）、gate、host-core 与 UI E2E 脚本未动。
- 第三轮不声称"根已接受"：R7–R10 的修复证据是本机 Linux x64 上的真实 runtime/单元/UI 复跑；根
  上一轮使用的是 macOS arm64 原生运行时的故障注入，本轮未在 macOS 实机复跑（直读器为纯 Node 文件
  解析，但本轮未以 macOS 原生字节复核）。整 M5/T20 与三平台包仍未完成。
- 第四轮（R11/R12，§1.8）只改直读器尾部语义及其测试/文档：完整 JSON 尾记录不再丢弃、非法 JSON
  记录（含残尾）typed 拒绝；fork、补丁级（仍 `.5`）、gate、host-core、固定子模块与 UI E2E 脚本
  未动，未重新引入 reader 进程，R1–R10 已闭合行为未触碰。默认容器的低层宽松（`parseSessionContent`
  的 `malformedRecords`）保留，桌面读取契约有意不再复制其宽松——这是文档化的分歧，不是遗漏。
  第四轮同样不声称"根已接受"：证据为本机 Linux x64 的真实 writer/单元/bridge/真实 UI 复跑；根
  使用的是 macOS arm64 原生字节夹具，未在本机以 macOS 复跑。整 M5/T20 与三平台包仍未完成。
- 第五轮（R13，§1.9）只改 UI harness、新增 `app/scripts/e2e/process-ownership.mjs` 与其回归、
  以及文档：产品代码、gate、host-core、fork、补丁级（仍 `.5`）、固定子模块与既有产品断言未动，
  R1–R12 已闭合行为未触碰；R11/R12 未重复返修。归属/信号判定依赖 Linux `/proc`
  （命令行与环境）；非 Linux 仍降级为"只验证 Electron 子进程"路径（代码在，本轮未实跑）。
  第五轮不声称"根已接受"：本机证据是 Linux x64 的真实 UI 复跑与 16 例归属回归；三平台包、
  整 M5/T20 仍未完成，最终验收由根执行。
- 第五轮如实记录两点：(1) 归属判据只接受"本次运行的唯一 scratch root"，因此若将来引入新的
  脱离子进程且既不继承 spawn 根、也不携带该 root，它会落入 `leftover` 并使运行失败——这是
  刻意的 fail-closed：宁可失败并保留 scratch，也不扩大所有权判据去猜。(2) 第一阶段的
  `onlyGroups` 只拆 Electron 组，纯度判定必须用完整自有集合；只传根条目的实现会被本机预检
  第一轮直接暴露（Electron 的渲染层子进程被当成 foreign，组信号退化为逐 PID），该中间状态
  已修正并记录在 §2.4 的两轮预检中。
- 第四轮如实记录一个调用顺序要求：桌面测试经 workspace 构建产物消费 `@pi-desktop/omp-runtime`，
  改动该包后必须先 `pnpm build:js`（首次未重建时 bridge 测试读到旧 dist，属于测试基建而非产品
  缺陷；重建后全部定向测试复跑通过）。
- 第三轮直读器明确接受的 session 版本为 2 与 3；版本 1（无稳定 entry id）与未知未来版本显式拒绝，
  这是行为边界而非缺陷（旧瞬时路径对 v1 会生成随机 id，与"稳定 entry id"契约冲突）。`blob:sha256:`
  图片引用不由直读器解析；重启后的旧瞬时路径同样无法解析（blob 存储位于已删除的 run root），
  行为未回归。
- 重启后**转录面板**的恢复渲染：第二轮已验收（§1.6）——重启后、发出任何新 prompt 之前，面板显示
  重启前的 user/assistant/tool 历史（行 id 为原生 entry id，overlap 与原会话一致、无重复、无
  丢失，且读取前后原生 transcript 字节不变）。第一轮 §1.5 如实记录的"只显示重启后回合"是当时的
  可观察状态，现已修复，不以旧记录推断历史丢失；第三轮在同一断言集上复跑，读取实现换为直读且
  `nativeTranscriptAfterPendingRestart.sha256 == nativeTranscriptAfterReselect.sha256` 保持。
- 第二轮与第三轮均未在 macOS/Windows 实机运行；历史读取与身份断言仅 Linux x64 + Xwayland 实跑。
- 专属 HOME 下产品运行时的子 PATH 派生自继承 HOME（`~/.bun/bin` 首位），harness 因此在专属 HOME
  内链接绝对 bun/node；这是测试环境构造要求（如实记录），不修改产品行为，也不读取用户配置。
- 未调用任何付费/远程模型；全部 E2E 使用本地 FakeProvider。第三轮"无凭据"的证明从"只读 profile
  不读取密钥"升级为结构性事实：冷读不接触 provider 目录、不启动任何进程，真实 runtime E2E 以
  不存在的 provider/model 标识完成读取；仍未在 UI 中删除已有凭据后再跑。
- 历史读取的入口是 `sessionGet`/`sessionOpen`（真实渲染层加载路径）；OMP 会话的侧边栏搜索、
  导出与 compaction 标记仍沿用既有实现，不在本轮范围。
- B10/C 行的细节证据以已接受阶段的原始报告为准（本文件 §3 只给引用与回归命令）。
