# 001 OMP 接入传输路径

状态:**已决定**(2026-09-22,M1 实验完成后经两轮独立复审返修 R1-R6、F1-F6,分支 `codex/m1-compatibility`)
决定范围:M1;影响 T08-T11 及后续所有 OMP 会话实现
证据:`docs/validation/M1-compatibility.md`、`app/experiments/omp-bridge/`(E01-E13 与 fixtures/results)

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
| 取消 | 先协议内 `abort`(`abort_bash` 备用),再拆桥接;不能只杀进程组 | E05(重做):`abort` 回收了真实运行的命令进程及其子进程;不先停止就杀桥接进程组会留下孤儿,因为命令运行在自己的 session/进程组 |
| 子代理 | 子代理工具调用走同一条 `tool_call` 钩子,但其会话 **`hasUI=false`**,审批只能由桌面策略/带外通道决定;停止时其后台进程树必须显式终止 | E11(按会话身份路由重做):子代理 `write` 进入同一钩子(`hasUI=false`,与父会话 `sessionId` 不同);纯 UI 依赖的审批被立即拒绝;策略批准时由子代理恰好执行一次;父 `abort` 不回收 detached 子代理的运行中命令树 |
| 分片 | **出站**在客户端解码后参与响应匹配;分片故障视为致命;不向 OMP 发送 `rpc_chunk` | E13:关闭自动压缩后 `rpc.request()` 拿到 1,200,650 字节的完整重组响应;分片写回 stdin 得到 `Unknown command: rpc_chunk`,而 1.3 MB 单行命令可接受;E12:损坏序列后解码器无法重新同步,固定实现自身也把它当致命错误 |
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

1. **停止顺序:先协议内停止,再拆桥接**。E05 重做后记录:在顶层会话里 `abort` 就能回收真实运行的命令进程及其子进程;**不先停止就杀桥接进程组会留下孤儿**,因为命令进程有自己的 session/进程组(`/proc` 记账:命令的 `ppid` 是 OMP,但 `pgrp`/`session` 是它自己)。T09/T11 必须先 `abort`(必要时 `abort_bash`),确认回收后才允许结束进程组。
2. **四种终止情形分别处理**,不能互相替代(参见 R2 的进程组回收要求:组长退出后仍需按**进程组存活**升级 SIGKILL,否则同组抗 TERM 后代会被漏掉):
   - 顶层会话取消:先 `abort`(必要时 `abort_bash`),命令进程与后代会被回收(E05);
   - 真实子代理取消:父 `abort` **不回收** detached 子代理的运行中命令树,子代理仍被 `get_subagents` 报为运行中;必须显式终止其进程树,不能假设父回合结束等于子任务结束(E11-D);
   - 异常退出:不先停止就杀桥接进程组会留下孤儿(E05-3);实验/宿主被强杀时,运行时靠 stdin EOF 自退出,但隔离目录需要兜底清理(E12-F2);
   - 兜底清理:桌面侧必须能按"本轮拥有的资源"回收运行时、后代与隔离目录(M2/T09);E12 的实现可作为参考——**先按进程组存活终止(组长退出不豁免),再按环境归属兜底,最后按所有权删除本轮运行根**。归属判据是进程环境引用本轮的隔离根或它属于该组的进程组成员,不是进程名。第四轮复审补强(R2):**回收失败必须使验收失败**(非零退出并把原因写进结果),不得把异常吞掉后仍报成功;清理未完成的登记必须保留以便重试,主动保留产物(`--keep-artifacts`)不算失败。
3. **审批发生在执行前**,依赖扩展钩子的同步返回;任何"先执行后弹窗"的实现都违反已验证语义。子代理的工具调用同样经过这条钩子(E11),因此审批路由不能只挂在父会话上。
4. **宿主工具与原生工具共用同一条钩子路径**(E08),因此宿主工具的执行也必须在桌面侧等待审批结果,不能因为"是自己注册的"就跳过。
5. **取消挂起问答的覆盖范围分两种,不能互相外推**。父会话(有 UI)的挂起对话确实会被 OMP 取消:E05 收到带 `targetId` 的 `cancel` 且 gate 解析为 deny;E08 显示未应答的宿主工具调用收到 `host_tool_cancel`。但**子代理的挂起审批不会被父停止取消**——复审 R1 的实测推翻了此前结论:父 `abort` 返回成功后子代理仍为 `running`,没有任何取消帧,延迟 300 ms 写入的 `allow` **会让子代理真的写入文件**(旧结论里的"deny"只是实验自己的等待超时)。因此桌面必须像原桌面 `permissions.cancel()` 那样**自己实现撤销**:删除 pending、以 Deny 唤醒等待方、并把迟到决定当作 NOT_FOUND 拒绝。E11 现用桥接侧取消标记实现了这套语义并验证"停止后旧审批不再放行",该能力**来自桥接,不是 OMP 自带**。所有取消都必须按 `targetId`(不是帧自身的 `id`)匹配。

   第五轮复审补强(F1):决定被消费前的任何 I/O 失败(**读取**或**消费写入**)都不得当作放行——写失败会让同一份 `allow` 授权后续所有调用(真实子代理已复现两次写入),读取失败则无法证明决定内容。两者都 fail-closed:显式 block 并记录 `child-consume-failed` / `child-decision-unreadable`。对照:PI `permissions.resolve` 先 remove pending 再发决定(重复请求 NOT_FOUND),OMP `emitToolCall` 对钩子异常/超时同样 fail-closed。

   第四轮复审补强(R1):取消必须对**尚未执行**的调用具有决定权——"决定文件比取消文件更早落盘"不构成放行理由(旧实现按 mtime 比较,已被真实 OMP 探针证伪并修复);等待循环每轮先查取消标记,决定按 `toolCallId` 归属且**单次消费**(应用后改写为 `consumed <id>`),不得复用到另一个调用。
