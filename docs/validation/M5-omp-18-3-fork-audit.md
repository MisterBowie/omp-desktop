# M5/T20-R3D：OMP 18.3 与 nornzach fork / bundled-sidecar 架构审计

更新时间：2026-09-27。分支 `codex/m5-omp-18-3-architecture`，基线 `4a7a5d82589dd4a60c338884eca09bf839184d90`。

状态：**审计完成（只读源码 + 确定性对比 + `git apply --check` 迁移分析）。本轮不改生产代码、不改两个固定子模块的 gitlink/内容、不改 patch artifact 与 manifest；R3 仍为硬阻塞，Cursor 产品门（ADR 0306）保留，T20 未完成、未声称。**

> **2026-10-02 范围说明（链接 `docs/validation/M5-t20-non-cursor-scope.md`）**：用户于 2026-10-02 将 **Cursor + Plan/Goal 移出范围（不支持且拒绝）**；本文档"R3 硬阻塞 / 不得用 OMP 原生 Plan/Goal 冒充 PI parity / 不得删除 Cursor 产品门"的结论继续有效，非 Cursor 路线按新记录的 §4 拆分继续推进。本文档其余事实与证据保持历史原样。

复审返修（独立复审 F1-F6，2026-09-27）：argv 表述、内置 sidecar 解析（`OMP_BUNDLED_OMP`/资源树扫描无 `app.isPackaged` 门）、bundled sidecar 的构建来源可归因性、符号级证据强度、`prepareToolCallDispatch` 与投机的时序、补丁迁移成本按目标分档——六项均已回到固定源码逐条核对后改写（核对命令与观察见 §12.1）。

本轮只新增本文档，并按真实状态最小更新 `docs/04-task-board.md` 与 `HANDOFF.md`。

---

## 0. 结论摘要

1. **oh-my-pi-gui 的架构已由源码核对**：Electron 主进程每个标签页各自 spawn 一个 sidecar，argv **以固定模式前缀 `["--mode", "rpc-ui"]` 开头**，随后按需追加 `--session <file>` 或 `--no-auto-resume`、`--chat`，再追加经拒绝名单过滤的用户 flag（`src/main/sidecar.ts:297-306`；`sidecar.test.ts:46,70,94,100,133,183-198` 钉住完整 argv）。`--mode` 同时在 `DENYLISTED_FLAGS` 与 `DENYLISTED_WITH_VALUE`（`src/shared/launch-profile.ts:44,62,84`）——用户 profile / `extraFlags` **无法改道模式**。内置 sidecar 的解析（`src/main/index.ts:66-112`）依次是：① `OMP_BUNDLED_OMP` 环境变量覆盖（**在任何 `app.isPackaged` 判断之前**）；② `process.resourcesPath/omp`；③ 从 `app.getAppPath()`/`process.cwd()` 向上最多 8 层扫描 `resources/omp` 与 `packages/gui/resources/omp`；此外 `OMP_SIDECAR=source`（+ `OMP_SIDECAR_CLI`）可切到工作区源码 CLI，同样**不看 `app.isPackaged`**。因此可严格证明的是：**不从系统 `PATH` 解析 `omp`**（全部 spawn 调用点都传已解析的绝对路径：`sidecar.ts:317`、`stats-server.ts:61`、`benchmark-runner.ts:121`），且**常规打包产物把 `Resources/omp`（`electron-builder.yml` 的 `extraResources`）作为首选内置资源**；同时存在**显式环境覆盖**与**资源树扫描**两条开发/夹具通道（`e2e/runtime.e2e.ts:21`、`e2e/real-core.e2e.ts:32,37`、`scripts/capture-showcase.ts:76` 都在用 `OMP_BUNDLED_OMP`）。当两条通道都解析不出路径时，`start()` 直接进入 `error` 状态（`sidecar.ts:250-262`）而**不会**去找系统 `omp`。
2. **sidecar 是本地编译产物，不是 `npm` 依赖；但“具体是哪个 fork commit”无法从当前证据精确归因**：`scripts/build-bundled-omp.ts` 只是**按相对路径**读取外层 monorepo（`repoRoot = guiRoot/../..`）的 `packages/coding-agent/src/cli.ts`，用 Bun 编译成独立可执行文件（`packages/coding-agent/scripts/compile-binary.ts:35-79`，`Bun.build({compile:{…}, bytecode:true})`），产物 `resources/omp*` 被 `.gitignore` 排除（>100 MB，不进库）。构建脚本**不校验**外层仓库的 git remote 或 commit（脚本内无 `git rev-parse`/remote 检查；`sync-upstream.sh` 也只 `git fetch upstream` 与读 `packages/coding-agent/package.json` 的版本）；README:212-218 把 `nornzach/oh-my-pi` 规定为**推荐的**外层布局，README §Releasing 步骤 7 只**要求记录**所用 monorepo commit；`CHANGELOG.md` 的 0.9.9/0.9.10 条目只写 “omp 18.3.0”，**没有** commit SHA（历史条目如 `CHANGELOG.md:130,168,190` 有 SHA，但那不能替当前版本作证）。因此可证明的是**设计/推荐流程**从外层 nornzach fork 构建 bundled binary，**不能**把已发布产物精确归因到 `81b9f250`。
3. **Bun 只用于开发与构建（用户侧）**：`package.json` 脚本、`build:omp`、`sync-upstream.sh` 全部用 Bun；运行期 spawn 的是编译后的**自包含**二进制（`src/main/sidecar.ts:305-307`；该二进制由 `Bun.build({compile:true})` 生成，内嵌 Bun 运行时，所以用户无需安装 Bun/Node，也不需要系统 `bun` 去跑脚本）；`resolveBunExe()`（`src/main/sidecar.ts:166-172`）**仅**在显式开发覆盖 `OMP_SIDECAR=source`（`src/main/index.ts:94-110`）时使用。GUI 的 `dependencies` 中没有任何 `omp`/`bun` 运行期包。
4. **13 个指定文件中，6 个在 can1357 v18.3.0 与 nornzach fork 之间逐字相同**：`packages/agent/src/agent-loop.ts`、`packages/agent/src/types.ts`、`packages/ai/src/types.ts`、`packages/ai/src/providers/cursor.ts`、`packages/coding-agent/src/tools/resolve.ts`、`packages/coding-agent/src/modes/rpc/host-tools.ts`（md5 与逐字节比较均为 0 差异）。
5. **另外 7 个文件的差异全部是三类**：①与过渡契约无关的 fork 产品修改（`tools/write.ts` 新增 overwrite diff 详情；`main.ts` 移除上游的 protocol-host 默认设置覆盖、新增 `--chat` 会话类型）；②fork 专有 RPC 面（`modes/rpc/rpc-plan.ts`、`modes/rpc/rpc-modes.ts` 为新文件，`rpc-mode.ts`/`rpc-types.ts`/`agent-session.ts` 大幅扩写）；③格式化漂移（同一行集合仅空白不同，agent-session 3087 行新增中 1014 行、rpc-mode 1940 中 816 行、rpc-types 1803 中 582 行属此类）。**符号级核验（弱证据，只说明“未发现符号级缺失”）**：18.3 相对 18.2.7 新引入的标识符（agent-session 154 / rpc-mode 30 / rpc-types 9 / main 6 / write 23）在 fork 对应文件中**缺失数为 0**。这只说明这些**名字**仍在文件里出现，**不能**推出函数体语义、调用关系或功能行为与 18.3 一致（同名函数可能被改写、调用点可能被替换、行为可能被 fork 的其它改动覆盖）；要断言“功能未丢失”必须由行为测试证明（见 §11 限制）。
6. **nornzach fork 完全没有实现 PI 的 SubmitPlan/SubmitGoal 合同**：`SubmitPlan`/`SubmitGoal` 在**整棵 fork 树（含文档）出现 0 次**；`soleBatch`/`batchPolicy`/“must be the only tool call”同样 0 次。它的 Plan/Goal 走 OMP 原生语义（见第 5 节），与 PI 的“待审批提交工具”是不同概念。
7. **OMP 原生 Plan 链路在 fork 中被完整暴露为 RPC**（上游 18.2.7 与 18.3.0 均无此面，`set_plan_mode`/`plan_proposal`/`plan_approval` 在两者的 `rpc-types.ts` 命中均为 0）：`set_plan_mode` → 模型把计划写到 `local://<slug>-plan.md` → `write xd://propose` → `tool_execution_end` → 发 `plan_proposal` 帧 → **静默 abort**（`markPlanInternalAbortPending` + `session.abort()`）→ 宿主回 `plan_approval` → 控制器按 option 执行/压缩/保存/refine。Goal 侧同理：RPC `set_goal`（objective/tokenBudget + `action: pause|resume|drop`）映射到 **上游早已存在的 `GoalRuntime`**（`goals/runtime.ts` 522 行，三树 md5 相同：create/replace/pause/resume/drop + continuation prompt）。
8. **18.3 的 `BeforeToolCallContext.assistantMessage` + `prepareToolCallDispatch` 只有“整批可见”，没有“整批裁决”**：hook 能看到整条 assistant 消息（`packages/agent/src/types.ts:847-866`），并在**最终/常规 loop dispatch 之前**按调用顺序逐个执行（`agent-loop.ts:2698-2780`；流式路径在 `message_end` 时点，`agent-loop.ts:2033-2056`，受 `finalToolCallsCanDispatch` 门控）。因此“非 Cursor 的 PI 式整批预检”**可以用宿主侧逻辑表达**（对批内**每个**调用返回 block）；但它不是 PI 语义的等价物：hook 对未知工具/参数非法/已被策略 deny 的调用**根本不被咨询**（`agent-loop.ts:2749-2753`），`kCursorExecResolved` 调用被直接 `continue` 跳过（`agent-loop.ts:2708`），且**投机执行不受 hook 时序保护**——`admitFinalized` 在 `toolcall_end`（流式期间）就被调用（`agent-loop.ts:2282-2288`），`#insertCandidate` 随后立刻 `#drain()`（`speculative-execution.ts:808-816`），只有声明 `deferBeforeToolCall` 的候选才等 `#admissionsFinalized`（`:852-855`）；该声明目前只由 coding-agent 的**本地读**投机宿主给出，且**仅当 loop 装了 `beforeToolCall` 时才被协调器采纳**（`packages/coding-agent/src/speculation/host.ts:169-183`），其它 host/无 hook 会话没有普遍保证。
9. **Cursor 的预执行在 18.3 与 18.2.7 中同构，仍使“被拒批次零副作用”不可满足**：`kCursorExecResolved` 语义未变（`packages/ai/src/providers/cursor.ts:1142-1143,1669+`；`agent-loop.ts:647,1376,1451,1507` 一律把这些块从 loop 可执行调用中剔除），provider 侧 `cursor.ts` 在 18.2.7→18.3 的 7 行改动与本主题无关（仅 `node:crypto` → `Bun.SHA256`）。结论与 R3A/R3B 一致，**不解除 R3**。
10. **迁移成本按目标不同，且“能力已进上游”为 0**：现有 40 个 hunk 的补丁对 18.2.7 全部适用（40/40）；**以 can1357 18.3.0 为目标为 39/40**（需修 **1** 个锚点：`agent-loop.ts` 的注释 `hub wait`→`wait`）；**直接以 nornzach fork 为目标为 38/40**（需修 **2** 个锚点：上述 `agent-loop.ts` 注释，加上 fork 重排的 `rpc-mode.ts` import 行）。**没有任何 hunk 命中 “ALREADY-UPSTREAM”**——`batchPolicy`/`soleBatchRejectionReason`/`AgentToolResult.terminate`/host-tool 的 `concurrency` 在 18.3 与 fork 的 `agent-loop.ts`/`types.ts`/`host-tools.ts`/`rpc-types.ts` 中命中均为 0；冲突都是**锚点文本**而非语义冲突。

