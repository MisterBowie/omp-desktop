# M5/T20-R3A：OMP 过渡工具契约补丁 —— 风险收敛补丁与 R3 仍阻塞的复审结论

更新时间：2026-09-25。状态：**R3 仍为硬阻塞（独立复审 F3 确认），T20-B 不得开始。** 本轮（复审返修轮）撤回了上一提交中"R3 已解除 / T20-B 可以开始"的结论，并把已完成的补丁收敛为**风险收敛**（loop 可控路径），而不是 PI 兼容性声明。分支 `codex/m5-omp-transition-hooks`；返修基线 `a78cec6df4572031365e8ea6a4237ca8db04ab20`；本文件描述返修后的最终状态。固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（omp/18.2.7）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`，gitlink 与工作树均未改动。

**第二轮独立复审返修（F6-F9，基线 `474408de2b2bdb538f5b2249d71398b8537e1fed`）**：只修本阶段脚本与证据，补丁 artifact 与 manifest 未改动（`sha256 e08ca7ff…fd8`、72978 字节，与 manifest 一致，见 §5）。R3 仍是硬阻塞、T20-B 仍不得开始；脚本测试面从 17 项增至 **24 项**（§6.1）。

**第三轮返修（macOS 复审的测试面跨平台修正，基线 `81ab2ce41faea2e2c62aab41431ea651a4b341e3`）**：macOS 独立复审实跑 `node --test apps/desktop/test/omp-patch.test.mjs` 得 **22/24**——F6 的 6 个正常 CLI 路径与 F7 的 `--source` symlink 攻击用例**全部通过**（生产修复在 macOS 上有效），失败的恰是第二轮新增的**两个测试自身的夹具/平台假设缺陷**（逐行可达性分析见 §6.2）：①夹具别名用词法拼写与 canonical 组件比较，被 macOS `tmpdir()` 前缀自身的 `/var -> /private/var` 改写击穿；②对**悬空**的根级符号链接（macOS `/.VolumeIcon.icns`）直接调用 `canonicalizeAncestor`，而该形状在生产中不可达。本轮只改测试与本文档；生产脚本、补丁 artifact、manifest 均未改动。修正后的结果已由独立复审在本机 macOS 实跑确认（见下段与 §5/§7）。

**第四轮（最终独立复审证据落盘，基线 `47d0258bd4610dcefb8a15f6c437a3afa46b9296`）**：独立复审在从远端 `47d0258` 建立的全新 detached worktree 上实跑 macOS 证据——① `node --test apps/desktop/test/omp-patch.test.mjs` 连续两次 exit 0、**24 通过 / 0 失败 / 0 跳过**（含第三轮修正的「canonicalizes the ancestor chain through a trusted alias and still refuses deeper links」与「follows the aliases the platform ships directly below the filesystem root」）；② F7 最小真实 git fixture 在最新提交上 status 1、错误 `scratch target must not live inside the source checkout: /private/tmp/…/source/inside`、真实 `out` 未创建、source `git status` 为空；③ `node scripts/omp-patch.mjs --check --json` exit 0（patch sha `e08ca7fff29bbd03e298f4488888b2692adda1486e3fff80536a31dd8af6fd5c`、追踪文件 7518）；④ `git diff --check ba7806c…` 与 `git show --check HEAD` 均 exit 0；⑤ 两个子模块固定 SHA 且干净。本轮只追加文档：生产脚本、补丁 artifact、manifest、子模块均未改动；**R3 结论不变**。

**第五轮（T20-R3B：provider/bridge 层可行性审计，基线 `e56979e9a40abf04df842f1e9c9860ffc7a5ed2e`，分支 `codex/m5-r3-provider-gate`）**：本轮**未改生产代码、补丁、manifest、测试与子模块**，只新增一个确定性 RED 实验（`app/experiments/omp-bridge/t20-cursor-exec-order.mjs` + `results/t20-cursor-exec-order.json`）与本文 §9。结论与第三轮独立复审一致并**加强**：Cursor exec channel 让"批次裁决前零执行"在本层不可满足——**方案 A（延迟 exec 到 message_end）不可行（自锁死）**，**方案 B（全 loop 路由：关 `mcp` bridge + `cursorExternalToolExecutor` + 处理原生帧）在非原生半边可测通，但原生半边无任何请求侧开关，只能永久拒绝 = 产品限制**。R3 仍为硬阻塞，T20-B/C/D 未开始。

## 1. 结论（含撤回）

- **R3（过渡工具独占批次 → 同批零执行；提交后终止）在 PI 语义下不可满足**，因此**不得解除**：PI 对 assistant message 的**全部** `toolCall` 计数（`upstream/pi-desktop/packages/agent-runtime/src/runtime.ts:2222-2234`：`content.filter(block => block.type === "toolCall")`，无任何排除），而 OMP 存在**在 assistant message 形成之前就已执行**的调用通道（Cursor exec channel / provider bridge），其副作用不可撤销，补丁层无法阻止。
- **撤回**：`a78cec6` 中"R3 已解除 / T20-B 可以开始"的声明（任务板、HANDOFF、ADR 0305、运行时 spec §15、本文件旧版本）全部撤回；相关文档现统一写"仍阻塞"。
- **保留并加强**（作为风险收敛，不构成解除依据）：批次计数改为**全部** `toolCall` 块（与 PI 同口径）、speculation 预执行门禁、批次拒绝语义、terminate 透传、RPC 边界严格校验。
- **不减小契约**：验收口径仍是"批次内全部调用零执行/零 `tool_execution_start`/零 host call/零副作用"；正因为 Cursor 通道使该口径不可满足，才判定阻塞。

## 2. F3：为什么严格契约在本层不可实现（源码依据）

| 事实 | 源码位置 | 结论 |
| --- | --- | --- |
| PI 对整条 assistant message 的全部 `toolCall` 计数，含任何特殊/已解析调用；含过渡工具且总数 ≠ 1 时逐个 block | `upstream/pi-desktop/packages/agent-runtime/src/runtime.ts:2222-2234` | PI 的"批次"= 消息内的全部 toolCall 块；任何排除都是偏离 |
| 提交工具的三个终支都 `terminate: true`（host 调用抛错 / proposal 非法 / 成功提交） | `runtime.ts:5110-5120`、`5137-5144`、`5165-5171` | 终止语义本身可实现（本补丁已实现并有测试） |
| `kCursorExecResolved` 标记的含义：Cursor exec channel **已在流式期间于服务端执行**该调用，结果另行缓冲；`agent-loop.ts` **必须**跳过执行，否则重复副作用 | `packages/ai/src/utils/block-symbols.ts:46-57`、`packages/agent/src/agent-loop.ts:1436-1441`、`1493-1496` | 该调用的副作用发生在 loop 之前，loop 只能"不重复执行"，无法阻止或撤销 |
| Cursor 结果在 assistant 消息关闭后由 agent 侧缓冲统一发出；非 Cursor provider 不会产生这些块 | `packages/agent/src/agent.ts:1491-1497` | 该通道由 provider/bridge 驱动；对 loop 是不可控输入 |
| 投机执行的候选在**流式期间**启动物理执行：`toolcall_end` → `admitFinalized` → `#insertCandidate` → `#drain()` → `#startCandidate` → `policy.execute(...)` | `packages/agent/src/agent-loop.ts:2264`、`packages/agent/src/speculative-execution.ts:847-905`、`884-953` | 若不做门禁，候选可在批次组成未知时先执行；本补丁用门禁消除了这条 loop 内路径 |
| 投机收敛与准入完成点：`reconcileFinalCalls` → `finalizeAdmissions`（置 `#admissionsFinalized` 并 drain）→ `discardAll/close` 会丢弃候选与 stream session | `packages/agent/src/agent-loop.ts:2033-2049`、`speculative-execution.ts:283-288`、`419-439` | 门禁可做到"批次判定前不启动候选" |
| 唯一 `finalized` 投机策略是 `read`（纯本地读）；`eval` 只有 `stream` 影子单元，且注释自认"已开始的物理工作无法撤销" | `packages/coding-agent/src/tools/read.ts:841-855`、`packages/coding-agent/src/tools/eval.ts:409-441`、`packages/coding-agent/src/eval/speculation/cell-session.ts:148-152` | 上游自身承认存在不可撤销的预执行，佐证阻塞成立 |
| 投机配置来源：`speculativeToolExecution.enabled`，每个 provider 调用创建协调器 | `packages/coding-agent/src/sdk.ts:3662,3749`、`packages/agent/src/agent-loop.ts:1919-1926` | 门禁点可选在协调器创建处，且不影响未声明 sole 的会话 |

