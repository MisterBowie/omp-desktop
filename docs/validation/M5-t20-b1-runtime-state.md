# M5/T20-B1：生产 mode/policy 状态与合约工具目录 —— 验证记录

更新时间：2026-10-02。状态：**T20-B1 首稿未通过独立复审（F1-F4，见 §9）；首轮返修提交（`064c738a`）通过 F1-F4 复核但被第二次独立复审判 R1-R3（见 §10），第二次返修已完成并通过本机针对性/全量验证，等待复审确认；T20 整体仍未完成（T20-C / T20-B2 / T20-D 未开始，`plan`/`goal` 能力保持关闭）**。

- 分支：`codex/m5-t20-b1-runtime-state`，基线 `27d5c88a1334b32dbd8c8ac17a6c262e81a8df32`（追加提交，不 amend/rebase/强推，不创建 PR、不发布）；**产出提交（代码/测试/文档首稿）`7ecf8c8b31e25c7d3d367888051645a3cdecf6a0`**；首轮返修提交 `a538533`/`4f5ca0c`/`8ad9e5f`/`064c738`；**第二次返修提交 `745ceecc`（代码/测试）与 `25236523cb8043c7bc40abb90d93aa2f7662b941`（文档/证据，已推送至 `origin/codex/m5-t20-b1-runtime-state`）**。
- 工作树：`/home/vv/person/code/omp-desktop-m5-t20-b1`；固定子模块：OMP `62bc57be1b03ef0802a33cf7f5f530e534527531`（omp/18.3.0）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`；patch level `62bc57b+omp-desktop.3`（fork commit `6226f805e92654344de04def413fa5cb91cb16b9`，本阶段**未改**）。
- 环境：Linux x64；Node v24.14.0；Bun 1.4.2（`/home/vv/.bun/bin`）；rustc 1.95.0。所有运行使用本地 FakeProvider 与固定/已补丁 OMP 源码，无付费/远程模型调用。

## 1. 交付与阶段边界

本阶段把 mode/permissionMode 从"只持久化"变成**每 prompt 的真实生产状态**，并把目录、模式块与工具策略表接到同一个快照：

- 运行范围状态 schema v2（`<runRoot>/desktop-state.json`）：`mode`、生产 `composeModeSystemPrompt(mode, "")` 块、**已解析**的有效 `permissionMode`、每宿主工具 `{name, risk, planSafeActions, origin}` 策略表 + T19-C 的技能/记忆；单一写者（bridge，每 prompt 一次组装）、单一读者（gate）。
- 策略半部分**强制**：宿主行读取、枚举校验、compose、原子写入或同契约自校验任一失败都在提交前拒绝 prompt（无 tombstone、无按 Agent 继续）；技能/记忆仍为 PI 式 best-effort（失败→空 capability 部分、撤回 `Skill` 工具；非法技能行按 PI 语义丢弃并告警）。
- gate 在 `before_agent_start`：能力块（技能→记忆，字节不变）之后**最后**追加 mode 块（纯追加、恰一次、单 system）；Plan/Goal 用真实 extension API `setActiveTools` 夹取 PI 合约目录（`read/glob/grep/bash/ask/new_context` ∩ 实际存在 + 非空 `planSafeActions` 的插件工具；Write/Edit/apply_patch/未知/用户 MCP/未声明插件永不进入；**不虚构** PI 的 BrowserPreview）；回 Agent 恢复夹取前选择并保留夹取期间自动激活的工具。
- 失效语义（2026-10-02 第二次复审返修后，见 §10；§9 为首轮返修历史记录）：强制通道开关**在启动时**由 supervisor 以 `desktopStateRequired`（生产 wiring 恒 `true`，未写状态的夹具显式 `false`）写成 `OMP_DESKTOP_STATE_REQUIRED=1|0`，随进程生命周期固定——删除/篡改运行根内任何文件都不可能把它关掉（第一次返修的 `desktop-state.required` 文件标记已删除，其写入路径的 symlink 覆盖缺陷随之消失）；开关开启时，交互会话任何"非 owned 且有效"的状态（缺失/不可读/超限/无 identity/他会话/未知 schema）都由 gate 用运行时正式的 `ctx.abort()` **加**结构化 `notify` 拒绝该回合（零 provider 请求、恰一次 `error(OMP_RUNTIME_STATE_REFUSED)` + 恰一次 `turnEnd(error)`、runner 回到 idle、状态修复后下一 prompt 正常）；委托会话（`hasUI=false`，实测）保持零注入跳过。拒绝与**本次已准入回合**绑定：runner 在每次 prompt 前经 `get_available_commands` 确认 gate 注册了内部命令 `/omp-desktop-turn`，再用正式 RPC `prompt` 安装随机 turn token、等待 gate 经 `notify` 的版本化确认，拒绝描述符（`v: 2`）必须命中本 native session 且携带该 token、fence 已确认、当前代未 `agent_start` 才关闭该代——重复投递与上一代的迟到描述符（旧 token）只计数不关闭；命令缺失/握手未确认在用户 prompt 提交前失败。子代理（其他 native identity）零模式/技能/记忆注入。
- 离开 Plan/Goal 回 Agent 时 bridge 重建运行时进程（扩展面只暴露按名选择的 `setActiveTools`、没有 presentation 恢复 API）：同一持久 native 会话 `switch_session`、同项目/模型、seeds 延续、无重放、身份不变、移除/禁用不复活；gate 的同进程恢复路径按"夹取前选择 + 夹取期间被移除的名字"恢复，目录类名字按当时目录过滤，不用 `getAllTools` 全开。
- 风险/安全动作随目录指纹刷新（名称/schema 不变也会重新注册）；gate 的审批描述符新增可选 `permissionMode`，作为有效策略被真实消费的可观察路径。

**明确不做/不声称**：不注册 `SubmitPlan`/`SubmitGoal`；不接通审批/执行/派发；不删除 Pi-only plan dispatch 拒绝（g3 仍 open）；不实现 C 的完整执行期决策表（g2 仍 open）；不新增 `plan`/`goal` capabilities、不开放 UI（B9/D 未动）；不声称 Cursor 组合可用（当前桌面未接通 Cursor 传输）。矩阵 B4-B9 与 D1-D3 未被本阶段触碰。

## 2. 数据流与版本

```text
host DB session row (mode, permission_mode)
        │  session.policy（wiring，每 prompt；inherit→当前 defaultPermissionMode，
        ▼  非法则 ask；[INVALID] 或行缺失→提交前拒绝）