**决策（要求 8 的完整表述见 §9）**：可以借鉴「自有 OMP fork + 固定 bundled sidecar + 双仓库同步」的架构（**但打包态“固定 sidecar”必须由我们自己加门**：nornzach 的解释器不区分打包态）；**不能**用 OMP 原生 Plan/Goal 冒充 PI parity；**不据此解除 R3，也不删除 Cursor 产品门**。

---

## 1. 证据源、获取方式与完整性核验

| 来源 | 固定坐标 | 本机获取 | 完整性核验 |
| --- | --- | --- | --- |
| PI Desktop | `0111e306c120ad5820688d7608cb37bad8fbcc1f` | 本地 clone（`git clone --shared` 自另一工作树，同 SHA） | `git rev-parse HEAD` = 该 SHA |
| 当前 OMP（子模块） | `d49918fab2dba3986927f2d46721629ed0f3a02c`（omp/18.2.7） | clone 至 `/tmp/t20r3d/omp-18.2.7`（本地对象共享） | `git rev-parse HEAD` = 该 SHA；根仓库 `git ls-tree HEAD upstream/` 为 `160000 commit d49918fa…` |
| can1357 v18.3.0 | `62bc57be1b03ef0802a33cf7f5f530e534527531` | codeload tarball（`https://codeload.github.com/can1357/oh-my-pi/tar.gz/refs/tags/v18.3.0`）+ `git fetch --depth 1 --filter=blob:none refs/tags/v18.3.0` 取元数据 | **逐文件 blob 比对**：`git ls-tree -r FETCH_HEAD`（7673 项）vs 解包树的 `git ls-files -s`（7673 项）→ missing 0 / extra 0 / 内容或模式差异 **0** |
| nornzach fork | `81b9f2507fd99c35076f35951481da7038227db9` | codeload tarball `…/nornzach/oh-my-pi/tar.gz/81b9f250…` | 同上，7733 项，差异 **0**（比对源为已有 `blob:none` clone 的 tree） |
| nornzach/oh-my-pi-gui | `313279965a30b14505934a78b584fedb095f117b` | 本机 `/tmp/oh-my-pi-gui-review`（`origin` 指向该仓库，HEAD 一致） | `git rev-parse HEAD` = 该 SHA，工作树干净（`git status --short` 空） |

外部源码全部落在 `/tmp`（`/tmp/t20r3d/`、`/tmp/oh-my-pi-gui-review/`）；**两个固定子模块的 gitlink 与内容未被写入**（§12 记录 `git status --short`）。

网络事实（影响取证方式，如实记录）：任务给出的 `http://127.0.0.1:7890` 代理**未监听**（connection refused）；本机实际可用的代理是 `127.0.0.1:7897`（clash-verge），`https://github.com` 经它返回 200。git 直连 `github.com:443` 在本轮多次超时（135910 ms 后失败），因此外部源码改用 **codeload tarball + `--filter=blob:none` 元数据 fetch**；两者都记在 §12。

---

## 2. 要求 1：oh-my-pi-gui 的实际架构（逐条核对；可证明与不可证明分开写）

### 2.1 Electron 启动 `omp --mode rpc-ui`

| 事实 | 坐标 |
| --- | --- |
| 每个会话一个 `SidecarManager`：argv 以**固定模式前缀** `["--mode", "rpc-ui"]` 初始化，随后依次追加 `--session <file>`（或 `--no-auto-resume`）、`--chat`（仅 chat 会话），最后追加经拒绝名单过滤的用户 flag | `src/main/sidecar.ts:297-306`（`const args = ["--mode", "rpc-ui"];` → `args.push("--session"…)`/`"--no-auto-resume"`/`"--chat"` → `args.push(...stripDenylistedFlags(userFlags))`） |
| `--mode` 属代码控制 flag：用户启动 profile 与 `extraFlags` 里的 `--mode` 会被成对剥离（含取值 token），因此**模式本身不可被用户改道**（argv 的其余部分是可变的） | `src/shared/launch-profile.ts:42-57,60-78,82-90`；`src/main/sidecar.ts:303-306` |
| 行为测试钉住**完整 argv**（`["--mode","rpc-ui","--session",…]`、`[…,"--chat"]`、`[…,"--no-auto-resume"]`、重启后 `["--mode","rpc-ui"]`、以及注入的 `--append-system-prompt/--no-rules/--add-dir/--tools` 顺序） | `src/main/sidecar.test.ts:46,70,94,100,133,183-198` |
| 源码侧（开发覆盖）`OMP_SIDECAR=source` 时 argv 变成 `[bun, <sourceCli>, ...args]`，模式前缀不变 | `src/main/sidecar.ts:305-307`；`src/main/index.ts:94-110` |
| NDJSON 解析 + 协议 v2 分片仅在 ready 通过 `supportedProtocolVersions` 含 2 且帧上限匹配时启用 | `src/main/rpc-bridge.ts:13-24`、`src/main/sidecar.ts:398-402` |
| 事件面按 AGENT_EVENT_TYPES 表路由（含 `plan_proposal`、`goal_updated`、`loop_mode_update` 等） | `src/main/sidecar.ts:57-89`、`src/main/sidecar.ts:404+` |

### 2.2 内置 sidecar 的解析：无系统 `omp` 回退，但存在开发覆盖与资源树扫描

| 事实 | 坐标 |
| --- | --- |
| 打包把 `resources/omp` 作为 `extraResources` 放到应用 `Resources/omp`（macOS 默认配置），即**常规打包产物的首选内置资源** | `electron-builder.yml`（`extraResources: [{from: resources/omp, to: omp}]`）；x64/Windows 变体分别指向 `resources/omp.x64`、`resources/omp.exe` |
| 解析顺序：① `OMP_BUNDLED_OMP` 环境变量（**先于任何 `app.isPackaged` 判断**，存在即采用）；② `process.resourcesPath/<omp|omp.exe>`；③ 从 `app.getAppPath()`/`process.cwd()` 向上最多 8 层找 `resources/omp`（含 `packages/gui/resources/omp`）。注释里的“没有系统安装的 omp 被咨询，也没有外部回退”指的是**不查 PATH**，不是“打包态只能走 ②” | `src/main/index.ts:66-90`（`resolveBundledOmp`）；`src/main/bundled-omp-path.ts:5-16` |
| 开发/夹具另有 `OMP_SIDECAR=source`（+ `OMP_SIDECAR_CLI`）切到工作区源码 CLI，**同样不检查 `app.isPackaged`** | `src/main/index.ts:94-112`（`resolveSourceCli`）；使用方 `e2e/real-core.e2e.ts:35,37`、`e2e/runtime.e2e.ts:21`、`scripts/capture-showcase.ts:76`（`OMP_BUNDLED_OMP`） |
| 全仓库**没有**按名字（PATH）启动 `omp` 的调用点：`spawn` 的命令一律是已解析路径（sidecar/stats/benchmark），或用 `bun`+源码入口 | `src/main/sidecar.ts:317`、`src/main/stats-server.ts:61`、`src/main/benchmark-runner.ts:121`（`binaryPath`）；`src/main/sidecar.ts:305`（`sourceCli ? resolveBunExe() : binaryPath`） |
| 两条通道都解析不出时：`binaryPath` 与 `sourceCli` 皆空 → `start()` 进入 `error` 状态并给出按构建形态措辞的错误，**不找系统 `omp`** | `src/main/sidecar.ts:250-262`；`missingSidecarMessage` `src/main/sidecar.ts:182-189` |
| sidecar 二进制本身被 `.gitignore` 排除（>100 MB，不进仓库），发布流程要求逐个 `--smoke-test` | `.gitignore`（`resources/omp`、`resources/omp.*`）；`scripts/sync-upstream.sh` 第 6 步；`README.md` §Releasing 步骤 5 |
| 打包配置契约测试（每个 mac 变体都注册 `omp://`、`extraResources` 存在等） | `src/main/packaging-config.test.ts` |

