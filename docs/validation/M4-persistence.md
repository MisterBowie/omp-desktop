# M4 验证记录：会话持久化、模型投影与并发注册表（T14-T16）

更新时间：2026-09-23。基线：`d420048ad9f82429e6117b3009c6fa53fd2f085f`，分支 `codex/m4-persistence`。
参考子模块固定且干净：PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`，OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`。

## 0. 结论摘要

- T14（会话字段/迁移/恢复/归档/分支）、T15（模型投影/凭证脱敏）、T16（并发注册表/故障恢复）实现完成并验证。
- 数据责任：OMP 原生 transcript 仍是唯一权威写入者；host-core 只保存版本化引用（`engine_adapter_version`/`engine_runtime_version`/`native_session_id`/`native_session_path`，schema v21），通过 `session.bindEngine`/`session.getEngineRef` 两个主机边界 RPC 读写，renderer 不接触原生绝对路径。
- 原生 session 文件落在应用自有持久目录 `<dataRoot>/omp-sessions`（`--session-dir`），与每次运行的临时 HOME/config/log/凭证分离，stop/reclaim 不删除。
- 每个桌面 session 有独立 supervisor/runtime/原生 transcript/工作目录/模型投影/审批注册表；侧栏切换不改变后台 session 的 cwd、模型或事件归属。
- 能力开放：`resume`/`branch`/`modelSwitch` 真实接线后开放；`steer`/`followUp`/`compact` 保持关闭（RPC 队列语义未接线），拒绝路径不回退 Pi。

## 1. 功能 → PI 实现/测试 → OMP 实现/测试 → 本项目决定 证据表

| 功能 | PI 实现/测试 | OMP 实现/测试 | 本项目决定 |
| --- | --- | --- | --- |
| 会话元数据与迁移 | `crates/host-core/src/db/migrations.rs`（v7→v20 链）、`db/tests.rs`（`v19_database_migrates_to_session_engine` 等）、`src/sessions.rs`（`SessionSummary`/`create_session_with_options`） | 无（原生会话由 OMP 管） | 沿用 host-core 迁移规范，v20→v21 加 4 个可空列（非 JSON blob），`db/tests.rs::v20_database_migrates_to_native_session_reference` 红绿覆盖 |
| 会话创建/查询 | `rpc/mod.rs` `session.create`/`session.get`、`apps/desktop/test/session-create.test.mjs`、`session-model.test.mjs` | `new_session`/`get_state`/`get_messages`（`rpc-types.ts`、`rpc-mode.ts:553`、`rpc-client.ts:631`） | 首次 OMP 会话走真实 RPC `new_session`→`get_state`，校验 `sessionId/sessionFile` 后 `session.bindEngine` 持久化 |
| 命名 | `session.rename`、`apps/desktop/test/session-rename.test.mjs` | `set_session_name`（`rpc-types.ts:80`、`rpc-mode.ts`） | OMP 名称经 `set_session_name` 协调，成功后才 `session.rename` 持久化（`session-ipc.ts`）；失败不留两套名称 |
| 归档/侧栏 | `packages/shared/src/session-presentation.ts`（`sessionIsArchived` 展示态）、`apps/desktop/test/app-store-sidebar.test.mjs` | 无对应 | 复用 PI 展示态归档/侧栏刷新，归档只改产品可见状态，不删原生文件 |
| 恢复 | 原生 Pi 会话 `native-pi-session.ts` 恢复（`SessionManager.open`） | `switch_session(sessionPath)`（`rpc-types.ts:76`、`session-manager.ts:1835` 采纳 header cwd） | 新进程用同一 session 引用 `switch_session(sessionPath)` 后恢复历史，不重放 prompt/工具/审批（`omp-session-persistence-e2e.test.mjs`） |
| 分支 | `session-fork.test.mjs`、`fork_session_through` | `get_branch_messages`→`branch(entryId)`（`rpc-types.ts:77-78`、`e06-session.mjs`） | 用原生 entry identity 调 `branch`，新桌面 session + 新原生映射，父子不共用原生 sessionFile |
| 模型/思维 | `packages/shared/src/types/providers.ts`（`ProviderPublic`/`ModelBinding`）、`runtime/provider-catalog.ts`、`session-thinking.test.mjs`、`session-configuration-staging.test.mjs` | `get_available_models`/`set_model`/`set_thinking_level`（`rpc-types.ts:48-53`）、`models.yml`（`config/models-config-schema-bundle.ts`、`config/model-registry.ts:429`） | 最小投影：只投影目标 provider/model，`models.yml` 写进临时 agent 目录；`set_model`/`set_thinking_level` 成功并持久化后才生效，失败保持旧绑定 |
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
| `node --test test/*.test.mjs`（`env -u SSH_ASKPASS`，desktop 全量） | **2605 passed / 0 failed / 4 skipped**（2609 项） | 0 |
| `pnpm typecheck`（12/13 workspace 包） | 通过 | 0 |
| `pnpm build:js` | 通过（含 desktop renderer 打包） | 0 |
| `cargo build --release -p host-core --locked` | 通过 | 0 |
| `git diff --check` | 无输出 | 0 |