bridge.prompt
  ├─ mode 离开 Plan/Goal 回 Agent → supervisor.stop/reclaim + retire runner
  │     └─ 下一 prompt 新进程：同一持久 native 会话 switch_session、同项目/模型
  ├─ catalog = adapter.catalog(project)        ── 单次组装
  │     └─ 插件风险（合法声明否则 medium）+ planSafeActions + origin；user MCP = low/[]
  ├─ refreshDesktopState(catalog, policy)      ── 强制策略 + best-effort 能力
  │     ├─ composeModeSystemPrompt(mode,"")
  │     ├─ 技能/记忆（失败→空，不回滚策略）
  │     ├─ writeDesktopCapabilityState(原子同目录 0600 替换, alias-safe)
  │     └─ readDesktopCapabilityState 自校验（字段级比对；失败→拒绝 prompt）
  ├─ registerHostTools(runner, skillsPresent, catalog)  ── 指纹含 risk/safeActions/origin
  └─ runner.prompt
        ├─ get_available_commands：必须列出 gate 注册的 /omp-desktop-turn（缺失→提交前拒绝）
        ├─ 正式 RPC prompt 安装本代 turn token → 等 gate notify 版本化确认（未确认→提交前拒绝）
        │     （命令由 #tryExecuteExtensionCommand 在 provider 循环前本地消费）
        └─ 提交用户 prompt
        │
        ▼  runtime 进程（trusted gate；OMP_DESKTOP_STATE_REQUIRED 启动时固定）
  before_agent_start:
    readDesktopStateForSession
      ├─ owned  → [native base, capability?, modeBlock]（append-only, block 最后）
      │           + Plan/Goal: setActiveTools(contract ⊆ live)；Agent: 恢复/无操作
      ├─ foreign → 委托：零注入、零 clamp（hasUI=false）；交互+强制通道：拒绝
      ├─ absent  → 通道关闭：零注入；开启且交互：拒绝
      └─ invalid → ctx.abort() + notify 结构化拒绝（无 provider 请求）
    runner: 拒绝必须命中本 native 会话 + 本代 token + fence 已确认 + 未 agent_start
            → 恰一次 error(OMP_RUNTIME_STATE_REFUSED) + turnEnd(error)，回到 idle
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
| **B3** 契约目录（只读核 + safe 插件；Write/Edit/未知不可见） | ✅* | E2E P2/P3/P5 严格序列 + 单元 `contractActiveToolNames`；**提交工具可见性属 B2 阶段**，本阶段未注册、未声称；Agent 呈现（native/deferred/essential 保持）按 §9.2 修正并以独立基线断言 |
| **B4-B9** 提交/审批/派发/能力键 | ⛔ 未开始 | 本阶段明确不注册提交工具、不接通审批派发、不新增 capabilities；g3 仍 open |
| **B10** Agent + T17-T19 回归 | ✅ | desktop 全量 2977/2966/0 fail/11 skip；真实运行时套件（session/host-tool/skill/subagent/capability-source e2e）全绿 |
| **B11** 顺序契约（先注册后夹取） | ✅ | E2E 每 prompt 工具表与 clamp/恢复严格相等；顺序机制由既有 T20-A spike R4-1/R4-2 反/正对照证明（本阶段未放宽）；合约模式退出以进程重建恢复（§9.2），失败则拒绝 prompt |
| **B12** 收敛（≤1 retry，无 `AgentStartPolicyChangedError`） | ✅ | witness 真实 attempts：首次夹取 2、稳定 1、真实变更 ≤2、重建后 1；全 prompt ≤2 断言 |
| **B13** 生命周期 + 策略表 + 真实持久 mode | ✅ | E2E 同 session 增/删/重加（含用户 MCP 替换/重加）、Plan/Goal/Agent 真实 host 行切换、safeActions 有↔无、策略表随目录（单元断言风险/安全动作单独变化会重注册）；契约模式严格序列无滞留/重复/未注册名；Plan 中新增插件在 Agent 重建后可见（F3） |
| **B14** R2 反例守卫 | ✅ | §4.3（常驻反例 + 注入真实 gate 的 RED 运行） |
| **g1**（T20-B1） | ✅ 退场 | `check-omp-plan-goal-gaps.mjs` 输出 `GAP-RETIRED g1` 并链接行为测试；退场依据为**返修后**的测试（含 F1-F4 失败路径，§9.3），首稿绿灯不足以支撑全闭 |
| g2 / g3 | ⛔ 仍 open | 探针 `SUMMARY: 2 gap(s) open [g2, g3]`，exit 1（未被本阶段改动，未通过删除问题得全绿） |

## 6. 命令、计数与退出码（2026-10-02，Linux x64 / Node v24.14.0 / Bun 1.4.2）

> 本节为首稿轮次的计数；2026-10-02 复审返修后的计数与证据见 **§9.3**（runtime 384/6、E2E 1/1、desktop 全量 2977/2966/0/11、compiled gate 9/9、skill E2E 6/6，全部 exit 0），本节保留为历史事实。

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
- extension 面只提供 `getActiveTools`/`getAllTools`/`setActiveTools`（按名选择）；真正恢复顶层 vs `xd://` 分区的 `setActiveToolPresentation` 是 session 方法（`interactive-mode.ts`/`sdk.ts` 直接调用），不在扩展 API，RPC 命令联合也没有 presentation 命令。首稿"以 `setActiveToolsByName` 恢复并接受 pinning（与 OMP interactive 同款）"被复审 F4 判为不满足 B1 的 Agent/native/deferred/essential 保持语义；返修改为：离开 Plan/Goal 回 Agent 时 bridge 回收并重建运行时进程（同一持久 native 会话 `switch_session`、同项目/模型、seeds 延续、无重放、身份不变），新进程自带默认呈现；E2E 以独立常量 `NATIVE_TOP_LEVEL`（12 项）+ deferred 断言每一条 Agent 工具表（含重建后）。gate 的同进程 Agent 恢复路径保留为回退：恢复"夹取前选择 + 夹取期间被移除的名字"（目录类名字按当时目录过滤），不复活移除/禁用工具、不用 `getAllTools` 全开（见 §9.2）。
- gate 的拒绝路径（`invalid`/强制通道下的 missing/foreign/clamp 不可用）由三处证据联合覆盖：单元测试（策略判定 + 注册 handler 的 abort+notify）、语义探针（`ctx.abort()` 的 provider 零请求语义），以及生产 E2E 的 refusal 反例（真实运行时：0 provider 请求、恰一次 `error(OMP_RUNTIME_STATE_REFUSED)` + `turnEnd(error)`、runner idle、修复后下一 prompt 正常、他会话伪造 notify 不关闭回合）；生产 bridge 在强制状态失败时先于提交拒绝，两者的分工在 §1/§4.2/§9 说明。
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

## 9. 2026-10-02 独立复审返修（F1-F4；原 RED 归档，返修 GREEN 追加）

### 9.1 判定与 RED 证据（原样归档，未编辑）

独立复审（Mac arm64 / Node v24.14.0 / Bun 1.4.2）判 `changes-required`：首稿的 `build:js` exit 0、runtime 23 files/370 pass/6 skip、B1 生产 E2E + bridge + adapter + B14 针对性 44/44 均通过，但四条生产反例未被覆盖：