**对本产品的含义（要求 8 的输入）**：nornzach GUI 的“闭环保守”只保证**没有 PATH 回退**，**不保证**打包态不会被环境变量或资源树扫描改道（`OMP_BUNDLED_OMP`、`OMP_SIDECAR=source` 在 `app.isPackaged` 下同样生效，e2e 正是这样驱动夹具的）。若我们的发布态要求“真正固定 sidecar”，T20-R4 必须在 `app.isPackaged` 下**禁用/忽略**这些开发覆盖与向上的资源树扫描（或提供等价的机械门，例如只接受清单校验过的资源路径），并补上行为测试（打包态注入 `OMP_BUNDLED_OMP`/`OMP_SIDECAR`、放置同名伪资源时仍拒绝启动）。本轮不改 nornzach 生产代码。

### 2.3 bundled sidecar 的构建路径：设计上来自外层 fork，但无法把已发布产物精确归因到某个 commit

| 事实 | 坐标 |
| --- | --- |
| `build:omp` **按相对路径**在外层目录编译 agent：`repoRoot = guiRoot/../..`，入口 `packages/coding-agent/src/cli.ts`，并只校验 `packages/coding-agent/scripts/compile-binary.ts` 存在与 monorepo 的 `packageManager`（Bun 版本门槛） | `scripts/build-bundled-omp.ts:1-40` |
| **没有任何 remote/commit 校验**：构建脚本内无 `git rev-parse`/remote 检查；`sync-upstream.sh` 也只 `git fetch upstream`、读 `packages/coding-agent/package.json` 的版本号 | `scripts/build-bundled-omp.ts`、`scripts/sync-upstream.sh:34,50` |
| 编译是 Bun 单文件可执行（bytecode、外置原生依赖、可选跨平台 target、`outfile=resources/omp*`） | `packages/coding-agent/scripts/compile-binary.ts:35-79` |
| 原生 `.node` 载荷按目标平台/版本 staged 并在 finally 还原（含 `pi_natives` 版本哨兵校验、跨架构 `--os/--cpu` 安装、失败时给出从源码构建的指引） | `scripts/build-bundled-omp.ts:120-210` |
| README 规定**推荐**的双仓库布局与责任边界：外层 `nornzach/oh-my-pi`（agent 源码与 sidecar 构建）、内嵌 `packages/gui/`（GUI 仓库）、`can1357/oh-my-pi` 仅作 upstream | `README.md:196-221` |
| 上游同步是一等流程（merge `upstream/main` → natives → stats → `build:omp` → GUI build/typecheck/test） | `scripts/sync-upstream.sh` |
| 发布流程步骤 7 **要求记录**“用于 sidecar 的 monorepo commit”，并**只在**该 commit 与 upstream main 不同时才强调 | `README.md` §Releasing 步骤 7 |
| 版本可核验的只有 agent 版本：`CHANGELOG.md` 的 0.9.9/0.9.10 条目只写 `omp/18.3.0`，**没有** monorepo commit；历史条目（0.9.x 早期）曾写 SHA，但那不能替当前版本作证 | `CHANGELOG.md:9,28`（无 SHA）对照 `:130,168,190`（有 SHA） |

**结论与限制**：可以证明的是**设计与推荐流程**（外层 nornzach fork + 内嵌 GUI 仓库 → `build:omp` 编译 bundled binary → 打进 `Resources/omp`），**不能**证明某个已发布安装包就是由 `81b9f250` 编译的（脚本不校验、产物不入库、版本说明不含 SHA）。因此本审计把 `81b9f250` 当作**fork 源码的固定证据源**（用于对比与读源码），而不是“已发布 sidecar 的构建来源”。T20-R4 的清单必须自带可核验字段（fork commit + desktop version + platform + sha256），不能依赖发布说明（见 §10 R4-3/R4-9）。

### 2.4 Bun 只用于开发与构建（用户侧不需要安装）

| 事实 | 坐标 |
| --- | --- |
| GUI 运行期依赖里没有 `omp`/`bun`（只有 Electron/React/渲染类依赖）；用户侧不需要 Bun/Node | `package.json` `dependencies`；`README.md` §Install & start |
| 运行期 spawn 的是编译后的自包含二进制（内嵌 Bun 运行时），`resolveBunExe()` 只在 `sourceCli` 存在时被调用，而 `sourceCli` **仅**由 `OMP_SIDECAR=source` 的开发覆盖产生 | `src/main/sidecar.ts:166-172,305-307`；`src/main/index.ts:94-110` |
| 主进程 bundle 的“打包后不得再有裸 import”守卫（`check-main-bundle.ts`，`bun run build` 的一部分） | `scripts/check-main-bundle.ts` |
| README 明确“DMG/NSIS/portable 用户无需另装 omp、Bun 或 Node”；单靠 GUI 仓库 clone 无法编译 sidecar（必须嵌在 monorepo 的 `packages/gui/`） | `README.md` §Install & start、§Development、§Troubleshooting（`Built-in omp not found` 条目） |
| 测试：`bundled-omp-path.test.ts`（文件名/`.exe` 解析）、`sidecar.test.ts`（argv、重启、崩溃循环）、`packaging-config.test.ts`（打包契约）；GUI 共 153 个 `*.test.*`/`*.spec.*` 文件，e2e 目录另有 6 个 Playwright 套件 | `src/main/*.test.ts`；`e2e/` |

**限制（如实记录）**：本轮**未**运行 GUI 的 vitest/Playwright/打包（需要其自身依赖与真实 sidecar 产物），只读取源码与测试断言；因此“GUI 架构”的结论来自源码与既有测试文本，不是本轮实跑结果。

---

## 3. 要求 2：can1357 v18.3.0 ↔ nornzach fork 逐文件对比

方法：两棵树都在 `/tmp` 且已按 §1 完成逐 blob 校验；用 `diff -u` 逐文件比较，并用 `difflib` 计算“上游新增行在 fork 中的保留率”“fork 新增行”与“仅空白差异行”。另做一次**符号级核验**（18.3 相对 18.2.7 新引入的标识符是否仍出现在 fork 文件中）——它只用于说明“**未发现**符号级缺失”，**不**等价于功能/行为等价（见 §0 第 5 条与 §11 限制）。

行数与变化量：

| 文件 | 18.2.7 | 18.3.0 | fork | 18.2.7→18.3 | 18.3→fork | 分类 |
| --- | --- | --- | --- | --- | --- | --- |
| `packages/agent/src/agent-loop.ts` | 3581 | 3642 | 3642 | +105/−24 | **0** | **逐字相同** |
| `packages/agent/src/types.ts` | 1153 | 1170 | 1170 | +26/−9 | **0** | **逐字相同** |
| `packages/ai/src/types.ts` | 1413 | 1459 | 1459 | +66/−18 | **0** | **逐字相同** |
| `packages/ai/src/providers/cursor.ts` | 5540 | 5541 | 5541 | +4/−3 | **0** | **逐字相同** |
| `packages/coding-agent/src/tools/resolve.ts` | 323 | 323 | 323 | 0 | **0** | **逐字相同** |
| `packages/coding-agent/src/modes/rpc/host-tools.ts` | 206 | 206 | 206 | 0 | **0** | **逐字相同** |
| `packages/coding-agent/src/tools/write.ts` | 1446 | 1486 | 1548 | +54/−14 | +67/−4 | 无关（fork 产品功能） |
| `packages/coding-agent/src/main.ts` | 2392 | 2395 | 2338 | +11/−7 | +19/−71 | 无关（fork 刻意移除上游默认覆盖） |
| `packages/coding-agent/src/session/agent-session.ts` | 11386 | 11673 | 13795 | +556/−211 | +3087/−977 | 混合（RPC 面 + 格式化漂移） |
| `packages/coding-agent/src/modes/rpc/rpc-mode.ts` | 1725 | 1760 | 3555 | +38/−3 | +1915/−261 | **fork 专用 RPC** |
| `packages/coding-agent/src/modes/rpc/rpc-types.ts` | 554 | 578 | 2369 | +25/−1 | +1787/−173 | **fork 专用 RPC** |
| `packages/coding-agent/src/modes/rpc/rpc-plan.ts` | — | — | 344 | — | 新文件 | **fork 专用 RPC** |
| `packages/coding-agent/src/modes/rpc/rpc-modes.ts` | — | — | 609 | — | 新文件 | **fork 专用 RPC** |

