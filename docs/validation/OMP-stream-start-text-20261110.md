# OMP 回复首段文字重复显示修复（R24）验证记录

日期：2026-11-10

## 来由

2026-11-09 为 README 截图时发现：“每次询问”模式下，模型先输出一段文字再调用需要审批的工具，审批卡等待期间这段文字
整段显示两次（如“I'll create … origin.I'll create … origin.”），回合结束后正常（[截图记录](Release-017-20261109.md)
“截图过程中发现的产品问题”第 1 项）。用户 2026-11-10 要求与 R16 一起处理。

## 定位

- 临时探针（未入库）：用 0.1.7 安装包和本机假服务商复现，在审批卡出现时读取会话消息、DOM 与渲染进程收到的
  `agentMessage` 事件。会话数据中还没有这条助手消息；DOM 只有一条实时行（`streaming`），其文本节点内容是两份相同文字。
- 事件序列：`message_start`（助手，`content` 已是完整文字）→ `message_update`（`stream: "delta"`，`deltaText` 为同一段文字）
  → `tool_permission_request`。渲染端把增量追加到起始内容之后，于是重复；审批等待期间这一行一直是实时行，直到回合结束
  才被历史替换。
- 原因：固定运行时在流已经收到第一段内容之后才序列化 `message_start`，这段内容随后又作为 `text_delta` / `thinking_delta`
  下发。适配层 `onMessageStart` 把消息当前内容原样转发。该写法自 0.1.0（`v0.1.0` 第 475 行）起未变，不是 R17–R22 引入的
  回归。普通回合中同样会重复第一段，但很快被 `message_end` 的最终内容替换，不易察觉。
- 实际重复的是哪部分取决于序列化时已写入的内容：探针中是正文，下面的 e2e 反向验证中是思考内容。

## 修复

分支 `codex/omp-stream-start-text`（`.worktrees/omp-stream-start-text`），叠在 R16（`codex/omp-turn-feedback`，已变基到
0.1.7 之后的 `main`）之上。

- `packages/omp-runtime/src/session/events.ts`：助手消息的 `message_start` 正文为空、`thinking` 省略，实时文字与思考只由增量构成；
  `message_end` 仍携带最终消息。用户消息不变。
- 规格 `03-runtime/02-agent-runtime.md` 新增“OMP live message start”；E2E 计划新增
  `E2E-OMP-reply-text-once-while-approval-waits`（只改英文版，与 R16、R17、R19 新增的 OMP 投影说明一致）。
- 无 IPC、持久化或权限语义变化。

## 验证

环境：macOS arm64，Node v24.14.0，pnpm 10.34.5；原生资源为 0.1.7 本地包 Resources 副本（OMP 18.3.0，fork `edec3898`）。
全部使用本机假服务商，没有真实模型调用。

| 命令 | 结果 |
| --- | --- |
| `vitest run src/session/events.test.ts`（`packages/omp-runtime`），`events.ts` 临时换回修复前 | exit 1：新增用例与原有“首帧带正文”断言共 2 项失败 |
| 同上，恢复修复 | exit 0，44/44 |
| `vitest run`（`packages/omp-runtime` 全量） | exit 0，593 通过、6 跳过 |
| `node --test test/omp-stream-start-text-e2e.test.mjs`（真实运行时，bash 审批挂起时重建实时行） | 修复后 exit 0，1/1；`events.ts` 换回修复前 exit 1，实时行思考内容为两份 |
| 涉及 `message_start` 的桌面测试 5 个文件（`omp-context-usage-e2e`、`omp-first-response-e2e`、`omp-history-read`、`omp-runtime-state-e2e`、`omp-session-bridge`） | 77 项 76 通过；1 项因新工作树未检出 `upstream/oh-my-pi` 失败，初始化子模块后单独重跑 1/1 通过 |
| omp-runtime typecheck、`pnpm lint`、`check:locales`、`git diff --check` | 均 exit 0 |

R16 与 R24 合并后的整体验证（全量测试、本地包、安装态冒烟与截图复核）见后续 0.1.8 记录。