| 编号 | 反例（原证据） |
| --- | --- |
| F1 | 缺失/不可解析状态静默继续：control `providerRequests=1` 正常完成；**delete 与 malformed 均 accepted=true / providerRequests=1 / 正常 agent_end**——原 Plan 意图失去 mode 块/clamp，按原生 Agent 继续 |
| F2 | abort 无终态/不可恢复：状态可解析且 owner 正确、mode 非法时 gate `ctx.abort` 使 `providerRequests=0`，但 RPC success/bridge accepted=true、观测点 `state=running`、桌面事件数组为空、下一 prompt 报 `runtime is running`；仅脚本 dispose 才关闭；报告 `turnEnds` 里的 `aborted` 来自 dispose，不是拒绝时已有终态 |
| F3 | Plan 中新增普通插件 Agent 恢复丢失：同一 native 会话、无 skills 的 Agent 空宿主目录 → Plan → Plan 加入 `plugin_demo_new_unsafe`（high/[]，应夹取）→ Agent 目录不变，最终 Agent provider 表仍无插件，`returnedAgentPluginVisible=false` |
| F4 | deferred/essential 呈现没有恢复：初始 Agent provider 顶层 12 项；最终 15 项，额外 `ast_edit`/`debug`/`lsp` 从 `xd://` 延迟目录变顶层，且插件缺失 |

原始文件（含复审机脚本，绝对路径仅供参考、不直接运行）：`repair-red/review-summary.json`、`repair-red/production-state-failure-probe.json`、`repair-red/production-state-failure-probe.mjs`、`repair-red/start-refusal-probe.json`。源码定位：`desktop-state.ts` 读不到 owner → `absent` → gate skip；gate 仅 `ctx.abort()`、无终态关联通道；clamp 的 `before` 快照 + `setActiveToolsByName` 恢复既丢新注册工具又把 mounted 名字 pin 成顶层。

### 9.2 返修内容与实现坐标

| 反例 | 返修 | 生产坐标 |
| --- | --- | --- |
| F1 | bridge 在强制策略通道下同时写 `desktop-state.required` 标记（失败即拒绝 prompt）；gate 读到标记且交互上下文（`hasUI` 非 false）时，任何非 `owned` 且有效的读（缺失/不可读/超限/无 identity/他会话/未知 schema）都拒绝 | `desktop-state.ts`（`markDesktopStateRequired`/`isDesktopStateRequired`/`DESKTOP_STATE_REQUIRED_FILE`）、`omp-desktop-gate.ts`（`beforeAgentStartPolicy(..., { required })`）、`omp-session.ts`（`refreshDesktopState` 先写标记） |
| F2 | 拒绝改为 `ctx.abort()` + 运行时正式 `notify` 通道里的版本化描述符（`session/start-refusal.ts`）；runner 归属协议：描述符必须命中本 entry 的 native session 且当前代未 `agent_start`，然后恰一次 `closeGeneration`（`error` 信封 `OMP_RUNTIME_STATE_REFUSED` + `turnEnd(error)`，取消 dialogs/hostcalls、回 idle）；迟到/重复/他会话/子代理信号只计数不关闭；`notify` 解析严格（kind/version/sessionId/code/reason/refusalId/at） | `src/session/start-refusal.ts`、`src/session/runner.ts`（`parseStartRefusalNotice` → `handleStartRefusal`、`RunRecord.started`、diagnostics `startRefusals`/`ignoredStartRefusals`）、`omp-desktop-gate.ts`（`refuseStart`） |
| F3 | 目录/策略与恢复协同：clamp 记录"夹取期间被移除的名字"（`removed`，含新注册被自动激活的宿主工具）；Agent 恢复 = 夹取前选择 ∪ removed ∪ 当前 active，目录类名字按**当时**目录过滤（`plugin_`/`mcp_`/目录内），native 名字必须在夹取前选择里；不使用 `getAllTools` 全开。生产路径上，离开合约模式改为重建进程（F4），该恢复路径作为同进程回退 | `omp-desktop-gate.ts`（`ContractClampState.removed`、`applyContractToolClamp`） |
| F4 | bridge 从"最后一次成功写状态时的 mode"检测合约模式 → Agent 转换，`supervisor.stop`/`reclaimAll` 回收后 retire runner，下一次 prompt 在新进程重建（同一持久 native 会话 `switch_session`、同项目/模型投影、`generationSeed`/`messageSequenceSeed` 延续、`hostToolsRegistered*` 清空重注册、无重放、身份不变）；回收失败拒绝 prompt。gate 不再依赖把 mounted 名字 pin 成顶层 | `omp-session.ts`（`lastPromptMode`、`ensureAgentPresentationReset`/`resetAgentPresentationAfterContract`、`prompt()`） |

扩展 API 依据（返修前核对，非假想字段）：`ExtensionActions` 只有 `getActiveTools`/`getAllTools`/`setActiveTools`（`extensibility/extensions/types.ts:1448-1462,1714-1724`）；`setActiveToolPresentation` 由 `interactive-mode.ts:4116` 与 `sdk.ts:4108/4132` 直接调用，RPC 命令联合（`rpc-types.ts`）无 presentation 命令；`hasUI=false` 是 `task`/`eval` 子代理的扩展运行器初始化（`task/executor.ts:4041` 不传 `uiContext`）而 rpc-ui 父会话传真实 UI 上下文（`rpc-mode.ts:1088`），由 witness 在真实运行时实测（parent=true、delegate=false）。

### 9.3 GREEN 计数与证据（2026-10-02，Linux x64 / Node v24.14.0 / Bun 1.4.2；全部本地 FakeProvider，无付费/远程模型）

| 命令 | 结果 | exit | 原始日志 |
| --- | --- | --- | --- |
| `pnpm -C packages/omp-runtime test` | 24 files / **384 passed / 6 skipped** (390)；+14（state marker、start-refusal 协议、runner 拒绝归属/否定、clamp removed/目录过滤） | 0 | `omp-runtime-vitest-repair.txt` |
| `node --test test/omp-runtime-state-e2e.test.mjs`（真实补丁树 + 生产 wiring/gate + FakeProvider + mutator 夹具） | **1 passed**：P1-P8（基线/deferred/Plan/Goal/重建/审批/safeActions/子代理 hasUI/MCP 替换重加/重启）+ refusal 反例（首 prompt delete、malformed、oversize、unknown-schema、identity-missing、mode-invalid、他会话伪造 notify 否定、三次修复恢复、身份/历史无重放/唯一 turnId/attempts ≤2） | 0 | `b1-e2e-repair.txt` |
| `node --test test/*.test.mjs`（`apps/desktop` 全量，`env -u SSH_ASKPASS`） | **2977 tests / 2966 pass / 0 fail / 11 skipped** | 0 | `desktop-suite-repair.txt` |
| `node --test test/omp-start-handler-semantics.test.mjs` | **1 passed**（abort→0 provider；throw→仍投递） | 0 | `start-handler-semantics-repair.txt` |
| `node --test test/mode-prompt-counterexamples.test.mjs` | **2 passed** | 0 | `b14-counterexamples-repair.txt` |
| `node --test test/omp-skill-path-e2e.test.mjs`（真实运行时 + 强制通道） | **6 passed** | 0 | `skill-path-e2e-repair.txt` |
| `node --test test/omp-sidecar.test.mjs`（真实 Bun 编译工具门） | **9 passed** | 0 | `compiled-gate-sidecar-repair.txt` |
| `pnpm build:js` / `pnpm -r --if-present typecheck` / `pnpm lint` | 全绿 | 0 / 0 / 0 | `build-typecheck-lint-repair.txt` |
| 矩阵 lint / gap 探针 / omp-patch / release-docs / agent-policy / locales(79 对) / check-docs / check-architecture | `MATRIX-ID-OK` / `GAP-RETIRED g1`+`2 open [g2,g3]` / `OMP-PATCH-OK` / 全绿 / 全绿 / 全绿 / **6 项预存在** / **1 项预存在** | 0 / **1（预期）** / 0 / 0 / 0 / 0 / **1（预存在）** / **1（预存在）** | `checks-repair.txt` |

