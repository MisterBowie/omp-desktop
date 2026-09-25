# M5/T20-R3A：OMP 过渡工具契约补丁 —— 可复现 patch set 与能力解除证据

更新时间：2026-09-25。状态：**R3 的 OMP 底层能力阻塞已解除（patch level `d49918f+omp-desktop.1`），T20-B 可以开始；T20-B/C/D 仍未开始、未实现、未声称。** 分支 `codex/m5-omp-transition-hooks`，本轮基线 `ba7806c`（父仓库 `worktree`：`/home/vv/person/code/omp-desktop-m5-r3`）。固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（omp/18.2.7）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`，两者 gitlink 与工作树均未改动。

本轮不实现任何桌面 Plan/Goal UI、模式状态或审批闭环，只做实「OMP 底层能力 + 可重复应用的补丁入口」，供 M6/T21 打包与 T20-B 消费。

---

## 1. 阻塞与解决方式

T20-A（`docs/validation/M5-plan-goal-capability-gates.md` §4.2/§8）用无费用 spike 证明：固定 OMP 18.2.7 上无法实现 PI 的过渡工具契约（R3 硬阻塞），根因是上游能力缺口——RPC host tool 定义没有调度/批次声明（`RpcHostToolAdapter.concurrency` 硬编码 `"shared"`）、`AgentToolResult`/`AfterToolCallResult` 没有 `terminate`、唯一"优雅终止"路径只认内置 `yield` 工具名。当时给出的解除条件之一就是"上游能力"。

本轮采用**可维护的 patch level**解除它：运行时源码仍固定在 `d49918f`，本项目在该固定提交之上维护编号补丁集，并把它做成可重复、可验证、可清理的构建入口（ADR 0305）。**这不是官方 OMP 18.2.7 原生支持**：能力标识、patch SHA-256、base SHA 与版本都记在 manifest 里，文档与打包都必须带上 patch level。

## 2. 上游最新 main 仍是缺口（不是版本号猜测）

只读稀疏克隆 `/tmp/omp-latest-ea8b542` @ `ea8b54247afb85fa10ba784b35b54f90d7b28c7f`（`packages/agent/src`、`packages/coding-agent/src/modes/rpc`、`packages/coding-agent/src/session`、`packages/coding-agent/test`、`packages/agent/test`、`docs` 稀疏面）实测：

| 检查 | 结果 |
| --- | --- |
| `packages/agent/src/types.ts` 是否含 `terminate` | **无**（`grep -n "concurrency\|terminate"` 只命中 `concurrency` 的文档注释与 `AgentTool.concurrency` 联合类型） |
| `RpcHostToolDefinition` 字段 | `name/label?/description/parameters/hidden?/loadMode?/readsSkillUris?`——**无** `concurrency`、**无**批次策略 |
| `packages/coding-agent/src/modes/rpc/host-tools.ts` | `concurrency: "shared" | "exclusive" = "shared"` 仍**硬编码** |

结论：能力缺口在最新 main 上依然存在，补丁不是"回移已上游修复的功能"，而是本项目自持的 patch level。

## 3. 补丁内容与契约映射（A-E）

`app/patches/oh-my-pi/0001-rpc-host-tool-transition-contract.patch`（10 文件，907 insertions / 30 deletions；`sha256 4351025dbb8bf7b6a7b58dacfcabc8b61f86710d19c0f1219483ffe25aea2b24`，52556 字节）：

| 文件 | 改动 |
| --- | --- |
| `packages/agent/src/types.ts` | `AgentTool.batchPolicy?: "any" \| "sole"`；`AgentToolResult.terminate?: boolean`；`AfterToolCallResult.terminate?: boolean`（含语义文档注释） |
| `packages/agent/src/agent-loop.ts` | 批次准入（纯函数 `soleBatchRejectionReason`）、阻断路径不产生 `tool_execution_start`、`terminate` 规范化与合并、批次结算后终止 run、partial 永不带 `terminate` |
| `packages/agent/src/telemetry.ts` | `recordSkippedTool` 状态联合加入 `"blocked"`（run collector 本就统计该状态） |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | `RpcHostToolDefinition.concurrency`/`batchPolicy` 声明与语义文档；`RpcHostToolResult.result`/`isError` 的 terminate 契约 |
| `packages/coding-agent/src/modes/rpc/host-tools.ts` | `normalizeHostToolPolicy`（唯一校验实现）、adapter 应用声明、`setTools` 先建后提交（拒绝不留半注册）、`handleResult` 保留 `terminate` 并组合错误位 |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | `set_host_tools` 归一化调用 `normalizeHostToolPolicy`（非法值整请求拒绝） |
| `packages/coding-agent/src/modes/rpc/rpc-client.ts` | SDK 侧 host 工具定义透传两个新字段 |
| `docs/rpc.md` | 运行时自带文档同步（字段、批次语义、终止语义、partial 不终止） |
| `packages/agent/test/agent-loop.test.ts` | 12 项新测试（见 §4） |
| `packages/coding-agent/test/rpc-host-tools.test.ts` | 4 项新测试（见 §4） |

契约要求逐条落地：

- **A（并发声明）**：`concurrency?: "shared" | "exclusive"`，省略 → `"shared"`（既有行为不变）；非法值在可信边界 fail closed——`set_host_tools` 整请求报错，**绝不静默变 shared**。校验只有一份实现（`normalizeHostToolPolicy`），命令路径与 adapter 路径都调用它，`RpcHostToolBridge.setTools` 先构建 adapter 再提交定义表，被拒绝的声明不会留下半注册状态。
- **B（批次唯一策略）**：`batchPolicy: "sole"`（通用命名，与桌面产品/工具名无关）。批次含该工具且调用数 ≠ 1 时**整批拒绝**：不调度、不执行、**零 `tool_execution_start`**、零 `host_tool_call`、零副作用；每个调用（含未知工具名与非法参数兄弟）都得到同一句 reason 的 blocked 错误结果，**按调用顺序**产出，保证 provider 的 tool_use/tool_result 配对完整。准入判定发生在 `beforeToolCall` 之前（PI 的顺序）：被拒批次不会触发审批/扩展钩子，因此不会为一个永不执行的调用弹卡。
- **C（终止）**：`AgentToolResult.terminate` 与 `afterToolCall` override 都可携带；批次结算后只要最终结果要求 terminate，run 在**下一次 provider 请求之前**结束，成功与错误结果同样适用，普通结果行为不变。终止**不是 abort**：`stopReason` 不被改写为 `aborted`，`onTurnEnd` 收到 `willContinue:false` 且 `signal.aborted === false`；队列中的 steering 保留给下一次 run（与外部中断一致）。
- **D（RPC 透传）**：`host_tool_result.result.terminate` 原样进入 agent loop。组合行为明确：`isError = frame.isError || result.isError`；frame 顶层 `isError` 且 result 要求 terminate 时**解析**为 `{isError:true, terminate:true}`（抛错无法携带该标志），否则维持既有"拒绝并抛出文本"契约。流式 `host_tool_update` 的 partial 永不终止：bridge 原样转发，loop 在归一化时剥离 `terminate`，只有结算结果参与终止判定。
- **E（不回归）**：既有 OMP 工具并发（shared/exclusive/函数式）、steering（含批内软信号）、synthetic/skip 结果、provider replay、host cancel（按 `targetId`）路径均未改动；`concurrency` 默认与既有硬编码值一致。

## 4. 交付物

| 位置 | 内容 |
| --- | --- |
| `app/patches/oh-my-pi/0001-rpc-host-tool-transition-contract.patch` | 补丁本体（可用 `git apply --check` 在固定子模块干净副本上通过） |
| `app/patches/oh-my-pi/manifest.json` | base SHA、期望版本、patch SHA-256/字节数、能力标识、契约字段、验证入口 |
| `app/scripts/omp-patch.mjs` | 唯一应用入口：manifest/checksum/base 校验 → 安全 scratch → 应用 → 可选 `--prepare-build` → 可选 `--verify` → finally 清理 |
| `app/apps/desktop/test/omp-patch.test.mjs` | 12 项脚本正向/负向测试（错误 SHA、版本不符、checksum、应用失败、已有目录、符号链接、越界目标、patch 路径逃逸、参数组合、凭据不外泄、payload 符号链接相对性） |
| `app/experiments/omp-bridge/t20-feasibility.mjs` | 双轨 spike：默认未补丁（`results/t20-feasibility.json`），`--patched` 走补丁 scratch（`results/t20-feasibility-patched.json`） |
| `app/docs/adr/0305-pinned-runtime-patch-set.md`、`app/docs/spec/03-runtime/02-agent-runtime.md` §15 | 决策与运行时契约（英文） |

新增 OMP 测试（补丁内）：

- `packages/agent/test/agent-loop.test.ts`（+12）：sole 工具单独调用可执行；`[sideEffect, sole]`、`[sole, sideEffect]`、`[sole, sole]`、`[unknown, sole]`、`[invalidArgs, sole]` 五种批次**整批零执行 + 零 `tool_execution_start` + 顺序稳定 + 全 blocked**；被拒批次不触发 pre-dispatch 钩子而单独调用会触发；默认 shared 与显式 exclusive 调度；成功 terminate 无下一次 provider 请求且非 aborted；错误 terminate 同样；普通结果继续；`afterToolCall` 可请求也可撤销 terminate；流式 partial 的 terminate 被忽略。
- `packages/coding-agent/test/rpc-host-tools.test.ts`（+4）：声明映射到 adapter（省略 → `shared`/`any`）；非法声明抛错且不留半注册；terminate 透传 + 三层错误组合（成功/`result.isError`/顶层 `isError`/无 terminate 的既有拒绝路径）；update 帧不结算调用、迟到 update 被忽略。
- RpcClient 侧新增"自定义工具的调度与批次声明跨线上帧"测试（SDK 定义 → 服务器收到）。

## 5. 证据（命令与结果）

环境：`source /home/vv/.nvm/nvm.sh` 后使用 Node v24.14.0；`PATH` 含 `~/.bun/bin`（Bun 1.4.2）。全部使用 fake provider/本地夹具，**未调用任何付费或远程模型**。

| 命令（工作目录） | 结果 |
| --- | --- |
| `node t20-feasibility.mjs`（`app/experiments/omp-bridge/`） | **38/46，失败恰为 8 项 R3 契约**（R3-1×2、R3-2、R3-3、R3-3b、R3-4×2、R3-5）；`results/t20-feasibility.json` 刷新为本次未补丁基线 |
| `node t20-feasibility.mjs --patched` | **46/46 PASS**（8 项 R3 全绿：同批兄弟零副作用、零 host call/零 execution start、重复提交零执行、成功/失败提交后 0 次后续 provider 请求）；`results/t20-feasibility-patched.json`（与未补丁基线文件分开） |
| `node scripts/omp-patch.mjs --check`（`app/`） | `OMP-PATCH-OK d49918f+omp-desktop.1`；base/version/checksum 校验通过；固定提交 tracked 文件 7518 个；scratch 已清理 |
| `node scripts/omp-patch.mjs --apply --out <dir> --prepare-build --verify`（`app/`） | 9.6 秒完成；launcher 报 `18.2.7`，树内 `bun test packages/agent/test/agent-loop.test.ts packages/coding-agent/test/rpc-host-tools.test.ts` 通过；payload=toplevel `node_modules` + `packages/natives/native` + `tool-views.generated.js` |
| `node --test apps/desktop/test/omp-patch.test.mjs`（`app/`） | **12 通过 / 0 失败** |
| `bun test packages/agent/test/agent-loop.test.ts packages/coding-agent/test/rpc-host-tools.test.ts packages/coding-agent/test/rpc-input-frame.test.ts`（补丁树 `/tmp/omp-verify-tree`） | **164 通过 / 0 失败**（139 + 10 + 15） |
| `bun test`（补丁树 `packages/agent/`，全量） | **未跑完（不计入证据）**：运行 6 分钟后卡在既有夹具 `packages/coding-agent/test/fixtures/delayed-tool-mcp.ts` 的子进程上，已中止并显式终止该夹具进程组。本补丁未触碰该夹具，但**不声称该全量套件通过**；跨包全量运行需要夹具子进程回收（见 §7）。早前在等价开发树（同样打过本补丁、仅 scratch 布局不同）跑同一条命令曾在 11.6 秒内完成 637/637，但**该次观测不作为本阶段任何配置的通过证据** |
| `bun run check:types`（补丁树 `packages/agent/`） | 0 错误 |
| `bun run check:types`（补丁树 `packages/coding-agent/`） | 仅 `test/judgment-chain.test.ts(296,52)` 的 `fetch/preconnect` 预存在错误；**在未改动的固定检出上逐字复现**，与补丁无关 |
| `bun run lint`（agent）与 `bunx oxlint src/modes/rpc test/rpc-host-tools.test.ts`（coding-agent） | 0 问题 |
| `bunx oxfmt --check`（补丁树 9 个改动文件） | 全部符合格式 |
| `node --test apps/desktop/test/{plan-drain-engine-gate,omp-session-configure,engine-router,plan-artifact-contract,plan-mode-source-contract}.test.mjs`（`app/`） | **37 通过 / 0 失败**（T20 定向基线计数一致；需先备好 app 依赖与 workspace `dist`） |
| `node scripts/check-t20-matrix-ids.mjs`（`app/`） | `MATRIX-ID-OK: B1-B14, C1-C8, D1-D3 each appear exactly once`，退出 0 |
| `node scripts/check-omp-plan-goal-gaps.mjs`（`app/`） | SKIP，退出 0（opt-in 未启用） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs`（`app/`） | **3 个缺口仍开放（g1/g2/g3，归属 T20-B/C），退出 1**——本轮只解除 OMP 底层能力，产品侧缺口诊断保持红灯，未静态假绿 |
| `biome lint`（`app/`，配置面 75 文件） | 0 问题；新增的 `scripts/omp-patch.mjs`、`apps/desktop/test/omp-patch.test.mjs`、`experiments/**` **不在 `biome.json` 的 `files.includes` 面内**（与既有 `check-*`/实验脚本同），改以 `node --check` 兜底 |
| `node --check`（3 个改动的 `.mjs`） | 全部通过 |
| `git diff --check`（根） | 0 |

