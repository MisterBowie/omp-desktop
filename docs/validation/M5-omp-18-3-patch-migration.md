# M5/T20-R4A：过渡契约补丁迁移到 OMP 18.3.0 基线

更新时间：2026-09-27。分支 `codex/m5-r4-omp18-patch`，基线 `5714c22a06d5548741f6311a619028be84bcc4a7`。

状态：**R4A 完成（补丁基线迁移）；R4B（bundled sidecar）尚未开始。** 本轮把现有 `0001-rpc-host-tool-transition-contract.patch` 从 can1357/oh-my-pi `omp/18.2.7` 迁移到 `omp/18.3.0`：`upstream/oh-my-pi` gitlink 升到 `62bc57be1b03ef0802a33cf7f5f530e534527531`（`refs/tags/v18.3.0`），patch level `62bc57b+omp-desktop.2`，`OMP_RUNTIME_VERSION` 与运行期 mock/夹具同步为 `18.3.0`。**R3 仍为硬阻塞；ADR 0306 的 Cursor 产品门保留；T20-B/C/D 未开始、T20 未完成、未声称。** 非目标（明确不做）：bundled sidecar 构建/启动闭环（R4B）、创建 GitHub 仓库、改 `.gitmodules`、Plan/Goal UI/运行时、解除 R3、放宽 Cursor 门、向 `can1357` 推送。

---

## 0. 结论摘要

1. **补丁是「重切」而不是「重写」**：新旧 artifact 的 added/removed 行多重集**完全相同**（逐行 `Counter` 比较），唯一差异是 1 行上下文——`packages/agent/src/agent-loop.ts` 的注释在 18.3.0 为 `// … sitting out a \`wait\`.`（18.2.7 为 `hub wait`）。这正是 R3D 审计 §8 预测的唯一锚点，也是逐文件 `git apply --check` 观察到的唯一冲突。40 个 hunk 在 18.3.0 上全部应用（带行号偏移），**没有任何 hunk 命中「能力已进上游」**。
2. **五类能力全部保留**：全量 `toolCall` 批次计数、`batchPolicy: "sole"` 整批拒绝、sole 会话的投机门、`terminate` 非 abort、host-tool RPC `concurrency`/`batchPolicy` 与 `result.terminate` 严格校验。本轮**没有**把 OMP 的 `TERMINAL_TOOL_RESULT_ABORT_REASON` 当作 `terminate`——它仍是 abort 语义（signal 置位、`stopReason` 走 aborted 分支），补丁的 `terminate` 是结算后正常结束。
3. **RED/GREEN 在真实固定 18.3.0 上成立**：未打补丁时新增契约测试判红（仅打测试 hunk：**137 pass / 13 fail**，另一测试文件因缺导出整文件报错；spike **38/46**、`ok:false`、exit 1），打补丁后判绿（三套件 **177 pass / 0 fail**；spike **46/46**、`ok:true`、exit 0）。
4. **基线与运行时一致性由机器校验**：`node scripts/omp-patch.mjs --check --json` exit 0（base `62bc57be…`、patch level `62bc57b+omp-desktop.2`、7673 追踪文件）；`--apply --prepare-build --verify` exit 0（launcher 报 **18.3.0**、两个 manifest 套件 **162 pass / 0 fail**）。manifest 与 submodule 不一致（含 patch 字节数、patch level 前缀）时 `--check` 直接失败。
5. **R3 未因升级而动摇**：R3B 的 provider-gate 实验在 18.3.0 上重跑，**严格 R3 契约检查 0/12 成立（12 项全部违反）**、候选方案检查 1/3（不计入退出码），与 18.2.7 上的结论一致。

---

## 1. 证据源与完整性核验