本机未重跑 host-core（606/606 于首稿提交运行、本轮未改 Rust）与 `pack`/283MB 构建；未改 fork `6226f805`/patch `.3`/PI `0111e306`/OMP `62bc57be`/pins/manifest。g2/g3 仍 open、gap 探针 exit 1；不注册 SubmitPlan/SubmitGoal、不开放 UI、不发布。

### 9.4 返修证据文件（`docs/validation/M5-t20-b1-runtime-state/`）

| 文件 | 内容 | SHA-256 |
| --- | --- | --- |
| `repair-red/review-summary.json` | 复审判定（changes-required、positive checks、四条失败、归档哈希与 pins 声明） | `e887509a2768154fda6999e14bf1fdd4991109ea24e4fa16ff7e7302233ccdbc` |
| `repair-red/production-state-failure-probe.json` | F1-F4 原始探针结果（本机拉回，未编辑） | `8837fe9ab559e798d8737148afbc4622dcdd87d1a520ebc35136c65b10a7e671` |
| `repair-red/production-state-failure-probe.mjs` | 复审机可读脚本（import 绝对路径，不直接运行） | `35af356b12f9c6d085aa93388299194662b39be50d9a7d9945852e984087858b` |
| `repair-red/start-refusal-probe.json` | `ctx.abort` 语义前置探针（control/throw/abort） | `42dacea8461988ba6d7451aeb7a4508877741798db98b60e11c4db0e35fb644f` |
| `b1-e2e-repair.txt` | 返修后 B1 生产 E2E（1/1；含 scratch 清理） | `71207e607c4dbe87134a722bfdb15d68ef48d979f3193e3606e1c61b14bdabba` |
| `desktop-suite-repair.txt` / `.exit.txt` | desktop 全量（2977/2966/0/11，最终提交重跑）与 exit | `a654f4daea0e911edd9d336e58a30b5ffefd663bd03938b270ea9e73faf1e091` / `19eaf43821a7660ec323a87c8457bf74823beb296c39f5e01aa8a683aa50f061` |
| `omp-runtime-vitest-repair.txt` + `.gz` | 包 vitest 输出（24 files / 384 passed / 6 skipped）；`.gz` 为原始字节（`gzip -n -9`），`.txt` 为去掉 EOF 空行并注明归一化的可读副本 | `.txt` `2c2ec52585de9c8dc3a8109a9cc9b482c779797121186b6488127641e597ca65`；`.gz` `333945a82a9a7daa5453629f7f3851bb54e9eb108618a87979ea3d6e64501c05` |
| `desktop-targeted-repair.exit.txt` | 五个针对性套件的 exit code（全 0） | `07c4ac3e58d4e725043534ae4c39da3c6b54c545431ca4d642610b5da3c0710e` |
| `start-handler-semantics-repair.txt` | 语义探针（1/1） | `dca494ffabe47f158456ba060068b95446877b788e8effc9703fbb01d757c51a` |
| `b14-counterexamples-repair.txt` | B14 常驻反例（2/2） | `4804574dcc3ca19cbd4bd098a3cb6893adfa3e05da26be91a89d13af23ed1bb5` |
| `skill-path-e2e-repair.txt` | 技能路径真实运行时 E2E（6/6） | `4b2d85f3346ece44e0e4bbceeaf64adb76480bf0ac2467501bb5e65f3e90772f` |
| `compiled-gate-sidecar-repair.txt` | 真实 Bun 编译工具门（9/9） | `7707f1ec9ef2c89bc12053f6dd2efa9abbd52959c750c5d0165d53c186716ea4` |
| `build-typecheck-lint-repair.txt` | build:js / 全仓 typecheck / lint 输出与 exit（全 0） | `a91a9ccfaec11631e2571a14e21273d44501b309106b283f35ae76bfc2548dea` |
| `checks-repair.txt` | 矩阵 lint / gap 探针（g1 退场 + g2/g3 open，exit 1）/ omp-patch / release-docs / agent-policy / locales 79 对 / check-docs（6 预存在）/ check-architecture（1 预存在）输出与 exit | `836fb0eed90864ce08c63ae21aff028483d03240e6bb16309c1ca83155131c4c` |

（SHA-256 在同一提交内计算；`repair-red/` 为复审侧原始字节，未做归一化。`omp-runtime-vitest-repair.txt` 为去掉 EOF 空行的可读副本，原始字节存于同目录 `.gz`。）

## 10. 2026-10-02 第二次独立复审返修（R1-R3；RED 原样归档 `repair2-red/`，GREEN 追加）

### 10.1 判定与 RED（原样归档，未编辑）

第二次独立复审（Mac arm64 / Node v24.14.0 / Bun 1.4.2，基线 `064c738ad585b8429a2d0d42d08719596a46f5cc`，即 §9 首轮返修提交）确认首轮 F1-F4 的真实补丁 OMP + 生产 bridge/gate + 本地 FakeProvider 组合 GREEN、owned 进程/scratch 全部回收，但判 `changes-required` 三条：

| 编号 | 反例（原证据，字节未编辑） |
| --- | --- |
| R1 | `repair2-red/production-state-failure-probe-064c738a.json` 策略 `delete-channel-files`：bridge 写入有效状态后、gate 读取前同时删除 `desktop-state.json` 与 `desktop-state.required`；真实生产 gate 仍发出 **providerRequests=1** 并以正常 agent 事件/completed turnEnd 收尾——可变文件缺失把强制通道降级为可选（与 F1 同一不变量） |
| R2 | 同脚本策略 `required-marker-symlink-write`：真实 `markDesktopStateRequired` 跟随符号链接，把外部目标从 `ORIGINAL` 改写成 `1\n`（`desktop-state.ts:249` 的普通 `writeFileSync`；原有状态 writer 的别名防护没有覆盖这条新写入路径） |
| R3 | `repair2-red/start-refusal-replay-064c738a.json`：真生产 runner/codec + 脚本化正式 RPC 帧（复审明确声明这是 runner 层负例，不是真实 OMP 进程重放 stdout）；第 1 代被精确合法拒绝后在 idle 结束，第 2 代被接受但尚未 `agent_start` 时重放同一旧描述符 → `beforeReplayState=running`、`afterReplayState=idle`、**`replayedNoticeClosedNewGeneration=true`**（旧归属只匹配 native 身份 + 未 start，没有代号绑定） |