量化补充：

- 保留率：agent-loop/agent types/ai types/cursor/resolve/host-tools 对 18.3 新增行保留 **100%**（且逐字节相同）；write.ts 保留 54/54；main.ts 保留 11/11；agent-session 保留 471/556；rpc-mode 保留 37/38；rpc-types 保留 25/25。
- fork 新增行中的“仅空白差异”行：agent-session 1014、rpc-mode 816、rpc-types 582、write.ts 23 —— 即 fork 对本仓库做过一次整体格式化（`biome/oxfmt` 风格），这部分不承载语义。
- 符号级（**弱证据**）：18.3 相对 18.2.7 新引入的标识符（agent-session 154、rpc-mode 30、rpc-types 9、main 6、write 23）在 fork 对应文件中**缺失数为 0**，即**未发现**符号级缺失。这只说明名字还在文件里出现；同名函数的函数体、调用关系与运行时行为是否与 18.3 一致**未验证**（也不能由本方法验证），需要行为测试（§11 限制）。

### 3.1 与过渡契约无关的修改（示例）

- `tools/write.ts`：fork 新增 `overwriteDiffFields()`（以 `editDiffString` 计算覆盖写前的 unified diff，并带 `MAX_WRITE_DIFF_TEXT_CHARS = 128_000` 预算与 best-effort 降级），结果详情多出 `overwritten`/`diff`/`firstChangedLine`；与工具批次/终止契约无关。18.3 相对 18.2.7 在该文件的 +54 行同样与契约无关（UTF-8 字节计数、行选择器等）。
- `main.ts`：fork **刻意删除**上游的 `HOST_DEFAULTED_SETTING_PATHS` / `applyRpcDefaultSettingOverrides` / `applyAcpDefaultSettingOverrides`（18.2.7 与 18.3.0 都存在，fork 为 0 命中），并留注释“Our fork deliberately omits them because they mask settings persisted by the GUI host”；另有 `--chat` 会话类型与 chat 系统提示注入、`!isInteractive && !session.model` 的报错被限制为“仅非 rpc 模式”。
  - **对我们的意义**：如果我们采用自有 fork，`rpc-ui` 启动时的“宿主默认设置覆盖”行为必须在 fork 里明确保留或按我们自己的契约重写（本产品目前依赖外部注入配置，见 T19-C 的 state 文件通道）。
- `agent-session.ts`：fork 删除/重排的部分包含上游 18.3 新增的 auto-title、ephemeral turn、附件来源提示、reset credits、obfuscation 等行；本轮只确认这些**标识符仍出现在 fork 文件中**（缺失 0），**未**验证它们的函数体与运行时行为是否与 18.3 等价——要断言“这部分没有能力差异”需要行为测试，本轮不做该断言。

### 3.2 fork 专用 RPC（新增命令面）

`rpc-types.ts` 新增（fork 侧）与本主题相关的命令/事件（`rpc-mode.ts` 在 `case` 中一一分发）：

```
set_plan_mode / get_plan_mode / plan_approval          // Plan
get_goal / set_goal{objective?, tokenBudget?, action?} // Goal: pause | resume | drop
guided_goal / set_agents_paused / btw / btw_branch / tan / omfg
get_vibe_mode / set_vibe_mode / get_loop_mode / set_loop_mode
get_settings / set_setting / get_settings_schema / get_model_roles / set_model_role …
```

事件面新增 `plan_proposal`（`RpcPlanProposalFrame`，`rpc-types.ts:824-831`）、`goal_updated`、`loop_mode_update`（GUI 侧对应 `src/shared/rpc-types.ts:76,124,148,1960-1969`）。上游 18.2.7/18.3.0 的 `rpc-types.ts` 中这些字符串命中均为 **0**：**OMP 原生 Plan/Goal 的 RPC 面是 fork 独有的**。

---

## 4. 要求 3：PI 的 SubmitPlan/SubmitGoal 合同核对，以及 nornzach 是否实现同一合同

### 4.1 PI 固定检出的合同（先证据）

| 合同要素 | 源码坐标 | 测试坐标 |
| --- | --- | --- |
| 批次判据 = assistant message 的**全部** `toolCall` 块（无排除） | `packages/agent-runtime/src/runtime.ts:2222-2224`（`content.filter(block => block.type === "toolCall")`） | `runtime.test.ts:2138-2156`（mixedBatch：`EnterPlanMode` + `Read` → `{block:true}`） |
| 混合批次**整批拒绝**，发生在扩展钩子之前 | `runtime.ts:2225-2234` | 同上 |
| 模式校验：enter 工具仅在 Agent 模式；submit 工具必须匹配当前契约模式 | `runtime.ts:2235-2249` | `runtime.test.ts:2288-2317`（Goal 模式下 `SubmitPlan` → `block`, `reason: "SubmitPlan is available only in Plan mode."`） |
| 提交工具三个终支：host 调用抛错 → `terminate:true`；proposal 非法 → `terminate:true`；成功 → `terminate:true`；**非法参数不 terminate** | `runtime.ts:5106-5120`、`5125-5143`、`5165-5171`；非法参数分支 `5081-5092`（无 terminate） | `runtime.test.ts:2193-2208`（成功后 `submitResult.terminate === true`）、`2226-2276`（Goal 同构） |
| 提交工具的 provider 侧形态（Plan/Goal 各自一套 `title/markdown/question` schema，`executionMode:"sequential"`） | `runtime.ts:5040-5080`（`buildSubmitTool`） | `runtime.test.ts:2080-2131`（Plan 模式工具表只含 read-only core + `SubmitPlan`；Goal 只含 `SubmitGoal`） |

### 4.2 nornzach fork 的判定：**未实现同一合同**

- `SubmitPlan` / `SubmitGoal` 在 fork 整棵树（`--include=*.ts --include=*.md`）出现 **0 次**。
- 也不存在 PI 语义的“整批预检”：`must be the only tool call`、`soleBatch`、`batchPolicy` 在 fork 全树 0 次。
- fork 的 Plan 是“模式 + 计划文件 + `write xd://propose` 审批”（§5.1），Goal 是“`GoalRuntime` 续跑契约”（§5.3）。两者都**不是** PI 的“唯一工具调用 + 待审批 + 提交后终止”合同。
- 对应地，fork 的 `agent-loop.ts` 与 18.3 逐字相同（§3 表），`agent-session.ts` 也没有引入任何分批裁决逻辑（`#beforeToolCall` 只做扩展 `tool_call` 派发，§7.1）。

**结论**：把 fork 的 Plan/Goal 当作 PI 的 SubmitPlan/SubmitGoal 合同来复用是**错的**——两者在工具形态、审批语义与终止方式上都不同（§5.4 表）。

---

## 5. 要求 4：OMP 原生 Plan 生命周期与 Goal 语义（fork 侧完整链路）

### 5.1 Plan：`set_plan_mode → local:// plan → write xd://propose → tool_execution_end → plan_proposal → abort → plan_approval`

| 环节 | 证据坐标（fork） |
| --- | --- |
| `set_plan_mode` 命令 → 设置 plan 模式状态，并 arm/disarm 提案控制器（不从宿主侧替换模型/工具集） | `rpc-types.ts:154-155`；`rpc-mode.ts:2897-2921,2922-2928`；`rpc-plan.ts:64-100`（`syncArmed`/`#arm`/`#disarm`） |
| 计划正文写到 `local://<slug>-plan.md`（`plan-mode-active.md` 提示词规定 slug 与 `xd://propose` 必须一致） | `packages/coding-agent/src/prompts/system/plan-mode-active.md:7,23,120-122`（18.2.7/18.3/fork 内容一致） |
| 提交 = 对 `xd://propose` 的 `write`；派发由 `writeDeviceDispatch` 解析出 `{tool: PROPOSE_DEVICE_NAME, mode:"execute", inner:{planFilePath,title,…}}` | `packages/coding-agent/src/tools/resolve.ts:42`（`PROPOSE_DEVICE_PATH`）、`writeDeviceDispatch`；测试 `packages/coding-agent/test/tools/resolve.test.ts:166-186` |
| 提案处理器把计划“提升”为待审批状态（`preparePlanForReview` + `setPlanModeState({planFilePath})` + `appendModeChange("plan", …)`） | `rpc-plan.ts:84-98`；`agent-session.ts:1540`（`preparePlanForReview`） |
| 提案帧在**工具执行结束事件**上发出：仅当 `event.type==="tool_execution_end" && !event.isError` 且 dispatch 是 propose/execute，读取计划文件内容后 `output({type:"plan_proposal", planFilePath, title, suggestedFileName, planContent, options})` | `rpc-plan.ts:126-152`；帧定义 `rpc-types.ts:824-831`；options 为 `["execute","compact","keep_context","save","refine"]` |
| 发帧后**静默终止当前回合**（防止模型在宿主审阅期间重复提交）：`session.markPlanInternalAbortPending()` → `await session.abort()` → `finally clearPlanInternalAbortPending()` | `rpc-plan.ts:148-155`；`agent-session.ts:2755-2770`（silent abort marker 的置位/清除）；TUI 同形实现 `modes/interactive-mode.ts:4790,5463` |
| 宿主回 `plan_approval{approved, option?, feedback?, savePath?}` → 控制器 resolve：退出 plan 模式、可选压缩、pin 计划引用、派发“已批准计划”合成 prompt；拒绝/refine 保持 plan 模式 | `rpc-types.ts:157-164`；`rpc-plan.ts:203+`（`resolve`，含与 TUI 的有意差异说明）；批准提示词 `prompts/system/plan-mode-approved.md` |
| 上游对照：18.2.7 与 18.3.0 的 RPC 层**没有**这些命令/事件（命中 0），只有 TUI/ACP/print 三条既有路径（`interactive-mode.ts`、`acp-agent.ts:1864-1877`、`print-mode.ts:161`）与 `plan-mode/` 模块 | `omp-18.2.7`/`can1357-18.3.0` 的 `rpc-types.ts`、`rpc-mode.ts` 命中 0；`plan-mode/` 目录两树一致（fork 多出 `plan-mode/plan-save.ts`） |

