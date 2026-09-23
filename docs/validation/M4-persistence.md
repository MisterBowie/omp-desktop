# M4 验证记录：会话持久化、模型投影与并发注册表（T14-T16）

更新时间：2026-09-23。第五轮复审基线：`d5997232c1b4478c65a1497ceebdf491fed47703`，分支 `codex/m4-persistence`。
参考子模块固定且干净：PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`，OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`。

## 0.1 独立复审返修（R1-R9）

上一轮提交 `c39452c` 经独立复审判定不可接受，本轮逐项修复。各项均先写能失败的回归测试，再修实现。

| 编号 | 问题 | 修复 | 测试 |
| --- | --- | --- | --- |
| R1 恢复路径 fail-closed | `switch_session` 直接收持久化路径，无 canonicalize/containment/file-type/identity/version 校验 | `validateNativeSessionPath`（resolve 后 containment、`lstat` 拒 symlink/目录/缺失、扫描前 4 行找 `type:"session"` header 且 `id` 必须匹配——固定 OMP 格式首行是 256 字节 title slot）、`validateEngineVersions`（adapter ≤ `ENGINE_ADAPTER_VERSION`、runtime 降级拒绝）；`bindEngine` 校验 adapter 范围；switch 后 `get_state` 核对 identity，不一致停 runtime | `omp-session-failclosed.test.mjs`（越界/symlink/目录/缺失/identity 不符/adapter 不符/runtime 降级/switch 后 mismatch） |
| R2 branch 接入 fork | `messages[0].entryId` 默认第一项；sidebar fork 复制 host transcript 无 native mapping | `sessionFork` IPC 检测 OMP 走 `bridge.branch(sessionId, throughMessageId)`；`branchEntryId` 把 renderer 选中的 user/assistant id 精确映射到 OMP entry（绝不默认第一项）；`createBranchSession` bind 失败删 child + `persistBranchCleanup` 删孤儿 native 文件 | `omp-session-branch.test.mjs`（sidebar 取 head、assistant 映射到对应 entry、错误 entry 拒绝、bind 失败补偿） |
| R3 modelSwitch/thinking 接入 sessionConfigure | setModel/setThinkingLevel 未接线；SessionEntry 复用只比较 project | `sessionConfigure` IPC 检测 OMP 走 `bridge.configure`；model 变化先 persist 再 dispose（下次 prompt 重投影），thinking 变化先 set_thinking_level 再 persist、失败回滚；`entryFor` 校验 binding 不变 | 现有 28 项 bridge 测试 + `configure` 路径 |
| R4 投影 fail-closed | 未检查 enabled/authKind/secret/modelId/thinking/headers；OAuth 降级 auth:none | `resolveProviderProjection`（disabled/unknown model/缺 key/oauth/basic/thinking 不兼容均拒绝；project headers）；secret 只在校验后读取并只落临时 models.yml | `omp-model-projection.test.mjs` R4 7 项 |
| R5 shutdown 可观察 | dispose 吞 thrown + 忽略 stopped:false | `dispose`/`disposeSession` 返回 `OmpDisposeResult`，逐 session 汇总 thrown/stopped:false 到 logger/返回值；单次失败不阻停其余 | `omp-session-failclosed.test.mjs` R5 2 项 |
| R6 delete/archive 目标回收 | session delete 只 dispose Pi | `sessionDelete` 检测 OMP 后 `disposeSession(id)`；回收失败写日志不谎报 | （R5 已覆盖 reclaim 失败可观察） |
| R7 rename 三态一致性 | rename 只在 runtime 运行时可 | `bridge.rename` 三态：active 直接 set_session_name、idle/restart 短暂恢复→改名→清理；host persist 失败回滚 native 名 | `omp-session-failclosed.test.mjs` R7 1 项 |
| R8 文档与并发 E2E | 路径测试只模拟 switch 失败；恢复硬编码伪 id | 恢复用 `get_state` 真实 `nativeSessionId`；新增真实 runtime 越界/header 校验 | `omp-session-persistence-e2e.test.mjs` |
| R9 附加 | restore 每次 prompt 重复 switch；bindEngine adapter 范围；branch bind 孤儿清理 | `ensureNativeSession` 已绑定则跳过重复 switch；`bind_session_engine_ref` 校验 adapter 范围；`persistBranchCleanup` 删孤儿 | 见 R1/R2 测试 |

## 0.2 第二轮独立复审返修（F1-F8）

上一提交 `3c7eb0b` 再次被拒，本轮逐项复现并修复。