### 10.2 返修内容（生产坐标）

| 反例 | 返修 | 坐标 |
| --- | --- | --- |
| R1 | 强制通道改为**启动域开关**：`OmpRuntimeSupervisorOptions.desktopStateRequired`（生产 wiring 恒 `true`；未写状态的夹具显式 `false`）在 spawn 时把 `OMP_DESKTOP_STATE_REQUIRED=1|0` **显式**写进子进程 env（永远覆盖 ambient/`extraEnv`），gate 只从 env 读；文件系统缺失/不可读/被替换不再影响开关。第一次返修的 `desktop-state.required` 文件、`markDesktopStateRequired` 与基于 `stat`/路径的 `isDesktopStateRequired(path)` 整体删除 | `desktop-state.ts`（`DESKTOP_STATE_REQUIRED_ENV` + 值语义判定）、`supervisor.ts`（选项 + spawn env）、`omp-runtime.ts`（adapter `createSupervisor` 透传）、`omp-session-wiring.ts`（恒 `true`）、`omp-session.ts`（不再写标记）、`omp-desktop-gate.ts`（`env?.OMP_DESKTOP_STATE_REQUIRED`） |
| R2 | 标记写入路径删除后，生产通道上不再有任何"直接 `writeFileSync` 到可变路径"的写入；仅剩的状态写入保持既有原子/no-follow/alias-safe 语义（同目录唯一临时文件 `wx` 0600 + rename；symlink/hardlink 只被替换为条目、绝不跟随改写其别名目标；失败保留旧文件、无残留临时文件）。新增用例断言 writer 在该目录只留下状态文件本身（不存在第二个可删除的通道文件） | `desktop-state.ts`（writer 未改）、`desktop-state.test.ts` |
| R3 | 新增 turn-fence 协议（`session/turn-fence.ts`）：每次准入回合 runner 铸造随机 32-hex token；先用正式 RPC `get_available_commands` 确认受信 gate 以 `source=extension` 注册了内部命令 `/omp-desktop-turn`（缺失/列表畸形 → 在提交用户 prompt 之前拒绝，握手文本绝不流入 provider），再经正式 RPC `prompt` 安装 token 并等待 gate 经 `notify` 的版本化 ack（`v:1`/kind/token）；拒绝描述符升到 `v: 2` 并携带 `turnToken`，runner 要求 native 身份 + fence 已确认 + `turnToken === 本代 token` + 未 `agent_start` 才关闭该代——旧 token 的重复投递、上一代迟到描述符、错误/`null` token、他会话、stop 退役/已 dispose 一律只计数。顺带修复同批暴露的相邻缺陷：**已关闭的代号不再被 transport 失败补发第二个终态**（合约模式重建 reclaim 时会触发，会在已完成回合上多挂一个 error） | `session/turn-fence.ts`、`session/start-refusal.ts`（v2 + `turnToken`）、`session/runner.ts`（`armTurnFence`/`expectTurnAck`/`handleTurnAck`/归属条件/诊断 `turnFences`/`ignoredTurnAcks`/`closeGeneration` 守卫）、`extensions/omp-desktop-gate.ts`（`registerCommand` + token 存储 + ack + 描述符） |

实现依据（返修前核对固定源码 + 本机实测）：固定 runtime 的扩展 API 公开 `registerCommand`（`extensibility/extensions/types.ts:1371`；`extensions/loader.ts:234` 落库）；`agent-session.ts` 的 `#dispatchPrompt` 在 provider 循环**之前**执行注册命令（`#tryExecuteExtensionCommand`，~7092 行）；RPC `prompt` 分发在 `modes/rpc/rpc-mode.ts`（~1187 行）；`get_available_commands` 返回 extension 来源命令（`slash-commands/available-commands.ts`）。本机独立探针实测：`available.ours=[{name:"omp-desktop-turn",source:"extension"}]`、握手 prompt → `providerDelta=0` 且 `promptResultFrames=[{type:"prompt_result",agentInvoked:false}]`、ack notify 命中 token、随后真实 prompt `providerDelta=1` 且 `agent_start/agent_end` 正常（探针为开发辅助，tracked 证据为下表测试）。

### 10.3 GREEN 计数与证据（2026-10-02，Linux x64 / Node v24.14.0 / Bun 1.4.2；全部本地 FakeProvider，无付费/远程模型）

| 命令 | 结果 | exit | 原始日志 |
| --- | --- | --- | --- |
| `pnpm -C packages/omp-runtime test` | 25 files / **400 passed / 6 skipped**（+16：turn-fence 线协议、runner 归属矩阵、gate 命令/token、supervisor/env、malformed v1/v2 等） | 0 | `omp-runtime-vitest-repair2.txt` |
| `node --test test/omp-runtime-state-e2e.test.mjs`（真实补丁树 + 生产 wiring/gate + FakeProvider + mutator/witness 夹具） | **1 passed**（15.6s）：P1-P8 全保；第 9 阶段改为 ①首个 prompt 同时删除状态文件与旧标记路径 → 拒绝（零 provider）②恢复 ③同会话后续回合再次同时删除 → 拒绝 ④malformed/oversize → 拒绝 + 恢复 ⑤unknown-schema/identity-missing/owned-invalid → 拒绝 + 恢复 ⑥`foreign-notify` 与 `forged-own-session-notify`（本会话 id + `turnToken:null`，旧归属会误关闭）负对照正常完成 ⑦Plan 夹取后回 Agent 的进程重建（stop/reclaim + retire runner）→ 全新 gate 重新武装 fence → 重建后真实拒绝 + 恢复；全程 provider 请求精确计数、恰一 error/turnEnd、身份/历史无重放、attempts ≤2 | 0 | `b1-e2e-repair2.txt` |
| `node --test test/*.test.mjs`（`apps/desktop` 全量） | **2977 tests / 2966 pass / 0 fail / 11 skipped** | 0 | `desktop-suite-repair2.txt` |
| 真实运行时套件组（start-handler 语义 / session / subagent / skill-path / host-tool / persistence / concurrent-approval / capability-source） | **24 passed** | 0 | `runtime-e2e-repair2.txt` |
| `node --test test/omp-sidecar.test.mjs`（真实 Bun 编译 gate、不同 TMPDIR 深度同字节） | **9 passed** | 0 | `compiled-gate-sidecar-repair2.txt` |
| `pnpm build:js` / `pnpm -r --if-present typecheck` / `pnpm lint` | 全绿 | 0 / 0 / 0 | `build-typecheck-lint-repair2.txt` |
| matrix ids / gap 探针 / omp-patch / release-docs / agent-policy / locales / check-docs / `git diff --check` | `MATRIX-ID-OK` / `GAP-RETIRED g1` + `2 gap(s) open [g2, g3]` / `OMP-PATCH-OK 62bc57b+omp-desktop.3` / 对齐 0.15.2 / 通过 / 79 对 / **6 项预存在**（508 页）/ 干净 | 0 / **1（预期）** / 0 / 0 / 0 / 0 / **1（预存在）** / 0 | `checks-repair2.txt` |