**判定**：严格契约要求"含 sole 工具的批次内所有调用（含 Cursor 已执行调用）零副作用"。Cursor 已执行调用的副作用发生在 assistant message 存在之前，属于 provider/editor bridge（`packages/ai/src/utils/block-symbols.ts:46-57`），**当前 patch 层无法阻止**；因此 F3 判定为**架构性阻塞**，本轮不解除 R3，也不得把口径缩小为"仅 loop dispatch 的调用"。

## 3. 本轮实际修复（风险收敛，逐项）

### 3.1 全 toolCall 计数（对齐 PI）

- `batchToolCalls(assistantMessage)` 取消息内**全部** `toolCall` 块；`batchAdmissionEntries(...)` 用与派发相同的工具解析给出 `{name, sole}`；pre-dispatch 准入与执行期守卫**共用**同一裁决（`soleBatchRejectionReason`）。
- 效果：`[Cursor 已执行调用, sole]` 现在**会被判定为多调用批次并整批拒绝**——sole 工具不执行、loop 不重复执行 Cursor 调用、无 `tool_execution_start`、无 host call；被派发的调用按顺序得到 blocked 结果。
- 诚实边界（测试内注明）：Cursor 调用**已在上游执行**、其结果由上游缓冲发出；本补丁只保证 loop 不再重复执行它，不保证"整批零副作用"。

### 3.2 speculative 预执行门禁

- 当该 provider 调用的活动工具表里存在 `batchPolicy: "sole"` 的工具时，本 provider 调用**不创建投机协调器**：不 admit 候选、不开启 stream 影子单元，因此批次判定之前不可能有任何投机物理执行。
- 影响（必须明示）：注册了过渡工具的会话（Plan/Goal 模式）失去 `read`/`eval` 投机预执行；未声明 sole 工具的会话（含 OMP 自身全部既有测试）行为不变。普通批次、并发调度、steering、provider replay、host cancel 均未改动。

### 3.3 批次拒绝语义（保留）

含 sole 工具且调用数 ≠ 1 时整批拒绝：不调度、零 `tool_execution_start`、零 host call、按调用顺序逐个 blocked 错误结果，且**不触发审批/扩展钩子**（PI 的顺序：批次守卫先于扩展钩子，`runtime.ts:2225-2234` 之前的 `beforeToolCall` 分支）。

### 3.4 RPC 边界严格校验（F2 与附加项）

- `concurrency`/`batchPolicy` 只有**省略**（`undefined`）才取默认值；JSON `null` 及任何非法值使整个 `set_host_tools` 请求被拒绝，且不会留下半注册集合（`normalizeHostToolPolicy` + `setTools` 先建后提交）。
- `host_tool_result.result.terminate` 必须是可选 JSON boolean：非 boolean 帧在 `isRpcHostToolResult` 被拒（作为未知命令 fail closed），直接调用 bridge 时也会以错误终结该调用，绝不按真值转换为终止。

### 3.5 terminate 透传（保留）

`AgentToolResult.terminate` / `afterToolCall` override → 批次结算后结束 run，成功与错误同样适用、非 abort（不改写 `stopReason`、`signal.aborted === false`、steering 保留）；`host_tool_result.result.terminate` 原样进 loop 并对顶层 `isError` 组合为 `frame.isError || result.isError`；流式 partial 永不终止。

## 4. 交付物

| 位置 | 内容 |
| --- | --- |
| `app/patches/oh-my-pi/0001-rpc-host-tool-transition-contract.patch` | 补丁本体（10 文件；`sha256 e08ca7fff29bbd03e298f4488888b2692adda1486e3fff80536a31dd8af6fd5c`，72978 字节，F6-F9 轮复核对齐 manifest，§4 旧值 378c3d6b…/72885 已被更正） |
| `app/patches/oh-my-pi/manifest.json` | base SHA、版本、patch SHA-256/字节数、能力标识、**status（not-strict + 阻塞原因 + 已撤回声明）** |
| `app/scripts/omp-patch.mjs` | 唯一应用入口：manifest/checksum/base 校验（schemaVersion 仅接受 1）、**逐组件 canonical 解析（仅跟随 root 直属系统别名）**、source/仓库根/cwd 的 canonical 保护边界、安全 scratch、应用、`--prepare-build`、`--verify`（进程组回收 + 退化 pid 防护）、finally 清理 |
| `app/apps/desktop/test/omp-patch.test.mjs` | **24 项**脚本正向/负向测试（含父级符号链接越界、真实根别名、source symlink 围栏、flag 取值边界、退化 pid、spawn 失败快速结算、孙进程回收） |
| `app/experiments/omp-bridge/t20-feasibility.mjs` | 双轨 spike（未补丁 / `--patched`），结果分别落 `results/t20-feasibility.json`、`results/t20-feasibility-patched.json` |

新增 OMP 测试（补丁内）：`packages/agent/test/agent-loop.test.ts` 新增 4 项（Cursor-resolved sibling 计入批次并整批拒绝；speculation 两种顺序下都不启动候选；无 sole 工具时投机照常工作的对照）；`packages/coding-agent/test/rpc-host-tools.test.ts` 新增 3 项（null 策略在 bridge 与 `set_host_tools` 边界都被拒且不留半注册、非 boolean terminate 被拒且不被强转）。

## 5. 证据（返修轮，全部实跑）

环境：Node v24.14.0（nvm）、Bun 1.4.2；全部使用 fake provider/本地夹具，未调用付费或远程模型。

