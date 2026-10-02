# M5/T20-C：执行时权限决策与插件真实模式 —— 验证记录

更新时间：2026-10-03。状态：**T20-C 实现完成、待独立复审；T20 未完成、Plan/Goal 未实现、`plan`/`goal` 能力保持关闭。**
本阶段只实现执行时权限与模式传播（矩阵 C1-C8），不注册 `SubmitPlan`/`SubmitGoal`、不接通审批/派发（B4-B9/B2 仍开放）、不改 Pi-only 审批派发、不发布包、不合并 main。

- 分支 `codex/m5-t20-c-execution-policy`；基线 `bff27e11363d3a60b59265ff91d2fb3d814b574a`（B1 独立验收提交；根复审证据已归档在 `M5-t20-b1-runtime-state/root-acceptance-20261003/`）。
- 归档整理提交 `95023d5`（RED 日志确定性 gzip；详见 B1 记录 §12）与 `02bf603`（根复审验收证据归档）；**实现提交 `a7d0291bf500918e754b6a7e9870e3b8961d4e71`（代码/测试/脚本），文档与证据提交 `6d15d32`**（追加提交，不 amend/rebase/强推）。
- 环境：Linux x64；Node v24.14.0（nvm 24.14.0 bin）；Bun 1.4.2；固定子模块 OMP `62bc57be1b03ef0802a33cf7f5f530e534527531`（omp/18.3.0，patch `.3`）、PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`。
- 全部运行使用**本地 FakeProvider / 固定已补丁 OMP 运行时 / 生产 wiring**，未调用任何付费或远程模型；未重跑 Rust host-core 606、未做 283 MB 打包（本阶段未改 Rust、patch 构件、pins/manifest）。

## 1. 实现

### 1.1 单一策略快照 → 一张决策表

`decideToolCall`（`packages/omp-runtime/extensions/omp-desktop-gate.ts`）改为消费 B1 写入的运行域状态快照
（`mode` / 已解析 `permissionMode` / 每宿主工具 `{risk, planSafeActions, origin}`），按 PI §1.3.1 顺序执行：

1. **合约硬拒绝最先**：`plan`/`goal` 下 PI allowlist 之外的任何工具、无非空 `planSafeActions` 的插件工具，
   在任何 permissionMode、legacy `allow`、Low 风险、session grant、外部路径、无 UI 判断之前 block；
   拒绝码 `WRITE_DISABLED_IN_PLAN` / `EDIT_DISABLED_IN_PLAN` / `PLUGIN_DISABLED_IN_PLAN` /
   `TOOL_DISABLED_IN_PLAN`。合约许可：`read`/`glob`/`grep`/`bash` + `ask`（OMP 非变更型提问工具；
   PI 的提问通道是宿主 UI、无模型工具）+ PI 专名 `BrowserPreview`/`new_context`（本运行时不注册，不虚构）；
   声明非空 `planSafeActions` 的插件工具落入常规判定，逐 action 由插件运行时 guard 把守。
2. **显式外部路径**：`auto` 放行、session grant 放行、否则弹卡（无 UI → fail closed）。
3. **风险**：Low 放行；`auto` 放行；`accept-edits` 仅 Write/Edit 自动；session grant 放行；其余弹卡。
4. **无 UI 只在"本就需要交互"处 fail closed**；`policyUnavailable`（强制通道开启但无可信策略）block 每个调用。

`OMP_DESKTOP_GATE_MODE` 降级为夹具开关，位于合约拒绝之下（不能复活合约拒绝的工具）；生产启动器从不写它。

### 1.2 风险保真（G9 收口）

- 原生名按 PI `tool_risk_with_declared`：`read`/`glob`/`grep`（+PI `ScheduledTaskList`）Low；`write`/`edit`/`bash`
  （+`GenerateImages`）High；其余含 `apply_patch`/`eval`/`browser`/`computer`/`BrowserPreview` 一律 Medium。
- 宿主工具取状态策略表的**声明**风险：插件 `low|medium|high`，缺失/非法/未注册 → Medium；用户 MCP → Low
  （仅在非合约模式生效，合约模式先被硬拒绝）。
- 默认 gated 原生名单增加 `browser`/`computer`/`browserpreview`，使 PI 未命名的 Medium 能力在 ask/accept-edits
  弹卡而不是无审批执行（`browserpreview` 在本运行时不存在，只为按 PI 契约名判定而列入）。
- 卡片 risk/reason/mode/permissionMode 与决策来自同一对象；描述符新增可选 `mode` 字段（`approval-protocol.ts`）。

### 1.3 外部路径：host-core 语义移植

新增 `packages/omp-runtime/src/session/tool-paths.ts`，逐条移植 `crates/host-core/src/workspace.rs`：
词法 `.`/`..` 归一与根钳制、按组件包含（Windows 大小写不敏感）、最深已存在祖先 canonicalize、
有界（32 跳）悬空符号链接跟随、workspace/scratch 双根解析与"广告拼写 ≠ 规范拼写"的前缀重写、
`requires_external_path_permission`（`Read|Glob|Grep|Write|Edit` + 显式 `path`）。OMP 会话当前没有 scratch 根
（scratch 是 Pi sidecar 概念），gate 传 `null`；参数保留并有专门测试，语义与 PI 一致。

### 1.4 插件真实模式（g2 退场）与上游缺口修复

- bridge 在每次被准入 prompt 后记录 `{turnId, mode}`；`OmpHostToolBinding.modeForTurn(turnId)` 只对该
  **精确回合**作答（未知/陈旧/委托回合 → `null`），适配器在 `dispatchable()` 之后、任何派发之前读取：
  `null` → 拒绝；用户 MCP 在非 `agent` 模式拒绝（`TOOL_DISABLED_IN_PLAN`，PI host-core 在插件桥之前同样拒绝）；
  插件工具收到**真实 mode**，PI 的逐 action `planSafeActions` guard（`plugin-runtime.ts:2504-2532`）因此在执行时生效。
- **修复一处可证实的上游缺口**：`plugin-host-process.mjs` 的 `pi.agent.registerTool` 此前只转发
  `{name, description, risk, schema}`，丢掉了 `planSafeActions`——host 侧注册表与 guard 读的是该字段，导致
  子进程声明的 plan-safe 列表永远到不了 guard、合约模式下插件工具永远不可用。现按声明转发
  （`planSafeActions !== undefined` 时带上）；该文件与固定 PI 上游逐字节相同，属 fork 修复，已在 ADR 0309 记录。
- 委托（`hasUI=false`）沿用所属交互会话**最后一次校验通过**的快照（进程级、按状态文件 `writtenAt` 年龄界），
  无可用快照则 block；不弹卡、不注入、不提权。

### 1.5 与 B1 的兼容性变更（有意为之，均已记录）

- **Agent+auto 不再为 Write/Edit/Bash/Medium 弹卡**（PI 语义）：B1 E2E 的"approval descriptor"阶段把
  permissionMode 固定为 `ask` 再驱动 write 审批，phase 4 的 `auto` 继承证据保留；
- **用户 MCP 在 Agent+ask 不再弹卡**（PI `mcp_*` = Low 自动放行）：`omp-host-tool-e2e` 的 MCP 用例改为断言
  "零弹卡、恰好执行一次"；
- **默认 gated 名单**新增三个 PI 未命名 Medium 名称（原 5 个不变）；
- **g2 静态检查退场**为 C 的行为测试（见 §2）；g3 仍 open，gap 探针 exit 1 为预期。

## 2. C1-C8 证据映射

| 行 | 场景 | 证据（层） | 结果 |
| --- | --- | --- | --- |
| C1 | 合约硬拒绝：Write/Edit/apply_patch/未知/`mcp_*`/无声明插件在**所有** permissionMode 与 legacy `allow` 下 block；合约许可集合正确 | gate 单元 `gate-permissions.test.ts`（plan/goal × ask/accept-edits/auto × 9 工具 + allow/grants/外部路径组合；拒绝码逐类）；编译产物探针 `omp-sidecar.test.mjs`（Bun 打包的真实 gate：plan Write block、无卡）；生产 E2E 以目录层如实标注隐藏工具的 not-found（不冒充 gate 拒绝） | 全绿 |
| C2 | Bash 无命令分类：inherit→默认、ask→卡、accept-edits→卡、auto→放行、Plan+auto 放行 | gate 单元（`ls` 与 `rm -rf /` 决策逐项相同）；生产 E2E（Agent+ask 批准后真实写文件；Plan+auto 真实写文件；Plan+ask 拒绝后零副作用） | 全绿 |
| C3 | 插件：无声明合约拒绝；有声明逐 action 允许/拒绝；`ctx.mode` = 真实模式 | 真实 `PluginRuntime` 子进程测试 `omp-plugin-plan-safe.test.mjs`（agent→`"mode":"agent"`；plan+`inspect` 允许、`write` 拒绝、无声明拒绝；goal 拒绝；未知回合拒绝；MCP plan 拒绝且 `callTool` 零调用）；生产 E2E（plan+auto 下 `plugin_demo_inspect` 实际执行并记录 `ctx.mode="plan"`） | 全绿 |
| C4 | 子代理 `hasUI=false`：合约模式 fail closed、Agent 语义不提高权限 | gate 单元（委托快照 + plan/goal 硬拒绝 + no-UI fail closed）；注册层测试（委托缓存/年龄界/无缓存 block）；生产 E2E（agent+ask 子代理 write → 无 UI block、文件不存在；agent+auto 子代理 write → 恰好一次） | 全绿 |
| C5 | browser/computer/eval：Agent+auto 放行、ask/accept-edits 弹卡、Plan/Goal 硬拒绝 | gate 单元（三种模式 × 三种 permissionMode × 三个名字；卡 risk=medium）；默认 gated 名单断言 | 全绿 |
| C6 | 四条有效权限模式：inherit 桌面侧解析、gate 只读结果；ask/accept-edits/auto 行为 | B1 生产 E2E（`inherit`→默认 `accept-edits`→`auto` 的逐轮解析与描述符消费，本阶段更新为 ask 弹卡断言语义）；gate 单元（快照 verbatim 消费）；wiring 单元沿用 | 全绿（B1 E2E 1 passed） |
| C7 | 风险保真：plugin 声明/缺失→medium、未知→medium、`mcp_*=low`（仅非合约）、BrowserPreview=medium 且合约许可 | gate 单元（`nativeRiskForTool` 逐名、策略表优先、mcp 在 plan 下即使 `auto`/`allow` 也硬拒绝、BrowserPreview 合约 ask 弹卡/auto 放行）；生产 E2E（plugin 声明 medium 卡、MCP Low 零卡执行） | 全绿 |
| C8 | 外部路径：auto 放行、ask/accept-edits 卡（除非 grant）、无 UI 只在需要交互时 fail closed；`..`/symlink/别名 | 路径移植测试 `tool-paths.test.ts`（Rust 测试逐条镜像 + scratch 拼写重写 + 工具名限定）；gate 单元（外部读 ask 卡/auto 放行/grant 放行/no-UI 语义）；生产 E2E（项目外真实文件：ask 拒绝零内容、auto 读出内容） | 全绿 |

## 3. 生产 E2E（`apps/desktop/test/omp-execution-policy-e2e.test.mjs`，真实已补丁 OMP + 生产 wiring/gate + FakeProvider）

12 个场景一次跑完 **1 passed（5.17s）**，逐场景断言决策与副作用计数：

1. Agent+ask：plugin_demo_echo（声明 medium）→ 卡（risk=medium、reason=审批理由）、拒绝 → 零执行、模型看到
   "denied by user"；2. Agent+ask：`mcp_alpha_lookup`（Low）→ **零卡**、恰好执行一次、结果回到模型；
3. Agent+ask：`bash printf … > marker` → 卡（risk=high）→ 批准 → 文件恰好写入一次；描述符实测
   `{mode:"agent", permissionMode:"ask"}`；4. Agent+ask：项目外 `read` → 卡（reason=external path）→ 拒绝 →
   后续请求无外部内容；5. default 改 `auto`（`inherit` 解析）→ 同一外部读**零卡**且内容回到模型；
6/7. 子代理（`hasUI=false`）：ask 下 write 被 no-UI block（模型收到理由、文件不存在）；auto 下同 write 恰好一次；
8. Plan+auto：隐藏的 `write` 尝试 → 目录层 `Tool write not found`、零副作用、**不声称 gate 拒绝**；
   `bash` 无卡执行；`plugin_demo_inspect` 无卡执行且 `ctx.mode="plan"`；隐藏 MCP 尝试同样目录层；
9. Plan+ask：`bash` 弹卡 → 拒绝 → 零副作用。

**分层诚实声明**：被 B1 目录夹取隐藏的工具（write/mcp/无声明插件）在真实运行时里**不会到达** gate
（`Tool <name> not found`），生产 E2E 只把它记为目录层证据；gate 层对这些工具的合约硬拒绝由
`gate-permissions.test.ts` 与 Bun 打包产物探针 `omp-sidecar.test.mjs`（真实 `bun build` 出的
`omp-desktop-gate.js`，子进程驱动 handler；plan Write block、plan Bash 卡字段、agent MCP 零卡、
缺状态 policy-unavailable）证明。

## 4. 验证命令与计数（Linux x64 / Node v24.14.0 / Bun 1.4.2）

| 命令 | 结果 | exit | 原始日志 |
| --- | --- | --- | --- |
| `pnpm -C packages/omp-runtime test` | **27 files / 437 passed / 6 skipped**（+33：gate-permissions 20、tool-paths 8、gate 更新） | 0 | `omp-runtime-vitest-c.txt` |
| `node --test test/*.test.mjs`（`apps/desktop` 全量，`env -u SSH_ASKPASS`） | **2983 tests / 2972 pass / 0 fail / 11 skipped**（+4：C E2E、plugin-plan-safe 2、编译产物 gate 探针） | 0 | `desktop-suite-c.txt` |
| `node --test test/omp-execution-policy-e2e.test.mjs` | **1 passed**（5.17s） | 0 | `c-execution-policy-e2e.txt` |
| `node --test test/omp-plugin-plan-safe.test.mjs`（真实 PluginRuntime 子进程） | **2 passed** | 0 | `plugin-plan-safe.txt` |
| `node --test test/omp-runtime-state-e2e.test.mjs`（B1 回归；descriptor 阶段按 C 语义固定 ask） | **1 passed**（15.26s） | 0 | `b1-runtime-state-e2e.txt` |
| `node --test test/omp-sidecar.test.mjs`（真实 Bun 打包工具门 + 行为探针 + 深度确定性） | **10 passed** | 0 | `compiled-gate-sidecar.txt` |
| T17-T19 定向回归（subagent e2e/bridge/read、tool-results、host-tool e2e、skill-path e2e、capability-source e2e、turn-fence e2e） | **70 passed / 0 failed** | 0 | `t17-t19-regression.txt` |
| `pnpm build:js` / `pnpm typecheck` / `pnpm lint` | 全绿 | 0 / 0 / 0 | `build-typecheck-lint.txt` |
| matrix ids / gap 探针 / omp-patch / release-docs / agent-policy / locales / check-docs / `git diff --check` | `MATRIX-ID-OK` / `GAP-RETIRED g1`+`GAP-RETIRED g2`+`g3 open`（**exit 1 预期**）/ `OMP-PATCH-OK 62bc57b+omp-desktop.3` / 0.15.2 / 通过 / 79 对 / **6 项预存在**（509 页）/ 干净 | 0 / **1（预期）** / 0 / 0 / 0 / 0 / **1（预存在）** / 0 | `checks.txt` |

未跑：Rust host-core（本轮未改 Rust/构件/pins）、283 MB sidecar 打包（本阶段不发布）、macOS/Windows 实机。

## 5. 未做 / 不声称

- 不注册 `SubmitPlan`/`SubmitGoal`、不实现提交/审批/派发（B4-B9/B2 未动；g3 仍 open）；不开放 `plan`/`goal`
  能力或 UI；不改 Pi-only 审批派发与 Cursor 门（ADR 0306）。
- R3（Cursor exec channel 的批次零副作用）仍是既有范围外硬阻塞事实；本阶段不触碰。
- 未验证真实 OMP 在 stdout 上重放帧；未验证 macOS/Windows；未调用真实模型。
- 隐藏工具的 gate 层硬拒绝只在单元与编译产物层证明；生产层是目录夹取（如实标注，不冒充）。
- 委托策略快照是进程级、按状态年龄界有效；detached 子代理在"用户改了模式但没有下一次 prompt"的窗口内
  仍按上一次提示词的策略裁决——与 B1 的文件通道同一边界，已记录，未声称更强。

## 6. 证据文件

`docs/validation/M5-t20-c-execution-policy/` 下：`omp-runtime-vitest-c.txt`、`desktop-suite-c.txt`、
`c-execution-policy-e2e.txt`、`plugin-plan-safe.txt`、`b1-runtime-state-e2e.txt`、`compiled-gate-sidecar.txt`、
`t17-t19-regression.txt`、`build-typecheck-lint.txt`、`checks.txt`、`SHA256SUMS.txt`。
所有日志为对应命令原始 stdout/stderr 直接落盘并追加 `EXIT=`。