| 来源 | 固定坐标 | 本机获取与核验 |
| --- | --- | --- |
| PI Desktop | `0111e306c120ad5820688d7608cb37bad8fbcc1f` | 本轮按仓库固定 gitlink **初始化子模块**（`upstream/pi-desktop`）：`rev-parse HEAD` 一致、工作树干净；行号另与 R3D 审计 clone `/tmp/t20r3d/pi-desktop-0111e30` 交叉核对 |
| 当前 OMP（子模块，本轮**升级后**） | `62bc57be1b03ef0802a33cf7f5f530e534527531`（`refs/tags/v18.3.0`） | `git -C upstream/oh-my-pi rev-parse HEAD` 一致、`git status --porcelain` 空；`packages/utils/package.json` = `18.3.0`；`git ls-tree -r` 7673 项（与 R3D 审计的逐 blob 校验结果、本轮 `--check` 的 `files: 7673` 相符） |
| OMP 18.3.0（迁移工作树） | 同上 | `git clone --depth 1 --branch v18.3.0`（经 `127.0.0.1:7897`）到 `/tmp/t20r4a/omp-18.3.0`；`rev-parse HEAD` = 该 SHA；其 `packages/agent/src/agent-loop.ts` 与 R3D 的逐 blob 校验树 `/tmp/t20r3d/can1357-18.3.0` **逐字节相同**（`cmp` 退出 0） |
| 迁移前 OMP | `d49918fab2dba3986927f2d46721629ed0f3a02c`（omp/18.2.7） | 旧 artifact 及其 sha/字节数在 git 历史与 `manifest.history` 中追加保留，不改写 |

网络事实（如实记录）：任务给出的 `http://127.0.0.1:7890` 代理**未监听**；本轮实际可用的是 `127.0.0.1:7897`（与 R3D 审计一致）。子模块与 18.3.0 clone 经该代理获取；`git apply` 与全部测试本地执行，**未调用任何模型**（无费用）。

---

## 2. 迁移前先核对 PI Desktop 固定源码与测试（每个契约）

证据全部来自固定检出 `upstream/pi-desktop@0111e30`，路径为 `packages/agent-runtime/src/runtime.ts` 与 `runtime.test.ts`：

| 契约 | PI 源码 | PI 测试（测试名；行号） |
| --- | --- | --- |
| 批次判据 = assistant message 的**全部** `toolCall` 块（无排除）；含过渡工具的混合批次**整批 block** | `runtime.ts:2219-2234`：`content.filter(block => block.type === "toolCall")`，`transitionInBatch && toolCalls.length !== 1` → `{block:true, reason:"… must be the only tool call in the assistant message."}` | `runtime.test.ts:2138` `guards transition batches and terminates after durable plan submission`（`mixedBatch` = `EnterPlanMode` + `Read` → `toMatchObject({block:true})`） |
| 模式校验：submit 工具必须匹配当前契约模式 | `runtime.ts:2235-2249` | `runtime.test.ts:2287` `blocks a submit tool that does not belong to the active contract mode`（Goal 模式下 `SubmitPlan` → `reason: "SubmitPlan is available only in Plan mode."`） |
| 提交工具的 provider 形态（`title/markdown/question`，`executionMode:"sequential"`） | `runtime.ts:5040-5080`（`buildSubmitTool`） | `runtime.test.ts:2043` `switches one pi Agent between Agent and Plan tool sets`、`:2100` `gives Goal mode the read-only core plus only SubmitGoal` |
| 成功提交 → `terminate: true` | `runtime.ts:5163-5171` | `runtime.test.ts:2193-2208`（`submitResult.terminate === true`）；Goal 同构 `:2221` `routes the Goal contract through the same host approval with kind goal` |
| host 调用抛错 → `terminate: true`；proposal 非法 → `terminate: true` | `runtime.ts:5106-5120`、`5125-5143` | **未找到**：现有测试只断言成功分支的 `terminate`，未覆盖这两条错误分支的 `terminate === true` |
| 非法参数**不** terminate | `runtime.ts:5081-5092`：返回 `isError: true, details.errorCode = "PLAN_INVALID_ARGUMENT"`，**无 `terminate`** | **未找到**：`runtime.test.ts` 中 `PLAN_INVALID_ARGUMENT` 与 `requires non-empty` 均 0 命中——PI 没有「非法参数不终止」的断言 |

结论：PI 侧「整批 block」「模式校验」「提交后 terminate（Plan 与 Goal）」都有直接源码与测试依据；**「非法参数不 terminate」只有源码依据、没有 PI 测试**（如实标注，不猜）。补丁在 OMP 侧为该分支补了行为测试（见 §5）。

---

## 3. 迁移前的 OMP 18.3.0 固定依据