### 5.2 Goal：`GoalRuntime` 的 create/replace/pause/resume/drop + continuation（不是待审批提交）

- `packages/coding-agent/src/goals/runtime.ts`（522 行）在 **18.2.7 / 18.3.0 / fork 三树 md5 相同**（`8dc609b3…`）；`prompts/goals/goal-continuation.md` 同样三树相同（`8405236e…`）。
- 该运行时已具备：`createGoal`（已有活动 goal 时抛错）、`replaceGoal`（无活动 goal 时抛错）、`pauseGoal`、`resumeGoal`、`dropGoal`、以及 `renderGoalPrompt("continuation"|"active"|"budget-limit")` 的续跑提示词（`goals/runtime.ts:385,402,420,437,456,509`）。
- fork 只是把它接上 RPC：`get_goal` / `set_goal{objective?, tokenBudget?, action?: "pause"|"resume"|"drop"}` / `guided_goal`（`rpc-types.ts:168-183,844-853`；`rpc-mode.ts:2955-3056`；控制器 `rpc-modes.ts` 的 `RpcGoalModeController`），并保留 TUI 同形的 `RpcGoalState{enabled,status,objective,tokenBudget,tokensUsed,timeUsedSeconds,mode}`。
- 因此 Goal 在本产品里的正确形态是“**运行期目标 + 续跑契约**”，不是 PI 的“一次提交、等宿主审批”。

### 5.3 Plan/Goal 与 PI 的差异（决策依据）

| 维度 | PI Desktop | OMP（含 fork RPC 面） |
| --- | --- | --- |
| 进入模式 | `EnterPlanMode`/`EnterGoalMode` 工具（唯一调用） | RPC `set_plan_mode` / 设置面；`enter` 由宿主驱动 |
| 提交 | `SubmitPlan`/`SubmitGoal` 工具（唯一调用，`title/markdown/question`） | Plan：`write xd://propose`（写的是 slug/title，正文在 `local://` 计划文件）；Goal：`GoalRuntime` 无“提交”概念 |
| 审批 | 宿主 `plans.submit` → 待审批提案（immutable artifact + sha256） | 计划文件 + `plan_proposal` 帧 + `plan_approval` 回答 |
| 提交后终止 | `terminate:true`（**非 abort**，`stopReason` 不改写） | Plan 用**静默 abort**（`SILENT_ABORT_MARKER`）；Goal 永不终止，按 continuation 续跑 |
| 批次语义 | 整条 assistant 消息的**全部** toolCall 计数，混合批次整批 block | 无批次概念（本次审计实测 0 命中） |

---

## 6. 要求 5：测试覆盖检索（5 个关键场景）与明确缺口

检索面：`grep -rn "xd://propose|PROPOSE_DEVICE_NAME" --include=*.test.ts` 命中 **9 个测试文件**（18.3.0 与 fork 的命中集合与行数完全一致，即 fork 未新增任何 propose 相关测试）；`set_plan_mode`/`plan_approval`/`RpcPlanApprovalController`/`rpc-modes` 在测试中命中 3 个文件：`rpc-session-actions.test.ts`（含 2 项 `RpcPlanApprovalController` 用例：批准后保存并新开会话、扩展取消时报告已保存）、`rpc-guided-goal.test.ts`（2 项 guided interview）、`rpc-chat-mode-guards.test.ts`。

| 场景 | 检索结果 | 判定 |
| --- | --- | --- |
| S1 `[write xd://propose, bash]`（混合批次，propose 在前） | 三处 propose fixture（`agent-session-plan-mode-convergence.test.ts:305-320`、`print-mode-plan-startup-hang.test.ts:64-68`、`modes/controllers/event-controller-plan-approval-dispatch.test.ts:17-38` 的合成 `tool_execution_end`）**都只有单个 toolCall**；全树无“propose 与兄弟同批”的构造 | **缺口（无测试）** |
| S2 `[bash, write xd://propose]`（propose 在后） | 同上，检索不到任何混合批次构造 | **缺口（无测试）** |
| S3 重复提交（同一回合两次 propose / 审批期间再提交） | 无测试；只有 `T3b: a propose write resets the convergence counter`（单一 propose，断言收敛计数器被重置）与静默 abort 机制（`rpc-plan.ts:148-155`） | **缺口（机制在、测试无）** |
| S4 同批兄弟零副作用（批次级拒绝后兄弟不得执行） | 全树无 `soleBatch`/`batchPolicy`/“must be the only tool call”；`host-tools.ts` 三树同为 206 行且无策略字段 | **缺口（机制不存在 + 无测试）** |
| S5 提交成功后不再请求模型 | 无测试断言这一步；`print-mode-plan-startup-hang.test.ts:100-107` 只断言“回合完成不挂死”（且其 mock 的 propose 因无计划文件而失败）；`T3b` 的 `mock.calls.length === 4` 反而说明该 harness 里 propose 之后**继续**跑完了后续模型响应 | **缺口（无测试）** |

结论：**不能引用 nornzach fork 的测试来支撑 PI 的 Post-Submit/整批语义**；它既没有该语义，也没有对应测试。

---

## 7. 要求 6：18.3 的整批预检可用性，以及 Cursor 为何仍不能零副作用

### 7.1 `BeforeToolCallContext.assistantMessage` 与 `prepareToolCallDispatch`（18.3 事实）

| 事实 | 坐标 |
| --- | --- |
| hook 上下文携带**整条 assistant 消息**（`assistantMessage`）、原始 `toolCall`、解析后的 `tool` 与校验后的 `args` | `packages/agent/src/types.ts:847-866` |
| 返回 `{block:true, reason}` 只作用于**当前调用**；`{args}` 会重新校验并写回 `toolCall.arguments`（成为历史/事件/持久化/replay 的唯一版本） | `agent-loop.ts:2749-2780` |
| prepare 在**最终/常规 loop dispatch 之前**执行：流式路径在 `message_end` 时点、受 `finalToolCallsCanDispatch` 门控（`agent-loop.ts:2033-2056`），非流式入口按需再跑一次；执行期复用同一份 prepared（`agent-loop.ts:2911-2918`）。**这不是“任何调度之前”**——投机候选可在流式期间先行起物理执行（见下） | `agent-loop.ts:2033-2056,2698-2780,2911-2918` |
| 投机时序（同一文件）：`toolcall_end` → `admitFinalized` → `#insertCandidate` → `#drain()`；只有 `deferBeforeToolCall` 候选会等 `#admissionsFinalized`；`finalizeAdmissions()` 在 `prepareToolCallDispatch` + `reconcileFinalCalls` 之后 | `agent-loop.ts:2282-2288`、`speculative-execution.ts:808-816,834-840,852-855`、`agent-loop.ts:2057-2071` |
| `deferBeforeToolCall` 目前只在 coding-agent 的**本地读**投机宿主上声明，且协调器**仅在该 provider 调用装了 `beforeToolCall` 时才采纳**（无 hook 的会话照样立即执行） | `packages/coding-agent/src/speculation/host.ts:169-183`、`speculative-execution.ts:803-805` |
| prepare 对每个调用按顺序执行；**未知工具或参数非法**时 `continue`（不咨询 hook）；**已被策略 deny** 时也不进入 | `agent-loop.ts:2708,2740-2753` |
| `kCursorExecResolved` 的调用在 prepare 与所有可执行计数中被**跳过/剔除** | `agent-loop.ts:2708`（prepare）、`647,1376,1451,1507`（计数/派发） |

### 7.2 判定：对“非 Cursor 的 PI 式整批预检”可用，但不是等价物

