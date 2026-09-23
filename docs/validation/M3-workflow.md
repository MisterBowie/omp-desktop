# M3 验证记录：端到端对话与工具执行（T11-T13）

状态:**完成**(T11-T13);M4 未开始。
本轮父提交:`8558414e7cab17937a2809d2c731d625c0397b5a`(M2 第四轮返修后的分支顶端)。
本轮最终 SHA 见交付报告(本文档在提交前写入,故不写入自身 SHA)。
固定子模块:OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`(本轮未修改)。

工作树:`/home/vv/person/code/omp-desktop-m3`,分支 `codex/m3-workflow`。
传输与权限决策沿用 `docs/decisions/001-omp-transport.md`;本轮新增产品侧 ADR `app/docs/adr/0301-omp-session-surface.md`。

## 0. 环境准备(本轮新增的必要步骤,均为固定子模块流程)

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 工作树依赖 | `pnpm install --frozen-lockfile`(app/) | Done,1.9 s(store 复用) |
| OMP 工作区 | `bun install --frozen-lockfile`(upstream/oh-my-pi) | 414 packages;修正了一个真实缺陷:未安装前 `@oh-my-pi/pi-utils` 由 Bun 从全局缓存解析为 **18.2.9**,导致 pinned 版本校验失败;安装后 CLI 回到源码 **18.2.7** |
| OMP 原生模块 | `bun --cwd=packages/natives run build` | `pi_natives.linux-x64-modern.node` 构建成功(2m 24s,nightly-2026-08-12);未编译时运行时以退出码 1 失败 |

两条都不是本轮代码问题,而是新工作树缺少 M0 已记录的准备步骤;记录于此以便复现。

## 1. T11 文本、思考、工具、错误与用量事件

### 1.1 三方证据位置

| 事实 | 固定 PI-Desktop | 固定 OMP | 本项目落点 |
| --- | --- | --- | --- |
| 目标事件词汇 | `packages/shared/src/types/agent.ts:221`(`AgentEvent`)、`:275`(`AgentEventEnvelope`)、`types/messages.ts:68`(`UiMessage`)、`:13`(`MessageUsage`) | — | 未改动既有联合类型,只新增可选 `OmpToolMeta`(`types/agent.ts:295`) |
| 源事件 | `packages/agent-runtime/src/runtime.ts`(Pi SDK → 事件) | `session/agent-session-events.ts:13`(`AgentSessionEvent`)、`packages/agent/src/types.ts:1131`(`AgentEvent`)、`packages/ai/src/types.ts:1390`(`AssistantMessageEvent`) | `packages/omp-runtime/src/session/events.ts`(转换器) |
| 工具事件顺序 | `runtime.ts` 的 tool_start/tool_end | `packages/agent/src/agent-loop.ts:3085`(先 `tool_execution_start`),`:3121`(`record.blocked` 抛错) | 同上;`tool_start` 携带 `args`/`intent` |
| 用量字段 | `MessageUsage`(含 `reasoningTokens?`) | `packages/catalog/src/types.ts:142`(`Usage`:`input`/`output`/`cacheRead`/`cacheWrite`/`totalTokens`) | 只映射真实存在字段;`reasoningTokens` **不填**(测试断言其不存在) |
| 审批后置结果 | `PermissionCard` 决策流 | M1 E04 捕获:拒绝产生 `tool_execution_end{isError:true,result:"denied by user (…)"}` | 转换器原样转发为 `tool_end{isError:true}` |

### 1.2 设计要点

- 事件只在 `packages/omp-runtime/src/session/events.ts` 一处翻译;渲染层、store、工具卡片保持原样(零引擎分支)。
- 工具结果只表示一次:`tool_execution_end` 生成工具行,`role:"toolResult"` 的 message 被折叠并计数(`diagnostics().toolResultMessages`)。
- OMP 专有字段(`intent`、`customWireName`、`tool_stream_update` 的 `update`)进入共享类型的 `ompToolMeta`,不并入 `args`、不丢弃。
- 未知帧按类型计数(`unmappedFrames`),不抛异常、不伪造行;`notice` 仅在 `level: "error"` 时升级为 `error` 事件。
- 消息 id 由转换器生成(`omp:<session>:<n>`)并在 start/update/end 间复用;`agent_end` 只有 `isTerminal !== false` 才完成回合。

### 1.3 行为测试

`packages/omp-runtime/src/session/events.test.ts`(16 项):文本/思考增量与同一 id、最终消息的用量映射(含 reasoning 缺省断言)、错误回合(`message_end` + 类型化 `error`)、取消回合(`aborted` 不伪造错误)、工具 start/update/stream_update/end 的字段保真、toolResult 折叠、缺 id 的帧必须报错、非终态 `agent_end`、`turn_end` 用量、错误 notice 与信息 notice 的区别、未知帧计数。

## 2. T12 审批与提问 UI、权限桥接

### 2.1 三方证据与"区分"的实际判据

| 事实 | 固定源码位置 | 本项目落点 |
| --- | --- | --- |
| 对话框帧联合 | `modes/rpc/rpc-types.ts:372`(`RpcExtensionUIRequest`:select/confirm/input/editor/cancel/notify/…) | `classifyUiRequest()` |
| `optionDetails` 的真实来源 | `modes/rpc/rpc-mode.ts:628`(`requestRpcSelect`:由 select **item** 的 `description` 生成,而非 `dialogOptions`) | 网关把描述符放进 item 的 `description`;M1 的早期写法(放 dialogOptions)会被静默丢弃,已修正 |
| 原生审批元组 | `extensibility/extensions/wrapper.ts:333`(`select(prompt, ["Approve","Deny"])`) | 作为"运行时自带审批"的结构判据之一 |
| 前置钩子 | `extensibility/extensions/wrapper.ts:246`(loop 在调度前触发 `tool_call`)、`shared-events.ts:311`(`{block, reason}`) | 网关返回 `{block:true,reason}` |
| 钩子在 `tool_execution_start` **之前**触发 | 同上 | E2E 时间线证实:`tool_permission_request` 出现在对应 `tool_start` 之前,因此决定必须靠描述符关联,不能靠事件顺序 |

**判据(不使用文案启发式)**:`method` 决定交互面;审批只认两种结构——(a) 携带本产品版本化描述符的对话框(select 的 `optionDetails[0].description` 或 confirm 的 `message`),(b) 选项元组恰好等于固定源码原生审批元组的 select。标题中出现 "approve" 而结构不符的帧按普通提问处理(有测试)。

### 2.2 决策语义(全部在桌侧强制)

`packages/omp-runtime/src/session/ui-requests.ts`:
单次消费(应答即移除,重复/迟到拒绝并记录)、身份绑定(session + run generation,跨代拒绝)、fail-closed(停止/关窗/传输失败/未知 method → `cancelled:true`,等价于拒绝)、可诊断(`answered`/`refused-unknown`/`refused-duplicate`/`refused-stale`/`cancelled` 记录)。

### 2.3 行为测试

`src/session/ui-requests.test.ts`(19 项):描述符识别与"仅标题像审批"的反例、原生元组识别、foreign/未来版本描述符拒绝、question/cancel/notice/unknown 分类、allow/deny 的线上值、question 选项值回传、**重复允许拒绝且不写第二帧**、未知 id 拒绝、跨代拒绝、停止时批量取消且迟到允许不可达、未知 method 安全取消、运行时已断开时不报成功。
`src/session/gate.test.ts`(13 项):网关发出的对话框**回灌到桌面分类器**必须被判为审批(契约测试)、参数保真、会话内允许只对同一工具生效、无 UI/超时/异常一律 block、deny 模式不弹窗直接 block、策略解析。

## 3. T13 停止语义与端到端流程

### 3.1 停止顺序(来自固定源码)

| 步骤 | 依据 | 实现 |
| --- | --- | --- |
| 1. 先取消未决对话框 | 桌侧 fail-closed 规则 | `cancelPending()` 先于协议命令 |
| 2. 协议内 `abort` | `modes/rpc/rpc-mode.ts:1259`(`await session.abort`) | `OmpSessionRunner.stop()` |
| 3. 仅在仍有 bash 调用时 `abort_bash` | `rpc-mode.ts:1501`(`session.abortBash()` 只作用于运行中的命令) | 由事件流跟踪的"未结束的 bash 工具调用"决定,不猜测 |
| 4. 有界等待收敛 | 需判定"是否真的停了" | `convergeTimeoutMs`,由 `agent_end`/运行关闭唤醒 |
| 5. 兜底拆除 | `001-omp-transport.md` 约束 1/2;M2 监督器 | 仅在协议未收敛时调用 `supervisor.stop()`,并如实报告 `converged:false` |

### 3.2 端到端夹具(真实固定运行时 + 本地假 provider,零付费调用)

`app/apps/desktop/test/omp-session-e2e.test.mjs`,隔离 HOME/运行根/临时项目:
固定 launcher(`findPinnedLauncher`) + 本产品网关(`--extension`)+ `--model` 指向本地假 provider;`prepareRun` 写入隔离 `models.yml`;`OMP_DESKTOP_GATE_TOOLS=write,bash`。

实际时间线(夹具打印,61 个事件):
`agent_start → turn_start → message_start/end(用户行)→ message_start/update/end(助手文本)→ tool_start/end call_read → turn_end → tool_permission_request(write#1)→ tool_start/end call_write_1(error: denied)→ turn_end → tool_permission_request(write#2)→ tool_start/update/end call_write_2 → turn_end → tool_permission_request(tests)→ tool_start/update×3/end call_tests → turn_end → tool_permission_request(long)→ tool_start/end(aborted)call_long → tool_update → turn_end → turn_start/…/turn_end → agent_end → [新一轮 generation 2 全部事件]`。

每步可观察结果:

| 步骤 | 断言 |
| --- | --- |
| 读文件 | `tool_end call_read` 结果含文件内容 |
| 第一次拒绝写入 | 批准请求被 `deny`;`tool_end call_write_1` 为 error 且文本含 denied;**文件内容仍为 `original`** |
| 再次批准 | 第二次批准(独立 requestId);文件变为新内容;`call_write_2` 的 `tool_end` **恰好 1 条** |
| 运行测试 | `call_tests` 结果含 `3 tests passed` |
| 启动长任务并停止 | 长任务写入 started 文件(含 pid);`stop()` 返回 `aborted:true` 且收敛;`/proc` 扫描该标记为 0、该 pid 已消失;`pendingToolConfirmations` = 0;旧请求 id 不再 pending |
| 晚到事件隔离 | 新一轮(generation 2)事件全部带新 `turnId`;`call_long` 的结果绝不出现在新 turnId 下;停止后的帧在无运行时被计为 late(`diagnostics().lateFrames`,包内测试断言) |

## 4. 能力与不变量变化

- `OMP_ENGINE_CAPABILITIES` 打开 `prompt`/`stop`/`structuredQuestions`/`toolApproval`(各有行为与测试);`resume`/`branch`/`steer`/`followUp`/`modelSwitch`/`subagentEvents` 仍关闭(M4/M5)。
- 监督器状态改为报告**活动能力**(运行时 idle 时才开放);`reason` 不再写 `not-implemented`。
- 打开 `prompt` 后暴露的一类新风险已修:宿主的 turn queue、plan 审批/排空、compact 属于 Pi 运行时机制,不能因为共享 `prompt` 能力而放行 OMP —— 新增 `refuseOutsidePiRuntime()` 显式拒绝(M2 的相关测试保持原意并继续通过)。
- 关窗/退出顺序:先取消 OMP 未决对话框,再进入既有 reclaim 批次(顺序在 shutdown 中显式排列)。

## 5. 实际执行的命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm build:js`(app/) | 12 包构建通过 |
| `pnpm typecheck`(app/) | 0 错误 |
| `pnpm --filter @pi-desktop/omp-runtime test` | **11 文件 / 142 项通过**(含 pinned smoke) |
| `pnpm --filter @pi-desktop/shared test` | 84 文件 / 968 项通过 |
| `cd apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | 2586 项,2582 通过,0 失败 |
| `cd crates && cargo test -p host-core --locked` | 579 通过 / 0 失败 |
| `cd app/experiments/omp-bridge && node run-all.mjs` | 13/13 实验、413/413 检查、退出码 0 |
| `node docs/validation/M0-rpc/verify-rpc.mjs` | PASS(ready + negotiate v2 + models,**未发送 prompt**) |
| `node --test apps/desktop/test/omp-session-e2e.test.mjs` | 1 项通过(约 2.5 s,真实固定 OMP) |

### 无付费调用与隔离证明

- 全部 OMP 交互使用本地假 provider(`http://127.0.0.1:<port>`,脚本化回合);测试与夹具从未配置真实提供方或密钥。
- 运行时以隔离运行根启动:`HOME`/`PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR` 指向临时目录(M2 `buildOmpRuntimeEnv`),`prepareRun` 只写入隔离 `models.yml`。
- 固定 OMP 的 `verify-rpc.mjs` 只做 ready/协商/模型列表,不发送 prompt。

### 残留检查

- mock/OMP/Electron 进程 0;`/tmp/omp-runtime-*`、`/tmp/omp-e2e-*` 运行根 0;`~/.omp-desktop*` 不存在。
- 用户真实目录 `~/.pi-desktop`、`~/.omp`、`~/.agents` 时间戳未变。
- 两个子模块 SHA 未变、工作树干净;`git status --porcelain` 为空。

## 5.1 独立复审返修 R1-R2(基线 `cb6f7287565dd8838382c253696d59295f137345`)

### R1 生产桥接忽略 projectPath(P1,已修)

**原状**:`agent-ipc.ts` 把真实 `session.projectPath` 传给 `ompSessions.prompt()`,但桥接只在日志里使用它,启动前**从未**调用 `supervisor.setWorkingDirectory(...)`;运行时因此以 run root 为 cwd 启动,OMP 无法读写用户项目。E2E 里手工调用 `setWorkingDirectory(project)` 掩盖了该缺陷。

**对照固定 PI-Desktop**:其运行时 cwd 是会话属性(host-core 按 `projectPath` 创建会话),桌面不把"项目"作为进程参数反复传递;M1 的实验也是以 `cwd: projectDir` 启动固定 OMP(`app/experiments/omp-bridge/e04-approval.mjs:87`),即"进程 cwd = 会话项目目录"。

**修正**(`app/apps/desktop/electron/main/runtime/omp-session.ts`):
1. 新增 `resolveProjectDirectory()`:空/纯空白 → `INVALID_ARGUMENT`;**非绝对路径拒绝**(不 `resolve()` 成 cwd 相对路径);不存在或非目录 → `INVALID_ARGUMENT`。
2. `prompt()` 在 `supervisor.start()` **之前**调用 `supervisor.setWorkingDirectory(projectDirectory)`;若监督器已拥有运行时(目录无法更改)则明确拒绝。
3. 绑定后同一 session 的**不同项目目录被明确拒绝**(`ENGINE_CAPABILITY_UNAVAILABLE`),相同项目继续;切换/并发属 M4。
4. E2E 删除手工 `setWorkingDirectory`,并新增断言:`bridge.workingDirectory() === project`、项目目录内出现写入结果、run root 的 `cwd` 下**不得**出现会话产物。

**先失败后通过**:把桥接回退到基线后用同一份新 E2E 运行 → `TypeError: bridge.workingDirectory is not a function`,且启动前没有任何 `setWorkingDirectory`(运行 root 作 cwd);修复后通过(2.2 s,读取/拒绝/批准/测试/长任务停止均发生在示例项目)。

**新增桥单测**(`apps/desktop/test/omp-session-bridge.test.mjs`):
`binds the session's project directory before the runtime starts`(断言调用序列恰为 `[setWorkingDirectory:<project>, start]`)、
`refuses an empty or relative project directory without starting anything`(`null`/`""`/空白/相对路径/不存在目录一律 `INVALID_ARGUMENT` 且 `supervisor.calls` 为空)、
`refuses a different project directory for a runtime already bound to one`(不同目录拒绝、同目录继续、`start` 只发生一次)。

### R2 权限身份加固(已修)

**原状**:`agent-ipc` 调用 `ompSessions.resolveUi(undefined, requestId, decision)`,显式绕过 session 检查;`approvalRequests` 虽保存了 `{request, sessionId}`,但解析路径未用它做权威路由。

**基线行为实测**(脚本对基线桥接):把一个 **ask** 请求的 id 交给权限路径 →
`BASELINE: permission path consumed an ASK request: true {"type":"extension_ui_response","id":"q-1","value":"a.ts"}` ——普通提问被当作权限决定消费并写回运行时。

**修正**:
1. 两个专用入口:`resolvePermission(requestId, decision)` 与 `resolveAsk(resolution)`,不再存在可绕过身份的通用入口;渲染器 IPC 负载不变(requestId 仍是 opaque token,`toolResolvePermission` 仍是 `{requestId, decision}`)。
2. `lookupDialog(requestId, kind)` 做权威查找:id 必须是该 kind 的**未决**对话框,session/run 取自桥接在抛出请求时保存的值;kind 不匹配 → `wrong-kind`,已应答/已取消 → `duplicate`,未知 → `unknown`,与绑定 session 不一致 → `stale`。
3. 校验通过后才 `consume()` 单次消费,再用**保存的 session + generation** 调用 runner;因此重复回复、停止后的回复、旧 generation 都不会写第二帧。
4. 请求的 generation 在抛出时同请求一起保存;`OmpSessionRunner.resolveUiRequest` 增加 `sessionId`/`generation` 入参并在 runner 侧二次校验(runner 的单会话身份 + 注册表按代拒绝)。
5. `lookupDialog` 与 `consume` 分离:格式不合法的回答(选项不在列表中、confirm 非 Yes/No、session 不符)**不消费**对话框,避免把仍在等待的运行时吊死。

**新增行为测试**:`a question's id cannot be consumed through the permission path`(拒绝且 0 帧,随后 ask 路径仍可正常应答)、`an approval's id cannot be consumed through the ask path`(拒绝且 0 帧,随后权限路径可应答)、`an approval is answered under the session the bridge stored for it`(surface 的 `sessionId` 即绑定 session,决定无需也无法另指 session)、`an answer that names another session is refused`(refused 后同一请求仍可被正确 session 应答)、`a duplicate decision, or one after a stop, never writes a second frame`。

### 本轮返修验证

| 命令 | 结果 |
| --- | --- |
| `pnpm build:js` / `pnpm typecheck` | 12 包构建通过 / 0 错误 |
| `pnpm --filter @pi-desktop/omp-runtime test` | 11 文件 / 142 项通过 |
| `pnpm --filter @pi-desktop/shared test` | 84 文件 / 968 项通过 |
| `cd apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | 2593 项:2589 通过 / 0 失败(桥接测试由 13 增至 20) |
| `node --test apps/desktop/test/omp-session-e2e.test.mjs` | 1 项通过(不预设 cwd) |
| `cd crates && cargo test -p host-core --locked` | 579 通过 / 0 失败 |
| `node docs/validation/M0-rpc/verify-rpc.mjs` | PASS(未发送 prompt) |
| 残留 | OMP/Electron 进程 0、临时运行根 0、`~/.omp-desktop*` 无、子模块 SHA 未变、工作树干净 |

## 6. 已知限制(真实存在,且不属于本轮范围)

1. **模型与凭证投影属于 M4/T15**:本产品尚未把用户模型设置投影进 OMP;产品内 OMP 会话需要一个可达模型配置,验收夹具用本地假 provider 提供。
2. **会话恢复/切换属于 M4**:一个运行时进程承载一个原生会话;M3 内切换会话被显式拒绝。附件投递同样未实现(拒绝并给出错误码)。
3. **steer/follow-up/压缩/分支/子代理事件未开放**;子代理的工具调用 `hasUI=false`,由网关 fail-closed 拒绝并记录,交互审批与能力下发属 M5/T17。
4. **自由文本扩展对话框(input/editor)未提供卡片**:以 fail-closed 取消并记录警告;OMP `ask` 工具的 select 与 confirm 正常显示。
5. **打包属 M6**:当前通过 `OMP_DESKTOP_RUNTIME`、开发 checkout 或 bundled 资源解析运行时与网关;未打包产物。
