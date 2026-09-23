# M5/T18：OMP 原生 Edit / LSP / Debug 结果的可读展示

更新时间：2026-09-24。状态：**T18 进行中**（独立复审返修 R1-R4 与 S1-S4 已完成，待复审确认；未验收）。分支 `codex/m5-tool-results`，本轮基线 `9c9ddc2da1091548fb142dc0b68ffad022914dbe`。固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`（本轮未改 tracked 源码；仅在此自有固定子模块内构建 untracked 依赖/native 产物）。

## 本轮独立复审返修（R1-R4）

独立 macOS 复审在基线 `5ca3212` 复现四项回归：text-only 结果文本在 durable/child 路径被丢、专用渲染抹掉诊断与未知字段、`plugin_publisher_edit` 被误判为原生 edit 而丢元数据、edit 结果路径不可点开。三项复审探针（`/tmp/m5-tool-paths-review.mjs`、`/tmp/m5-tool-preservation-review.mjs`、`/tmp/m5-tool-row-mounted-review.mjs`）在基线分别 27/33、8 例全丢、组件交互 FAIL。本轮修复（仍只在 `tool-presentation.ts` 边界内，未改 converter/预算/权限）：

- **R1 文本跨 envelope 与 row-content 保留**：新增 `ompResultText`，同时读 envelope 文本块与 text-only 投影到 `content` 的行文本。`ompLspBlocks` 不再因 text-only ToolError（read-only/timeout）返回空 body；`ompDebugBlocks` 在结构化字段未承载结果（no-session terminate、空 console output）时回退到 producer 文本。live/durable/child 三条路径同一条 presenter。
- **R2 专用渲染不抹掉诊断/未知字段**：LSP 恢复 `request`（status/request 等动作记录模型所求）与其余未知字段；debug 恢复 `snapshot.id`/`instructionPointerReference`、`breakpoints[].message`（断点 pending 原因）与 snapshot 嵌套未知字段；edit 恢复 `diagnostics`（messages 成 note + summary/server 成行）、`meta`、`firstChangedLine` 与顶层/每文件未知字段。已知字段只在「值已被表示」后才从通用回退中移除。
- **R3 普通 PI/插件兼容**：原生 edit 识别从「shape 即边界」（`details.diff`/`perFileResults`）收窄为「bare 工具名 === `edit` AND shape」。`getToolAction` 的 `edit` 后缀别名会让 `plugin_publisher_edit` 进入同一分支；收窄后此类插件保留其 `revision`/嵌套元数据走通用回退，Pi Edit `ops`/ReviewChangeCard 所有权不变。
- **R4 只读文件路径可点开**：edit 结果路径改为 `files` 块（rename 同时含 `sourcePath`/`move`），走既有 `FileList` → `useOpenPreviewTarget` → host `fsResolveRef`，restored/child 行无 `toolArgs` 时也能打开被编辑文件；不解析诊断文本为路径、不加文件系统权限、不自动打开，宿主解析与缺失/错误处理保持原样。

新增回归：`omp-tool-results.test.mjs` +6 例（text-only LSP ToolError、debug no-session/empty-output、LSP request、debug id/instructionPointerReference/断点 message/未知字段、edit diagnostics/firstChangedLine/未知字段、`plugin_publisher_edit` 元数据保留）；三份复审探针与既有 tool-text/row-budget/row-meaning 探针全绿。

## 本轮独立复审返修（S1-S4）

独立 macOS 复审在已推送基线 `9c9ddc2` 补充探针 `/tmp/m5-tool-residual-review.mjs`（11 例，且已附于 `/tmp/m5-tool-paths-review.mjs` 末尾，故旧 33/33 结果未触及它），在该基线 11 例全 FAIL：7 例断言同一行在已验收 `ca6a255`（当时走通用 JSON 回退）可读、4 例断言真实生产者语义或不得伪报。四项残余修复（仍只在 `tool-presentation.ts` 边界内，未改 converter/预算/权限）：

- **S1 快照不代表动作结果**：`ompDebugBlocks` 原对任意 snapshot/未知 key/空 evaluation 都置 `carried=true`，使真实 producer 恒带 snapshot 的空 console output（`getOutput` 恒 `buildSummary`，空时文本 `(no output captured)`）与空断点表（`Function breakpoints:\n(none)`）的文本被抑制。现 `carried` 仅在 output/evaluation/断点**实际渲染后**置位；snapshot 与通用余量是元数据，绝不抑制文本。
- **S2 只消费已渲染的值（含嵌套/多文件）**：LSP 标量 `request`、debug 非字符串 `output`/非 record `evaluation`、edit 非 record `diagnostics` 不再因「已知 key 无条件消费」消失；debug 的 `source` 只消费 `path`（`name` 等其余字段留嵌套余量）、断点行补上真实 `id`（`dap/types.ts` 有 id）并把未识别字段/条目留余量；`ompEditBlocks` 多文件分支不再提前 return 而丢顶层 `diagnostics`/`meta`/未知字段。保留全部字节/截断标记。
- **S3 缺失/裁剪负载不是 no-op**：`ompEditFileBlocks` 只在「无 diff、无快照、非 rename、无 `snapshotsPruned`/`truncated`/`isError` 遗漏标记」时才生成 `no changes were made`；裁剪/截断/失败文件只给出 missing-information 提示（`file snapshots were pruned`/`file content was truncated`），绝不伪造成功语义，也不借用 no-change 预览（对照 `tui/src/tools/edit.ts` 与 `edit-renderer.test.ts:578-660` 的 delete/move 不借用 no-change 预览）。
- **S4 保留 rename 关系 + 挂载交互回归**：rename 在可点开的双路径 `files` 块之外增加 `move: a.ts → b.ts` 字段行，恢复 source→destination 语义（不再读作「两个文件被编辑」）。新增真实挂载回归 `omp-tool-row-mounted.test.mjs`：真实 `ToolRow` disclosure + `ToolDetails`/`useOpenPreviewTarget`/`api`，控制宿主/store 目标——成功解析并打开一次、missing/error 只出 error toast 不打开、`autoOpen` 不解析/打开任何文件、restored/child 行无 `toolArgs`（组件 harness，非浏览器/截图 E2E）。

新增回归：`omp-tool-results.test.mjs` +4 例（snapshot 不抑制空 output/空断点、断点 id/每项余量/source 余量、未知值可读、多文件顶层诊断 + 裁剪非 no-op），既有 rename 用例补 `move` 关系断言；`omp-tool-row-mounted.test.mjs` 2 例。复审探针 paths 33/33、preservation 8/8、mounted、residual 11/11 与既有 tool-text/row-budget/row-meaning 全绿。

## 0. 范围与结论

T18 只适配**结果展示**，不改执行、权限、生命周期或持久化语义：固定 OMP 拥有工具执行与权限，本阶段把 OMP 原生 `edit`/`lsp`/`debug` 三种结果的真实形状映射为既有的只读块（diff/fields/code/note/files），使结果含义在 live 主会话工具行、durable/恢复行与共享子代理转录中可见。普通 Pi 工具、插件输出、delegation 报告、截断 chip 与回退行为保持不变。

结论先行：

- **LSP**：诊断文本与「all language servers failed」失败文本此前被 details 优先的解包丢弃（探针 `/tmp/m5-tool-text-review.mjs` 在 T17 基线上 `presentationShowsText=false`）。现从 envelope 文本块或行 `content` 读取并渲染为 output/error 块；`success` 只表示「是否有语言服务器应答」，诊断结果满 error 严重度仍是 `success:true`，因此**不会**把源码错误当成工具失败；`request`/未知字段保留。
- **Debug**：`details.snapshot`/`details.evaluation` 此前退化为 JSON blob。现扁平为字段行（id/adapter/status/cwd/program/location/stopReason/frameName/instructionPointerReference/exitCode/configuration），evaluation 经 record 渲染器成行，console output 成 output 块，断点成行（含 `message` pending 原因）；未知字段走通用 record 回退；no-session/空 output 的 producer 文本保留。
- **Edit**：`details.diff` 是 hashline 格式字符串（非统一 diff），`oldText`/`newText` 才是源文本快照。现以 `oldText`/`newText` 生成只读 diff（`diffBlock`），快照被裁剪时回退到 `diff` 字符串；单/多文件、rename(`sourcePath`/`move` 双路径)、create(`newText`)、delete(`oldText`)、no-op（「no changes were made to …」）、per-file 错误（`displayErrorText`/`errorText`）、`snapshotsPruned` 通知、`diagnostics`/`meta`/`firstChangedLine` 都可读；路径是点开的 files 块。**不**伪造 Pi review 快照、不声称 revert/accept 能力。

## 1. 证据链

### 1.1 PI 参考（何处停止）

- `apps/desktop/src/lib/tool-presentation.ts:152` `toolResultPayload` 优先 `details`：Pi 文本块通常重复结构化结果，故优先 details 避免重复字节。`delegateReport`/`envelopeTextOf` 是显式例外，从 envelope 文本块读 delegation 报告与 lifecycle 摘要。本轮**未**改动该语义，OMP 文本经新的 `ompResultText` 在 OMP 专用分支内读取。
- `apps/desktop/test/tool-presentation.test.mjs:84`（Edit ops vs 真实 review 快照）、`:406`（未知插件）、`:481/:543`（截断通知与 diff context）——这些是 Pi 行为基线，本轮未改。
- `apps/desktop/test/tool-row-file-refs.test.mjs`：真实 `useOpenPreviewTarget` 经 `fsResolveRef` 路由文件打开；宿主解析引用，不把工具文本当路径能力。本轮 edit 路径改走该既有链路。
- **PI 在检视的 presenter 中没有任何 LSP/DAP 专用映射**（source notes 已确认）；不把不存在的 PI LSP/DAP 组件写成适配来源。

### 1.2 OMP 生产者形状（固定 d49918fa）

| 工具 | 生产者 | details / content 形状 |
| --- | --- | --- |
| edit | `packages/coding-agent/src/edit/index.ts:266/488/528`、`packages/tui/src/tools/edit.ts:59-111` | `EditToolDetails`：`diff`（hashline 格式）、`perFileResults[]`（`path/op/move/sourcePath/oldText/newText/diff/isError/errorText/displayErrorText/snapshotsPruned/diagnostics/meta/firstChangedLine`）、顶层 `path/op/move/sourcePath/firstChangedLine/diagnostics/meta`；成功时 `content` 为格式化文本 + details，失败时仅 `{content, isError:true}`（无 details）。 |
| lsp | `packages/coding-agent/src/lsp/tool.ts:398-445`、`packages/tui/src/tools/lsp.ts:29-91` | 诊断文本在 `content` 文本块；`details` 含 `{action, serverName?, success, request?}`（status/request/其他动作带 `request`）。all-servers-failed 用 `success:false` + 文本，**不**置顶层 `isError`；含 error 严重度的诊断仍 `success:true`。ToolError（read-only/timeout）为 text-only，无 details。 |
| debug | `packages/coding-agent/src/tools/debug.ts:819-831`（evaluate）及同文件其余分支、`packages/tui/src/tools/debug.ts:34-53` | `DebugToolDetails`：`{action, success, snapshot}`；snapshot 含 `id/adapter/status/cwd/program/stopReason/frameName/source.path/line/column/instructionPointerReference/needsConfigurationDone/exitCode`；action 专有字段 `evaluation/output/breakpoints/functionBreakpoints/stackFrames/threads/scopes/variables/disassembly/memory/state/timedOut`。no-session terminate 无 snapshot、空 output 的 `output:""` 均 text-only 含义。 |

### 1.3 本项目适配（`app/apps/desktop/src/lib/tool-presentation.ts`）

- 新增 `ompToolBareName`（bare 工具名，插件/MCP 命名空间不匹配）、`ompToolKind`（`lsp`/`debug`）、`ompResultText`（envelope + 行 content）、`ompLspBlocks`（`ompResultText` + `serverName`/`action` 行 + `request` 行 + 通用余量）、`ompDebugBlocks`（`ompDebugSnapshotBlocks`/`ompDebugLocation`/`ompDebugBreakpointRows` + `recordBlocks` 回退 + text 兜底）、`ompEditBlocks`/`ompEditFileBlocks`（`filesBlock`/`diffBlock`/`codeBlock`/`ompEditDiagnosticBlocks` + 通用余量）。
- `resultBlocks` 在 Pi switch 前对 `lsp`/`debug` 分流；`case "edit"` 以 `ompToolBareName === "edit"` AND（`details.diff` 字符串或 `perFileResults` 数组）区分原生 OMP edit 与 Pi/插件 edit。**未**全局替换 Pi 的 details 优先语义，未改 converter/预算/游标/权限。

## 2. 用户可见行为与限制

- live 主会话 `tool_execution_end`（`toolResult: frame.result`）与 durable `convertEntry`（`toolResult: {content,details}` 有界投影）都携带 `{content, details}` envelope，text-only 结果把文本投影到行 `content`、`toolResult` 为空；`ompResultText` 同时读两者，因此同一 presenter 覆盖 live/durable/restore/child 全部路径（测试覆盖）。
- 4 MiB 整行预算不变：本阶段只改 presenter 纯函数，不新增 durable 字段；大 Unicode LSP 结果仍 ≤ 4 MiB 且带 `truncated` chip 与 `…`（测试覆盖）。
- 限制：edit 的 hashline 格式 `diff` 字符串在快照裁剪时作为 `diff` 块按文本渲染（不做 hashline 语法高亮）；debug 的 `instructionBreakpoints`/`dataBreakpoints` 与 stack/thread/scope/variable/disassembly/memory 列表走通用 JSON 回退（数据可见，只是不做专用结构化渲染）。edit 的 `diagnostics`/`meta`/`firstChangedLine` 与未知字段**在**结果正文渲染（本轮已修复）。

## 3. 验证命令与结果（`app/`，Node v24.14.0，pnpm 10.34.5，`env -u SSH_ASKPASS`）

| 命令 / 范围 | 结果 | 退出 |
| --- | --- | --- |
| `pnpm --filter @pi-desktop/desktop typecheck` | 通过 | 0 |
| `pnpm --filter @pi-desktop/desktop lint`（style tokens） | style tokens OK | 0 |
| `pnpm lint:biome` | Checked 75 files | 0 |
| `pnpm --filter @pi-desktop/desktop build`（electron-vite renderer 重建） | built in ~6s | 0 |
| 定向七套 `node --test test/tool-presentation.test.mjs test/omp-subagent-presentation.test.mjs test/omp-tool-results.test.mjs test/omp-tool-results-render.test.mjs test/tool-display.test.mjs test/tool-row-file-refs.test.mjs test/omp-tool-row-mounted.test.mjs` | **85 passed / 0 failed** | 0 |
| 复审探针 `/tmp/m5-tool-paths-review.mjs` | 33/33（edit-update/move/multi-delete/pruned、lsp 诊断/全服失败/部分失败、debug evaluate/no-session/empty-output/future-field 各走 live/durable/child）+ 普通 PI 插件元数据 | 0 |
| 复审探针 `/tmp/m5-tool-residual-review.mjs`（S1-S4，11 例） | 11/11（debug 空 output/空断点带 snapshot 文本保留、断点 id/source/每项余量、LSP 标量 request、debug 非字符串 output、edit 非 record diagnostics、多文件顶层诊断、裁剪非 no-op、rename 关系） | 0 |
| 复审探针 `/tmp/m5-tool-preservation-review.mjs` | 8/8 均 `before=true` 且 `after=true` | 0 |
| 复审探针 `/tmp/m5-tool-row-mounted-review.mjs` | lsp 文本可见、debug no-session 文本可见、edit 路径经真实 host `fsResolveRef` 解析并打开一次、missing/error 只出 toast | 0 |
| 既有探针 `/tmp/m5-tool-text-review.mjs` / `/tmp/m5-row-budget-review.mjs` / `/tmp/m5-row-meaning-review.mjs` | lsp+debug 均 `presentationShowsText=true`；row-budget 全 `withinBudget`；row-meaning 全断言 | 0 |
| 全量 desktop `node --test test/*.test.mjs`（`app/apps/desktop`，固定 runtime 已备） | **2763 总数 / 2759 passed / 0 failed / 4 skipped** | 0 |

新增测试：`omp-tool-results.test.mjs`（25 例，真实 `OmpEventConverter.convertEntry`/`convert` → 真实 `buildToolPresentation`/`runOutcome`/`toolResultChips`，覆盖 LSP 诊断/服务器失败/text-only 失败/request、debug evaluate/paused+断点+output/no-session/empty-output/id/instructionPointerReference/未知字段、edit 单/多文件/rename/create/delete/no-op/pruned/partial-error/diagnostics/firstChangedLine/未知字段、live `tool_execution_end`、子代理转录、Pi `ops` 兼容、`plugin_publisher_edit` 兼容、大 Unicode 截断，以及 S1-S4 回归：snapshot 不抑制空 output/空断点、断点 id/每项余量/source 余量、未知值可读、多文件顶层诊断 + 裁剪非 no-op、rename 关系）；`omp-tool-results-render.test.mjs`（1 例，SSR 渲染真实 `ToolDetailBlocks` 断言 LSP/edit/debug 文本可见）；`omp-tool-row-mounted.test.mjs`（2 例，真实挂载 `ToolRow` disclosure + `ToolDetails`/`useOpenPreviewTarget`/`api`，成功打开一次、missing/error 只出 toast 不打开、`autoOpen` 不打开、restored/child 行无 `toolArgs`）。

### 3.1 环境修正（非源码改动）

六项真实固定 OMP E2E 此前在本新工作树报 `version-mismatch`（pinned launcher 解析到全局缓存 18.2.11 而非 18.2.7），随后报缺 `pi_natives.linux-x64.node`。本轮按自有固定子模块的 package scripts 准备运行时（均为 untracked/generated 产物，tracked 源码 0 改动、SHA 不变）：

1. `upstream/oh-my-pi` 内 `bun install --frozen-lockfile`（复用全局 cache，414 包链接）——launcher 现报 `omp/18.2.7`。
2. `bun run build:native`（`crates/pi-natives`，Rust `nightly-2026-08-12`；先以用户目录 `~/.local/omp-tools` 下载 cmake 3.30.5 + ninja 1.12.1 补齐 opusic-sys 的构建工具）——产出 `packages/natives/native/pi_natives.linux-x64-modern.node`，1m43s。
3. 校验 launcher `omp/18.2.7`、子模块 SHA `d49918f`、tracked 源码 clean（`git status --porcelain` = 0）后运行全量 desktop。

不通过改预期版本、用全局 18.2.11、跳过 E2E 或改其它工作树来规避。

## 4. 先红后绿证据

- 复审探针 `/tmp/m5-tool-text-review.mjs` 在 T17 验收基线上：LSP `presentationShowsText=false`（仅 `action/serverName/success` 可见）、debug `presentationShowsText=true`（经 details.evaluation）。本轮改后两例均 `presentationShowsText=true` 且退出 0。该探针不是实际 LSP/DAP 运行时或 UI/E2E 执行，而是 converter→presenter 回归探针。
- 独立复审三探针在基线 `5ca3212` 复现：paths 27/33（debug no-session/empty-output 三条路径全丢、普通 `plugin_publisher_edit` 丢 revision/嵌套元数据）、preservation 8 例全丢、mounted 组件交互（debug 文本隐藏、edit 路径非可点）FAIL。本轮改后三探针全部退出 0（见 §3）。`/tmp/m5-tool-preservation-review.mjs` 用 `git show ca6a255` 取已验收 presenter、以未改依赖转译后对照同一实际 converter 行，故「before=true」是真实回归证据而非假设审查。

## 5. 未完成项 / 限制

- 未新增 ADR：本轮是既有 `tool-presentation.ts` 边界内的纯展示适配，不改变接口/契约/权限/架构（沿用 ADR 0300/0303 的「差异集中在适配层」原则），故只在验证文档记录。
- 真实付费模型烟测、Windows、打包均不在 T18 范围；`branch`/`steer`/`followUp`/`compact`、子代理单独停止仍关闭（T19/T20 逐项开放）。
- macOS 中文路径的 9 项 PI release-fixture 失败属 M6/T22，本轮不做无关修复。
- T18 仍待独立复审确认（未验收）；独立复审返修 R1-R4 与 S1-S4 已完成。
