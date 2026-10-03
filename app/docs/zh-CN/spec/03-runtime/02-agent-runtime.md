# 02. Agent 运行时

> **翻译说明：** 本页是与 [英文源规格](/spec/03-runtime/02-agent-runtime) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。


## 1. Goal

应用决策：**D002/D003/D008/D158/D189/D190/D193/D194**。


将 pi 包装到桌面层可以安全使用的产品运行时中。

核心包：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`

## 2. 运行时放置

Agent 循环在 **Node/TypeScript pi sidecar** 中运行，而不是在渲染器中运行。

```text
packages/agent-runtime/*
apps/desktop/electron/* (supervisor)
crates/host-core (tool execution + permissions)
```

## 3. 核心对象

### 3. 1 PiRuntime (Node)
- 初始化 models/providers
- 创建 Agent
- 绑定工具桥
- subscribe/normalize pi 事件

### 3. 2 AgentHostFacade (Electron 主)
- 会话路由
- 过程监督
- IPC 翻译

### 3. 3 主机工具桥（Rust）
- 接收工具调用请求
- 应用权限策略
- 执行 builtin/plugin 工具
- 返回标准化的工具结果

## 4. 运行时 API（包级）

```ts
interface AgentRuntime {
 prompt(input: PromptInput): Promise<{ turnId: string }>
 steer(input: RuntimePrompt, expectedTurnId: string, message: UiMessage): { accepted: boolean; turnId: string }
 requestGracefulStop(): { requested: boolean }
 abort(turnId?: string): Promise<void>
 getStatus(): RuntimeStatus
 dispose(): Promise<void>
 subscribe(handler: (event: NormalizedAgentEvent) => void): () => void
}
```

`requestGracefulStop()` 是针对当前活动运行时的一次性请求。pi 循环会在
`turn_end` 之后、当前助手响应与这一批工具都已完成时对它求值，并在发出下一次
模型请求之前正常地发出 `agent_end`。它不会取消进行中的提供商流或正在运行的
工具。空闲的运行时返回 `{ requested: false }`；立即生效的 `abort()` 仍然是另
一条独立的取消路径。

### 4.0 当前回合补充指令

`steer` 在改变任何状态之前验证当前回合标识，再通过 pi-agent-core 原生 steering 队列的
`all` 模式加入用户输入。当前提供商请求和已启动的一批工具先完成；所有已接收输入在
同一个持久回合的下一次模型请求边界进入上下文。进行中的请求不会被改写或中止。
与普通提示相同，主进程负责附件验证和转录持久化。

pi 消费排队输入时保留渲染器提供的消息 id；即使补充输入早于最初用户消息被消费，
也遵循这一规则。如果输入在 pi 最后一次检查队列后才获准进入，运行时抑制终态事件，
等 pi 释放执行后沿用同一回合继续，不再次公开发出 `agent_start`。现有上下文和提供商
恢复流程优先于这次继续执行。补充指令也会唤醒正在空闲等待后台委托的父代理，
不会取消这些委托。

中止、优雅停止、致命错误和终态落定都会关闭接收入口。已接收但尚未消费的输入保留在
转录和上下文历史中，并从 pi steering 队列移除，避免在后续回合独立执行。
普通 follow-up 仍留在独立的 Host FIFO 中，直到当前持久回合最终落定。
补充指令失败不得终止当前运行。

## 5. 提示流程

1. 加载持久会话，会话缺失则拒绝
2. 解析该会话的 mode/provider/model 与项目绑定（app/当前工作区默认值仅作为
   旧版回退）
3. 针对该确切的 provider/API URL 与 model 解析完整的 models.dev 元数据记录，
   并把持久会话的思考级别钳制到它最接近的受支持值；快照中不存在的 id 使用
   显式的通用回退
4. 验证 model/secret 可用性
5. 会话繁忙则拒绝；渲染器会把面向用户的下一条提示排入队列，在当前会话到达
   `agent_end` 之前不会调用这条路径
6. 在 Electron main 的会话绑定路径边界上校验结构化附件，按 SHA-256 持久化
   图片字节，持久用户消息中只保留附件引用。只有处于视觉模型 10 MB 内联上限
   之内的图片才会被读进内存；更大的图片走流式哈希/复制以及既有的安全路径回退
7. 为本回合快照有效的 shell ID 与方言
8. 用解析出的会话配置和有效思考级别启动 pi 回合；HTTP 429 的建连与流式失败
   使用运行时自有的静默 10 次重试预算，其他瞬时的 transport/provider 失败则在
   建连与流式两个阶段之间共享一份运行时自有的 10 次重试有界预算
   （D127、D186、D245、D258）
9. 将规范化的回答与思考事件流式传输到 UI
10. 工具调用时，携带持久的 `sessionId` 委托给 Rust 主机桥；由主机解析会话
    绑定的工作区根
11. 若 pi 以 `stopReason: "error"` 结束一条消息，则用结构化的
    `UiMessage.error` 收尾任何残缺的助手气泡，将其持久化进转录，并发出一个
    携带同一个提供商 `AppError` 的规范化生命周期 `error` 事件；即使是没有任何
    回答文本的失败，也仍然是一条可见的助手错误消息
12. 独立地收尾并持久化成功的 answer/thinking 块

当一个进行中的回合还没有产生新的转录行时，运行时会发出一个规范化的 `status`
事件来命名这段安静间隔：`starting` 表示提示交接，`waiting-model` 表示某次
提供商请求正在等待它的第一个助手事件，`preparing` 表示工具批次结束后、下一次
请求发出前，`compacting` 表示正在做上下文检查点，`recovering` 表示正在补救
空回复，`retrying` 表示正处于一次有界的提供商退避中，`waiting-subagents`
表示父级正在等待被委托出去的工作（并带上每个仍在运行的目标的粗粒度子动作）。
渲染器把这个阶段限定在该会话内，并在助手或工具活动开始时、或回合终止时清除它。
这纯粹是可观测性，它不会引入第二个 agent 循环，也不会给出完成百分比。

运行时为每个持久会话恰好构造一个 pi `Agent`。Plan 不会另选第二个模型、
规划器服务、权限实现或运行时。同一个 Agent 在一次由主机确认的转换之后，
改变它自己的规划状态与工具注册表。

### 5d。有界提供商流恢复和诊断（D186、D245、D259、ADR 0091、ADR 0128）

提供程序请求设置和流式传输交付是两个独立的故障阶段，但
HTTP 429 处理是一个响应恢复策略。此路径禁用了 pi-ai 的嵌套
适配器重试，因此运行时可以在两个阶段之间共享一个预算。

`PROVIDER_RATE_LIMITED` 在初始尝试之后最多重试 10 次，总共 11 次
提供程序尝试。设置阶段的 429 在提供程序流适配器内部重试。
流中的 429 会从下一个模型上下文中删除失败的助手，并在同一
回合中调用 `continue()`。两个阶段占用同一个计数器，因此设置阶段的
429 后跟流阶段的 429 无法重置或倍增该预算。在两个阶段中，
捕获的响应状态都会在对提供商消息进行分类之前应用，因此通用的
429 正文仍会进入 429 预算，而已知的不可重试分类仍然是终止的。
主会话和内置子代理使用相同的控制器和策略。

429 重试在转录生命周期上是静默的：没有中间助手错误、生命周期 `error`、
`turn_end`、`agent_end` 或重复的助手气泡到达 UI。一个规范化的 `status` 事件
会标明这次重试退避，好让用户知道该回合仍在进行。重试开始时会复用可见的
助手消息 id，从而在一个气泡中替换任何部分内容。结束事件由最终
成功或耗尽的那次尝试发出一次。等待期间的中止会取消计时器，并
阻止下一次提供程序请求。

延迟遵循 OpenCode 风格的顺序：`retry-after-ms`、`retry-after` 秒、
`retry-after` HTTP 日期，然后是指数退避。回退从 2 秒开始，并以最多
25% 的正向抖动指数增长；每个服务器值或计算值都以 30 秒为上限。
运行时从 fetch 捕获失败的响应状态和标头，因为 pi-ai 的普通响应
回调仅涵盖已建立的响应。

非 429 瞬时故障共享它们自己的有界响应恢复预算：在初始尝试之后
最多重试 10 次，总共 11 次提供程序尝试。该预算由请求设置和流式
传输交付共享，因此在两个阶段之间移动的故障无法重置或倍增它，
并且它与 429 预算相互独立。它只接受 `NETWORK_ERROR`、`TIMEOUT`、
`STREAM_FAILED` 和可重试的 `PROVIDER_ERROR`——包括在标头到达之前
或流中到达的网关 `502`/`503`/`504`。身份验证、模型选择、格式错误的
请求、上下文以及其他不可重试的错误不会进入任何提供程序重放路径，
并且来自格式错误的 400/422 请求的不可重试 `PROVIDER_ERROR` 仍然是
终止的。

**Synchronized update (#699):** Both budgets reset after a complete, non-error,
non-aborted model response, including tool-call responses, in the main session
and builtin subagents. Headers, partial output, and phase changes never reset
them. New requests start at retry 1; persistent outages remain bounded at ten
retries per class. Exhaustion diagnostics use the applicable budget counter,
not temporary retry activity. See the English source section 5d and ADR 0206.

在把 HTTP 400/422 那种消息以 `(no body)` 结尾的流前 `PROVIDER_ERROR` 抛给上层
之前，运行时最多做一次静默的修复尝试：移除生成的输出上限字段
`max_tokens`、`max_completion_tokens` 和 `max_output_tokens`。这次修复不消耗
瞬时重试预算，也不增加退避，调用方的 `onPayload` 改写仍然生效。第二次不透明
的失败即为终止，而在修复开始之前发生的中止会阻止这次修复请求。

非 429 延迟优先遵循服务器：`retry-after-ms`、`retry-after` 秒，然后是
`retry-after` HTTP 日期，上限为 8 秒。捕获的标头会为每个可以声明
延迟的状态（429、408、409 和 5xx）保留，而不再仅限于 429。在没有
可用标头时，等待是一个简单的倍增计划：1 秒、2 秒、4 秒，然后是
8 秒；它在请求阶段和流阶段完全相同，因此在两个阶段之间移动的故障
保持同一个可预测的节奏。该计划是确定性的——没有抖动——因为它调节
的是一次失败的请求，而不是同步的速率限制突发。服务器声明的延迟
一律优先，即使它比计划的等待更短。

只有失败的请求会被重放。会话、它的转录本以及它的工具状态都保持
不变：失败的助手会从下一个模型上下文中删除，并复用同一个可见的
助手消息 id，因此重试永远不会重启该回合或重新运行已完成的工具调用。
每次重试都可中止，并通过规范化的 status 事件报告它当前的退避。主会话、内置
子代理和一次性 composer 提示增强使用相同的错误码、预算大小和
优先级。

应用设置 `infiniteProviderRetry` 默认关闭。开启后，主会话及其内置子代理只跳过可重试
网络/瞬时故障（含 `PROVIDER_RATE_LIMITED`）的次数上限。退避、`Retry-After`、可见重试状态和
停止路径不变。不可重试错误、上下文恢复、压缩、工具执行和一次性补全仍走原有有界预算。
开启后可能在用户停止回合前持续消耗 API 用量。
设置读取对此开关返回明确布尔值：缺省或关闭均规范化为 `false`。修改并保存其他设置不得因此校验失败或启用重试；非布尔值写入仍被拒绝。

当 429 预算耗尽时，最终的助手错误和生命周期 `error` 只发出一次。
提供程序故障在可用时于 `AppError.details` 中携带有界诊断：
`phase`（`request` 或 `stream`）、`providerStatus`、`providerCode`、
`providerWaitMs`、`streamMs`、`retryAttempt`、网络诊断
（`networkCategory`、`networkCode`、`networkSyscall`、`networkHost`、
`networkRoute`）以及请求关联字段（`requestMessages`、`requestBytes`、
`compactionGeneration`）。
对于持续的 429，
`retryAttempt` 为 `10`；对于持续的非 429 瞬时故障，它也为 `10`。凭据与不受限制的
响应正文永远不会进入事件或日志。每次重试都会新建请求、流和 `AbortController`；
重试唯一共享的状态是进程级 undici dispatcher。当同一来源在一轮内连续两次没有
任何响应、且新尝试仍无法到达它时，下一次尝试前会重建一次传输（每 30 秒最多一次，
`dns` 除外），避免重试继续复用连接已死的连接池。重建先安装替换、再优雅关闭旧
的 dispatcher，并复现已配置的链路，因此其他会话正在进行的请求仍会在原连接池上
完成，代理也不会被悄悄丢弃。

### 5e。静默回合恢复

以没有工具调用且没有可见辅助文本结束的普通回合是不可见的
对用户：推理永远不会呈现，因此结论只写在那里
没有到达。 255 个录制的会话中有 15 个以这种方式结束了一个回合，并且
用户唯一的办法就是输入“继续”。

运行时在 `message_end` 处检测到它：停止既不是错误也不是异常
中止，消息不请求任何工具（没有 `toolCall` 内容部分），并且
修剪后可见文本为空白。推理内容不免除回合
——只思考的转变正是需要恢复的情况。

恢复镜像 §5d 并以相同的方式限制：每次运行最多重新运行一次。
无声助手已从模型上下文中删除 (`continue()`
拒绝以助理消息结尾的记录，空的则不
值得重新发送），一条简短的无输出指令被附加到系统中
提示继续该操作，并且重复使用气泡 ID，以便恢复
回合后不留空行。无声尝试的 `turn_end` 和
`agent_end` 被抑制；重新运行会发出单个终端生命周期。

恢复在 `message_end` 中装载，并在循环空闲后执行，因此它属于
每一个驱动循环的入口——用户提示与已审批的计划或目标执行
同样如此。每个入口在开始前清空恢复状态，并在 `waitForIdle`
之后执行待处理的恢复，两半都走同一份共享实现。漏掉其中任何
一半，本次运行都会在生命周期仍被抑制、且没有尝试任何恢复的
情况下结束，用户看到的就是会话在工作中途停住，既没有错误也
没有重试入口。§5d 的溢出与 provider 流重试遵循同一契约，而残留
的抑制标志会吞掉*下一次*运行的终止事件。

一次性指令依赖于代理的系统提示，而不是
`prepareNextTurn` 钩子，因为该钩子仅在实时运行中形成回合
并且本次运行已经结束。除非路径范围内的，否则它会在之后被删除
指令重新加载同时重写了提示，在这种情况下，较新的
重建胜利。

如果重新运行也没有声音，则回合结束时会出现明显的辅助错误
可重试的 `EMPTY_MODEL_RESPONSE`，它为转录本提供正常的重试
行动。在这两种情况下都不会保留空的助理消息。

Host 账本完成通知（ADR 0239、D446）是唯一例外：其提示已经允许无需确认。
Main 按 ID 从账本读取排队消息、检查目标会话，再构造来源元数据。只有
`kind: completion`、目标为当前会话、消息 ID 和回复目标 ID 均非空时，运行时
才接受静默。静默的通知回复正常发出完成消息和终止生命周期，不重试、不报告
`EMPTY_MODEL_RESPONSE`。提供商错误和中止仍按原规则处理，同一次尝试的
provider 重试保留例外；原任务及结果不被改写，完成通知不会要求再次回调。

例外只覆盖通知自己的那条回复：本次运行第一条结算的 assistant 回复会消耗它，
无论该回复是静默、有文本还是工具批次。因此紧随工具结果之后的回复按本节普通
规则处理；被接受的 steering 消息一旦进入模型上下文，例外立即撤销，所以对
用户的回复保留完整的重跑与报错路径。每次新运行都按提示的来源信息重新计算。
普通用户输入、task/message 投递、复制的来源文本和恢复的历史记录都不能开启它。

被接受的静默回复仍然不值得重发。Main 会把它持久化为一条空的已完成行（转录
隐藏该行，host 不存文本），但运行时不把它写入自己的条目和 pi 的转录状态，
上下文投影也会丢弃没有内容块的 assistant，与恢复转录时的处理完全一致。因此
下一次 provider 请求不会带上空的 assistant 消息。

决定 D193 与 D446（ADR 0239 修订段）；参见 E2E-146 与
E2E-SESSION-completion-notice-allows-silence。

### 5. 1 上下文检查点保护（D158/D203、ADR 0030/0049/0061/0064）

完整的可见记录和模型上下文是不同的视图
同一个会话。持久检查点总结了旧模型上下文，同时
渲染器继续显示每个原始用户、助手和工具行。

PI-Desktop 复用 pi-agent-core 的 `buildSessionContext`、`convertToLlm`、
`estimateContextTokens`、`prepareCompaction` 和 `compact` 原语。桌面运行时拥有
这些原语的运行时机，以及结果如何穿过 Rust 存储
边界； OpenCode DCP 仅是 AGPL-3.0 行为参考，不是链接或
复制的依赖关系。

压缩遵循 Codex 的机制 (ADR 0064)：它总是内联发生在
回合边界，模型可以通过`new_context`请求，每次compaction
添加一个转录本行并提出一个警告 toast，并且没有
任何地方的预计算。

pi 0.84.4+ 只在循环将要在同一次运行中开启另一个助手回合时才调用
`prepareNextTurn`——包括在一批工具执行完毕与随后的模型请求之间。新的用户
提示仍然会在它的第一次提供商请求之前，经由 `prompt()` 中的
`automaticCompactionNeeded` 先行压缩。

对于每个 pi 循环：

1. pi 在助手消息和所有工具之后发出并等待 `turn_end`
   该回合的结果已完成
2. PI-Desktop 根据完整转录本和最新转录本重建上下文
   有效的检查点并估计下一个请求预算
3.低于硬边界，并且没有待处理的模型请求，下一回合
   收益不变
4. 处于或高于硬边界，或者当模型名为 `new_context` 时，
压缩在下一个提供程序请求之前同步运行。在
   在 summary 系列中，生成摘要是强制的；运行时会拿摘要输入对照模型窗口做
   预检，并跳过放不下的请求。自动摘要失败时先尝试一个确定性的保留尾部
   检查点，而手动压缩仍然报告
   `CONTEXT_COMPACTION_FAILED`
5. 成功生成或确定性恢复首先追加
   通过 host-core 检查点，然后安装其摘要 + 保留尾部为
   下一个提供程序请求的运行时上下文；硬边界
   检查点在持久化之前被重新估计，并且在之前再次估计
   继续，并且不能授权下一个请求，除非它低于
   硬预算

检查点生成和安装是单独的操作。
`buildCheckpoint` 运行准备、预算预检和摘要请求
无需保留任何内容或更改活动检查点；安装
重新估计，通过 host-core 附加，更新活动检查点，以及
发出 `compaction_end`。阻塞路径将两者背靠背组成。

**在检查点中幸存下来的内容。** 压缩后的模型上下文是
摘要以及最多一条**用户**消息；助手和工具消息是
从模型上下文中删除并保留在可见的转录本中。圆周率
`prepareCompaction` 仍然选择切点，因此其回合边界和
保留分割回合处理，但运行时会折叠分割回合
前缀和最近的尾部返回到摘要输入中，因此摘要涵盖
整个紧凑的范围内，没有任何东西跨越边界而未被覆盖。
保留模式由请求这次压缩的生命周期决定：

- 当提供商必须在工具结果、`toolUse` 回合或溢出恢复后继续当前任务时，使用
  `active_turn`；仅保留压缩范围内最新的用户消息，最多为下面的保留限额；
  超过该限制时截断而不是丢弃
（`[checkpoint truncated: this message crossed the retained context budget]`），
  并恢复为时间顺序。
- 在终止回合边界、发送新用户提示之前或手动压缩时，使用
  `completed_turn`；保留尾部为空。摘要是已完成工作的权威内容，检查点后的
  下一条用户提示是唯一的新任务。
- `fresh_window` 系列仍是 ADR 0064 规定的无摘要例外，并始终携带空尾部。

`retainedTailMode` 存储在检查点不透明的 `details` 中，因此重启会保留同一任务
边界。没有该字段的旧检查点会归一化为只保留最新的用户消息。放弃助理
消息也会丢弃其工具调用，因此没有孤立的工具调用可以到达
提供商。保留的尾部用持久化之前的摘要重新估计
并且在继续之前，所以超大的请求仍然无法通过警卫。

**两个压缩系列。** 两者运行相同的生命周期 - 预算
重新估计、host-core 追加、`compaction_end`、转录本行、警告：

- `summary`（默认）从模型请求摘要；
- `fresh_window` 不请求任何内容并安装一个空的检查点
  保留尾部和固定标记文本，说明历史记录已重置，无需
  正在总结中。

压缩系列先由构造选项决定，其次才轮到
`PI_DESKTOP_COMPACTION_STRATEGY`。它不是设置项，在 `AppSettings` 与 i18n 中
都不存在；它之所以存在，是为了让"不做摘要"这条机制既被实现、又可被测试。

**面向模型的表面。** `new_context` 不带任何参数并开始一个新的
下一回合边界处的上下文窗口；它永远不会清除或重置环境
状态。当前回合的系统提示中附加了两条预算提醒，
每个检查点窗口最多一次，并在检查点被重置时重置
安装：当剩余预算降至
`clamp(hardLimit * 0.15, 8k, 32k)`，要求模型开始平仓，并且
一个剩余 2,000 个令牌，告诉它写下必须幸存的一切。
这两个提醒都不会保留或显示在记录中。

硬边界是模型上下文窗口减去请求余量。
Headroom 是 16,384 个代币储备底线的最大值，模型最大输出
上限为上下文窗口的 25%，以及 5% 的安全裕度。预留楼层
本身被限制在窗口的一半处。传递给 pi 的切点目标是
从模型窗口得出，硬预算的 20% 被限制在
8,000–64,000 个代币，然后上限为硬预算的一半；它决定了在哪里
边界倒塌了，而不是幸存下来的东西。活动用户消息保留限制为
20,000 个代币，上限为硬预算的一半，因此仅靠保留无法填补
小窗口，没有留下摘要的空间。这些值都不是
可配置。

**估算校准（D606）。** 上述每个阈值都对着同一个数字比较，而该数字会按请求的真实开销校正。pi 的 `estimateContextTokens`
以最后一条助手用量为锚，其余一律按 `chars / 4` 估算：该常数会低估中文文本，且在没有锚点时完全不含系统提示与工具结构，
而下一次请求仍要为它们付费。两类误差分开处理——逐字符偏差以「猜测尾部」上的比例表示（与量级无关）；无锚点残差只在与之
量级相当的样本（0.5×–2×）上按比例应用，否则只加上观测到的固定开销（上限 32,000 词元）。

校正是不对称的，因为这个数字决定压缩：向上修正只要有三个观测即生效；向下修正需要三个方向一致的样本、每次最多 15 %，
且永远不能把数值压到原始估算的 85 % 以下——因此处在硬限制 1.18×（`1 / 0.85`）的投影仍会触发压缩。偏离校准预测
0.5×–3× 之外的报告视为误报；连续两次误报会冻结向下修正，直到出现可用报告。


传入的用户提示先于第一个提供商参与预算
请求。自动摘要请求在有界的 pi-ai 重试策略下重试瞬时的提供商失败
（3 次重试，2s/4s/8s 退避，Stop 可取消）；配额、鉴权等确定性失败立即返回。
预检守卫按 pi 实际序列化的提示（工具结果已截断）估算大小，而不是按原始消息；
若该提示仍超出窗口，会恰好尝试一次缩减输入（工具结果截为短前缀、去掉思考块、
不删除任何消息），之后才放弃摘要（ADR 0282）。如果在自动阈值或溢出期间正常压缩仍然失败
恢复时，运行时会与之前的恢复检查点保持一个简短的恢复检查点
摘要（如果可用）和一个适用的积极限制尾部。的
完整的转录本保持持久且可见，而下一个模型请求
仅接收恢复检查点和尾部。生命周期事件标记
这作为 `fallback: "retained_tail"`，检查点的 mark 也携带同样的 `fallback`，
因此渲染器可以显示警告并把转录行标为摘要生成失败，
而不是虚假的成功。如果无法准备、持久或保留后备
低于安全预算，用户行和助理错误仍然持久并且
没有提供商请求开始。提供商报告的上下文溢出是最后一个
恢复层：从模型上下文中省略失败的助手，压缩一次，
并重试一次。第二次溢出仍处于终止状态。基岩的
`prompt is too long: N tokens > M maximum` 形式映射到此路径。

自动保护始终启用且用户不可配置。的
运行时仍然接受禁用它的构造时覆盖，由
测试；持久的 `contextCompaction` 设置将被忽略，因此会话无法
失去防护，无法恢复。手动 `/compact` 仍然存在
会话空闲时可用。检查点生成是可中止的并且
计为运行状态，直到持久持久性完成。

委托（第 5f 节）对照它自己解析出的模型走同一条推导，并在它自己的回合边界上压缩，
但没有属于它自己的持久检查点链（ADR 0299）。

## 5b.运营模式及规划状态

- 默认产品模式：**Agent**
- 产品选择器是 **Agent | Plan | Goal**；内部对话页面
  仍可能使用 `page = "chat"`
- 模式是会话范围的，并与会话元数据一起保存
- 思维水平是会话范围的，并通过会话元数据持续存在
- 主机配置仅在会话空闲时可变。渲染器
  保持 mode/provider/model/thinking/permission 控件在运行期间可编辑，
  将最新选择视为下一回合状态，并刷新一个完整的
  终端事件后的配置。
- 更改 mode/provider/model/thinking 级别适用于下一回合，并且
  当任何影响运行时的配置更改时重新创建 pi 运行时；
  运行中的运行时不会观察到排队的渲染器选择。
- 实时规划指示器跟随正在运行的回合。回合中暂存的模式选择不会把投影的
  `planning`/`inactive` 提前翻过去；Composer 模式芯片可以立刻显示暂存模式，
  但只有进行中的回合真正投影 `planning` 时才脉冲，紧凑的转录本规划行也是同一投影。

实时计划状态的推导和预测为：

```ts
type OperatingMode = "agent" | "plan" | "goal";
type ProposalKind = "plan" | "goal";
type PlanningState =
  | "inactive"
  | "planning"
  | "awaiting_approval";
type PlanExecutionState = "queued" | "running" | "completed" | "interrupted";
```

Plan 和 Goal 是两种 **合约模式** (D198)。他们共用一个耐用的
批准表、一张投影 `PlanningState`、一张批准表面和一张
执行队列；提案上的 `kind` 判别器 (`plan` | `goal`) 选择
提示符、工件目录和面向用户的副本。 `Agent` 是唯一的
没有种类的模式，并且是唯一可以自由执行的模式。因为
投影是共享的，`planning` 和 `awaiting_approval` 始终一起读取
可以知道会话处于哪种持久模式。

当用户选择 Plan 时，`Agent / inactive` 进入 `Plan / planning`
空闲时或 Agent 调用 `EnterPlanMode` 时。在 Plan 中，Agent 可以
检查、使用上下文控制、通过选定的权限模式运行 Bash，
并调用 `SubmitPlan(title, markdown, question)`。主机核心保留
在新的不可变中提交 Markdown 字节
`.pi/plan/<unique-name>.md` 工件，记录其相对 path/hash/size 和
在 `plan_approvals` 中构造 title/question，并将活动状态移至
`awaiting_approval`。

仅批准 `approve` 和 `reject`。批准提交 `mode = agent`，
显式权限模式、执行 ID 和 `execution_state = queued`
一个主机事务中的相同 `plan_approvals` 行。的
然后，同一个 Agent 使用 Agent 工具集进行新的模型转动。拒绝，
绝对过期、待处理的中断、过时的响应或持久性
失败关闭批准行并将活动状态返回为可编辑
`Plan / planning` 不授予执行工具。后来接受的 Plan 提示
是一个新的转折：早期的 `SubmitPlan` 调用仍然是历史不可变的
检查点，并且 Agent 必须调用 `SubmitPlan`
一次使用新的完整 Markdown 快照来创建新的工件。如果批准
已提交且 queued/running 执行被中断，持久模式
仍然是 Agent 并且不会重播执行。

手动模式和配置选择可以由渲染器上演，同时
轮运行，但主机持久性仅保持空闲状态。选择 Agent 是
故意的用户覆盖并且不综合计划或批准。每个
会话有 1 个活动轮次、1 个待批准轮次和 1 个 queued/running
执行；暂存时，第二个提示或执行被拒绝
仅在会话空闲后才提交配置。

`Agent / inactive` 进入 `Goal / planning` 两种方式相同，由用户选择
空闲时或通过 Agent 调用 `EnterGoalMode`。 Goal 有相同的工具
表面为 Plan，只不过其提交工具是
`SubmitGoal(title, markdown, question)` 及其工件被写入
`.pi/goal/<unique-name>.md`。提交的 Markdown 是一个**目标合约**——
要达到的结果、证明已达到的验收标准以及
不得跨越的界限——不是实施步骤的列表。一个
当会话处于活动状态时，提交工具会被拒绝并显示 `PLAN_KIND_MISMATCH`
是另一种，当没有合约处于活动状态时，使用 `PLAN_NOT_ACTIVE`。

Goal 批准所承诺的内容与 Plan 批准所承诺的内容完全相同：`mode = agent`，
显式权限模式、执行 ID 和 `execution_state = queued`
同一行。排队执行指令因种类而异。批准的计划是
重播为遵循的步骤；批准的目标指示 Agent 选择其目标
自己的方法，通过运行检查来验证每个验收标准
合同名称，在未满足标准和未经尝试的方法的情况下继续工作
仍然存在，只有当边界阻挡它时才提前停止，并以
逐个标准地报告所满足的内容和观察到的证据。

## 5c。思维能力与流契约

- 规范级别为 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、
  和 `max`。会话（及子智能体）选择器还接受 `omit`，它不是目录/绑定能力：
  运行时把智能体记账保持为 `off`，走低层 provider 流，不合成思考覆盖
  （ADR 0194 / ADR 0295）。
- 随包的 models.dev 发布快照对于已发布的推理支持具有权威性，
  思维层面的映射、限制、输入模式、定价、标题和适配器
  每个已解决的已知模型的兼容性。
- 提供商配置不能覆盖已知模型语义。未知
  自由格式的 id 仍然可以通过通用的纯文本、非推理的方式运行
  模型，因此仅公开 `off`。
- 不支持的请求级别采用所选 models.dev 模型的最近受支持级别规则：先向上扫描
  先向上，然后向下。非推理提供商总是决心
  `off`。
- 视觉支持由同一条 models.dev 记录解析：只有 `input.includes("image")` 才启用
  图片传输。未知/自定义模型 id 保持为保守的 text/path 模型，即使发现到的元数据
  声称支持 `vision`。
- 有效级别会传给 pi `Agent`；特定于提供商的请求
  序列化仍然是 pi-ai 的责任。
- Pi `thinking` 块变为 `UiMessage.thinking` 并且
  `message_update.deltaThinking`。他们从不附加到 `content` 或
  `deltaText`。
- 恢复的助手历史重建单独的文本和思维块
  在下一个回合之前。
- 恢复的历史记录还可以从持久保存的工具 call/result 对中重建工具
  工具行（`off`/`minimal`/`low`），因此重新创建了运行时
  保持其完整的工作上下文——读取的文件内容、命令输出——
  而不是折叠成裸露的聊天文本（D127）。中断的刀具行
  恢复为错误结果；辅助行丢失的工具行
  获得合成的仅呼叫辅助运营商，以便 call/result 对保留
格式良好，适用于每个提供商 API。
- 每个请求里的工具调用 id 必须唯一。转录是仅追加的快照流，容忍重试造成的重复追加，因此同一次调用可能两次进入组装后的
  上下文——同一个行 id（宿主按 keep-last 读取时已折叠），或者两个不同的行 id（宿主无法折叠）。因此上线前的最后一个视图
  对每个 `toolCall` id 只保留第一次出现，丢弃其后重复的调用或结果，使提供商校验的「一调用一结果」配对保持完整；没有重复的
  请求原样返回。一旦发生丢弃，会在 `agent` 日志通道上报告一次，带上会话与 id（D608）。Anthropic 系端点（含 DeepSeek）
  会以 `tool_use ids must be unique` 拒绝整个回合（issue #718），使该会话无法继续。
- 视觉运行时只从会话绑定的附件、scratch 与项目根目录中水合持久化的图片引用。
  处于 10 MB 内联安全上限之内的图片会成为临时的 pi-ai 图片块；超限或不可用的
  图片则退化为安全的 `@path` 回退。超限历史的水合会直接复制文件，不会先把内容
  读进内存。Base64 绝不会被还原进持久的 UI 消息或转录记录。
- 失败的助理消息仍然是持久的诊断记录条目，但
  在以后的回合中永远不会恢复到 pi 模型上下文中。
- 恢复的检查点可清除保留的助理消息中的提供商使用情况
  用于预算。该用法测量了预压缩请求，并且不得
  使摘要+尾部看起来与丢弃的上下文一样大。
- 运行时重新创建和模型更改恢复最新的有效检查点。
  仅当其边界保留在实时转录本中时，截断才会保留它；
  仅当子级包含该边界时才分叉 copies/remaps。
- 分叉会话接收新的会话 ID，并且没有共享运行时。它的第一个
  提示创建一个新的 pi 运行时并仅从子进程恢复上下文
  转录本，包括重新映射的工具 call/result 对。
- 消息范围的助手 Fork/Edit 遵循相同的规则：子进程
  转录可能会停止或替换所选的助理响应，但其
  下一个提示无法重用源会话的 runtime/provider 缓存，因为
  会话 ID 和重新映射的转录本身份是独立的 (D134)。

## 5f。子代理委托（D201、ADR 0062、ADR 0089）

会话 Agent 可以把可拆分的工作交给在独立上下文中后台运行的委托，
并按需取回报告。

**目录。** 定义是来自两个来源的 Markdown 文档：`agent-runtime` 中内嵌的五个
内置函数（`explorer`、`code-reviewer`、`test-runner`、`fixer`、`ui-designer`），以及
`~/.agents/subagents/*.md` 下的全局用户文档。没有项目级子代理目录，`.pi/agents`
不会作为能力来源被扫描。用户文档在进入加载器前会根据应用本地启用状态过滤，
内置定义则由加载器按同一份应用本地状态过滤（ADR 0270）。
Electron main 每次启动加载全局目录，并在 sidecar 参数中传递
`subagents` / `subagentProviders`，因此编辑定义会在下一次提示时生效。目录上限
为 `MAX_SUBAGENT_DEFINITIONS`（16）；格式错误或不可读文档只产生启动诊断，
不会让启动失败。

Frontmatter 新增 `permission: inherit | ask | accept-edits | auto`（默认
`inherit`）。使用默认的 `inherit`（包括所有内置定义）时，sidecar 不附加覆盖，
委托使用会话的有效权限模式；因此父会话为 `auto` 时，明确的外部路径也不会再次
弹出授权卡。只有内置定义和用户定义可以声明非 `inherit` 作用域；项目定义随仓库
一起到来，声明会在解析时被丢弃并留下警告，其委托仍在会话的有效模式下运行 ——
想要该作用域的用户把文档复制到自己的 agents 目录。可写的内置 `fixer` 与
`ui-designer` 也默认继承父会话：`auto` 下跟随父会话自动放行，而 `ask` 和
`accept-edits` 仍保留各自的审批边界。显式声明的内置或用户作用域仍然是一次有意的覆盖。

**工具（ADR 0089）。** 委托是四个工具的生命周期，仅在 Agent 模式下且目录
非空时构建，四个工具都属于 Agent 核心集而不是第 7.1 节的按需目录：

- `Task(agent, task, description?, model?)` — 验证其参数（未知的 `agent`、空的
  `task`、无法解析的模型引脚以及工具全部不可用的定义，各自返回一个工具
  错误解释失败而不是抛出），**在后台**启动委托，并立即返回一个
  `delegationId`。当会话已经在运行 `MAX_SUBAGENT_CONCURRENCY`（10）个
  委托时，启动会以工具错误失败。

  `Task` 工具接受一个可选的 `model` 参数（`"provider/modelId"`），用于在本次
  运行中覆盖该委托的模型。解析优先级：Task.model 参数 → 定义 frontmatter 的
  引脚 → 会话模型。父 agent 会在系统提示中看到一份模型摘要，列出提供商设置里
  所有标记为 `availableForSubagents` 的模型。若委托目录为空，提示会告诉模型
  省略 `model`，使用定义的固定模型，无固定模型时继承会话模型；显式给出的键如果正好就是当前会话的
  provider/model，同样按继承处理。其他显式模型键必须已配置并已为委托启用。
  Electron 单独传递 `subagentModelKeys` 与 `subagentProviders`：后者可含仅供定义
  固定使用的模型，只有前者授权缓存覆盖并生成模型摘要。缺省列表为空；按需解析成功
  写入独立覆盖缓存，不得覆盖定义固定模型或改变运行时复用判断。按需匹配使用与
  固定模型相同的唯一 id/vendor/name 规则。许可列表变化会在下一次启动时替换空闲运行时。
  省略 `model`，或 `Task.model` 重复该定义自己的固定模型键时，定义仍可使用未勾选自动调度的固定模型。Task 的定义目录展示
  每项默认模型，并提示省略或重复该键以保留默认值。参见
  [ADR subagent-model-opt-in](/adr/subagent-model-opt-in)。
  当某个模型键没有被预先解析时，运行时会请求 Electron main 通过
  `provider.resolveSubagentModel` RPC 按需解析。已启动的 `Task` 结果详情会记录
  本次运行实际使用的 `modelId`。
- `TaskWait(delegationIds?, mode?, minCompleted?, timeoutSeconds?)` — 收敛
  正在运行的委托（默认全部）并返回它们的报告；`mode: "any"` 配合
  `minCompleted` 可以在前 N 个完成时提前收敛。已结算的委托立即返回，
  因此按 id 重读报告代价很低。合并结果上限为 `MAX_TASKWAIT_RESULT_CHARS`
  （50k）。`timeoutSeconds` 默认 600 秒并被夹到 900 秒：等待会阻塞回合，
  所以这个上限决定了会话最长能看起来卡住多久。到点不是失败，也不会停掉委托
  （D328）—— 等待返回心跳（谁、状态、已用时、轮数、最后工具）以及已完成的
  报告。运行时会保持父级回合打开，并在它们完成时把剩余报告交回，即使父级已经
  停止调用工具。只有 `TaskStop` 或用户 Stop 才会中止委托。
- `TaskList()` — 报告会话的每个委托及其状态和运行中心跳。
- `TaskStop(delegationIds?)` — 停止正在运行的委托（默认全部）；等待每次
  中止结算后，在 `details.stopped[]` 上持久化 `status: "stopped"` 与
  `completedAt`。被停止的委托读作 `stopped`。

**委托循环。** `SubagentRun` 是同一 sidecar 进程中的第二个 pi `Agent`，
使用该定义的系统提示、其（可能已固定的）provider/model、其声明的工具，
以及与父级相同的主机连接，并遵循与父级相同的有界提供程序重试策略。
委托没有轮次上限：它会在自己结束时、父级调用 `TaskStop` 时、用户 Stop 时结束，
或因父级终态错误而被中止（ADR 0253）。仍声明 `maxTurns` 的文档会正常加载，该键
会像其他任何无法识别的 frontmatter 键一样被忽略。
`maxTokens` 是可选的按定义输出上限（最大 200000）；省略、`none` 或 `0` 表示跟随模型
已发布的上限。它会覆盖为该委托构建的模型上的 `maxTokens`，因此适配器派生出的
`max_tokens` / `max_completion_tokens` / `max_output_tokens` 都会带上它；它只约束该
委托自身的响应 —— 会话自己的请求仍沿用模型绑定。超过天花板的值属于笔误，会被钳制
而不会转发给 provider。
内置的 `explorer` 声明 `Read`、
`Glob`、`Grep` 和 `Bash`，而 `code-reviewer` 保持只读；`fixer` 与 `ui-designer`
会在工作区内写入，`ui-designer` 另外声明 `BrowserPreview`，以便在报告前检查渲染结果。
其状态为 `completed`、`failed`、`aborted`、`timed_out` 以及仅存在于注册表的
`stopped`；终态通过 `TaskWait` 呈现，其文本是报告（上限为
`MAX_SUBAGENT_REPORT_CHARS`，12k），其 details 携带 `delegationId`、`agent`、
`status`、`startedAt`、结算后的 `completedAt`、`turns`、`toolCalls`，以及失败或
超时时的 `error`。`startedAt` 与 `completedAt` 是以毫秒计的运行时时间戳，也是
渲染器展示委托时长的事实来源；`Task` 那次立即返回的工具调用时长只覆盖启动
后台工作这一段。

**委托生命周期（D328）。** 运行时不再用空闲或总时长掐死委托。
`idle-timeout` / `max-duration` 仍会解析以便旧文档能加载，但不会被武装。
委托一直跑到自己结束、失败、被 `TaskStop`，或用户
Stop / 运行时销毁。主 Agent 用 `TaskStop` 判断要不要取消；运行中只能看到
一行心跳（谁、状态、已用时、轮数、最后工具）。

当父级在委托仍在跑时停止调用工具，运行时吞掉这次 `agent_end`，保持持久
回合打开，等委托完成后再把报告塞回父级。父级收工不会中止它们。

致命的 provider/stream 错误（包括耗尽的 HTTP 429）、父级中止，仍分别保留它们既有的
`failed` 和 `aborted` 结果。
父级终态错误还会中止残留委托、跳过续跑提示，并把会话恢复为空闲，这样
“继续”不会变成 `AGENT_BUSY`（D352）。

**可恢复的委托（ADR 0279）。** `Task` 接受一个可选的 `resume` 参数，携带同一会话中
某个已结算委托的 `delegationId`。恢复后的委托是一个新的 `SubagentRun`，以该链此前的
消息为种子 —— 最初的 `task` 简述，加上这条链产出的每一行 —— 然后再以新的 `task`
提示它，于是一个已经读过或改过某个文件的委托会从那份上下文继续，而不是从零开始。
种子完全由 transcript 支撑：链的行恰好是那些 `parentToolCallId` 属于该链某个 `Task`
调用的行，它们用委托自己的绑定（固定的委托模型未必是会话模型）转换成 provider 消息。
不保活任何内存对象，也不引入新的事件类型、存储 schema 或工具参数。

一条链是共享同一个委托会话的那些 `Task` 调用的序列：第一次调用，加上此后每一个把更早
的 `delegationId` 当作 `resume` 传入的调用。运行时在启动时从持久化的 transcript 重建
链索引 —— 每个 `Task` 行都在 `toolResult.details` 里带着自己的 `delegationId` 与结算
状态、在 `toolArgs.resume` 里带着被恢复的 id，并在重建时归一化 agent 名 —— 因此可恢复性
能挺过一次 sidecar 重启。链的身份（`delegateSessionId`）始终留在内部；父级只会传
`delegationId`，由反向映射解析它。

只有 `completed` 与 `failed` 的链可恢复；`stopped` 和 `aborted` 的运行是终态，只能靠
新建委托重来；而应用在它还在工作时被关掉的那种运行会重建成 `interrupted`，同样不可
恢复。只读工具输出超过 `MAX_RESUMABLE_READ_LINES`（50000）的链会从可复用清单里消失，
且不做链内裁剪，因此恢复绝不会悄悄丢掉历史。注册表按定义名最多保留
`MAX_RESUMABLE_CHAINS_PER_AGENT`（2）条可复用链，并在每次委托结算时淘汰最久未活动的
那些；仍在工作的链永不淘汰，所以这个上限只算可复用链，活跃链可以让它暂时超出。

恢复严格限定在同一会话内，且从不排队：对正在运行的委托做恢复是一个工具错误，提示父级
先用 `TaskWait` 收敛；一条链在任何时刻最多只有一条活跃记录。`model` 与 `resume` 同时
给出会被拒绝，而恢复后的运行会沿用该链记录的绑定：优先使用链解析出的
`providerId/modelId` 键，从 transcript 重建的链则按模型 id 匹配；当什么都匹配不上时，
运行会继续使用定义当前的绑定，并把先前的模型 id 记进它生命周期 details 的
`modelChangedFrom`。有意换模型意味着新建一个委托。未知 id、属于另一个定义的 id、
不可恢复的状态、超出读预算的链，以及行已经不在的链，各自返回一个说明原因的工具错误；
对未知 id，还会一并列出当前可复用的 id。

父级通过系统提示发现可复用的链：那里列出每条链最新的 `delegationId`、它的目标，以及它
读过的文件最多 `MAX_RESUMABLE_LISTED_FILES`（8）个（超出部分带 `(+N more)` 后缀）。
清单会在委托结算时围绕既有的提示段落重新组装。对 `MAX_SUBAGENT_CONCURRENCY`、
`TaskWait`、`TaskList`、`TaskStop` 以及生命周期快照而言，恢复来的运行就是一个普通
委托。`Task` 的立即返回结果与生命周期 details 会增加 `resumedFrom` 以便追溯；
transcript 把一条链渲染成它最新 `Task` 卡片下的一段连续多轮对话，不带单独的
“已恢复”标记。

**模型引脚。** Frontmatter 中的 `model: <provider>/<model>` 在每次启动时于
Electron main 里解析一次——凭据与 models.dev 快照都在那里——匹配提供商 id、
厂商键或显示名称，且最多 `MAX_SUBAGENT_PROVIDERS`（8）个不同的提供商。无法
解析的引脚会被有意地排除在绑定映射之外；运行时把这个缺失的条目转成一个点名
该引脚的工具错误，绝不回退到会话模型。定义中的 `thinkingLevel` 会按第 5c 节
同样的"就近支持"规则，对照解析出的模型做钳制；特殊值 `omit` 故意
不发送思考覆盖，把控制权留给提供商适配器自己的默认行为。
`agents.create` 和 `agents.update` 只接受这种 `<provider>/<model>` 形状的引脚；
缺少提供商部分的值会被拒绝并返回 `SUBAGENT_INVALID`，而不是被写入，因为运行时
永远无法解析它。只有斜杠是结构性字符——提供商部分按归一化别名匹配，
因此包含空格的显示名是合法的。


**上下文预算与压缩（ADR 0299）。** 委托拥有与会话相同的窗口保护，并且以相同方式
推导。预算取自该次运行实际解析出的模型 —— `Task.model` 覆盖、定义引脚，或继承
的会话模型 —— 走第 5.1 节那条共享推导，因此 `hardLimit` 就是该窗口减去同样的
请求余量，而按定义声明的 `maxTokens` 上限作为输出预算参与其中。在委托的回合边界
上，该次运行会重新估计它自己的上下文；达到或超过 `hardLimit` 时，就在下一次提供商
请求之前同步压缩，保留模式按与会话相同的生命周期规则选择：仍有待处理工具结果的
边界按活动回合保留，已完成的边界按完成回合保留。没有任何预计算，也没有第二道阈值。

当摘要无法生成，或压缩后的上下文仍然超出预算时，该次运行降级：只保留原始任务简报
加最近的若干条消息，丢弃其余历史，继续运行，并记录它已被降级，因此报告与生命周期
details 会说明该委托丢失了历史，而不是把一个不完整的答案当作完整答案呈现。若连这样
也放不下，该次运行以 `SUBAGENT_CONTEXT_OVERFLOW`（不可重试）失败，点名父级可以改变
什么 —— 缩小任务范围、改用窗口更大的模型、一次读取更少内容 —— 而不是把提供商的
溢出文本转发出去。

有序备选模型在被尝试之前会对照它自己窗口重新评估：预算装不下已携带上下文的备选
会被跳过，并以该理由记入 `modelFailures`，而不是被重试进同一个失败。恢复来的链在
预算之内播种 —— `seedDelegateMessages` 保留原始任务简报与最近的轮次，并优先丢弃最旧
的工具结果 —— 因此一次恢复从 `hardLimit` 之下开始，而不是在它的第一次请求上就溢出。

委托压缩只影响委托的模型上下文。它不改写任何持久化的转录行，不写入 host-core 检查点，
也不添加压缩行、警告 toast 或上下文检查器条目；委托保留它完整的可见行，父级依旧只看到
报告。压缩完全自动：`new_context` 对委托仍然被拒绝，因为执行它会设置父级运行时的待压缩
标记。

**事件与上下文。** 委托发出的每个事件都在信封上携带 `parentToolCallId` 和
`agentName`，Electron main 会把这两者一并复制到持久化的行上。运行时重建模型
上下文时会跳过每一条带 `parentToolCallId` 的行：父级从始至终只通过 `TaskWait`
或运行时的完成提示（D328）看到报告，重放委托的行既与这一点相矛盾，也会重新
引入委托机制本就是为了避免的上下文开销。

**回合所有权。** 委托的生命周期永远不会轮到 Electron main
处理。父级可以在 `Task` 之后继续自己的主线或对用户说话。如果它在委托仍在
跑时停止调用工具，运行时保持持久回合打开，并在它们完成时交回报告。用户
Stop、`TaskStop`、运行时销毁或父级终态错误（D352）会中止仍在运行的委托。

### 5f.1 委托权限作用域（ADR 0089）

委托的工具调用与父级走同一条 host `tools.execute` 路径。当定义声明了
`permission` **且其来源是 `builtin` 或 `user`** 时，sidecar 把作用域附加到
委托的工具 RPC 上，host-core 在该模式下裁决调用，而不是使用会话的有效权限
模式。`project` 定义声明的作用域会在解析时被丢弃并留下警告，因此打开一个
不可信的仓库无法把它自己的委托提权到会话模式之上。两个门禁与对待会话
模式一样始终高于作用域：契约模式的硬拒绝（委托只存在于 Agent 模式）
和外部路径门禁 —— 带作用域的委托在触碰工作区与 scratch 根之外的任何
东西之前仍然会询问。因此 `accept-edits` 意味着“工作区内的
Write/Edit 免提示裁决；其余一切按会话模式行事”。

周围的合约位于 `03-tools-and-permissions.md` §10.2（什么是
代表可以致电），`04-data-storage.md` §4.7a（持久归属），
`04-ux/03-permission-ux.md` §6a（多个待处理请求）以及
`04-ux/08-component-spec.md` §9.9（代表团如何解读）。

### 5f.2 不存在同级或父级之间的通道（D326、ADR 0165）

并发的受委托方之间不互发消息，父 agent 也不向其他会话发消息。进程内的
`Peer` 邮箱（ADR 0138 / ADR 0140）与 host-core 的 A2A 代理（ADR 0147 /
ADR 0162 / ADR 0164）均已撤销。

协调工作仍然走既有的委托契约：父方撰写彼此独立的任务简报，启动 `Task`，
再通过 `TaskWait` / `TaskList` / `TaskStop` 收集各自完备的报告。如果还需要
下一轮工作，那就是一个新的 `Task`，其简报里包含先前的报告。`A2A` 与 `Peer`
不是可分配的工具；定义中若出现这两个名字，会被当作未知工具名，并在解析时
带警告丢弃。

## 6. 提供商和模型

> 完整政策：`11-provider-model-system.md`、`12-provider-config-schema.md`、`13-model-catalog-and-selection.md`。

覆盖策略：

1. **由 pi-ai 公开的原生提供商**（OpenAI、Anthropic、Google 以及其他可在 pin 版本上使用的提供商）
2. **兼容OpenAI**网关和长尾供应商的一流路径
3. **具有协议配置文件的自定义提供商**
4. **可刷新模型目录** + **自由格式模型 ID**（无封闭许可名单）

MVP UI 始终至少包括：
- OpenAI
- Anthropic
- 谷歌 Gemini
- OpenAI 兼容（通用）
- 自定义提供商条目

运行时职责：
- 解决 `(providerId, modelId)`
- 解析并序列化完整的 pi-ai 模型记录，或将模型标记为
  未知的通用后备
- 由此解析模型推理能力和有效思维水平
  相同的记录
- 通过主机获取机密（切勿在日志中缓存原始机密）
- 将供应商故障转换为提供商 AppError 代码
- 将 tokens/events 流式传输到协调器
- 支持abort/cancel中流

本地模型通过 OpenAI 兼容端点（Ollama、LM Studio、vLLM 等）获得支持。

### 6.1 一次性 Composer 增强

Composer 增强使用与 agent 请求相同的已解析提供商绑定和重试分类，但会创建一个
独立的补全上下文，其中恰好只有一条用户消息和那段静态的增强系统提示。它不会
实例化会话 agent，不包含转录历史，不暴露工具，也不持久化任何回合。渲染器只
拿到裁剪后的文本结果；API key 与厂商刷新凭据始终留在 Electron main。存在会话
时，OpenCode Go 的一次性调用复用会话 id 作为 `x-opencode-session`；否则运行时
会为该次调用合成一个 id，使网关接受该请求。

### 6.2 OpenCode 会话路由标头

对话、子代理、上下文压缩摘要、提示增强以及插件的一次性补全，只要其提供商满足
下列任一条件——`apiStyle` 为 `opencode_go`、`vendorKey` 为 `opencode` 或
`opencode-go`、pi-ai 提供商 id 为上述值之一，或 base URL 的主机为
`opencode.ai`——都会发送：

- `x-opencode-session`：持久的对话 id；调用方没有会话时则为一个按次生成的 UUID
- `x-opencode-client: pi-desktop`
- `User-Agent: pi-desktop/<APP_VERSION>`

调用方自带的标头会覆盖 client 与 User-Agent 默认值。空的会话标头会由对话 id
补回，使 OpenCode Go 不会返回 `MissingSessionID`。提供商行上的 `headers` 映射
在这次合并之后应用（标头加上一层 fetch 包装），因此自定义值优先于 OpenCode
默认值，也优先于适配器的最后写入。保留键无法冲掉 `x-opencode-session`。这属于
agent 运行时的职责，与官方 Pi 编码 agent 的归属层保持一致；pi-ai 的 `sessionId`
流选项并不会发出 `x-opencode-session`。

上下文压缩摘要同样是这一类提供商请求，但 harness 会自行组装其流选项，不会经过
会话的 stream 函数，因此 agent 运行时把这次标头合并应用到交给压缩的模型集合
上。该请求携带会话自己的对话 id，而不是 harness 否则会生成的按次 id，这样摘要
就与它所压缩的对话落在同一个网关后端。


## 7. 系统提示组成

```text
[base product prompt in English]
+ [operating-state prompt: agent/plan/goal]
+ [workspace info]
+ [tool instructions]
+ [project instruction chain, when present]
+ [optional user custom instructions]
```

基本提示明确指出协作规则，因为省略它们
是产生静默会话的原因：“更喜欢简洁、可操作的答案”
只有相关的行，而推理模型将其执行为根本没有说什么。
所需的行为，每一项都是观察到的相反的失败：

- 以用户书写的语言回答
- 每个工具批次前一句话，且沉默时间不得超过一个工具
  批量或 60 秒的工作
- 用户提出的任何问题都会以可见文本的形式得到答复；推理未显示
  给他们，并不算作答案
- 最终消息是独立的
- 工作是从头到尾进行的，而不是停留在分析上
- 工具调用通过本机工具调用接口；写成散文的电话
  （特别是 OpenAI 风格的 `multi_tool_use.parallel` 包装器）不运行，并且
  当模型发出一个模型时，运行时会记录它

它还说明了与主机端预算相匹配的搜索偏好
[16-工具结果限制](/zh-CN/spec/03-runtime/16-tool-result-limits)：范围 `Read`、`Grep` 和
`Glob` 用自己的参数代替手卷 `Read`/`Grep`/16-tool-result-limits.md/
`find`。 `Read` 仅接受现有的常规文本文件。当文件名是
不确定或必须列出目录时，Agent 会激活 `Glob`
通过 `ToolSearch` 获取当前提示，而不是猜测名称或阅读
目录。 `Glob.path` 是一个目录，而 `Grep.path` 可能是一个文件或一个
目录树。调用使用 `Read.offset/limit`、`Glob.path/limit` 和
`Grep.path/include/outputMode/headLimit`； `filesWithMatches` 或 `count` 避免
不需要的内容。工作区相对路径仍然是可移植的默认路径，带有
仅当本机工具不足时才在活动 shell 中使用有界命令。
Grep 在本机装有 `rg` 时使用它，否则使用进程内搜索器；代理应调用 Grep 而不是在 Bash 里跑 `rg`。Bash 仍不得假定 `rg` 存在。代理不得重复已经在上下文中的搜索。

编辑规范块携带
[18-line-anchored-edit-contract](/zh-CN/spec/03-runtime/18-line-anchored-edit-contract)
的行锚定 `Edit` 契约：操作表、仅 `+` 正文规则、“范围只命名被改动的行”、
“在每次成功写入后依据返回的 tag 重新定位”，以及成文的反模式。sidecar 的
`Edit` schema 是 `{ path, tag, ops }`；`old_string` 与 `new_string` 不再存在，
并且 sidecar 的工具描述必须在实质上与 host-core 的 `builtin_tool_defs()` 条目
逐字一致，因为按一种语法教出来、却用另一种语法校验的模型每次调用都会失败。

### 7. 1 活动工具上下文和按需加载（D185、ADR 0048）

sidecar 构建了一个完整的工具注册表，但它不会序列化每个工具
将模式注册到每个提供商请求中。每个新用户提示都以
该模式的核心集：

- Agent：`Read`、`Bash`、`Edit` 和 `Write`（匹配 pi 的编码代理核心）
- Agent：只要技能目录非空，`Skill` 也在核心集中（D404、ADR 0230）——`# Skills`
  段落与用户输入的 `/skill-id` 都要求模型调用它，而模式中缺失的工具根本无法被调用
- Agent：当子代理目录非空时，`Task`、`TaskWait`、`TaskList` 和
  `TaskStop` 也是如此 (§5f) — 模型必须寻找的能力是它不会使用的能力，
  委托生命周期值得每个请求的额外模式
- Plan：`Read`、`Glob`、`Grep`、`BrowserPreview` 和 `Bash`
- 两种模式：`ToolSearch`（当至少存在一种延迟功能时）

在Agent模式下，`Glob`和`Grep`加入`BrowserPreview`、插件工具，
以及延迟集中的插件开发助手。两种合约模式均保留
他们的 read/inspection 核心可用，而该类的提交工具
（`SubmitPlan` 或 `SubmitGoal`）仅在规划状态期间公开，并且
仅适用于主动类型。延迟工具已注册，但其名称和
紧凑型
一行描述出现在 `# On-demand tools` 目录中；参数
模式则不然。目录是有限的，因此具有许多工具的插件无法
重新创建原来的提示膨胀。
该模型使用确切的名称或简短的功能查询调用 `ToolSearch`。
sidecar 激活最多四场比赛，通过返回他们的名字
pi-agent-core 的 `addedToolNames`，并用这些重建下一轮上下文
模式。具有本机延迟工具搜索的提供商可在以下位置接收定义：
该负载点；其他提供商通常会收到活动定义。

延迟激活会在每个新用户提示之前重置，因此之前的任务
无法使不相关的第一个请求携带不断增长的工具集。工具
注册表、主机权限路径、工具超时和工作区包含规则
保持不变。 `ToolSearch` 是 sidecar 的本地变量，不跨越
主机 RPC 边界。其激活标记保留在持久化工具中
结果，尽管重新启动，恢复的转录仍然是提供商有效的
在重用延迟功能之前，运行时仍然需要重新搜索。

对于用户可见的 HTML 可交付成果，默认系统提示要求代理
创建页面或创建第一个页面后激活 `BrowserPreview` 一次
使用工作区相对路径进行有意义的可视化编辑。代理重用
迭代时实时重新加载预览，而不是发出重复预览
来电。生成的、仅供测试的和非可视的 HTML 文件被排除在外。当
工具被延迟，`ToolSearch` 必须在预览调用之前激活它。
### 7. 2 Plan 提示要求

Plan 提示告诉相同的 Agent 了解请求，检查
相关 repository/specification/test 上下文，识别受影响的文件并
风险，包括重点验证和 migration/recovery 影响、表面风险
开放式问题。当任何初始或修订计划准备就绪时，必须调用
`SubmitPlan` 在当前回合中立即恰好一次，并完成一个
降价快照。已接受的新 Plan 提示没有事先等待批准；
记录中较早提交的内容是历史上不可变的检查点。
拒绝、过期或中断后，Agent 可能会在新一轮中修改，并且
必须遵循相同的 one-SubmitPlan 规则。它不得声称变更是
做了。主机写入不可变的 `.pi/plan/*.md` 工件； Agent 确实
本身不编写或编辑它，并且不接收请求更改流。

该提示可能会将 Bash 描述为受权限限制且可能会发生变异。它
不得将 Plan 描述为严格的只读安全边界。

### 7. 2a Goal 提示要求

Goal 提示告诉同一个 Agent 在任何事情之前协商目标合同。
自主工作。它要求实现什么而不是如何实现：结果、结果
验收标准和边界。它不能枚举实现
步骤，因为 Agent 在批准后自行决定这些步骤。每一次接受
标准必须能够在执行后由 Agent 客观地检查——命令
那必须过去，或者是可观察到的行为。 Agent 检查工作空间并
首先询问任何不明确的问题，然后立即准确地调用 `SubmitGoal`
当前回合中一次，包含一个完整的 Markdown 快照。

一次提交规则、历史检查点规则、关闭后修改规则、
no-chat-confirmation 规则和 host-writes-the-artifact 规则相同
作为 Plan，用 `SubmitGoal` 和 `.pi/goal/*.md` 代替 Plan
等价物。提示还指出，一旦获得批准，合同即为
Agent 所遵循的标准：自主追求目标、选择
它自己的方法，只有当每个验收标准都得到验证或一个
边界挡住了它。

### 7. 2b 子代理提示组成（D201、ADR 0062）

代表的系统提示在 sidecar 中由三部分组成，其中
order：委托框架、定义的 Markdown 正文和工具
其宣称的工具所获得的指导。身体位于工作空间引导前方
所以项目自己的说明仍然具有最终决定权。

框架陈述了代表的处境的形状，这不是
从正文中可以推断：这是一项委托任务，委托人看不到
用户，提出问题或进一步委托，它完全具有列出的工具，并且
它的最终消息是主代理收到的唯一消息。只读
定义还被告知永远不要报告它无法进行的编辑；
一个具有写入能力的人被告知只能触摸该任务所涉及的文件。

指导块与会话提示使用的文本相同，仅在以下情况下包含：
该定义声明了匹配工具：search/read 范围为
Read/Grep/Glob，编辑 Edit/Write 的规则，命令 shell 合约
Bash 以及会话具有临时目录时的临时目录规则
代表可以写。附加项目指令链（§7.3）
最后，因此代表遵循与其会话相同的项目规则。

### 7. 3 项目指令链

Electron主流程首先解析全局
`~/.pi/agent/AGENTS.md`，然后将指令文件投影到
运行时启动时的会话绑定项目根。对于每个项目目录
按以下顺序最多使用一个非空文件：`AGENTS.override.md`、`AGENTS.md`、
`CLAUDE.md`，然后是 `.claude/CLAUDE.md`。条目由项目串联而成
root 到目标目录，因此最接近的文件最后出现并占用
优先。初始链的目标是项目根。在 `Read` 之前，
`Write`、`Edit` 或 `BrowserPreview` 调用，sidecar 要求 Electron main
解析目标路径并用该路径替换活动指令部分
工具执行之前路径的完整链。这使得规则变得懒惰并且
防止代理移动到同级目录后保留同级目录规则
不同的文件树。

会话绑定的项目根与运行时启动元数据一起传递，并且
在每次提示或压缩请求之前由 Electron main 注册。的
sidecar 无法选择不同的根。在一次提示期间，路径解析
声明由项目根目录和目标目录缓存，因此重复文件工具
在同一目录中不要执行另一个 IPC 请求。索赔被放弃
在下一个提示下，允许进行编辑和新创建的指令文件
没有陈旧的跨消息缓存的效果。

路径特定的解决方案是尽力而为的，并且有 2 秒的截止日期。如果
解析器或其主机 RPC 不可用或超过该截止日期，该文件
工具继续运行运行时的 base/root 链，而不是等待
一般主机RPC超时。失败的解决方案永远不会留下以前的解决方案
已解决同级目录链处于活动状态。

所有发现都保留在会话项目根目录中。空的、不可读的、
跳过根目录外的文件。合并的 UTF-8 内容上限为 32 KiB
源路径标记在 `# Project instructions` 下。
sidecar 从不直接读取工作区指令。改变的根链
在下一个提示时重新创建空闲运行时；嵌套指令已解决
当相关文件工具运行时再次。解析器的超时和 fallback 是运行时保护措施；
它们不会输出独立的 timing 日志记录。

设置为固定全局路径提供专门的管理。项目
查看项目列表菜单为其相应的项目提供了 `AGENTS.md` 编辑器
注册的项目根。其 IPC 不接受任意渲染器文件路径。
保存会影响下一个提示，而无需重新启动应用程序。

## 8. 并发

| 适用范围 | MVP 政策 |
|---|---|
| 同一会话 | 单圈串联 |
| 不同的会话 | 有限并行 |
| 工具 | 默认情况下是顺序的 |
| `Task` 通过一条助理消息进行呼叫 | 并行，每会话 10 个运行委托 (ADR 0089) |

工具并发性通过 pi 执行模式来表示：每个目录工具都是
`sequential` 和 `Task` 单独为 `parallel`，并且 pi 按顺序运行批处理
一旦它包含一个顺序工具。因此，全 `Task` 批次是唯一的批次
扇出，并且所有其他订购保证均不变。代表问题
主机独立调用，以及 host-core 的每次会话一次突变准入
防止写入撕裂，但留下两个无序的相同路径突变，因此
sidecar 序列化针对相同标准化路径的 IPC/`sequential` 调用
在到达宿主之前；不同路径上的调用永远不会相互等待。
这就是保持每个路径编辑恢复规则的原因
`03-tools-and-permissions.md` §4d 在扇出下有意义。

选择另一个项目选项卡仅影响可见的 shell 工作区。它
不会处置、中止或重新启动属于另一个会话的运行时。

## 9. 中止语义

- 停止模型流
- 尝试取消可中断工具
- 不自动回滚已完成的写入
- 在 UI/storage 中标记回合已中止
- 保留已过去的响应持续时间；当提供商最终使用不可用时，
  估计可见思维以及每个 4 个 Unicode 代码点的答案输出
  令牌并将其保留为 `responseOutputTokens`，因此停止轮吞吐量为
  仍然可用并且明显近似
- 渲染器智能停止转录撤消和结构化输入框恢复
  中止后的协调；他们不会改变运行时取消或滚动
  返回完成的工具效果

## 10. 明确的非目标

- 没有 DOM 知识
- 无法绕过 Rust 主机进行直接 FS 访问
- events/logs 中没有秘密泄露

## 11. 实施状态（M5）

实现：流转OpenAI兼容协议路径
（通用逃生舱口，D024）；每个会话强制执行一个活动回合
`AGENT_BUSY`；根据接受的提示返回真实的 `turnId`；供应商失败
映射到 `PROVIDER_UNAUTHORIZED` / `PROVIDER_RATE_LIMITED` /
`MODEL_NOT_CONFIGURED` / `STREAM_FAILED` / `TURN_ABORTED`（可检测）。
桌面开发生命周期重建 `packages/agent-runtime/dist`
在 Electron 启动之前，因此生成的 sidecar 始终执行当前的
标准化和误差映射源。

跟踪差距（MVP 后积压）：更丰富的系统提示组成 (§7) 和
provider/model 目录发现超出当前有线路径。

### 运行范围状态 v2 与合约工具目录（M5/T20-B1，ADR 0308）

T19-C 的 `desktop-state.json` 升级为 schema v2：除技能/记忆外，每提示词还写入必填的会话
`mode`、生产 `composeModeSystemPrompt(mode, "")` 块、**已解析**的有效 `permissionMode`
（`inherit` 按 host-core 语义解析为应用当前 `defaultPermissionMode`，否则 `ask`）以及本次注册
目录的每宿主工具 `{name, risk, planSafeActions, origin}` 策略表。策略半部分是强制的：宿主行
读取、枚举校验、compose、写入或自校验任一失败都会在提交前拒绝提示词（不再有 tombstone、也不会按
Agent 继续）；技能/记忆仍为 PI 式 best-effort。gate 在 `before_agent_start` 先追加能力块、最后
追加 mode 块（纯追加、恰一次、单一 system），并在 Plan/Goal 用 `setActiveTools` 夹取 PI 合约目录
（`read/glob/grep/bash/ask/new_context` ∩ 实际存在，加上声明了非空 planSafeActions 的插件工具；
Write/Edit/未知/用户 MCP/未声明插件永不进入；不虚构 PI 的 BrowserPreview）。

2026-10-02 复审返修补齐四条失效语义：①**强制通道在启动时确定**——supervisor 以显式
`desktopStateRequired`（生产 wiring 恒为 `true`，未配置该通道的夹具显式传 `false`）在 spawn 时写
`OMP_DESKTOP_STATE_REQUIRED=1|0`；开关随进程生命周期固定，删除/篡改运行根内任何文件都不能把它关掉。
开关开启时，交互会话任何"非 owned 且有效"的状态（缺失/不可读/超限/无 identity/他会话/未知 schema）
都必须拒绝回合（零 provider 请求），只有委托会话（`hasUI=false`，`task`/`eval` 子代理的扩展运行器
没有 UI 上下文）保持零注入跳过；关闭时夹具明确退化。②**拒绝终态与回合绑定**——除 `ctx.abort()` 外，
gate 通过运行时正式的 `notify` 通道发出带版本的结构化拒绝描述符（`v: 2`）。每次提交通道前，runner
先铸造随机 32 位十六进制 **turn token**，用 `get_available_commands` 确认受信 gate 注册了内部命令
`/omp-desktop-turn`（未注册则说明该运行时会把握手文本当用户提示词送给 provider，因而在提交前拒绝），
再经正式 RPC `prompt` 路径发送握手（由 `#tryExecuteExtensionCommand` 在 provider 循环前本地消费，
不进入 provider/transcript/工具目录），并等待 gate 经 `notify` 发回的版本化确认；拒绝描述符必须命中
本 entry 的 native session 且携带该代 token、fence 已确认、当前代尚未 `agent_start`，才关闭该代：恰
一次 `error`（`OMP_RUNTIME_STATE_REFUSED`）+ 恰一次 `turnEnd(error)`，关闭 dialogs/hostcalls 并回到
idle。重复投递、上一代的迟到描述符（旧 token）、他会话/子代理信号只计数不关闭；`v: 1`（无 token）不再
可解析。命令缺失、握手被拒或未确认会在发送用户提示词之前失败。准备期间到达的 Stop 或 dispose 会取消
被准入的那一代：runner 在每个 await 之后、写入用户内容之前立即重验准入时捕获的代号，以 `aborted`
恰一次关闭被取消的代（Stop 因此无需 teardown 即可收敛）并拒绝该 prompt；迟到的握手/确认续延既不能装上
过期 fence，也不能提交被取消的 prompt。③**离开合约模式重建
运行时进程**——扩展面只暴露按名选择的 `setActiveTools`（会把它恢复的名字钉在顶层），没有
presentation 恢复 API（`setActiveToolPresentation` 非扩展接口，RPC 也无该命令），因此 Plan/Goal →
Agent 时 bridge 回收进程、下一次提示词在同一持久 native 会话（`switch_session`）、同一项目/模型
投影上重建默认呈现（native 顶层 + `xd://` 延迟分区）并重注册宿主目录，seeds 跨替换延续、无重放、
身份不变、被移除/禁用的工具不复活；回收失败则拒绝提示词。gate 自身的 Agent 恢复路径保留为同进程
回退：恢复夹取前选择 + 夹取期间被移除的名字，目录类名字按**当时**目录过滤、native 名字按夹取前
选择过滤，不用 `getAllTools` 全开。④子代理仍零注入、审批描述符仍携带有效权限模式。本节写作时
T20-B2/D 尚未开始（B2 与 T20-D 见后续小节）；
T20-C 见下一节（其复审返修后，产品路径的 `tool_call` 不再按调用回读状态文件：描述符携带的
risk/mode/permissionMode/理由全部来自本回合被准入的不可变策略，可变文件只在准入时被读取）。

### 提交、审批与派发（M5/T20-B2，ADR 0310；2026-10-03）

非 Cursor 路线现在实现 Plan/Goal 的提交、审批与派发闭环（证据
`docs/validation/M5-t20-b2-submit-approval.md`）。`plan`/`goal` 能力键的开放与真实桌面验收
由 T20-D 完成（ADR 0312；证据 `docs/validation/M5-t20-d-capability-ui.md`）：能力**声明**
与运行时**阶段**是两个轴，声明表示引擎可以承载该模式，不等于当前有进程在运行。

- **提交工具**：bridge 在每次提示词的唯一目录装配点追加**当前合约模式自己的**提交工具——Plan 只有
  `SubmitPlan`、Goal 只有 `SubmitGoal`、Agent 两者都没有——名称/描述/schema（required 的
  `title`/`markdown`/`question`）与 PI 逐字一致，声明 `loadMode: "essential"`、
  `concurrency: "exclusive"`、`batchPolicy: "sole"` 与补丁级 `.4` 的
  `terminateOnSettle: true`；运行域策略表声明 `{risk: "low", origin: "desktop"}`。gate 的合约决策只放行
  本模式自己的提交工具（另一种 kind 以 `PLAN_KIND_MISMATCH` 拒绝），目录夹取保留该名字。声明在 agent
  loop 的统一结算边界强制执行：成功、宿主拒绝、语义错误与**从未到达 execute 的 schema 校验失败**都
  在提交后终止且无后续 provider 请求；被批次准入拒绝或中断跳过的调用不终止，混合批次仍整批零副作用
  `block-and-continue`。
- **身份**：bridge 是 OMP 持久 host turn 的唯一责任方——每次被接受的提示词（普通入口与批准执行入口）
  提交前恰一次 `session.beginTurn`，runner 关闭该代时恰一次结算（`recoverInflight: false`、不建通知），
  live `omp-turn:…` 代号与 host turn id 分开保存。executor 只使用绑定中的
  `{sessionId, hostTurnId, toolCallId}` 提交；宿主 `plans.submit` 仍是权威（durable kind、每会话一个
  pending、live turn、工件发布），其错误码原样到达模型。
- **审批与派发**：复用既有 `plans.resolve` 事务（approve → `mode=agent` + 所选 `permissionMode` +
  `queued`）与既有 `PlanApprovalBar`/`plans.changed` 表面，不新增第二审批队列。`runtime/plans.ts` 在
  任何持久变更前判定引擎：OMP 先等本会话 live 回合结算，再以 queued→running CAS 恰一次 claim、恢复
  native 会话身份，并把共享的 `approvedPlanInstruction(execution)`（工件路径、标题、问题与边界标签内
  的完整 Markdown）经同一 prompt 路径提交；Pi 路径不变；其它引擎/拒绝在 claim 前跳过。拒绝/过期/
  中断、CAS 失败者与重启维护都不会发提示词、不会重放；完成/中断按持久 host turn id 结算，后来的回合
  不能结算错误的执行。Goal 延续定时器仍未实现（一次批准的 Goal 是一个 agent 回合，与本版本 Pi 路径
  一致）。

### 执行时权限决策（M5/T20-C，ADR 0309；2026-10-03 复审返修见 §6）

受信 gate 的 `tool_call` 决策升级为 PI §1.3.1 的顺序（mode / 已解析 permissionMode / 每宿主工具
risk+planSafeActions）；复审返修（ADR 0309 §6）把策略来源收紧为**每次提示词一份被准入的不可变快照**
并把 session grant 交给桌面会话拥有：

- **每提示词一份被准入策略**：runner 在每次提示词前用既有 `/omp-desktop-turn` 握手同时安装新的 turn
  token 与桌面策略准入（会话 `mode`、有效 `permissionMode`、宿主工具 `{risk, planSafeActions,
  origin}` 表与会话 grants，由 `session/turn-admission.ts` 编码）；gate 只为该 token 安装该准入，并以
  所安装参数原文的 SHA-256 回执，runner 只有在回执匹配后才提交用户提示词。该回执是同一受信运行时进程内
  runner 与 gate 之间的**应用自有一致性校验**，不是对桌面端的密码学认证，也不如此声称：握手走运行时自身
  的本地命令通道，能在该进程内发起提示词的写入方本就在该准入的防护边界之外。该回合的每个调用——所属
  会话自身调用与其委托（`hasUI=false`，须先按下方"委托与失败"绑定到本回合）——都只依据这份不可变
  记录决策；运行域状态文件降为**内容通道**（mode 块、技能、记忆与强制存在性证明），产品路径不再为
  策略回读它，因此工具体在同一提示词内改写 `permissionMode` 不能让本回合的后续调用放宽。`agent_start`
  武装记录、终止性 `agent_end` 退役（计划内续跑保留）、启动拒绝清空；未真正启动的记录、他会话交互
  上下文，以及强制通道下没有任何记录的进程一律 block（`policy-unavailable`）。无 payload 的宿主
  （不发送准入的夹具）退化为"该回合第一次校验通过的读取即冻结准入"，同样不受回合内改写影响；每个
  新提示词重新解析设置并整体替换记录。
- **顺序**：合约模式硬拒绝最先——PI allowlist 之外的任何工具、无非空 `planSafeActions` 的插件工具，
  在任何 permissionMode、外部路径、session grant 与夹具开关之前被 block，拒绝码为
  `WRITE_DISABLED_IN_PLAN` / `EDIT_DISABLED_IN_PLAN` / `PLUGIN_DISABLED_IN_PLAN` /
  `TOOL_DISABLED_IN_PLAN`；随后是显式外部路径例外（`auto` 放行、session grant 放行、否则弹卡）；
  再按 Low / `auto` / `accept-edits`（仅 Write/Edit）/ session grant；其余弹卡。`ask` 与 PI 专名
  `BrowserPreview`/`new_context` 保持合约许可（不注册 BrowserPreview）。对已准入回合，
  `OMP_DESKTOP_GATE_MODE` 完全失效（不能越过 PI 顺序放行或拒绝），`OMP_DESKTOP_GATE_TOOLS` 只能向产品
  默认 gated 名单**增加**名字、不能缩小。被裁决集合＝配置的副作用原生名 ∪ 全部桌面宿主工具；两者之外
  的原生名不由本 gate 裁决（OMP 自身审批仍然生效），而被裁决的未知名字风险按 PI 默认取 Medium、绝不
  取 Low。
- **外部路径**：`session/tool-paths.ts` 移植 host-core `workspace.rs` 的语义（词法 `.`/`..` 归一
  与根钳制、按组件包含、最深已存在祖先 canonicalize 与有界悬空符号链接跟随、workspace/scratch
  双根与 `requires_external_path_permission`），`..`/符号链接/别名逃逸会弹卡而不是漏过；相对路径与
  PI 一样先并入 workspace，因此相对逃逸（`../outside`）**确实**走外部路径分支，macOS `/var` 别名行为
  与 PI 的"先词法根、后 realpath"顺序一致；OMP 会话当前没有 scratch 根（参数保留并已有测试）。
- **风险保真**：原生名按 PI 映射（read/glob/grep Low；write/edit/bash High；其余含 `apply_patch`、
  `eval`、`browser`、`computer`、`BrowserPreview` 一律 Medium）；宿主工具取状态策略表的声明风险
  （缺失/未注册 → Medium）；`mcp_*` 在非合约模式为 Low。`browser`/`computer`/`browserpreview`
  加入默认 gated 名单，使其在 ask/accept-edits 下弹卡而不是无审批执行。
- **Session grant**：桌面把用户真实选择原样回传——`allow-session` 映射为 gate 的第二个选项
  （`Allow for this session`），也是 gate 唯一据此授予会话范围的标签；桌面会话的 grant 存储（bridge
  侧对应 PI 内存态 `AppState.session_grants`）只在决定**确实送达**时记账（过期、取消、发送失败或重复
  裁决都不会产生或重放 grant）。grant 随每次准入重新下发，因此同一会话的运行时替换（Plan → Agent
  重建）后仍然有效；它按桌面会话隔离、在 native 身份更换时丢弃，并由 `clearSessionGrants`
  （对应 PI `permissions.clearSessionGrants`）与删除会话路径显式清除；绝不作为落盘的提权通道。
- **插件真实模式**：bridge 记录被准入回合的 `{turnId, mode}`，执行器只按该回合读取（未知回合拒绝），
  插件执行上下文收到真实 mode，PI 的逐 action `planSafeActions` guard 因此在执行时生效；用户 MCP
  工具在非 agent 模式于适配器边界拒绝；插件子进程 API 现在把 `planSafeActions` 转发给
  `agent.registerTool`（修复上游 child 未转发、guard 恒见空列表的缺口）。
- **委托与失败**：强制通道开启时，状态不可读/他会话/非法的交互会话每个调用都 block
  （`policy-unavailable`）；委托会话（`hasUI=false`，真实子代理）**只依据其启动时所绑定的那一份准入**
  裁决——在自身 `session_start` / `before_agent_start` / `agent_start` 且该准入仍存活、已武装时完成绑定；
  该记录一旦退役（终止性 `agent_end`、启动拒绝）或被下一次 fence 整体替换，委托即被拒绝，绝不借用
  更新的回合策略。从未在任何存活准入下被观察到的委托 fail closed；自身会话头显示其创建早于该准入被
  武装的委托（延迟启动、parked/revived worker）同样拒绝——延迟启动绝不"顺手"归入更新的回合。当公开
  接口暴露会话文件时，委托声明的父链（`getHeader().parentSession` 沿已记录中间会话上溯）必须抵达该
  准入的所属会话文件，且**每个中间跳都必须绑定到正在被主张的那一份准入记录本体**（按记录身份而非
  token 比较）：中间跳属于已退役或别代准入、或从未被归属过（延迟启动、链未解析）时整条链一律拒绝，
  因此退休子代理的新后代无法借道接入当前回合；无法抵达所属文件的链同样拒绝。无 UI 只在"本就需要
  交互"处 fail closed——**已绑定**委托的 Low/`auto`/grant 调用照常通过、无提权。
- **卡片一致**：审批描述符的风险、mode、permissionMode 与理由都来自同一个策略对象。
- **证据分层**：gate 层合约硬拒绝（含被 B1 目录夹取隐藏的工具）由 gate 单元测试与真实 Bun 打包的
  产物探针证明；生产 E2E 在真实已补丁运行时上覆盖可达决策，并把隐藏工具尝试如实标为目录层
  "not found"，不冒充 gate 拒绝。

### Provider certificate trust（issue #714）

桌面 sidecar 使用 Node 的 `--use-system-ca` 启动，同时保留内置根证书和继承的
`NODE_EXTRA_CA_CERTS`。它使用操作系统信任库，但不会关闭证书链或主机名校验。
更新本地信任库或额外 CA 启动环境后，需要重启桌面应用。无头 pi-host 启动行为以及
System/Direct/Custom 代理路由保持不变。

在主 session 和内置 delegate 中，明确的证书校验错误在初始化和流恢复阶段都视为
终态。结构化原因会穿过 adapter 的错误扁平化，保留在最终错误行中，也不会触发
provider transport 重建。`EPROTO` 等协议错误继续使用原有重试行为。详见
[证书信任 ADR](../../../adr/provider-system-certificates.md)。

## 16. Plan/Goal × Cursor 产品门（M5/T20-R3C，ADR 0306）

因为 §15 的阻塞是架构性的，产品选择排除该组合而不是声称兼容：**一个会话不得把活跃的 Cursor
模型/提供方与 Plan 或 Goal 模式组合**（用户确认的决策，ADR 0306）。Cursor 的 exec 通道会在响应
仍在流式期间执行工具调用，因此 Cursor 会话无法满足 PI 的过渡工具契约，其副作用也无法撤销。

该不变量由 host-core 在**持久化写入处**强制，而不是由桌面：

* `crates/host-core/src/plan_goal_guard.rs` 在每次打开数据库时在该连接上安装两个 **TEMP**
  `sessions` 触发器——一个针对 `INSERT`，一个针对 `UPDATE OF mode, provider_id`，均为
  `ON main.sessions`。凡是结果为 Plan/Goal + Cursor 提供方的写入都会被 SQLite 本身中止，
  因此过渡工具（`plans.enter`）、`session.configure`、`session.create`、fork、导入以及任何
  将来的写入者都在覆盖范围内，也没有调用方能在"读"与"写"之间把该组合落盘。
* 守卫是**连接状态，不是 schema 状态**：TEMP 触发器只属于 `Database` 持有的那一条连接，连接关闭
  即消失——不会写入 `sqlite_master`、不推进 schema 版本，旧版二进制之后再打开同一文件也不会继承
  任何行为。安装时还会删除提交 `876fb07` 曾写进 `sqlite_master` 的同名持久触发器，使从该版本升级
  只收敛到一份定义；修订后的定义总是替换此前的 TEMP 定义（不使用 `IF NOT EXISTS`）。通过裸
  `sqlite3` 连接（手工编辑）产生的写入不在守卫范围内，仍由派发门兜底。
* 升级顺序同样固定：对已识别的 schema，`Database::open` 在**迁移链之前**先清掉这两个持久名字，
  并且只在**迁移链之后**安装 TEMP 守卫。历史迁移会主动写入受守卫列（v7→v8 会把 `mode = 'chat'`
  改写为 `'plan'`），因此若把清理放到迁移之后，这样的升级会被旧守卫中止——从 `876fb07` 直接跳到
  更新版本安装的数据库将无法打开。清理是精确的：只针对模块拥有的两个名字、只在持久 schema，不做
  前缀或 `LIKE` 匹配，因此 PI 的 `messages_*` 维护触发器与用户自己的触发器都不会被删除；本构建
  拒绝识别的文件（有表但无版本号，或版本高于 `SCHEMA_VERSION`）保持原样、不会被编辑。
* 身份是规范 provider id `"cursor"`，错误码是 `PLAN_GOAL_CURSOR_UNSUPPORTED`（规格 08 §3.2b）。
  两种语言各自只保留一份字面量，并由
  `apps/desktop/test/plan-goal-cursor-constant-parity.test.mjs` 将其钉在一起；守卫的 SQL 由这些
  常量生成。
* 每个可能写入该组合的 host RPC 都返回该错误码。`plans.enter` 与 `session.configure` 本来就会原样
  上报 `PLAN_*` 拒绝；`session.create`、`session.fork`、`session.import` 现在同样如此，而不再压成
  `INTERNAL`。
* 已经持有该组合的行（手工改过，或由守卫存在之前的历史迁移产生）仍可打开，且对其做无关写入仍然
  可用——前提是两个受守卫列**完全保持原值**。把这样的行切换到另一种契约模式属于"新形成该组合"，
  会被拒绝。两条修复路径都是普通写入：去掉模式，或改选其他提供方。任何情况下都不会改写用户的模式
  或模型。

桌面补上触发器覆盖不到的边界：

* `sessionConfigure`、`sessionCreate`、`agentPrompt` 在任何运行时工作之前以同一错误码拒绝同一组合，
  并把 `mode`/`providerId` 放进抛出载荷，使渲染层的 `error.details` 能带上它们
  （`packages/shared/src/plan-goal-model-gate.ts`）。
* 派发门是"守卫看不到的路径"（迁移、手工编辑）的最后防线。
* 渲染层在契约模式下不提供 Cursor 提供方并说明原因；在 IPC 之前以本地化提示拒绝该组合；并跳过会
  形成该组合的自动模型 pin。

非 Cursor 提供方与 Agent 模式下的 Cursor 模型不受影响。R3 本身仍未解除（针对该组合）、
T20-B/C/D 在本门落地时尚未开始：本门是这些工作的前置条件，而不是该功能本身。

**当前范围（2026-10-02）**：该排除是产品的当前范围，而不是临时阻塞——用户把「Cursor + Plan/Goal」
移出范围，同时把非 Cursor 的 Plan/Goal 路线保留在范围内并要求满足严格契约（非 Cursor 提供方不产生
§15 所述预执行块）。上述门与它新增的全部边界继续生效；组合门不拒绝 Cursor + Agent，但当前桌面尚未
接通 Cursor 传输，本轮不新增该能力。T20-B/C/D 在该日尚未开始，且只会针对非 Cursor 路线推进；
拆分见 `docs/validation/M5-t20-non-cursor-scope.md`。

**当前状态（2026-10-03）**：以下仅更新进度口径，不影响本节任何门——根已独立验收 B1、C、B2 与
模型侧 EnterPlanMode/EnterGoalMode；T20-D（`plan`/`goal` 能力声明、composer 入口与真实 Electron
验收，ADR 0312）已实现、待根复审。「Cursor + Plan/Goal」排除与本节全部门保持不变。

## 17. bundled sidecar 的构建与准入（M5/T20-R4B；自 M6/T20-R4-3 起为可复现构建；自 M6/T21-A 起含打包资源验收，ADR 0307）

打包构建只运行一个 OMP 运行时，而该运行时是本项目的构建产物，而不是上游标签：`omp/18.3.0`
加上 patch level `62bc57b+omp-desktop.3`，由 `app/patches/oh-my-pi/manifest.json` 记录的自有 fork
提交承载。

* **构建。** `scripts/omp-sidecar.mjs` 是唯一入口。源码检出的 `origin` 不是清单中的 fork 仓库、
  `HEAD` 不是清单中的 fork 提交、工作树不干净、上报版本不是 `18.3.0`，或相对基线的差异不等于清单
  的文件列表（且受控补丁不能反向应用）时，它一律拒绝。编译使用 OMP 自身的 Bun 单文件构建，因此
  产物就是该提交下 `omp --version` 所报告的可执行文件。入口显式传入编译模式
  （`scripts/build-binary.ts --bytecode`），自有 fork 拒绝其他任何开关，模式记录在
  `build.bytecode`。产物与工具门被复制到
  `apps/desktop/resources/omp-runtime/`（已 gitignore；打包复制会用 filter 排除该目录自身的
  `.gitignore`），并在 electron-builder 的 `extraResources` 中声明。
* **发布门。** `pack`、`dist`、`dist:mac`、`dist:win`、`dist:linux` 都以
  `scripts/release-package.mjs` 结尾；该入口只解析一次发布目标，并把同一目标用于两个对目标敏感
  的步骤：sidecar 预检与 electron-builder。这与上游产品把 sidecar bundle 步骤串进发布命令
  （`bundle:runtime` 先于 `electron-builder`）的做法一致，但目标选择是单一来源：架构透传
  （`pnpm run dist:mac -- --x64`）只会到达链尾命令，位于链中段的预检读不到它，arm64 机器就会
  把 arm64 sidecar 打进 x64 应用。宿主目标的预检会实际构建产物；跨目标预检拒绝编译，要求存在
  **恰好为该平台/架构**暂存、且相对本次发布的受控清单校验通过的产物，并在架构未声明时在 spawn
  任何进程之前失败。Windows/Linux 两侧都保持固定 x64 契约。绝不把宿主二进制复用到其他平台。
  命令行参数分三类。四个轴——platform、architecture、`--dir`、`--publish`——由本入口**拥有**：
  它识别已安装 electron-builder CLI 为它们声明的全部拼写（平台开关
  `--mac`/`-m`/`-o`/`--macos`/`--m`/`--o`、`--win`/`-w`/`--windows`/`--w`、
  `--linux`/`-l`/`--l`；target 列表 `--mac dmg zip`、`--win=portable` 一律拒绝，因为该维度只负责
  选平台；架构布尔开关接受 `=true` 与字面量 `true`，拒绝 `=false`、`--no-<arch>` 与其它取值；
  `--dir` 同理；`--publish` 连同 `-p`/`--p` 别名，取值按 CLI 自己的列表校验）。每个轴至多声明
  一次、由本入口恰好写出一次，因此 `--x64 --arm64`、`--x64 --arch arm64`、重复 `--platform`、
  `--publish never -p always`、`--dir --dir=true` 都在 spawn 之前拒绝。会替换或中断预检所校验
  产物的参数被**拒绝**：`--prepackaged`/`--pd` 让 `doPack` 直接跳过并改为打包外部应用
  （`app-builder-lib/out/platformPackager.js:146`、`out/macPackager.js:268-270`），
  `--projectDir`/`--project` 改读别的项目，`--config`/`-c`/`--c` 的路径形式换成外部配置文件，
  `--help`/`--version` 让 builder 不打包就退出。dotted 配置覆盖只经 **source-neutral
  allowlist** 通过：`mac.identity`、`mac.forceCodeSigning`、`mac.notarize`（固定 lane 实际用的
  就是这三个——上游 release workflow 的 `-c.mac.forceCodeSigning=true` 与
  `-c.mac.notarize=true`、本地 Developer ID lane 的 `-c.mac.identity=<name>`），三者只选证书或
  签名/公证闸门，无法增删或搬移任何被打包的文件；`files`、`extraResources`、`extraFiles`、
  `directories.app`、`extends` 及平台级同类键一律拒绝，因为"任意 `-c.*`"会让
  `-c.extraResources` 换掉已校验的输入。其余 token（不是 electron-builder 已声明选项者）仍按
  原序**原样转发**，由 builder 自己的严格解析器拒绝未知 flag，而不是被本入口静默丢弃。
  本地签名 lane（`scripts/release-macos.sh`）也通过
  `pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs` 进入同一模块，
  因此 Developer ID + 公证的本地构建与 `pnpm dist:mac` 一样先跑预检再跑 electron-builder，
  不再直接调用 electron-builder。
* **打包输入。** 每条执行发布命令的 lane 都会在打包前准备源码：检出清单所固定的 fork 提交（完整
  历史，因为构建要重新证明 `base..HEAD`）、安装固定 Bun、在该检出中执行
  `bun install --frozen-lockfile`，并把 `OMP_SIDECAR_SOURCE` 指向它。只检出本仓库的干净 runner
  根本无法执行 `dist:*`——预检在编译任何东西之前就拒绝缺失的源码；任何 lane 都不允许下载上游发布
  资产，也不允许在 electron-builder 之后注入运行时。
* **工具门。** 运行时用 `--trusted-extension` 加载工具门，因此它以自包含 bundle 的形式发布
  （`omp-runtime/extensions/omp-desktop-gate.js`，由
  `packages/omp-runtime/extensions/omp-desktop-gate.ts` 构建）：直接复制源码仍会 import
  `../src/...`，而该路径在 sidecar 旁并不存在，运行时会拒绝启动。构建会证明 bundle 不再含相对
  导入、先清空构建自有的 `extensions/` 目录（避免旧构建残留被一起发布），并记录工具门的字节数与
  摘要。工具门从其自身源码目录编译，而不是从瞬时的运行根：Bun 按构建 cwd 写出每个模块的路径注释，
  cwd 随 `TMPDIR` 变化会让同一源码产出不同的工具门字节与不同的 provenance 摘要。一条回归测试经
  本入口在不同深度的临时根下构建，并要求工具门字节与完整清单相等。
* **provenance。** 构建会在可执行文件旁写出 `provenance.json`：schema
  `omp-desktop.bundled-sidecar/3`、fork 仓库/提交/tree、上游基线 SHA 与版本、patch level、能力
  id、OMP 版本、桌面版本、平台、架构、二进制文件名、字节数与 SHA-256、各扩展的路径与其字节数/摘要，
  以及构建工具、其版本和所选编译模式（`build.bytecode`）。每个值都来自已校验的检出、补丁清单、
  本机环境或实际产物。启动时**校验**的是
  schema、平台、架构、OMP 版本、patch level、上游基线 SHA 与版本、fork 仓库与提交、桌面发布版本、
  二进制名，以及二进制与每个扩展的字节数/摘要；`fork.tree`、`capabilities` 与 `build.*` 的取值
  是应用无法自行推导的审计记录，绝不作为“已验证”呈现（但它们的形状仍被强制）。schema 为 `/3`，
  因为强制 `build.bytecode` 改变了契约，因此 `/2` 与 `/1` 被拒绝而不是被静默重定义。扩展路径会规范化为相对 POSIX
  路径，否则拒绝（不得是绝对路径、盘符、UNC、空/`.`/`..` 段或重复项），且清单必须**恰好**声明
  信任工具门——再发一个扩展需要单独的 ADR。
* **准入。** 打包构建的唯一候选是
  `process.resourcesPath/omp-runtime/{omp|omp.exe}`；只有当清单相对本构建的 pins 校验通过、且
  二进制字节数与 SHA-256 与磁盘文件一致时才使用。包含性在**同一个规范形式**下判定：资源根与
  `omp-runtime` 都先解析再比较，因此别名祖先（macOS 的 `/var/...` 解析为 `/private/var/...`）
  不会被误判为逃逸，而符号链接的 `omp-runtime`、二进制、manifest 或工具门仍被拒绝。工具门走同一套
  校验（`resolveBundledGate`）：`resourcesPath` 缺失、工具门缺失、符号链接、路径逃逸或摘要变化都是
  拒绝，绝不回退到 app path、环境变量或 `PATH`。缺失、符号链接、逃逸、格式错误、不匹配或被篡改的
  资源一律以 `OmpRuntimeError("bundled-runtime-invalid")` 拒绝，且原因会进入引擎状态，并经
  `inspectBundledGate` 与适配器的 `launcherError` 进入 prompt 与控制操作错误，而不是被压成
  “no runtime”或“gate not found”。打包构建下不读取 `OMP_DESKTOP_RUNTIME`、不向上扫描 app path，
  也绝不使用 `PATH`。开发态的运行时与工具门都保留显式覆盖与固定子模块的向上查找。
* **启动。** 启动路径在 spawn 之前探测 `--version`，并在 `ready` 之后协商协议 v2；不一致时引擎停在
  `failed`，原因为 `version-mismatch` 或 `protocol-unsupported`，且能力全部关闭，因此不会创建可用
  会话。这里复用 M1 的握手，而不是新增第二套。
* **隔离。** bundled 产物与固定启动器使用同一套环境策略（合成 HOME、`PI_CODING_AGENT_DIR`、剥离
  steering 变量/代理/凭证），stop/reclaim 会回收其进程组与自有的 run root。已用真实编译产物验证，
  见 `docs/validation/M5-bundled-sidecar.md`。
* **打包资源验收。** `scripts/verify-packaged-runtime.mjs` 接受 electron-builder 的真实产物——打包
  应用的 `Resources` 目录——并用生产模块而不是第二套实现来驱动它：先 `verifyBundledRuntime`，再把
  已校验的二进制与工具门经 `OmpRuntimeSupervisor` 用桌面自身的 `--trusted-extension` 参数链启动，
  子进程 PATH 收缩为一个空目录，启动环境里带有 `NODE_PATH`、发现重定向变量与一份凭证。运行必须到
  达 `idle`、版本为 pins 中的版本、协商协议 v2、完成无提供方的 `get_state`、诱饵目录零写入，并以
  进程组已回收、run root 已删除结束；在宿主可读取子进程环境处（Linux `/proc`），空 PATH、run root
  内的 HOME 以及 `NODE_PATH`/重定向/凭证的缺席都被作为事实断言。不存在的 trusted extension 必须
  让运行时无法变为可用，而且必须是**该**拒绝——失败 `detail` 必须在该路径**自身的边界上**点名该缺失
  路径（"Trusted extension must be an existing module file: `<path>`"；仅共享前缀的更长路径
  `<path>.another-file` 命名的是另一个文件，不算）；超时、启动器/原生加载失败、
  命名了别的路径的拒绝、或竟然启动成功，都让门是否被加载无法成立，入口以观察到原因失败。这正是
  "启动成功即工具门确实被加载"的依据。回收被检查而不是假定：入口启动过的每个 run 都必须先被回收，
  才会删除自己的临时根；进程组或目录无法回收的 run 保留其根与 supervisor 的所有权记录，入口报告
  保留位置并以非零退出；被覆盖的启动环境在包括运行失败与删除失败在内的所有出口上恢复。
  `--verify-only` 在校验后即停。该入口绝不校验隐式路径，拒绝与失败都以非零退出。它无头地验收打包
  构建的运行时边界，不是 GUI 启动；真实应用内的安装包验收仍属 T22/T23。桌面回归套件
  （`apps/desktop/test/packaged-runtime-verify.test.mjs`）把它固定在该契约上：参数与路径拒绝始终
  运行；工具门控制（只接受在**该路径自身边界上**精确点名该缺失路径的拒绝，同名前缀的更长路径不算；
  无关失败不被接受）与回收失败路径通过注入的
  supervisor class 始终运行；当 `OMP_T21_RESOURCES` 指向真实 `Resources` 树时，再验证被掉包的
  工具门、字节不再匹配的二进制、缺失的二进制、其他平台/架构、伪造的 patch level 或 schema，以及
  "运行未启动"时的保留根/环境恢复行为（opt-in；skip 不等于通过）。

本构建校验的 pins 镜像在 `@pi-desktop/shared`（`OMP_RUNTIME_BASE_SHA`、
`OMP_RUNTIME_PATCH_LEVEL`、`OMP_RUNTIME_FORK_REPOSITORY`、`OMP_RUNTIME_FORK_COMMIT`），因为打包
后的应用没有仓库可读；桌面测试断言它们与受控清单一致。

产物已逐位可复现：同一 fork 提交的两次独立构建得到相同的字节数、SHA-256 与 `provenance.json`，
因为内嵌的原生插件归档使用固定时间戳写入、编译模式是显式的，且工具门从其自身源码目录编译、其字节
不随瞬时运行根变化；在不同深度的 `TMPDIR` 根下两次构建的二进制、工具门与完整清单一致。此前的
构建间差异来自 `Bun.Archive` 给归档打上了墙上时钟时间，而不是 bytecode；上游针对
`--compile --bytecode --splitting` 的修复（oven-sh/bun#42151）覆盖的是本构建未使用的模式。测量、
对照构建与拒绝证据见 `docs/validation/M6-r4-3-reproducible-sidecar.md`，因此 R4-3 **已满足**。

本文不涉及：R3 仍然阻塞（针对该组合）、T20-B/C/D 在本文写作时尚未开始，因此 M5/T20 当时在
HANDOFF、任务板、ADR 0307 与本节中记为**部分完成**（后续进度见上文 2026-10-03 状态说明）。

## 18. OMP 原生历史读取与提交提示词身份（M5/T20-D 返修 2，ADR 0313）

每个会话只有一个写者，因此 OMP 会话的转录就是运行时自己的原生会话文件，桌面不会把它再写进宿主
`messages`。`sessionGet`/`sessionOpen` 仍必须显示该转录：对 OMP 会话，宿主行只提供元数据，消息
来自对运行时规范 entry 的**只读历史投影**。

### 18.1 读取

`OmpSessionBridge.readHistory` 把 `get_entries`（`{ entries, leafId }`）投影成桌面行：从 `leafId`
沿 `parentId` 走活动分支到根，消息 entry 经与实时流相同的转换器投影，行的 id 为
`omp:<session>:entry:<entryId>`——跨读取稳定。工具行在其 `toolCallId` 于该分支唯一时以它作为行 id
（渲染层实时工具行就用这个键，因此持久行替换其实时孪生而不是重复），否则回退到 entry id。窗口与
原生读取器的 `detail()` 一致：`messageLimit`（默认 100，有硬上限）、`messageBefore`、
`messageAround`、`contentLimit`，并返回 `messageStart`/`messageEnd`/`hasMoreBefore`/
`hasMoreAfter`/`messageCount`。

运行时的选择绝不把两个进程放在同一个文件上：

- 已有存活运行时的会话，经该运行时（转录的属主进程）读取，并像提示词一样先做引用校验；
- 否则用**只读配置**启动一个瞬时 supervisor：投影会话的模型*身份*但不带凭据（`auth: none`），
  提供商行无法投影时用回环占位项，且不传 `--model`、不写 run 级状态。读取者被切到持久转录、其
  上报身份与持久引用核对、读取 entry，然后先离开该转录（`new_session`）再被回收。

该读取不发送任何 prompt、不执行任何工具、不发出任何提供商请求，也不要求可用的提供商凭据；
`new_session` 这一步存在的原因，是运行时在持有会话时被回收会向该转录追加 `session_exit` 诊断，
而历史读取必须让转录逐字节不变。缺失、属于他者、只写了一半或版本不兼容的引用、不可达的运行时、
畸形 entry 列表与回收失败一律 fail-closed；只有尚无原生引用的会话才返回空页——尚无原生引用不是
错误，而不可读的转录绝不呈现为空页。

### 18.2 每次提交的提示词只有一个身份

渲染层在提示词离开之前就画出用户行（`messageId`，仍按桌面宿主边界做 UUID 校验）。该 id 随提示词
进入 bridge 与 runner（`userMessageId`）；转换器把它绑定到随后的 user frame，并把该帧按 PI 的
`user_message_persisted` 报告为对乐观行的替换，而不是再造一行，Main 也不再自行回显用户行。绑定是
一次性的：其 run 在未回显的情况下关闭时即被丢弃，因此后续提示词绝不会被改键到旧行上。没有乐观 id
的提示词（已批准计划的执行入口）保持原行为：原生帧就是用户行。

### 18.3 持久读取替换实时行

流式行与其持久孪生无法共享 id（运行时的实时帧不带 entry id），因此合并被显式化而不是按内容猜测：

- bridge 按会话记录一份精确的、单一写者的实时行台账（渲染层的行就来自同一批 envelope），其中包含
  已受理提示词的乐观行；
- 行的"已结算"由其自身终止事件判定；自身终止事件从未到达时由该 run 的 `agent_end`/`error` 判定；
  只有已结算的行才可能有持久孪生，在飞行的行永不被点名；
- **尾部**读取返回 `replacedLiveMessageIds`——返回窗口内确有其持久孪生的已结算行（窗口会加宽以覆盖
  它们）——渲染层在合并前精确丢弃这些行。较旧的页与居中读取不点名任何行：它们不包含相应孪生。

绝不比较文本或时间，因此两段逐字节相同的提示词始终是两行、两个 id，重复项绝不会被折叠成一行。
`SessionDetail.replacedLiveMessageIds` 是可选字段；实时行与持久行本就同 id 的引擎（Pi 原生、桌面）
从不设置它。
