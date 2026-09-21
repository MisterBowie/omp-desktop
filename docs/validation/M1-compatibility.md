# M1 兼容性实验记录

记录时间:2026-09-22
工作目录:`/home/vv/person/code/omp-desktop-m1`(M1 专用分支 `codex/m1-compatibility` 的 worktree)
结论:**13/13 实验通过,326/326 检查通过**;接入路径已定案,见 `docs/decisions/001-omp-transport.md`。

> 本文件已被一次独立复审返修(R1-R6)。返修前版本的 E05 取消结论**无效并已撤回**,隔离、子代理权限、协议分片、工具链健壮性均有新证据;逐项处理见 §8。

## 1. 环境与基线

| 项目 | 值 |
| --- | --- |
| 系统 | Linux x86_64,内核 7.0.0-31-generic(kernel #31~24.04.1-Ubuntu) |
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

总结果:`experiments: 13/13 passed | checks: 326/326`,退出码 0,耗时 114.3 秒;汇总写入 `results/summary.json`,逐实验明细写入 `results/<name>.json`。汇总现在按「退出码 0 + 无信号 + PASS + 结果文件一致」判定,不再只看 PASS 文本。

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
| E11 子代理权限与取消 | `node e11-subagent-permissions.mjs` | 0 | 28/28 | 子代理的 `write` 走同一条 `tool_call` 钩子(拒绝无副作用/批准执行一次);父停止不回收 detached 子代理的命令树,显式进程树终止可以 | `e11-subagent-allow.json`、`e11-subagent-deny.json`、`e11-subagent-cancel.json`、`e11-subagent-pending-cancel.json` |
| E12 工具链故障回归 | `node e12-harness-faults.mjs` | 0 | 16/16 | 非法帧不崩溃且有界清理;汇总按退出码/信号/结果文件判定,超时按进程组回收 | `e12-invalid-frames.json`、`e12-aggregator-verdicts.json` |
| E13 协议 v2 分片 | `node e13-chunking.mjs` | 0 | 34/34 | 1.2 MB 提示触发真实 5 片/组 `rpc_chunk` 并完整重组;入站分片被拒绝;缺片/重复/乱序/非法元数据/超限全部报错 | `e13-real-chunk-sample.json`、`e13-inbound-chunks.json`、`e13-chunk-faults.json` |

## 3.1 M0 回归复跑

在 M1 分支上复跑 M0 的验证资产,确认新增实验没有破坏既有能力:

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node docs/validation/M0-rpc/verify-rpc.test.mjs` | 0 | `pass 18 / fail 0`(假进程驱动的分帧、隔离、进程组回收测试) |
| `node docs/validation/M0-rpc/verify-rpc.mjs` | 0 | `PASS: ready + negotiate_protocol(v2) + get_available_models` |

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

**子代理的权限覆盖与取消(E11)** — `task` 子代理的 `write` 会进入**同一条**扩展 `tool_call` 钩子:拒绝时文件不存在,批准时恰好写入一次;钩子看到的仍是子代理的具体目标路径。父会话停止时,子代理挂起的审批对话会收到带 `targetId` 的 `cancel` 并解析为 deny,无副作用。但父会话 `abort` **不会**回收 detached 子代理正在运行的命令树(真实外部程序 PID 仍存活),`get_subagents` 也不再报告其为运行中;显式的进程树终止可以回收。因此桌面停止会话时必须显式处理子代理的后台进程。

**宿主工具、取消与子代理(E08)** — `set_host_tools` 注册的工具能被模型调用,`host_tool_result` 会回灌给模型;扩展的 `tool_call` 钩子同时观察到宿主工具与原生工具(`["m1_host_echo","write"]`),因此"注册宿主工具"不等于绕过审批。放弃未应答的宿主工具调用(改发 `abort`)会收到 `host_tool_cancel`,**关联字段是 `targetId` 而不是它自己的 `id`**,桌面必须按 `targetId` 匹配。真实 `task` 调用产生了 `subagent_lifecycle`/`subagent_progress`/`subagent_event` 三类帧,`get_subagents` 在子代理存活期间返回带 `parentToolCallId`、`sessionFile`、`status` 的条目(子代理结束后会从注册表移除)。

**模式差异实测(E10)** — 纠正了仅凭源码的初判:两种模式都能投递扩展对话,但 `main.ts:2085` 的 `hasUI` 只对 rpc-ui 为真,`setToolUIContext` 只在 rpc-ui 装配,结果是 rpc-ui 广告 12 项工具(含 `ask`),普通 rpc 只有 11 项。桌面若用普通 rpc 会丢失 OMP 自身的询问用户能力。

**配置隔离(E07)** — 子进程实际环境(`/proc/<pid>/environ`)中不存在注入的合成 `OPENAI_API_KEY`,也不存在 `OMP_PROFILE`、`PI_PROFILE`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`;可见模型只有本实例的两个;`agent.db`、`sessions/`、日志都落在隔离根;配置根为 `~/.omp-m0-<hex>` 而非 `~/.omp`。

## 6. 未执行项与剩余风险

| 项 | 状态 | 原因 / 后续 |
| --- | --- | --- |
| MCP 工具进入模型工具表 | 未通过 | 隔离配置的 MCP 服务器被发现、启动并完成 `initialize`/`tools/list`,但其工具未出现在模型工具表中(OMP 只广告 12 项核心工具);归属 T19/M5 |
| 子代理审批对话的桌面路由 | 未实现 | E11 由实验代答;真实桌面如何呈现子代理提问属 M5 |
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

复审后**被撤回**的旧结论:`abort`/`abort_bash` 无法回收运行中命令、必须依赖桥接层进程组终止。替换为:顶层会话 `abort` 即可回收命令进程及其子进程;杀桥接进程组**不能**替代停止(`abort`),否则留下孤儿;子代理的后台命令树需要显式终止。