未跑：host-core / cargo / 283MB 打包（本轮未改 Rust、未改 patch 构件/manifest/pins）。仅 Linux x64。

### 10.4 验证层次与不声称

- **R1**：单元（supervisor 默认 `1`、显式 opt-out 写 `0`、`extraEnv` 无法翻转；gate 的 required 只由值决定；`desktop-state.test.ts` 的"无伴随通道文件"）+ 生产 E2E（首/后续回合同时删除通道文件仍拒绝、零 provider、修复后恢复）。
- **R2**：标记写入路径已删除；原有状态 writer 对抗性用例（symlink/hardlink/目录/不可写目录/无残留）全绿 + 新增"writer 只留状态文件"断言；复审脚本在自有临时目录内的行为已作为 RED 归档（未编辑）。
- **R3**：runner 层负例矩阵（精确重复：idle 与下一代 awaiting-start；上一代迟到描述符；错误 token；`null` token；他会话；`agent_start` 后；stop 退役后；dispose 后；无 run；下一代真拒绝仍只关该代；缺命令/未 ack 在提交前失败且不发送用户 prompt）+ 生产层（真实拒绝/恢复、Plan→Agent 重建后的真实拒绝、伪造描述符负对照）。
- **不声称**：真实 OMP 进程不会在 stdout 上重放帧（复审脚本本身即 runner 层负例）；本修复证明的是"任何非本代 token 的拒绝描述符都不关闭本代"，涵盖未来一切延迟/重复投递。用户键入保留命令名（`/omp-desktop-turn <32hex>`）会被运行时按扩展命令本地消费（与任何扩展命令同语义，无用户可见输出）；桌面自身每次 prompt 先安装新 token，产品路径不受影响——该名称按内部保留命令处理并已文档化。

### 10.5 返修证据文件（`docs/validation/M5-t20-b1-runtime-state/`）

| 文件 | 内容 | SHA-256 |
| --- | --- | --- |
| `omp-runtime-vitest-repair2.txt` | 包 vitest 原始输出（25 files / 400 passed / 6 skipped，exit 0） | `6cb0f74dbb7011a2794fc9d6d76b28443774d5d40f9ae636995bce5dfaf90e8f` |
| `b1-e2e-repair2.txt` | B1 生产 E2E 单跑（1 passed / exit 0） | `0a2459aa954a51b64c21254482cd10b7e8b849ab01e515e508b347030178484f` |
| `desktop-suite-repair2.txt` | desktop 全量原始输出（2977/2966/0/11，EXIT=0） | `8109daf657d05f4aadc6eef5c2a5ae2ff9be3b3504c649d6d720e813cb985d82` |
| `runtime-e2e-repair2.txt` | 真实运行时套件组（24 passed / EXIT=0） | `13394cedecb416602c0dc99832679e45b16041c1687beeaa1146ad6051b1fc25` |
| `compiled-gate-sidecar-repair2.txt` | 真实 Bun 编译 gate 套件（9 passed / EXIT=0） | `4d9210ff0c125b82978c8c7c482cfceacec7de72423a8895ef2b5ca2024cfd00` |
| `build-typecheck-lint-repair2.txt` | build:js / 全仓 typecheck / lint（exit 0/0/0） | `a964ae2f6bc517d38eae3b161f4910d6ea4d10d9aaa21a1cefcd9245c14fbf96` |
| `checks-repair2.txt` | 矩阵 lint / gap 探针（exit 1 预期）/ omp-patch / release-docs / agent-policy / locales 79 对 / check-docs（6 预存在，exit 1）/ `git diff --check` | `496f7f0d023a8e3e1a429972a4e1f7770c94eb7db5c48c4b1c8992d7d4f8707e` |
| `repair2-red/*` | 第二次复审原始 RED（summary/probe/replay）+ `SHA256SUMS.txt` + `README.md`（说明与哈希） | 见 `repair2-red/SHA256SUMS.txt` 与 §10.1 |

（`repair2-evidence-sha256.txt` 为上述 7 个日志的 `sha256sum` 汇总，未做归一化；所有日志为对应命令的原始 stdout/stderr 直接落盘。）

## 11. 2026-10-02 第三次独立复审返修（R4：turn-fence 准备期 Stop 竞态；RED 原样归档 `repair3-red/`，GREEN 追加）

### 11.1 判定与 RED 证据（原样归档，未编辑）

第三次独立复审（Mac arm64 / Node v24.14.0 / Bun 1.4.2；候选提交 `7fa4be024e16c0a1cbafa752052ee46829a7fab3`，被测源码 `50e4f6ee4d7222fbdd47f078f74a28d0a185cb1b`，两者只差两行 Markdown）确认 F1-F4、R1、R3 的独立探针全部 GREEN（缺失/不可解析/owned-invalid/两文件同删 → provider0、恰一 error/turnEnd、idle、下一 prompt provider1；Agent 插件/原生/deferred 目录恢复；新旧拒绝描述符矩阵含正对照），但判 `changes-required` 一条（R4/P1）：

| 编号 | 反例（原证据，字节未编辑） |
| --- | --- |
| R4 | 新增的异步 turn-fence 准备忽略准备期间到达的 Stop：`runner.prompt` 在 `armTurnFence` 之后无条件提交用户 prompt，`armTurnFence` 在 await command discovery 之后不重验“本代是否仍被准入”。真实线序 `get_available_commands → abort → 内部绑定 prompt → 用户 prompt`：Stop 时 `state=stopping`、`providerAtStopRequest=0`，但 bridge 仍 `accepted=true`、**`providerRequests=1`**（被取消的 prompt 在 abort 之后被提交并完整执行）；固定运行时早于 `agent_start` 的 abort 不产生 `agent_end`，所以协议内 abort 无法取消尚未分发的 prompt。同批 `start-refusal-generation-*.json` 的新旧描述符矩阵（含正对照）继续 GREEN |

原始文件：`repair3-red/production-fence-stop-race-50e4f6ee.json`、`repair3-red/production-fence-stop-race-probe.mjs`、`repair3-red/start-refusal-generation-50e4f6ee.json`、`repair3-red/start-refusal-generation-review.mjs`、`repair3-red/production-state-failure-probe-50e4f6ee.json`、`repair3-red/third-review-summary-7fa4be02.json`。

