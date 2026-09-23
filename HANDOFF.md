# OMP Desktop 开发交接

更新时间：2026-09-23。当前状态：**M3 端到端对话与工具执行（T11-T13）实现完成（见下方摘要与 `docs/validation/M3-workflow.md`），等待独立复审。**接入路径沿用 M1 定案：「rpc-ui 子进程 + 受信扩展 tool_call 前置审批 + 桥接层进程组终止兜底」，M2 已把它落成产品包 `app/packages/omp-runtime` 与唯一路由点 `engine-router`。M2 已完成并按要求复审（`docs/validation/M2-runtime-boundary.md` §8-§11）。下一阶段 M4（T14-T16）。M3 的范围是 T11-T13，不含 T14-T16。

## 0. M3 交付摘要（本轮）

- 状态：**T11-T13 已完成并提交**（分支 `codex/m3-workflow`），等待独立复审；M4 未开始。
- 证据：`docs/validation/M3-workflow.md`（三方证据位置、权限竞争矩阵、停止顺序、端到端夹具时间线与残留检查）；设计决策：`app/docs/adr/0301-omp-session-surface.md`。
- 新增/改动核心：`app/packages/omp-runtime/src/session/`（events 转换器、ui-requests 决策注册表、runner 生命周期）、`app/packages/omp-runtime/extensions/omp-desktop-gate.ts`（随产品发布的执行前网关）、`app/apps/desktop/electron/main/runtime/omp-session.ts`（桌面桥接）、`agent-ipc.ts` 的 OMP 分支、`packages/shared/src/engine.ts` 的能力开放（prompt/stop/structuredQuestions/toolApproval）。
- 新增测试：`events.test.ts`(16)、`ui-requests.test.ts`(19)、`gate.test.ts`(13)、`runner.test.ts`(14)、`omp-session-bridge.test.mjs`(13)、`omp-session-e2e.test.mjs`(真实固定 OMP 端到端 1 项：读→拒绝→批准一次→跑测试→长任务停止→无残留)。
- 本轮环境补充（新工作树必需）：`bun install --frozen-lockfile` 与 `bun --cwd=packages/natives run build`（未安装时 Bun 会解析到全局缓存 18.2.9，pinned 校验失败）。
- 返修（独立复审 R1-R2，基线 `cb6f728`）：R1 `prompt(projectPath)` 现在会在 `start()` **之前**把经过校验的绝对项目目录交给监督器（空/相对/不存在一律 fail closed，绑定后不同目录明确拒绝），E2E 不再手工设置 cwd；R2 权限决定改走专用 `resolvePermission`/`resolveAsk`，身份取自桥接保存的 session+generation+kind，重复/停止后/跨 kind/未知一律 fail closed（基线实测缺陷：ask 请求 id 可被权限路径消费并写帧）。详见 `docs/validation/M3-workflow.md` §5.1。
- 第二轮返修（独立复审 R1-R3，基线 `60e0f7e`）：R1 跳过/拒绝提问与无法投递的自定义答案现在 fail closed 完成（写 `{cancelled:true}` 并清两层 pending），不再让 OMP 永久等待；R2 旧 generation 的 UI 请求在回合结束/停止/失败/被新 run 替代后一律失效，旧决定绝不写入新 run；R3 `stop(sessionId)` 先校验会话所有权再清理，错误会话的停止不再破坏正确会话的 pending/状态/wire。详见 `docs/validation/M3-workflow.md` §5.2。
- 第三轮返修（独立复审 F1-F3，基线 `ce2bf01`）：F1 只有存在 active run 时才呈现 approval/question，idle/stopping 期间到达的交互帧按 OMP 协议立即 `{cancelled:true}`（不呈现、不留 pending、不可事后放行）；F2/F3 prompt 被拒绝或抛错时统一走幂等的 `closeGeneration()`（取消该代 dialog、通知桥接、回到 idle、保留原异常），与传输失败并发时最多取消一次。详见 `docs/validation/M3-workflow.md` §5.3（含 PI-Desktop/OMP 参考文件与测试检索证据）。
- 第四轮返修（独立复审 F1-F2，基线 `db89c88`）：删除 `omp-session-bridge.test.mjs` 中的永真断言 `|| true`；prompt 被拒绝或请求抛错且该回合已呈现过卡片时，runner 现在发出**恰好一次** terminal `error` envelope（带正确 `sessionId`/`turnId`，与传输失败共享单次守卫，原异常与拒绝原因保持不变），使 renderer 的 `pendingPermissions`/`pendingAsks` 按 PI-Desktop 既有契约被清空，不再留下孤儿卡片；terminal 之后的迟到交互请求仍 fail closed。附带修正 E2E 自身两处时序假设（僵尸进程判定、回合结算等待），全量 desktop 连续 8 次 0 失败。详见 `docs/validation/M3-workflow.md` §5.4。
- 下一轮入口：M4/T14-T16（会话字段与恢复、模型与凭证投影、并发项目）；M3 未开放的入口（附件、steer/follow-up、压缩、分支、子代理交互审批、会话切换）保持显式拒绝。