| 事实 | 证据 |
| --- | --- |
| 18.3.0 **没有**这些能力（故没有任何 hunk 可「因上游已有」而丢弃） | 18.3.0 全树 `batchPolicy` / `soleBatchRejectionReason` / `AgentToolResult.terminate` / `RpcHostToolDefinition.concurrency` 命中 **0**；`git apply --numstat` 显示新旧 artifact 的逐文件增删行数完全一致 |
| 唯一锚点差异 | `packages/agent/src/agent-loop.ts`：18.2.7 `// … sitting out a \`hub wait\`.`（`/tmp/t20r3d/omp-18.2.7` 行 3033）对 18.3.0 `// … sitting out a \`wait\`.`（`upstream/oh-my-pi` 行 3075）——该行是 `@@ -3028,6 +3131,56 @@` hunk 的尾部上下文 |
| 版本/运行时 | `packages/utils/package.json` = `18.3.0`（`--check` 与 manifest 的 `base.version` 机器校验）；18.3.0 追踪文件 7673 |
| `terminate` 与上游 abort 的边界 | 18.3.0 的 `TERMINAL_TOOL_RESULT_ABORT_REASON` 是 **abort** 语义（置位 signal、`stopReason` 走 aborted 分支）；本补丁**不**复用，`terminate` 是结算后正常结束（不改写 `stopReason`、`signal.aborted === false`、steering 保留） |
| Cursor 预执行仍使严格契约不可满足 | 与 R3D 审计 §7.3 一致；本轮 §5.5 在 18.3.0 上重跑 provider-gate 实验再次确认（0/12 成立） |

---

## 4. 迁移实现

### 4.1 patch artifact

| 项 | 迁移前（18.2.7） | 迁移后（18.3.0） |
| --- | --- | --- |
| patch level | `d49918f+omp-desktop.1` | `62bc57b+omp-desktop.2` |
| base SHA / version | `d49918fab…` / `18.2.7` | `62bc57be…` / `18.3.0` |
| sha256 | `e08ca7fff29bbd03e298f4488888b2692adda1486e3fff80536a31dd8af6fd5c` | `4edbfadff9cc3238ae6bb7c206e7d8e0be33c2190068e6731fdb58e43ec9b545` |
| bytes | 72978 | 72910 |
| 文件 / hunk / 逐文件增删 | 10 / 40（见 manifest 历史） | 10 / 40，逐文件增删行数不变（`docs/rpc.md 42/0`、`agent-loop.ts 188/24`、`telemetry.ts 1/1`、`types.ts 30/0`、`agent-loop.test.ts 635/1`、`host-tools.ts 85/5`、`rpc-client.ts 2/0`、`rpc-mode.ts 9/2`、`rpc-types.ts 29/0`、`rpc-host-tools.test.ts 329/1`） |

生成方式：把旧 artifact 的那 1 行上下文改成 18.3.0 的文本，`git apply -p1` 到 18.3.0 检出，再 `git -C <checkout> diff` 重切。往返校验：重切产物再次 `git apply` 后 `git diff` 逐字节等于该产物。

### 4.2 manifest

`app/patches/oh-my-pi/manifest.json`：更新 base version/SHA、patch level、patch sha256/bytes、`files`（仍 10 个，与 artifact 的 `diff --git` 集合一致）与 `notes`；新增 **append-only `history`**，登记已退役的 `d49918f+omp-desktop.1`（base、sha256/bytes、退役日期与原因）。旧基线历史只追加、不改写。

### 4.3 应用/校验脚本

`app/scripts/omp-patch.mjs` 新增两项严格校验（本轮唯一的脚本行为变化）：

- `manifest.patch.bytes` 必填、正整数，且必须等于 artifact 实际字节数；
- `manifest.patchLevel` 必须匹配 `<base-short-sha>+<marker>`，且 7 位前缀**必须等于 `base.sha` 前 7 位**。

其余不变：base SHA 对照 source `HEAD`、版本取 `packages/utils/package.json`、checksum、`git apply --check --reverse` 证明补丁完全应用、scratch 清理与路径围栏。

### 4.4 运行时版本与夹具同步

| 位置 | 变化 |
| --- | --- |
| `app/packages/shared/src/engine.ts` | `OMP_RUNTIME_VERSION = "18.3.0"` |
| `app/packages/shared/src/engine.test.ts` | 3 处断言/夹具 |
| `app/packages/omp-runtime/src/launcher.test.ts` / `test-harness.ts` / `test/mock-omp.mjs` | 6 + 1 + 1 处（`MOCK_VERSION`、mock launcher 的 `omp/…`） |
| `app/packages/omp-runtime/src/session/host-tools.ts` / `subagent-frames.ts` | 注释中的 pinned 版本 |
| `app/apps/desktop/test/*.test.mjs` | 16 个文件的 mock runtime 版本与 `expectedRuntimeVersion`（33 处） |
| `app/experiments/omp-bridge/t20-feasibility.mjs` / `t20-cursor-exec-order.mjs` / `extensions/t20-spike-gate.ts` | 注释中的 pinned 版本；R3B 实验的 `PINNED_OMP_SHA` 改为新固定 SHA（仍可用 `--expected-sha`/`--omp` 覆盖） |