### 5.1 OMP 未补丁基线回归（同一环境，固定子模块）

| 命令（`upstream/oh-my-pi/`） | 结果 |
| --- | --- |
| `bun test packages/agent/test/agent-loop.test.ts`（补丁前基线检出） | 126 通过 / 0 失败（补丁后为 139） |
| `bun test packages/coding-agent/test/rpc-host-tools.test.ts` | 5 通过 / 0 失败（补丁后为 10） |

### 5.2 R2 字节数的 1 字节漂移（如实记录）

本次未补丁 spike 的 R2 记录为 `prefixBytes=14431/14431/14435`、`systemBytes=14607/16157/16591`，而 T20-A 文档记录为 `14432/14432/14436`、`14608/16158/16592`。原因已定位并实测：系统提示里包含**当前 worktree 的 `AGENTS.md` 绝对路径**（`keep in sync: /home/vv/person/code/omp-desktop-m5-**t20**/AGENTS.md` → 本轮为 `...-m5-**r3**`，恰好短 1 字节），与本补丁无关。对照实验：本轮在**同一 worktree** 内分别以"带 `batchPolicy`/`concurrency` 声明的 host tool 定义"和"不带"运行 R4-4，三次 prompt 的 system 文本**逐字节相同**（16591 字节），证明新字段不进入模型提示词。