新增定向测试：`apps/desktop/test/omp-model-projection.test.mjs`（5 项）、`apps/desktop/test/omp-secret-redaction.test.mjs`（2 项 canary）、`apps/desktop/test/omp-session-persistence-e2e.test.mjs`（1 项真实 runtime 持久化/恢复/并发）、`omp-session-bridge.test.mjs`（28 项，升级到 per-session registry 语义）、`crates/host-core/src/db/tests.rs`（迁移 v21 + bindEngine 4 项）。

## 3. 先红后绿证据

1. **迁移 v20→v21**：`v20_database_migrates_to_native_session_reference` 先造 v20 形状（DROP 4 列、`user_version=20`），重开断言 4 列存在且旧记录读回 `engine=pi`、引用字段全 `None`；`bind_engine_ref_persists_and_reads_back_native_handles` 断言 OMP 会话 bind 后读回；`bind_engine_ref_refuses_pi_sessions_and_blank_handles` 断言 Pi 会话/空 id/未知 session 的拒绝路径。首次运行暴露 v20→v21 未在 post-match 链中续读版本号（`migrate_v19_to_v20` 后缺 `migrated_version` 重读），修复后 12 个既有迁移测试由失败转绿。
2. **持久化真实 native id/path 且关闭 runtime 后文件仍在**：`omp-session-persistence-e2e.test.mjs` 断言 `get_state` 的 `sessionFile` 落在 `sessionDir`（非 runRoot），`disposeSession` 后 `existsSync(sessionPath)` 仍为真。
3. **新进程恢复相同会话**：同一测试用 `nativeSessionPath` 重开，断言历史恢复、0 个旧工具执行、目标文件 mtime/content 不变（restore 不重放）。
4. **缺失/损坏/越界引用**：`omp-session.ts` 的 `ensureNativeSession` 对 `switch_session` 返回 `cancelled`/`success:false` 抛 `OMP_RESTORE_FAILED`，不新建替代会话（bridge 测试 + registry 语义覆盖）。
5. **rename/archive/open/branch 主路径与失败**：`session-ipc.ts` 重命名失败抛 `ENGINE_CAPABILITY_UNAVAILABLE`；`branch` 断言父子 `nativeSessionPath` 不同（e2e 步骤 3 + `branch` 校验 `nativeSessionPath === entry.nativeSessionPath` 拒绝）。
6. **模型投影只出现目标模型 + 默认变化不改旧 session**：`omp-model-projection.test.mjs` 断言只一个 `- id:`；投影固定于 session 绑定的 provider/model；`set_model`/`set_thinking_level` 失败返回 `{ok:false}` 且不改绑定。
7. **canary secret 不泄漏**：`omp-secret-redaction.test.mjs` 断言合成 key 只落在临时 `models.yml`，不在日志、事件 envelope、持久引用、文档/快照。
8. **并发隔离**：`omp-session-persistence-e2e.test.mjs` 断言两个 session 各写各的 marker、cwd 不同、停止一个不影响另一个（`runtimes.length===2` 见 bridge 测试）。
9. **崩溃/重启不重放、旧审批不跨进程放行**：runner 的 generation 单次消费 + `resolveUiRequest` 绑定 session/generation（M3 已证），M4 恢复路径复用同一语义（`omp-session-bridge.test.mjs` 28 项全绿）。
10. **未开放能力拒绝不改持久状态**：`steer`/`followUp`/`compact` 保持关闭，`engine-router` 拒绝（`engine.test.ts` 断言 `steer===false` 与 typed refusal）；`resume`/`branch`/`modelSwitch` 开放（`engine.test.ts` 更新后 968 项全绿）。
11. **Pi 对照**：desktop 全量 2605 项通过，Pi session 路径未回归；host-core 582 项通过。

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

## 6. 下一任务

M5/T17 子代理面板与编排归属、T18 edit/LSP/DAP 结果展示、T19 MCP/规则/技能/记忆。`steer`/`followUp`/`compact` 的 RPC 队列接线与 `subagentEvents` 在 M5 逐项开放。
