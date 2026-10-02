# M5/T20-B1：生产 mode/policy 状态与合约工具目录 —— 验证记录

更新时间：2026-10-02。状态：**T20-B1 完成；T20 整体仍未完成（T20-C / T20-B2 / T20-D 未开始，`plan`/`goal` 能力保持关闭）**。

- 分支：`codex/m5-t20-b1-runtime-state`，基线 `27d5c88a1334b32dbd8c8ac17a6c262e81a8df32`（追加提交，不 amend/rebase/强推，不创建 PR、不发布）。
- 工作树：`/home/vv/person/code/omp-desktop-m5-t20-b1`；固定子模块：OMP `62bc57be1b03ef0802a33cf7f5f530e534527531`（omp/18.3.0）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`；patch level `62bc57b+omp-desktop.3`（fork commit `6226f805e92654344de04def413fa5cb91cb16b9`，本阶段**未改**）。
- 环境：Linux x64；Node v24.14.0；Bun 1.4.2（`/home/vv/.bun/bin`）；rustc 1.95.0。所有运行使用本地 FakeProvider 与固定/已补丁 OMP 源码，无付费/远程模型调用。

## 1. 交付与阶段边界

本阶段把 mode/permissionMode 从"只持久化"变成**每 prompt 的真实生产状态**，并把目录、模式块与工具策略表接到同一个快照：

- 运行范围状态 schema v2（`<runRoot>/desktop-state.json`）：`mode`、生产 `composeModeSystemPrompt(mode, "")` 块、**已解析**的有效 `permissionMode`、每宿主工具 `{name, risk, planSafeActions, origin}` 策略表 + T19-C 的技能/记忆；单一写者（bridge，每 prompt 一次组装）、单一读者（gate）。
- 策略半部分**强制**：宿主行读取、枚举校验、compose、原子写入或同契约自校验任一失败都在提交前拒绝 prompt（无 tombstone、无按 Agent 继续）；技能/记忆仍为 PI 式 best-effort（失败→空 capability 部分、撤回 `Skill` 工具；非法技能行按 PI 语义丢弃并告警）。
- gate 在 `before_agent_start`：能力块（技能→记忆，字节不变）之后**最后**追加 mode 块（纯追加、恰一次、单 system）；Plan/Goal 用真实 extension API `setActiveTools` 夹取 PI 合约目录（`read/glob/grep/bash/ask/new_context` ∩ 实际存在 + 非空 `planSafeActions` 的插件工具；Write/Edit/apply_patch/未知/用户 MCP/未声明插件永不进入；**不虚构** PI 的 BrowserPreview）；回 Agent 恢复夹取前选择并保留夹取期间自动激活的工具。
- 失效语义：声称属于本会话但校验失败的状态文件由 gate 用运行时正式的 `ctx.abort()` 拒绝该回合（throw 不是保护，见 §4.2）；缺失/他会话文件零注入。子代理（其他 native identity）零模式/技能/记忆注入。
- 风险/安全动作随目录指纹刷新（名称/schema 不变也会重新注册）；gate 的审批描述符新增可选 `permissionMode`，作为有效策略被真实消费的可观察路径。

**明确不做/不声称**：不注册 `SubmitPlan`/`SubmitGoal`；不接通审批/执行/派发；不删除 Pi-only plan dispatch 拒绝（g3 仍 open）；不实现 C 的完整执行期决策表（g2 仍 open）；不新增 `plan`/`goal` capabilities、不开放 UI（B9/D 未动）；不声称 Cursor 组合可用（当前桌面未接通 Cursor 传输）。矩阵 B4-B9 与 D1-D3 未被本阶段触碰。

## 2. 数据流与版本

```text
host DB session row (mode, permission_mode)
        │  session.get / settings.get（wiring，每 prompt；inherit→当前
        ▼  defaultPermissionMode，非法则 ask；[INVALID] 或行缺失→拒绝）