## 1. 用户已确定的方向

- 基于 `vastsa/PI-Desktop` 实现 OMP 桌面端，界面和主要交互尽量保持一致。
- 按 `can1357/oh-my-pi` 的能力修改或增加功能。
- 由本轮模型负责规划，用户选择其他模型执行实现。
- 用户已有 NVM，使用 **`nvm use 24`**，不要重复安装 Node。

## 2. 已准备好

| 位置 | 内容 |
| --- | --- |
| `app/` | 本项目直接管理的产品源码，导入自 PI-Desktop 0.15.2 |
| `upstream/pi-desktop/` | PI-Desktop 原始源码子模块，固定基线提交 |
| `upstream/oh-my-pi/` | OMP 18.2.7 源码参考子模块，固定基线提交 |
| `docs/source-baseline.json` | 精确 SHA、工具版本与准备状态 |
| `docs/00-scope-and-decisions.md` | 范围和技术决策 |
| `docs/01-source-audit.md` | 本地源码入口、真实协议和兼容性边界 |
| `docs/02-target-architecture.md` | 目标架构、接口、会话和权限实现路径 |
| `docs/03-implementation-plan.md` | M0-M7 阶段计划与验收门 |
| `docs/04-task-board.md` | 24 个实现任务，当前全部待开始 |
| `docs/05-validation-and-release.md` | 测试矩阵、用户路径和发布验收 |
| `docs/06-executor-prompts.md` | 分阶段执行提示词 |
| `docs/07-environment-and-upstream.md` | 环境准备和上游维护 |
| `docs/validation/M0-baseline.md` | M0 验证记录（命令、版本、退出码、SHA、截图） |
| `docs/validation/M0-screenshots/` | M0 代表性界面基线截图（项目列表/设置/模型/扩展） |
| `docs/validation/M1-compatibility.md` | M1 验证记录（E01-E13、413 项检查、传输能力矩阵、未执行项、三轮复审返修 R1-R6 / F1-F6 / R1-R4） |
| `docs/decisions/001-omp-transport.md` | 接入传输路径决策（含 M2 必须遵守的十二条约束） |
| `app/experiments/omp-bridge/` | M1 实验套件：`node run-all.mjs` 可复现，含 `tools/long-task.mjs`、`lib/runtime-registry.mjs`（按运行标识回收资源）、fixtures/results |

PI-Desktop SHA：`0111e306c120ad5820688d7608cb37bad8fbcc1f`

OMP SHA：`d49918fab2dba3986927f2d46721629ed0f3a02c`

项目 GitHub 地址：`git@github.com:MisterBowie/omp-desktop.git`，主分支 `main`。根目录直接管理文档和 `app/`，上游参考采用固定提交的子模块。使用 `git clone --recurse-submodules` 或在克隆后运行 `git submodule update --init --recursive`。

