# M5 验证记录：OMP 子代理面板与编排归属（T17）

状态：**完成**（T17）。M5 后续任务 T18-T20 未开始。
本轮父提交：`a2ac9de0da6c18e6614fdc11ddd10d4e94cae0df`。
固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`（本轮未修改）。
工作树：`/home/vv/person/code/omp-desktop-m5-t17`，分支 `codex/m5-subagents`。
传输/权限决策沿用 `docs/decisions/001-omp-transport.md`；本轮新增产品侧 ADR `app/docs/adr/0303-omp-subagent-surfacing.md`。

## 0. 环境准备（固定子模块流程，与本轮代码无关）

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 工作树依赖 | `pnpm install --offline --frozen-lockfile`（app/） | Done，1.9 s（store 复用） |
| OMP 工作区 | `bun install --frozen-lockfile`（upstream/oh-my-pi） | 414 packages（`tool-views.generated.js` 重生成，见 §7） |
| OMP 原生模块 | `bun run build:native`（`CMAKE`/`PATH` 注入 pyenv 3.12.13） | `pi_natives.linux-x64-modern.node` 构建成功（2m26s） |

## 1. 三方证据位置

| 事实 | 固定 PI-Desktop | 固定 OMP | 本项目落点 |
| --- | --- | --- | --- |
| 子代理帧 | `packages/agent-runtime/src/subagent.ts`（`SubagentRun.handleEvent` 只转发 message/tool 行）、`delegation-message.ts`（`settledDelegationMessage`/`taskMessageSnapshot`） | `packages/tui/src/overlays/session-observer-registry.ts`（`SubagentLifecyclePayload`/`SubagentProgressPayload`）、`packages/tui/src/tools/task.ts:1818`（`AgentProgress`）、`packages/coding-agent/src/task/types.ts:38`（`SubagentEventPayload`）、`modes/rpc/rpc-types.ts`（`RpcSubagentSnapshot`/`RpcSubagentMessagesResult`/`set_subagent_subscription`） | `packages/omp-runtime/src/session/subagent-frames.ts`（typebox 严格校验）、`subagents.ts`（每子代理 registry/转换/结算） |
| 拓扑读取 | `apps/desktop/src/lib/subagent-topology.ts`（`delegationId`/`status`/`startedAt`/`completedAt`/`delegations[]`/`stopped[]`）、`tool-display.ts`（`isDelegationStartTool("task")`） | — | 不改拓扑；`task` 工具结果 `details` 增补 `delegationId`/`agent`/`status`/`startedAt`/`completedAt` |
| 父归属 | `AgentEventEnvelope.parentToolCallId`/`agentName`（`types/agent.ts:304`）、`event-persistence.ts`（`subagentTagged`）、`session-coordination.ts`（`isStaleTerminalEvent` 对 `parentToolCallId` 的 terminal 事件返回 true） | `parentToolCallId` 在 lifecycle/progress/snapshot；`subagent_event` 只有 `{id,event}` | runner 用 `task toolCallId → {generation,turnId}` 把迟到的子代理帧归到发起回合 |
| 快照/读取 | — | `get_subagents`（存活子代理）、`get_subagent_messages`（按 `subagentId`/`sessionFile` + `fromByte` 字节游标） | runner `listSubagents`/`readSubagentTranscript`；`sessionFile` 只在 main/runtime 内部，列表与读取结果均不透出 |
| 单独停止 | `TaskStop`（PI 专有） | 无（RPC 命令联合体无 per-subagent stop；`hasUI=false`） | `stopSubagent` 恒拒（typed `capability-unavailable`） |
| 子代理审批 | `SubagentRun` 权限作用域 | `hasUI=false`；同一 `tool_call` 钩子；门 `extensions/omp-desktop-gate.ts` 的 `no-ui` 路由在子代理会话里 block | 沿用 M3 门（session/generation/kind 校验）；子代理 gated 工具 fail closed、无副作用；`mode: allow` 下恰好执行一次 |

## 2. 归属/能力矩阵

| 关注点 | OMP 事实（证据） | Pi 行为 | 本项目决策 |
| --- | --- | --- | --- |
| 子代理编排 | OMP 原生 `task` 工具 + 三类帧（E08/E11、`rpc-subagents.ts`） | Pi `Task`/`TaskWait`/`TaskList`/`TaskStop` | OMP 会话只由 OMP 编排；绝不启动 Pi Task 运行时、不重复任务、不翻译同名工具 |
| 父归属 | lifecycle/progress/snapshot 带 `parentToolCallId`（e08 fixture） | `AgentEventEnvelope.parentToolCallId` | OMP `parentToolCallId` → envelope 字段；子代理帧按发起回合归因 |
| 子代理身份 | lifecycle `id`（不透明） | `delegationId` | OMP `id` 即 `delegationId` |
| 状态 | lifecycle `started/completed/failed/aborted` | `SubagentOutcome` | `started→running`，其余同名 |
| 帧 | 三族（lifecycle/progress/event） | `AgentEvent` 词汇 | 严格校验；event → 每子代理转换器 |
| 订阅 | `set_subagent_subscription off/progress/events` | — | readiness 后一次 `events` |
| 快照 | `get_subagents` 存活子代理 | — | 存活期内 reconcile 补漏 |
| 详情读取 | `get_subagent_messages` 字节游标 | 子代理行持久化进父 store | 桥接按不透明 id 读取；`sessionFile` 不出桥 |
| 单独停止 | 无 per-child stop RPC | `TaskStop` | 恒拒（typed refusal），按钮保持禁用 |
| 子代理审批 | `hasUI=false` → 门 `no-ui` block | 父交互 UI | fail closed；永不借用父 UI；策略允许执行一次 |
| 重启 | 终止子代理从 registry 移除 | 持久 transcript | 不谎报运行、不重放；`turnLive:false`→`aborted` 诚实呈现 |

## 3. 用户路径

- **父会话发起 `task`**：OMP 原生 `task` 工具被识别为 delegation 节点（`isDelegationStartTool`），`toolResult.details` 增补 `delegationId`/`agent`/`status`/`startedAt`/`completedAt` → 现有拓扑卡片显示 creating/running/completed/failed/aborted 状态与父子关系。
- **子代理进度/最新输出**：`subagent_event` 帧经每子代理转换器转成 `message_*`/`tool_*` 行，带 `parentToolCallId`/`agentName`，流入现有 detail/`SubagentRun` 结构；`subagent_progress` 更新 registry 快照。
- **打开子代理详情**：`ompSubagentRead` → 桥 `readSubagentTranscript` → `get_subagent_messages`（字节游标、`reset`/`nextByte` 透出），映射为 `UiMessage[]`；`sessionFile` 不跨桥。
- **单独停止**：`ompSubagentStop` 恒返回 `capability-unavailable` 与准确解释（固定 OMP 无 per-child stop；停止子代理 = 停止父回合），UI 按钮保持禁用，不静默调用父 abort。
- **重启**：registry 为空，不谎报旧 detached 子代理仍在运行、不重放；持久父 transcript 里已记录的 completed/failed 如实呈现，其余 `running` 节点按 `turnLive:false` 呈现为 `aborted`（interrupted）。

## 4. 失败/取消矩阵

| 场景 | 行为 | 证据 |
| --- | --- | --- |
| 子代理 gated 工具（`hasUI=false`，`mode: ask`） | 门 `no-ui` 路由 block，`tool_end{isError:true}`，目标文件不变 | E2E（`existsSync(marker)===false`） |
| 子代理 gated 工具（`mode: allow`） | 恰好执行一次，目标文件内容正确，`tool_end` 恰一条且归因正确 | E2E 第二项 |
| 父 stop/dispose/shutdown | 沿用 M3 门：pending 决策作废、迟到 allow 不执行；进程组回收 | 既有 M3/M4 E2E + 本轮 `reclaimAll` 断言 |
| 迟到子代理帧（父回合已关） | 按发起回合 `turnId` 归因，不落到新代 | `subagent-runner.test.ts`（late generation） |
| 格式错误/归属不明帧 | 计数拒绝，不作父事件 | `subagent-frames.test.ts`、`subagents.test.ts`（orphan） |
| 快照补漏 | `get_subagents` reconcile 修复漏掉的 started/progress，不重复子代理、不重放副作用 | `subagents.test.ts`、bridge test |
| 单独停止 | 恒拒（typed `capability-unavailable`） | bridge/IPC test |

## 5. 验证命令与结果

所有命令在 `app/` 下执行，先 `nvm use 24`（非交互 shell 加载 `~/.nvm/nvm.sh`，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2，rustc stable 1.95.0）。OMP 子模块已按 §0 构建。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test` | **197 passed / 0 failed**（含真实固定 runtime 烟测；新增 subagent-frames/subagents/subagent-runner 三套 41 项） | 0 |
| `node --test test/omp-subagent-bridge.test.mjs`（`env -u SSH_ASKPASS`） | **7 passed / 0 failed** | 0 |
| `node --test test/omp-subagent-e2e.test.mjs`（`env -u SSH_ASKPASS`） | **2 passed / 0 failed**（真实固定 OMP + 假 provider） | 0 |
| （全量回归见 §6） | | |