| 命令（工作目录） | 结果 |
| --- | --- |
| `node t20-feasibility.mjs`（`app/experiments/omp-bridge/`） | **38/46**，失败恰为 8 项 R3 契约（未补丁基线，`results/t20-feasibility.json`） |
| `node t20-feasibility.mjs --patched` | **46/46**（全新 scratch 树）——**仅证明 loop 可控路径**：批次拒绝、零 host call/零 execution start、提交成功/失败后 0 次后续 provider 请求；**不构成 R3 解除依据**（该 spike 的 fake provider 不产生 Cursor exec 通道，也不启用工具投机；相关路径由 §3.1/§3.2 的单元测试覆盖） |
| `bun test packages/agent/test/agent-loop.test.ts`（补丁树） | 143 通过 / 0 失败 |
| `bun test packages/coding-agent/test/rpc-host-tools.test.ts`（补丁树） | 13 通过 / 0 失败 |
| `bun test packages/agent/test/agent-loop.test.ts packages/coding-agent/test/rpc-host-tools.test.ts packages/coding-agent/test/rpc-input-frame.test.ts`（补丁树，合并） | **171 通过 / 0 失败**（143 + 13 + 15） |
| `node --test apps/desktop/test/omp-patch.test.mjs`（`app/`，F6-F9 返修后，本机 Linux） | **24 通过 / 0 失败 / 0 跳过**（连跑 3 次结果一致） |
| 同一命令（`app/`，第三轮测试修正后，本机 Linux） | **24 通过 / 0 失败 / 0 跳过**（连续两次；两项修正后的用例另以 `--test-name-pattern` 单独复核） |
| 同一命令在本机 macOS（`81ab2ce`，第三轮修正**前**，独立复审） | **22 通过 / 2 失败**（历史 RED/复审事实，保留）：F6 的 6 个正常 CLI 路径与 F7 的 `--source` symlink 用例全部通过；失败的 2 项是新增测试自身的跨平台夹具缺陷（§6.2），非生产回退 |
| 同一命令在本机 macOS（`47d0258`，第三轮修正后，独立复审实跑） | **24 通过 / 0 失败 / 0 跳过**（连续两次 exit 0；含第三轮修正的「canonicalizes the ancestor chain through a trusted alias and still refuses deeper links」与「follows the aliases the platform ships directly below the filesystem root」） |
| F7 最小真实 git fixture（`--source <symlink>` + `--out <real-source>/inside`），本机 macOS（`47d0258`，独立复审实跑） | status 1，错误 `scratch target must not live inside the source checkout: /private/tmp/…/source/inside`；真实 `out` 未创建，source `git status` 为空 |
| `node scripts/omp-patch.mjs --check --json`（本机 macOS `47d0258`，独立复审） | exit 0；patch sha `e08ca7fff29bbd03e298f4488888b2692adda1486e3fff80536a31dd8af6fd5c`、追踪文件 7518（补丁 artifact 未改动） |
| 第三轮修正的两项测试失效性对照（本机 Linux，临时改坏生产脚本后立即还原） | `isTrustedRootAlias` 恒 false → 真实根别名用例失败；`canonicalizeAncestor` 的链接拒绝整段短路 → 遍历用例失败；两项修正都不是空转断言 |
| 同一命令在 `474408de` 上（RED 证据；输出见交付报告） | **18 通过 / 5 失败**，失败原因逐项核对：F7 `--source <symlink>` + `--out <real-source>/inside` `actual: 0, expected: 1`、`TypeError: isTrustedRootAlias is not a function` / `canonicalizeAncestor is not a function` / `isSignalableProcessGroup is not a function`、`--out --json` `actual: 0, expected: 2` 并在 `$PWD` 建出 `--json/` 树 |
| 旧策略 vs 新策略（本机 Linux 真实根别名；一次性探针，旧判定即 `realpath(nearestExistingParent) !== nearestExistingParent`） | 旧策略即拒 `/bin`、`/lib`（与 macOS `/var → /private/var` 同类）；新策略 canonicalize 为 `/usr/bin`、`/usr/lib`；`/tmp`（真实目录）两者均接受。该判定的常驻回归是 suite 中的「真实根别名」用例 |
| `node scripts/omp-patch.mjs --apply --out /tmp/omp-t20-fix2-smoke --json` | exit 0；7518 追踪文件；`tree` 为 canonical `/tmp/omp-t20-fix2-smoke`；补丁内容可见（`soleBatchRejectionReason` 等 7 处） |
| 同上把 `--out` 指向 `<tmp>/link/new-tree`（`link -> <tmp>/protected`） | exit 1：`OMP-PATCH-FAIL scratch target must not be reached through a symlink: …/link`；`protected/` 仍为空 |
| `./node_modules/.bin/biome lint`（`app/`） | Checked 75 files，0 问题 |
| 补丁 artifact 复核 | `sha256 e08ca7ff…fd8`、72978 字节，与 `manifest.json` 完全一致（未改动；按约定不重跑补丁内 171 项） |
| `node scripts/omp-patch.mjs --check --json` | 通过：`patchLevel d49918f+omp-desktop.1`、`patchSha256 e08ca7fff29bbd03e298f4488888b2692adda1486e3fff80536a31dd8af6fd5c`、追踪文件 7518、scratch 清理 |
| `node scripts/omp-patch.mjs --apply --out <dir> --prepare-build --verify` | 通过，7.7 秒：launcher 报 **18.2.7**；树内 agent-loop + rpc-host-tools **156 通过 / 0 失败**；异常/超时按进程组回收 |
| `bun run check:types`（补丁树 agent / coding-agent） | agent 0 错误；coding-agent 仅 `test/judgment-chain.test.ts(296,52)` 预存在错误（未改动固定检出逐字复现） |
| `bun run lint` / `bunx oxlint` / `bunx oxfmt --check` | oxlint 0 问题；改动面 9 个**代码**文件全部符合 oxfmt 格式 |
| `bunx oxfmt --check docs/rpc.md`（固定基线未改文件） | **基线即不符合**（上游该 markdown 自身未按 oxfmt 排版）：因此**不对其做全文件重排**，只手工追加 42 行同风格内容（`git diff --numstat` 为 `42+/0-`）；同理，本轮曾误跑 oxfmt 使其膨胀到 86650 字节，已回退并重新生成（现 72978 字节）。逐文件 hunk 与删除行审计见 §6 |
| `biome lint`（`app/`，配置面 75 文件） | 0 问题（新增脚本与实验文件不在 `biome.json` 的 `files.includes` 面内，以 `node --check` 兜底） |
| `node --check`（新增/修改 `.mjs`） | 全部通过 |
| `git diff --check ba7806c0646180b2b40a83fa998f2437295174af..HEAD` | exit 0（`.patch` artifact 的作用域 whitespace 豁免，见 §6；返修前该命令 exit 2 / 34 行报错） |
| `git show --check HEAD` | exit 0 |
| T20 定向 37 项 / 矩阵 lint / gap 诊断 | 37/37；`MATRIX-ID-OK` exit 0；`OMP_T20_GAP_PROBE=1` 报 **3 缺口（g1/g2/g3 归属 T20-B/C）exit 1**——产品侧缺口保持红灯，未静态假绿 |

## 6. 边界与安全修复（复审附加项）