**故意不改**（历史事实）：`app/docs/adr/0300-*.md`、`0304-*.md` 中记述当时检出的事实性文字；`app/experiments/omp-bridge/results/e01-protocol.json` 与 `fixtures/e01-handshake.json`（M1 在 18.2.7 上的已记录 run）。`results/t20-feasibility*.json` 与 `results/t20-cursor-exec-order.json` 因本轮重跑刷新为 18.3.0 记录，旧记录保留在 git 历史。

---

## 5. RED / GREEN 证据（全部实跑）

环境：Node v24.14.0（nvm 24）、Bun 1.4.2、Git 2.43.0、Python 3.12。OMP 检出 = `upstream/oh-my-pi @ 62bc57be`。运行 OMP 套件前按仓库约定在该 worktree 单独 `bun install --frozen-lockfile`（1.73s，缓存命中；postinstall 生成 `tool-views.generated.js`），并把官方预编译 `@oh-my-pi/pi-natives-linux-x64@18.3.0` 的 `pi_natives.linux-x64-{baseline,modern}.node` 放入 `packages/natives/native/`（**未**改任何受版本控制的文件；事后 `git status --porcelain` 仍为空）。全程未调用付费/远程模型。

### 5.1 未打补丁 18.3.0 的原状基线

| 命令（`upstream/oh-my-pi/`） | 结果 |
| --- | --- |
| `bun test packages/agent/test/agent-loop.test.ts packages/coding-agent/test/rpc-host-tools.test.ts packages/coding-agent/test/rpc-input-frame.test.ts`（未打补丁） | exit 0，**152 pass / 0 fail**（新增契约测试尚不存在，故全绿） |

### 5.2 RED：只打测试 hunk 的 18.3.0

把 artifact 中两个测试文件（`packages/agent/test/agent-loop.test.ts`、`packages/coding-agent/test/rpc-host-tools.test.ts`）的部分 `git apply` 到**未打补丁**的 18.3.0：

| 命令 | 结果 |
| --- | --- |
| `bun test packages/agent/test/agent-loop.test.ts packages/coding-agent/test/rpc-host-tools.test.ts` | **exit 1**：`Ran 150 tests across 2 files` → **137 pass / 13 fail**。失败用例（12 个不同名字）：`agentLoop tool batch admission > rejects every call of a batch that shares its message with a sole-batch tool [sideEffect, sole]` 以及 `[sole, sideEffect]`/`[sole, sole]`/`[unknown, sole]`/`[invalidArgs, sole]`；`agentLoop tool batch admission > never consults the pre-dispatch hook for a rejected batch`；`agentLoop tool result termination > ends the run after a successful tool result that requests termination`、`… after a failed tool result …`、`… lets afterToolCall request termination and override a tool's request`；`agentLoop sole-batch admission over every tool-call path > counts a Cursor exec-resolved sibling toward the batch and still blocks the sole call`、`… does not start a speculative candidate when the batch advertises a sole-batch tool (speculative-first)`、`… (sole-first)`。`rpc-host-tools.test.ts` 另有文件级 `Unhandled error between tests`：`SyntaxError: Export named 'normalizeHostToolDefinitions' not found in module …/rpc-mode.ts` |

### 5.3 RED：未打补丁 spike（真实固定运行时）

| 命令（`app/experiments/omp-bridge/`） | 结果 |
| --- | --- |
| `node t20-feasibility.mjs` | **exit 1**：46 项检查 **38 pass / 8 fail**、`ok:false`。8 项失败 = R3 契约（混合批次整批零副作用、提交后终止等）：`PI blocks every call in a batch that contains a transition tool`、`SubmitPlan host calls: 1, execution starts: 2`、`sibling file: true, execution starts: 2`、`PI's batch guard blocks the whole batch; observed 2 submissions, 2 execution starts`、`the interception payload has no batch view, so a per-call block cannot protect the siblings`、`model calls after the submit result: 2`、`model calls after the failed submit result: 2`（另 1 项为批内零执行） |

