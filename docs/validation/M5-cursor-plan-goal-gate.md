# M5/T20-R3C：Plan/Goal × Cursor 产品门 —— 证据、原子写入门与实现

更新时间：2026-09-27。状态：**已实现并验证（本阶段仅交付"用户确认的产品门"）**。

- 分支：`codex/m5-cursor-plan-goal-gate`。本文件描述**三轮独立复审返修后**的状态：复审 F1-F3 判定上一版把不变量放在桌面层不足以成立（`plans.enter` 由 sidecar 直连 host-core、桌面预读与写入之间存在 TOCTOU、跨 IPC 丢失 `mode`/`providerId`），F1-F4 轮已把不变量落到 **host-core 的持久化写入本身**并补齐拒绝载荷与中文镜像；**F5/F6 轮**把守卫改为**每连接 TEMP 触发器**（不再把触发器写进持久 schema，并清理 `876fb07` 留下的同名持久残留），并执行 rustfmt；**F7 轮（本文件本次更新重点）** 修正升级顺序：持久残留清理移到**迁移链之前**、TEMP 守卫仍在**迁移链之后**安装，使从 `876fb07` 直接跳到带新迁移的版本不再被旧守卫中止。
- 固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（omp/18.2.7）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`；**gitlink 与追踪内容未改动**。
- **严格 R3 仍不受支持**（R3A 补丁=风险收敛、R3B 实测严格契约 0/12），**T20-B/C/D 未开始、T20 未完成**；本阶段不声称严格 Cursor 兼容，也不重写 R3 的结论。
- 用户已明确选择产品选项 1：**Plan/Goal 模式不支持 Cursor 模型**。

## 0. 结论摘要

1. **不变量**：一个会话不得把"活跃的 Cursor 模型/提供方"与 Plan 或 Goal 模式组合在一起。
2. **强制点下沉到持久化写入**：`crates/host-core/src/plan_goal_guard.rs` 在每次打开数据库时在 host 持有的那条连接上安装两个 **TEMP** `sessions` 触发器（`INSERT` 与 `UPDATE OF mode, provider_id`，均 `ON main.sessions`），凡结果落入该组合的写入由 SQLite 本身中止。覆盖过渡工具（`plans.enter`）、`session.configure`、`session.create`、fork、导入与任何将来的写入者；条件在写入时对**数据库当前行**求值，因此调用方先读后写之间的并发更新不能把组合落盘（F1/F2）。**F5**：守卫是**每连接** TEMP 触发器——只存在于该连接的 `sqlite_temp_master`，连接关闭即消失，**不写入 `sqlite_master`、不推进 schema 版本**；`install` 先删除 `876fb07` 写进持久 schema 的同名触发器再安装（无 `IF NOT EXISTS`，修订定义总能替换旧定义）；裸 `sqlite3` 连接的手工写入不在守卫范围内，由派发门兜底（不夸大为"约束任意外部连接"）。**F7**：升级顺序固定——已识别 schema 的持久残留清理在**迁移链之前**、TEMP 守卫安装在**迁移链之后**（历史迁移会写受守卫列，如 v7→v8 把 `mode = 'chat'` 改成 `'plan'`，旧守卫若仍在就会把这类升级中止在 `PLAN_GOAL_CURSOR_UNSUPPORTED`，用户不该被迫先运行中间版本）；清理只针对模块拥有的两个确切名字、只在持久 schema，未识别数据库（`user_version=0` 且有表、或高于 `SCHEMA_VERSION`）先拒绝、且其中的同名触发器不会被清理。
3. **修复路径保留**：无效旧记录仍可打开、仍可做无关写入（仅当 mode/provider 完全保持原值），两条修复（去掉模式 / 改选提供方）都是普通写入；**旧记录在 plan 与 goal 之间的切换属于"新形成组合"，会被拒绝**（复审补充项）。派发门作为迁移/手工篡改数据的最后防线。
4. **稳定错误码**：`PLAN_GOAL_CURSOR_UNSUPPORTED`；host RPC 的 `plans.enter`/`session.configure`/`session.create`/`session.fork`/`session.import` 都返回该码而不是 `INTERNAL`；桌面拒绝错误统一构造，`data = { errorCode, mode, providerId }` 经 `register.ts` 作为 `error.details` 抵达渲染层（F3）。
5. **身份与字面量**：规范 provider id `"cursor"`（精确比较）。TS 与 Rust 各一份字面量，守卫 SQL 由 Rust 常量生成，跨语言一致性由测试钉住；不做名称/供应商/URL 猜测。
6. **测试**：host-core **先红后绿**（未修状态下 4 项判红，修复后整套 596/0）；新增 host-core 测试 14 项、桌面测试 20 项（其中 6 项为上一轮门测试更新，含 3 项跨语言一致性、3 项真实 wrapper/IPC 载荷、3 项 host 原子性/旧记录回归）。桌面全量 **2907 项 / 2903 通过 / 0 失败 / 4 跳过**；shared 491（src）/ i18n 25；workspace typecheck、`build:js`、lint、locale、docs 检查、gap 探针、矩阵 lint 均按既有结论。**F5/F6 轮**：plan_goal_guard 扩到 11 项（新增 5 项连接作用域/替换测试），未修状态 **4 项判红**、修复后 `cargo test -p host-core --locked` **601/0**；`cargo fmt --all -- --check` 由 exit 1 转 exit 0；桌面门套件 23/23（详见 §5.1/§5.3/§5.4）。

## 1. 用户决策与原不变量

**不变量（唯一权威表述）**：**一个会话不得把"活跃的 Cursor 模型/提供方"与 Plan 或 Goal 模式组合在一起。**

它与固定 OMP 能力的关系（不重写 R3）：PI 的过渡工具契约要求"提交工具独占整个 assistant 批次、同批兄弟零副作用、提交后终止"；Cursor 的 exec channel 在响应流式期间**已执行**工具调用（早于承载它的 assistant 消息）且副作用不可撤销，因此该契约在固定 OMP 上**不可实现**（`docs/validation/M5-omp-transition-patch.md` §2/§9/§10；R3A 补丁只收敛 loop 可控路径，R3B 实测严格契约检查 **0/12 成立**）。用户据此选择"产品层不支持该组合"，而不是伪造兼容或缩小验收口径。

## 2. PI Desktop 证据（先）

固定检出：`upstream/pi-desktop@0111e306`。本轮的额外对比（用于确认"新概念"以及沿用哪套既有机制）：

| 事实 | 坐标 |
| --- | --- |
| `plan_rpc_err` 从消息首个 token 取 `PLAN_*` 码，否则 `PLAN_INTERNAL` | `crates/host-core/src/rpc/mod.rs:873-882`（与 fork 逐字一致） |
| `session.configure` 处理器的映射规则：消息以 `PLAN_` 开头即走 `plan_rpc_err` | `crates/host-core/src/rpc/mod.rs:2194-2200`（与 fork 逐字一致） |
| `PlanManager::enter` 的 CAS 写入在事务内执行（`unchecked_transaction` + 受限 UPDATE） | `crates/host-core/src/plans/approval.rs:152-167`（与 fork 逐字一致） |
| schema 里已有触发器，但只有 3 个 messages FTS 索引触发器；**没有任何 provider/模式条件守卫** | `crates/host-core/src/db/schema.rs:162-173`；`grep -rn cursor upstream/pi-desktop/crates/host-core/src` 仅命中分页 cursor |
| `boot_maintenance` 用 `CREATE INDEX IF NOT EXISTS` 在每次打开时幂等补齐加索引（本实现的写入门也挂在打开路径上，但走的是"先 DROP 再建 TEMP 定义"，不用 `IF NOT EXISTS`） | `crates/host-core/src/db/migrations.rs:10-13` |

其余 PI-first 证据（模式权威状态、唯一写入者、模型只校验配置、无"模式×模型"先例、错误/本地化形状、最接近的测试）与上一轮记录一致，见本文件 §7 的复盘与 `docs/validation/M5-plan-goal-capability-gates.md`。要点：**PI Desktop 不存在任何"因模型/提供方而拒绝或隐藏模式"的代码路径或测试**（检索面见 §7.1），本门是新概念，必须显式论证。

## 3. 固定 OMP 证据（后）

固定检出：`upstream/oh-my-pi@d49918fab`。本轮自行核对（不依赖显示标签）：

| 事实 | 坐标 |
| --- | --- |
| provider id 规范字面量 `"cursor"` | `packages/catalog/src/compat/provider-ids.ts:21`（`KnownProvider` 联合） |
| provider 规则：`provider "cursor" {`，`label="Cursor"` 只是显示名 | `packages/catalog/src/compat/rules/providers/cursor.kdl:3,6` |
| api 侧字面量 `"cursor-agent"` | `packages/catalog/src/types.ts:21`、`packages/ai/src/api-registry.ts:31` |
| 消费者**内联比较字面量**，没有 `isCursor(model)` 之类的规范解析器 | `packages/agent/src/agent.ts:796`（`model.api !== "cursor-agent"`）、`packages/ai/src/providers/cursor.ts:4767-4768`（`msg.provider === "cursor"`） |

上游其余证据（模型标识与目录、会话内 `set_model`/`cycle_model` 与 `hasConfiguredAuth`、原生 plan/goal 但 rpc 无模式面、`set_host_tools` 无策略字段、会话文件不记录 provider/mode 的头部形状、无"模式↔模型"互斥代码）与上一轮记录一致。

## 4. 实现

### 4.1 host-core：写入本身不可落入组合（F1/F2；F5 改为每连接 TEMP 触发器）

`crates/host-core/src/plan_goal_guard.rs`：

- 常量：`CURSOR_PROVIDER_ID = "cursor"`、`PLAN_GOAL_CURSOR_UNSUPPORTED`；守卫 SQL 由这两个常量 `format!` 生成（不是第二份字面量）。
- **两阶段（F7）**：
  1. **迁移前**——`plan_goal_guard::clear_persistent_residuals`：`Database::open` 在确认版本受支持之后、进入 `match version` 迁移链之前调用；只对两个 guard 名字在 **main schema** 执行 `DROP TRIGGER IF EXISTS`，清掉 `876fb07` 写进 `sqlite_master` 的**持久残留**。必须在迁移前：历史迁移本身就会写受守卫列（`db/migrations.rs` 的 v7→v8 `UPDATE sessions SET mode = 'plan' WHERE mode = 'chat'`），残留触发器会让这类升级在清理发生前直接中止，而要求用户先运行中间版本才升级是不成立的。
  2. **迁移后**——`plan_goal_guard::install`：在该连接上、本次打开的**完整迁移链之后**（`boot_maintenance` 之前）执行；先对两个名字在 **main 与 temp 两个 schema** 做防御性 `DROP TRIGGER IF EXISTS`，再以 `CREATE TEMP TRIGGER … ON main.sessions` 安装当前定义（**不带 `IF NOT EXISTS`**，因此修订后的定义总能替换旧定义）。
  - `sessions_refuse_cursor_contract_ai`：`BEFORE INSERT ON main.sessions`，结果为 `mode IN ('plan','goal')` 且 `provider_id = 'cursor'` 时 `RAISE(ABORT, code)`。
  - `sessions_refuse_cursor_contract_au`：`BEFORE UPDATE OF mode, provider_id ON main.sessions`，同上条件**且** `NOT (old.mode = new.mode AND old.provider_id = new.provider_id)` ——即：已持有该组合的行只有在两个受守卫列**完全不变**时才允许被写；`plan+cursor → goal+cursor` 这类切换会被拒绝（复审补充项）。
- 清理范围与拒绝顺序（F7）：清理只删这两个确切名字（按 `GUARD_TRIGGER_NAMES` 逐个 `DROP`），不做前缀/`LIKE`/`GLOB` 匹配，因此 PI 的 `messages_ai`/`messages_ad`/`messages_au` 与用户自定义触发器都保留；`user_version = 0` 且已有表（"refusing to touch it"）与版本高于 `SCHEMA_VERSION`（"newer than supported"）在两个前置拒绝里就返回，**先于**任何清理，文件与其中的同名触发器都不被触碰；legacy v1..v6 走归档重建，同样不清理。
- 作用域（F5）：守卫只存在于该连接的 `sqlite_temp_master`，**连接关闭即消失**；`sqlite_master` 中不出现任何守卫，schema 版本保持 v21 不变，旧二进制之后再打开同一文件不会继承该行为。裸 `sqlite3` 连接（手工编辑）不受约束——这本就是既有"手工路径"，由桌面派发门兜底，不作为本门声称的覆盖范围。
- 覆盖：`plans.enter`（sidecar 直连）、`session.configure`、`session.create`、`session.fork`、`session.import`、以及任何将来的写入者；条件由 SQLite 在写入时按当前行求值，不存在"预读—写入"窗口。
- 错误码：`RAISE(ABORT, 'PLAN_GOAL_CURSOR_UNSUPPORTED')` 的消息就是该码；`plans.enter`/`session.configure` 原有 `PLAN_*` 映射直接生效；本轮把 `session.create`/`session.fork`/`session.import` 也改为同一映射（`session_write_rpc_err`），避免直接 host RPC 得到 `INTERNAL`。
- 旧数据策略：不阻断打开、不做静默改写；无关字段更新与两条修复可用，跨契约模式切换被拒；未被触发器覆盖的历史迁移结果由桌面派发门兜底。

### 4.2 桌面：触发器覆盖不到的边界 + 跨 IPC 载荷（F3）

| 层 | 文件 | 变更 |
| --- | --- | --- |
| 共享（谓词+载荷）| `packages/shared/src/plan-goal-model-gate.ts` | `planGoalCursorRefusal(mode, providerId)`（返回 `{errorCode, mode, providerId, message, data}`）与统一构造函数 `planGoalCursorError`；`data = { errorCode, mode, providerId }` 供 IPC 转发 |
| 共享错误码 | `packages/shared/src/errors.ts` | `PLAN_GOAL_CURSOR_UNSUPPORTED` |
| main 边界 | `apps/desktop/electron/main/ipc/agent-ipc.ts`（派发）、`session-ipc.ts`（新建、配置）| 三处都改为 `throw planGoalCursorError(refusal)`，`data` 随错误跨 IPC |
| 渲染层 | `stores/slices/session-slice.ts`、`features/chat/composer/hooks/useComposerModelMenu.ts`、`ComposerModelPicker.tsx` | 契约模式隐藏 Cursor 提供方并说明原因；store 在 IPC 之前用同一谓词拒绝并弹本地化提示；会形成组合的自动 pin 跳过 |
| i18n | 8 个 locale | `errors.PLAN_GOAL_CURSOR_UNSUPPORTED`（键集一致性由既有测试强制）|
| 规范/ADR | `docs/spec/03-runtime/02-agent-runtime.md` §16 + `docs/zh-CN/...` 同节、`08-error-codes.md` §3.2b + 中文镜像、ADR 0306 | 记录 host-core 写入门、稳定码、旧记录容忍规则与限制 |

**没有**改动的面：OMP/PI 子模块、patch artifact/manifest、`plans.ts`、既有错误码语义、Agent 模式与非 Cursor 提供方的任何行为。

## 5. 测试与验证

### 5.1 host-core 先红后绿（要求 1）

未修状态下（仅加入测试，未实现守卫；`cargo test -p host-core cursor`）**4 项判红**，恰好复现复审指出的漏洞：

| 测试 | 未修时的失败证据 |
| --- | --- |
| `plans::tests::enter_refuses_the_cursor_contract_combination_without_writing_the_mode` | `called Result::unwrap_err() on an Ok value: ()` —— `enter` 成功，`mode` 被写成 plan/goal |
| `sessions::tests::configure_refuses_the_cursor_contract_combination_in_both_directions` | `Ok(SessionSummary { provider_id: Some("cursor"), mode: "plan", … })` —— 组合被持久化 |
| `sessions::tests::create_refuses_the_cursor_contract_combination` | `Ok(SessionSummary { provider_id: Some("cursor"), mode: "plan", … })` —— 新建即写入组合 |
| `rpc::tests::cursor_contract_refusals_keep_their_code_at_the_rpc_boundary` | `Ok(Object {"ok": true, "state": "planning"})` —— sidecar 直连 host 的 `plans.enter` 直接把 mode 写成 plan |

同一轮中非 Cursor 回归测试（`enter_still_writes_the_mode_for_a_non_cursor_provider`、`configure_leaves_non_cursor_and_agent_combinations_alone`）**通过**，证明红项不是环境问题。

修复后：`cargo test -p host-core` → **596 通过 / 0 失败**（新增 14 项）。

**F5/F6 轮补充（本文件更新重点）**：在 `876fb07`（`CREATE TRIGGER`，写进持久 `sqlite_master`）上新增 5 项连接作用域测试与 1 项 SQL 形状断言，**4 项测试判红**，红项正是复审 F5 指出的问题：

| 测试 | 未修时的失败证据（实测输出） |
| --- | --- |
| `the_guards_are_connection_scoped_temp_triggers` | `assertion left == right failed, left: [], right: ["sessions_refuse_cursor_contract_ai", "sessions_refuse_cursor_contract_au"]`——守卫不在 `sqlite_temp_master`，而在 `sqlite_master`（持久） |
| `the_guards_die_with_the_connection_and_return_on_the_next_open` | `assertion failed: guard_trigger_names(&raw, "sqlite_master").is_empty()`——关闭 `Database`、用裸 `Connection::open` 重开后仍能查到守卫 |
| `install_replaces_the_persistent_triggers_an_older_build_left_behind` | `assertion failed: guard_trigger_names(db.conn(), "sqlite_master").is_empty()`——新的 `Database::open` 不清理 `876fb07` 留下的同名持久触发器 |
| `install_replaces_a_stale_connection_definition_instead_of_keeping_it` | 安装后 temp 定义仍是 `BEGIN SELECT 1; END;`（`IF NOT EXISTS` 跳过了替换），断言 `!sql.contains("SELECT 1")` 失败 |

`apps/desktop/test/plan-goal-cursor-constant-parity.test.mjs` 的 SQL 形状断言同步更新（要求 `CREATE TEMP TRIGGER`、`ON main.sessions`、无 `IF NOT EXISTS`、`clear_sql` 同时 DROP main 与 temp），对 `876fb07` 的旧源码同样判红（`/BEFORE INSERT ON main\.sessions/` 与 `/CREATE TEMP TRIGGER/` 均不匹配）。

**F6**：`cargo fmt --all -- --check` 在 `876fb07` 上 **exit 1**——`plan_goal_guard.rs` 4 处、`sessions.rs` 5 处，全部落在本轮新增代码内（未修时实测 `9` 个 `Diff in`）。修复后（§5.4）：上述测试全绿，`cargo fmt --all -- --check` exit 0，且 `cargo fmt --all` 只改动这两个 Rust 文件（`sessions.rs` 为纯换行折叠，无语义改动）。

**F7 轮（本文件本次更新重点）**：新增 4 项 `Database::open` 级回归测试（真实打开、真实迁移，不直接调用清理 helper、不比较源码字符串），其中 **1 项在 `692994c` 上判红**：

| 测试 | 未修时的失败证据（实测输出） |
| --- | --- |
| `open_clears_the_legacy_durable_guard_before_migrating` | `called Result::unwrap() on an Err value: apply schema v7 to v8 migration; backup /tmp/.tmpnAtNCw/pi.sqlite.v7.bak remains` / `Caused by: 0: PLAN_GOAL_CURSOR_UNSUPPORTED 1: Error code 1811: constraint failed`——夹具是一个可识别的 v7 文件（`user_version = 7`、`plan_approvals` 已按 v7 形状移除），其中植入了 `876fb07` 的两个持久触发器并放入一行 `mode='chat' + provider_id='cursor'`；`692994c` 把清理放在迁移链之后，v7→v8 的 `UPDATE sessions SET mode = 'plan' WHERE mode = 'chat'` 因此在旧触发器仍然生效时中止了升级 |

同一轮里 `open_refuses_an_unversioned_database_without_clearing_the_guard`、`open_refuses_a_newer_schema_without_clearing_the_guard`、`open_removes_only_the_two_owned_trigger_names` 在 `692994c` 上即为绿色——它们钉住的是**不能被改坏**的边界（拒绝优先于清理、只删两个确切名字），不是本轮新漏洞；修复后仍绿。

`apps/desktop/test/plan-goal-cursor-constant-parity.test.mjs` 新增第 4 项形状断言（`persistent_residual_clear_sql` 只 DROP `main.`、不做 `LIKE`/`GLOB` 扫描；`Database::open` 中清理调用早于 `migrate_v7_to_v8(&conn)`、`plan_goal_guard::install` 晚于它）；行为证明仍由上面那项 `Database::open` 测试承担，形状断言只防止两阶段被重新合并而无人察觉。

### 5.2 本轮新增/更新的测试清单

| 文件 | 项数 | 覆盖 |
| --- | --- | --- |
| `crates/host-core/src/plan_goal_guard.rs`（`mod tests`）| 15 | INSERT 对 plan/goal×cursor 拒绝、对 agent/其它 provider/空值/精确近似值放行；UPDATE 拒绝"进入组合"；旧记录无关写入与两条修复可用、**plan⇄goal 切换被拒**；`uninstall/install` 证明守卫本身就是拒绝来源；守卫文本由常量生成；**连接作用域（F5，新增 5 项）**：定义只在 `sqlite_temp_master`、`sqlite_master` 无守卫、`ON main.sessions`；关闭 `Database` 后裸连接无守卫且测试明确断言"裸连接写入该组合成功"（= 手工路径不受约束），下次 `Database::open` 重新安装并拒绝；`876fb07` 的持久残留被删除并替换为 temp 定义；旧 TEMP 定义被替换而非因 `IF NOT EXISTS` 保留；`uninstall` 两个 schema 都不残留；**升级顺序（F7，新增 4 项，全部走真实 `Database::open`）**：① v7 夹具（`user_version = 7`、`chat + cursor` 行、已植入 `876fb07` 的两个持久触发器）必须先清理后迁移——升级完成后该行变成 `plan + cursor`、schema 到 `SCHEMA_VERSION`、`sqlite_master` 无守卫、本连接 temp 恰有两个守卫，且此后**新写入仍被拒**（插入 plan+cursor、把该历史行切到 goal 都被拒）；② `user_version=0` 且已有表仍 "refusing to touch it"，且其中两个同名触发器**不被清理**、不出现 temp 守卫；③ 版本高于 `SCHEMA_VERSION` 同样先拒绝，同样不清理、不改动；④ 只删两个确切名字——PI 原有的 `messages_ai`/`messages_ad`/`messages_au` 与另建的 `sessions_refuse_cursor_contract_ai_backup` 全部保留 |
| `crates/host-core/src/plans/tests.rs` | 2 | `enter` 对 plan/goal×cursor 拒绝且零写入（无 mode/无审批行/无审计）、非 Cursor 照常写入 |
| `crates/host-core/src/sessions.rs`（`mod tests`）| 5 | configure 双向拒绝 + 两条修复 + 非 Cursor/近似值放行；create 拒绝且零持久化；**旧无效记录跨契约模式切换被拒**且同值写回/修复放行；**写入时按数据库当前行判定**（模拟"桌面预读后另有更新"的 TOCTOU，断言仍被拒且状态未变）|
| `crates/host-core/src/rpc/mod.rs`（`mod tests`）| 1 | 直接 host RPC 的稳定错误码：`plans.enter`（plan/goal）、`session.configure`（进入模式、绑定 cursor）、`session.create`，且既有"运行中回合→`PLAN_CONFIGURATION_BLOCKED`"语义不变 |
| `apps/desktop/test/plan-goal-cursor-constant-parity.test.mjs` | 4 | TS↔Rust 的 `cursor` 字面量、错误码字面量与 `ErrorCodes` 一致；守卫 SQL 由常量生成且不含硬编码 `'cursor'`；守卫覆盖 INSERT/UPDATE 且 UPDATE 的容忍条件为"完全同值"；**（F5）强制 `CREATE TEMP TRIGGER`、`ON main.sessions`、无 `IF NOT EXISTS`，并要求清理语句同时 DROP main 与 temp 两种残留**（防止回退到持久触发器）；**（F7）要求持久清理是独立函数、只 DROP `main.`、无 `LIKE`/`GLOB`，并要求 `Database::open` 中"清理 → 迁移 → 安装 TEMP"的顺序**（防两阶段被合并；行为证明见 §5.1 的 `Database::open` 测试） |
| `apps/desktop/test/omp-session-ipc-result.test.mjs`（新增 3 项）| 3 | 经**真实 `registerIpcHandlers`/`wrap`**：configure 拒绝保留 `error.code` 与 `error.details = {errorCode, mode, providerId}`；create 同样；真实渲染层 `api.configureSession` 捕获的 Error 同样携带 code 与 details |
| `apps/desktop/test/plan-goal-cursor-gate.test.mjs` | 10 | 真实 IPC 处理器的行为测试（派发/配置/新建三向拒绝 + 两条出路 + 非 Cursor 回归 + 近似值不误伤），并断言抛出载荷含 `data` |
| `apps/desktop/test/plan-goal-cursor-renderer.test.mjs` | 4 | 渲染层契约：错误码注册+中英文本、模型菜单隐藏 Cursor 提供方并渲染提示、store 守卫先于 IPC、pin 守卫先于乐观写入 |
| `packages/shared/src/plan-goal-model-gate.test.ts` | 7 | 谓词边界表（plan/goal×cursor 拒绝、agent×cursor 放行、其它 provider 与近似值放行、legacy/缺失值不冲突）＋ `data` 载荷＋统一构造函数 |

### 5.3 失效性对照（红/绿对照，均实跑）

| 对照 | 做法 | 结果 |
| --- | --- | --- |
| host-core 守卫缺失 | 仅加测试、未实现 | 4 项判红（§5.1） |
| 桌面门缺失（上一轮） | 临时移除 `agentPrompt`/`sessionConfigure`/`sessionCreate` 门并复原 | 10 项行为测试中 **6 项判红** |
| UPDATE 守卫过宽（复审补充项的对照） | 把容忍条件临时改回 `NOT (old.mode IN ('plan','goal') AND old.provider_id='cursor')` 并复原 | 3 项旧记录测试**全部判红**（`plan+cursor → goal+cursor` 被放行） |
| F3 载荷缺失 | 临时移除共享谓词的 `data` 块并复原 | `omp-session-ipc-result` 与 `plan-goal-cursor-gate` **两个文件全红**（`error.details` 丢失）|
| **F5 守卫仍是持久触发器**（`876fb07` 的实际状态） | 只加连接作用域测试与形状断言，不改实现 | **4 项判红**：temp schema 无守卫 / 关闭重开后 `sqlite_master` 仍有守卫 / 新 open 不清理持久残留 / 旧 TEMP 定义未被替换（§5.1） |
| **F5 保留 `IF NOT EXISTS`** | 安装前不 DROP 旧 TEMP 定义 | `install_replaces_a_stale_connection_definition_instead_of_keeping_it` 判红（`SELECT 1` 旧定义仍在，跨语言形状断言亦要求无 `IF NOT EXISTS`） |
| **F6 未格式化** | 在 `876fb07` 上直接跑 `cargo fmt --all -- --check` | exit 1（`plan_goal_guard.rs` 4 + `sessions.rs` 5 = 9 处 `Diff in`） |
| **F7 清理晚于迁移**（`692994c` 的实际状态） | 只加 `Database::open` 级回归测试，不改实现 | `open_clears_the_legacy_durable_guard_before_migrating` 判红：v7 夹具的 `chat + cursor` 行在清理发生前被 `876fb07` 的持久触发器中止在 v7→v8 迁移里（`PLAN_GOAL_CURSOR_UNSUPPORTED`，§5.1） |
| **F7 清理范围过宽**（变异对照） | 临时让 `persistent_residual_clear_sql` 额外 DROP `sessions_refuse_cursor_contract_ai_backup`（等价于按前缀多删一个）并复原 | `open_removes_only_the_two_owned_trigger_names` 判红：`left: ["messages_ad", "messages_ai", "messages_au"] / right: [..., "sessions_refuse_cursor_contract_ai_backup"]` |
| **F7 先清理再拒绝**（变异对照） | 临时把 `clear_persistent_residuals` 提到两个前置拒绝之前并复原 | `open_refuses_an_unversioned_database_without_clearing_the_guard`、`open_refuses_a_newer_schema_without_clearing_the_guard` 同判红（`left: 0 / right: 2`——被拒绝的文件里同名触发器已被清掉） |

### 5.4 实跑命令与结果

环境：Node v24.14.0、pnpm 10.34.5、Bun 1.4.2、Rust stable 1.95.0（`cargo test -p host-core`）。工作目录 `app/`（desktop 套件在 `app/apps/desktop/`）。全部使用本地夹具/fake，**未调用任何付费或远程模型**。

| 命令 | 结果 |
| --- | --- |
| `cargo test -p host-core` | **596 通过 / 0 失败**（新增 14 项；§5.1 的未修状态 4 红已记录） |
| `cargo test -p host-core cursor` / `… legacy` | 7/7 与 83 项中的 3 项旧记录测试通过（对照见 §5.3） |
| `env -u SSH_ASKPASS node --test --test-reporter=tap test/*.test.mjs`（`app/apps/desktop/`） | **2907 项 / 2903 通过 / 0 失败 / 4 跳过** |
| `npx vitest run --root packages/shared src` | **491 通过 / 0 失败**（43 文件）|
| `pnpm --filter @pi-desktop/shared test` | 982 通过（86 文件；含 `dist/` 中编译副本，属该包既有行为） |
| `pnpm --filter @pi-desktop/i18n test` | **25 通过 / 0 失败** |
| `pnpm typecheck`（workspace） | 全部包 Done（0 错误）|
| `pnpm build:js` | exit 0 |
| `pnpm lint`（biome 75 文件 + style tokens） | 0 问题 |
| `node docs/scripts/check-locales.mjs` | `Verified 79 English/Chinese specification pairs` |
| `node docs/scripts/check-docs.mjs` | 仍仅 6 项**预存在**问题（§6.2），本阶段新增页/节零新增 |
| `node --test apps/desktop/test/error-code-registry.test.mjs` | 2/2（新码已进 `08-error-codes.md`；host 发出的码全部已注册）|
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | **3 缺口 exit 1**（g1/g2/g3 未变：本阶段不实现 OMP Plan/Goal 运行时面）|
| `node scripts/check-t20-matrix-ids.mjs` | `MATRIX-ID-OK` exit 0 |
| `git diff --check` / `git show --check HEAD` | exit 0 |
| 子模块 | OMP `d49918fab`、PI `0111e306`；gitlink 与追踪内容未改动（子模块内仅有被上游 `.gitignore` 覆盖的构建载荷）|

**F5/F6 轮（本文件更新重点）实跑**：

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --all -- --check` | 返修前（`876fb07`）**exit 1**：9 处 `Diff in`（`plan_goal_guard.rs` 4 + `sessions.rs` 5）；`cargo fmt --all` 后 **exit 0**，改动只落在本轮这两个 Rust 文件，`sessions.rs` 为纯换行折叠（无语义改动），无无关大面积格式化 |
| `cargo test -p host-core --locked` | **601 通过 / 0 失败**（新增 5 项连接作用域/替换测试；§5.1 记录未修状态 4 红） |
| `cargo clippy -p host-core --all-targets --locked` | exit 0，仅 1 项**基线已有** warning：`crates/host-core/src/user_skills.rs:921` `useless_format`（父提交 `b2d25b` 同一行同一原因，该文件在本分支未改动） |
| `env -u SSH_ASKPASS node --test test/plan-goal-cursor-constant-parity.test.mjs test/plan-goal-cursor-gate.test.mjs test/omp-session-ipc-result.test.mjs test/plan-goal-cursor-renderer.test.mjs`（`app/apps/desktop/`） | **23 通过 / 0 失败** |
| `node --test apps/desktop/test/error-code-registry.test.mjs` | 2/2 |
| `node docs/scripts/check-locales.mjs` | `Verified 79 English/Chinese specification pairs` |
| `node docs/scripts/check-docs.mjs` | 仍仅 6 项**预存在**问题（§6.2），本轮修改节零新增 |
| `git diff --check` / `git show --check HEAD` | exit 0 |
| 本轮**未重跑** | desktop 全量 2907 项、shared/i18n/typecheck/build:js/lint、gap 探针与矩阵 lint（改动为 Rust 实现/注释 + 跨语言形状断言 + 文档；Rust 侧已全量重跑） |

**F7 轮（本文件本次更新重点）实跑**：

| 命令 | 结果 |
| --- | --- |
| `cargo test -p host-core --locked plan_goal_guard`（修复前 `692994c`） | **14 通过 / 1 失败**：`open_clears_the_legacy_durable_guard_before_migrating` 红，失败文本即 §5.1 记录的 `PLAN_GOAL_CURSOR_UNSUPPORTED`（v7→v8 迁移被旧持久触发器中止） |
| `cargo test -p host-core --locked plan_goal_guard`（修复后） | **15 通过 / 0 失败** |
| `cargo test -p host-core --locked` | **605 通过 / 0 失败**（新增 4 项 `Database::open` 级回归测试） |
| `cargo fmt --all -- --check` | 修复前 exit 1（本轮改动的 2 处 `Diff in`，均在新增代码内）；`cargo fmt --all` 后 **exit 0**，改动只落在 `plan_goal_guard.rs` 与 `db/repositories.rs`，无无关格式化 |
| `cargo clippy -p host-core --all-targets --locked` | exit 0，仅 1 项**基线已有** warning：`crates/host-core/src/user_skills.rs:921` `useless_format`（该文件在父提交 `876fb07` 与本提交之间**零差异**，`git diff 876fb07 HEAD -- crates/host-core/src/user_skills.rs` 为空；同一行同一原因，本分支从未改动该文件） |
| `env -u SSH_ASKPASS node --test test/plan-goal-cursor-constant-parity.test.mjs test/plan-goal-cursor-gate.test.mjs test/omp-session-ipc-result.test.mjs test/plan-goal-cursor-renderer.test.mjs`（`app/apps/desktop/`） | **24 通过 / 0 失败**（parity 由 3 项增至 4 项） |
| `node --test apps/desktop/test/error-code-registry.test.mjs` | 2/2 |
| `node docs/scripts/check-locales.mjs` | `Verified 79 English/Chinese specification pairs`（英中 §3.2b 与 §16 同步修改后仍配对；表格/围栏形状未变） |
| `node docs/scripts/check-docs.mjs` | 仍仅 6 项**预存在**问题（§6.2），本轮修改页零新增 |
| 变异对照（均复原） | 见 §5.3 两行：清理范围过宽 → `open_removes_only_the_two_owned_trigger_names` 判红；清理早于拒绝 → 两项拒绝测试判红 |
| `git diff --check` | exit 0 |
| 本轮**未重跑** | desktop 全量 2907 项、shared/i18n/typecheck/build:js/lint、gap 探针与矩阵 lint（改动为 Rust 打开顺序 + 注释 + 跨语言形状断言 + 文档） |

### 5.5 因本次改动同步的既有测试夹具

`session-ipc.ts` 新增对 `@pi-desktop/shared` 的导入后，三个用**手写 shared 桩**转译加载 main 模块的测试文件（`engine-session-ipc`、`omp-session-configure-ipc`、`omp-session-ipc-result`）需要让桩包含该模块：现在通过 `helpers/ts-import-hooks.mjs` 加载 `packages/shared/src/plan-goal-model-gate.ts` 并展开进桩。三处均为夹具依赖面同步，断言未改。

## 6. 限制、未做与预存在缺陷

1. **不声称严格 Cursor 兼容**：R3 仍为硬阻塞（严格契约 0/12）；本阶段不实现 Plan/Goal 的 OMP 运行时面（提示词/目录/提交/审批/派发均属 T20-B/C/D，未开始）。
2. **预存在缺陷（非本阶段引入，未修）**：`app/docs/scripts/check-docs.mjs` 在**本阶段起点提交**上即报 6 项——`adr/0301-omp-session-surface.md` 的 H1 不以 `ADR` 开头（`git show HEAD:app/docs/adr/0301-omp-session-surface.md` 第一行即 `# 0301 — …`），以及 `adr/0301`–`adr/0305` 五行缺失于 `adr/README.md` 索引。本阶段只为自己的 ADR 0306 添加索引行，其余保持原样以免混入无关改动。
3. **旧数据的边界与守卫的连接作用域（能力事实，非"不变量未落实"）**：守卫只约束**写入**，且（F5 起）是**每连接 TEMP 触发器**。由迁移或手工编辑产生的、守卫存在之前就已持有该组合的行仍会保留在库中——它们不能被继续写入该组合、也不能在契约模式之间切换，但记录本身仍在，直到用户走修复路径；这类行的**运行**由桌面派发门拒绝。裸 `sqlite3` 连接的手工写入不受守卫约束（本就不在覆盖范围内），正是上述手工路径。F5 之前守卫写进持久 schema，会让旧版（降级后的）二进制继承一个它不认识的产品行为；改为 TEMP 后该跨版本污染已消除，且 F7 把这层清理固定在**迁移链之前**——历史迁移会写受守卫列（v7→v8 `chat`→`plan`），若清理仍在迁移之后，从 `876fb07` 直接跳版本升级会被旧守卫中止在 `PLAN_GOAL_CURSOR_UNSUPPORTED`。升级**不清洗历史迁移的结果本身**：迁移允许产出 `plan + cursor` 这类行，它们的运行仍由桌面派发门兜底（与本条前半段一致；"打开即自动修复/拒绝打开"仍属另一项产品决策，不在本阶段）。
4. **未做**：未做 UI E2E（`verify:ui:*` 需用户显式要求；本阶段为真实 IPC/wrapper 行为测试 + 渲染层契约测试）；未做 macOS 实机复核（本机 Linux）。另需明确：桌面既有测试套件**不启动真实 host-core 二进制**（Rust 侧由 `cargo test -p host-core` 覆盖），两侧目前靠"错误码/字面量契约 + 同一份守卫定义（每连接 TEMP 触发器）"衔接，没有跨进程集成测试——这是既有状况，本阶段未新增该层，也未声称有。**F7 轮**同样**未重跑** desktop 全量 2907 项与 shared/i18n/typecheck/build:js/lint/gap 探针，只重跑桌面门套件（24/24）、`error-code-registry`（2/2）、locale/docs 检查与 Rust 全量（605/0）+ clippy + fmt（§5.4）。
5. **未声称**：未声称本阶段解决了 OMP 的 Plan/Goal 能力（G1/G2/G3 仍开放）；未声称 Cursor 传输在其它引擎/未来构建中不可达（只声称**当前构建**的可达性）。

## 7. 证据来源与核验方式

1. 上游（PI/OMP）行号来自本阶段的**只读源码检索**，其中本轮新引用的 PI 对比（`plan_rpc_err`、configure 映射、`enter` CAS、schema 触发器、`boot_maintenance` 幂等 DDL）与 OMP 身份（`provider-ids.ts`、`cursor.kdl`、`types.ts`、`api-registry.ts`、内联比较点）**由本轮直接读取核对**。
2. host-core 与桌面测试数字均为本机实跑输出；未运行的命令在 §6.4 明确列出，不写成"通过"。
3. 检索面（PI Desktop 无"模式×模型"先例）：`crates/host-core/src` 上的 `MODE_NOT_SUPPORTED|INCOMPATIBLE|unsupported_mode|support.*mode`；`packages/**`、`apps/**` 上的 `mode.*incompatib|MODE_UNSUPPORTED|supportsPlan|supportsGoal|requiresModel`；`packages/agent-runtime/src`+`apps/desktop/src` 上的 `mode.*(unavailable|disabled|blocked)|only available in|not available in`；`apps/desktop/test`+`crates/host-core/src` 上的 `mode.*"model"|"model".*mode`。全部为空（仅命中工具级文案与无关的模型不可用标签）。

## 8. 下一轮入口

- 无（T20 仍受阻）。解除 R3 需要：上游 OMP 提供批次可见/终止能力、用户显式接受语义差异、或把提交移出模型循环（三者皆需上游变更或用户决定，见 `docs/validation/M5-plan-goal-capability-gates.md` §6.3/§8）。
- 仍关闭：`branch`/`steer`/`followUp`/`compact`、子代理单独停止、子代理 `hasUI=false` 工具 gating、PI agent 扩展注入。
