# M5/T20-B2：非 Cursor 的 Plan/Goal 提交、审批与批准执行 —— 验证记录

更新时间：2026-10-03。状态：**实现完成、待独立复审**；T20 未完成、`plan`/`goal` 能力键保持关闭、T20-D 未开始。设计：ADR 0310（`app/docs/adr/0310-omp-plan-submit-approval-and-dispatch.md`）；补丁级 `.4`（ADR 0305 修订）。证据目录：本文件同名目录（原始日志 + `SHA256SUMS.txt`）。

- 分支：`codex/m5-t20-b2-approval`（追加提交，不 amend/rebase/强推，不发布、不合 main）
- 基线：`9491016062e36a2967cf3db74d2a4990421d9d30`（C 的根已接受最终原始提交）
- 工作树：`/home/vv/person/code/omp-desktop-m5-t20-b2`；固定子模块 OMP `62bc57be1b03ef0802a33cf7f5f530e534527531`（未改）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`（未改）
- 受控补丁级：**`62bc57b+omp-desktop.4`**，fork `MisterBowie/oh-my-pi` 分支 `codex/omp-desktop-18.3.0-patch-4`，commit `512370a1b177cf45e4d12781104506ea372fb8a9`，tree `78886eaf82d4145521369b9e734cfff53f53fb54`，patch `0001-omp-desktop-runtime.patch` 101113 B / sha256 `d6d30785389a2ffc84bdff8ac72a4cea27c2abc50e14d709397f23dd2362882f`（15 文件）
- 环境：Linux x64；Node v24.14.0；Bun 1.4.2；宿主 host-core `0.15.2`（`cargo build -p host-core --locked`，复用受控 target 缓存）；所有模型调用都是本地 FakeProvider，**无付费/远程模型**、未调用 Cursor 服务

## 1. 范围（本轮实现）

矩阵行 B4-B8、B13 目录生命周期，以及 D1/D3 所需的闭环；B9 能力声明与整矩阵仍属 T20-D。

1. **补丁 `.4`：结算时终止声明**（`AgentTool.terminateOnSettle` / `RpcHostToolDefinition.terminateOnSettle`，默认关闭；非布尔值整批拒绝并进入注册 fingerprint）。在 agent loop 的唯一结算边界（`emitSettledToolResult`）按**已解析工具定义**执行：成功、失败、`beforeToolCall` 拒绝/变换异常、`execute` 抛错、宿主错误/无效返回与**从未到达 `execute` 的 schema 校验失败**都在提交后终止、无第二个 provider 请求；被批次准入拒绝/中断跳过与外部 Stop 不终止；流式 partial 永不终止；混合批次仍整批零副作用 `block-and-continue`；未知工具名不能凭名字获得该声明。这闭合了根探针 `omp-t20-b2-submit-validation-4d532524-20261003` 实测的缺口（缺 required 字段时 host0/provider3 且下一 Bash 真实执行）。
2. **提交工具（PI 权威契约）**：生产 adapter 导出 `desktopSubmitToolCatalogEntry(kind)`——`SubmitPlan`/`SubmitGoal` 的名称、描述与 required `title`/`markdown`/`question` schema 与 PI `buildSubmitTool` 逐字一致，`essential` + `exclusive` + `sole` + `terminateOnSettle`；bridge 在唯一目录装配点按会话合约模式追加（Plan 只 `SubmitPlan`、Goal 只 `SubmitGoal`、Agent 两者都没有），策略表声明 `{risk:"low", planSafeActions:[], origin:"desktop"}`（`origin` 新增 `desktop` 值）。gate：`contractAllowsTool(name, hostTools, mode)` 只放行本模式自己的提交工具、另一种 kind 以 `PLAN_KIND_MISMATCH` 拒绝；`contractActiveToolNames` 在夹取中保留它；提交调用不需审批卡（Low），审批走既有卡片。
3. **executor submit 分支**：只接受运行绑定里的 `{sessionId, hostTurnId, 真实 toolCallId}`；错 mode（`modeForTurn`）、未绑定 durable turn、空参数、未接线 `plans.submit` 都 fail closed；成功要求宿主返回 `status:"pending"` 且 proposal 带 id/relativePath/sha256/sizeBytes，否则报 invalid proposal；宿主错误码原样（如 `PLAN_ALREADY_PENDING`）回给模型。
4. **持久 host turn（单一责任方）**：bridge 在每次被接受的提示词（普通入口与批准执行入口共用 `prompt`）提交前恰一次 `session.beginTurn`（`hostTurns` provider，生产由 `createOmpHostTurnLifecycle` 提供），runner `closeRun` 时恰一次结算；`recoverInflight:false`、`createNotification:false`，native JSONL 仍是唯一正文来源；started 失败/Stop/dispose 只结算自己那一代；`hostTurn`（持久 id）与 live `omp-turn:` 代号分开保存并贯穿 `OmpHostToolRun.hostTurnId`；下一提示词先 `await` 上一行的 end promise，避免 `AGENT_BUSY`。
5. **派发**：`runtime/plans.ts` 在任何持久变更前判定引擎（gate 拒绝 → 跳过、行保持 queued、drain 继续）；OMP 分支等本会话 live 回合结束 → `plans.claimExecution` CAS 恰一次 → `session.getEngineRef` 恢复同一 native 会话 → 以共享 `approvedPlanInstruction`（从 PI `executeApprovedPlan` 提取为 `@pi-desktop/agent-runtime` 单一实现）经 bridge `prompt` 提交；Pi 路径不变；完成/中断由 `settleOmpTurnEnd` 按 durable host turn id 结算；拒绝/过期/CAS 失败者/boot maintenance 都不发提示词、不重放。审批 IPC 不再拒绝 OMP，但 approve 前仍先过引擎门；复用既有 `plans.resolve` 事务与 `PlanApprovalBar`/`plans.changed`，无第二审批队列。

## 2. 验证（全部本机实跑；原始日志见同名目录）

| 命令 / 场景 | 结果 | 原始日志 |
| --- | --- | --- |
| fork `bun test packages/agent/test/agent-loop.test.ts`（含新增 `terminateOnSettle` 6 例：schema 缺字段/execute 抛错/成功无 flag/未知工具不继承/中断跳过不终止/混合批次拒绝不终止） | **155 passed / 0 failed** | `fork-agent-loop.txt` |
| fork `bun test packages/coding-agent/test/rpc-host-tools.test.ts packages/coding-agent/test/rpc-input-frame.test.ts`（新增 `terminateOnSettle` 声明/非法值/边界 null 用例） | **28 passed / 0 failed** | `fork-rpc-host-tools.txt` |
| fork `bun test packages/natives/test/embed-native.test.ts packages/coding-agent/test/build-binary-bytecode.test.ts`（可复现构建载荷不回退） | **5 passed / 0 failed** | `fork-reproducibility.txt` |
| 真实 fixed patched OMP（`.4` 源码树）+ 生产 bridge/gate/host-tool adapter + 真实 host-core（隔离 `pi.sqlite`）+ 本地 FakeProvider：`node --test apps/desktop/test/omp-plan-submit-e2e.test.mjs` | **4 passed / 0 failed**（有效提交=provider 1 + 工件 sha/size/字节/新旧不可覆盖；schema 缺字段=terminate 且 host 0 调用、无兄弟副作用；`[bash, SubmitPlan]` 整批零副作用、不终止、普通工具随后执行；重复 pending 拒绝、reject→重提；批准派发恰一次 prompt（双派发竞争）、指令含工件路径与完整 Markdown、completed 不重放；重启后 queued 行被 boot maintenance 置 interrupted、drain 不执行） | `plan-submit-e2e.txt` |
| **RED 对照**：`OMP_B2_UNPATCHED=1` 同一 E2E 抗未打补丁子模块（`62bc57be`） | **fail**：提交成功后的回合 30 s 内不结算（base 运行时忽略宿主结果 terminate 并继续）——补丁 `.4` 即缺口闭合证据 | `plan-submit-e2e-unpatched-red.txt`（归一化可读副本）+ `.gz`（原始字节；raw sha256 `80919b9a…`） |
| `pnpm test`（`app/packages/omp-runtime`，含 gate 提交工具/夹取/决策与注册字段回归） | **31 files / 474 passed / 6 skipped** | `omp-runtime-vitest.txt`（归一化可读副本）+ `omp-runtime-vitest.txt.gz`（原始字节，`gzip -n -9`；raw sha256 `87f8fff9…`） |
| 受影响 desktop 套件（drain 5、提交单元 5、artifact 契约、bridge/failclosed/launcher/sidecar/patch/packaging、plan-approval-settings） | **144 passed / 0 failed** | `desktop-affected.txt` |
| 真实 OMP 回归：`omp-session-e2e.test.mjs` + `omp-host-tool-e2e.test.mjs`（未改行为路径） | **7 passed / 0 failed** | `real-omp-regression.txt` |
| `cargo test -p host-core --locked plans::`（复用受控 target 缓存；未改 Rust） | **20 passed / 0 failed**（restart 打断、CAS、artifact 防覆盖/symlink、kind roundtrip 等） | `hostcore-plans.txt` |
| `node scripts/omp-patch.mjs --check`；`node scripts/omp-sidecar.mjs --check --source <fork>` | `OMP-PATCH-OK 62bc57b+omp-desktop.4`；`OMP-SIDECAR-OK 62bc57b+omp-desktop.4 (fork 512370a1…)`，exit 0 | `patch-sidecar-check.txt` |
| `node scripts/omp-sidecar.mjs --build`（**两次**：默认 out + 深层 TMPDIR/不同 out）+ `cmp` + `diff -u provenance` + `verify-packaged-runtime` | 二进制 284001760 B / `47a30f08…` 两次 `cmp` 相同；gate bundle 41981 B / `b4305983…` 相同；provenance `diff` 空；`PACKAGED-RUNTIME-OK`（真实二进制 protocol v2、gate 装载控制拒绝、stop reaped/cleaned） | `sidecar-build-provenance.txt` |
| `pnpm build:js` / `pnpm typecheck` / `pnpm lint` / `git diff --check` | 全部 exit 0 | `build-typecheck-lint.txt` |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | **`SUMMARY: 0 gap(s) open [none]`，exit 0**（g1/g2 保持 RETIRED；**g3 由 B2 退场为行为测试**）；矩阵 ID/中英 spec 对/发布文档检查均通过；`check-docs` 仅剩 6 项预存在问题（0301 H1 + 0301-0305 index，与本分支起点一致、零新增） | `app-checks.txt` |
| desktop 全量 `node --test test/*.test.mjs`（初始化 `upstream/pi-desktop` 后；`env -u SSH_ASKPASS`） | 见 §3（`desktop-full.txt`；上一轮全量在该子模块尚未初始化时跑出 2978 pass/6 fail，6 项逐一核对后全部是环境/夹具项：3 项为本轮行为变更的夹具缺口，2 项为环境泄漏，1 项为未初始化的参考子模块） | `desktop-full.txt` |

## 3. 受影响测试的更新（有意行为变更，非放宽断言）

B2 改变了两处可观察形状，相关既有测试按新行为更新：

1. **`OmpTurnEndInfo` 新增 `hostTurnId`**：`omp-host-tool-bridge.test.mjs` 的 deepEqual 与 B1 E2E 的 `expectRefusal`/`expectNormalTurn` 记录改为按字段投影并**新增** `typeof hostTurnId === "string"` 断言（拒绝回合与正常回合都必须结算自己的持久回合）。
2. **合约目录新增本模式提交工具**：B1 E2E 的 `contractExpected` 增加提交工具参数并在 Plan/Goal 断言中**新增**「Plan 恰好含 `SubmitPlan` 且不含 `SubmitGoal`、Goal 反过来」的正向断言；Agent 阶段期望不变。
3. **`wireOmpSessions` 现在无条件装配宿主持久回合生命周期**：B1/C 两个 E2E 的假宿主补上 `session.beginTurn`/`session.endTurn` 记录（与真实 host-core 相同的 RPC 形状），不是跳过或吞掉调用。
4. **`plan-drain-engine-gate.test.mjs`**：原「OMP 会话被拒」改为三条——引擎门拒绝在 claim 前跳过、OMP 运行时未接线在 claim 前跳过、接线后恰一次 claim + 恰一次 bridge prompt（且不调用 Pi sidecar）。
5. **fork patch 探针/清单**：`check-omp-plan-goal-gaps.mjs` 的 g3 按 g1/g2 相同方式退场为行为测试（只校验替代测试存在，不做符号匹配）；`packaging-sidecar-source`/`preview-workflow` 期望的 fork ref 随 manifest 更新为 `512370a1`（`app/.github/workflows/{release,linux-package}.yml` 与根 `.github/workflows/mac-preview-package.yml`）。

## 4. 限制与未跑项

- **全量 desktop（最终）**：`env -u SSH_ASKPASS PI_DESKTOP_HOST_BIN=<host-core> node --test test/*.test.mjs` → **2995 tests / 2984 pass / 0 fail / 11 skipped，exit 0**（`desktop-full.txt`；含 B2 新增的 11 项）。本机 `SSH_ASKPASS=/usr/bin/false` 是环境泄漏，会让 `remote-host-ssh-password.test.mjs` 的「key 认证不应继承 askpass」断言失败；去掉该环境变量后 14/14 通过——环境问题，不是产品行为（未改产品）。
- **B1/C 真实运行时 E2E 复核**：`patched-e2e-regression.txt` → 2 passed / 0 failed（B1 15.9s、C 11.8s）。两者夹具补上了宿主 `session.beginTurn`/`session.endTurn`，并断言每个回合都结算自己的持久回合（§3 变更 1/3）。
- **未跑/不声称**：`plan`/`goal` 能力键与 UI 入口未开放（T20-D 整矩阵）；未发 release/tag、未合 main；三平台（macOS arm64 / Windows x64 / Linux x64）真实安装包按用户目标在 M5 整体验收后交付，本轮只有 Linux x64 本机证据；未跑 Windows/macOS 实机；未用真实外部模型；未调用 Cursor 服务；Cursor + Plan/Goal 仍拒绝（ADR 0306 未改）。
- **真实外部模型**：无。E2E 的 provider 是本地 FakeProvider；宿主是真实 host-core + 真实数据库（`node:sqlite` 只读核对重启后 `plan_approvals.execution_state = interrupted`）。
- **已知边界（如实记录）**：Goal 延续定时器未实现（批准的 Goal 是一个 agent 回合，与 Pi 路径一致）；`settleOmpTurnEnd` 的结算发生在 runner 同步 close 触发的异步 host RPC 中（fire-and-forget + 一次重试 + 日志），下一提示词等待该 promise —— 若 host 持续不可用，`beginTurn` 会以 `AGENT_BUSY` fail closed 而非静默继续。
- **补丁 `.4` 的第二方产物**：Linux x64 sidecar 284001760 B/`47a30f08…`（provenance `patchLevel 62bc57b+omp-desktop.4`）；该产物与 `.3` 的旧二进制不同，manifest/坐标已同步更新（`app/patches/oh-my-pi/manifest.json`、`@pi-desktop/shared` 常量、`docs/source-baseline.json`、两个 workflow 的 ref）。