首次规划的 `app/` worktree 结构已为 GitHub 交付调整；原始 worktree 仅在本机 `.local-worktrees/pi-desktop-baseline/` 保留，不是后续开发入口。`source-baseline.json` 中的初始化记录保持历史原样，当前布局以上述说明为准。

## 3. M0 已完成的工作

- 建立专用分支 `codex/m0-baseline` 与 worktree，初始化参考子模块到固定 SHA（pi-desktop `0111e306`、oh-my-pi `d49918fab`）。
- 准备并记录环境：Node 24、pnpm 10.34.5、Bun 1.4.2、rustc stable + nightly-2026-08-12、cmake/ninja。
- 原 PI-Desktop 按锁文件安装依赖并完成 `build:js`、typecheck、lint、host-core 构建与测试（`cargo test -p host-core` 577 通过）。
- 隔离开发数据/数据库/凭证/更新源（`PI_DESKTOP_DATA_DIR`）与全局 `.agents`（`PI_DESKTOP_AGENTS_DIR`），启动开发版，CDP 截取代表性界面基线。
- OMP `bun setup` 构建成功；`docs/validation/M0-rpc/verify-rpc.mjs` 绑定 `upstream/oh-my-pi` 内的启动器（repo 路径，非全局链接），核对 gitlink=submodule SHA 与版本 18.2.7，全量隔离（每次运行唯一的 `PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR`/`OMP_DEV_LAUNCH_DIR`）下完成 `ready`/`negotiate_protocol`(v2)/`get_available_models` 协议启动，无付费模型调用；隔离路径为验收条件，流错误统一清理，默认无临时目录/进程残留。配套 `verify-rpc.test.mjs`（18 项假进程测试）+ fixture `models.yml` + `fake-omp.mjs`。
- 证据：`docs/validation/M0-baseline.md`（含顶部“返修记录”）与 `docs/validation/M0-screenshots/`；任务看板 T01-T03 已标记完成。

## 3.1 仍然没有做的工作

- 没有修改应用源码或 OMP 源码（M0 全部通过已有配置完成，未改产品代码；仅根 `.gitignore` 增加 `.dev-data/`）。
- 没有调用真实模型或付费 API（OMP 协议启动用 `auth: none` 的本地 mock 模型）。
- 没有创建 PR、发布安装包或部署产品，没有自动提交或推送。
- 没有做 macOS arm64 打包（本机为 Linux x64，与规划假设不同）。
- M1 未覆盖：真实子代理事件（需真实 `task` 调用，T17）、MCP 工具进入模型工具表（T19）、macOS/Windows 进程终止语义（T23）、真实付费模型烟测（需用户指定）。

## 3.2 M1 已完成的工作

