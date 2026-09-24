# M5/T19-C：桌面技能/记忆/插件用户路径

更新时间：2026-09-25。状态：**T19-C 已实现并验证（分支 `codex/m5-capability-user-paths`，首轮基线 `df49b84f8246a83c4ed5cb1e2a3e0c72ee88e538`；第二轮复审返修基于 `10d2366cc8e968cfe3fef9d8b162e8446dbf18c5` 追加提交，见 §3.3/§8）**。固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（18.2.7）、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`。T20（Plan/Goal/高权限能力门）未实现、未声称。

## 1. 上游证据（固定源码，非推断）

### 1.1 PI-Desktop（`upstream/pi-desktop` @ `0111e306`）

**目录组装与来源顺序**（`apps/desktop/electron/main/runtime/session-launch.ts`）：

- `activeUserSkills(projectPath)`（130-144）：host RPC `skills.active`，按绑定项目作用域过滤；host 不可用/读失败 → `[]`（best-effort）。
- `loadUserSkillBody(id, projectPath)`（225-240）：host RPC `skills.read`；skill 或 body 缺失 → `null`（调用方回退到插件目录）；**读取后重复 `isActiveInProject` 作用域检查**，不通过即抛 `skill "<id>" is not enabled for this project`——会话可跨 prompt 存活，目录之后的作用域变更必须立即生效。
- 目录顺序（441-464）：`builtinSkills({workspacePath, pluginPaths})` → `plugins.getSkills().filter(pluginActiveInProject)` → 用户技能；只传 `id/name/description`，正文按需读。
- 项目/组记忆（379-433）：`project.group.context` → `context.memory.content`（trim）；组有 `roots`/`instructions` 时进入 `projectInstructions`（非 T19-C 范围）；`!result.context` 时回退旧路径 `project.memory.get`；整个读取 try/catch best-effort，失败绝不妨碍 launch。
- **`Skill` 本地工具**（`sidecar.ts` 524-563）：`s.setLocalTool("Skill", …)`；id 缺失 → `Skill: \`id\` is required. Use an id from the Skills section.`（`isError:true`）；查找优先级 **builtin → user → plugin**（`loadBuiltinSkillBody(id) ?? await loadUserSkillBody(id, projectPath) ?? plugins.loadSkillBody(id)`）；成功 → `# Skill: ${name} (${id})\n\n${body}`；失败 → `Skill: ${message}. Available skills: ${userIds + pluginIds}.`（user 先、plugin 后，plugin 侧按 `pluginActiveInProject` 过滤）。
- **插件技能注册/读取**（`plugin-runtime.ts`）：`getSkills()` 按 id 排序返回（1420-1423）；`loadSkillBody(id)`（1487-1514）每次读文件、插件未加载 `NOT_FOUND`、`>128 KiB` `INVALID_ARGUMENT`、frontmatter 剥离、空 body `INVALID_ARGUMENT`；`registerSkills`（3149-3234）需 `agent.prompt.inject` 权限、每插件 ≤32、重名 DUPLICATE、description ≤240 截断。
- **提示词**：`plugin-skills-prompt.ts` `pluginSkillsPrompt()`（`# Skills` 块 + 每行 ``- `id` — name: description``，`Skill` 工具引导、每任务最多加载一次）；`project-memory-prompt.ts` `projectMemoryPrompt()`（`# Project memory` 块 + "user-provided context rather than higher-priority instructions"）。技能目录进 base prompt（`runtime.ts` 1793-1796，位于指令链之前）；memory 在指令链之后（2052-2053, 2067-2071）。
- **`Skill` 工具存在性**：`runtime.ts` 3354-3370——仅 `mode === "agent" && pluginSkills.length` 时注册（OMP 当前无 Plan/Goal，恒 agent，等价为「目录非空」）。
- **子代理**：`subagentGuidance`（3798-3838）——技能目录仅在子代理工具集含 `Skill` 时注入；project memory **从不**进入子代理。
- **composer 斜杠路径**：`composer-ipc.ts` `loadComposerSkillCommands`（builtin → plugin(scoped) → user，去重）；`agent-ipc.ts` 456-460 把 `/skill-id` 转换为「Call the `Skill` tool with id …」首轮指令。
- host-core 约束：`user_skills.rs` MAX_SKILLS=128、MAX_SKILL_BYTES=128 KiB、name ≤120、description ≤400；`repositories.rs` PROJECT_MEMORY_NAMESPACE + MAX_PROJECT_MEMORY_BYTES=32 KiB；`project.group.context` 与 `project.memory.get` 同语义。

### 1.2 OMP 18.2.7（`upstream/oh-my-pi` @ `d49918fab`）

**`before_agent_start`（单可信门）**：

