# 001 OMP 接入传输路径

状态:**已决定**(2026-09-22,M1 实验完成后,分支 `codex/m1-compatibility`)
决定范围:M1;影响 T08-T11 及后续所有 OMP 会话实现
证据:`docs/validation/M1-compatibility.md`、`app/experiments/omp-bridge/`(E01-E10 与 fixtures/results)

## 1. 决定

OMP 接入采用**独立子进程 + `--mode rpc-ui` 的 NDJSON JSON-RPC**,权限采用**受信扩展的 `tool_call` 前置钩子**,进程回收采用**桥接层进程组终止**作为兜底。不引入 SDK bridge,也不采用 ACP。

具体形态:

| 方面 | 决定 | 依据 |
| --- | --- | --- |
| 传输 | 子进程 stdin/stdout,每行一个 JSON 帧 | E01/E09;`negotiate_protocol` v2 可用,180 KB 多字节消息可往返 |
| 模式 | `rpc-ui`(不是 `rpc`) | E10:只有 rpc-ui 会 `setToolUIContext`,模型的工具表因此包含 OMP 自身的 `ask` 工具(12 项 vs 11 项) |
| 审批 | 受信扩展注册 `tool_call` 钩子,执行前返回 allow/deny | E04:拒绝时无文件/进程副作用;批准后只执行一次;钩子看到具体目标 |
| 审批问答通道 | 扩展 `ctx.ui.select/confirm/input/editor` → `extension_ui_request` | E03/E04/E10:`select` 带关联 ID,回答后 gate 才能放行 |
| 宿主工具 | `set_host_tools` + `host_tool_call`/`host_tool_result`;取消帧按 `targetId` 关联 | E08:模型可调用宿主工具并拿到结果;宿主工具同样经过 `tool_call` 钩子;放弃未应答调用会收到 `host_tool_cancel` |
| 子代理 | `set_subagent_subscription(events)` + `get_subagents`,三类 `subagent_*` 帧 | E08:真实 `task` 调用产生 `subagent_lifecycle`/`subagent_progress`/`subagent_event`,快照含 `parentToolCallId` 与 `sessionFile` |
| 会话 | 使用 OMP 原生会话,按 `sessionFile` 路径恢复 | E06:恢复不重放副作用、不重新审批;`branch` 生成新的原生会话文件 |
| 配置隔离 | 每实例独立 config root + agent dir,剥离凭证与 steering 环境变量 | E07:子进程环境中合成 Key 与 `OMP_PROFILE`/`XDG_*` 均不存在 |
| 取消 | `abort` + `abort_bash`,并必须附加进程组终止 | E05:`abort` 后运行中的命令进程仍存活,只有进程组终止才回收 |
| 桥接断开 | 不自行重连;断开即回收并由桌面重建 | E09:stdin EOF 与 stdout EPIPE 都会让 OMP 自行退出,进程组被回收 |
| 版本协商 | 只协商 v2,并把 ready 的 `supportedProtocolVersions` 当参考信息 | E01:广告 `[1,2]`,但 `negotiate_protocol: 1` 被明确拒绝(`rpc-mode.ts:1176`) |
| 进程监督 | 独立进程组,启动超时/崩溃/协议错误分类处理 | E09:ENOENT、退出码 3、永不 ready 分别归类,均被回收 |

## 2. 被否决的方案

| 方案 | 否决原因 |
| --- | --- |
| SDK bridge | RPC 已覆盖消息、工具、宿主工具、会话、取消与审批前置阻断;M1 未发现必须下沉到 SDK 的缺口。保留为后续备选。 |
| ACP | 面向编辑器客户端的另一套协议,不提供本项目需要的原生工具审批优先级;未做运行时对比,不采用。 |
| 普通 `--mode rpc` | 可用且有扩展对话能力,但 `hasUI=false` 使 OMP 自身的 `ask` 工具不注册,桌面会丢失"询问用户"能力。 |
| 桌面侧另建审批系统 | 与仓库规则冲突,且 E04/E08 已证明原生工具的 `tool_call` 钩子在执行前可达。 |
| 直接调用低层 Agent 包 | 不含完整 OMP 的工具、扩展、会话与 MCP 装配,不构成完整引擎。 |

## 3. 必须随之实现的约束