## 6. 脚本安全性与踩坑记录

- **目标目录**：`--out` 必须不存在或为空目录；拒绝符号链接、拒绝源码检出内部、拒绝仓库根/应用根/cwd 自身与其祖先、"不得包含"被保护路径；`--check` 不产生任何输出目录。
- **异常清理**：任何失败路径（校验、复制、`git apply --check`、应用、构建准备、验证）都在 `finally` 语义下删除本次创建的 scratch；脚本自带测试用独立 `TMPDIR` 断言"零残留"。
- **符号链接必须逐字复制（实测踩坑）**：`fs.cpSync` 默认会把符号链接**改写为指向源检出的绝对路径**，于是 `node_modules/@oh-my-pi/*` 会解析回**未补丁**的 workspace——树"看起来打了补丁实际跑旧代码"。修复为 `verbatimSymlinks: true`，并新增回归测试（payload 复制后 `node_modules/@fixture/example` 仍是相对链接）。该 bug 是被 §5 的双轨计数抓出来的：首次 `--patched` 仍是 38/46。
- **不打印凭据**：脚本只打印路径、哈希、命令名；测试用 `MY_API_KEY=canary-...` 断言 stdout/stderr 不含该值。验证子进程使用隔离 `HOME`/配置目录并剥离凭据类环境变量。

