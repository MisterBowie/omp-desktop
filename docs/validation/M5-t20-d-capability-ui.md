# M5/T20-D：能力键、真实桌面闭环与完整矩阵

更新时间：2026-10-03。状态：**首稿 `8a1dd8fc` 经根复审判 changes-required（R1–R4：缺
auto 批准与 running 执行重启、无专属 HOME/回收失败不可见、无可审计 raw 证据且 execution id
印错、现行 spec/矩阵状态漂移）；定向返修完成、本机验证通过、待根复审**（返修证据
`docs/validation/M5-t20-d-capability-ui/repair-20261003/`，§1.5）。分支
`codex/m5-t20-d-capability-ui`（普通追加提交，不 amend/rebase/强推，不发布、不合 main、
不建 PR），基线 `68519ea19f6fee37fec2c5817256f3a68ea8606e`（根已接受的 D-Enter 最终原始提交）。
固定子模块 OMP `62bc57be`、PI `0111e306`（未动）；补丁级保持 `62bc57b+omp-desktop.5`
（fork commit `36483311dfff67be7504f591974df93fc512a45a`，本阶段不改 fork、不改 patch）。

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
（同样自排除、`sha256sum -c` 全通过）。本文件本身由 Git 追踪，不在任何清单内。

| 验证 | 命令（要点） | 结果 | 原始日志 |
| --- | --- | --- | --- |
| B9 RED | 暂存实现后运行 `vitest run src/engine.test.ts`、`node --test engine-router/engine-session-ipc/omp-mode-capability-render` | shared 2 失败/12 通过；desktop 3 失败（router 门、IPC 边界、渲染层 offeredModes） | `red-b9-shared-engine.txt`、`red-b9-desktop-boundaries.txt` |
| B9 GREEN | 同上（实现恢复后） | shared 14/14；desktop 20/20（含 `omp-mode-capability-render.test.mjs` 的 chip 显隐/受限循环 SSR 断言与 IPC/create+configure 的关闭声明拒绝） | `green-b9-shared-engine.txt`、`green-b9-desktop-boundaries.txt` |
| D3 UI E2E（首稿，历史） | `DISPLAY=:1 … OMP_DESKTOP_RUNTIME=<patched> node scripts/e2e-omp-plan-ui.mjs` | `SUMMARY 1 passed, 0 failed`、exit 0，8 张截图（仅 ask/accept-edits/ pending 重启，见 §1.5 返修原因） | `omp-plan-ui-run.txt`、`omp-plan-ui-artifacts/` |
| **D3 UI E2E（返修：三种权限 + running/pending 重启 + 隔离/回收/raw 证据）** | `DISPLAY=:1 XAUTHORITY=… PI_DESKTOP_E2E_PATCHED_TREE=/tmp/omp-patched-t20d-ui-repair1 PI_DESKTOP_E2E_ARTIFACT_DIR=…/repair-20261003 node scripts/e2e-omp-plan-ui.mjs` | `SUMMARY 1 passed, 0 failed`、exit 0；12 张截图；`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`；raw JSON 929889 B | `repair-20261003/omp-plan-ui-run.txt`、`repair-20261003/omp-plan-ui-raw.json`、`repair-20261003/omp-plan-ui-01..12-*.png` |
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
| B10 | Agent 回归与 T17–T19 不受影响 | desktop 全量 **3026 tests / 3015 passed / 0 failed / 11 skipped**（含 T17–T19 全部用例与全部 OMP E2E） | 既有套件 | 通过 |
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
| D3 | 端到端用户路径 | 本阶段 UI E2E（§1.2 首稿 + §1.5 返修：三种批准权限、真实 Reject/重提、真实 running 与 pending 应用重启、专属 HOME 隔离、PID/进程组级回收验证、单份 raw JSON 证据）+ 已接受 B2 的派发证据 | renderer + runtime/Host + host-core + OS 进程 | 通过 |

## 4. 未做与不声称

- D2 未实现（矩阵可选）；无 OMP interactive Goal 延续定时器，也不声称有。
- 不声称 M5/T20 全部完成：T21 整体、T22、T23、T24/M7 与用户三平台真实 GitHub 测试包未交付；
  本阶段的编译/运行验证是源码树资源（patched launcher + 源码 gate），不是安装包验收。
- 未在 macOS/Windows 实机运行本阶段 E2E；UI 证据仅 Linux x64 + Xwayland 会话显示。返修轮的
  进程身份/回收验证依赖 Linux `/proc`（非 Linux 会降级为只验证 Electron 子进程，代码路径在，
  但本轮未实跑）。
- 未修改/未升级 fork 与补丁级（保持 `.5`）；未改 Cursor 门（ADR 0306）与其它已关闭能力。
- 返修轮只改 `app/scripts/e2e-omp-plan-ui.mjs` 与文档（含 ADR 目录/索引的机械修复）；产品代码、
  gate、host-core、fork、补丁与固定子模块未动，故未重跑产品全量套件、未重建编译产物（改动不在
  其影响面）。
- 重启后**转录面板**的恢复渲染未在本阶段验收：§1.5 记录的是返修运行中"重启 + 恢复回合结束后"
  的实际可观察状态（面板只显示重启后的回合），native 转录完整另有 provider 请求为证；不据此
  声称历史丢失，也不声称面板恢复完整。
- 专属 HOME 下产品运行时的子 PATH 派生自继承 HOME（`~/.bun/bin` 首位），harness 因此在专属 HOME
  内链接绝对 bun/node；这是测试环境构造要求（如实记录），不修改产品行为，也不读取用户配置。
- 未调用任何付费/远程模型；全部 E2E 使用本地 FakeProvider。
- B10/C 行的细节证据以已接受阶段的原始报告为准（本文件 §3 只给引用与回归命令）。