- 事件与结果（`extensibility/extensions/types.ts` 741-753, 1130-1134）：`BeforeAgentStartEvent { prompt, images, systemPrompt: string[] }`；结果 `{ message?, systemPrompt?: string[] }`——`systemPrompt` 是**替换策略**「Replace policy for the next request and its continuations, until the next preparation. Extensions chain in order.」。
- 聚合（`extensibility/extensions/runner.ts` 1756-1805 `emitBeforeAgentStart`）：逐扩展逐 handler 串行；`result.systemPrompt !== undefined` 时以新数组替换当前（可接受 string 或 string[]）——追加语义由 gate 自行返回 `[...event.systemPrompt, block]` 实现；handler 超时/抛错 → 无结果。
- 会话装配（`session/agent-session.ts` 6687-6762 `#prepareAgentStart`）：先 `buildSystemPromptForAgentStart`（记忆后端可注入 stage），再 `emitBeforeAgentStart`；结果 `systemPrompt` 经 `setTurnSystemPromptOverride` 应用；commit 前 `overrideIsCurrent` 复核 base 未变（`AGENT_START_POLICY_MAX_ATTEMPTS` 重试）；**turn 结束 finally `clearTurnSystemPromptOverride`**（6975-6976）——每 prompt 重新跑 hook，与 PI 每次 launch 重装配同节奏。
- 应用（`session/session-tools.ts` 399-402）：`setTurnSystemPromptOverride` → `agent.setSystemPrompt(prompt)`；base 重建（390-392 `#applyAgentSystemPrompt`）在 override 存活期内保留 override（OMP 自身测试 `agent-session-before-agent-start-prompt-override.test.ts` 钉死该契约：provider 请求 `context.systemPrompt` 即 override、turn 后回落 base）。
- 超时（`runner.ts` 92, 1277-1348）：`EXTENSION_HANDLER_TIMEOUT_MS = 30_000`；超时/错误 → handler 无结果 → **无注入、turn 以原生 prompt 继续**（fail closed 语义由本层提供）。
- **`message` 结果会以 `role:"custom"` 消息持久化进转录**（`#prepareAgentStart` 6734-6760 `normalizeCustomMessagePayload`）——T19-C **只使用 `systemPrompt`**，绝不使用 `message`（转录零复制）。
- rpc-ui 的 `prompt` 命令走同一 `session.prompt` 路径（`rpc-mode.ts` 1185-1241），hook 同样触发。

**`set_host_tools` 与原生技能**：

- `RpcHostToolDefinition { name, label?, description, parameters, hidden?, loadMode?, readsSkillUris? }`（`rpc-types.ts` 441-452）。
- `normalizeHostToolDefinitions`（`rpc-mode.ts` 575-596）：trim、空名/空 description/非对象 schema 拒绝；`loadMode` 未声明 → `defaultLoadModeForToolName` 未知名 = `discoverable`（移出顶层 schema）——桌面必须显式 `loadMode:"essential"`。
- 冲突（`session/session-tools.ts` 1963-2016 `#applyRpcHostToolRefresh`）：同请求重名 → `"RPC host tool names must be unique"`；与任何非 RPC-host registry 名冲突 → `"RPC host tool \"…\" conflicts with an existing tool"`——原生工具清单无 `Skill` 名（`tools/` 下 name 枚举：ask/ast_edit/bash/read/…/manage_skill 等，无 `Skill`），桌面 `Skill` host tool 可注册。
- 原生技能（`discovery/builtin.ts` 270-303）：`<cwd>/.omp/skills/`（向上遍历，project 层）+ `~/.omp/agent/skills/`（user 层；本产品合成 HOME）；系统提示 `<skills>` 块（`prompts/system/system-prompt.md` 27-34）指导 `read skill://<name>` 按需读。T19-A 保留启用；桌面目录以独立 `# Skills` 块并列注入，不触碰该机制。
- host tool 结果经 OpenAI 线格式进入 `role:"tool"` 消息（`ai/src/providers/openai-completions.ts:2421-2425`；T19-B E2E 已实测）。
- 子代理会话（`task/executor.ts` 3717-3800）：独立 SessionManager/session id；`restrictToolNames` 时 `preloadedExtensionPaths: []`（gate 不进子代理），否则 gate 可进——gate 侧以**属主 session id 匹配**决定注入，与两种情况都确定。

## 2. 设计决策（摘要）