### 5.4 GREEN：完整补丁的 18.3.0

| 命令 | 结果 |
| --- | --- |
| `git -C upstream/oh-my-pi apply -p1 <artifact>` 后 `bun test packages/agent/test/agent-loop.test.ts packages/coding-agent/test/rpc-host-tools.test.ts packages/coding-agent/test/rpc-input-frame.test.ts` | **exit 0**：`Ran 177 tests across 3 files` → **177 pass / 0 fail**（含 `rpc-input-frame.test.ts` 的 15 项） |
| `git apply --check -p1 <artifact>`（未打补丁的 18.3.0 子模块） | **exit 0**（`-v` 显示各 hunk 以 `offset N lines` 命中），且子模块 `git status --porcelain` 事后仍为空 |
| `node t20-feasibility.mjs --patched` | **exit 0**：46 项 **46 pass / 0 fail**、`ok:true`；`patched.runtime` = `patchLevel 62bc57b+omp-desktop.2`、`baseSha 62bc57be…`、`carriesPatch {batchPolicy:true, concurrency:true, terminate:true}` |
| `node scripts/omp-patch.mjs --check --json`（`app/`） | **exit 0**：`patchLevel 62bc57b+omp-desktop.2`、`baseSha 62bc57be…`、`patchSha256 4edbfadf…`、`files 7673`、scratch 清理 |
| `node scripts/omp-patch.mjs --apply --out /tmp/omp-r4a-verify --prepare-build --verify --json`（`app/`） | **exit 0**：`verify.version = "18.3.0"`、`testsSummary = "162 pass, 0 fail, Ran 162 tests across 2 files"`（manifest 的 `suites`），payload = `node_modules`、`packages/natives/native`、`tool-views.generated.js` |
| `node --test apps/desktop/test/omp-patch.test.mjs`（`app/`） | **exit 0**：**26 pass / 0 fail**（原 24 + 新增 2） |
| 同一 suite 的**反向 RED**（把脚本换回 `HEAD` 版本、新测试不动） | **exit 1**：`refuses a patch whose byte count does not match the manifest` 与 `refuses a patch level that does not name the manifest base` 均以 `AssertionError … 0 !== 1` 失败 → 两项新校验不是空转 |
| `env -u SSH_ASKPASS node --test <16 个受影响 desktop 测试文件> apps/desktop/test/omp-patch.test.mjs`（`app/`） | **exit 0**：`tests 163 / pass 163 / fail 0`（含真实固定 18.3.0 运行时的 `omp-session-e2e`、`omp-subagent-e2e`、`omp-skill-path-e2e`） |
| `pnpm --filter @pi-desktop/shared test` | **exit 0**：**86 文件 / 982 tests passed** |
| `pnpm --filter @pi-desktop/omp-runtime test` | **exit 0**：**21 文件 / 322 tests passed**（含 `pinned-runtime.test.ts` 对真实启动器的版本断言） |

### 5.5 R3 未动摇：18.3.0 上重跑 provider-gate 实验

| 命令（`app/experiments/omp-bridge/`） | 结果 |
| --- | --- |
| `bun t20-cursor-exec-order.mjs` | **exit 1**（RED = 预期）：**严格 R3 契约检查 0/12 成立（12 项全部违反）**——`siblingFirst`/`submitFirst` 两序下，含 `SubmitPlan` 的批次里兄弟与过渡调用都在 stream `done` 之前执行（`executions before the stream's done event: 2 of 2`）、副作用文件真实产生、服务器收到成功应答、成功提交也无法把 `terminate` 送到 loop；`sole SubmitPlan` 也被 provider 抢先执行。候选方案检查 1/3（`external handoff` 成立；`no handlers`、`scheme B native` 违反）**不计入契约、不参与退出码**。全树 `git status --porcelain` 仍为空（工具体为夹具，未落任何真实副作用文件） |

结论：18.3.0 的 Cursor exec channel 仍让「批次裁决前零执行」不可满足；**R3 不解除**（与 R3D 审计 §7.3 一致）。

---

## 6. 检查与预存在失败