| 编号 | 问题 | 修复 | 测试 |
| --- | --- | --- | --- |
| F1 canonicalize | `resolve` 只词法规范化，中间目录 symlink 可逃逸；state path 可缺失；整文件 `readFileSync` | `validateNativeSessionPath` 用 `realpathSync`（root+candidate）、`lstatSync(raw)` 拒直接 symlink、`openSync`+`readSync` 有界读前 4KB 找 header；switch 后 `get_state` 必须同时返回 id + canonical path | `omp-session-failclosed.test.mjs`（中间目录 symlink 逃逸/get_state 缺 path/同 id 错 path） |
| F2 delete/archive | delete 先删 row 再取 engine（无法判定 OMP）；dispose ok:false 被忽略；archive 无 IPC | `sessionDelete` 先 `requireForSession(id,"stop")` 取 engine，OMP reclaim 在 `session.delete` 前，`cleanupFailed` 返回可观察；新增 `sessionArchive` IPC + renderer 通知，archive 回收目标 runtime、unarchive 不启动 | `omp-session-delete-archive.test.mjs`（5 项：顺序/回收失败/两会话隔离/非 OMP 跳过） |
| F3 branch | 序号猜测 entry、重启/idle NOT_FOUND、父 runtime 串线到 child、忽略 selected text、title 丢弃 | **关闭 `branch` capability**（OMP `branch` 是 redo-from-user fork，非 PI copy-through fork；rpc-ui 事件流不带 entry id，无法可靠持久化 message→entry 映射；branch RPC 会切走父 runtime）。`sessionFork` 对 OMP 抛 typed refusal | `engine.test.ts`/`engine-router.test.mjs`（branch=false 断言） |
| F4 modelSwitch 原子 | configure 从不调 set_model；thinking 失败后 DB 已提交无回滚；mode/permissionMode 丢弃；dispose 失败被忽略 | `configure` 用单一 `persistConfig`（一次 `session.configure` 带全字段 mode/provider/model/thinking/permissionMode，host 原子）；model 变化 persist 后 dispose、dispose `ok:false` 返回失败；thinking 失败回滚 | 现有 28 项 bridge 测试 + 全量 |
| F5 投影 allowlist | 未知/空 authKind 降级 auth:none；stale hasSecret 后空 key 仍 auth:none；provider id 未引号 | `resolveProviderProjection` 用明确 allowlist（`api_key`/`api_key_and_base_url`/`none`），其余全拒；`projectSessionModels` 拿真实 secret 后再次 fail-closed；provider id 用 `JSON.stringify` 引号 | `omp-model-projection.test.mjs`（F5 未知/空 auth、special id） |
| F6 rename 回滚 | 空旧标题不回滚；回滚失败被吞；cleanup `{ok:false}` 被忽略 | `rename` 空标题也回滚，回滚失败返回 `inconsistent`；one-shot cleanup 失败返回 `{ok:false, inconsistent}` | `omp-session-failclosed.test.mjs`（F6 空标题回滚/cleanup 失败） |
| F7 真实并发审批 | E2E 顺序执行；无两 runtime 重叠审批 | 新增真实 runtime + 本地 fake provider：A/B 同时 prompt、同时卡审批、回答 A 不释放 B、各自 side effect、停止 A 不影响 B | `omp-session-concurrent-approval-e2e.test.mjs` |
| F8 文档诚实 | 声明超出实际证明 | 本表 + ADR 0302 §6 更正 branch 关闭；HANDOFF 更正 | — |

## 0.3 第三轮独立复审返修（G1-G3）

| 编号 | 问题 | 修复 | 测试 |
| --- | --- | --- | --- |
| G1 modelSwitch 原子 | modelChanged 先 persist 后 dispose，reclaim 失败 DB 已改；thinking 回滚 null/空被跳过、回滚失败被吞；persistConfig optional | 改为「先成功回收旧 runtime，再原子 persist」离线切换事务：reclaim 失败 DB 完全不变；persist 失败 DB 原值不变、下次 prompt 按旧 binding 重启；thinking-only 应用→persist→回滚，null/空旧值用 "off"，回滚失败 `inconsistent`；persistConfig 缺失 fail-closed | `omp-session-configure.test.mjs`（5 项：model 顺序/回收失败不写 host/thinking 回滚/回滚失败 inconsistent/mode+permissionMode） |
| G2 delete/archive 回收失败可观察 | delete 回收失败仍删 row；archive 返回 `{ok:true,cleanupFailed}`；renderer fire-and-forget；engine 解析失败被当非 OMP | delete 先解析 engine（失败 fail closed），OMP 回收失败则抛 typed error 不删 row/outbox；archive 回收失败抛 typed error；renderer archive 改 async：先 `api.archiveSession` 成功才提交 archived metadata，失败保持未归档并抛错 | `omp-session-delete-archive.test.mjs`（回收失败不写 host row / archive 抛错） |
| G3 清理过期 branch | 关闭 capability 但保留序号猜测 branch 实现 + wiring | 删除 `branchEntryId`/`createBranchSession`/`persistBranchCleanup`/`userMessages` 追踪，`branch` 改为 typed refusal；文档不再把 modelSwitch 称为「原子」（改为「离线切换事务」） | — |