6. **渲染读取器必须有显式行长上限**。E09 显示非法 JSON 可恢复,但 Node `readline` 无行长限制;超长行必须以显式 `line-too-large` 错误并重新同步。
7. **配置与凭证按 HOME 边界隔离**。仅改 `PI_CONFIG_DIR` 不够,因为 OMP 还会在 home 下发现 `~/.agent`、`~/.agents`、`~/.omp` 等目录;E07 现在把子进程 `HOME` 指向运行目录内的合成家目录,并额外剥离 `CLAUDE_CONFIG_DIR`/`COPILOT_HOME`/`GH_CONFIG_DIR`/`MISE_DATA_DIR`/`OMP_WORKTREE_DIR`/`PI_CONFIG_FILES` 等重定向变量。
8. **代理环境同样要按边界归一化**。第五轮复审补强(F2):只覆盖大写代理变量不够——子进程会继承小写 `http_proxy`/`https_proxy`/`all_proxy`/`no_proxy` 并真的经其发出 HTTP 与 CONNECT(实测)。隔离必须按 PI `network-proxy.ts` 的 `PROXY_ENV_KEYS`(大小写各四组 + `NODE_USE_ENV_PROXY`)**先全量剥离,再施加自身策略**,与 `host-process.ts` 的"先 stripProxyEnv 再叠加"一致;这是进程环境策略,不等于操作系统级网络沙箱。
9. **子代理审批必须由桌面策略决定**。E11 实测:子代理会话 `hasUI=false`,OMP 不为子代理提供 UI,所以"弹窗让用户批准子代理的每一次工具调用"**不可实现**。桌面需要二选一或组合:父会话在派发时授予子代理一个明确的能力范围(策略放行/拒绝),或通过带外通道把决定送回运行中的子代理会话。本项目的 M1 实验用 `M1_CHILD_POLICY`(allow/deny/defer)模拟该策略,并验证了"等待中的子代理审批在父会话停止后解析为拒绝且无副作用"。
10. **只协商 v2**。ready 广告 `supportedProtocolVersions: [1,2]`,但 v1 协商会被明确拒绝(E01,`rpc-mode.ts:1176`);桌面应要求该列表包含 2、协商 2,把 v1 请求当错误路径处理,而不是把它当作可回退选项。
11. **等待中的协议/流错误要按实际错误返回**。R4 实测:请求发出后流里出现损坏分片时,客户端必须把真实错误(`chunk decode failed: …`)返回给调用方并立即结束等待,只有真正超时才归类为 timeout;这与原桌面 `host-process.ts` 的 `closeTransport(error)` 语义一致(清除 pending 定时器、用真实错误拒绝待完成请求)。
12. **不要向 OMP 发送分片帧**。E13 记录:`rpc_chunk` 只有出站方向被支持,把分片写回 stdin 会得到 `Unknown command: rpc_chunk`;超大命令应作为**单行**发送(实测 1.3 MB 单行被接受并完整送达模型),而 OMP 自身超过 1 MiB 的帧必须由桌面按 5 片/组那样的序列重组。
13. **分片故障按致命处理**。E12 实测:固定解码器在一次分片错误后无法重新同步(后续每个帧都被拒),OMP 自己的客户端也没有在读取循环里捕获解码异常,因此桌面必须把分片故障视为会话终结:让挂起请求快速失败并重启运行时,而不是继续复用该流。
14. **桥接断开后按"重建"处理**。E09 证明 stdin EOF 与 stdout EPIPE 都会让 OMP 自行退出且进程组被回收,因此桌面不需要"重连同一进程",而应把断开视为会话结束并按需重建。

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
- **子代理的停止与审批**:已实测父 `abort` 不回收 detached 子代理的命令树、子代理无 UI 因而无法交互审批;桌面如何下发子代理能力范围、如何单独停止子代理,属 M2/T10-T11 与 T17。
- **版本协商的表面矛盾**:ready 广告同时支持 v1/v2,但协商只接受 v2(E01)。这是上游实现现状而非阻塞;桌面按"要求列表含 2、只协商 2"处理。
- **app 侧英文 ADR**:M1 未改动产品代码(`app/experiments/` 为未接入主流程的实验),冻结架构未变,因此不在 `app/docs/adr/` 另写英文 ADR。M2 把运行时边界落进产品代码(T09/T10)时,必须按上游规范补写英文 ADR,并从本文件链接。
- 重新评估触发条件:OMP 升级导致 `rpc-types.ts` 的帧协议、`tool_call` 钩子语义或 `main.ts` 的模式装配变化。