## 7. 未做/未声称

- **T20-B/C/D 未开始**：桌面 Plan/Goal UI、模式状态、审批闭环、权限模式传播、`planSafeActions` 仍未实现；`OMP_T20_GAP_PROBE` 的 g1/g2/g3 仍为 `GAP-OPEN`。
- **不声称上游支持**：patch level 为 `d49918f+omp-desktop.1`（OMP Desktop 维护），运行时仍报 `omp/18.2.7`；任何"18.2.7 原生支持这些字段"的说法都是错误的。
- **未改子模块**：两个 gitlink 与工作树 SHA 未变；补丁只存在于父仓库文件与临时 scratch 中。
- **未打包**：M6/T21 才会用 `--apply --out <dir> --prepare-build` 产出内置运行时；本阶段只做实入口。
- **全量套件夹具挂起（非补丁结论）**：在补丁树的 `packages/agent` 目录内跑 `bun test`（全量）会卡在既有夹具 `packages/coding-agent/test/fixtures/delayed-tool-mcp.ts` 的子进程上（该文件与本次补丁无关，补丁只改 agent 包源码与 coding-agent 的 RPC host-tool 映射）。本轮以**改动面套件**（`agent-loop.test.ts` 139 + `rpc-host-tools.test.ts` 10 + `rpc-input-frame.test.ts` 15 = 164 项）、agent 包 typecheck/lint/format 与父仓库定向套件作为通过证据；**未声称** agent 包全量套件通过。补丁树运行结束后已显式终止该夹具进程组，无残留进程。
- 本阶段 spike 未覆盖：真实付费模型、macOS/Windows 平台行为、T20-B 的模式持久化/提示词/审批链路。

## 8. 下一轮入口

**M5/T20-B（Plan/Goal 模式状态机、提示词、目录、提交/审批/派发闭环）可以开始**：R3 的解除条件是三条同时满足——(1) patched spike 46/46；(2) OMP 定向/相关单测在补丁树上全绿；(3) 应用脚本 `--check`/`--apply --prepare-build --verify` 与父仓库负向测试通过。三条均已满足（§5）。T20-B 必须继续使用 patch level 而非直接改子模块，并在 B 系列验收里覆盖同批阻断与终止的真实产品行为。