## 0.4 第五轮独立复审返修（J1-J5）

基线 `d599723`（第四轮 H1-H4 提交）。逐项先写能失败的回归测试再修实现。

| 编号 | 问题 | 修复 | 测试 |
| --- | --- | --- | --- |
| J1 inconsistent 穿透 IPC | configure/rename 把 `inconsistent:true` 放在 Error 顶层，`register.ts` 的 `wrap()` 只转发 `e.data` 进 `Result.error.details`，renderer `invoke()` 只暴露 `error.details`，标记丢失 | 标记移入既有 data/details 契约（`data: { inconsistent: true }`），保留 typed `ENGINE_CAPABILITY_UNAVAILABLE` 与 message；rename 同步补齐（此前 rename 直接丢弃 `inconsistent`） | `omp-session-ipc-result.test.mjs`（真实 `registerIpcHandlers`/`wrap` 路径，断言 `error.details.inconsistent === true` + code + message）；直接 handler 断言改查 `error.data.inconsistent` |
| J2 OMP 无桥接 fail-closed | `sessionRename`/`sessionConfigure` 在 `engine === "omp" && ompSessions` 为假时落到 `host.call("session.rename"/"session.configure")` | 两者在 `engine === "omp"` 且无 `ompSessions` 时抛 typed capability-unavailable error，先于任何 host 变更；Pi 路径不变 | `omp-session-configure-ipc.test.mjs`（rename/configure 拒绝 + 断言对应 host 调用从未发生） |
| J3 archive store 行为测试 | `omp-session-archive-renderer.test.mjs` 只做源码文本断言 | 用 TS import hook + 最小 get/set 状态 harness 执行真实 `createProjectSlice().archiveSession()`：`api.archiveSession` reject 时 `sessionMeta[id].archived` 保持 false、`sessions[]` 条目保持未归档、`persistCurrentSidebar` 不被调用、拒绝传播到调用方（阻止 Sidebar no-next 兜底创建 fallback） | `omp-session-archive-renderer.test.mjs`（J3 可执行 store 测试；Sidebar await/catch 源码契约保留为补充检查） |
| J4 主机专属变更空洞 | moveProject / replaceMessages / saveRevision / listRevisions / activateRevision 无引擎门，`engine === "omp"` 会改写/读取 host transcript/project 投影，与原生 transcript 分叉 | 五个 handler 在 host 变更前 `engineForSession` 取引擎，OMP 抛 typed refusal（`refuseOmpSessionAction`）；Pi 行为不变。`scratch` 判定独立：scratch 目录 host 所有（`<dataDir>/scratch/<sessionId>`），是 renderer 附件/粘贴/截图/语音图片存储，不是原生 transcript，**不**加引擎门（代码注释 + 本节记录） | `omp-session-host-mutation-gates.test.mjs`（每个 handler OMP 拒绝 + host 调用未发生 + Pi 路径不变） |
| J5 文档诚实 | validation §3.6 仍称 `set_model`/`set_thinking_level` 失败返回 `{ok:false}` | 改写为最终行为：model change 不调 `set_model`（离线 reclaim-first/persist-second 重投影重启）；仅 thinking-only 在线 `set_thinking_level` 并回滚 | 本表 + §3.6 更正；task-board/HANDOFF 同步 |

## 0. 结论摘要