- **F1/F6 目标目录 canonical 化（含 macOS 系统别名）**：`--out` 的最近存在父目录逐组件 canonicalize（`canonicalizeAncestor` + `isTrustedRootAlias`）。只有**文件系统根直属、属主为 root** 的符号链接被跟随（macOS `/var`、`/tmp`、`/etc` → `/private/…`，usrmerge Linux `/bin`、`/lib`、`/sbin`）：这类条目非 root 无法创建/替换/删除，属于平台自身的别名，拒绝它们会让 macOS 上任何 `--out /tmp/…`（含 `tmpdir()` = `/var/folders/…`）失败。其余任何深度、任何属主的符号链接仍在创建/复制/删除前拒绝（例：`/tmp/link -> /protected` 时 `--out /tmp/link/new-tree` 被拒，`/protected` 未被写入也未被删除）。拒绝后仍对 canonical 目标做保护路径、自身符号链接、非空目录检查，创建/复制/失败清理全部使用 canonical 路径，`tree` 报告 canonical 路径。回归测试（第三轮已修正跨平台夹具，见 §6.2）：策略单测（synthetic stats 的 macOS/Linux 形状）+ 遍历单测（伪造根下跟随别名、深层链接仍拒；夹具别名按 **canonical** 拼写比较）+ 真实根别名用例（只探测**存在且可 realpath** 的候选 `/var`、`/tmp`、`/etc`、`/bin`、`/sbin`、`/lib`、`/lib64`，断言 `isTrustedRootAlias` 与 canonical 目标；平台没有这类**可解析**别名时显式 skip，不伪装通过；并对 `tmpdir()` 断言 canonicalize 而非拒绝）。**macOS 真实 24/24 已由独立复审在 `47d0258` 本机实跑确认（连续两次）**（见 §6.2、§7）。
- **F7 `--source` 等保护边界同样 canonical 化**：`--source`、仓库根、app 根、`process.cwd()` 全部 canonicalize 后才做等值/祖先/后代判断。此前只 canonicalize 目标，`--source source-link`（`source-link -> real-source`）+ `--out real-source/inside` 会绕过"不得位于 source 内"，在**真实检出**中创建目录（本机 macOS 已用真实 git fixture 复现：status 0、`?? inside/`）。回归测试断言拒绝、`inside` 不存在、source 文件内容/条目列表不变且 `git status --porcelain` 为空；同样断言 `--out` 经符号链接指向 source 时拒绝、目标不变。
- **参数取值边界（F9 与缺值）**：`--out`/`--manifest`/`--source` 缺少值、或下一 token 以 `-` 开头（本身是 flag）时，一律报 `<flag> requires a value`（exit 2，零副作用）。此前 `--out --json` 会把 flag 当路径，在 `$PWD` 创建 `--json/` 并填充整棵追踪树；`--out --source foo` 则报出无关的 `unknown argument: foo`。取值要写以 `-` 开头的路径请用 `./-name`。
- **manifest schemaVersion**：只接受脚本明确支持的 `1`，其它值 fail closed（回归测试 99 → 拒绝）。
- **`--verify` 进程组回收 + 退化 pid 防护（F8）**：`runReaped` 以 `detached` 建组，超时按 SIGTERM→SIGKILL 升级杀整组，直接子进程结束后再对整组补杀一次；回归测试用一个"生成孙进程后挂起"的夹具，断言超时后孙进程确实消失（不再出现 `delayed-tool-mcp.ts` 式残留）。`isSignalableProcessGroup` 在取负之前拒绝退化目标（`pid` 必须是 >1 的整数）——`process.kill(-0)` 会杀本进程组、`-1` 会杀用户可杀的全部进程，上游 `eval/kernel-base.ts` 同口径；单测覆盖 `undefined/0/1/负数/非整数/NaN`。`child.on("error")` 改为先对有 pid 的子进程整组 SIGKILL 再 settle；**可达的 spawn 失败（ENOENT/EACCES）没有 pid、也就没有进程组**，回归测试断言立即结算（`< 5s`，`timeoutMs` 为 60s）、`timedOut === false`、`error.code === "ENOENT"` 且 `getActiveResourcesInfo()` 无残留 `Timeout`；"子进程已存在再收到 error"的整组杀灭是防御性分支，本脚本可达的错误形状不产生该情况，**不声称已实测**（见 §7）。
- **`.patch` artifact 的 whitespace**：`app/.gitattributes` 仅对 `patches/oh-my-pi/*.patch` 关闭 whitespace 检查（patch 载荷行天然是"diff 标记 + 原缩进"），普通源码检查未放宽；`git diff --check <base>..HEAD` 与 `git show --check HEAD` 均为 exit 0。
- 凭据不外泄：脚本只打印路径/哈希/命令名；测试用 `MY_API_KEY=canary-…` 断言输出不含该值；验证子进程使用隔离 HOME 并剥离凭据类变量。
- **不做大面积机械重排**：`docs/rpc.md` 在固定基线上就不符合 `oxfmt`，因此本补丁不对它（或任何其它上游文件）做全文件格式化；新增/修改片段按文件既有风格手工对齐。修复轮逐文件审计：`docs/rpc.md 42+/0-`、`agent-loop.ts 188+/24-`、`agent-loop.test.ts 635+/1-`、`rpc-host-tools.test.ts 329+/1-`、`host-tools.ts 85+/5-`、其余 1-30 行；全部 25 行删除都是本轮被替换的实现/断言行，无无关改动。返回码：`git diff --check <base>..HEAD` 与 `git show --check HEAD` 均 0（F4）。

### 6.1 固定源码检索结果（先例 / 借鉴 / 自有）

按约定先查 PI Desktop 固定检出（`upstream/pi-desktop@0111e30`），再查 OMP 固定检出（`upstream/oh-my-pi@d49918f`）：

| 问题 | PI Desktop（可引用路径） | OMP（可引用路径） | 本轮处置 |
| --- | --- | --- | --- |
| macOS `/var`、`/tmp` 别名 | Rust 侧显式处理：`crates/host-core/src/workspace.rs:239-256`（把字面 scratch 前缀改写后重解析，注释点明 `/var vs /private/var`）、`crates/host-core/src/rpc/mod.rs:945`；测试注释 `apps/desktop/test/plugin-fs-scope.test.mjs:715`（raw 比较永不相等） | `packages/utils/src/dirs.ts:139-160` `standardizeMacOSPath` / `resolveEquivalentPath`（"preserves aliases like /private/tmp -> /tmp"）；`packages/coding-agent/src/tools/plan-mode-guard.ts:99` | **借鉴**"平台别名必须归一"的事实；但两处都**未找到**"逐组件拒绝父级符号链接、同时豁免 root 直属别名"的实现 → 属 **OMP Desktop 自有构建工具**（`isTrustedRootAlias` + `canonicalizeAncestor`），安全边界写明为"非 root 无法在 `/` 下直接创建/替换条目" |
| 逐组件符号链接拒绝 | `apps/desktop/electron/main/imported-package-skills.ts:11-30`（`assertImportedPackagePath`：逐段 `lstatSync`，命中链接即 `invalid`） | 未检索到同类逐段拒绝工具 | **借鉴**遍历写法（逐段 `lstatSync`），另加别名策略与 canonical 返回值 |
| canonical 后再做包含判断 | `apps/desktop/electron/main/services/image-generation-service.ts:71-75`（两侧 `realpath` + `within`）、`apps/desktop/pi-host/src/host-operations.ts:164-196`、`apps/desktop/electron/main/session-list-probe.ts:35-38`（`realpath(tmpdir())` 对 `realpath(dataDir)`） | `plan-mode-guard.ts:99`（realpath 归一后比较） | **借鉴**：source/仓库根/app 根/cwd 全部 realpath 后再比较（F7） |
| 进程组信号与退化 pid | `apps/desktop/electron/main/npm-executable.ts:96-135`（`killProcessTree` 先判 `pid`，`process.kill(-pid, …)` 失败回退 `child.kill`） | `packages/coding-agent/src/eval/kernel-base.ts:144-176` `isSignalableProcessGroup` / `killProcessGroup`（注释明确 `-0` 杀自身进程组、`-1` 杀全部可杀进程）、`packages/coding-agent/src/eval/probe.ts:103` | **借鉴** OMP 的 `pid > 1` 守卫（含理由）与 PI 的 `-pid` + 回退写法（F8） |
| flag 取值边界 | 该检出无同形 patch/scratch CLI 工具 | 未检索到同类参数解析先例 | **自有**（`parseArgs` + 定向回归，F9） |

### 6.2 第三轮：两项失败测试的生产可达性分析（测试缺陷，非生产回退）

