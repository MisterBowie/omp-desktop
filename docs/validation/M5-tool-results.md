# M5/T18：OMP 原生 Edit / LSP / Debug 结果的可读展示

更新时间：2026-09-24。状态：**T18 已完成**（待最终独立复审）。分支 `codex/m5-tool-results`，基线 `ca6a25570122c1f74007697b885eb2dbb681b5f4`（验收代码基线 `ab07a888d6afb916561b80e5661ed27aa6be612a`）。固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`（本轮未修改）。

## 0. 范围与结论

T18 只适配**结果展示**，不改执行、权限、生命周期或持久化语义：固定 OMP 拥有工具执行与权限，本阶段把 OMP 原生 `edit`/`lsp`/`debug` 三种结果的真实形状映射为既有的只读块（diff/fields/code/note），使结果含义在 live 主会话工具行、durable/恢复行与共享子代理转录中可见。普通 Pi 工具、插件输出、delegation 报告、截断 chip 与回退行为保持不变。

结论先行：

- **LSP**：诊断文本与「all language servers failed」失败文本此前被 details 优先的解包丢弃（探针 `/tmp/m5-tool-text-review.mjs` 在 T17 基线上 `presentationShowsText=false`）。现从 envelope 文本块读取并渲染为 output/error 块；`success` 只表示「是否有语言服务器应答」，诊断结果满 error 严重度仍是 `success:true`，因此**不会**把源码错误当成工具失败。
- **Debug**：`details.snapshot`/`details.evaluation` 此前退化为 JSON blob。现扁平为字段行（adapter/status/cwd/program/location/stopReason/frameName/exitCode/configuration），evaluation 经 record 渲染器成行，console output 成 output 块，断点成行；未知字段走通用 record 回退。
- **Edit**：`details.diff` 是 hashline 格式字符串（非统一 diff），`oldText`/`newText` 才是源文本快照。现以 `oldText`/`newText` 生成只读 diff（`diffBlock`），快照被裁剪时回退到 `diff` 字符串；单/多文件、rename(`sourcePath → move`)、create(`newText`)、delete(`oldText`)、no-op（「no changes were made to …」）、per-file 错误（`displayErrorText`/`errorText`）与 `snapshotsPruned` 通知都可读。**不**伪造 Pi review 快照、不声称 revert/accept 能力。

## 1. 证据链

### 1.1 PI 参考（何处停止）

- `apps/desktop/src/lib/tool-presentation.ts:152` `toolResultPayload` 优先 `details`：Pi 文本块通常重复结构化结果，故优先 details 避免重复字节。`delegateReport`/`envelopeTextOf` 是显式例外，从 envelope 文本块读 delegation 报告与 lifecycle 摘要。
- `apps/desktop/test/tool-presentation.test.mjs:84`（Edit ops vs 真实 review 快照）、`:406`（未知插件）、`:481/:543`（截断通知与 diff context）——这些是 Pi 行为基线，本轮未改。
- `apps/desktop/test/tool-row-file-refs.test.mjs`：真实 `useOpenPreviewTarget` 经 `fsResolveRef` 路由文件打开；宿主解析引用，不把工具文本当路径能力。
- **PI 在检视的 presenter 中没有任何 LSP/DAP 专用映射**（source notes 已确认）；不把不存在的 PI LSP/DAP 组件写成适配来源。

### 1.2 OMP 生产者形状（固定 d49918fa）

| 工具 | 生产者 | details / content 形状 |
| --- | --- | --- |
| edit | `packages/coding-agent/src/edit/index.ts:266/488/528`、`packages/tui/src/tools/edit.ts:59-111` | `EditToolDetails`：`diff`（hashline 格式）、`perFileResults[]`（`path/op/move/sourcePath/oldText/newText/diff/isError/errorText/displayErrorText/snapshotsPruned`）、`path/op/move/sourcePath/firstChangedLine`；成功时 `content` 为格式化文本 + details，失败时仅 `{content, isError:true}`（无 details）。 |
| lsp | `packages/coding-agent/src/lsp/tool.ts:398-445`、`packages/tui/src/tools/lsp.ts:29-91` | 诊断文本在 `content` 文本块；`details` 仅 `{action, serverName, success}`。all-servers-failed 用 `success:false` + 文本，**不**置顶层 `isError`；含 error 严重度的诊断仍 `success:true`。 |
| debug | `packages/coding-agent/src/tools/debug.ts:819-831`（evaluate）及同文件其余分支、`packages/tui/src/tools/debug.ts:34-53` | `DebugToolDetails`：`{action, success, snapshot}`；snapshot 含 `adapter/status/cwd/program/stopReason/frameName/source.path/line/column/needsConfigurationDone/exitCode`；action 专有字段 `evaluation/output/breakpoints/functionBreakpoints/stackFrames/threads/scopes/variables/disassembly/memory/state/timedOut`。 |

### 1.3 本项目适配（`app/apps/desktop/src/lib/tool-presentation.ts`）

- 新增 `ompToolKind`（按工具名 `lsp`/`debug` 识别，edit 按 action 已为 `edit`）、`ompLspBlocks`（读 `envelopeTextOf` + `serverName`/`action` 行，`success:false` 用 error tone）、`ompDebugBlocks`（`ompDebugSnapshotRows`/`ompDebugLocation`/`ompDebugBreakpointRows` + `recordBlocks` 回退）、`ompEditBlocks`/`ompEditFileBlocks`（`diffBlock`/`codeBlock`/note）。
- `resultBlocks` 在 Pi switch 前对 `lsp`/`debug` 分流；`case "edit"` 以 `details.diff` 字符串或 `perFileResults` 数组存在与否区分 OMP/Pi edit（Pi Edit 两者皆无，故无需引擎判断，shape 即边界）。**未**全局替换 Pi 的 details 优先语义，未改 converter/预算/游标/权限。

## 2. 用户可见行为与限制

- live 主会话 `tool_execution_end`（`toolResult: frame.result`）与 durable `convertEntry`（`toolResult: {content,details}` 有界投影）都携带 `{content, details}` envelope，因此同一 presenter 覆盖两条路径；子代理转录经带 `parentToolCallId`/`agentName` 的转换器复用同一展示（测试覆盖）。
- 4 MiB 整行预算不变：本阶段只改 presenter 纯函数，不新增 durable 字段；大 Unicode LSP 结果仍 ≤ 4 MiB 且带 `truncated` chip 与 `…`（测试覆盖）。
- 限制：edit 的 hashline 格式 `diff` 字符串在快照裁剪时作为 `diff` 块按文本渲染（不做 hashline 语法高亮）；edit 的 `diagnostics`/`meta`/`firstChangedLine` 不在结果正文渲染（仍保留在 durable 行供模型使用）；debug 的 `instructionBreakpoints`/`dataBreakpoints` 与 stack/thread/scope/variable/disassembly/memory 列表走通用 JSON 回退。

## 3. 验证命令与结果（`app/`，Node v24.14.0，pnpm 10.34.5，`env -u SSH_ASKPASS`）

| 命令 / 范围 | 结果 | 退出 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile`（store 复用 808 包）+ `pnpm -r --if-present build` | 全部 workspace JS 构建通过（desktop renderer 重建） | 0 |
| `pnpm --filter @pi-desktop/desktop typecheck` | 通过 | 0 |
| `pnpm --filter @pi-desktop/desktop lint`（style tokens） | style tokens OK | 0 |
| `pnpm lint:biome` | Checked 75 files | 0 |
| `node --test test/tool-presentation.test.mjs test/omp-subagent-presentation.test.mjs test/omp-tool-results.test.mjs test/omp-tool-results-render.test.mjs test/tool-display.test.mjs test/tool-row-file-refs.test.mjs` | 72 passed / 0 failed | 0 |
| 探针 `/tmp/m5-row-budget-review.mjs` / `/tmp/m5-row-meaning-review.mjs` / `/tmp/m5-tool-text-review.mjs` | 8/8、全断言、lsp+debug 均 `presentationShowsText=true` | 0 |
| 全量 desktop `node --test test/*.test.mjs`（`app/apps/desktop`） | 2750 总数 / 2740 passed / 6 failed / 4 skipped | 1（6 项失败均为真实固定 OMP E2E，见下） |
| 全量 desktop 排除 4 份真实 OMP E2E 文件 | 2744 总数 / 2740 passed / 0 failed / 4 skipped | 0 |

