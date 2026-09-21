# 源码核对与修改入口

## 1. 分析基线

已从官方仓库拉取完整工作树，使用浅历史。精确版本：

| 项目 | 版本 | 提交 |
| --- | --- | --- |
| PI-Desktop | 0.15.2 | `0111e306c120ad5820688d7608cb37bad8fbcc1f` |
| OMP coding-agent | 18.2.7 | `d49918fab2dba3986927f2d46721629ed0f3a02c` |

两个源码仓库均未发现 `.codegraph/`，本次按文件、类型及调用入口核对，未创建索引。下面的行号对应上述提交。这里只做静态源码核验，没有运行实际 OMP/桌面联调。

## 2. 核心结论

1. PI-Desktop 已经有独立 Agent 进程，并将通用进程实现放在 `packages/host-runtime`。新增引擎应优先利用此边界，不在 Electron 入口文件新写一套进程管理。
2. PI-Desktop 同时存在桌面自有会话、Pi 原生会话和远程会话。`source` 表示 transcript 归属，不宜直接把它改成引擎枚举。
3. 桌面常规 Agent 运行时自己构造 `Agent`，工具执行会调用宿主 `tools.execute`；Pi 原生会话则已有 `createAgentSession` 的 SDK 路径。两条路径都要核对，不能只替换一个包。
4. OMP RPC 已有 ready、版本协商、帧分片、宿主工具、原生会话操作和子代理接口，可以复用其协议设计与测试。
5. OMP 已有原生工具审批 wrapper 和可阻断的 `tool_call` 扩展钩子。优先实验 **rpc-ui + 受信扩展/现有审批机制**，再决定是否需要 SDK bridge；不要先发明另一套 OMP 权限系统。
6. 普通 `rpc` 与 `rpc-ui` 的 UI 能力不同；源码把完整工具 UI 注入限制在 rpc-ui 路径。面向桌面交互不能只测普通 rpc 的文本输出。
7. 本地锁定 OMP 根配置要求 `bun@>=1.4`，coding-agent 包声明 `bun >=1.3.14`，源码 Rust 固定 `nightly-2026-08-12`。准备源码构建时采用较严格的根要求，并记录这一文档/包级声明差异。

## 3. PI-Desktop 修改入口

所有路径均以 `app/` 为产品工作树。下面是定位清单，不意味着每个文件都要改。