- 在 `app/experiments/omp-bridge/` 建立可复现实验套件 E01-E13(本地假 provider、每实例合成 HOME 与隔离配置根、进程组回收)。`node run-all.mjs`:**13/13 实验、413/413 检查通过,退出码 0,约 210 秒**;汇总按「退出码 0 + 无信号 + PASS + 结果文件命名/`ok` 一致 + 本轮运行标识」判定,并回收被强杀实验的 detached 运行时与隔离目录。
- 权限链路实测:受信扩展的 `tool_call` 钩子在**执行前**拿到工具名与具体目标,拒绝时无文件/进程副作用,批准后只执行一次;宿主工具(`set_host_tools`)同样经过该钩子。审批问答通过 `extension_ui_request` 的 `select/confirm/input` 往返,并覆盖取消与超时。
- 取消链路实测(复审 R1 后重做):顶层会话里 `abort` 就能回收**真实运行的命令进程及其子进程**(用自行写 PID 的外部程序验证);**不先停止就杀桥接进程组会留下孤儿**,因为命令运行在自己的 session/进程组;挂起对话被 `cancel` 且解析为 deny、会话保持可响应。停止顺序因此定为"先协议内停止,再拆桥接"。
- 子代理挂起审批的取消(第三轮 R1):**OMP 不提供**——父 `abort` 成功后子代理仍 `running`、无取消帧、延迟 300 ms 的 allow 会真的执行;E11 改为由**桥接侧取消标记**实现"停止后旧审批不能再放行",并区分取消/拒绝/超时。桌面须在 M2/T09 自建该机制。
- 子代理(R3 新增 E11,复审 F1 后按会话身份路由重做):子代理的工具调用**会**进入同一条 `tool_call` 钩子,但钩子在子代理会话里 `hasUI=false`,不可能向用户弹窗——纯 UI 依赖的审批会被立即拒绝,审批必须由桌面策略或带外通道决定;策略批准时由子代理恰好执行一次。父会话 `abort` **不会**回收 detached 子代理正在运行的命令树(子代理仍被报为运行中),需要显式的进程树终止。
- 配置隔离(R2 加固):子进程 `HOME` 指向运行目录内的合成家目录,并剥离额外重定向变量;正对照(合成 HOME 里的全局规则生效)与反对照(decoy HOME 的规则/技能不生效)都已验证,测试不再读取真实用户配置。
- 协议分片(R4 新增 E13,复审 F3 后接入客户端):关闭自动压缩后 1.2 MB 提示产生真实 `rpc_chunk`,解码器现接在**响应匹配之前**,`rpc.request()` 能拿到 1,200,650 字节的完整重组响应;分片写回 stdin 会被拒绝(`Unknown command: rpc_chunk`),而单行超限命令可直接接受;分片故障不可恢复(固定实现亦视为致命),桌面应重启运行时。
- 取消语义(第四轮 R1):取消对尚未执行的调用具有决定权——每轮先查取消标记,决定按 `toolCallId` 归属且单次消费,不再用文件 mtime 判断(真实 OMP 探针证伪了旧规则);E12 覆盖取消先到、allow 先落盘后被取消、正常允许、显式拒绝、真实超时与作用域不匹配。
- 回收验收(第四轮 R2):回收异常/`clean=false`/存活资源进入验收判定,失败时非零退出且 summary 保留结构化诊断;清理失败的登记保留可重试;`--keep-artifacts` 不算失败。
- 审批消费 fail-closed(第五轮 F1):决定文件的**读取或消费写入**失败都不放行(显式 block;`child-consume-failed`/`child-decision-unreadable`),否则一份只读 `allow` 会授权后续所有调用(真实子代理已复现)。
- 代理环境归一化(第五轮 F2):隔离环境按 PI `PROXY_ENV_KEYS` 先全量剥离大小写四组代理变量与 `NODE_USE_ENV_PROXY`,再施加本测试策略;真实 bun 子进程实测假代理 0 请求、loopback 仍可达。
- 离线烟测(第四轮 C1):M0 隔离环境显式离线(出站指向关闭端口、loopback 直连),默认命令恢复通过且**未放宽超时**;原因见验证报告 §8.3。
- 回收语义(第三轮 R2/R3):按**进程组存活**决定 SIGKILL 升级(组长退出不豁免,对照 `npm-executable.ts` 的 `settle()`),存活成员按 `/proc` 的 `pgrp` 精确枚举,清理未完成保留登记且不谎报;按所有权删除本轮 `.dev-data/m1/<run>-*` 临时根并遵循 `--keep-artifacts`。
- 传输错误分类(第三轮 R4):等待中的协议/流错误按真实错误返回(`errorKind="transport"`),只有真正超时才归类 timeout。
- 工具链加固(E12,R5/R6 与复审 F2-F5):帧结构校验、启动失败有界清理;汇总按「退出码 0 + 无信号 + PASS + 结果文件命名/`ok` 一致 + 本轮运行标识」判定;被超时杀死的实验,其 detached 运行时、后代与隔离目录按**环境归属**有界回收(不按进程名);参数选择集合正确。
- 宿主工具与子代理:`host_tool_call`/`host_tool_result` 往返可用,放弃未应答调用会收到 `host_tool_cancel`(**按 `targetId` 关联**);真实 `task` 调用产生 `subagent_lifecycle`/`subagent_progress`/`subagent_event` 三类帧,存活期快照含 `parentToolCallId` 与 `sessionFile`。
- 会话与隔离实测:原生会话按 `sessionFile` 恢复且不重放副作用、不重新审批;`branch` 生成新的原生会话文件;子进程实际环境无凭证与 steering 变量;模型/规则/MCP 都从隔离根加载。
- 传输边界实测:跨块 UTF-8、半帧、CRLF、非法 JSON 恢复、超长行显式报错、180 KB 多字节消息往返;缺失可执行文件/立即崩溃/永不 ready 三类降级运行时均可分类回收;stdin EOF 与 stdout EPIPE 都会让 OMP 自行退出且进程组被回收。
- 模式差异实测(纠正了仅凭源码的初判):两种模式都能投递扩展对话,但只有 `rpc-ui` 装配 `setToolUIContext` 并广告 OMP 自身的 `ask` 工具(12 项 vs 11 项)。
- 版本协商实测:ready 广告 `supportedProtocolVersions: [1,2]`,但 `negotiate_protocol: 1` 被明确拒绝,只能协商 v2。
- 回归:M0 的 `verify-rpc.test.mjs` 18/18 通过,`verify-rpc.mjs` 真实无费用 RPC 通过。
- 证据:`docs/validation/M1-compatibility.md`、`docs/decisions/001-omp-transport.md`、`app/experiments/omp-bridge/fixtures|results/`;任务看板 T04-T07 已标记完成。

