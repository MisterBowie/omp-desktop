# M1 兼容性实验记录

记录时间:2026-09-22
工作目录:`/home/vv/person/code/omp-desktop-m1`(M1 专用分支 `codex/m1-compatibility` 的 worktree)
结论:**13/13 实验通过,396/396 检查通过**;接入路径已定案,见 `docs/decisions/001-omp-transport.md`。

> 本文件已被一次独立复审返修(R1-R6)。返修前版本的 E05 取消结论**无效并已撤回**,隔离、子代理权限、协议分片、工具链健壮性均有新证据;逐项处理见 §8。

## 1. 环境与基线

| 项目 | 值 |
| --- | --- |
| 系统 | Linux x86_64,内核 7.0.0-31-generic(kernel #31~24.04.1-Ubuntu)。依赖 `/proc` 的验证(E05/E11 的进程组记账、E07 读取子进程 `/proc/<pid>/environ`、E12 的环境归属回收)只在 Linux 上执行并通过;这些路径在其他平台需要各自的等价实现,不能把本机结论直接外推(macOS/Windows 见未执行项) |
| Node | v24.14.0(`nvm use 24`) |
| Bun | 未在 PATH;由锁定源码的 `scripts/omp` 启动脚本内部 `exec bun` |
| Rust | 1.95.0(本次实验未使用) |
| OMP 源码 | `upstream/oh-my-pi` @ `d49918fab2dba3986927f2d46721629ed0f3a02c`(v18.2.7) |
| PI-Desktop 源码 | `upstream/pi-desktop` @ `0111e306c120ad5820688d7608cb37bad8fbcc1f` |
| 启动器 | `upstream/oh-my-pi/packages/coding-agent/scripts/omp --mode rpc-ui` |
| 模型 | 全部为本地假 provider(`http://127.0.0.1:<port>/v1`),**无任何付费模型调用** |

工作树状态:所有 M1 产物为新增未跟踪文件(`app/experiments/`、`docs/decisions/`);未提交。上游子模块未修改。

## 2. 可重复命令

```bash
cd app/experiments/omp-bridge
source "$HOME/.nvm/nvm.sh" && nvm use 24
node run-all.mjs                     # 全部实验,约 78 秒
node run-all.mjs e04 e05             # 子集
node e04-approval.mjs                # 单个实验;加 --keep-artifacts 保留临时目录
```

每个实验自建隔离目录(配置根 `~/.omp-m0-<hex>`、agent dir、cwd),结束后回收进程组并删除临时根。结果写入 `results/<name>.json`,脱敏 fixture 写入 `fixtures/<name>.json`。

总结果:`experiments: 13/13 passed | checks: 396/396`,退出码 0,耗时 205.5 秒;汇总写入 `results/summary.json`,逐实验明细写入 `results/<name>.json`。汇总现在按「退出码 0 + 无信号 + PASS + 结果文件存在/命名/`ok` 一致 + 本轮运行标识」判定,不再只看 PASS 文本。

清理验证:正常结束时 `.dev-data/m1/` 运行目录与 `~/.omp-m0-*` 配置根均为 0 个残留,无遗留 OMP 进程(被 `SIGKILL`/管道中断的临时调试运行会留下残留,已清理并确认与正式路径无关)。

## 3. 逐实验结果

| 实验 | 命令(`app/experiments/omp-bridge/` 下) | 退出码 | 检查 | 结论要点 | 证据 |
| --- | --- | --- | --- | --- | --- |
| E01 协议启动 | `node e01-protocol.mjs` | 0 | 26/26 | `ready` + `negotiate_protocol` v2;帧限制 1 MiB / 64 MiB;v1 协商被明确拒绝 | `e01-handshake.json` |
| E02 消息循环 | `node e02-turn.mjs` | 0 | 12/12 | 文本/思考/工具调用事件序列;`prompt` 立即应答,`agent_end` 才是回合结束 | `e02-turn-events.json` |
| E03 交互 | `node e03-interaction.mjs` | 0 | 23/23 | `select`/`confirm`/`input` 的关联 ID 与响应结构;取消、超时与 pending 清理 | `e03-ui-exchange.json` |
| E04 权限阻断 | `node e04-approval.mjs` | 0 | 29/29 | 拒绝无文件/进程副作用;批准只执行一次;钩子看到具体目标 | `e04-allow-write.json`、`e04-deny-write.json` |
| E05 取消 | `node e05-cancel.mjs` | 0 | 28/28 | 用真实外部程序验证:顶层 `abort` 回收命令进程及其子进程;不先停止就杀桥接进程组会留下孤儿;挂起对话按 `targetId` 取消 | `e05-abort-events.json` |
| E06 持久化 | `node e06-session.mjs` | 0 | 23/23 | 原生会话文件位置;按路径恢复不重放、不重新审批;`branch` 生成新原生文件 | `e06-session-state.json` |
| E07 配置隔离 | `node e07-isolation.mjs` | 0 | 23/23 | 只加载隔离模型;规则进提示;MCP 服务器被发现并握手;子进程无凭证/steering 变量 | `e07-isolation-env.json` |
| E08 子代理与工具桥 | `node e08-host-tools.mjs` | 0 | 23/23 | 宿主工具往返与取消(`targetId` 关联);子代理三类事件帧与存活期快照;宿主工具同样过 `tool_call` 钩子 | `e08-host-tool-exchange.json`、`e08-host-tool-cancel.json`、`e08-subagent-events.json` |
| E09 传输边界 | `node e09-transport.mjs` | 0 | 30/30 | 跨块 UTF-8、半帧、CRLF、非法 JSON 恢复、超长行、180 KB 多字节往返;stdin EOF / stdout EPIPE 自退出并回收 | `e09-degraded-runtimes.json` |
| E10 模式差异 | `node e10-modes.mjs` | 0 | 18/18 | 两种模式都有扩展对话通道;只有 rpc-ui 广告 `ask` 工具 | `e10-mode-capabilities.json` |
| E11 子代理权限与取消 | `node e11-subagent-permissions.mjs` | 0 | 42/42 | 按**会话身份**路由后:子代理工具调用进入同一 `tool_call` 钩子但 `hasUI=false`,不能弹窗;审批须由桌面策略决定(拒绝无副作用/批准执行一次);父停止不取消其挂起审批(R1)也不回收其命令树 | `e11-subagent-allow.json`、`e11-subagent-deny.json`、`e11-subagent-cancel.json`、`e11-subagent-pending-cancel.json` |
| E12 工具链故障回归 | `node e12-harness-faults.mjs` | 0 | 76/76 | 非法帧不崩溃且有界清理;汇总按「退出码+信号+PASS+结果文件+运行标识」判定;被杀实验的运行时/同组抗 TERM 后代/整棵临时运行根被有界回收(组长退出不豁免);**取消对未执行调用具有决定权且决定单次消费**;**回收失败进入验收并非零退出**;流错误与超时分类正确;参数选择集合正确 | `e12-invalid-frames.json`、`e12-aggregator-verdicts.json`、`e12-runtime-reaping.json`、`e12-chunk-error-handling.json`、`e12-arg-parsing.json` |
| E13 协议 v2 分片 | `node e13-chunking.mjs` | 0 | 30/30 | 关闭自动压缩后,1.2 MB 提示产生真实分片,`rpc.request()` 经客户端解码后拿到 1,200,650 字节完整响应;入站分片被拒绝;缺片/重复/乱序/非法元数据/超限均有判定 | `e13-real-chunk-sample.json`、`e13-inbound-chunks.json`、`e13-chunk-faults.json` |

## 3.1 M0 回归复跑

在 M1 分支上复跑 M0 的验证资产,确认新增实验没有破坏既有能力:

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node docs/validation/M0-rpc/verify-rpc.test.mjs` | 0 | `pass 18 / fail 0`(假进程驱动的分帧、隔离、进程组回收测试) |
| `node docs/validation/M0-rpc/verify-rpc.mjs` | 0 | `PASS: ready + negotiate_protocol(v2) + get_available_models`,1.28 s(见 §8.3 C1:修订前在本机因出站发现黑洞化耗时 10 s 而失败) |

真实无费用 RPC 复跑的关键输出:

```text
gitlink SHA  : d49918fab2dba3986927f2d46721629ed0f3a02c
submodule SHA: d49918fab2dba3986927f2d46721629ed0f3a02c
pinned ver   : 18.2.7 (reported 18.2.7)
scope        : {"agentDirInRunRoot":true,"launchDirInRunRoot":true,"configRootNotUserOmp":true,"configRootIsolatedName":true}
ready        : {"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
negotiate    : {"id":"m0","type":"response","command":"negotiate_protocol","success":true,"data":{"protocolVersion":2}}
models       : local-model
```

帧限制(1 MiB / 64 MiB)与 `supportedProtocolVersions` 即来自这次复跑的 ready 帧。该 ready 帧里的 `protocolVersion: 1` 是"帧层当前版本",不是可协商命令版本,见 E01 的 v1 拒绝结论。

## 3.2 Fixture 来源

`fixtures/` 下每个文件都在 `note` 字段自述来源。归类:

| Fixture | 来源 | 说明 |
| --- | --- | --- |
| `e01-handshake.json` | 真实采集 | 本地假模型 provider;无凭证 |
| `e02-turn-events.json` | 真实采集 | 该实验单独使用 `--approval-mode yolo` |
| `e03-ui-exchange.json` | 真实采集 + 合成答复 | 帧为真实,答复值是实验自己构造的 |
| `e04-allow-write.json` / `e04-deny-write.json` | 真实采集 + 合成答复 | 审批结论来自实验注入的选择 |
| `e05-abort-events.json` | 真实采集 | 只保留事件类型与 abort 应答 |
| `e06-session-state.json` | 真实采集 | 路径都落在该次运行的隔离 agent dir 内 |
| `e07-isolation-env.json` | 真实采集 | **只记录变量名,不记录环境变量值** |
| `e08-host-tool-exchange.json` | 真实采集 | 宿主工具往返 |
| `e08-host-tool-cancel.json` | 真实采集 | 宿主故意不应答,采集取消帧 |
| `e08-subagent-events.json` | 真实采集 | 子代理由本地假 provider 驱动 |
| `e09-degraded-runtimes.json` | **合成故障样本** | 运行时是实验自己写的桩脚本,只有读取器的分类结果是被观察行为 |
| `e10-mode-capabilities.json` | 真实采集 | 两种模式跑同一场景 |
| `e11-subagent-allow.json` / `e11-subagent-deny.json` | 真实采集 + 合成答复 | 子代理驱动的写入,审批结论由实验注入 |
| `e11-subagent-cancel.json` | 真实采集 | 子代理运行真实外部程序;回收结果为实测 |
| `e11-subagent-pending-cancel.json` | 真实采集 | 子代理挂起对话被父停止取消 |
| `e12-invalid-frames.json` | **合成故障样本** | 桩运行时输出非法帧,只有客户端分类是被观察行为 |
| `e12-aggregator-verdicts.json` | **合成故障样本** | 桩实验的退出码/信号/结果文件组合 |
| `e12-runtime-reaping.json` | **合成故障样本** | 桩实验启动真实运行时后被超时杀死,验证回收 |
| `e12-chunk-error-handling.json` | **合成故障样本** | 桩运行时发出损坏的分片序列 |
| `e12-arg-parsing.json` | **合成故障样本** | 参数组合与桩实验执行集合 |
| `e12-stream-error-vs-timeout.json` | **合成故障样本** | 请求在途时流被破坏,R4 的分类回归 |
| `e12-cancel-decision-semantics.json` | **合成故障样本** | 直接驱动真实 gate 模块:取消/决定顺序、作用域与单次消费(第四轮 R1) |
| `e12-cleanup-verdict.json` | **合成故障样本** | 桩实验通过但 scratch 不可删除,汇总必须失败(第四轮 R2) |
| `e13-real-chunk-sample.json` | 真实采集 | 固定 OMP 真实发出的 `rpc_chunk` 结构 |
| `e13-inbound-chunks.json` | 真实采集 | 向 stdin 发送合法分片后的真实反应 |
| `e13-chunk-faults.json` | **合成故障样本** | 用移植编码器生成再破坏的分片序列 |

真实采集的样本均已检查不含密钥形状字符串;合成样本只包含桩脚本的行为分类,不冒充真实 OMP 输出。

## 4. 传输能力矩阵

图例:`实测` = 本机真实进程 + 断言;`源码推断` = 只读源码得出,未运行;`未验证` = 未触及;`不支持` = 已确认无法做到。

| 能力 | `--mode rpc` | `--mode rpc-ui` | SDK(`sdk.ts`) | ACP(`modes/acp/`) |
| --- | --- | --- | --- | --- |
| ready / `negotiate_protocol` v1+v2 | 实测 | 实测 | 未验证 | 未验证 |
| `maxFrameBytes` / `maxReassembledFrameBytes` | 实测(1 MiB / 64 MiB) | 实测(同左) | 未验证 | 未验证 |
| prompt / 文本 / 思考 / 工具事件 / `agent_end` | 实测 | 实测 | 未验证 | 未验证 |
| 扩展对话(`extension_ui_request` 的 select/confirm/input/editor) | 实测 | 实测 | 源码推断(`setToolUIContext` 注入 `toolContextStore`) | 源码推断(自有 UI context) |
| 工具级 UI(OMP 自身 `ask` 工具、需要 `hasUI`) | **不支持**(`hasUI=false`,`ask` 不注册) | 实测(工具表 12 项,含 `ask`) | 源码推断(`sessionOptions.hasUI` 可控) | 源码推断 |
| `tool_call` 执行前钩子(原生工具) | 实测 | 实测 | 源码推断 | 源码推断 |
| `tool_call` 执行前钩子(宿主工具) | 未验证 | 实测(同一条钩子) | 未验证 | 未验证 |
| `set_host_tools` / `host_tool_call` / `host_tool_result` | 未验证 | 实测 | 未验证 | 未验证 |
| `host_tool_cancel`(按 `targetId` 关联) | 未验证 | 实测 | 未验证 | 未验证 |
| 子代理 `subagent_lifecycle` / `subagent_progress` / `subagent_event` | 未验证 | 实测 | 未验证 | 未验证 |
| 会话新建/命名/按路径恢复/分支 | 未验证 | 实测 | 未验证 | 未验证 |
| 取消(`abort` / `abort_bash`) | 未验证 | 实测:顶层会话 `abort` 回收真实命令进程及其子进程 | 未验证 | 未验证 |
| 分片(`rpc_chunk`,出站重组) | 未验证 | 实测(真实 5 片/组样本) | 未验证 | 未验证 |
| 分片(入站,发往 OMP) | 未验证 | **不支持**(`Unknown command: rpc_chunk`) | 未验证 | 未验证 |
| 超过 1 MiB 的单行命令 | 未验证 | 实测(1.3 MB 单行被接受并完整送达) | 未验证 | 未验证 |
| 子代理工具调用经过 `tool_call` 钩子 | 未验证 | 实测(拒绝无副作用/批准一次) | 未验证 | 未验证 |
| 桥接断开清理(stdin EOF / stdout EPIPE) | 未验证 | 实测(OMP 自退出并被回收) | 未验证 | 未验证 |
| 终端桥接(`createTerminal` 交给客户端) | 未验证 | 不适用(rpc-ui 强制 `PI_NO_PTY=1`) | 未验证 | 源码推断 |
| MCP / 规则 / 模型目录发现 | 未验证 | 实测(隔离根内生效) | 未验证 | 未验证 |

**结论**:`rpc-ui` 是唯一同时具备"扩展执行前审批"与"工具级 UI(含 OMP 自身 `ask`)"的实测可用路径,因此为主路径;SDK 与 ACP 未被 M1 排除,只是没有需要它们的缺口,也未做运行时对比。SDK 仅在 rpc-ui 出现无法绕过的限制时作为备选,届时应先补最小验证。

## 5. 关键行为证据

**权限前置阻断(E04)** — 4 个场景(允许/拒绝 × write/bash):扩展 `tool_call` 钩子在执行前拿到工具名与具体目标(`guarded.txt`、命令中的标记路径),返回 deny 后目标文件不存在、命令未产生任何输出;返回 allow 后文件内容恰好写入一次。阻断发生在工具真正执行之前,不是事后弹窗。

**取消的真实边界(E05,复审 R1 后重做)** — 旧结论「`abort` 不回收命令、只有进程组终止才回收」**已撤回**:它建立在一个从未真正运行的命令上(`echo $$ > pid; exec sleep 300` 在 OMP 内嵌 shell 里报 `command not found: exec`,退出码 127,而且 `$$` 不是外部命令的 PID),当时被观测的"存活进程"根本不是被测命令。E05 现用真实外部程序 `tools/long-task.mjs` 重做:该程序自行写入自己的 `process.pid`、父 PID 和子进程 PID,并一直运行到被终止,因此结论不再依赖 shell 内建变量或名称匹配。

重做后的实测(身份各不相同:被测进程 ≠ OMP PID ≠ 测试进程):

| 停止手段 | 顶层会话中的命令进程 | 该命令的子进程 |
| --- | --- | --- |
| `abort`(协议内) | **被回收** | **被回收** |
| `abort_bash` | 已被上一步回收 | 已被上一步回收 |
| 直接杀桥接进程组(不先停止) | **未回收,成为孤儿** | **未回收,成为孤儿** |
| 先 `abort` 再拆桥接 | 被回收 | 被回收 |

机制来自 `/proc` 记账:命令进程的 `ppid` 等于 OMP PID,但它的 `pgrp`/`session` 是**它自己的**,所以杀掉 OMP 的进程组根本触达不到它。挂起对话仍会收到带 `targetId` 的 `cancel`,gate 解析为 `deny` 且无副作用。

**子代理的权限覆盖与取消(E11,复审 F1 后重做)** — 旧版本**无效**:它用一条共享的顺序响应队列驱动父会话与子代理,而子代理是异步启动的,于是父会话抢先消费了本该给子代理的 `write` 轮次;"子代理审批"的结论实际上全部来自父会话。现在按**会话身份**路由(子代理的派发文本是它自己会话的第一条 user 消息),并断言归属:父会话 `task` 钩子 `hasUI=true` 而子代理 `write` 钩子 `hasUI=false`、两者 `sessionId` 不同、子代理 `parentToolCallId` 等于父会话 `task` 的 `toolCallId`、父会话从未自己发起 `write`。

重做后的实测:

| 场景 | 结果 |
| --- | --- |
| 子代理工具调用是否经过同一条钩子 | **经过**,且带子代理自己的目标路径 |
| 子代理能否向用户弹窗 | **不能**,`hasUI=false`,OMP 不提供子代理 UI |
| 纯 UI 依赖的审批结果 | 立即拒绝(`denied: no UI available for approval`),无对话、无副作用 |
| 桌面策略拒绝/批准 | 策略拒绝无副作用;策略批准时由**子代理**恰好写入一次 |
| 带外审批等待中停止父会话 | 停止 25 ms 返回、会话可响应、无副作用;挂起的子代理审批随后解析为拒绝 |
| 子代理执行真实长任务时停止父会话 | 父 `abort` **不回收** detached 子代理的命令进程与后代(`get_subagents` 仍报 1 个运行中);显式进程树终止可回收 |

架构影响:子代理的工具调用在**执行前**可达且可阻断,但无法向用户提问,所以桌面的审批方案必须是"父会话交互决定 + 子代理按策略/带外通道决定"的两段式(或直接把子代理的能力限制在策略允许的范围内),不能假设子代理继承父会话的 UI。

**宿主工具、取消与子代理(E08)** — `set_host_tools` 注册的工具能被模型调用,`host_tool_result` 会回灌给模型;扩展的 `tool_call` 钩子同时观察到宿主工具与原生工具(`["m1_host_echo","write"]`),因此"注册宿主工具"不等于绕过审批。放弃未应答的宿主工具调用(改发 `abort`)会收到 `host_tool_cancel`,**关联字段是 `targetId` 而不是它自己的 `id`**,桌面必须按 `targetId` 匹配。真实 `task` 调用产生了 `subagent_lifecycle`/`subagent_progress`/`subagent_event` 三类帧,`get_subagents` 在子代理存活期间返回带 `parentToolCallId`、`sessionFile`、`status` 的条目(子代理结束后会从注册表移除)。

**模式差异实测(E10)** — 纠正了仅凭源码的初判:两种模式都能投递扩展对话,但 `main.ts:2085` 的 `hasUI` 只对 rpc-ui 为真,`setToolUIContext` 只在 rpc-ui 装配,结果是 rpc-ui 广告 12 项工具(含 `ask`),普通 rpc 只有 11 项。桌面若用普通 rpc 会丢失 OMP 自身的询问用户能力。

**配置隔离(E07)** — 子进程实际环境(`/proc/<pid>/environ`)中不存在注入的合成 `OPENAI_API_KEY`,也不存在 `OMP_PROFILE`、`PI_PROFILE`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`;可见模型只有本实例的两个;`agent.db`、`sessions/`、日志都落在隔离根;配置根为 `~/.omp-m0-<hex>` 而非 `~/.omp`。

## 6. 未执行项与剩余风险

| 项 | 状态 | 原因 / 后续 |
| --- | --- | --- |
| MCP 工具进入模型工具表 | 未通过 | 隔离配置的 MCP 服务器被发现、启动并完成 `initialize`/`tools/list`,但其工具未出现在模型工具表中(OMP 只广告 12 项核心工具);归属 T19/M5 |
| 子代理的交互式审批 | **不支持** | E11 实测:子代理会话 `hasUI=false`,OMP 不提供子代理 UI,因此无法向用户弹窗;桌面必须用策略或带外通道决定(E11 用 `M1_CHILD_POLICY`/决策文件模拟),真正的桌面策略属 M2/T10-M11 |
| 子代理挂起审批的取消 | **OMP 不支持** | R1 实测:父 `abort` 成功后子代理仍 `running`、无取消帧、迟到 allow 会真的执行;E11 现由**桥接侧取消标记**实现"停止后不能放行",桌面需在 M2/T09 自建同等机制 |
| 离开进程组且不带归属环境的进程 | **不能归属** | R2 边界用例:该进程既不在本轮进程组、环境也不引用本轮隔离根,回收器**不声称覆盖**;产品侧需在启动工具时自行记录归属(`tools/mod.rs` 的 ProcessOwnership/Job Object 是参考) |
| 分片损坏后的恢复 | **不支持** | E12 实测:固定解码器无重新同步路径,一次分片错误后后续帧全部被拒;OMP 自己的客户端也把它当作致命错误(读取循环外无 try/catch),桌面应重启运行时 |
| 真实付费模型烟测 | 未执行 | 按仓库规则需用户明确指定提供方与预算 |
| ACP / SDK 运行时对比 | 未执行 | 仅源码比对;M1 选定 rpc-ui 后不再需要,不作为已对比结论 |
| macOS / Windows 进程终止 | 未覆盖 | 本机为 Linux;终止语义按自写 PID 校验,跨平台留待 M6/T23 |
| 系统密钥存储命名隔离 | 未覆盖 | 环境变量层已证明隔离;系统钥匙串命名属 M4/T22 |
| 可执行文件版本不匹配 | 未覆盖 | E09 覆盖了缺失(ENOENT)、立即崩溃、永不 ready;"存在但版本错误"的判定属启动监督逻辑,归 M2/T09 |
| 分片丢失/重复的实际传输 | 未覆盖 | E13 用合成序列验证了缺片/重复/乱序/非法元数据的判定;真实链路上这些故障未人为制造 |
| 桌面侧重连策略 | 未实现 | E09 证明桥接断开时 OMP 会自退出并被回收;是否自动重连由 M2/T09 决定 |
| 子代理的恢复/重启边界 | 未验证 | E11 已实测"父停止不回收子代理命令树、显式进程树终止可回收";重启与恢复语义留待 T17/M5 |

已知缺口(不掩盖):**停止必须按"先协议内停止、后拆桥接"的顺序执行,并且子代理的后台进程树必须显式终止**。E05 实测:不先停止就杀桥接进程组会留下孤儿命令树(命令运行在自己的 session/进程组);E11 实测:父会话 `abort` 不会回收子代理(detached)正在运行的命令树,而显式的进程树终止可以回收。这两条结论都来自真实外部程序的 PID 校验,不是推断。

## 7. 下一阶段条件

M2 可以开始,前置条件已满足:RPC(rpc-ui)覆盖消息、会话恢复与执行前权限链路,并有脱敏 fixture 与可重复命令。M2 必须把 E05 的进程回收结论落进 T09 的进程监督实现,并按 `docs/decisions/001-omp-transport.md` §3 的十条约束执行。

## 8. 独立复审返修记录(R1-R6)

复审对象:`32e9245`(M1 首次交付)。每项都先复现缺口,再修复并回归;新结论只依据可复现证据。

| 编号 | 复现到的缺口 | 处理 | 回归证据 |
| --- | --- | --- | --- |
| R1 [P1] | `fixtures/e05-abort-events.json` 里记录着 `command not found: exec`、`exitCode 127`:E05 的命令从未运行,`$$` 也不是外部命令 PID,因此"abort 不回收命令"的结论无效 | 新增真实外部程序 `tools/long-task.mjs`(自写 pid/ppid/子进程 pid,运行到被终止);E05 重做并记录 OMP/命令/子进程三种身份、`/proc` 进程组记账、四种停止路径;断言全部在测试侧兜底清理之前完成 | E05 28/28;`results/e05-cancel.json` 的 `parentGoneAfterAbort`、`bridgeKillProcessReclamation`、`orderlyStopReclamation` |
| R2 [P1] | 客户端沿用真实 `HOME`,而 OMP 还会发现 `~/.agent`、`~/.agents`、`~/.omp`,只改 `PI_CONFIG_DIR` 不足够;E07 还读取真实用户配置做对照 | `lib/base.mjs` 增加严格隔离:`HOME`→运行目录内的合成家目录,预建 `.agent/.agents/.omp/.claude/.config`,并额外剥离 9 个重定向变量;E07 增正对照(合成 HOME 的规则必须生效)与反对照(decoy HOME 的规则/技能必须不生效),并删除对真实用户配置的读取;`stop()` 连同合成 HOME 一起回收 | E07 36/36;`configRoot` 落在 `<runRoot>/home/.omp-m0-*`;真实用户家目录中新增隔离根数为 0 |
| R3 [P1] | 子代理只被证明能回文本,没有审批覆盖与执行中取消的证据 | 新增 E11:用本地假 provider 驱动真实子代理写文件(拒绝/批准两条)与运行受控长任务,验证覆盖、无副作用、父停止与挂起对话清理 | E11 28/28;子代理 `write` 进入同一钩子且 `targetId` 取消生效;父 `abort` 不回收 detached 子代理命令树(记为限制),显式进程树终止可回收 |
| R4 [P2] | E09 的 180 KB 远低于 1 MiB 帧阈值,没有任何真实 `rpc_chunk` 证据 | 新增 E13:确定触发条件(1.2 MB 提示 → 5 片/组真实分片),移植固定实现的解码器(常量与拒绝规则一致)做重组校验;实测入站分片被拒绝、单行超限命令可接受;补齐缺片/重复/乱序/非法元数据/超限等用例 | E13 34/34;`e13-real-chunk-sample.json` 为真实采集,`e13-chunk-faults.json` 标注为合成 |
| R5 [P2] | 启动阶段收到 `null` 等非法帧时 `f.type` 抛异常并绕过 `stop()`,子进程残留 | `lib/rpc.mjs` 增加帧结构校验(非对象/无字符串 `type` → `__invalid__`),`#start` 的所有失败路径统一走有界 `stop()`;新增 `launcher` 测试接缝以便对着桩运行时验证 | E12 16/16;`R5` 用例:启动失败被报成就绪失败而非 TypeError、无残留进程、无残留合成 HOME |
| R6 [P2] | `run-all.mjs` 只看 PASS 文本,子实验打印 PASS 后退出 9 仍算通过并返回 0 | 通过条件改为「退出码 0 + 未被信号终止 + PASS + 结果文件存在且 `experiment` 匹配且 `ok: true`」;超时按**进程组**回收实验自身启动的 OMP;新增 `--dir` 与 `M1_EXPERIMENT_TIMEOUT_MS` 以便端到端回归 | E12 16/16;六种不诚实桩实验全部被拒且汇总退出 1,唯一诚实桩被接受;超时桩的孙进程被回收 |

## 8.1 第二轮独立复审返修(F1-F6)

复审对象:`1156d0e`。同样先复现、再修复、再回归。

| 编号 | 复现到的缺口 | 处理 | 回归证据 |
| --- | --- | --- | --- |
| F1 [P1] | E11 用共享顺序队列驱动父/子两个会话,父会话抢先消费了本应属于子代理的 `write` 轮次;独立复现显示真实子代理 `toolCount=0` 而实验仍"通过" | 假 provider 增加**按会话身份路由**(以子代理派发文本作为其首条 user 消息的判据,不靠延迟);E11 重写并断言父/子 `sessionId`、`hasUI`、`parentToolCallId` 与 `task` 的 `toolCallId` 一致、父会话未自行 `write` | E11 40/40;`e11-subagent-{allow,deny}.json` 记录父子两个 sessionId;真实子代理路径为 `hasUI=false` |
| F2 [P1] | 汇总器超时只杀实验进程组,而运行时是 `detached`,实验的 `finally` 不执行 → 运行时进程、其后代与隔离目录残留 | 新增 `lib/runtime-registry.mjs`:启动时登记(pid/进程组/隔离根/运行标识/宿主 pid),正常停止时注销;汇总器在**每个**实验结束后按本轮运行标识做有界回收(组终止 → 环境归属清扫 → 删除隔离根)。归属判据是进程环境里本轮的 `PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR` | E12 40/40;`e12-runtime-reaping.json`:被超时杀死的桩实验,其运行时、被其派生的后代、合成 HOME 与配置根全部被回收,且**同形 decoy 进程存活**(证明不是按名字滥杀) |
| F3 [P2] | 分片解码只在实验结束后离线做,`OmpRpc` 的响应匹配看不到重组后的帧 → 大响应让 `rpc.request()` 超时 | 解码器接入 `lib/rpc.mjs` 的行处理,**在响应匹配与事件分派之前**;解码错误记录为 `__chunk_error__` 并把流标记为失败,使挂起/后续请求快速失败而不是超时 | E13 30/30:关闭自动压缩后 `get_messages` 经 `rpc.request()` 返回 1,200,650 字节且内容逐字节完整(12 个物理分片 → 3 个逻辑帧);E12 的 `e12-chunk-error-handling.json` 覆盖损坏序列 |
| F4 [P2] | 预先放置的旧成功结果文件可以冒充本轮结果 | 汇总器生成本轮唯一运行标识并注入每个实验(`M1_RUN_ID`);证据对象记录该标识,汇总器要求结果文件存在、命名匹配、`ok: true` **且运行标识等于本轮** | E12:`e97`(旧运行标识)与 `e98`(无运行标识)都被拒绝;成功桩改为**自己在本轮写结果**,父脚本不再预写 |
| F5 [P2] | `--dir` 缺失时 `i !== dirFlag + 1` 会丢掉第一个选择参数(`e04 e05` 只跑 e05,只给 `e04` 则跑全部) | 参数解析抽出为 `lib/suite-policy.mjs` 的 `parseArgs`,按标志逐个消费 | E12 覆盖 7 种排列(单选/多选/`--dir` 在前在后/`--keep-artifacts`),并端到端断言实际执行的实验集合恰为所选 |
| F6 [P2] | 交接提示词仍写"abort 不回收运行中命令";ADR 的子代理结论与已提交 fixture 记录相反 | 先完成 F1,再按有效证据重写 HANDOFF 提示词、ADR(区分四种终止情形)、本报告与任务板 | E05 与 E11 的 fixture 现与文档一致;`e11-subagent-cancel.json` 由身份路由后的运行重新生成 |

**四种终止情形必须区分**(此前混为一谈):

| 情形 | 实测结果 | 来源 |
| --- | --- | --- |
| 顶层会话取消 | `abort` 回收命令进程及其后代 | E05 |
| 真实子代理取消 | 父 `abort` 不回收 detached 子代理的运行中命令树,子代理仍被报为运行中;显式进程树终止可回收 | E11-D |
| 异常退出 | 不先停止就杀桥接进程组会留下孤儿命令树;被强杀**的实验**其运行时靠 stdin EOF 自退出,但隔离目录会残留 | E05-3、E12-F2 |
| 兜底清理 | 汇总器按运行标识与环境归属回收本轮运行时/后代/隔离目录;桌面侧等价实现属 M2/T09 | E12-F2 |

## 8.2 第三轮独立复审返修(R1-R4)

复审对象:`165163c`。每项都先复现、再对照原桌面实现、再修复、再回归。

| 编号 | 原桌面依据(源码事实) | OMP 实际差异(本机实测) | 实际处理 | 回归证据 |
| --- | --- | --- | --- | --- |
| R1 [P1] 子代理等待审批未被父停止取消,而实验把超时当取消 | `runtime.abort()`→`abortRunningDelegations()` 取消各 running delegation;`permissions.cancel()` 删除 pending 并发送 Deny,迟到 `resolve` 返回 `NOT_FOUND`(rpc/mod.rs 的 `tools_abort_during_permission_removes_the_pending_request` 断言"迟到批准"被拒、结果为 `TOOL_ABORTED`)。注意原桌面这套转发明确覆盖 Bash/GenerateImages,不能外推为"所有 Write 都已验证可取消" | 复现:子代理 `write` 进入 `gate-pending` → 父 `abort` 返回 `success=true` → `get_subagents` 仍报子代理 `running` → **abort 后 300 ms 写入 allow,子代理真的创建了目标文件**;全程没有任何取消帧。原 E11-C 的 deny 只是实验自己的 20 s 等待超时 | 撤回"父停止会取消子代理挂起对话"的结论;ADR 第 5 条改为"父会话取消与子代理取消覆盖范围不同";gate 增加**桥接侧取消**(取消标记 + 迟到决定拒绝),E11-C 改为"停止→发布取消→迟到 allow"并断言**取消(vs 超时/拒绝)分类**、`toolCallId` 归属与零副作用;fixture 标注该能力来自桥接而非 OMP | E11 42/42:`route="child-cancelled"`、`lateAllowExecuted=false`、`subagentsStillRunningAfterParentStop=1`、`ompNativeCancelObserved=false` |
| R2 [P1] 回收器在组长退出后漏杀同组后代 | `npm-executable.ts` 的 `settle()` 在超时后**无论组长是否已退出**都对剩余进程组发 SIGKILL(注释即写明"leader may exit on SIGTERM while a descendant survives");测试 `timeout kills resistant descendants after their group leader exits with ignored stdio`(本机运行 1/1 通过) | 复现:组长先退出后,旧实现用"组长 PID 是否存活"决定是否升级 SIGKILL,`alive(pgrp)` 又退化成检查正 PID → 同组抗 TERM 后代存活,但 `stillAlive=[]` 被报告为"无残留",登记还被删除 | 回收改为按**进程组存活**(`kill(-pgid,0)`)决定升级:先 SIGTERM,再有界 SIGKILL,组长退出不豁免;存活成员按 `/proc/<pid>/stat` 的 `pgrp` 精确枚举;清理未完成时**保留登记并置 `clean=false`**,不再谎报 | E12:`R2: the survivor is reclaimed even though its leader had already exited`、`reaper reports no survivors`、`registration dropped only after group gone`;后代**不带 PI 归属环境变量**,证明是进程组处理而非环境扫描在起作用 |
| R3 [P2] 超时只清理 HOME/config,未清理本轮实验根 | `scratch.rs` 按会话生命周期管理 scratch(跨回合保留、删除会话时清理、启动时清扫孤儿),`main.rs` 只在拿到真实会话列表时清扫 | 复现:汇总器超时后 `homeRemains=false` 但 `runRootRemains=true`、`agent` 数据仍在;旧 E12 随后自删整个临时套件目录,掩盖了残留 | 回收器增加**按所有权**删除本轮运行根(`.dev-data/m1/<run>-*`),并遵循 `--keep-artifacts`;`run-all` 把该选项传入并汇总 `cleanup` 状态;明确不把实验清理规则扩展成"abort 就删 OMP agent dir/会话/凭据" | E12:`R3: scratch run root is reclaimed`、`agent data is reclaimed`、`--keep-artifacts preserves that run's scratch root`、两轮运行根不同 |
| R4 [P2] 等待响应期间的分片错误被误报为 timeout | `host-process.ts`:`closeTransport(error)` 清除 pending 定时器并用**真实错误**拒绝所有待完成请求;只有定时器触发才返回 timeout;写失败传播传输错误 | 复现:请求发出后流中出现错序分片,`request({timeoutMs:2000})` 约 27 ms 返回 `error="timeout"`,而内部 `streamError` 是 `chunk decode failed: rpc chunk sequence mismatch` | `request()` 分离分类:`errorKind="transport"` 返回真实流错误并立即结束等待,`errorKind="timeout"` 仅在超时真的到达时给出 | E12:`R4: a request waiting when the stream faults does not report a timeout`(26 ms,`errorKind=transport`)、`a genuine timeout keeps its own classification`、大响应与故障后新请求回归保留 |

## 8.3 第四轮独立复审返修(R1/R2/C1)

复审对象:`c5754ce`。同样先复现、再对照原桌面、再修复、再回归。

| 编号 | 原桌面依据(源码事实) | OMP/本机实测差异 | 实际处理 | 回归证据 |
| --- | --- | --- | --- | --- |
| R1 [P1] 取消已发布,较早落盘的 allow 仍放行 | `permissions.cancel()` 删除 pending 并唤醒等待者;`rpc/mod.rs` 在审批等待后再检查 cancellation;迟到 `resolve` 返回 NOT_FOUND。**范围限制**:该接线在固定 PI 中明确覆盖 Bash/GenerateImages,不能外推为所有 Write | 用复审方的两个探针在本仓库复现:①直接驱动扩展 handler:`cancelPresentAtResolution=true` 但 `gateBlocked=false`;②真实 OMP + 真子代理:父 `abort` 成功后 SIGSTOP 本探针持有的 OMP → 写 allow → 20 ms 后写 cancel → SIGCONT,子代理**实际写出目标文件**。根因:gate 用两个文件的 mtime 决定取消是否有效,较早的 allow 因此豁免了已可见的取消 | 取消改为**对未执行调用具有决定权**:每轮先查取消标记,存在即终态 `cancelled`,不再比较 mtime;决定改为**按 toolCallId 归属、单次消费**(应用后把文件改写为 `consumed <id>`),跨调用不重用;作用域不匹配时记录 `gate-decision-ignored` | E12 新增 8 项:`earlier-allow-then-cancel` 被阻断且分类为 `child-cancelled`、`cancel-first`、正常 allow、显式 deny、真实 timeout、作用域不匹配不重用、一次批准只放行一个调用。复审方两个探针在修复后:handler `gateBlocked=true`;真实 OMP `sideEffectAfterCancel=false`,`route=child-cancelled` |
| R2 [P2] 回收失败仍被汇总为成功 | 原项目没有这份 OMP M1 汇总器;其 `npm-executable` 测试直接断言进程消失,产品 `scratch.rs` 删除失败只 warn —— 都不能当作"无残留验收通过"的证据 | 复现:桩实验 PASS/exit 0/结果有效,但专属 scratch 内部目录不可写 → 回收 EACCES → 汇总仍 `passed=true`、exit 0,且 summary 把 `error` 丢掉只剩 `clean:null` | 回收失败进入验收:结构化 `errors`(phase/path/message)、`clean=false` 一律判失败并非零退出;summary 保留原因与诊断;清理失败**保留登记**以便重试;`--keep-artifacts` 的主动保留不算失败。顺带修掉重构时引入的所有权判定错误(运行根本身被自身包含判断挡掉) | E12 新增 8 项:真实汇总入口下 exit≠0、输出为 `REJECTED (cleanup incomplete: remove … EACCES)`、summary 含 verdict 与 errors、残留根被记录、登记保留(可重试)、解除障碍后重试成功回收、`--keep-artifacts` exit 0 且保留根 |
| C1 默认 M0 烟测不可复现 | 无对应实现(这是本项目自己的烟测) | 复现:`node docs/validation/M0-rpc/verify-rpc.mjs` 退出 1,`get_available_models failed: no response`(8.88 s,步上限 8 s)。定位到机制:`get_available_models` 等待 `awaitBackgroundRefresh()`(`rpc-mode.ts:1423`),该后台发现会向远端目录/服务发起**出站 HTTPS**(抓到的 CONNECT 目标:`catalog.stencil.so`、`hyper.charm.land`、`api.kilo.ai`、`api.venice.ai`、`zenmux.ai`、`api.commandcode.ai`、`coding-intl.dashscope.aliyuncs.com`);本机这些连接不是拒绝而是黑洞,于是耗到 `REMOTE_DISCOVERY_TIMEOUT_MS = 10_000`(`model-discovery.ts:67`)。实测:同一次调用首次 10,036 ms、第二次 25 ms;把出站指向一个拒绝连接的本地端口后降为 24 ms;`get_state` 全程 24 ms | 隔离环境改为**显式离线**:`HTTP(S)_PROXY`/`ALL_PROXY` 指向关闭的本地端口,`NO_PROXY` 放行 loopback(夹具 provider 仍走直连)。**不放宽任何超时**,保留 8 s 步上限。这是把环境可达性的影响从烟测里移除,**不声称**已定位某个 provider 发现实现为何慢、也不声称修改了 OMP | M0 默认命令:`PASS`,退出码 0,1.28 s(修复前 8.88 s 失败);M0 假进程单测 18/18 通过;`models : local-model` 仍正确列出 |

**本轮明确的能力边界**:子代理挂起审批的取消仍**不是 OMP 自带能力**,只是桥接实现,桌面必须自建;回收失败现在会阻断验收,但"跨进程组且丢弃归属标记的逃逸后代"依旧无法归属(见 §6)。

**能力边界(本轮新增的明确结论)**:子代理挂起审批的取消在固定 OMP 中**不存在**;M1 只用实验侧桥接实现并证明"停止后不能放行",桌面必须在 M2/T09 自建同等机制(删除 pending + Deny 唤醒 + 迟到决定拒绝),不能依赖 OMP。另:`tools.mod.rs` 的正式 Bash 生命周期(unix 进程组 / Windows Job Object)是产品级参考,本轮只对齐了实验套件的回收语义。

复审后**被撤回**的旧结论:`abort`/`abort_bash` 无法回收运行中命令、必须依赖桥接层进程组终止。替换为:顶层会话 `abort` 即可回收命令进程及其子进程;杀桥接进程组**不能**替代停止(`abort`),否则留下孤儿;子代理的后台命令树需要显式终止。