1. **单一快照装载器**（`apps/desktop/electron/main/runtime/omp-desktop-capabilities.ts`）：`snapshot(projectPath)` 按 PI `session-launch` 语义组装 `skills`（builtin → plugin(scoped, 注册表 id 序) → user(host `skills.active`)）与 `memory`（`project.group.context` 组记忆 → 旧路径回退，best-effort）。每个 prompt 前恰好调用一次。
2. **运行域状态文件**（`packages/omp-runtime/src/desktop-state.ts`）：supervisor 在 `OmpRunPaths` 增 `desktopState`（`<runRoot>/desktop-state.json`），spawn 时设 `OMP_DESKTOP_STATE` 环境变量（buildOmpRuntimeEnv 之后写入，`extraEnv` 无法改道）；bridge 每 prompt 前经 `writeDesktopCapabilityState` **原子替换**（同目录唯一临时文件 + `wx` 独占创建 + mode 0600 + `rename` 原子换入 + finally 清理临时文件，与 `npm-preferences.ts` 同模式）写 `{v, sessionId, writtenAt, memory, skills}`——final path 上的符号链接/硬链接作为条目被换入的文件替换、绝不跟随或改写其另一名称；失败保留旧文件且不留临时文件；随 run root 一起被 stop/reclaim/启动失败清理。
3. **gate 注入**（`extensions/omp-desktop-gate.ts`）：注册 `before_agent_start` handler；读状态文件并校验（常规文件、非符号链接、≤512 KiB、**依赖无关的显式字段校验**（gate 在 OMP 进程内加载，任何包导入会解析到运行时自己的模块图——绿跑实测 typebox 解析错误致启动失败后改为显式校验）、字段长度/数量上限、新鲜度 ≤10 min、**拒绝未来时间戳（`writtenAt > now`）**、属主 session 匹配）；通过则返回 `{systemPrompt: [...event.systemPrompt, block]}`（追加、绝不替换原生 prompt）；block = 与 PI 逐字节一致的 `pluginSkillsPrompt` + `projectMemoryPrompt` 拼接（skills 在前）。任何读/校验失败或非属主会话 → 返回 undefined → **无注入、turn 以原生 prompt 继续、审批门不受影响**（fail closed 于注入，不 fail closed 于 turn）。空目录+空记忆 → 无 override（不扰动 prompt 缓存指纹）。
4. **按需 `Skill` host tool**：bridge 在目录非空时把常量 `Skill` 定义（`loadMode:"essential"`，参数 `{id}`，描述与 PI 逐字一致）加入 `set_host_tools` 目录（目录非空才注册 = PI gate）；executor 分支按 **builtin → user(调用时按 `loadUserSkillBody(..., projectPath)` 复检作用域) → plugin(仅按 PI `loadSkillBody` 复检：已注册/插件已加载/文件可读/≤128 KiB/非空 body，无执行时作用域谓词——PI `sidecar.ts` 直接调 `plugins.loadSkillBody(id)`)** 实时读 body（frontmatter 已由各来源剥离、128 KiB 上限由来源执行）；plugin 作用域变化经**下一 prompt 的目录重建**生效，不在 body 读取时拒绝；成功 `# Skill: ${name} (${id})\n\n${body}`、失败 `Skill: ${message}. Available skills: ${list}.`（`isError`）；错误提示列表 = live `activeUserSkills` + live scoped plugin skills。`Skill` 不是 `plugin_/mcp_` 名 → 网关不审批（PI 一致：只读）。
5. **一致退化与 stale 失效**：host 读失败按 PI best-effort（memory 缺失不注入、user skills 缺失仅少目录）；**snapshot 抛错、状态写入失败或 fresh state 自校验失败** → 先以**空 tombstone（skills=[]、memory=null）原子替换旧状态**，gate 只能读到「无注入」；**tombstone 也写不进** → **prompt 在提交 runtime 前失败**（gate 接受 10 分钟内文件，绝不能继续并让它读旧目录/旧记忆）。**写入成功后，bridge 用与 gate 完全相同的 `readDesktopCapabilityState` 契约回读刚写的文件并核对属主 session**——`skillsPresent` 只由校验过的状态决定（不另写可能漂移的校验规则），gate 会拒绝的目录（空 id/字段超限/数量超限/文件超限）绝不注册 Skill 工具；两种路径该 turn 都不注册 Skill 工具（无目录却给工具 = 半脑状态，明确不产生）；**失败日志只记录 presence-only 分类（`kind: error|non-error` + `hasCode` 布尔），绝不输出 message/stack/name/code 值或正文/凭据**（异常对象的 name/code/errorCode 同为调用方提供的字符串，同样被禁）。gate 侧 malformed/oversized/stale/未来时间/非属主 → 无注入。每个 prompt 都重写状态（与指纹无关），编辑/删除下一 prompt 可见。
6. **单一注册/加载责任**：桌面技能只经上述一条路径进入 OMP；原生 `<skills>`/`skill://` 不动；PI agent 扩展仍不注入；T20（Plan/Goal、mode 传播、高权限工具、子代理单独停止/`hasUI` 策略）保持关闭。

## 3. 先红后绿（探针）

探针文件（断言可观察行为）：

- `app/packages/omp-runtime/src/desktop-state.test.ts`（vitest，21 例）：写入 0600/原子替换（无临时文件残留）/符号链接/硬链接/独占创建失败/植目录拒绝/失败保留旧文件；读取缺失/目录/符号链接/超限/坏 JSON/错版本/空 sessionId/非数字时间戳/过期/**未来时间戳**/字段超限；prompt 块与 PI 逐字节一致、trim、空列表省略、拼接顺序。
- `app/packages/omp-runtime/src/desktop-state-supervisor.test.ts`（vitest，4 例）：`runRoot()` 启动前 null；spawn env `OMP_DESKTOP_STATE` 指向 run root 内路径；`extraEnv` 同名 decoy 被覆盖；stop 后状态文件随 run root 消失、`runRoot()` 回 null。
- `app/packages/omp-runtime/src/session/gate-desktop-state.test.ts`（vitest，7 例）：追加不替换原生 parts、逐字节含 PI 块；非属主 session/缺 sessionManager 不注入；缺失/坏 JSON/过期/超限字段不注入；**未来时间戳状态不注入**；空目录+空记忆无 override；仅技能/仅记忆；注册 `before_agent_start` + `tool_call` 两 handler。
- `app/apps/desktop/test/omp-desktop-capabilities.test.mjs`（6 例）：builtin→plugin→user 顺序、元数据无 body、组记忆/旧路径回退语义、作用域过滤、host 失败 best-effort（插件目录仍在）、编辑/删除下一快照可见、PI prompt 逐字节 parity。
- `app/apps/desktop/test/omp-skill-path-bridge.test.mjs`（9 例）：状态文件每 prompt 先于 prompt 写出（sessionId=原生 id、writtenAt、0600）；Skill 工具仅目录非空注册（含指纹重注册）；记忆/技能编辑下一 prompt 重写状态；**首轮写入失败且 tombstone 不可写 → prompt 在提交前失败（无 prompt/set_host_tools 命令）**；**成功后 snapshot 失败 → 空 tombstone 替换旧状态（无 stale 目录/记忆、Skill 撤回、prompt 照常）**；**tombstone 不可写 → prompt 拒绝（只允许首个 prompt 到达 runtime）**；**gate 会拒绝的 fresh state 绝不注册 Skill（自校验失败 → 空 tombstone）**；**失败日志只含稳定分类、绝不含错误文本（哨兵泄漏断言）**；两会话隔离状态与目录。
- `app/apps/desktop/test/omp-skill-path-adapter.test.mjs`（10 例）：id 缺失错误逐字；builtin 优先于同 id plugin；user 次之+**调用时作用域复检**抛错逐字；plugin 末位+加载态复检；**scoped-away plugin body 无作用域谓词照常加载（PI 精确契约 guard）**；未知 id 错误+可用列表（user 先 plugin 后、scoped-away 不进）；卸载 fail closed；body 编辑实时可见；目录不含 Skill（bridge 决定存在性，guard）；`isHostToolName("Skill")===false`（guard）。
- `app/apps/desktop/test/omp-skill-path-e2e.test.mjs`（6 例，真实固定 OMP 18.2.7 + fake provider）：T1 目录+记忆进系统提示、body 不出现在任何请求、记忆不进非 system 消息；T2 模型调 `Skill` 恰一次、body 进恰一条 `role:"tool"` 消息、零审批；T3 记忆编辑/删除下一 prompt 可见、无转录复制；T4 目录后卸载 → PI 形状错误进模型上下文；T5 原生 `.omp/skills` 项目技能与桌面目录并列；T6 状态路径符号链接不被跟随（哨兵不动）、空格/中文路径、dispose 后状态随 run root 消失。