未通过/未执行:MCP 工具未进入模型工具表(归属 T19);子代理的交互式审批**不支持**(无 UI,须由桌面策略替代)与单独停止(T17);macOS/Windows 进程终止未验证(T23);ACP/SDK 仅源码比对。

## 3.3 M2 已完成的工作（T08-T10）

- **T08 引擎边界**：`packages/shared/src/engine.ts` 定义 `EngineId`（`pi` | `omp`，与 `SessionSource` 不同维度）、全键必需的 `EngineCapabilities`、`SessionEngineRef`（含 `ENGINE_ADAPTER_VERSION`）、`EngineRuntimeStatus` 与协议/版本常量。`normalizeEngineId` 对缺省与未知值一律回 `pi`：旧会话永远属于 Pi，不会被新默认值接管。
- **T09 运行时包**：新增 `app/packages/omp-runtime`（已入 pnpm workspace 与锁文件）。模块职责：`protocol`（typebox 帧校验、ready 判定、v2 分片重组）、`ndjson`（显式行长上限 + `line-too-large` 重同步）、`transport`（ID 匹配、流错误按真实原因返回、挂起请求全量 settle、拒绝写回 `rpc_chunk`）、`launcher`（显式/打包内/固定子模块，**绝不从 PATH 解析**，`--version` 校验）、`isolation`（合成 HOME、剥离重定向/代理/凭证变量）、`process`（停止顺序 abort → abort_bash → EOF → TERM 组 → KILL 组，按**进程组存活**判定）、`supervisor`（运行根所有权、单飞启动、`stopped`/`reaped`/`cleaned` 三独立判定、`terminateOwnedTree`、`prepareRun` 配置投影）。
- **实际运行证据**：该包 62 项测试全部通过，其中含**真实固定 OMP 运行时**的无费用烟测（版本 18.2.7 校验 → ready → negotiate v2 → 停止后进程组与运行根均已回收）；mock 子进程覆盖永不 ready、拒绝 v2、帧上限不符、分片损坏、忽略 TERM/EOF、组长退出但后代存活等情形。
- **T10 路由与身份**：host-core schema 升级到 v20（`sessions.engine TEXT NOT NULL DEFAULT 'pi'` + 迁移与备份，既有会话读出 `pi`；fork 与协同 spawn 继承来源引擎）；`session.create` 校验引擎；桌面侧 `runtime/engine-router.ts` 是唯一判定点（`prompt`/`steer`/`stop` 三个执行入口统一过 gate），OMP 会话在能力关闭时被**拒绝而非回退到 Pi**；`runtime/engine-runtime.ts` 汇总两引擎状态并持有 OMP 运行时；退出时 reclaim 未完成会写 error 日志。
- **应用身份**：`packages/shared/src/app-identity.ts` 定义产品身份并与上游 PI-Desktop 及 OMP 自身目录做冲突断言（`assertIndependentIdentity`）；数据根改为 `~/.omp-desktop` / `~/.omp-desktop-dev`，appId `net.misterbowie.omp-desktop`，productName `OMP Desktop`，更新源指向本项目仓库，开发构建禁用自动更新，开发 bundle 的名称/bundle id 由 package.json 派生。
- **复审返修（R1-R7，见验证记录 §8）**：① 生产组合此前**没有**接入会话→引擎查询，steer/stop 等按 id 的 gate 实际永远读作 Pi——现已由 host 的 `session.get` 提供唯一持久化来源并在组合测试中断言（OMP 会话抛能力拒绝且不触碰 sidecar）；② 查询失败不再 fail-open 到 Pi，只有“读取成功且无 engine 字段”才算旧会话，其余一律 `ENGINE_UNAVAILABLE`；③ 逐条审计并 gate 了 abort/compact/status/队列/ask 解析/计划批准与恢复排空，ADR 0300 增补审计表与三条不 gate 的依据；④⑤ supervisor 在 `reaped:false` 后保留可重试所有权并禁止二次启动，stop/reclaim 单飞以消除并发竞态（含 start 与 reclaim 的竞态）；⑥ shutdown 对 reclaim rejection 写 error 日志并有行为测试；⑦ 测试夹具 PATH 追加解释器目录，修复 macOS/`~/.nvm` 下的 127 失败（生产 PATH 仍封闭）。
- **第二轮复审返修（S1-S6，见验证记录 §9）**：① 队列 reorder 补上唯一 gate；② 计划批准与恢复排空改为“先 gate 再改动持久状态”（被拒的执行跳过且保持 queued）；③ 所有执行/控制 handler 改为“参数校验 → 读引擎并 gate → 才要求 Pi 运行时”，并把 gate 语义定为**按声明**判定（运行时是否在跑由状态面回答，避免一次重启被读成永久拒绝，队列也才能在重启期间暂存）；④ 启动失败若进程未能回收，错误携带所有权、supervisor 采纳并保留目录与 pid/pgid，拒绝第二次启动，重试可清理；⑤ 记录区分“进程已回收（只欠目录）”与“仍拥有活组”，前者绝不再发信号；⑥ 删除任务临时文件，交付以 `git status --porcelain` 为空为准。第三轮（S7）：扫描回收成功后按同一 runRoot 精确释放所有权（`ownsRun`），使 `status` 回到 `stopped`、`start()` 可再次成功；成功回收的 `stop` 同时删除扫描为同一运行保留的记录，扫描确认进程已回收但目录仍在时把记录降级为 cleanup-only 并停止发信号。cleanup failure 语义不变：只要仍有未清理记录，`status` 为 `failed`/`unreclaimed`、`start()` 继续拒绝。第四轮（S8）：进程组确认回收后，无论目录删除成败都先替换同 runRoot 的旧保留记录，保证一次运行最多一条记录（删净则 0 条，否则恰 1 条 cleanup-only）。
- **环境事实（重要）**：子模块依赖必须**按 worktree 单独安装**（`bun install` + `bun run build:native`，不执行 `link omp`）。未安装时固定启动器会把 `@oh-my-pi/pi-utils` 解析到 bun 缓存里的已发布包，`--version` 报出与固定检出不同的版本——这正是运行时包坚持启动前校验版本的理由。
- 证据：`docs/validation/M2-runtime-boundary.md`、`docs/decisions/001-omp-transport.md`（沿用）、`app/docs/adr/0300-engine-boundary.md`（英文 ADR）、`app/docs/spec/03-runtime/02-agent-runtime.md` §13。任务看板 T08-T10 已标记完成。

