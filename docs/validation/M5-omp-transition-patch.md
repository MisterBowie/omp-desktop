# M5/T20-R3A：OMP 过渡工具契约补丁 —— 风险收敛补丁与 R3 仍阻塞的复审结论

更新时间：2026-09-25。状态：**R3 仍为硬阻塞（独立复审 F3 确认），T20-B 不得开始。** 本轮（复审返修轮）撤回了上一提交中"R3 已解除 / T20-B 可以开始"的结论，并把已完成的补丁收敛为**风险收敛**（loop 可控路径），而不是 PI 兼容性声明。分支 `codex/m5-omp-transition-hooks`；返修基线 `a78cec6df4572031365e8ea6a4237ca8db04ab20`；本文件描述返修后的最终状态。固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（omp/18.2.7）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`，gitlink 与工作树均未改动。

**第二轮独立复审返修（F6-F9，基线 `474408de2b2bdb538f5b2249d71398b8537e1fed`）**：只修本阶段脚本与证据，补丁 artifact 与 manifest 未改动（`sha256 e08ca7ff…fd8`、72978 字节，与 manifest 一致，见 §5）。R3 仍是硬阻塞、T20-B 仍不得开始；脚本测试面从 17 项增至 **24 项**（§6.1）。

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
| `node --test apps/desktop/test/omp-patch.test.mjs`（`app/`，F6-F9 返修后） | **24 通过 / 0 失败 / 0 跳过**（连跑 3 次结果一致） |
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

- **F1/F6 目标目录 canonical 化（含 macOS 系统别名）**：`--out` 的最近存在父目录逐组件 canonicalize（`canonicalizeAncestor` + `isTrustedRootAlias`）。只有**文件系统根直属、属主为 root** 的符号链接被跟随（macOS `/var`、`/tmp`、`/etc` → `/private/…`，usrmerge Linux `/bin`、`/lib`、`/sbin`）：这类条目非 root 无法创建/替换/删除，属于平台自身的别名，拒绝它们会让 macOS 上任何 `--out /tmp/…`（含 `tmpdir()` = `/var/folders/…`）失败。其余任何深度、任何属主的符号链接仍在创建/复制/删除前拒绝（例：`/tmp/link -> /protected` 时 `--out /tmp/link/new-tree` 被拒，`/protected` 未被写入也未被删除）。拒绝后仍对 canonical 目标做保护路径、自身符号链接、非空目录检查，创建/复制/失败清理全部使用 canonical 路径，`tree` 报告 canonical 路径。回归测试：策略单测（synthetic stats 的 macOS/Linux 形状）+ 遍历单测（伪造根下跟随别名、深层链接仍拒）+ 真实根别名用例（对本机 `/bin`、`/lib` 断言 canonical 目标，并对 `tmpdir()` 断言 canonicalize 而非拒绝）。**macOS 真实 24/24 需本机复审确认**（见 §7）。
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

## 7. 未做/未声称

- **R3 仍阻塞**：不得开始 T20-B/C/D；产品侧 gap 诊断保持 3 缺口 exit 1。
- **不声称上游支持**：patch level 仍是本项目维护的 `d49918f+omp-desktop.1`，运行时仍报 `omp/18.2.7`。
- **未跑完的套件不得声称通过**：补丁树内 `packages/agent` 全量 `bun test` 曾卡在既有夹具 `delayed-tool-mcp.ts`（本轮已实现并验证进程组回收通道，但未重跑该全量套件）；通过证据只来自改动面套件、typecheck 与父仓库定向套件。
- **macOS 端到端验收未在本机完成**：F6 的最终验收是"本机 macOS 上同一 suite 全过（含 6 个此前因 `/var → /private/var` 失败的用例）"，本机 Linux 只能提供策略/遍历单测、真实根别名用例、旧策略探针对照与 CLI 冒烟（§5、§6）；**需复审在本机 macOS 复跑确认**。行为差异须注意：macOS 上 `--out /tmp/…` 的 `tree` 报告 canonical `/private/tmp/…`（同一目录）。
- **未测的异常分支（不得声称已测）**：`child.on("error")` 在"子进程已存在且 pid 有效"时整组杀灭属防御性分支——本脚本可达的 spawn 错误形状没有 pid；已测的只有 ENOENT/EACCES 的立即结算与定时器清理，以及退化 pid 的守卫单测。
- **补丁本体未改动**：因此按约定未重跑补丁内 171 项测试，只复核 `sha256`/字节数与 `manifest.json` 一致（§5）。
- 未覆盖：真实付费模型、Windows 平台行为、T20-B 的模式/审批链路。

## 8. 解除 R3 的可能路径（供后续决策，不构成本轮承诺）

1. 上游或补丁让"过渡工具批次"不再走会预执行的通道：Cursor exec channel 不在会话内预执行、工具投机对这类会话关闭（本补丁已做后者）；
2. 产品层显式决策：声明 sole 工具的会话禁用 Cursor exec 通道（需要 provider/bridge 侧开关，非 loop 能决定）；
3. 用户明确接受语义差异：只保证 loop 可控路径（当前补丁的状态），并据此重写验收口径。