- T14（会话字段/迁移/恢复/归档）、T15（模型投影/凭证脱敏）、T16（并发注册表/故障恢复）实现完成并验证。**分支（branch）经两轮复审确认与固定 OMP `branch` 语义不兼容（redo-from-user fork vs PI copy-through fork）且 rpc-ui 事件流不带 entry id，本版关闭该 capability 并明确拒绝，不宣称兼容**（见 §0.2 F3、ADR 0302 §6）。
- 数据责任：OMP 原生 transcript 仍是唯一权威写入者；host-core 只保存版本化引用（`engine_adapter_version`/`engine_runtime_version`/`native_session_id`/`native_session_path`，schema v21），通过 `session.bindEngine`/`session.getEngineRef` 两个主机边界 RPC 读写，renderer 不接触原生绝对路径。
- 原生 session 文件落在应用自有持久目录 `<dataRoot>/omp-sessions`（`--session-dir`），与每次运行的临时 HOME/config/log/凭证分离，stop/reclaim 不删除。
- 每个桌面 session 有独立 supervisor/runtime/原生 transcript/工作目录/模型投影/审批注册表；侧栏切换不改变后台 session 的 cwd、模型或事件归属。
- 能力开放：`resume`/`modelSwitch` 真实接线后开放；`branch`/`steer`/`followUp`/`compact` 保持关闭（typed refusal），拒绝路径不回退 Pi。

## 1. 功能 → PI 实现/测试 → OMP 实现/测试 → 本项目决定 证据表

| 功能 | PI 实现/测试 | OMP 实现/测试 | 本项目决定 |
| --- | --- | --- | --- |
| 会话元数据与迁移 | `crates/host-core/src/db/migrations.rs`（v7→v20 链）、`db/tests.rs`（`v19_database_migrates_to_session_engine` 等）、`src/sessions.rs`（`SessionSummary`/`create_session_with_options`） | 无（原生会话由 OMP 管） | 沿用 host-core 迁移规范，v20→v21 加 4 个可空列（非 JSON blob），`db/tests.rs::v20_database_migrates_to_native_session_reference` 红绿覆盖 |
| 会话创建/查询 | `rpc/mod.rs` `session.create`/`session.get`、`apps/desktop/test/session-create.test.mjs`、`session-model.test.mjs` | `new_session`/`get_state`/`get_messages`（`rpc-types.ts`、`rpc-mode.ts:553`、`rpc-client.ts:631`） | 首次 OMP 会话走真实 RPC `new_session`→`get_state`，校验 `sessionId/sessionFile` 后 `session.bindEngine` 持久化 |
| 命名 | `session.rename`、`apps/desktop/test/session-rename.test.mjs` | `set_session_name`（`rpc-types.ts:80`、`rpc-mode.ts`） | OMP 名称经 `set_session_name` 协调，成功后才 `session.rename` 持久化（`session-ipc.ts`）；失败不留两套名称 |
| 归档/侧栏 | `packages/shared/src/session-presentation.ts`（`sessionIsArchived` 展示态）、`apps/desktop/test/app-store-sidebar.test.mjs` | 无对应 | 复用 PI 展示态归档/侧栏刷新，归档只改产品可见状态，不删原生文件 |
| 恢复 | 原生 Pi 会话 `native-pi-session.ts` 恢复（`SessionManager.open`） | `switch_session(sessionPath)`（`rpc-types.ts:76`、`session-manager.ts:1835` 采纳 header cwd） | 新进程用同一 session 引用 `switch_session(sessionPath)` 后恢复历史，不重放 prompt/工具/审批（`omp-session-persistence-e2e.test.mjs`） |
| 分支 | `session-fork.test.mjs`、`fork_session_through` | `get_branch_messages`→`branch(entryId)`（`rpc-types.ts:77-78`、`e06-session.mjs`） | **branch capability 关闭**：固定 OMP `branch` 是 redo-from-user fork（fork 到选中 user 的 parent）而非 PI copy-through fork，rpc-ui 事件流不带 entry id，无法可靠映射；`branch()` 抛 typed refusal（见 §0.2 F3、§0.3 G3） |
| 模型/思维 | `packages/shared/src/types/providers.ts`（`ProviderPublic`/`ModelBinding`）、`runtime/provider-catalog.ts`、`session-thinking.test.mjs`、`session-configuration-staging.test.mjs` | `get_available_models`/`set_model`/`set_thinking_level`（`rpc-types.ts:48-53`）、`models.yml`（`config/models-config-schema-bundle.ts`、`config/model-registry.ts:429`） | 最小投影（单模型）：model change 是最小投影约束下的**离线 reclaim-first/persist-second restart**（不调用固定 OMP `set_model`）；thinking-only 才在线 `set_thinking_level` 并回滚；mode/permissionMode 一次 host configure 持久化 |
| 凭证/脱敏 | `crates/host-core/src/secrets.rs`、`ipc/provider-ipc.ts:444`（`providers.getSecret`） | `isolation.ts`（ambient 剥离、合成 HOME）、`e07-isolation.mjs` | secret 只在 main/host 边界读取，只落进临时 `models.yml`；canary 扫描覆盖日志/帧/持久引用/文档/快照 |
| 并发/隔离 | 无（Pi 单 sidecar） | 无（M3 单 runtime） | 每 session 独立 supervisor/runtime（`omp-session.ts` registry），并发实测（`omp-session-persistence-e2e.test.mjs`） |