新增测试：`omp-tool-results.test.mjs`（14 例，真实 `OmpEventConverter.convertEntry`/`convert` → 真实 `buildToolPresentation`/`runOutcome`/`toolResultChips`，覆盖 LSP 诊断/服务器失败、debug evaluate/paused+断点+output、edit 单/多文件/rename/create/delete/no-op/pruned/partial-error、live `tool_execution_end`、子代理转录、Pi `ops` 兼容、大 Unicode 截断）；`omp-tool-results-render.test.mjs`（1 例，SSR 渲染真实 `ToolDetailBlocks` 断言 LSP/edit/debug 文本可见）。

## 4. 先红后绿证据

- 复审探针 `/tmp/m5-tool-text-review.mjs` 在 T17 验收基线上：LSP `presentationShowsText=false`（仅 `action/serverName/success` 可见）、debug `presentationShowsText=true`（经 details.evaluation）。本轮改后两例均 `presentationShowsText=true` 且退出 0。该探针不是实际 LSP/DAP 运行时或 UI/E2E 执行，而是 converter→presenter 回归探针。
- 六项全量 desktop 失败与本轮无关：均为真实固定 OMP E2E（`omp-session-e2e`、`omp-session-persistence-e2e`、`omp-session-concurrent-approval-e2e`、`omp-subagent-e2e`×3），在 `OmpRuntimeProcess.start` 的版本校验处报 `version-mismatch`（本新工作树未 `bun install` + 未构建 `upstream/oh-my-pi/packages/natives`，pinned launcher 解析到全局缓存 18.2.11 而非 18.2.7），发生在任何工具结果产生之前，与 presenter 无关。排除这 4 份 E2E 文件后全量 0 失败。T17 的 4 项 macOS-only 跳过与 T18 无关，计数如实保留。

## 5. 未完成项 / 限制

- 未新增 ADR：本轮是既有 `tool-presentation.ts` 边界内的纯展示适配，不改变接口/契约/权限/架构（沿用 ADR 0300/0303 的「差异集中在适配层」原则），故只在验证文档记录。
- 真实付费模型烟测、Windows、打包均不在 T18 范围；`branch`/`steer`/`followUp`/`compact`、子代理单独停止仍关闭（T19/T20 逐项开放）。
- T18 仍待最终独立复审。