## 4. 下一执行模型从哪里开始

**从 M3（T11-T16）开始：端到端对话与工具执行。**

M2 已完成并等待复审：引擎边界、`packages/omp-runtime` 监督与传输、路由与能力门、应用身份（见 §3.3）。
M3 的起点是运行时包已有的传输/监督接口——回合事件、工具卡片、审批问答都在其上实现，
不要再自己造一套进程或协议处理。

M0 已完成并经四轮复审返修：原桌面可复现构建、开发数据与全局 `.agents` 隔离、UI 基线、OMP 协议启动（绑定 repo 内启动器、版本 18.2.7、`ready`/`negotiate_protocol` v2）均有记录（`docs/validation/M0-baseline.md`，顶部四段“返修记录”）。环境已就绪：Node 24、pnpm 10.34.5、Bun 1.4.2、桌面 Rust stable + OMP `nightly-2026-08-12`、cmake/ninja。复审结论以复审方为准。

M1 已定案接入路径并留下约束，见 `docs/decisions/001-omp-transport.md`（§3 十二条必须实现的约束）。M2 不得重新论证 rpc-ui 选择，除非出现新证据；停止必须先协议内停止再拆桥接（顶层 `abort` 即回收命令进程，子代理需显式终止其进程树），审批必须先于执行，子代理审批不能假设继承父会话 UI。实验套件可继续复用于回归：`cd app/experiments/omp-bridge && node run-all.mjs`（413 项检查）。