## 2. 验证命令与结果

所有命令在 `app/` 下执行，先 `nvm use 24`（非交互 shell 加载 `~/.nvm/nvm.sh`，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2，rustc stable 1.95.0）。OMP 子模块按 worktree 单独 `bun install` + `bun run build:native`（cmake/ninja 经 pyenv 提供，需显式 `CMAKE` 与 PATH 注入）。

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `cargo test -p host-core --locked` | **582 passed / 0 failed** | 0 |
| `cargo fmt -p host-core -- --check` | 通过（已格式化两处） | 0 |
| `pnpm --filter @pi-desktop/omp-runtime test` | **157 passed / 0 failed**（含真实固定 runtime 烟测） | 0 |
| `pnpm --filter @pi-desktop/shared test` | **968 passed / 0 failed** | 0 |
| `node --test test/*.test.mjs`（`env -u SSH_ASKPASS`，desktop 全量） | **2663 passed / 0 failed / 4 skipped**（2667 项） | 0 |
| `pnpm typecheck`（12/13 workspace 包） | 通过 | 0 |
| `pnpm build:js` | 通过（含 desktop renderer 打包） | 0 |
| `cargo build --release -p host-core --locked` | 通过 | 0 |
| `git diff --check` | 无输出 | 0 |

新增定向测试：`apps/desktop/test/omp-model-projection.test.mjs`（17 项，含 R4/F5 fail-closed）、`apps/desktop/test/omp-secret-redaction.test.mjs`（2 项 canary）、`apps/desktop/test/omp-session-persistence-e2e.test.mjs`（1 项真实 runtime 持久化/恢复/并发，恢复用真实 `get_state` 身份）、`apps/desktop/test/omp-session-failclosed.test.mjs`（17 项 R1/F1/R5/F6/R7）、`apps/desktop/test/omp-session-delete-archive.test.mjs`（5 项 F2 IPC）、`apps/desktop/test/omp-session-concurrent-approval-e2e.test.mjs`（1 项 F7 真实并发审批）、`omp-session-bridge.test.mjs`（28 项 registry 语义）、`crates/host-core/src/db/tests.rs`（迁移 v21 + bindEngine）。

## 3. 先红后绿证据