### 3.1 红（纯基线 `df49b84`，worktree 已确认 HEAD，产品代码未含任何实现）

- vitest 3 文件：**3 文件全 fail**——`Cannot find module './desktop-state.js'`（模块不存在；desktop-state-supervisor 与 gate-desktop-state 同因）。
- `omp-desktop-capabilities.test.mjs`：**5/5 fail**——`the capability snapshot module must exist`（模块不存在）。
- `omp-skill-path-bridge.test.mjs`：**5/5 fail**——bridge 忽略 capabilities 选项：无状态文件（`ENOENT`）、`set_host_tools` 目录无 `Skill`、无两会话状态。
- `omp-skill-path-adapter.test.mjs`：**7/9 fail、2/9 通过（guard）**——失败均为行为红：`Error: plugin tool not loaded: Skill`（baseline adapter 无 Skill 分支，Skill 落入 plugin 分支）；通过的两例是钉死基线已成立契约的 guard（目录不含 Skill、`isHostToolName("Skill")===false`），与 T19-A 的路径守卫同理。
- E2E：见 §3.1.1（命令与计数）。

### 3.1.1 E2E 红

命令：`cd app/apps/desktop && env -u SSH_ASKPASS node --test --test-concurrency=1 test/omp-skill-path-e2e.test.mjs`（真实固定 OMP 18.2.7 + 本地 fake provider，无付费模型）。

结果：**6/6 fail，exit 1**，运行后 **0 残留 OMP 进程、0 残留临时目录**（清理经 `t.after` 登记，断言失败不泄漏资源）。失败原因全部为可观察缺失：

- T1：`the catalog line must carry id, name and description`（系统提示无 `# Skills` 目录——基线 gate 无 `before_agent_start`、bridge 忽略 capabilities seam，无状态文件、无注入）；
- T2：`0 !== 1`（无任何 `role:"tool"` 消息携带 skill body——基线无 `Skill` host tool，模型调用被拒）；
- T3：`0 !== 1`（没有任何请求携带记忆——无注入）；
- T4：`the model must read the PI-shaped refusal`（基线 adapter 无 Skill 分支，错误形状不是 PI 契约）；
- T5：`the desktop catalog must ride beside it`（原生 `.omp/skills` 技能断言**在基线即通过**——原生技能属 OMP、T19-A 保持启用，是基线正守卫；红的只是桌面目录缺失）；
- T6：`the supervisor must report its run root`（基线 supervisor 无 `runRoot()`/状态环境变量）。

红跑探针返修记录（见 §7）：① 首版 T5 夹具用扁平 `.md`，OMP `scanSkillsFromDir`（`discovery/helpers.ts:444-540`）只扫描 `<dir>/<name>/SKILL.md`，夹具改目录布局后红的理由归位；② 首版 E2E 在断言失败时 `finally` 引用基线不存在的 `supervisor.runRoot()`，清理被短路导致孤儿 OMP 进程与悬挂事件循环——重写为 `t.after` 资源账本（bridge/provider/userMcp/临时根逐一登记、disposer 自吞错误、dispose 幂等）后红跑正常退出且无残留。

### 3.2 绿（本阶段产品基线）