macOS 复审的两项失败都落在第二轮新增测试**自己构造的形状**上；逐行核对生产调用路径后确认**生产脚本无需改动**：

- **「canonicalizes the ancestor chain through a trusted alias and still refuses deeper links」**（`app/apps/desktop/test/omp-patch.test.mjs:425`）：夹具在 `tmpdir()` 下造 `fakeroot/private/var` 与 `fakeroot/var -> private/var`，其"信任本夹具别名"的策略比较 `componentPath === alias`——`alias` 是**词法**拼写（`/var/folders/…/fakeroot/var`），而 `canonicalizeAncestor` 交给策略的 `componentPath` 是**逐组件 realpath 后**的规范化路径（`/private/var/folders/…/fakeroot/var`）。macOS 上 `tmpdir()` 自身就经 `/var -> private/var`，前缀被改写后词法比较永不相等，夹具别名被判为未受信任而抛错（复审所见 `scratch target must not be reached through a symlink: /private/var/folders/…/fakeroot/var`）。**生产可达性**：脚本只把 `nearestExistingParent(...)` 的结果交给 `canonicalizeAncestor`，生产代码里**不存在**"按拼写给出信任名单"的输入；被误判的只是夹具策略本身。本机用**生产** `canonicalizeAncestor` 复现了同一机制：受信任的中间别名一旦改写 canonical 前缀，词法比较策略必抛出同一错误串；改按 canonical 别名比较即解析成功，且**更深的可植入链接仍被拒绝**（§5 对照行）。修正：夹具别名改按 `join(realpathSync(fixtureRoot), "var")` 比较；三条断言（跟随别名、深层仍拒、默认策略仍拒）全部保留。
- **「follows the aliases the platform ships directly below the filesystem root」**（同文件 `:463`）：原实现枚举 `/` 下**全部**符号链接并无条件调用 `canonicalizeAncestor`，于是撞上 macOS 根目录中 root-owned 的**悬空**链接 `/.VolumeIcon.icns`（复审所见 `ENOENT … stat '/.VolumeIcon.icns'`）。**生产可达性**：`canonicalizeAncestor` 的入参只会是 `nearestExistingParent(resolvedTarget)` 的结果，而它的 `existsSync` **跟随链接**、对悬空项返回 false，因此悬空项从不成为入参；反之只要 `existsSync(existingParent)` 为真，链上每个组件都必然可解析，遍历中的 `realpathSync` 不会 ENOENT。本机 CLI 端到端复核（真实 git 夹具，`--out` 前缀是悬空链接）：**不出现**符号链接策略错误，exit 1 且为 `mkdir … ENOENT`（fail closed），目标未创建、source 未改动、`git status --porcelain` 为空。修正：只探测**存在且可 realpath** 的明确候选 `/var`、`/tmp`、`/etc`、`/bin`、`/sbin`、`/lib`、`/lib64`（macOS 覆盖 `/var`/`/tmp`/`/etc`；usrmerge Linux 覆盖 `/bin`/`/sbin`/`/lib`/`/lib64`，本机实测这四个 link → `/usr/…`），并保留对 `tmpdir()` 的 canonicalize 断言；平台若一个可解析别名都没有，则 `t.skip` 显式跳过并给出原因，不伪装通过。
- **为什么不是生产回退**：macOS 复审中同一 suite 里 F6 的 6 个正常 CLI 路径（含 `--apply --out /tmp/omp-review-81ab-apply --json` 成功、`tree` 报告 canonical `/private/tmp/omp-review-81ab-apply`、7518 追踪文件）与 F7 的最小真实 git 夹具（exit 1、`scratch target must not live inside the source checkout: /private/tmp/…/source/inside`、`out` 不存在、source `git status` 为空）**全部通过**，说明 canonical 化与围栏在 macOS 上按设计工作；两项失败各自停留在夹具拼写与不可达入参形状，未经过生产脚本的对应分支。失效性对照（§5）：把 `isTrustedRootAlias` 改成恒 false、或把遍历的链接拒绝整段短路，两项修正后的测试都会立即失败——不是空转断言。

## 7. 未做/未声称

- **R3 仍阻塞**：不得开始 T20-B/C/D；产品侧 gap 诊断保持 3 缺口 exit 1。
- **不声称上游支持**：patch level 仍是本项目维护的 `d49918f+omp-desktop.1`，运行时仍报 `omp/18.2.7`。
- **未跑完的套件不得声称通过**：补丁树内 `packages/agent` 全量 `bun test` 曾卡在既有夹具 `delayed-tool-mcp.ts`（本轮已实现并验证进程组回收通道，但未重跑该全量套件）；通过证据只来自改动面套件、typecheck 与父仓库定向套件。
- **macOS 脚本 suite 已确认，范围有限**：`81ab2ce` 上独立复审实跑为 **22/24**（历史 RED/复审事实，保留），其中 F6 的 6 个正常 CLI 路径与 F7 的 symlink 攻击用例均已通过，另 2 项失败经 §6.2 确认为**测试夹具缺陷**并已最小修正（只改测试与本文档）；修正后的 `47d0258` 由独立复审在本机 macOS 实跑为 **24/24（连续两次 exit 0）**。本文件只声称**脚本 suite 的 macOS 24/24**：**不声称**补丁内 171 项在 macOS 重跑，**不声称**全量套件或 Windows 通过。行为差异须注意：macOS 上 `--out /tmp/…` 的 `tree` 报告 canonical `/private/tmp/…`（同一目录）。
- **未测的异常分支（不得声称已测）**：`child.on("error")` 在"子进程已存在且 pid 有效"时整组杀灭属防御性分支——本脚本可达的 spawn 错误形状没有 pid；已测的只有 ENOENT/EACCES 的立即结算与定时器清理，以及退化 pid 的守卫单测。
- **补丁本体未改动**：因此按约定未重跑补丁内 171 项测试，只复核 `sha256`/字节数与 `manifest.json` 一致（§5）。
- 未覆盖：真实付费模型、Windows 平台行为、T20-B 的模式/审批链路。

## 8. 解除 R3 的可能路径（供后续决策，不构成本轮承诺）

1. 上游或补丁让"过渡工具批次"不再走会预执行的通道：Cursor exec channel 不在会话内预执行、工具投机对这类会话关闭（本补丁已做后者）；
2. 产品层显式决策：声明 sole 工具的会话禁用 Cursor exec 通道（需要 provider/bridge 侧开关，非 loop 能决定）；
3. 用户明确接受语义差异：只保证 loop 可控路径（当前补丁的状态），并据此重写验收口径。

## 9. T20-R3B：provider/bridge 层可行性审计（2026-09-25）

本轮任务：在**不改生产代码/补丁/manifest/测试/子模块**的前提下，判定严格 R3 契约能否在 Cursor exec provider/bridge 层满足，并给出方案 A（延迟 exec 到 message_end）与方案 B（全 loop 路由）的逐项判定。**结论：两者都不满足严格契约，R3 仍为硬阻塞，T20-B/C/D 不开始。**

### 9.1 基线与环境