- **可用**：因为 hook 能看到整条消息，宿主可以对该消息**每个**调用返回 `{block:true, reason:"<transition tool> must be the only tool call in the assistant message."}`，从而在 loop 可控路径上实现“含过渡工具的批次整批不执行”，且发生在 `tool_execution_start` 之前。
- **不等价**（三条硬限制）：
  1. hook 的返回值是**逐调用**的，没有任何“批裁决”原语；实现整批语义必须由调用方对批内每个调用自算一次，且对“未知工具/参数非法”的成员根本不会被问（`agent-loop.ts:2749-2753`），只能由缓存/重算补齐——这不是 PI 的单次批判定。
  2. hook 的时序**不构成零副作用的保证**：投机候选在流式期由 `toolcall_end` 触发（`agent-loop.ts:2282-2288`）并立刻 `#drain()`（`speculative-execution.ts:808-816`），只有声明 `deferBeforeToolCall` 的候选才被推迟到 `finalizeAdmissions()`（`:852-855`）；该声明目前只有 coding-agent 的本地读宿主给出，且**仅当本 provider 调用装有 `beforeToolCall` 时协调器才采纳**（`packages/coding-agent/src/speculation/host.ts:169-183`、`speculative-execution.ts:803-805`）。因此“把整批预检放进 hook 就能零副作用”**不能泛化**——严格零副作用仍必须依赖投机 admission 门（R3A 补丁对声明 sole 工具的会话关闭投机，正是为此）。
  3. hook 看不到、也拦不住 Cursor exec channel 的**已执行**调用（§7.3）。
- **对我们的实现选择**：这正好解释了 R3A 补丁为什么把批次裁决放在 `agent-loop.ts` 的 `prepareToolCallDispatch`/`executeToolCalls`（在那里才能同时拿到“整条消息的全部 toolCall”与“投机/派发门”），而不是放在 `AgentSession.#beforeToolCall`——后者只承载扩展 `tool_call` 派发，且在**没有扩展注册 `tool_call` handler 时直接 early return**（`agent-session.ts:4197-4200`，三树同形）。

### 7.3 Cursor 预执行：18.3 与 18.2.7 同构，零副作用仍不可满足

| 事实 | 坐标 |
| --- | --- |
| exec 通道的调用在**流式期**由 provider 侧合成并**执行**，随后以 `kCursorExecResolved` 标记携带结果缓冲 | `packages/ai/src/providers/cursor.ts:1142-1143,1669-1900,2155-2303`；注释 `agent-loop.ts:1499-1506`（“Cursor already executed the tool server-side (via the bridge)…running it here again would duplicate the same side-effecting call”） |
| loop 必须在所有可执行计数里剔除这些块（否则重复副作用） | `agent-loop.ts:647,1376,1451,1507` |
| provider 侧 18.2.7→18.3 的 7 行改动与本主题无关（`createHash("sha256")` → `Bun.SHA256`） | `packages/ai/src/providers/cursor.ts` diff |
| 因此：被拒绝的批次里若含一个 Cursor 已执行调用，其副作用发生在承载它的 assistant 消息存在之前 | 与 R3A §2、R3B §9 的结论一致（本轮以 18.3 源码复核，未发现新开关） |

**判定**：**18.3 没有改变 R3 的结论**——`kCursorExecResolved` 通道的预执行既不可阻止也不可撤销；这也是本轮**不解除 R3**的直接依据。

---

## 8. 要求 7：现有 18.2.7 补丁的逐 hunk 迁移分析（仅在 `/tmp` scratch）

方法与产物（全部在 `/tmp`，未触碰仓库内 patch/manifest）：

- 脚本 `/tmp/t20r3d/analyze_patch.py`：解析 10 文件 / **40 个 hunk**，对每个 hunk 取“before 块（上下文 + 删除行）”在目标树中做**逐字**与**空白归一**两级查找，若都失败再看“after 块（新增行）”是否已存在（=能力已进上游）。
- 逐文件 `git apply --check -p1`（每文件单独一个 patch，落在 `/tmp/t20r3d/perfile/`）。

结果：

| 目标树 | hunk 逐字适用 | 空白归一适用 | 已进上游 | 冲突 |
| --- | --- | --- | --- | --- |
| 18.2.7（补丁基线，对照） | 40 | 0 | 0 | 0 |
| can1357 v18.3.0 | **39** | 0 | **0** | 1 |
| nornzach fork | **38** | 0 | **0** | 2 |

整补丁 `git apply --check` 退出码：18.2.7 → **0**；18.3.0 → **1**；fork → **1**。逐文件的结果：唯一失败的是 `packages/agent/src/agent-loop.ts`（两棵树都失败）与 `packages/coding-agent/src/modes/rpc/rpc-mode.ts`（仅 fork 失败）。

冲突原因（已逐条核对，均为**锚点文本**而非语义）：

1. `agent-loop.ts` 的 hunk `@@ -3028,6 +3131,56 @@`（批次准入块插入点）尾部上下文包含注释 `// the message injects promptly instead of sitting out a \`hub wait\`.`；18.3 把 `hub wait` 改成 `wait`（`diffs/182-183-agent-loop.diff` 的 `@@ -3030,7 +3072,7 @@`），锚点因此失配。**要插入的 50 行代码本身与 18.3 无任何冲突。**
2. `rpc-mode.ts` 的 hunk `@@ -40,7 +40,7 @@` 是对 `./host-tools` 的 import 行改写；fork 把该文件 import 区整体重排/换行（`rpc-mode.ts:65`），锚点失配。

分类与迁移建议（逐能力）：

| 补丁能力 | 18.3/上游是否已有 | 迁移结论 |
| --- | --- | --- |
| 批次计数 = 消息内**全部** `toolCall`（含 Cursor 已执行块） | **否**（`batchPolicy`/`soleBatchRejectionReason` 命中 0） | **必须保留**；在 18.3 上合并只需修 1 个注释锚点（若目标改为 fork 则为 2 个），随后重生成 artifact |
| `batchPolicy: "sole"` 声明 + 含 sole 且调用数≠1 时**整批拒绝**（零 `tool_execution_start`、零 host call、按序 blocked 结果、不触发审批钩子） | **否** | **必须保留**（这是 PI 批次语义在 OMP 上的唯一落点） |
| 投机预执行门禁（活动工具表含 sole 工具时该 provider 调用不创建投机协调器） | **否**（`speculativeToolExecution` 在 18.3 与 18.2.7 同形） | **必须保留**；**应继续留在 loop 层**（移到 `AgentSession.#beforeToolCall` 无法阻止流式期已启动的候选） |
| `AgentToolResult.terminate` / `afterToolCall.terminate` 覆盖（结算后终止、非 abort、流式 partial 永不终止） | **否**；但上游已有近似机制 `TERMINAL_TOOL_RESULT_ABORT_REASON`（`agent-loop.ts:166,744`，由 `agent-session.ts:2758,4183` 的 subagent yield 产出）——它是 **abort 语义**（signal 置位、`stopReason` 走 aborted 分支） | **保留 terminate**（非 abort 是产品要求：提交成功后是正常完成，不写 aborted、不清 steering）；同时**不要**改用上游 abort 路径 |
| host-tool RPC 的 `concurrency` / `batchPolicy` 策略字段 + `host_tool_result.result.terminate` 严格校验 | **否**（`RpcHostToolDefinition` 三树字段一致，无这两项） | **保留在 host-tool RPC 层**（`host-tools.ts`/`rpc-mode.ts`/`rpc-types.ts` 三棵树逐字相同，hunk 全部适用） |
| `docs/rpc.md` 文档与测试 | — | 迁移时同步（两棵树均 100% 适用） |

**结论（按目标分开）**：迁移到 **can1357 18.3.0** 的成本是**修复 1 个注释锚点 + 重新生成 artifact**；直接迁移到 **nornzach fork** 的成本是**修复 2 个锚点**（同一个 `agent-loop.ts` 注释 + `rpc-mode.ts` 的 import 重排）+ 重新生成 artifact。两种目标下都**没有任何能力需要删除**，也没有任何能力可以“因为上游已有”而丢弃（`ALREADY-UPSTREAM = 0`）。

---

## 9. 要求 8：决策

1. **架构可以借鉴：自有 OMP fork + 固定 bundled sidecar + 双仓库同步。**
   - 证据（按其真实强度）：§2 证明 GUI 侧**不从 PATH 解析 `omp`**、常规打包产物以 `Resources/omp` 为首选资源、运行期不需要 Bun；§8 证明我们的补丁迁移到 **18.3 只需修 1 个注释锚点**（若直接以 fork 为目标则需 2 个）；§3 证明 fork 面（RPC Plan/Goal）是**可读、可审**的实现样板。**不**以此声称“nornzach 的打包态绝对固定 sidecar”，也**不**把已发布产物归因到某个 fork commit。
   - 落地边界（不能照抄）：① fork 必须是我们自己维护的（`MisterBowie` 名下新仓库，**绝不**向 `can1357/oh-my-pi` 推送，符合根 `AGENTS.md`）；② sidecar 构建产物必须自带可核验清单（fork commit + 桌面版本 + 平台 + sha256），并在打包态**由代码校验**（nornzach 只“要求记录”，脚本不校验外层仓库，不足以照抄）；③ 打包态必须显式处理 nornzach 那两条**无 `app.isPackaged` 门**的开发通道（`OMP_BUNDLED_OMP`、`OMP_SIDECAR=source`）与向上资源树扫描——我们要么在 `app.isPackaged` 下禁用/忽略它们，要么用等价的机械门（只接受清单校验过的资源路径）并补行为测试；④ `rpc-ui` 的宿主默认设置覆盖行为要在 fork 里明确写出（nornzach fork 选择移除，我们必须显式选择，不能默认漂移）。