1. **停止路径不能只发协议命令**。E05 记录:在 rpc-ui(强制 `PI_NO_PTY=1`)下,`abort`+`abort_bash` 被确认,但运行中 bash 命令的操作系统进程仍存活;桥接层进程组终止可以回收。T09/T11 的停止实现必须包含此兜底,并据此判定"已终止"。
2. **审批发生在执行前**,依赖扩展钩子的同步返回;任何"先执行后弹窗"的实现都违反已验证语义。
3. **宿主工具与原生工具共用同一条钩子路径**(E08),因此宿主工具的执行也必须在桌面侧等待审批结果,不能因为"是自己注册的"就跳过。
4. **取消会连带取消挂起问答**。E05 显示挂起对话会收到带 `targetId` 的 `cancel`,gate 解析为 deny;E08 显示未应答的宿主工具调用同样收到 `host_tool_cancel`。两者都必须按 `targetId`(不是帧自身的 `id`)匹配并清理 pending UI/宿主任务,而不是重复弹窗或继续执行。
5. **渲染读取器必须有显式行长上限**。E09 显示非法 JSON 可恢复,但 Node `readline` 无行长限制;超长行必须以显式 `line-too-large` 错误并重新同步。
6. **配置根与凭证始终显式注入**,不依赖用户全局 profile(E07)。
7. **只协商 v2**。ready 广告 `supportedProtocolVersions: [1,2]`,但 v1 协商会被明确拒绝(E01,`rpc-mode.ts:1176`);桌面应要求该列表包含 2、协商 2,把 v1 请求当错误路径处理,而不是把它当作可回退选项。
8. **桥接断开后按"重建"处理**。E09 证明 stdin EOF 与 stdout EPIPE 都会让 OMP 自行退出且进程组被回收,因此桌面不需要"重连同一进程",而应把断开视为会话结束并按需重建。

## 4. 结论对应的 D 项

| 编号 | 结论 |
| --- | --- |
| D01 | 普通 RPC(rpc-ui)足以承载工具审批、取消与完整事件;不需要独立 SDK bridge |
| D02 | 完整会话来自 `omp --mode rpc-ui` 进程,不是低层 Agent 包 |
| D03 | 原生会话由 OMP 保存在其 agent dir;桌面只保存索引与展示投影 |
| D04 | 权限由受信扩展的 `tool_call` 钩子决策,原生工具与宿主工具都在执行前被阻断 |
| D05 | 部分:子代理事件与快照已实测(三类帧、`parentToolCallId`、`sessionFile`),父子关系的 UI 映射与停止边界留待 M5/T17 |
| D06 | 模型目录与配置可受控注入(隔离根);系统密钥存储命名留待 M4 |
| D07 | rpc 与 rpc-ui 的能力差异已实测记录;ACP 仅源码比对,不做运行时结论 |

## 5. 未决与再评估条件

- **MCP 工具暴露**:E07 证明隔离项目配置中的 MCP 服务器会被发现、启动并握手,但其工具未出现在模型工具表中(OMP 只广告 12 项核心工具)。该问题属于 T19/M5,不影响 M1 的隔离结论。
- **规则注入**:规则文件需要 frontmatter(`alwaysApply: true` 或 `description`)才会进入提示;M5 适配时需要按此语义实现 UI,避免"写了规则但不生效"。
- **平台差异**:进程终止只在 Linux 上实测;macOS arm64 需在 M6 重新验证。
- **子代理停止边界**:事件、进度、快照与父子关联已实测;父回合停止后子代理是否继续存活、如何单独停止,留待 T17/M5 测量。
- **版本协商的表面矛盾**:ready 广告同时支持 v1/v2,但协商只接受 v2(E01)。这是上游实现现状而非阻塞;桌面按"要求列表含 2、只协商 2"处理。
- **app 侧英文 ADR**:M1 未改动产品代码(`app/experiments/` 为未接入主流程的实验),冻结架构未变,因此不在 `app/docs/adr/` 另写英文 ADR。M2 把运行时边界落进产品代码(T09/T10)时,必须按上游规范补写英文 ADR,并从本文件链接。
- 重新评估触发条件:OMP 升级导致 `rpc-types.ts` 的帧协议、`tool_call` 钩子语义或 `main.ts` 的模式装配变化。