| 项 | 值 |
| --- | --- |
| 父仓库 | HEAD `e56979e9a40abf04df842f1e9c9860ffc7a5ed2e`，分支 `codex/m5-r3-provider-gate`，工作树干净（本轮前） |
| 子模块 | OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（omp/18.2.7）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`；gitlink 与工作树未改动 |
| 运行时 | Bun 1.4.2（`process.versions.node` 报 26.3.0，是 bun 内置的 Node 兼容版本号；系统 `node` 为 v24.14.0） |
| 本轮新增 | 仅 `app/experiments/omp-bridge/t20-cursor-exec-order.mjs`、`app/experiments/omp-bridge/results/t20-cursor-exec-order.json`、本文 §9 |
| 网络/费用 | 全程无网络、无付费模型：所有帧与工具体都是本地夹具 |

子模块初始化说明（可复核）：本工作树原先只有空子模块目录，`git submodule update --init --recursive` 实测下载速率约 35 KB/s（pack 目标 544 MiB，不可行），因此按完全相同的方式从同仓库另一工作树（`/home/vv/person/code/omp-desktop-m5-t20`，同一固定 SHA）**本地复制**子模块 git dir 并 `reset --hard`；随后用 project 自己的构建载荷清单（`app/scripts/omp-patch.mjs` 的 `BUILD_PAYLOAD`）以**硬链接**补齐 `node_modules`、`packages/natives/native`、`packages/coding-agent/src/export/html/tool-views.generated.js`，使实验与上游套件可在本树内运行。这些载荷全部被上游 `.gitignore` 覆盖：两个子模块 `git status --short` 为空、gitlink 未变（§9.10 残留说明）。

### 9.2 PI 固定检出的语义坐标（先例检索结论）

| 事实 | 坐标 | 说明 |
| --- | --- | --- |
| 批次判据 = 整条 assistant message 的**全部** `toolCall` 块，无任何按名字/来源的排除 | `upstream/pi-desktop/packages/agent-runtime/src/runtime.ts:2222-2224` | `content.filter((block) => block.type === "toolCall")` |
| 混合批次**整批拒绝**，且发生在任何执行之前（`beforeToolCall` 预检，早于扩展钩子） | `runtime.ts:2229-2234`（block 返回）、`:1946`（wiring）、`:2235` 之后才是 `extensionToolCall` | `transitionInBatch && toolCalls.length !== 1` → `{ block: true, reason: "… must be the only tool call in the assistant message." }` |
| 提交工具终支 | 非法参数 `runtime.ts:5081-5092`（`PLAN_INVALID_ARGUMENT`，**无** `terminate`）；host 调用抛错 `:5106-5120`（`terminate: true` @ `:5119`）；proposal 非法 `:5125-5143`（`terminate: true` @ `:5142`）；成功 `:5169-5170` | 三个终支终止，非法参数分支不终止——R3-c 的准确口径是"host error / 非法 proposal / 成功"三个终支 |
| 无预执行/投机通道 | 批次顺序执行（`executionMode: "sequential"`，`runtime.ts:3419-3423`）；`beforeToolCall` 拿到的是完整 message | PI 侧不存在"消息成形前已执行"的调用通道 |
| **先例检索：没有**任何直接断言"含过渡工具的批次里兄弟调用零执行/零副作用"的测试 | 仅 `runtime.test.ts:2138-2219`（混合批次，断言 `{ block: true }`）；`apps/desktop/test/plan-artifact-contract.test.mjs:11-37`（对 `runtime.ts` 的正则/文本契约，非行为）；`scripts/e2e-plan-ui.mjs:62-64` + `:1028`（实跑驱动断言 transcript 工具序列恰为 `EnterPlanMode,SubmitPlan`） | 按本轮要求明确记录：**没有更直接的零副作用先例**，最接近的是 e2e 驱动的转录序列断言 |

即：PI 的"批次裁决先于任何执行"依赖同一进程内、同一线程的调用顺序（裁决函数在派发前被调用且能读到完整 message）。这正是 OMP 的 Cursor 路径无法复制的结构条件。

### 9.3 OMP 公开文档结论

- Cursor provider 章节：`upstream/oh-my-pi/docs/provider-quirks.md:433-467`。要点逐条：双向 RPC（`:454-455`）；`interactionQuery` 会 **block the turn until the client writes `interactionResponse`**（`:457-459`）；**Async Execution Drain & Turn Completion**：帧异步派发、`inFlightDispatches` 跟踪并在结束流之前收束（`:460-462`）；`synthesizeCursorExecToolCall` 为"本地执行"生成展示块（`:463-464`）。
- 其他文档面（`docs/providers.md:95`、`docs/environment-variables.md:84,328-333`、`docs/settings.md:310,317`、`docs/config-usage.md:205`）只涉及 Cursor 的**认证、调试环境变量、外部配置源发现**；`settings` 里的 `cursor` provider id 指"发现来源开关"，不是模型 provider。
- **结论：公开文档面不存在任何"延迟执行/禁用 exec 通道/按会话关闭 Cursor 原生工具"的开关。**`docs/toolconv/pi-native.md:105-108` 与 `docs/provider-quirks.md:571-573` 只说明 `execHandlers`/`cursorExecHandlers`/`cursorOnToolResult` 这类回调字段**不会**被送到 pi-native 传输（`NON_WIRE_KEYS`）。

### 9.4 OMP 源码/测试坐标（本轮实测相关）

| 事实 | 坐标 |
| --- | --- |
| exec 帧在**流式期间**同步等待本地结果：注释明确 "The server is waiting on OUR local tool result during this window — no AssistantMessageEvent flows until the handler finishes." | `packages/ai/src/providers/cursor.ts:1151-1193`（`execServerMessage` → `await stream.trackLocalWork(handleExecServerMessage(...))`） |
| 帧派发是 fire-and-forget 但被跟踪；`done` 之前 `await drainInFlightDispatches()` | `cursor.ts:854-882`（dispatch 与 `inFlightDispatches`）、`:949-960`（drain 后 `stream.push({type:"done"})`） |
| 每个 exec 块在**执行前**就被 `markCursorExecResolved`（`kCursorExecResolved`），因此 agent-loop 永不重复执行、也无法阻止 | `cursor.ts:4143-4169` `synthesizeCursorExecToolCall`；loop 侧过滤 `packages/agent/src/agent-loop.ts:638-641,1436-1440,1488-1499,2681-2682,2791-2793,2852-2858` |
| 无 handler 的出口：`buildRejected("Tool not available")` + 合成一个 isError 的配对结果；块**仍**是 resolved | `cursor.ts:2618-2674` `resolveExecHandler`（`if (!handler) { const reason = "Tool not available"; … }`） |
| `mcpArgs` 分支：只有存在 `execHandlers.mcp` 才 synth+mark+记录 `resolvedMcpToolCallIds`；无 `mcp` 时既不建块也不配对，答复为 `toolNotFound`，仅当 `externalToolExecutor` 才改为 handoff success | `cursor.ts:1938-1967`（`:1959-1962` handoff/toolNotFound 选择）、`buildMcpExternalHandoffResult` `:4025-4035` |
| 无 `mcp` handler 时块来自交互更新（`toolCallStarted` → `selectMcpCall`），`resolvedByExec` 仅当 id 在 `state.resolvedMcpToolCallIds` 中才为真 → 否则**未标记 resolved**，由 loop 执行并自行配对 | `cursor.ts:4291-4322`；`resolvedMcpToolCallIds` 定义/写入 `:776,790,1115-1116,1951` |
| 真实桥接：`CursorExecHandlers` 的方法直接调用 `tool.execute(...)`（`bash`/`write`/`edit`/`read`/`grep`/`glob`/`lsp`/`mcp`），不经过任何 loop 钩子 | `packages/coding-agent/src/cursor.ts:230-289`（`executeTool`）、`:434-435`、`:495-504`（shell→bash）、`:935-958`（mcp） |
| 桥接装配：每会话一次，`sdk.ts:3114-3148` 构造并 `:3726-3727` 交给 Agent；`allowDirectFileMutation` 只是**策略**开关（approval），非批次延迟 | `packages/coding-agent/src/sdk.ts:3114-3148,3726-3727`、`packages/coding-agent/src/cursor.ts:305-336` |
| `cursorExternalToolExecutor` **仅**由 auth-gateway 设置（两处） | `packages/ai/src/types.ts:671-672`；`packages/ai/src/auth-gateway/server.ts:136,558` |
| 请求侧无"禁用原生工具"字段：`AgentRunRequest` 全部字段 = conversationState/action/modelDetails/requestedModel/**mcpTools**/conversationId/mcpFileSystemOptions/skillOptions/customSystemPrompt；`RequestContext` 的 23 个字段里工具相关只有 `tools`（= 我方广告）与 `customSubagents`（服务端子代理的工具表，客户端恒发 `[]`） | `packages/catalog/src/discovery/cursor-proto.ts:184-193`、`:5498-5517`；客户端实际填写的 RequestContext 字段见 `cursor.ts:1614-1627`；`McpFileSystemOptions` 仅 `enabled/workspaceProjectDir/mcpDescriptors`（`:2316-2320`）且客户端不构造 |
| `customWireName` 在 Cursor 路径**零出现**（它属 OpenAI custom-format 概念）；MCP 广告按 `tool.name`，`CURSOR_NATIVE_TOOL_NAMES` 按名字排除 `bash/read/write/delete/ls/grep/todo`（`write` 会因 xdev 设备被重新加入） | `packages/ai/src/providers/cursor.ts:4640-4699`；host 工具**同名冲突**在注册期即拒：`packages/coding-agent/src/session/session-tools.ts:1966-1974`（`RPC host tool "…" conflicts with an existing tool`） |
| 上游测试：exec handler 未结束前**不会**发 `done`（真实 `node:http2` 夹具） | `packages/ai/test/cursor-terminal-error.test.ts:453-521`（"waits for an exec handler decoded from the final chunk before done"） |
| 上游测试：external handoff 只答复 `McpSuccess`（文案 "…handed off to the external client for execution. Do not retry or call it again; end the turn. The result will be provided in the next request."）；无 handler/空 handler 时 `toolNotFound` | `packages/ai/test/cursor-exec-modern.test.ts:1996-2020`、`:2089-2094`；文案来源 `packages/ai/src/providers/cursor-external-tool-handoff.md` |
| 上游测试：无 `mcp` handler 时**不留 resolved 标记、不收集 toolResult** | `packages/ai/test/cursor-exec-handlers.test.ts:1535-1615`（另有配对契约 `:205-215`） |
| **未找到**：任何"延迟 exec 到消息完成"或"批次拒绝后 Cursor exec 零执行"的上游测试；也没有把 no-handler+external 的 MCP 调用交给 loop 并断言"恰好一次"的端到端测试 | 见 §9.10 检索面（`packages/ai/test/cursor-*.test.ts`、`packages/agent/test/*`、`packages/coding-agent/test/cursor-exec.test.ts`） |

### 9.5 协议时序（实验 + 上游测试双证据）

问题：Cursor server 是否等待 exec response 才继续产生后续 toolCall/message_end？

- **客户端可证的强结论**：任何 exec handler 未 settle 时，assistant 消息的终态事件**不能**发出——`cursor.ts:949-960` 在 `stream.push({type:"done"})` 前 `await drainInFlightDispatches()`；上游 `cursor-terminal-error.test.ts:453-521` 用真实 http2 夹具（handler 用闸门挂住）断言 `done` 必须等 handler 完成，本机实跑该文件 **11 通过 / 0 失败**。
- **服务端行为的证据层级**：`cursor.ts:1170-1180` 的注释（"The server is waiting on OUR local tool result during this window"）与 `docs/provider-whitespace`→`docs/provider-quirks.md:457-459`（`interactionQuery` "block the turn until the client writes `interactionResponse`"，未回复则由 300s idle watchdog 中止）属**上游自述**；本轮**未**、也无法用 fake transport 观测真实服务端行为（fake 传输由我控制，观测不到对端）。因此本文件不声称"已实测服务端等待"，只声称"客户端结构上无法在消息完成后再执行"。

因此，"延迟 exec 到 message_end"在客户端**自锁死**：等待 message_end 的 handler 正是 message_end 的前置条件。

### 9.6 本轮新增的确定性 RED 实验

- 路径：`app/experiments/omp-bridge/t20-cursor-exec-order.mjs`（结果 `results/t20-cursor-exec-order.json`）。
- 走的**真实**路径：`cursor.ts` 导出的 `handleServerMessage`（生产 socket 读取循环调用的同一函数）+ `packages/coding-agent/src/cursor.ts` 的 `CursorExecHandlers`（`sdk.ts:3114` 为 Cursor 会话安装的同一类）；帧用 `create(...)` 由 `agent.proto` 编解码构造，仅 h2 socket 与两个工具体是本地夹具，副作用由工具体产生。**没有任何手工 `kCursorExecResolved` 标记**：标记来自 provider 自己的 `synthesizeCursorExecToolCall`。
- 命令（本机实跑，退出码 1 = 严格契约被违反，即 RED）：

```
bun app/experiments/omp-bridge/t20-cursor-exec-order.mjs
bun test packages/ai/test/cursor-terminal-error.test.ts     # 补丁树/固定树，11 pass
bun test packages/coding-agent/test/cursor-exec.test.ts     # 69 pass
```

- 精确调用序列（同步记录点，`toolcall_*` 事件经异步消费者记录、次序上滞后，不做结论依据）：

| 场景 | 序列 | 执行计数 |
| --- | --- | --- |
| s1 `[shell(兄弟), mcp(SubmitPlan)]` | `dispatch:shellArgs → tool_execution_start:bash → dispatch:mcpArgs → tool_execution_start:SubmitPlan → tool_execution_end:bash → tool_execution_end:SubmitPlan → drain:complete → done` | bash ×1、SubmitPlan ×1（**均在 done 之前**），兄弟文件已落盘 |
| s2 `[mcp(SubmitPlan), shell(兄弟)]` | `dispatch:mcpArgs → tool_execution_start:SubmitPlan → dispatch:shellArgs → tool_execution_start:bash → … → done` | SubmitPlan ×1、bash ×1（均在 done 之前） |
| s3 单独 `SubmitPlan` | `dispatch:mcpArgs → tool_execution_start:SubmitPlan → tool_execution_end:SubmitPlan → done` | SubmitPlan ×1，块 `resolved: true`，配对结果 `hasTerminate: false` |
| s4 无 handler（`execHandlers: undefined`） | `dispatch:shellArgs → dispatch:mcpArgs → drain:complete → done` | 0 次物理执行；但 bash 块仍 `resolved: true` 且收到 `ShellRejected{reason:"Tool not available"}`，SubmitPlan 收到 `McpToolNotFound` |
| s5 无 `mcp` handler + `externalToolExecutor` | `dispatch:mcpArgs → drain:complete → done` | 0 次执行；**不建块、不配对**，答复 `McpSuccess`（handoff 文案） |
| s6 闸门（shell handler 挂住） | `dispatch:shellArgs → handler:shell:enter → dispatch:mcpArgs → tool:SubmitPlan:execute → handler:shell:leave → drain:complete → done` | 帧**不串行**（SubmitPlan 在 shell 未完成时执行）；`hasPendingLocalWork === true`；`done` 只能在 handler 结束后 |

- 判定：16 项契约检查中 **1 项成立 / 15 项被违反**。唯一成立的是"无 `mcp` handler 时 exec 分支把一个非原生调用留给 loop"（方案 B 的使能事实）。线帧实测：s1/s2 里客户端向 server 回的是 `shellResult: success`（带 `stdout`）与 `mcpResult: success`——即**服务端收到的是"兄弟调用成功执行"**。
- 补充实测的**不对称**（对方案 B 关键）：无 handler 时，**原生帧**的块仍是 synthesized 且 `resolved`（loop 永不接管、无本地回退，模型只看到伪造的 `Tool not available`）；而**MCP 帧**的块才是未 resolved、交给 loop。

### 9.7 方案 A：延迟 exec 直到 message_end —— **不可行**

| 判据（任务给定） | 实测/源码证据 | 判定 |
| --- | --- | --- |
| 不得死锁 | `cursor.ts:949-960` 在 `done` 前 drain 所有 exec dispatch；§9.6 s6 复现；上游 `cursor-terminal-error.test.ts:453-521` 真实 http2 断言 | **死锁（自锁死）**：等 message_end 的 handler 就是 message_end 的前置条件 |
| 不得让模型先看到伪失败 | 若改用"先答 `rejected` 再由 loop 执行"，则模型看到 `Tool not available`（§9.6 s4 实测）而工具随后真的执行了 | 伪造失败，违反 |
| 不得破坏 transcript pairing/replay | 执行被推迟则 `done` 之前没有配对结果；`buildSessionContext` 会剥掉未配对调用（`cursor.ts:4143-4168` 注释、`packages/agent/test/agent.test.ts:896-932`） | 破坏 replay，违反 |
| 不得重复 continuation | 服务端 handoff/拒绝文案与本地结果分叉（`cursor-external-tool-handoff.md` 文案要求"end the turn…result in the next request"） | 违反 |

### 9.8 方案 B：全 loop 路由（关 `mcp` bridge + `cursorExternalToolExecutor` + 处理原生帧）—— **非原生半边可测通，原生半边无开关，整体不可行**

按任务给定的 5 点逐项：

1. **能否动态关闭 Cursor `mcp` bridge 并打开 `cursorExternalToolExecutor`，让 SubmitPlan/SubmitGoal 走未 resolved 的 loop 路径？** 机制**存在且实测**（§9.6 s5：不建块、不配对、答复 handoff success；`cursor.ts:1938-1967`）。但**没有受支持的开关**：`cursorExternalToolExecutor` 在本检出中只有 auth-gateway 两个设置点（`server.ts:136,558`），coding-agent/sdk 从不设置；桥接对象是**每会话构造一次**（`sdk.ts:3114`），而"关掉 `mcp`"同时会关掉**所有** MCP 路由能力（xd:// 设备/mounted 工具、`mcp` 审批预检 `cursor.ts:1920-1935`、`session-advisors` 的 advisor 工具桥），功能损失远超 SubmitPlan。这是一项**新的会话级能力**，不是现成开关。
2. **必须同时处理原生 `read/bash/write/grep/ls/delete/…` 帧。** 实测：请求侧**没有**任何字段能让服务端不使用原生工具目录（§9.4：`AgentRunRequest`/`RequestContext` 字段枚举；唯一的工具**集合**字段是 `CustomSubagent.tools`，客户端恒发 `customSubagents: []`）；分发器只看 `execCase`（`cursor.ts:1600-1616`）。**只能永久拒绝**，而拒绝的形状就是 `Tool not available`（§9.6 s4/s7 实测：0 次执行 + 伪造失败 + 块仍 resolved）。
3. **能否在 Plan/Goal 目录中移除/隐藏全部 Cursor 原生工具，用非原生 wire name 的 host/RPC wrapper 提供 PI 的 Read/Glob/Grep/Bash/…？** `customWireName` 在 Cursor 路径**零出现**，改名不改变"服务端仍持有原生目录"这一事实；`buildMcpToolDefinitions` 只按 `tool.name` 排除 `CURSOR_NATIVE_TOOL_NAMES`（`cursor.ts:4640-4699`），host 工具与既有工具同名会在注册期直接失败（`session-tools.ts:1966-1974`）。即：可以给 host 工具取非原生名，但**不能**让服务端不发原生帧——该点失败。
4. **用现有 Cursor fake transport 测试证明 handoff 块未带 `kCursorExecResolved`、由 loop 恰一次执行、continuation/转录不冲突、并验证原生能力可被请求侧显式禁用。** 前三项的上游覆盖是**分裂**的（provider 侧 `cursor-exec-handlers.test.ts:1535-1615`；loop 侧 `agent-loop.test.ts:5519-5612` 用手工标记块），**没有**"no-handler + external 的 MCP 调用交给 loop 并断言恰好一次"的端到端测试（NOT FOUND）；第四项（请求侧禁用原生能力）**不存在**（§9.4）→ 该点失败。
5. **不得假设模型只选 MCP alias；恶意/异常模型发原生帧时保证仍须成立。** 成立的前提只能是"永久拒绝原生帧"，即第 2 点的产品限制；一旦允许原生帧执行，混合批次的兄弟就仍在裁决前执行（§9.6 s1/s2）→ 失败。

补充：即便接受方案 B 的限制配置，patch 层的 sole 批裁决会把"原生帧(已 resolved+伪造失败) + handed-off submit(未 resolved)"整批拒绝，于是 SubmitPlan 不执行、原生调用也不执行（零执行），但**语义与 PI 不同**（PI 给兄弟的是"必须是唯一工具调用"的阻断，而非"工具不可用"），且该会话的 Cursor 原生工具整体报废。

### 9.9 产品限制备选（**只作为限制记录，不解除 R3**）

- (a) Plan/Goal 模式禁用 Cursor 模型（或反之：Cursor 会话禁用 Plan/Goal 目录）——语义清晰，但属产品裁剪。
- (b) 若保留 Cursor + Plan/Goal：让"所有 Cursor 工具报 `Tool not available`"（本次实测的 s4/s7 形状）——这是伪造失败，用户体验与 PI 不同，且使 Cursor 原生工具整体不可用。
- (c) 只支持非 Cursor provider 承担过渡工具。
- (d) 用户显式接受语义差异：只保证 loop 可控路径（第三轮补丁的现状），据此重写验收口径（第三轮 §8.3 已列）。

上述任一项都必须由用户在产品层决策；本文件不把它们算作 R3 解除。

### 9.10 本轮未做/未声称 + 复核入口

- **未改任何生产代码、patch artifact、manifest、测试与子模块**；未开始 T20-B/C/D；不声称阶段完成。
- **未运行**：真实付费/远程模型、真实 Cursor 服务端行为实验（因此 §9.5 的服务端等待只引上游自述）、Windows 行为、`packages/agent` 全量套件。
- 实验的 §9.6 证据依赖"provider 的帧处理实现"（`handleServerMessage`）与真实桥接类，而不是完整 `streamCursor` 传输；后者由上游 `cursor-terminal-error.test.ts` 的 http2 夹具覆盖（本机实跑 11 pass），两者互补。
- 残留/临时资源：实验脚本用 `mkdtempSync` 建场景目录并在 `finally` 中删除（本机核查无 `/tmp/t20-cursor-exec-*` 目录残留）；无子进程残留。固定子模块内为运行实验而补齐的构建载荷（`node_modules`、`packages/natives/native`、`tool-views.generated.js`，硬链接、被上游 `.gitignore` 覆盖）保留以便复核；如需纯净工作树，删除这些路径即可（不影响 gitlink 与任何追踪文件）。