- vitest 定向 **27/27**；`@pi-desktop/omp-runtime` 全量 **317/317**（+27）。
- 桌面定向 12 套件 **172/172**（含 host-tool bridge/adapter、capability boundary、session bridge/failclosed/ownership、model projection、subagent bridge 与本轮 capabilities/skill-path bridge/adapter）。
- T19-C E2E（真实固定 OMP）**6/6**：目录+记忆进系统提示（body 不出现在任何请求、记忆不进非 system 消息）；模型调 `Skill` 恰一次、body 进恰一条 `role:"tool"` 消息、零审批；记忆编辑/删除下一 prompt 可见且无转录复制；目录后卸载 → PI 形状错误进模型上下文；原生项目技能 `<skills>` 块与桌面目录并列且 `read skill://` 按需可读（body 不进目录请求）；末级路径符号链接不被跟随（哨兵不动）、空格/中文路径、dispose 后状态随 run root 消失。
- 回归：真实固定 OMP 既有六套件 **17/17**（capability-source 5 + host-tool 6 + session/concurrent-approval/persistence/subagent 6）；桌面全量 **2858 总数 / 2854 passed / 0 failed / 4 skipped**（+26）。
- typecheck 2×0、`pnpm build:js` 0、style-token lint 0、Biome 0、`git diff --check` 0、子模块固定 SHA、无残留进程/临时目录。

### 3.3 第二轮复审返修红/绿（追加提交，基于 `10d2366`）

**红（未修实现，产品代码不变、只加探针；分两批：residual 1-3 于 `10d2366`，residual 6-7 于其修复后的工作树）**：

- vitest：**3 fail / 25 pass**——`desktop-state.test.ts` 2 fail（`refuses to replace a planted directory at the final path`：基线 rm+wx 会静默删掉预植目录并写成功，未抛错；`on a future timestamp…`：基线只查过期、未来时间恒新鲜）；`gate-desktop-state.test.ts` 1 fail（`injects nothing for a state written in the future`：基线会注入未来状态）。原子替换的契约探针（成功无临时文件残留、失败保留旧文件）在基线即通过，属钉死契约的正守卫，与 T19-A 路径守卫同理。
- `omp-skill-path-bridge.test.mjs`：**5 fail / 4 pass**——residual 1-3 三例（首轮写失败契约、tombstone 失效、tombstone 不可写 fail-before-prompt）于 `10d2366` 红；residual 6-7 两例于修复后工作树红（`a fresh state the gate would reject never decides the Skill tool`：gate 会拒绝的空 id 目录仍注册了 Skill；`capability failure logs carry no error text`：日志 fields 携带哨兵 `SECRET-CANARY-*`）。
- `omp-skill-path-adapter.test.mjs`：**10/10 pass**——新增的「scoped-away plugin body 无作用域谓词照常加载」guard 在基线即通过，证实当前实现与固定 PI（`sidecar.ts` 直接调 `plugins.loadSkillBody(id)`、`plugin-runtime.ts:1487-1514` 无 scope 复检）已一致，本次只修正文档/注释的泛化说法，不添加任何执行时 scope 拒绝。

**绿（本追加提交）**：

- vitest 定向 **32/32**；`@pi-desktop/omp-runtime` 全量 **322/322**（+5）。
- 桌面定向 13 套件 **177/177**（+5）。
- 真实固定 OMP：T19-C E2E 6/6 + 既有六套件 17/17 = **23/23**，运行后 0 残留进程/目录。
- 桌面全量 **2863 总数 / 2859 passed / 0 failed / 4 skipped**（+5）。
- typecheck 2×0、`pnpm build:js` 0、style-token lint 0、Biome 0、`git diff --check` 0、子模块固定 SHA、无残留进程/临时目录。

## 4. 实现文件

| 文件 | 变更 |
| --- | --- |
| `app/packages/omp-runtime/src/desktop-state.ts` | 新增：状态文件常量/边界（512 KiB、10 min 新鲜度、**拒绝未来时间戳**、条目数/字段长度上限）、**原子替换写入器（同目录唯一临时文件 + wx + 0600 + rename + finally 清理，失败保留旧文件、不留临时文件、不跟随 final path 别名）**、依赖无关的读取校验（gate 在 OMP 进程内加载，不得依赖包解析）、PI 逐字 prompt 块（`desktopSkillsPrompt`/`desktopMemoryPrompt`/`desktopCapabilityPrompt`）、序列化 |
| `app/packages/omp-runtime/src/supervisor.ts` | `OmpRunPaths.desktopState`；`startRuntime` 在 buildOmpRuntimeEnv 之后设 `OMP_DESKTOP_STATE=<runRoot>/desktop-state.json`（extraEnv 无法改道）；`runRoot()` getter |
| `app/packages/omp-runtime/extensions/omp-desktop-gate.ts` | 注册 `before_agent_start`：`beforeAgentStartInjection(event, context, statePath, now)` 读+校验状态（含未来时间拒绝）、属主 session 匹配、追加 PI 块（绝不替换原生 parts）；任何失败返回 undefined；`ExtensionAPI` 增事件签名 |
| `app/packages/omp-runtime/src/index.ts` | 导出 desktop-state 模块 |
| `app/apps/desktop/electron/main/runtime/omp-desktop-capabilities.ts` | 新增：单一快照装载器（builtin → plugin(scoped) → user(host `skills.active`)；`project.group.context` → legacy 回退；best-effort 与 PI 逐条对应） |
| `app/apps/desktop/electron/main/runtime/omp-session.ts` | bridge：`OmpCapabilityProvider` seam；`refreshDesktopState()` 每 prompt 前快照+原子写状态；**失败路径 `invalidateDesktopState()`：空 tombstone 原子替换旧状态；tombstone 写不进 → prompt 提交前抛 `OMP_CAPABILITY_STATE_FAILED`（gate 接受 10 分钟内文件，绝不带着 stale 状态提交）**；`registerHostTools(runner, includeSkillTool)` 在目录非空且写入成功时追加常量 `Skill` 定义（指纹含其存在性） |
| `app/apps/desktop/electron/main/runtime/omp-host-tools.ts` | `DESKTOP_SKILL_TOOL_NAME`/`desktopSkillToolDefinition()`（PI 逐字描述、`{id}` schema、`loadMode:"essential"`）；executor `Skill` 分支按 builtin → user(调用时作用域复检) → plugin(仅 PI `loadSkillBody` 复检，无作用域谓词) 实时读，PI 成功/错误形状，经 `outcomeFor` 共享预算 |
| `app/apps/desktop/electron/main/runtime/omp-session-wiring.ts` | `capabilities` 依赖透传 |
| `app/apps/desktop/electron/main/index.ts` | 生产装配：`createOmpDesktopCapabilities({host, plugins, pluginActiveInProject, activeUserSkills, log})`；adapter 增 `loadBuiltinSkillBody`/`loadUserSkillBody`/`activeUserSkills` |
| `app/packages/omp-runtime/src/session/gate.test.ts` | 既有注册测试改为静态导入并钉死两事件注册面（tool_call + before_agent_start），tool_call 阻断断言不变 |
| 测试 | `desktop-state.test.ts`（21）、`desktop-state-supervisor.test.ts`（4）、`gate-desktop-state.test.ts`（7）〔vitest〕；`omp-desktop-capabilities.test.mjs`（6，含 PI 逐字节 parity）、`omp-skill-path-bridge.test.mjs`（9）、`omp-skill-path-adapter.test.mjs`（10）、`omp-skill-path-e2e.test.mjs`（6，真实固定 OMP） |

