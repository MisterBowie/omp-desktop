# 执行任务看板

状态：`待开始`、`进行中`、`已完成`、`阻塞`。只有附验证证据才能将实现任务标为已完成。

当前交付阶段：M5/T18（OMP 原生 Edit/LSP/Debug 结果的可读展示）进行中、独立复审返修 R1-R4 与 S1-S4 已完成、待复审确认（分支 `codex/m5-tool-results`，本轮基线 `9c9ddc2da1091548fb142dc0b68ffad022914dbe`；证据见 `docs/validation/M5-tool-results.md`）。T17 已通过最终独立复审并验收（验收代码基线 `ab07a888d6afb916561b80e5661ed27aa6be612a`，分支 `codex/m5-subagents`；证据见 `docs/validation/M5-subagents.md`、`app/docs/adr/0303-omp-subagent-surfacing.md`）。下一阶段入口：M5/T19-T20。历轮独立复审返修的历史记录见 `docs/validation/M5-subagents.md` §0.1-§0.14。

2026-09-24：按用户要求以 `6914e68ef6e2bad632a8f549fde718e1f7f9db54` 做了一次 Linux x64 预览打包，发布 prerelease `m5-preview`（内置固定 OMP 18.2.7 运行时，仅为试用；证据见 `docs/validation/M5-preview-package-2026-09-24.md`）。该产物不是 M6/T21、T22 的完成证据。

## 准备工作

| 编号 | 工作 | 状态 | 证据 |
| --- | --- | --- | --- |
| P01 | 确认项目目标及两份仓库 | 已完成 | 用户确认及 `00-scope-and-decisions.md` |
| P02 | 建立独立项目与文档工作区 | 已完成 | 根目录 README、AGENTS 与 docs |
| P03 | 拉取两份源码并固定基线 | 已完成 | `source-baseline.json`；GitHub 交付时 app 改为直接跟踪源码，上游固定为子模块 |
| P04 | 源码核对、路径校验和最终交接 | 已完成 | `01-source-audit.md`、HANDOFF、`validation/planning-2026-09-21.md` |

## 实现任务