新增定向测试：
- `packages/omp-runtime/src/session/subagent-frames.test.ts`（16 项：帧校验、快照/消息响应、游标归一化）
- `packages/omp-runtime/src/session/subagents.test.ts`（14 项：lifecycle 注册/结算、progress/event 归因、孤立帧、快照去重、路径不披露、重置）
- `packages/omp-runtime/src/session/subagent-runner.test.ts`（5 项：订阅幂等、迟到代归因、list 快照拒绝、读取非披露、stop 恒拒）
- `apps/desktop/test/omp-subagent-bridge.test.mjs`（7 项：桥 list/read/stop + IPC 真实 handler 路径 + Pi 路由不变）
- `apps/desktop/test/omp-subagent-e2e.test.mjs`（2 项：真实固定 OMP `task` 子代理端到端——三帧族、子身份、`parentToolCallId`、子工具归因、deny 无副作用、allow 恰好一次、快照、停止回收）

## 6. 全量回归

（提交前运行，命令与计数在最终交付报告补齐）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test` | 197 passed |
| `pnpm --filter @pi-desktop/shared test` | 见交付报告 |
| `node --test test/*.test.mjs`（`env -u SSH_ASKPASS`，desktop 全量） | 见交付报告 |
| `pnpm typecheck`（12/13 workspace 包） | 通过 |
| `pnpm build:js` | 通过 |
| `git diff --check` | 无输出 |

## 7. 关键限制与边界

- **`subagent_event` 需要 `--model`**：固定 OMP 仅在显式 `--model provider/model` 时转发子代理事件流；仅靠 `models.yml` 发现则子代理有 lifecycle/progress 但无 event（详情/转录不流）。M4 投影已钉住单一 provider/model，故 `omp-session-wiring.ts` 现同时传 `--model` 与投影。这是本轮发现的真实上游行为，已用 E2E 前后对照复现。
- **单独停止关闭**：固定 OMP 无 per-child stop RPC，子代理 `hasUI=false` 无可信子进程句柄；`stopSubagent` 恒拒并如实说明（停止子代理 = 停止父回合）。未臆造父 abort 伪成功。
- **batch `task` 的拓扑卡**：Pi 模型是「一个 Task 行 = 一个 delegation」。OMP batch（`tasks[]`）会在一行下多个子代理；拓扑卡以首个 child 为主 `delegationId`，各子代理行仍按 `parentToolCallId` 归入该卡。单子代理（最常见、E2E 覆盖）完整。
- **重启边界**：固定 OMP 进程退出后无法重开 live 子代理 registry；桌面不谎报旧 detached 子代理仍在运行、不重放。持久父 transcript 已记录的 completed/failed 如实呈现，其余 `running` 按 `turnLive:false` 呈现为 `aborted`。
- **子模块生成文件**：`bun install` 重生成 `upstream/oh-my-pi/packages/coding-agent/src/export/html/tool-views.generated.js`（未提交，见 `git status`）。