## 5. 验证命令与结果

环境：Node v24.14.0（`/usr/local/bin/node`，nvm 24 同版本）、pnpm 10.34.5、Bun 1.4.2（`~/.bun/bin`，仅作固定 OMP 启动器解释器）、固定 OMP 18.2.7（`upstream/oh-my-pi` 仓库内启动器，`bun install --frozen-lockfile` + `bun run build:native` 已备）。全部在 `codex/m5-capability-user-paths`（基线 df49b84）工作树执行；未调用付费模型（全部 fake/local fixture）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 定向探针（vitest） | `cd app/packages/omp-runtime && pnpm exec vitest run src/desktop-state.test.ts src/desktop-state-supervisor.test.ts src/session/gate-desktop-state.test.ts` | **32 passed / 0 failed**（首轮 27 + 返修 5） |
| omp-runtime 全量 | `pnpm exec vitest run` | **322 passed / 0 failed**（T19-B 基线 290；首轮 +27、返修 +5） |
| 桌面定向（13 套件） | `node --test test/omp-host-tool-bridge.test.mjs test/omp-host-tool-adapter.test.mjs test/omp-capability-source-boundary.test.mjs test/omp-session-bridge.test.mjs test/omp-session-failclosed.test.mjs test/omp-desktop-capabilities.test.mjs test/omp-skill-path-bridge.test.mjs test/omp-skill-path-adapter.test.mjs test/engine-runtime.test.mjs test/omp-runtime-launcher.test.mjs test/omp-model-projection.test.mjs test/omp-session-ownership.test.mjs test/omp-subagent-bridge.test.mjs` | **177 passed / 0 failed**（首轮 172 + 返修 5） |
| T19-C E2E | `node --test --test-concurrency=1 test/omp-skill-path-e2e.test.mjs`（真实固定 OMP） | **6 passed / 0 failed**，无残留进程/目录 |
| 既有真实 E2E 回归 | capability-source + host-tool + session + concurrent-approval + persistence + subagent 六份 | **17 passed / 0 failed**（真实固定 OMP；与 T19-C 合并跑 23/23） |
| 桌面全量 | `cd app/apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | **2863 总数 / 2859 passed / 0 failed / 4 skipped**（首轮 2858；+5 返修） |
| typecheck | `pnpm --filter @pi-desktop/omp-runtime typecheck`、`pnpm --filter @pi-desktop/desktop typecheck` | 退出 0 / 退出 0 |
| 构建 | `pnpm build:js` | 退出 0 |
| lint | `pnpm --filter @pi-desktop/desktop lint`（style tokens）、`pnpm lint:biome` | 退出 0 / 退出 0 |
| 空白 | `git diff --check` | 退出 0 |
| 子模块 | `git submodule status` | 固定 SHA（OMP `d49918fab`、PI `0111e306`） |

## 6. 限制与已知边界

- **注入是追加、不是替换**：gate 以 `systemPrompt: [...event.systemPrompt, block]` 实现追加语义——固定 OMP 的 `systemPrompt` 结果语义是「本 turn 替换策略」（runner.ts 聚合时替换数组），追加由 gate 自己完成；OMP 自身测试钉死「provider 请求读到 override、turn 后回落 base」。
- **30 s handler 超时与 fail-closed**：`before_agent_start` handler 超时/抛错 → 无注入、turn 以原生 prompt 继续（OMP `runHandlerWithTimeout` 语义）；这是注入层的 fail-closed，不是 turn 级阻断——与「host 读失败按 PI best-effort」的决策一致。
- **子代理零注入**：gate 按属主 session id 匹配，子代理（独立 SessionManager id）什么都不注入；PI 中子代理也不接收 project memory（技能目录仅在继承 `Skill` 工具时出现——OMP host tools 不随子代理传播，故桌面目录也不注入）。`restrictToolNames` 与否都由 id 匹配统一覆盖。
- **状态文件新鲜度窗口**：10 min 上限只约束「bridge 停止刷新却仍被读取」的异常路径；正常路径写入与读取间隔毫秒级。超过窗口或**未来时间戳** → 无注入（未来时间无偏差窗口：写入与读取用同一机器时钟，罕见回拨只损失一个 turn 的注入，fail closed）。
- **原子替换语义**：同目录唯一临时文件 + `wx` + 0600 + `rename` 原子换入；final path 上预植的符号链接/硬链接作为条目被换入文件替换（其目标/另一名称不改写）；final path 为目录时 rename 失败（不静默换掉目录），失败保留旧文件且不留临时文件——此时由 §2-5 的 tombstone/fail-before-prompt 路径接管，旧状态绝不会进入模型。
- **Skill 工具与目录的一致性**：目录非空才注册 Skill（PI gate）；snapshot 失败/状态写入失败时该 turn 先失效旧状态（空 tombstone）并撤回 Skill——不产生「有工具无目录」或「旧目录残留」的半脑状态；tombstone 写不进则 prompt 直接失败（`OMP_CAPABILITY_STATE_FAILED`），不提交给 runtime。
- **PI scope 边界（按固定源码，不收紧也不放宽）**：user skill body 每次调用经 `loadUserSkillBody(id, projectPath)` 复检作用域（PI `session-launch.ts` 抛错）；plugin skill body 仅按 PI `loadSkillBody` 复检（已注册/插件已加载/文件可读/≤128 KiB/非空 body），**无执行时作用域谓词**（PI `sidecar.ts` 直接调 `plugins.loadSkillBody(id)`）；plugin 作用域变化经下一 prompt 的目录重建生效。OMP adapter 与 PI 完全一致，未添加任何额外门。
- **错误提示列表有界性**：PI 的 `Available skills:` 列表无界；OMP 路径经 `outcomeFor` 共享 ≤768 KiB 帧预算（确定性截断保头部），目录条目数本身受 host-core（128 用户技能）与每插件 32 的上限约束。
- **skill body 大小**：各来源自带上限（插件 128 KiB、用户 128 KiB、builtin 打包文件），远端无需重复校验；超限错误文本透传。
- **composer 斜杠路径**：`/skill-id` 转换为首轮 `Skill` 调用指令（既有 PI 路径）；若该 turn 因状态写入失败而无 Skill 工具，模型将得到无工具错误——与目录缺失时 PI 的行为（无该 id 的技能）同属显式失败，不静默回退 Pi。
- **T20 保持关闭**：不声称 Plan/Goal、真实 mode 传播、高权限工具完成、子代理单独停止或 `hasUI` 策略；adapter 执行上下文仍固定 `mode:"agent"`（T19-B 限制延续）。
- **PI agent 扩展**仍不注入；原生 `<skills>`/`skill://`、规则、上下文文件不动（E2E T5 实测原生项目技能与桌面目录并列、`read skill://` 按需可读）。