2. **不能用 OMP 原生 Plan/Goal 冒充 PI parity。** §4/§5 已列清语义差异（工具形态、审批、终止方式、批次语义、Goal 是续跑而非待审批）。产品对 Plan/Goal 的对外说法必须写“OMP 原生 Plan/Goal（模式 + 计划文件审批 / 目标续跑）”，不得标为 PI 的 SubmitPlan/SubmitGoal 等价物。
3. **不解除 R3，也不删除 Cursor 产品门。**
   - §7.3 复核了 18.3 的 Cursor 预执行路径（同构、无新开关），严格契约仍不可满足；
   - 因此 ADR 0306 的“会话不得把活跃 Cursor 模型/提供方与 Plan/Goal 组合”继续有效；G1/G2/G3 仍开放，T20-B/C/D 仍不得开始。

---

## 10. 下一实施阶段的最小范围与验收矩阵（建议 T20-R4）

**范围（最小、可审阅、不越权）**：

1. 建立**自有的** OMP 基线与补丁级：以 `62bc57be`（18.3.0）为新基（或经用户确认继续用 18.2.7 并只做记录），把 `0001-rpc-host-tool-transition-contract.patch` 迁移为 `+omp-desktop.2`（预期：目标为 18.3.0 时修 `agent-loop.ts` 注释锚点 **1** 处；目标为 fork 时再加 `rpc-mode.ts` import 锚点，共 **2** 处），更新 `manifest.json`（新 base SHA/version/patch sha/bytes），并把 §8 的逐 hunk 结论写进 ADR 0305。
2. 实现**bundled sidecar 的构建与启动闭环**（不接 UI 功能）：`app/scripts` 下的构建脚本产出可执行 sidecar + 清单（fork commit、桌面版本、平台、sha256，且构建时**校验外层仓库的 remote/commit**），`packages/omp-runtime` 的 launcher 增加“打包内固定 sidecar”路径——在 `app.isPackaged` 下**只接受**清单校验过的资源路径，拒绝环境覆盖（`OMP_BUNDLED_OMP`/`OMP_SIDECAR=source`）与向上资源树扫描，并在启动前做版本/协议断言；开发态仍走固定子模块。行为测试必须覆盖“打包态注入覆盖变量/放置同名伪资源仍拒绝启动”。
3. **不动** Plan/Goal 运行时面、不动 Cursor 门、不解除 R3、不开放 T20-B/C/D 的缺口项。
4. 需要用户/仓库决策的事项（本轮已识别，不在本轮执行）：自有 fork 的仓库名与归属；是否把 18.3 作为新基（会引入 §3.1 的 `main.ts`/`write.ts` 上游变化）。

**验收矩阵（每条要有可观察证据）**：

| ID | 验收点 | 可观察判定 | 证据要求 |
| --- | --- | --- | --- |
| R4-1 | 补丁迁移到新基 | 新基树上 `git apply --check -p1` **退出码 0**；补丁内改动面套件（`agent-loop.test.ts`、`rpc-host-tools.test.ts`、`rpc-input-frame.test.ts`）通过 | 命令+退出码+计数；artifact sha256/bytes 与 manifest 一致 |
| R4-2 | 无能力丢失 | §8 表中“必须保留”的 5 项在新基树中存在（符号级 grep + 行为测试各 ≥1 项，含 sole 批次整批拒绝、terminate 非 abort、RPC 策略字段严格校验） | 测试名与失败/通过输出；对照实验（移回旧基应判红） |
| R4-3 | 构建产物固定且可核验 | 构建脚本输出清单含 fork commit/桌面版本/平台/sha256，且**构建时校验**外层仓库的 remote 与 commit（不匹配即失败）；重复构建在相同输入下产出相同清单 | 两份清单 diff；`sha256sum`；故意用错 remote/commit 时的失败输出 |
| R4-4 | 打包内 sidecar，无系统回退 | 在 PATH 中**没有** `omp`、且未安装 Bun/Node 的环境下启动成功；删掉/改坏资源中的 sidecar → 启动报“缺少内置 omp”类错误且**不**尝试系统 `omp` | 启动日志；移除资源后的错误文本；`strace`/进程表佐证（或 `spawn` 记录） |
| R4-5 | 版本/协议断言 | 启动前校验版本与 `supportedProtocolVersions` 含 2（沿用 `rpc-bridge.ts:13-24` 契约）；版本不匹配时拒绝启动并给出可操作错误 | 命中/不命中两组的退出码与错误文本 |
| R4-6 | 数据与凭证隔离不回退 | 沿用现有隔离断言（独立数据根、`PI_CODING_AGENT_DIR` 注入、开发态禁用更新），新构建路径不得绕过（测试用 canary 证明不读用户目录） | canary 扫描输出 |
| R4-7 | R3/门未被动摇 | `node scripts/check-omp-plan-goal-gaps.mjs`（opt-in）仍报 3 缺口 exit 1；ADR 0306 的门测试仍全绿 | 命令+退出码+计数 |
| R4-8 | 文档一致 | 新基 SHA 写入 `docs/source-baseline.json` 的**新增日期化记录**（不改历史）、HANDOFF/任务板与本审计文档互相引用一致；`node docs/scripts/check-docs.mjs` 无**新增**问题 | 命令+退出码；仅记录预存在的 6 项 |
| R4-9 | 打包态不接受开发覆盖（nornzach 现状缺这道门） | `app.isPackaged` 为真时：注入 `OMP_BUNDLED_OMP`/`OMP_SIDECAR`(+`OMP_SIDECAR_CLI`) **不生效**；在资源树中放置同名伪 `omp` 不生效；仅清单校验过的资源路径被接受 | 打包态（或等价 `isPackaged` 仿真）下三组注入的行为测试与启动日志 |

非目标（明确不做）：解除 R3、开放 T20-B/C/D、实现 Plan/Goal 运行时面、删除或放宽 Cursor 门、把 OMP 原生 Plan/Goal 标成 PI parity、向 `can1357/oh-my-pi` 推送。

---

## 11. 限制与未做

1. **只读审计**：未改生产代码、未改两个子模块的 gitlink/内容、未改 `app/patches/**`、未改 manifest、未新增/修改测试。
2. **未实跑**：nornzach GUI 与 fork 的测试套件（vitest/Playwright/bun test）、编译 sidecar、打包安装产物；PI Desktop 的测试套件本轮也未重跑。“18.3 无此能力”“fork 无此测试”等判定基于**源码与测试文本的检索**，不是运行结果（检索命令与命中数见 §6/§12）。
3. **fork 差异的性质（弱证据边界，复审 F4 后收窄）**：§3 的符号级核验只说明“18.3 新引入的标识符在 fork 文件中**未缺失**”，**不能**推出函数体语义、调用关系或功能行为与 18.3 一致；本轮**不**声称“fork 不存在功能丢失”。要得到功能层结论必须跑两侧的行为测试（本轮未跑）。fork 的 `main` 与其自身 `upstream/main` 的提交拓扑（本轮观察到 `merge-base` 为 18.3.0 标签提交、但两侧历史计数达 24570）**未进一步归因**，本轮不需要该结论。
4. **打包态“固定 sidecar”不可由 GUI 源码证明（复审 F2）**：`OMP_BUNDLED_OMP` 覆盖与向上资源树扫描都**没有** `app.isPackaged` 门，`OMP_SIDECAR=source` 也一样；可证明的只有“不查 PATH + 常规产物首选 `Resources/omp` + 解析不到就报错”。nornzach 的实际发布包是否被这些通道改道**未测**（本轮未运行该 GUI）。
5. **发布产物与 fork commit 的对应关系不可证明（复审 F3）**：`build:omp` 不校验外层仓库的 remote/commit，sidecar 不入库，0.9.9/0.9.10 的 CHANGELOG 也没有 SHA；因此 `81b9f250` 只作为**源码证据源**使用，不作为任何已发布物件的构建身份。
6. **投机/hook 时序（复审 F5）**：`prepareToolCallDispatch` 只在**最终/常规 loop dispatch 之前**执行；投机候选可在 `toolcall_end` 期间立即执行，`deferBeforeToolCall` 目前只有 coding-agent 的本地读宿主声明且仅在有 `beforeToolCall` 时被采纳。因此本审计**不**泛化“hook 可保证零副作用”。
7. **上游/服务端行为**：Cursor 服务端是否阻塞 `done`、以及真实付费模型行为未测（沿用 R3B 的既有结论与证据层级）。
8. **未核验的区域**：GUI 的 e2e/打包运行、Windows 路径行为、macOS 实机。

---

## 12. 命令、退出码与限制记录

运行时：`node v24.14.0`（nvm）、Bun 1.4.2、Python 3.12.13；全部在 `/tmp` scratch 与只读源码上进行，**未调用任何模型**（无费用）。