| 编号 | 阶段 | 任务与交付 | 依赖 | 验收重点 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T01 | M0 | Node 24、pnpm、Rust、Bun 环境与版本记录 | P03 | 可复现命令，不改全局 Node 默认 | 已完成 |
| T02 | M0 | 原桌面构建与测试基线 | T01 | 上游失败独立记录，尚不启动真实用户实例 | 已完成 |
| T03 | M0 | 开发数据/凭证/更新源隔离及代表性 UI 基线 | T02 | 先隔离再启动，不读写原产品数据、不自动更新 | 已完成 |
| T04 | M1 | OMP RPC 启动、版本协商、命令/事件 fixtures | T01 | ready、分片、应答与回合结束区分 | 已完成 |
| T05 | M1 | 工具执行前审批与拒绝实验 | T03,T04 | 拒绝无副作用；覆盖原生工具入口 | 已完成 |
| T06 | M1 | 取消、子代理及宿主工具实验 | T04,T05 | 后台实际终止，挂起请求清理 | 已完成 |
| T07 | M1 | 会话恢复、配置隔离及接入 ADR | T04-T06 | 原生会话映射；选定主路径 | 已完成 |
| T08 | M2 | 最小运行时接口和原 Pi 行为保持 | T07 | 旧流程对照测试 | 已完成（`docs/validation/M2-runtime-boundary.md` §3.1；`packages/shared/src/engine.ts` + `engine.test.ts` 20 项、`runtime/engine-router.ts` + 10 项、`engine-session-ipc` 4 项） |
| T09 | M2 | OMP 进程监督与协议适配包 | T08 | 退出/超时/帧错误，资源回收 | 已完成（`docs/validation/M2-runtime-boundary.md` §3.2；`packages/omp-runtime` 62 项含 mock 子进程与真实固定运行时无费用烟测；M1 413/413 未回归） |
| T10 | M2 | 会话引擎选择、能力判断和应用身份 | T03,T08,T09 | 新旧会话路由准确 | 已完成（`docs/validation/M2-runtime-boundary.md` §3.3；host-core schema v20 + 579 项、桌面 2537 项、身份隔离与开发构建禁用更新） |
| T11 | M3 | 文本、思考、工具、错误与用量事件 | T09,T10 | 顺序、隔离与未知工具退化 | 已完成（`docs/validation/M3-workflow.md` §1） |
| T12 | M3 | 审批与提问 UI、权限桥接 | T05,T11 | 请求关联、拒绝/超时/取消 | 已完成（同上 §2） |
| T13 | M3 | 停止与端到端编码流程 | T06,T11,T12 | 文件/命令副作用与 UI 一致 | 已完成（同上 §3） |
| T14 | M4 | 会话字段、迁移、恢复、归档 | T07,T13 | 旧库/新库，缺文件与中断恢复 | 已完成（`docs/validation/M4-persistence.md` §1-§3；host-core schema v21 + 582 项、`session.bindEngine`/`getEngineRef`、持久 `--session-dir`、registry 恢复/命名/归档；**分支 branch 关闭**——固定 OMP `branch` 语义与 PI fork 不兼容） |
| T15 | M4 | 模型配置、认证投影和凭证脱敏 | T07,T13 | 配置不串用，凭证不泄漏 | 已完成（同上；`omp-model-projection.ts` + canary 扫描；model change 为最小投影约束下的**离线 reclaim-first/persist-second restart**，thinking-only 在线 `set_thinking_level` 并回滚，mode/permissionMode 一次持久化） |
| T16 | M4 | 并发项目、队列、压缩与故障恢复 | T14,T15 | cwd 不漂移、无重复执行 | 已完成（同上；per-session registry、并发/恢复 E2E、`resume`/`modelSwitch` 开放、`branch`/`steer`/`followUp`/`compact` 保持拒绝） |
| T17 | M5 | OMP 子代理面板与编排归属 | T16 | 父子事件、查看、停止、恢复边界 | 已完成（`docs/validation/M5-subagents.md`；ADR 0303；验收代码基线 `ab07a888d6afb916561b80e5661ed27aa6be612a`；真实固定 OMP 子代理端到端验收 + macOS arm64 独立复审；`subagentEvents` 能力开放；限制：`stopSubagent` 恒拒（无 per-child stop RPC）、子代理 `hasUI=false` 工具 gating、批拓扑近似、`branch`/`steer`/`followUp`/`compact` 仍关闭；历轮返修见 §0.1-§0.14） |
| T18 | M5 | edit/LSP/DAP 结果与必要的专用展示 | T16 | 结构正确、未知结果可读 | 进行中（`docs/validation/M5-tool-results.md`；`tool-presentation.ts` 新增 OMP edit/LSP/debug 只读展示，LSP 诊断/失败/request 文本可见、debug snapshot/evaluation/断点 message/未知字段可见、edit 单/多文件/rename/create/delete/no-op/partial-error/pruned/diagnostics/firstChangedLine 可读且路径可点开；live 与 durable/子代理路径同 presenter，Pi/插件兼容与 4 MiB 预算不变；独立复审返修 R1-R4 与 S1-S4 已完成（快照不抑制空结果文本、只消费已渲染值含嵌套余量、裁剪非 no-op、rename 关系 + 挂载交互回归），待复审确认，未验收） |
| T19 | M5 | MCP、规则、技能、记忆及插件分类适配 | T16 | 单一加载责任、不重复工具注册 | 待开始 |
| T20 | M5 | Plan/Goal 和高权限工具能力门 | T17-T19 | 不借用不适用的原权限/模式语义 | 待开始 |
| T21 | M6 | OMP 运行时资源打包与版本固定 | T16 | 无全局依赖也能启动 | 待开始 |
| T22 | M6 | 品牌、更新源、许可证及 macOS 安装产物 | T20,T21 | 新旧应用并存，发布源独立 | 待开始 |
| T23 | M6 | Windows/Linux 分平台验证 | T22 | 平台原生依赖、取消和路径 | 待开始 |
| T24 | M7 | 日常任务验收、升级回退及维护交接 | T22 | 真实工作流、限制说明、升级演练 | 待开始 |

T23 不阻塞仅面向 macOS arm64 的首次交付，但未通过前不能宣称跨平台可用。T17-T20 按用户实际功能优先级逐项开放，不要求在基本开发版之前全部完成。

## M0 完成记录（T01-T03）

证据详见 `docs/validation/M0-baseline.md`（命令、退出码、版本、SHA、界面截图均已记录）。