### 11.2 返修内容与实现坐标

**把 turn-fence 准备绑定到“被准入的那一代”，每个 await 之后重验取消/生命周期归属。** `runner.ts` 在 `prompt` 里把本代的 `RunRecord` 捕获为本地 `run`，并新增：

- `isCurrentRun(run)`：当且仅当 `state === "running"` 且 `this.run === run` 时该代仍可提交内容。Stop 在 `performStop` 的**第一个 await 之前**同步把状态置为 `stopping`，dispose 同步清空 `run`，两者都是本代的取消。
- `closeCancelledRun(run, reason)`：当该代仍是本 runner 的时候取消其 dialogs 并以 `aborted` 关闭（恰一次 turnEnd）；dispose/teardown 已关闭的代、替换后的新代一律不动。
- `refuseCanceledPreparation(run)`：先 `closeCancelledRun`，再抛 typed `stopping` 拒绝。

重验点（按修复后代码顺序）：①`get_available_commands` 响应到达后、**缓存命令可用性之前**；②握手的 `prompt` 请求异常/响应到达后；③ACK 等待返回后；④`prompt()` 内最后一道同步检查，紧跟 `runtime.request({type:"prompt", message})` 写入之前（同一次同步块，中途无 await，Stop 无法插入）；⑤`prompt()` 的 catch 中：本代仍现行 → 原有关闭路径；已在别处被取消但仍是本 runner 的代 → `closeCancelledRun`。`performStop` 在置 `stopping` 后立即 `pendingTurnAck?.settle(false)`：Stop 直接取消对 ack 的等待，不必等 fence 截止时间，也不会让迟到的 ack 之后装上过期 fence。被取消代不再发送用户 prompt、不 arm fence、不 `turnFences++`、不缓存/触碰新代。

真实运行时语义依据（返修前核对固定源码，与复审 RED 线序一致）：`abort` 是**普通（串行）RPC 命令**（`rpc-mode.ts` 的 `RpcInputDispatcher` 只让 control 帧插队，`bash` 后台分发），因此它排在已提交帧之后、无法撤销尚未分发的 prompt；`agent_start` 之前的 abort 不发 `agent_end`（复审探针与本机生产反例均实测）。用户 Stop 的准备期结果：prompt 以 `stopping` 被拒、恰一次 `turnEnd(aborted)`、回到 idle、Stop `converged=true`/`toreDown=false`（保留活进程）、下一次真实 prompt 在同一 runtime/持久 native 会话上正常准入。不伪造 `agent_end`、不用私有 API、产品代码无 monkeypatch、无额外 provider 请求、无 token 泄漏。

### 11.3 GREEN 计数与证据（2026-10-02/03，Linux x64 / Node v24.14.0 / Bun 1.4.2；全部本地 FakeProvider，无付费/远程模型）

| 命令 | 结果 | exit | 原始日志 |
| --- | --- | --- | --- |
| `pnpm -C packages/omp-runtime test` | 25 files / **404 passed / 6 skipped**（+4：discovery / 握手响应 / ACK 三个边界 + dispose 准备期取消；含 stop 重试 `nothing running`、下一 prompt 新 fence、迟到 ack 只计数、不 arm 过期 fence） | 0 | `omp-runtime-vitest-repair3.txt` |
| `node --test test/omp-session-turn-fence-e2e.test.mjs`（**新增**：真实补丁 OMP + 生产 bridge/runner/gate + FakeProvider；seam 只用公开 `runtimeFactory` 包裹真实进程的 request 转发） | **1 passed**（8.2s 单跑 / 16.2s 负载下）：control 正常 provider1；`stop-on-command-discovery`、`stop-on-fence-handshake` 两策略下 Stop 同步置 `stopping`、取消的 prompt 以 `stopping` 被拒、**providerRequests=0**、无用户 prompt 帧、恰一 `turnEnd(aborted)`、无 agent 事件、无伪造 `agent_end`、无宿主/文件副作用；恢复 prompt 在同一 bridge/持久 native 身份（`new_session`=1、`switch_session`=0、persist=1）上 provider1 完成、turn 身份不同；dispose/最终 stop `reaped && cleaned` | 0 | `turn-fence-stop-e2e-repair3.txt` |
| `node --test test/omp-session-bridge.test.mjs` | **51 passed**（+1：`stop during turn-fence preparation...` discovery 与 ack 两个 held 边界；stop 不提前返回、恰一 aborted、下一 prompt 在同一 runtime 上恢复） | 0 | `desktop-suite-repair3.txt`（全量内含） |
| `node --test test/omp-runtime-state-e2e.test.mjs`（B1 生产 E2E，真实补丁树 + 生产 wiring/gate + mutator/witness） | **1 passed**（15.4s；P1-P9 与拒绝/恢复矩阵保持） | 0 | `b1-e2e-repair3.txt` |
| 真实运行时套件组（start-handler 语义 / session / subagent / skill-path / host-tool / persistence / concurrent-approval / capability-source） | **24 passed** | 0 | `runtime-e2e-repair3.txt` |
| `node --test test/*.test.mjs`（`apps/desktop` 全量，`env -u SSH_ASKPASS`） | **2979 tests / 2968 pass / 0 fail / 11 skipped** | 0 | `desktop-suite-repair3.txt` |
| `pnpm build:js` / `pnpm -r --if-present typecheck` / `pnpm lint` | 全绿 | 0 / 0 / 0 | `build-typecheck-lint-repair3.txt` |
| matrix ids / gap 探针（`OMP_T20_GAP_PROBE=1`）/ omp-patch / release-docs / agent-policy / locales / check-docs / `git diff --check` | `MATRIX-ID-OK` / g2/g3 open（exit 1 预期）/ `OMP-PATCH-OK 62bc57b+omp-desktop.3` / 对齐 0.15.2 / 通过 / 79 对 / **6 项预存在**（508 页）/ 干净 | 0 / **1（预期）** / 0 / 0 / 0 / 0 / **1（预存在）** / 0 | `checks-repair3.txt` |

RED（最终版新测试 + 临时还原的未修复 runner 源码及其重建 `dist`，原始 stdout/stderr 直接落盘并追加 `EXIT=1`）：runner 层 **4 failed / 40 passed**、bridge 层 **1 failed / 50 passed**、生产 E2E **1 failed**（三份日志归档于 `repair3-red/`，与被取消行为一致）。GREEN 前已恢复修复源码并重建（E2E/桌面套件经包 `dist` 消费产品运行时）。

未跑：host-core / cargo / 283MB 打包（本轮未改 Rust、patch 构件、fork、pins/manifest）。仅 Linux x64。门禁 `desktopStateRequired` 生产 wiring 未改。

### 11.4 验证层次与不声称