## 7. 探针返修记录

1. **E2E 清理缺陷（红跑复现）**：首版 E2E 在断言失败时 `finally` 引用基线不存在的 `supervisor.runRoot()`，清理被短路导致孤儿 OMP 进程与悬挂事件循环。重写为 `t.after` 资源账本（bridge/provider/userMcp/临时根逐一登记、disposer 自吞错误、dispose 幂等），红跑正常退出且零残留。
2. **T5 夹具布局**：首版用扁平 `.md`，OMP `scanSkillsFromDir`（`discovery/helpers.ts:444-540`）只扫描 `<dir>/<name>/SKILL.md`；改目录布局后基线红的理由归位为「桌面目录缺失」，原生技能断言在基线即通过（正守卫）。
3. **gate 模块加载失败（绿跑）**：gate 经 `--trusted-extension` 在 OMP 进程内加载，初版状态解析器 `import typebox` 在运行时进程解析到错误版本（`Type.String is not a function`）→ 启动即失败。修复：解析器改为依赖无关的显式字段校验（该模块被 gate 导入，任何包导入都会解析到运行时自己的模块图）；补注原因于模块头。
4. **T6 符号链接种植时机**：首 prompt 后状态文件已存在，`symlinkSync` EEXIST；先移除真实状态文件再种植别名（场景不变：末级路径别名不被跟随、哨兵不动、下次重写还原）。
5. **T6 状态断言过窄**：E2E 环境 builtin 技能加载器可解析打包技能文件（`pi-desktop/imagegen` 进目录），deepEqual 整数组失败；改为断言目标条目存在且字段精确。
6. **T4 全量并发竞态**：`waitFor(requests>=1)` 与 host_tool_call 往返竞速，全量套件并发负载下 unload 可能落在执行之后。修复：首轮脚本 `delayMs:1500`——请求在响应流式之前已记录，unload 确定落在「目录已组装、执行未派发」窗口内。
7. **既有 gate.test 注册断言**：gate 新增第二事件注册后，「恰好一个 handler」的旧断言失败；改为静态导入 + 断言两事件注册面（tool_call + before_agent_start），tool_call 阻断断言保持不变。
8. **fake 注册表保真**：adapter 卸载探针首版 fake 只替换 `getSkills`，`loadSkillBody` 仍命中闭包内的旧目录；改为同 PI `PluginRuntime.loadSkillBody` 卸载语义（`loaded.has(pluginId)` 失败）后红/绿正确。E2E fake 同步提供 `unload()`。
9. **call 顺序断言过窄**：快照装载器先读 `skills.active` 再读组上下文，首版断言 calls 恰为一条；改为断言「组上下文被读、旧路径未被读」（语义不变）。
10. **bridge 探针运行时句柄**：fake supervisor 在 prompt 前不产 runtime，解构 `runtime` 于 prompt 前得到 undefined；改为 lazy getter + prompt 后取值。