- **T01 环境**：Node v24.14.0（nvm）、pnpm 10.34.5（corepack）、Bun 1.4.2、rustc stable 1.95.0 + nightly-2026-08-12（1.99.0-nightly）、cmake 4.4.3 + ninja 1.13.2（pip）；参考子模块浅取到固定 SHA（pi-desktop `0111e306`、oh-my-pi `d49918fab`）。
- **T02 构建/测试**：`pnpm install --frozen-lockfile`、`build:js`、`typecheck`、`lint`、`cargo build -p host-core --locked`、`cargo test -p host-core --locked`（577 通过）、`cargo fmt --check` 均通过；`pnpm -r --if-present test` 1 项失败（`remote-host-ssh-password.test.mjs`，本机 `SSH_ASKPASS` 环境变量触发，非回归）；重跑范围明确为 **desktop 包套件**（`env -u SSH_ASKPASS node --test apps/desktop/test/*.test.mjs` → 2523 项 / 2519 通过 / 0 失败 / 4 跳过），其余 workspace 包未重跑。
- **T03 隔离/UI**：开发版以 `PI_DESKTOP_DATA_DIR` 隔离，`pi.sqlite`/`secrets/.machine-key`/日志/插件写入 `.dev-data/pi-desktop`，`~/.pi-desktop` 零写入，更新源 dev 构建 `disabled`；Electron 43.6.0 启动，CDP 截取项目列表/设置-MCP/模型/扩展 5 张基线截图。
- **OMP 协议启动（M0 步骤 7，T04 前置）**：`bun setup` 成功；`node docs/validation/M0-rpc/verify-rpc.mjs`（绑定 `upstream/oh-my-pi/.../scripts/omp` 的 repo 路径入口，gitlink=submodule SHA=`d49918fab`、版本 18.2.7 核对一致；全量隔离 + readline 分帧 + 进程树回收）输出 `ready`、`negotiate_protocol`(v2)、`get_available_models`（mock 模型，无付费模型调用）。

> 复审返修（2026-09-22，四轮）：第一轮 6 项 + 第二轮 6 项 + 第三轮 4 项及临时目录清理 + 第四轮 2 项（环境恢复断言/凭据日志泄漏、管道错误统一清理）均已修复并重验。详见 `docs/validation/M0-baseline.md` 顶部四段“返修记录”。

## 单任务记录模板

```text
任务：Txx
状态：
当前阶段：
基线 SHA / 本次测试代码状态：
目标与可观察行为：
实际修改文件：
验证命令及结果：
代表性用户路径：
已确认的接口 / 数据归属：
未完成项及原因：
风险或需要用户决定的事项：
下一任务：
证据文档：docs/validation/...
```

如果只完成源码分析，没有完成行为实验，应标记“进行中”，不能把推测写成“已验证兼容”。

## M1 任务记录（2026-09-22）

```text
任务：T04 OMP RPC 启动、版本协商、命令/事件 fixtures
状态：已完成
基线 SHA / 本次测试代码状态：M0 基线 4321095；OMP d49918fa；分支 codex/m1-compatibility；新增未跟踪文件
目标与可观察行为：锁定源码启动 rpc-ui，读取 ready，协商协议版本，记录命令/事件帧与帧限制
实际修改文件：app/experiments/omp-bridge/（e01、e02、lib/rpc.mjs、lib/provider.mjs、fixtures/e01、e02）
验证命令及结果：node run-all.mjs → e01 26/26、e02 12/12 通过；M0 verify-rpc.test.mjs 18/18、verify-rpc.mjs 通过
代表性用户路径：会话建立、发消息、看到文本/思考/工具事件、回合结束
已确认的接口 / 数据归属：NDJSON 帧；帧限制 1 MiB / 64 MiB；negotiate_protocol 只接受 v2（广告 [1,2] 但 v1 被拒绝）；prompt 立即应答而 agent_end 才是回合结束
未完成项及原因：无
风险或需要用户决定的事项：不要把 ready 的 supportedProtocolVersions 当可回退清单
下一任务：T05
证据文档：docs/validation/M1-compatibility.md
```