| 命令（`app/`） | 结果 |
| --- | --- |
| `node docs/scripts/check-docs.mjs` | **exit 1，6 项预存在**（506 页）：`adr/0301` 的 H1 不以 `ADR` 开头 + `adr/0301`–`0305` 缺 `adr/README.md` 索引行——与 R3D 审计记录的起点状态**完全一致**，本轮新增页面 0 项 |
| `node docs/scripts/check-locales.mjs` | exit 0：`Verified 79 English/Chinese specification pairs.` |
| `node scripts/check-t20-matrix-ids.mjs` | exit 0：`MATRIX-ID-OK: B1-B14, C1-C8, D1-D3 each appear exactly once` |
| `node scripts/check-architecture.mjs` | **exit 1，预存在**：`apps/desktop/electron/main/index.ts: 1550 / 1500`（本轮未改该文件；`New TS/TSX files checked: 0`） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | **exit 1**（预期）：`SUMMARY: 3 gap(s) open [g1, g2, g3]`；`VERDICT g4` = 「pinned rpc-ui 无 plan/goal/permission/approval 命令」——**在 18.3.0 上重跑仍成立**，说明升级没有使 T20-A 的判定失效 |
| 根仓库 `git diff --check` / `git show --check HEAD`（提交后） | 均 exit 0（`.patch` artifact 的 whitespace 由 `app/.gitattributes` 豁免） |
| 根仓库 `git status --short`（提交前） | 只有本阶段应改的文件；`upstream/oh-my-pi` 的 gitlink 变更已暂存；两个子模块工作树 `git status --porcelain` 均为空 |

预存在失败（`check-docs` 6 项、`check-architecture` 1 项）与起点提交一致，本轮**不作顺带修复**，也不把它们写成通过。

---

## 7. 限制与未做

1. **R4B 未做**：没有构建/打包 bundled sidecar，没有实现「打包态只接受清单校验资源」的门，也没有 macOS/Windows 实机验证。
2. **未创建自有 fork 仓库**：本轮改的是固定参考子模块的 gitlink 与 patch 基线，未新建 `MisterBowie/oh-my-pi` 之类仓库，也未改 `.gitmodules`；「自有 fork 的仓库名/归属」仍是用户决策项（R4B 的前置）。
3. **OMP 依赖与 natives 的取得方式**：18.3.0 子模块的 `node_modules` 由本地 `bun install` 缓存获得，native `.node` 取自 npm 官方预编译包 `@oh-my-pi/pi-natives-linux-x64@18.3.0`（未用 bazel 本地编译）；这些都不进版本控制，也不改变受控文件。
4. **未重跑的范围**：M1 的 13 个 omp-bridge 实验（`run-all.mjs`，413 项）未重跑，其 fixtures/results 中属于 18.2.7 运行记录的部分保持原样（§4.4）；`packages/agent` 全量 `bun test` 与 desktop 全量套件（~2900 项）未重跑，本轮只跑受影响文件与两个 manifest 套件。
5. **未测**：真实 Cursor 服务端行为、真实付费模型、Windows 路径、macOS 实机。
6. **mock 版本字面量**：`launcher.test.ts` 等处的版本字符串是夹具输入，同步为 18.3.0 只为一致性，不代表对其行为的新断言。

---

## 8. R4B 剩余事项（尚未开始）

对照 R3D 审计 §10 的验收矩阵，R4A 覆盖 R4-1/R4-2 与 R4-7/R4-8 的本轮部分；**R4B 需完成**：

- **R4-3** 构建脚本输出可核验清单（fork commit + 桌面版本 + 平台 + sha256），且**构建时校验**外层仓库 remote/commit；重复构建清单一致。
- **R4-4** 打包内 sidecar、无系统 `omp` 回退：PATH 无 `omp`、未装 Bun/Node 也能启动；资源缺失时报「缺少内置 omp」且不找系统 `omp`。
- **R4-5** 启动前版本/协议断言（沿用 `rpc-bridge.ts:13-24` 契约），版本不匹配拒绝启动。
- **R4-6** 数据与凭证隔离在新构建路径不回退（canary 证明不读用户目录）。
- **R4-9** 打包态**不接受**开发覆盖：`app.isPackaged` 为真时 `OMP_BUNDLED_OMP`/`OMP_SIDECAR(+_CLI)` 不生效、资源树伪 `omp` 不生效、只接受清单校验过的资源路径。
- 前置决策：**自有的 OMP fork 仓库名与归属**。

不因本轮结论而改变：**R3 仍阻塞**、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始。