bridge.prompt
  ├─ catalog = adapter.catalog(project)        ── 单次组装
  │     └─ 插件风险（合法声明否则 medium）+ planSafeActions + origin；user MCP = low/[]
  ├─ refreshDesktopState(catalog)              ── 强制策略 + best-effort 能力
  │     ├─ 读宿主行→校验枚举→composeModeSystemPrompt(mode,"")
  │     ├─ 技能/记忆（失败→空，不回滚策略）
  │     ├─ writeDesktopCapabilityState(原子同目录 0600 替换, alias-safe)
  │     └─ readDesktopCapabilityState 自校验（字段级比对；失败→拒绝 prompt）
  ├─ registerHostTools(runner, skillsPresent, catalog)  ── 指纹含 risk/safeActions/origin
  └─ runner.prompt
        │
        ▼  runtime 进程（trusted gate）
  before_agent_start:
    readDesktopStateForSession
      ├─ owned  → [native base, capability?, modeBlock]（append-only, block 最后）
      │           + Plan/Goal: setActiveTools(contract ⊆ live)；Agent: 恢复/无操作
      ├─ foreign → 零注入、零 clamp（子代理）
      ├─ absent  → 零注入（无状态通道/无法归因）
      └─ invalid → ctx.abort() 拒绝回合（无 provider 请求）
  tool_call:
    owned 状态可读时，审批描述符携带有效 permissionMode（T20-C 的消费前置）