## 8. 第二轮复审返修记录（基于 `10d2366` 的追加提交）

1. **stale 状态泄漏（residual 1）**：`refreshDesktopState()` 在 snapshot 抛错时只返回 `skillsPresent:false`，旧 `desktop-state.json` 仍在——gate 接受 10 分钟内文件，下一 prompt 会注入上一轮目录与记忆，且 Skill 工具已撤回（目录/工具不一致 + stale memory）。修复：失败路径统一走 `invalidateDesktopState()`——先以空 tombstone（`skills=[]`、`memory=null`）原子替换旧状态，gate 只能读到「无注入」；tombstone 也写不进时在提交 runtime 前抛 `OMP_CAPABILITY_STATE_FAILED`，绝不让 gate 读旧文件。探针：`omp-skill-path-bridge.test.mjs` 三例（成功轮后 snapshot 失败 → 空 tombstone、Skill 撤回、prompt 照常；tombstone 不可写 → prompt 拒绝且无 prompt/set_host_tools 命令；首轮写入失败同契约），未修基线 3/3 行为红。失败日志仅 presence-only 分类（见 residual 7），绝不含正文/凭据。
2. **非原子替换（residual 2）**：`rmSync` + `wx` 在删除与创建间有缺口（崩溃/失败留无文件）。修复：按仓库既有 `npm-preferences.ts`/`crash-report.ts` 的真实原子模式——同目录唯一临时文件（`randomUUID`，不用固定 `.tmp` 名）+ `wx` 独占创建 + 0600 + `rename` 原子换入 final path + finally 清理临时文件；final path 上的符号链接/硬链接作为条目被换入文件替换（其目标/另一名称不改写），预植目录时 rename 失败（不静默换掉）；失败保留旧文件且不留临时文件。探针：`desktop-state.test.ts` 三例（成功无临时文件残留；失败保留旧文件且目录只有 final path；植目录拒绝且植入口幸存），另 E2E T6（哨兵不动）与 supervisor/清理探针保持绿。
3. **未来时间戳绕过新鲜度（residual 3）**：`readDesktopCapabilityState()` 只查 `now - writtenAt > MAX`，未来时间恒新鲜。修复：`writtenAt > now` 直接拒绝（无偏差窗口：写入与读取用同一机器时钟，罕见回拨只损失一个 turn 注入，fail closed）；`desktop-state.test.ts` 与 `gate-desktop-state.test.ts` 各加一例（未修基线均红）。
4. **PI plugin scope 边界（residual 4）**：按固定源码核对——`sidecar.ts:526-555` plugin body 成功路径无 `pluginActiveInProject`，`plugin-runtime.ts:1487-1514` 只复检存在/loaded/文件/128 KiB/非空 body；scope 只用于目录与 `Available skills` 列表。当前 OMP adapter 已与 PI 一致，未添加执行时 scope 拒绝；本轮只修正泛化说法（`omp-host-tools.ts` runSkillLoad 注释、adapter 探针头注释、ADR 0304 §1 表格行与 §5、spec §14、validation §2/§6、HANDOFF），并新增 guard 探针「scoped-away plugin body 无作用域谓词照常加载」（基线即通过，钉死契约）。
5. **文档一致性（residual 5）**：validation §2-3 曾声称 TypeBox schema（实为依赖无关显式校验，§7-3 已记录 TypeBox 移除），全部对齐为显式校验；同步更新探针/实现文件表/验证表计数与失败语义、原子写、PI scope 边界说明。T20 保持待开始，未标完成。
6. **fresh state 自校验（residual 6）**：`refreshDesktopState()` 写成功即按 `snapshot.skills.length` 决定 Skill 注册，但 snapshot 可能含 gate 会拒绝的状态（空 id/字段超限/数量超限/文件 >512 KiB）——gate 读到 null 无目录、bridge 却注册了 Skill（再次「有工具无目录」）。修复：写成功后用与 gate **完全相同**的 `readDesktopCapabilityState(statePath, now)` 回读并核对属主 native session（不另写可能漂移的校验规则），`skillsPresent` 只由校验过的状态决定；自校验失败走与 snapshot/write failure 相同的 tombstone/fail-before-prompt 路径。红测：provider 返回空 id 目录 → 基线注册 Skill（红）；修复后无 Skill 且 on-disk 为空 tombstone。
7. **失败日志脱敏（residual 7，两轮收紧）**：三处失败日志初版原样记 `String(error.message)`；首修改为 `{name, code}` 后复审指出 name/code/errorCode 同为调用方提供的任意字符串，仍可携带正文/密钥。终版：`capabilityErrorFields(error)` 只输出 **presence-only 布尔**——`kind: "error"|"non-error"`（`instanceof Error`）+ `hasCode: boolean`（code 形状属性是否存在），绝不输出任何字符串值。红测：snapshot 抛错误且 `message`/`name`/`code`/`errorCode` 各设不同秘密哨兵，断言 logger fields 序列化不含任何一个（初版红于 message 哨兵，收紧后红于 name/code 哨兵，终版绿）。