1. **迁移 v20→v21**：`v20_database_migrates_to_native_session_reference` 先造 v20 形状（DROP 4 列、`user_version=20`），重开断言 4 列存在且旧记录读回 `engine=pi`、引用字段全 `None`；`bind_engine_ref_persists_and_reads_back_native_handles` 断言 OMP 会话 bind 后读回；`bind_engine_ref_refuses_pi_sessions_and_blank_handles` 断言 Pi 会话/空 id/未知 session 的拒绝路径。首次运行暴露 v20→v21 未在 post-match 链中续读版本号（`migrate_v19_to_v20` 后缺 `migrated_version` 重读），修复后 12 个既有迁移测试由失败转绿。
2. **持久化真实 native id/path 且关闭 runtime 后文件仍在**：`omp-session-persistence-e2e.test.mjs` 断言 `get_state` 的 `sessionFile` 落在 `sessionDir`（非 runRoot），`disposeSession` 后 `existsSync(sessionPath)` 仍为真。
3. **新进程恢复相同会话**：同一测试用 `nativeSessionPath` 重开，断言历史恢复、0 个旧工具执行、目标文件 mtime/content 不变（restore 不重放）。
4. **缺失/损坏/越界引用**：`omp-session.ts` 的 `ensureNativeSession` 对 `switch_session` 返回 `cancelled`/`success:false` 抛 `OMP_RESTORE_FAILED`，不新建替代会话（bridge 测试 + registry 语义覆盖）。
5. **rename/archive/delete 主路径与失败**：`session-ipc.ts` 重命名失败抛 `ENGINE_CAPABILITY_UNAVAILABLE`；`sessionDelete` 先取 engine 再回收 OMP runtime、回收失败抛 typed error 不删 host row；`sessionArchive` IPC 回收目标 runtime、回收失败抛 typed error（`omp-session-delete-archive.test.mjs`）。branch 关闭（见 §0.2 F3）。
6. **模型投影只出现目标模型 + 默认变化不改旧 session**：`omp-model-projection.test.mjs` 断言只一个 `- id:`；投影固定于 session 绑定的 provider/model。模型变化**不调用**固定 OMP `set_model`——它是最小投影约束下的离线切换事务：先成功回收旧 runtime，再原子 persist（回收失败 host 原值不变；persist 失败下次 prompt 按旧 binding 重投影）；仅 thinking-only 变化才在线 `set_thinking_level` 并在 persist 失败时回滚、回滚失败报 `inconsistent`。
7. **canary secret 不泄漏**：`omp-secret-redaction.test.mjs` 断言合成 key 只落在临时 `models.yml`，不在日志、事件 envelope、持久引用、文档/快照。
8. **并发隔离（真实 runtime）**：`omp-session-concurrent-approval-e2e.test.mjs` 让 A/B 两个真实 OMP runtime 同时存活、同时卡各自 gate 审批，回答 A 不释放 B、各自 side effect、停止 A 不影响 B；`omp-session-persistence-e2e.test.mjs` 断言双项目 cwd/文件隔离。
9. **崩溃/重启不重放、旧审批不跨进程放行**：runner 的 generation 单次消费 + `resolveUiRequest` 绑定 session/generation（M3 已证），M4 恢复路径复用同一语义（`omp-session-bridge.test.mjs` 28 项全绿）。
10. **未开放能力拒绝不改持久状态**：`branch`/`steer`/`followUp`/`compact` 保持关闭，`engine-router` 拒绝（`engine.test.ts` 断言 `branch===false`/`steer===false` 与 typed refusal）；`resume`/`modelSwitch` 开放（`engine.test.ts` 更新后 968 项全绿）。
11. **Pi 对照**：desktop 全量 2663 项通过，Pi session 路径未回归；host-core 582 项通过。

## 4. 环境限制与未完成项

- 未开放能力：`steer`/`followUp`/`compact`（RPC 队列语义未接线，保持 typed refusal）；`subagentEvents`（M5/T17）。这些是明确的后续任务，不是遗漏。
- 平台：并发/进程终止仅在 Linux x64 实测（与 M1-M3 一致），macOS arm64 留待 M6。
- 无真实付费模型调用：所有运行验证用本地 fake provider（`experiments/omp-bridge/lib/provider.mjs`）。

## 5. 修改文件

host-core：`crates/host-core/src/db.rs`、`db/schema.rs`、`db/migrations.rs`、`db/repositories.rs`、`db/tests.rs`、`sessions.rs`、`rpc/mod.rs`、`plugins/providers/tests.rs`。
runtime 包：`packages/omp-runtime/src/supervisor.ts`、`src/index.ts`。
shared：`packages/shared/src/engine.ts`、`src/engine.test.ts`。
desktop：`apps/desktop/electron/main/runtime/omp-session.ts`（重写为 registry）、`omp-session-wiring.ts`（新增）、`omp-model-projection.ts`（新增）、`omp-runtime.ts`、`engine-runtime.ts`（未改）、`ipc/agent-ipc.ts`、`ipc/session-ipc.ts`、`ipc/register.ts`、`main/index.ts`。
测试：`apps/desktop/test/omp-session-bridge.test.mjs`、`omp-session-e2e.test.mjs`、`omp-model-projection.test.mjs`、`omp-secret-redaction.test.mjs`、`omp-session-persistence-e2e.test.mjs`（新增）。
文档：`app/docs/adr/0302-omp-session-persistence-and-runtime-registry.md`（新增）、本文件、`docs/04-task-board.md`、`HANDOFF.md`。

第五轮返修（J1-J5）增量：desktop `ipc/session-ipc.ts`（configure/rename `inconsistent` 移入 `data`；rename/configure fail-closed；moveProject/replaceMessages/saveRevision/listRevisions/activateRevision 引擎门；scratch 加引擎无关注释）。测试新增：`omp-session-ipc-result.test.mjs`、`omp-session-host-mutation-gates.test.mjs`；更新：`omp-session-configure-ipc.test.mjs`、`omp-session-archive-renderer.test.mjs`。

## 6. 下一任务

M5/T17 子代理面板与编排归属、T18 edit/LSP/DAP 结果展示、T19 MCP/规则/技能/记忆。`steer`/`followUp`/`compact` 的 RPC 队列接线与 `subagentEvents` 在 M5 逐项开放。