```

状态文件在每次 prompt 前重写：模式/权限/目录变更对**下一个** prompt 生效；旧文件不会污染下一回合（要么被成功写入替换，要么 prompt 被拒绝）。

## 3. 固定先例（对照来源）

| 决策 | 固定来源 | 本阶段用法 |
| --- | --- | --- |
| mode 块 = `composeModeSystemPrompt(mode, "")`，追加在 base+记忆之后 | PI `packages/agent-runtime/src/mode-prompts.ts`（app 与上游逐字节相等，测试钉住）、`runtime.ts:2051-2075` | bridge 调用真实 composer；gate 只追加已验证的块 |
| `inherit`→应用当前默认、非法/再 inherit→ask | host-core `session_collaboration/permissions.rs`（本阶段新增 host-core 测试） | wiring 解析；bridge 只接受 `ask/accept-edits/auto`（不把启动环境 `ask/deny/allow` 当权限模式） |
| 契约模式许可集合 | PI `runtime.ts:3314,3453-3467`、host-core `permissions.rs:148-153` | gate clamp 的 native 允许集 |
| 插件 planSafeActions 决定契约可见性 | PI `runtime.ts:3328-3340`、`plugin-runtime.ts:776-817`（ADR 0211） | 策略表 + clamp 过滤 |
| 风险：声明合法值否则 medium；`mcp_*`→Low | host-core `permissions.rs:129-140` | adapter 策略表映射（非名字前缀） |
| `set_host_tools` 自动激活 → 顺序契约 | OMP `session-tools.ts:1999-2010`（`autoActivatedRpcToolNames`），T20-A §4.2 R4-1/R4-2 | 每 prompt 先注册后夹取（E2E 严格序列断言） |
| policy retry 上限与语义 | OMP `agent-session.ts:407,6788-6855` | witness 记录真实 attempts（≤2，无 `AgentStartPolicyChangedError`） |
| `ctx.abort()` 是 start handler 唯一正式拒绝路径；throw 被吞 | OMP `extensibility/extensions/runner.ts`（实测，§4.2） | gate 拒绝路径 + 语义探针 |
| `inherit` 语义、configure 原子持久 | PI `session-launch.ts`、host-core `sessions.rs:1808`、`approval.rs:54-119` | 既有 configure 语义保留（回归全绿） |

## 4. 行为证据

### 4.1 真实固定已补丁 OMP + 生产 wiring/bridge/gate（FakeProvider）

`apps/desktop/test/omp-runtime-state-e2e.test.mjs`（**1/1，exit 0**；`docs/validation/M5-t20-b1-runtime-state/b1-e2e.txt`）。经 `wireOmpSessions`（生产组合根）与真实 `createOmpDesktopCapabilities`/`createOmpHostToolAdapter`、真实补丁树（`preparePatchedTree({prepareBuild:true})`，断言 4 项 patch capability）与真实 gate 运行一个持久 native 会话，另加载 witness 扩展记录每次 handler 调用（prompt、native session id、activeTools、system parts）。8 个阶段（同 session）：

| 阶段 | 操作 | 断言（对 provider 实际请求 / witness / 状态文件） |
| --- | --- | --- |
| P1 Agent | 目录：safe 插件 + 未声明插件 + 用户 MCP + 技能 | provider 工具表 = 独立基线且含 `plugin_demo_inspect/plain/mcp_alpha_lookup/Skill`；单 system；mode 块=Agent 生产块、恰一次且在末尾、无 PI base；状态 mode=agent、permissionMode=accept-edits（inherit→默认）、策略表与目录一致；attempts=1 |
| P2 Plan | `configure(mode=plan)` | 严格序列 = 合约允许集（`read/glob/grep/bash/ask` ∩ 实际 + safe 插件）；未声明插件/用户 MCP/`Skill` 不可见；mode 块=Plan、恰一次；attempts=2（首次夹取 1 次 policy retry） |
| P3 Goal + 目录变更 | 加 safe 插件 `run`、删 `plain` | 严格序列 = 上一步 + `plugin_demo_run`；被删工具无滞留；mode 块=Goal；attempts ≤2 |
| P4 Agent | 目录不变、`defaultPermissionMode` 改为 auto | 严格序列 = 恢复选择（含 MCP/Skill，含运行期 pinning，见 §7）+ `run`；状态 permissionMode=auto（同一 prompt 快照） |
| P5 Plan（重加） | 重加 `plain` | 严格序列 = 合约集（重加的无声明插件仍不可见）；attempts ≤2 |
| P6 审批 | 模型调 `write`；gate 弹卡 | 待审批时文件未写；**原始 dialog 帧**解析出的描述符 `permissionMode == "auto"`、toolName=write；`resolvePermission(allow-once)` 后恰一次落盘；回合结算；工具表严格序列=恢复后 Agent 表 |
| P7 子代理 | `task` 委派 | 子进程 provider 请求（按 provider 同一 first-user 分类）中**零** mode 块/技能/记忆标记；witness 出现不同 native session id |
| P8 重启 | `disposeSession` 后重 prompt | 新运行时回到默认呈现基线（严格序列）；attempts=1（clamp 状态随进程重置） |

同一测试末尾断言所有 prompt 的 witness attempts ≤ 2（第 3 次尝试即 `AgentStartPolicyChangedError` 语义）。

### 4.2 start handler 真实语义（前置研究，实测）

`apps/desktop/test/omp-start-handler-semantics.test.mjs`（**1/1，exit 0**）。加载 fixture 扩展为唯一 trusted extension，直接驱动真实固定运行时：

- `before_agent_start` 中 `ctx.abort()` → **provider 请求 0 次**（回合被拒绝、提示词未投递）；
- `before_agent_start` 抛异常 → 扩展运行器记录并继续，**provider 请求 1 次且回答被流式投递**（负对照：throw 不是保护）。

因此 gate 的 owner-state 失效路径用 `ctx.abort()`，而不是 try/catch 或抛错。

### 4.3 B14 反例守卫

- 常驻：`apps/desktop/test/mode-prompt-counterexamples.test.mjs`（**2/2，exit 0**）——与 E2E 共用的谓词 `apps/desktop/test/helpers/mode-prompt-assertions.mjs` 对 PI base 作第二块/写进状态块、mode 块重复、别的 mode 块、块不在末尾、缺少能力注入全部判红，正向形态通过。
- RED 对照：把"PI 默认 base 作为第二块追加"注入真实 gate（`b14-red/counterexample.diff`）后运行 E2E → **1 failed / exit 1**（`b14-red/regression-red.txt`，失败点 `agent-1: the mode block must be the final appended part`）；恢复后 gate SHA-256 与注入前一致（`cd98b173…`），反例未留在提交中。

### 4.4 单元/桥接层

- `packages/omp-runtime/src/desktop-state.test.ts`：v2 roundtrip；未知 schema（含 T19-C v1）拒绝；枚举/上限/未来/过期；host tool 风险/来源/重复名/动作上限/`user-mcp` 带 safeActions 拒绝；`readDesktopStateSessionId` 宽松归因；`readDesktopStateForSession` 四态（owned/foreign/absent/invalid）。
- `packages/omp-runtime/src/session/gate-desktop-state.test.ts`：注入顺序（native→capability→modeBlock）、字节精确块、他会话/缺失零注入、owner invalid→refuse、契约目录计算、clamp 状态机（进入/稳定/恢复/无 API 拒绝）、注册 handler 的 clamp+abort+描述符 permissionMode。
- `apps/desktop/test/omp-skill-path-bridge.test.mjs`（**10/10**）：v2 写入、mode 变更下一 prompt 生效、策略失败/行缺失/未知枚举拒绝、写失败拒绝、能力失败保留策略、非法技能行降级、策略表随指纹重注册、日志不含错误文本、双 session 隔离。
- `apps/desktop/test/omp-host-tool-adapter.test.mjs`（**37/37**）：声明风险/安全动作/origin 映射（非名字猜测）、非法风险→medium、user MCP=low/[]。
- host-core 新增 `configure_persists_mode_and_permission_mode_and_effective_mode_resolves_inherit`：configure 原子持久 mode+permissionMode、`inherit`→当前默认、非法/再 inherit→ask（606/606 全绿）。

## 5. 矩阵逐行证据（M5-plan-goal-capability-gates.md §7）

| 行 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| **B1** configure 持久化（T15 回归） | ✅ | 既有 `omp-session-configure.test.mjs`、host-core configure 测试全绿；新测试把 configure 后的 host 行读入每 prompt 状态（E2E P2/P3/P4/P5/P6 通过 `bridge.configure` 切 mode） |
| **B2** mode 块注入（四条同时成立） | ✅ | E2E P1-P6：①三块与生产 composer 逐字节相等（`app/packages/agent-runtime/src/mode-prompts.ts` 与固定 PI 文件逐字节一致，`omp-desktop-capabilities.test.mjs` 钉住）；②每请求恰 1 条 `role:"system"`；③ PI `DEFAULT_RUNTIME_SYSTEM_PROMPT` 不出现；④技能/记忆标记与顺序稳定；状态失败→拒绝 prompt（单元 + 桥接） |
| **B3** 契约目录（只读核 + safe 插件；Write/Edit/未知不可见） | ✅* | E2E P2/P3/P5 严格序列 + 单元 `contractActiveToolNames`；**提交工具可见性属 B2 阶段**，本阶段未注册、未声称 |
| **B4-B9** 提交/审批/派发/能力键 | ⛔ 未开始 | 本阶段明确不注册提交工具、不接通审批派发、不新增 capabilities；g3 仍 open |
| **B10** Agent + T17-T19 回归 | ✅ | desktop 全量 2977/2966/0 fail/11 skip；真实运行时套件（session/host-tool/skill/subagent/capability-source e2e）全绿 |
| **B11** 顺序契约（先注册后夹取） | ✅ | E2E 每 prompt 工具表与 clamp/恢复严格相等；顺序机制由既有 T20-A spike R4-1/R4-2 反/正对照证明（本阶段未放宽） |
| **B12** 收敛（≤1 retry，无 `AgentStartPolicyChangedError`） | ✅ | witness 真实 attempts：首次夹取 2、稳定 1、真实变更 ≤2、重启后 1；全 prompt ≤2 断言 |
| **B13** 生命周期 + 策略表 + 真实持久 mode | ✅ | E2E 同 session 增/删/重加、Plan/Goal/Agent 真实 host 行切换、策略表随目录（单元断言风险/安全动作单独变化会重注册）；契约模式严格序列无滞留/重复/未注册名 |
| **B14** R2 反例守卫 | ✅ | §4.3（常驻反例 + 注入真实 gate 的 RED 运行） |
| **g1**（T20-B1） | ✅ 退场 | `check-omp-plan-goal-gaps.mjs` 不再做静态符号判断：输出 `GAP-RETIRED g1` 并链接 4 个行为测试（含 E2E 命令）；探针只在替换测试缺失时判红 |
| g2 / g3 | ⛔ 仍 open | 探针 `SUMMARY: 2 gap(s) open [g2, g3]`，exit 1（未被本阶段改动，未通过删除问题得全绿） |

## 6. 命令、计数与退出码（2026-10-02，Linux x64 / Node v24.14.0 / Bun 1.4.2）

| 命令 | 结果 | exit | 原始日志 |
| --- | --- | --- | --- |
| `pnpm -C packages/omp-runtime test` | 23 files / **370 passed / 6 skipped** (376) | 0 | `omp-runtime-vitest.txt` |
| `node --test test/*.test.mjs`（`app/apps/desktop`，`env -u SSH_ASKPASS`） | **2977 tests / 2966 pass / 0 fail / 11 skipped** | 0 | `desktop-suite.txt` |
| B1 E2E 单跑（真实补丁树，三连跑均绿） | **1 passed** | 0 | `b1-e2e.txt` |
| start handler 语义探针（真实运行时） | **1 passed** | 0 | `start-handler-semantics.txt` |
| B14 常驻反例 | **2 passed** | 0 | `b14-counterexamples.txt` |
| B14 RED（注入反例 gate） | **1 failed**（判红成功） | 1 | `b14-red/regression-red.txt` |
| `node --test test/omp-sidecar.test.mjs`（真实 Bun 编译工具门、不同 TMPDIR 深度同字节） | **9 passed** | 0 | `compiled-gate-sidecar.txt` |
| `cargo test -p host-core --locked` | **606 passed / 0 failed** | 0 | `host-core-tests.txt` |
| `cargo fmt --check` / `cargo clippy -p host-core --all-targets --locked` | 干净 / 0 错误（1 条既有 `user_skills.rs` warning，非本阶段文件） | 0 / 0 | `rust-fmt-clippy.txt` |
| `pnpm build:js` / `pnpm -r --if-present typecheck` / `pnpm lint` | 全绿 | 0 / 0 / 0 | `build-typecheck-lint.txt` |
| `node scripts/check-t20-matrix-ids.mjs` | `MATRIX-ID-OK` | 0 | `checks.txt` |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | `GAP-RETIRED g1` + `SUMMARY: 2 gap(s) open [g2, g3]` | 1（预期） | `checks.txt` |
| `node scripts/omp-patch.mjs --check` | `OMP-PATCH-OK 62bc57b+omp-desktop.3` | 0 | `checks.txt` |
| `check-release-docs` / `check-agent-policy-sync` / `check-locales` | 全绿（79 对） | 0 | `checks.txt` |
| `node docs/scripts/check-docs.mjs` | **6 项预存在**（ADR 0301-0305 index/H1）/ 509 页，零新增 | 1（预存在） | `checks.txt` |
| `check-architecture`（补充） | 1 项预存在（`main/index.ts` 1550>1500，基线同为 1550、本阶段未改该文件） | 1（预存在） | 报告内说明 |

原始日志未编辑；`git diff --check` 在提交内容上运行（见 §8 与提交说明）。空行/空白如有，按仓库既有做法归档确定性 gzip + 可读副本。

## 7. 限制与未验证项（如实记录）

- 只跑 Linux x64；未做 macOS/Windows 实机，未做打包/GUI 启动（T21/T22/T23 范畴）。
- E2E 的 host 是**受控 fixture**（`session.get`/`settings.get`/`session.configure`/`session.bindEngine` 的 DB 语义由内存行模拟）；mode/permission 的真实持久层由 host-core 的 `cargo test -p host-core --locked`（606/606，含新增 inherit 解析测试）与既有 configure RPC 测试覆盖，两者证据层不同、均已记录。
- E2E 阶段的 host tool 执行只发生一次（审批探针的 `write` 是原生工具）；宿主工具执行路径的既有覆盖在 `omp-host-tool-e2e.test.mjs`（6/6）等套件。
- extension 面只提供 `setActiveTools`（→`setActiveToolsByName`），显式选择会把此前 `xd://` 可发现的内建工具 pin 成顶层；这是 OMP 自身 interactive Plan 恢复选择的同款语义（`interactive-mode.ts` `#goalModePreviousTools`），E2E 以"恢复夹取前 enabled 选择"规则建模并断言，未被隐藏或淡化。用户禁用工具不会被复活（恢复只含夹取前 enabled 集合）。
- gate 的 owner-invalid `ctx.abort()` 路径由单元测试（调用 abort）+ 语义探针（abort 语义）联合覆盖；生产 bridge 在强制状态失败时先于提交拒绝，两者的分工在 §1/§4.2 说明。
- `witness` 扩展是测试夹具（`apps/desktop/test/fixtures/omp-runtime-state-witness.ts`），不是产品代码；产品 gate 保持 dependency-free。
- 未重跑全量 `pack`/283MB 二进制构建、未调用真实付费模型、未改 fork/patch/pins、未动 Cursor 门与 ADR 0306。
- 后续阶段：T20-C（消费本阶段策略表 → 执行期硬拒绝与真实插件 mode）、T20-B2（提交/审批/派发；前置 C）、T20-D（整体验收后开放能力）。

## 8. 证据文件（`docs/validation/M5-t20-b1-runtime-state/`）

| 文件 | 内容 | SHA-256 |
| --- | --- | --- |
| `omp-runtime-vitest.txt` + `.gz` | 包 vitest 输出（370/6）；`.gz` 为原始字节（`gzip -n -9`，原始 sha256 `0461c3d9…`），`.txt` 为去掉 EOF 空行并注明归一化的可读副本 | `.txt` `67a0f9360fffa49234df83cd1f4caa0837bc80f07aa1db78a117969049d81fae`；`.gz` `dc7a7182382d14d934f44a02997ece9a2bc290157ec19b49c7a6139dd47d8cca` |
| `desktop-suite.txt` | desktop 全量输出（2977/2966/0/11） | `8af72cc948c3f7c2f8142ec1b05ec5ddf6ebf1376647dfba2f3c4f57c4e9e97c` |
| `desktop-suite.exit.txt` | 全套件与四个单跑套件的 exit code | `e852af9f79837451213b823d31a1ad449314e0f78c74861e387c2cc752152b11` |
| `b1-e2e.txt` | B1 生产 E2E（1/1） | `b07add39b02f3930838703fc67ed0b592854a6d40cb0d32db800d6fbe308d462` |
| `start-handler-semantics.txt` | start handler abort/throw 语义探针（1/1） | `995131bc61dcf0142a54c599f108faa5015388257671b912f97ad6830df0b085` |
| `b14-counterexamples.txt` | B14 常驻反例（2/2） | `f3db5785ad9230e7567784a3d6bbeac6f3d3796a3705676de4ea33c339265e58` |
| `b14-red/regression-red.txt` | 注入反例后的 RED 运行（1 failed / exit 1） | `d32fb78c239579ab0e976cfb7fcac22bb97c8ea028a5d8861cc7762265b3ed3c` |
| `b14-red/counterexample.diff` + `.gz` | 注入的语义反例：`.gz` 为可应用的原始字节（原始 sha256 `26415589…`），`.diff` 为去掉 EOF 空白并注明归一化的可读副本 | `.diff` `beff4f1768b11fb67a8c7222f61745dda026960b2797721fb525847b80973a9f`；`.gz` `67ef12b5b7526ed6b4332e4bfd8be99ce9bc420520a27e4a580021e50f948460` |
| `b14-red/README.md` | 反例注入/恢复与归一化说明 | `744bfc76a7439c3aa966d33b5c57027f18ad91e785fa96fb5765a21c1f36a2bf` |
| `compiled-gate-sidecar.txt` | 真实 Bun 编译工具门套件（9/9） | `b9e44de7a8698511f974ce11ee932b37ac3a5f9a2e7ba75b998cb15c7745c5cf` |
| `host-core-tests.txt` + `.gz` / `host-core.exit.txt` | host-core 全量（606/0）与 exit；`.gz` 为原始字节（原始 sha256 `d3323cb8…`），`.txt` 为去掉 EOF 空行并注明归一化的可读副本 | `.txt` `2ef0ef5a45ce638e9c1616ed65fa6a01de4439c9d117a9044514bcbc20539ed2`；`.gz` `e0a492dc3009aa288f69b6cd157de4f82584c82d1228f15c3459d9d5ed9306e3`；exit `dcf3062542d4a79863f959974e18c3e0deefbb8f4b39132abaaa83d24b5d3eac` |
| `rust-fmt-clippy.txt` | fmt/clippy 输出与 exit | `e6595314639f5a7789aa4369feb9ed56360d59580fe532620bde0d90db608d0a` |
| `build-typecheck-lint.txt` | build:js/typecheck/lint 输出与 exit | `41c559030491da1a9331360a4886bb9d40d3d91f74a0a0649f98ecd6244efa44` |
| `checks.txt` | 矩阵 lint、gap 探针、omp-patch、release-docs、agent-policy、locales、docs 输出与 exit | `8d267bd487878e58683e9828b4d67086744ccf04506fd352c8056c67e9438cc5` |

上游/固定参考源码坐标：OMP `upstream/oh-my-pi`（gitlink `62bc57be`，本阶段只读；补丁 scratch 由 `app/scripts/omp-patch.mjs` 生成、验收后删除），PI `upstream/pi-desktop`（gitlink `0111e306`，只读）。本阶段未修改两个参考子模块。