| 入口 | 已确认事实 | 适配用途 |
| --- | --- | --- |
| [根 package.json](../app/package.json) | Node >=22.19.0、pnpm 10.34.5、版本 0.15.2 | M0 构建基线 |
| [agent-runtime/package.json](../app/packages/agent-runtime/package.json) | 依赖 `@earendil-works/pi-agent-core/pi-ai/pi-coding-agent`；Node esbuild sidecar | 核对依赖，不做全局包名替换 |
| [Electron agent-sidecar.ts](../app/apps/desktop/electron/main/agent-sidecar.ts#L50) | 继承 host-runtime 的 AgentSidecar，使用 Electron 可执行文件与 `ELECTRON_RUN_AS_NODE` | OMP 可执行路径与启动方式需单独配置 |
| [host-runtime agent-sidecar.ts](../app/packages/host-runtime/src/agent-sidecar.ts#L124) | 通用 AgentSidecar，163 行创建子进程 | 复用进程/通信责任边界 |
| [runtime/sidecar.ts](../app/apps/desktop/electron/main/runtime/sidecar.ts#L61) | `createSidecarRuntime` 处理事件、宿主调用和崩溃清理 | 引擎事件归一化、运行身份和清理 |
| [runtime/session-launch.ts](../app/apps/desktop/electron/main/runtime/session-launch.ts#L86) | `createSessionLaunchRuntime` 整理项目、模型、规则及会话参数 | 引擎路由与受控配置投影 |
| [runtime/session-coordination.ts](../app/apps/desktop/electron/main/runtime/session-coordination.ts) | 现有会话执行协调模块 | 防止旧编排与 OMP 同时调度 |
| [main/ipc/session-ipc.ts](../app/apps/desktop/electron/main/ipc/session-ipc.ts) | 桌面会话 IPC 边界 | 新旧引擎入口和能力控制 |
| [Agent sidecar.ts](../app/packages/agent-runtime/src/sidecar.ts#L499) | `agent.prompt`；599 行 `agent.abort`，并对 Pi 原生会话单独路由 | 不能将 OMP 原始 `type` 命令直接传给此 `method` 协议 |
| [DesktopAgentRuntime](../app/packages/agent-runtime/src/runtime.ts#L1471) | 1809 行 `new Agent`；3056 行附近发起 `tools.execute` | 当前 Agent 循环、工具和权限耦合点 |
| [native-pi-session.ts](../app/packages/agent-runtime/src/native-pi-session.ts#L1055) | `SessionManager.open` + `createAgentSession` | 原生会话展示、身份/lease、分支实现可作为参考 |
| [SessionSource/Capabilities](../app/packages/shared/src/types/sessions.ts#L18) | `desktop / pi-native / remote`，已有会话能力字段 | 引擎 ID 与 transcript 归属分开设计 |
| [Rust sessions.rs](../app/crates/host-core/src/sessions.rs) | 桌面会话、模式、权限及持久化逻辑 | 会话元数据和兼容迁移 |
| [Rust permissions.rs](../app/crates/host-core/src/permissions.rs) | 现有宿主权限机制 | 评估可复用的政策入口，不能默认拦截外部 OMP |
| [Rust secrets.rs](../app/crates/host-core/src/secrets.rs#L17) | 存在数据目录内加密 secret store 及 `file_fallback` 返回 | 隔离需覆盖实际文件型凭证存储，不能只看 README 的 Keychain 描述 |
| [main/index.ts](../app/apps/desktop/electron/main/index.ts#L181) | 调用 `applyDevelopmentUserData`；识别 `PI_DESKTOP_DATA_DIR` | 先使用已有开发数据隔离入口，查清其覆盖范围 |
| [updater.ts](../app/apps/desktop/electron/main/updater.ts#L33) | 更新 URL 指向 vastsa/PI-Desktop | fork 后禁用或改为新产品发布源 |
| [desktop/package.json](../app/apps/desktop/package.json#L78) | `appId=net.aiuo.pi-desktop`、产品名称和 GitHub publish 配置 | 应用身份和打包资源 |

UI 主要从 [ChatTranscript.tsx](../app/apps/desktop/src/components/ChatTranscript.tsx)、[Composer.tsx](../app/apps/desktop/src/components/Composer.tsx) 及其周边组件/模型定位。上游明确把这些大文件列为需要保持规模或缩小的模块，新功能应沿现有组件和服务边界扩展。

## 4. OMP 修改前必读入口

OMP 参考仓库默认不修改，优先通过公开入口适配。

| 入口 | 已确认事实 | 用途 |
| --- | --- | --- |
| [coding-agent/package.json](../upstream/oh-my-pi/packages/coding-agent/package.json) | SDK 导出 TS 源码，CLI 为 `src/cli.ts`，包版本 18.2.7 | 打包和运行时要求 |
| [sdk.ts](../upstream/oh-my-pi/packages/coding-agent/src/sdk.ts#L375) | `CreateAgentSessionOptions` 包含 cwd/agentDir、认证、模型、扩展、sessionManager 等 | 完整会话嵌入入口；实现位于 1333 行 |
| [rpc-types.ts](../upstream/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-types.ts#L24) | 原生 RpcCommand、RpcResponse、UI 和宿主工具类型 | 适配契约的首要来源 |
| [rpc-mode.ts](../upstream/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L821) | `runRpcMode`，输出 ready，v2 协商后切换编码 | 命令处理与交互行为 |
| [rpc-client.ts](../upstream/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-client.ts) | 已有客户端启动、等待 ready、版本协商与宿主工具处理 | 优先评估可复用性；先检查依赖是否适合 Electron/Node 进程 |
| [rpc-frame.ts](../upstream/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-frame.ts) | 有状态帧编码、rpc_chunk 等传输逻辑 | 大帧和协议 v2，避免只写一行 JSON 解析器 |
| [rpc-input.ts](../upstream/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-input.ts) / [rpc-output.ts](../upstream/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-output.ts) | 输入和输出边界 | 处理背压、关闭和解析错误 |
| [rpc-subagents.ts](../upstream/oh-my-pi/packages/coding-agent/src/modes/rpc/rpc-subagents.ts) | 子代理协议实现模块 | 子代理面板和事件映射 |
| [main.ts](../upstream/oh-my-pi/packages/coding-agent/src/main.ts#L2085) | `sessionOptions.hasUI = isInteractive || mode === "rpc-ui"`；2311 行按 rpc-ui 注入工具 UI | 桌面优先验证 rpc-ui |
| [extensions/wrapper.ts](../upstream/oh-my-pi/packages/coding-agent/src/extensibility/extensions/wrapper.ts#L176) | `tool_call` 可阻断；修改参数后重新审批；无 UI 时必要审批拒绝 | 原生工具执行前的关键接入点 |
| [extensions/runner.ts](../upstream/oh-my-pi/packages/coding-agent/src/extensibility/extensions/runner.ts#L1472) | `emitToolCall` 支持阻断和失败关闭 | 受信扩展桥接、超时和取消验证 |
| [permission-gate 示例](../upstream/oh-my-pi/packages/coding-agent/examples/hooks/permission-gate.ts) | 用 `tool_call`、`ctx.ui.select` 和 `{ block: true }` 进行阻断 | 最小实验参考；示例正则不是生产级完整政策 |
| [sdk wrapper 构造](../upstream/oh-my-pi/packages/coding-agent/src/sdk.ts#L2848) | 无条件创建 ExtensionRunner，避免无扩展时审批丢失 | SDK 桥接应保留原有审批链 |
| [acp-permission-gate.ts](../upstream/oh-my-pi/packages/coding-agent/src/session/acp-permission-gate.ts) | ACP 工具权限需求定义 | ACP 备选路线边界 |
| [agent-session.ts](../upstream/oh-my-pi/packages/coding-agent/src/session/agent-session.ts) / [session-manager.ts](../upstream/oh-my-pi/packages/coding-agent/src/session/session-manager.ts) | OMP 原生会话生命周期、历史和恢复 | 保留原生会话语义 |
| [utils/dirs.ts](../upstream/oh-my-pi/packages/utils/src/dirs.ts#L414) | `PI_CODING_AGENT_DIR` 与 profile 解析 | 配置根隔离需考虑 profile/env 的优先级 |
| [rust-toolchain.toml](../upstream/oh-my-pi/rust-toolchain.toml) | `nightly-2026-08-12` | OMP 源码构建独立于桌面 Rust 稳定工具链 |

## 5. 协议映射草案

此表列出真实 OMP 原生名称，桌面映射仍需 M1/M2 实现。

| 桌面意图 | OMP 原生命令/帧 | 需要注意 |
| --- | --- | --- |
| 就绪与协商 | `ready`、`negotiate_protocol` | ready 初始版本 1，支持 [1,2]；遵循协商顺序 |
| 发消息 | `prompt` | command response 与回合结束不同；本地 slash 命令可能不调用 Agent |
| 插入/排队 | `steer`、`follow_up` | 映射实际队列语义，不能一律转成 prompt |
| 停止 | `abort`、`abort_bash` | 验证各自覆盖的执行范围和子任务 |
| 模型 | `get_available_models`、`set_model` | 配置及凭证来源仍需单独注入 |
| 会话 | `new_session`、`switch_session`、`branch`、`set_session_name` | switch 使用原生 sessionPath；处理 cancelled 返回值 |
| 历史 | `get_messages`、`get_messages_page` | 长历史分页与游标映射 |
| UI 交互 | `extension_ui_request` / `extension_ui_response` | 区分问题、审批、通知和无应答 UI 更新 |
| 宿主工具 | `set_host_tools`、`host_tool_call/update/result/cancel` | 只证明已注册宿主工具的双向调用能力 |
| 子代理 | `set_subagent_subscription`、`get_subagents`、`get_subagent_messages` | progress/events 订阅级别，父子身份和历史恢复 |
| 大帧 | `rpc_chunk` | 需要重组、限额、错误与进程退出处理 |

## 6. 优先复用的测试

OMP 已有以下测试文件，可作为行为理解和 fixture 设计依据，不能在本轮声称它们已经运行：

- [rpc-client.start.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/rpc-client.start.test.ts)
- [rpc-client.restart.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/rpc-client.restart.test.ts)
- [rpc-frame.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/rpc-frame.test.ts)
- [rpc-input-frame.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/rpc-input-frame.test.ts)
- [rpc-host-tools.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/rpc-host-tools.test.ts)
- [rpc-extension-ui.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/rpc-extension-ui.test.ts)
- [rpc-subagents.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/rpc-subagents.test.ts)
- [rpc-prompt-result.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/rpc-prompt-result.test.ts)
- [agent-session-acp-permission.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/agent-session-acp-permission.test.ts)
- [rpc-shutdown-persistence.test.ts](../upstream/oh-my-pi/packages/coding-agent/test/modes/rpc-shutdown-persistence.test.ts)

桌面原生会话可参考 [native-pi-session.test.ts](../app/packages/agent-runtime/src/native-pi-session.test.ts)，但 OMP 格式和 API 必须独立核对，不能假定与 Pi 相同。

## 7. 仍需运行证明的结论

- rpc-ui、受信扩展和原有审批政策能否覆盖产品承诺的所有原生工具、嵌套调用和子代理。
- 当前 OMP SDK/客户端可直接用于哪种宿主运行时，打包时需要哪些 worker、资源和原生模块。
- 会话恢复、取消和配置隔离的真实行为，尤其是 profile 自动发现与全局环境继承。
- 原桌面的插件、Plan/Goal、远程会话在引擎选择后如何保持兼容。
- 跨平台可执行文件、信号、权限与原生模块的支持范围。

这些都已列为 M1-M6 的验收事项。静态类型表明有接入点，不等于集成已经通过。