```text
任务：T05 工具执行前审批与拒绝实验
状态：已完成
基线 SHA / 本次测试代码状态：同上
目标与可观察行为：受信扩展在工具执行前阻断原生 write/bash，并覆盖宿主工具入口
实际修改文件：app/experiments/omp-bridge/（e03、e04、e08、e10、extensions/approval-gate.ts、fixtures/e03、e04、e08、e10）
验证命令及结果：node run-all.mjs → e03 23/23、e04 29/29、e08 23/23、e10 18/18 通过
代表性用户路径：模型请求写文件/执行命令 → 桌面审批 → 拒绝或批准一次
已确认的接口 / 数据归属：tool_call 钩子执行前可达且带具体目标；拒绝无副作用；宿主工具同走该钩子；只有 rpc-ui 提供工具级 UI（含 ask）
未完成项及原因：无
风险或需要用户决定的事项：审批 UI 必须先于执行；交互提问本身不等于权限审批
下一任务：T06
证据文档：docs/validation/M1-compatibility.md
```

```text
任务：T06 取消、子代理及宿主工具实验
状态：已完成
基线 SHA / 本次测试代码状态：同上
目标与可观察行为：取消运行中的工具与挂起对话，验证宿主工具往返/取消与子代理事件
实际修改文件：app/experiments/omp-bridge/（e05、e08、fixtures/e05、e08-host-tool-cancel.json、e08-subagent-events.json）
验证命令及结果：node run-all.mjs → e05 28/28、e08 23/23、e11 42/42 通过（第五轮复审后重跑：全套 13/13、413/413、退出码 0）
代表性用户路径：执行中停止；审批弹窗中停止；宿主工具回灌结果；委派子代理并观察进度
已确认的接口 / 数据归属：挂起对话与宿主工具调用都会被取消（均按 targetId 关联）；子代理三类帧与存活期快照可用。**复审 R1/F1 修正**：①旧结论"abort 不回收命令进程"已撤回（旧命令 `echo $$; exec sleep 300` 从未运行，退出码 127），用真实外部程序重做后顶层 `abort` 即可回收命令进程及其子进程，不先停止就杀桥接进程组会留下孤儿；②旧 E11 用共享响应队列，父会话抢走了本应属于子代理的轮次，其"子代理审批"结论无效；按会话身份路由重做后：子代理工具调用进入同一钩子但 `hasUI=false`（无法弹窗，须由策略/带外通道决定），父 `abort` 不回收 detached 子代理命令树；**第三轮 R1 追加**：父 `abort` 也不会取消子代理的挂起审批（迟到 allow 会真的执行），已撤回旧结论并由桥接侧取消实现，ADR 第 5 条据此重写
未完成项及原因：子代理在父回合停止后的存活语义已测到"不回收"，其恢复/重启边界留待 T17
风险或需要用户决定的事项：停止顺序必须为"先协议内停止，再拆桥接"；子代理后台进程树必须显式终止；子代理审批无法交互，桌面必须实现策略或带外通道
下一任务：T07
证据文档：docs/validation/M1-compatibility.md
```

```text
任务：T07 会话恢复、配置隔离及接入 ADR
状态：已完成
基线 SHA / 本次测试代码状态：同上
目标与可观察行为：原生会话的新建/命名/恢复/分支，配置与凭证隔离，选定主接入路径
实际修改文件：app/experiments/omp-bridge/（e06、e07、e09、e12、e13、lib/base.mjs、lib/ndjson.mjs）、docs/decisions/001-omp-transport.md、docs/00-scope-and-decisions.md
验证命令及结果：node run-all.mjs → e06 23/23、e07 36/36、e09 30/30、e12 93/93、e13 30/30 通过；总计 13/13 实验、413/413 检查、退出码 0
代表性用户路径：重启后恢复会话；切换项目不串数据；发送含中文与 emoji 的长消息；桌面崩溃后不留孤儿进程
已确认的接口 / 数据归属：原生会话归 OMP；桌面只存索引与投影；rpc-ui 为唯一提供 ask 工具的模式；桥接断开时 OMP 自退出并被回收
未完成项及原因：MCP 工具未进入模型工具表（T19）；macOS 进程终止未验证（T23）
风险或需要用户决定的事项：接入路径已定案，M2 必须按决策文档 §3 的十条约束实现
下一任务：T08
证据文档：docs/validation/M1-compatibility.md、docs/decisions/001-omp-transport.md
```