## 5. 可直接交给执行模型

```text
打开 /home/vv/person/code/omp-desktop 作为整个工作区（M0、M1 已完成）。

阅读 AGENTS.md、HANDOFF.md 和 docs 中的规划文档，以及 app/ 的适用规则。
本轮执行 M2（T08-T10），前置 M1 已完成：
- docs/validation/M1-compatibility.md
- docs/decisions/001-omp-transport.md（§3 六条约束必须落实）

环境已就绪：Node 24、pnpm 10.34.5、Bun 1.4.2（~/.bun/bin）、
桌面 Rust stable + OMP nightly-2026-08-12、cmake/ninja（pip 安装）。

接入路径已定案，不要重新论证：OMP 以独立子进程 + --mode rpc-ui 运行，
权限走受信扩展的 tool_call 执行前钩子。停止按顺序处理：先协议内 abort
（顶层会话即可回收命令进程及其后代），确认回收后再拆桥接；不先停止就杀
桥接进程组会留下孤儿。
子代理不同：其会话 hasUI=false，无法弹窗审批，必须由桌面策略或带外通道决定；
父会话 abort 不会回收 detached 子代理正在运行的命令树，需要显式终止其进程树。
详见 docs/decisions/001-omp-transport.md 的十二条约束。

T08 最小运行时接口并保持原 Pi 行为；T09 进程监督与协议适配包
（退出/超时/帧错误/资源回收，读取器需显式行长上限）；T10 会话引擎选择、
能力判断与应用身份（含独立 appId、数据目录、凭证存储命名与更新源）。

优先复用 app/experiments/omp-bridge/ 的结论与 fixtures 作为回归基线
（cd app/experiments/omp-bridge && node run-all.mjs 应保持通过）。
不修改参考子模块，不重写界面，不调用付费模型，不自动提交或推送。

输出 docs/validation/M2-*.md，更新任务看板和 HANDOFF.md。
```

## 6. 下一轮必须保持的取舍

- 保留桌面 UI 和既有 Pi 行为，变更集中在运行时边界。
- 引擎 ID 与现有 `SessionSource` 分开；原生 Pi/远程会话不受新默认值误影响。
- OMP 原生工具和桌面宿主工具不是同一执行路径，权限覆盖需要证据。
- OMP 原生会话由 OMP 管理；桌面数据库仍归 Rust host-core，不做双重 transcript 写入。
- 使用结构化事件，复用已有协议/组件/测试；不解析终端输出，不预先设计多引擎大平台。
- 阶段失败如实记录，保持可回退的小范围变更，不将未运行验证标为通过。