- **runner 层（确定性）**：三个 held 边界（command discovery / 握手响应 / gate ACK）+ dispose 准备期取消各一个用例；断言零用户 prompt、零 fence arm、恰一 aborted、dispose 不再继续准备、stop 重试 `nothing running`、迟到 ack `ignoredTurnAcks` 计数且不影响下一代的 fence。
- **bridge 层**：同一不变量在两个 held 边界上通过真实 bridge/runner 生命周期验证（含 stop 不提前返回、`toreDown=false`、恢复 prompt 在同一 runtime/持久身份）。
- **生产层**：真实固定已补丁 OMP 进程 + 生产 bridge/runner/gate + FakeProvider；seam 只在真实帧提交后同步触发用户 Stop，不延迟/伪造/重排任何 RPC 帧或响应，control 策略证明同一层可正常 provider1；断言 provider 精确计数、线序（无用户 prompt）、恰一终态、恢复同一 native 身份、无文件副作用。
- **不声称**：未验证真实 OMP 在 stdout 上重放帧（本轮不涉及）；未改/未重跑 Rust、patch 构件与打包；g2/g3 仍 open，T20 未完成、Plan/Goal 未实现、能力关闭；B1 验收仍待本地复审；仅 Linux x64，无 macOS/Windows 实机、无真实付费模型。

### 11.5 返修证据文件（`docs/validation/M5-t20-b1-runtime-state/`）

| 文件 | 内容 | SHA-256 |
| --- | --- | --- |
| `omp-runtime-vitest-repair3.txt` | 包 vitest 原始输出（25 files / 404 passed / 6 skipped，EXIT=0） | `eb9dd67f61f125427bba762f6bbd52dd9a1dc479943c6d14ec83f00f9a25e5be` |
| `turn-fence-stop-e2e-repair3.txt` | 新增生产反例 E2E（1 passed / EXIT=0） | `c03cf968b87129851199657e379abcddf7d15f3616ed03a88837ddccf593659a` |
| `b1-e2e-repair3.txt` | B1 生产 E2E 单跑（1 passed / EXIT=0） | `f40d3b516a1c957f480dd65cd2a8429ae5e7fef068855322eca3af368799a4ff` |
| `runtime-e2e-repair3.txt` | 真实运行时套件组（24 passed / EXIT=0） | `5118c5df6569fee2f44d7731c175939b25c2bf9066069c56e30b0a123896ab4a` |
| `desktop-suite-repair3.txt` | desktop 全量原始输出（2979/2968/0/11，EXIT=0） | `7def3556fe63641ae9235b330b103e968381892cf40ad1046482c32c9a1b5c57` |
| `build-typecheck-lint-repair3.txt` | build:js / 全仓 typecheck / lint（exit 0/0/0） | `9b084b7f3aaa48f4f78180711c7c9491602ef1e48d77439fa3d09446af57e513` |
| `checks-repair3.txt` | 矩阵 lint / gap 探针（exit 1 预期）/ omp-patch / release-docs / agent-policy / locales / check-docs（6 预存在，exit 1）/ `git diff --check` | `53c15e9478e62cd93fa63f7266eea2e348945eef8314940848b2da15adfbf543` |
| `repair3-red/*` | 第三次复审原始 RED（summary/probe/replay，未编辑）+ 本轮三份新测试 RED 日志 + `SHA256SUMS.txt` + `README.md` | 见 `repair3-red/SHA256SUMS.txt` 与 §11.1 |

（`repair3-evidence-sha256.txt` 为上述 7 个日志的 `sha256sum` 汇总；所有日志为对应命令的原始 stdout/stderr 直接落盘，仅追加 `EXIT=` 行。）

## 12. 2026-10-03 证据归档整理（gzip；B1 最终区间空白检查收尾，非行为轮）

根复审独立验收 `bff27e1`（行为判定 `B1 behavior accepted`）后，唯一遗留的归档级问题是：
`git diff --check 7fa4be0 bff27e1` **exit 2**，且全部命中只来自两份**字节原样**的 RED 日志——
`repair3-red/bridge-test-red.txt` 第 67/70 行与 `repair3-red/e2e-test-red.txt` 第 17/20 行
各有一个只含两个空格的原始 TAP 输出空行（`node --test` 原样 stdout）。按归档范围修复
（不改产品代码、不改行为结论、不重开 B1）：

| 文件 | 处理 | 解码后 SHA-256（= `bff27e1` 中的 Git blob） | 归档 `.gz` SHA-256 |
| --- | --- | --- | --- |
| `repair3-red/bridge-test-red.txt` → `.txt.gz` | 确定性 gzip（`compresslevel=9, mtime=0`，头部无文件名；`.gz` 字节是捕获字节的纯函数），跟踪明文删除 | `975875e11cde84effff37a58444d64b668a679a2c86b055aabd7963f53a2512e` | `0727b12e4cb9b9978ef973401cbe034640091d6efb34ef1ee9d085a36d75197d` |
| `repair3-red/e2e-test-red.txt` → `.txt.gz` | 同上 | `ddb5a4829a70961bcc22bcb0e170b5a213139843266144263727c2cab4fc6d24` | `f5e18c14d8ce2c638d59e2b220d7820c558c1f3d8fc75411a1ea21a22927f350` |
| `repair3-red/runner-tests-red.txt` | 无空白问题，保持明文原样 | `83ed30b501167ea88c1627cb8cc8763bbfd908be3621f0f80c6d4349766e56b5` | —（未压缩） |

验证（本机 Linux x64 / Node v24.14.0）：`git show bff27e1:<path> | sha256sum` 与
`gunzip -c <path>.gz | sha256sum` 对两份文件逐一相等，且 Python `gzip.decompress` 与原始
`git show` 字节 `==`（逐字节，不只是摘要）；`.gz` 头部实测 `1f8b0800000000000203`
（无 FNAME、MTIME=0）。`repair3-red/README.md`（含两种摘要与解码命令）与
`repair3-red/SHA256SUMS.txt`（每个跟踪文件的实际摘要）已同步更新。

**更正后的口径**：历史区间 `7fa4be0..bff27e1` 的 `git diff --check` 退出码**仍是 2**（提交对象不可变，
不剥离原始捕获空白、不重写历史、不放宽空白规则）；修正后的最终区间 `7fa4be0..<本归档提交>`
空白检查为 0。B1 的行为证据、计数与结论均不变。

同轮归档：根复审方对 `bff27e1` 的独立验收原始证据（判定 JSON、Mac 构建/vitest/定向 desktop 日志、
生产 Stop/恢复与状态失效探针、拒绝分代矩阵、17 份证据哈希核对）经 `/tmp/omp-t20-c-root-handoff-20261003/`
移交，已**字节原样**保存到 `root-acceptance-20261003/`（含 README 说明与逐文件 SHA-256；
**非本工作区产出**，本工作区未运行 macOS、未运行根复审探针，只做复制与哈希核对）。