| 命令 | 结果 |
| --- | --- |
| `git -C upstream-dir ...`（根仓库）`git status --short` | 空 |
| `git ls-tree HEAD upstream/` | `160000 commit d49918fab2dba3986927f2d46721629ed0f3a02c upstream/oh-my-pi`、`160000 commit 0111e306c120ad5820688d7608cb37bad8fbcc1f upstream/pi-desktop` |
| `curl -x http://127.0.0.1:7890 … https://github.com/` | 连接被拒（代理未监听）；改用 `127.0.0.1:7897` → HTTP 200 |
| `git ls-remote https://github.com/can1357/oh-my-pi refs/tags/v18.3.0` | `62bc57be1b03ef0802a33cf7f5f530e534527531 refs/tags/v18.3.0`（exit 0，耗时 ~152 s） |
| codeload tarball（经 7897 代理） | `can1357` 67,408,344 B（~3.0 MB/s）、`nornzach` 67,709,376 B（~6.1 MB/s）；`tar tzf` 校验通过 |
| 树完整性核验（`git ls-tree -r FETCH_HEAD` vs 解包树 `git ls-files -s`） | 18.3.0：7673 vs 7673，missing 0 / extra 0 / blob-diff **0**；fork：7733 vs 7733，**0** |
| `diff -u`/`difflib` 三方比较 | 见 §3 表；`diff -rq` 全树：116 个文件不同、59 个 fork 独有、0 个 18.3 独有 |
| `python3 /tmp/t20r3d/analyze_patch.py` | 40 hunks：18.2.7 `APPLIES=40`；18.3.0 `APPLIES=39, CONFLICT=1`；fork `APPLIES=38, CONFLICT=2`；三棵树 `ALREADY-UPSTREAM=0` |
| 逐文件 `git apply --check -p1` | 仅 `agent-loop.ts`（18.3.0 与 fork）与 `rpc-mode.ts`（仅 fork）失败，其余全部 OK |
| 整补丁 `git apply --check -p1`（捕获真实退出码） | 18.2.7 → 0；18.3.0 → 1；fork → 1 |
| 测试面检索（`grep -rn "xd://propose|PROPOSE_DEVICE_NAME" --include=*.test.ts`） | 18.3.0 与 fork 均 9 个文件，命中集合一致（fork 未新增 propose 测试） |
| 场景检索（`soleBatch`/`batchPolicy`/`must be the only tool call`） | fork 全树 **0** 命中 |
| `SubmitPlan|SubmitGoal`（fork 全树 `*.ts`/`*.md`） | **0** 命中 |
| `set_plan_mode`/`plan_proposal`/`plan_approval`/`set_goal` 在 `rpc-types.ts` | 18.2.7 = 0，18.3.0 = 0，fork = 2/1/2/1 |
| `md5sum` 关键上游文件三树 | `goals/runtime.ts` = `8dc609b3…`×3；`prompts/goals/goal-continuation.md` = `8405236e…`×3；`modes/rpc/host-tools.ts` = `b8c9c954…`×3；`agent-loop.ts` = 18.2.7 `f37c82f7` vs 18.3/fork `402d9504` |
| `node docs/scripts/check-docs.mjs`（`app/`） | **exit 1，6 项预存在问题**（`adr/0301` H1 不以 `ADR` 开头 + `adr/0301`–`0305` 缺索引行），与本轮起点提交上的记录**完全一致**；新增页面零新增问题（506 页统计不变） |
| `node docs/scripts/check-locales.mjs`（`app/`） | `Verified 79 English/Chinese specification pairs.`，exit 0（本轮不改规格/ADR，数字不变） |
| `node scripts/check-t20-matrix-ids.mjs`（`app/`） | `MATRIX-ID-OK: B1-B14, C1-C8, D1-D3 each appear exactly once`，exit 0 |
| `node scripts/check-architecture.mjs`（`app/`） | **exit 1，预存在失败**：`apps/desktop/electron/main/index.ts is 1550 LOC; maximum is 1500`。本轮 `git status --short` 只有新增的本文件，`app/` 零改动，因此该失败与本轮无关（起点提交即如此）；本轮不修 |
| `git status --short`（根仓库） | 只有 `?? docs/validation/M5-omp-18-3-fork-audit.md`（审计前为空；子模块目录仍为未初始化空目录，gitlink 与内容未动） |
| `git diff --check` | exit 0 |
| `git show --check HEAD`（提交后） | exit 0（见 §13 提交坐标） |
| 文档内固定 SHA 核对（脚本列出文档里全部 40 位十六进制串并逐个回查来源） | 文档含 **6** 个不同 SHA，5 个固定坐标全部回查一致：PI `0111e306…`（clone HEAD）、18.2.7 `d49918fa…`（clone HEAD + 根 gitlink）、18.3.0 `62bc57be…`（git 对象 + `git ls-remote` 标签）、fork `81b9f250…`（clone HEAD + 逐 blob 校验）、GUI `31327996…`（clone HEAD）；第 6 个 `4a7a5d82…` 为本分支基线提交，`git rev-parse HEAD` 一致 |

限制：`git apply --check` 的管道写法曾吞掉退出码（`| head` 改变 `$?`），上表列的是**去掉管道后**重新取得的真实退出码。`check-docs.mjs` 的 6 项与 `check-architecture.mjs` 的 1 项都是**起点提交即存在**的问题，本轮按“只做当前阶段”的约定不作顺带修复，以免把无关改动混进审计轮。

### 12.1 复审返修轮（F1-F6）的源码复核

复审提出的六项都先回到固定源码逐条核对，再改文档字句；核对命令与观察如下（全部只读）：

| 复审项 | 复核命令（工作目录） | 观察 |
| --- | --- | --- |
| F1 argv | `sed -n '290,315p' src/main/sidecar.ts`；`grep -n "launch\|--mode" src/main/sidecar.test.ts`（GUI 仓库） | 复审成立：`:297` 只是 `const args = ["--mode","rpc-ui"]`，`:298-306` 再 push `--session`/`--no-auto-resume`/`--chat`/过滤后的用户 flag；测试钉住**完整** argv（`:46,70,94,100,133,183-198`） |
| F2 解析顺序 | `sed -n '56,113p' src/main/index.ts`；`grep -rn "spawn(\|execFile(" src/main/*.ts`；`grep -rn "OMP_BUNDLED_OMP\|OMP_SIDECAR" src scripts e2e` | 复审成立：`OMP_BUNDLED_OMP` 在 `:68`（早于 `:71` 的 `resourcesPath`）且无 `isPackaged` 门；`:76-89` 仍向上扫描 `app.getAppPath()`/`cwd`；`resolveSourceCli` `:98-112` 无 `isPackaged` 门；`spawn` 一律用已解析路径（无 PATH 查找）；e2e/showcase 正在使用该覆盖 |
| F3 构建来源 | `sed -n '205,250p' README.md`；`grep -n "rev-parse\|remote" scripts/build-bundled-omp.ts scripts/sync-upstream.sh`；`sed -n '1,30p' CHANGELOG.md` | 复审成立：脚本无 remote/commit 校验；README 只规定**推荐**布局与“记录 commit”；0.9.9/0.9.10 条目无 SHA（历史条目有） |
| F4 符号集合 | 复算标识符缺失数（方法见 §3） | 复审成立：只能支持“未发现符号级缺失”，不能支持功能等价 |
| F5 prepare/投机时序 | `sed -n '2278,2295p;2015,2045p' packages/agent/src/agent-loop.ts`；`sed -n '800,860p' packages/agent/src/speculative-execution.ts`；`sed -n '155,200p' packages/coding-agent/src/speculation/host.ts`（18.3 树） | 复审成立：`toolcall_end` → `admitFinalized`（`:2282-2288`）→ `#insertCandidate` → `#drain()`（`:808-816`）；`deferBeforeToolCall` 才等 `#admissionsFinalized`（`:852-855`），该 flag 只在本地读宿主声明且仅在装了 `beforeToolCall` 时被采纳（`host.ts:169-183`）；§7.1 原先的“任何调度之前”是错误表述 |
| F6 迁移成本 | `python3 /tmp/t20r3d/analyze_patch.py`；逐文件 `git apply --check` | 复审成立：18.3 = 39/40（1 个锚点）、fork = 38/40（2 个锚点）；原 §8 结论把两者合并为“1 个”是错误表述 |

返修范围：仅本文档、`docs/04-task-board.md`、`HANDOFF.md` 的字句与结论分档；**未改**生产代码、测试、两个子模块、patch artifact 与 manifest；**未**解除 R3、**未**删除 Cursor 产品门、**未**声称 T20 完成。

## 13. 复核入口

- 本轮源码与结论可复现：`/tmp/t20r3d/{can1357-18.3.0,nornzach-omp,omp-18.2.7,verify-183,diffs,perfile}`；GUI 源码 `/tmp/oh-my-pi-gui-review`；分析脚本 `/tmp/t20r3d/analyze_patch.py`（scratch，不进仓库）。
- 文档内固定 SHA 与实际取得的 SHA 由 §1 的逐 blob 校验钉住；`docs/source-baseline.json` 未被本轮修改（升级时才新增日期化记录）。
- 与本轮结论直接相关的既有证据：`docs/validation/M5-omp-transition-patch.md`（§1/§2/§8/§9/§10：R3 阻塞、Cursor 预执行、方案 A/B 判定）、`docs/validation/M5-plan-goal-capability-gates.md`（T20-A 审计与验收矩阵）、`docs/validation/M5-cursor-plan-goal-gate.md` + `app/docs/adr/0306-plan-goal-excludes-cursor-models.md`（Cursor 产品门）。
