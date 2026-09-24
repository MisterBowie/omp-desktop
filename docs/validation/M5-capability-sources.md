# M5/T19-A：运行时能力源隔离与可信网关加载

更新时间：2026-09-25。状态：**T19-A 已实现并验证（本轮基线 `ff4c1efed63475b9f552ace8a3f28f69b317e176`，分支 `codex/m5-capability-sources`）**。固定子模块：OMP `d49918fab2dba3986927f2d46721629ed0f3a02c`（18.2.7）、PI-Desktop `0111e306c120ad5820688d7608cb37bad8fbcc1f`（未改 tracked 源码；仅在本自有固定子模块内使用已有 untracked 依赖/native 产物）。T19-B（host-tool RPC）与 T19-C（桌面技能/记忆/插件用户路径）未实现、未声称。

## 1. 上游证据（固定源码，非推断）

### 1.1 OMP 18.2.7（`upstream/oh-my-pi` @ `d49918fab`）

**CLI 标志**（`packages/coding-agent/src/cli/flag-tables.ts`）：

- `--config`（117-119）：可重复，`result.config = [...(result.config ?? []), value]`；文档 `docs/cli-reference.md:65`「Load an extra `config.yml`-style overlay for this run (repeatable)」。
- `--trusted-extension`（218-221）：可重复、要求绝对路径；`args.ts:315-331`：`--trusted-extension cannot be combined with --extension, -e, or --hook`、`requires an absolute path`。
- `--extension`/`-e`/`--hook`（212-217）：把模块并入 `additionalExtensionPaths`，**不关闭**环境发现。

**`--trusted-extension` 是精确文件白名单**（`main.ts:1597-1614`）：
```ts
resolvedPath = fsSync.realpathSync.native(trustedPath); stat = fsSync.statSync(resolvedPath);
if (!stat.isFile()) throw new Error(`Trusted extension must be a module file, not a directory: ${trustedPath}`);
...
options.disableExtensionDiscovery = true;
options.additionalExtensionPaths = trustedPaths;
```
加载绕过发现（`main.ts:479-492` `loadTrustedSessionExtensions` → `loadExtensions(paths)` 直接加载；2148-2172 加载失败致命）。`sdk.ts:797-805`：`explicitOnly` 时 `configuredPaths = [...explicit]`（不含 `settings.extensions`），且 `discoverExtensionPaths(..., { ambient: false })`；`extensibility/extensions/loader.ts:600-650`：`ambient === false` 跳过 native `.omp/extensions` 能力扫描、环境 hook 工厂、已装插件扩展入口。`main.ts:1714-1719`：trusted 下跳过 CLI-root 注入。**但不覆盖** custom tools/MCP/skills/rules/插件根（这些由 `--config` 与其它旋钮管辖）——正是本阶段 overlay 的职责。

**设置优先级**（`config/settings.ts:3303-3307`，权威合并点）：
```ts
this.#merged = this.#deepMerge(this.#deepMerge({}, this.#global), this.#projectSettingsForMerge());
this.#merged = this.#deepMerge(this.#merged, this.#configOverlay);
this.#merged = this.#deepMerge(this.#merged, this.#overrides);
```
`601-604` + `1958-1962`：overlay 文件顺序 = `PI_CONFIG_FILES`（按分隔符）在前、`--config` 在后、后文胜前文；文档 `docs/config-usage.md:214-222` 原文确认 `defaults <- global <- project <- PI_CONFIG_FILES overlays <- --config overlays <- runtime overrides`。**结论：`--config <overlay>` 高于 global/project 两层，低于运行时 override。**

**`mcp.enableProjectConfig`**：默认 `true`（`settings-schema.ts:4761-4766`）；门是预去重作用域过滤（`mcp/config.ts:102-118`）：`enableProjectConfig || server._source.level !== "project"`，对**所有** provider 的 project 级 MCP 生效（native `.omp/mcp.json`/`.omp/.mcp.json`/`mcp.json`、项目根独立回退 `mcp.json`/`.mcp.json`（`discovery/mcp-json.ts:160-181`）、`.claude/.mcp.json`（`discovery/claude.ts:92-96`）等）。

**`memory.backend`**：默认 `off`（`settings-schema.ts:2967-2972`）；`memory-backend/resolve.ts:20-26` 仅 `local`/`hindsight`/`mnemopi`/`sharpshooter` 有效，其余（含 off）→ `offBackend`；`off-backend.ts:5-20` no-op `start`、`buildDeveloperInstructions` 返回 undefined；`memories/index.ts:339-341` 记忆启动硬门 = `memory.backend === "local"`；`memory://` 在 off 下 `Unknown protocol`（`internal-urls/memory-protocol.ts:404-407`）；read 工具 schema 去掉 memory 命名空间（`tools/read.ts:830-836`）。**结论：global/project 配置把 backend 改回 `local` 即重新开启记忆注入；overlay 强制 `off` 关闭。**

**项目级 settings 来源**（可重新打开上述开关的低优先层）：`.claude/settings.json`（`discovery/claude.ts:522-560`，整对象并入 project 层）、`.omp/settings.json`（`discovery/builtin.ts:846-900`）、`.cursor/`、`.gemini/`、`.codex/` 等同类 provider。

**扩展 `tool_call` 钩子**：注册 `pi.on("tool_call", handler)`（`extensibility/extensions/loader.ts:199-203`）；两入口（agent 循环 `agent-session.ts:4153-4185` 参数准备期、包装器回退 `extensions/wrapper.ts:186-215`）经 `markToolCallEmitted`/`consumeToolCallEmitted` 按 `toolCallId:toolName` 去重；`ExtensionRunner.emitToolCall`（`runner.ts:1471-1520`）逐扩展、逐 handler 调用，`{block:true}` 即阻断，handler 超时 fail-closed。

**环境扩展发现路径**：`discovery/builtin.ts:58-72` `getConfigDirs` = `<cwd>/.omp`（project）+ `getAgentDir()`（user，`PI_CODING_AGENT_DIR` 覆盖，`packages/utils/src/dirs.ts:581-583`）；`discovery/helpers.ts:818-840` 发现 `extensions/*.{ts,js}` 等。**结论：`<agentDir>/extensions/decoy.ts` 是真实的环境扩展入口，`--extension` 模式下会被加载执行。**

### 1.2 PI-Desktop（`upstream/pi-desktop` @ `0111e306`）

- **桌面 MCP**：宿主文档/进程双重拥有。记录来自 `.agents/servers`（`crates/host-core/src/mcp_servers.rs:51-52`），project 按 id 或 label 遮蔽 global（`271-273`、`177-192`）；命名 `mcp_<server>_<tool>`（`packages/plugin-sdk/src/index.ts:1974-1977`）；工具随 `pluginTools` 进 sidecar（`apps/desktop/electron/main/runtime/session-launch.ts:644-667`）；执行经 `tools.execute` → `plugins.execute`（`crates/host-core/src/tools/mod.rs:956-960`、`apps/desktop/electron/main/runtime/host.ts:161-163`）；调用时作用域复检（`user-mcp.ts:177-196`）。**Pi 没有项目 `.mcp.json` 运行时读取**（repo 全量搜索无 `.mcp.json` 读取器；外部扫描器是导入面 `agent-mcp-scan.ts`）。
- **插件 MCP/Agent Tools**：同一注册表三种贡献（`plugin-runtime.ts:2485-2504` agentTools、`3428-3519` mcpServers），命名 `plugin_<plugin>_<server>_<tool>`，同走 `plugins.execute`。
- **技能**：builtin/plugin/user 三主人（`session-launch.ts:441-461`），目录进 prompt（`plugin-skills-prompt.ts:8-25`），正文经 `Skill` 本地工具按需读（`sidecar.ts:524-546`，`skills.read` + 作用域复检 `session-launch.ts:225-241`）。
- **项目记忆**：`projectMemoryPrompt()`（`project-memory-prompt.ts:6-14`，`# Project memory` 块），宿主 kv（`PROJECT_MEMORY_NAMESPACE`，`repositories.rs:12`），组上下文优先（`session-launch.ts:379-431`）。
- **审批**：宿主 `tools.execute` 权限评估（`rpc/mod.rs:3259-3292`）；扩展级等价物是插件专属 `tool_call` 钩子（`extensions/runner.ts:47-93`、`runtime.ts:2130-2144`）；sidecar 无 `--extension` 参数（`agent-sidecar.ts:50-63`）；`discoverTrustedExtensions()`（扫 `~/.pi/agent/extensions` + `<project>/.pi/extensions`，`extensions/discovery.ts:175-193`）**无生产调用者**（仅 `discovery.ts` 与 `discovery.test.ts` 引用）。

## 2. 设计决策（摘要）

1. **每运行一份配置 overlay**（`packages/omp-runtime/src/config-overlay.ts`）：supervisor 在 `startRuntime()` 内、`prepareRun` 与 spawn 之前写入 `runRoot/config-overlay.yml` 并以 `--config <overlay>` 追加在**参数末尾**；内容强制 `mcp.enableProjectConfig: false` + `memory.backend: off`。按 1.1 的优先级链，workspace/global 配置无法重新打开这两类来源；overlay 是 run 的属性（`OmpRunPaths.configOverlay`），随 run root 一并被 stop/reclaim/启动失败清理，绝不进入静态构造参数。
2. **网关改走可信白名单**（`engine-runtime.ts`）：`--extension <gate>` → `--trusted-extension <gate>`。按 1.1，该标志关闭一切环境扩展发现，网关恰好加载一次，环境里任何扩展（含网关副本）都不会执行。审批/取消/会话/进程清理语义不变（M3）。
3. **所有权契约**（`docs/adr/0304-omp-capability-source-ownership.md` + spec `03-runtime/02-agent-runtime.md` §14）：workspace AGENTS/上下文、OMP 规则、OMP 原生项目技能与 task/LSP/debug/edit 归 OMP 且保持启用；桌面/插件 MCP 与插件 Agent Tools 归桌面宿主，T19-B 经 host-tool RPC 恰一次暴露；桌面技能 T19-C 按需读并复检作用域；桌面项目记忆 T19-C 经可信网关按 `projectMemoryPrompt()` 语义注入；插件 UI/主题/独立服务归桌面；PI agent 扩展暂不兼容、不得注入 OMP；同一 MCP 服务器/工具绝不「OMP 原生发现 + 桌面宿主注册」双载。**本阶段只实现边界（关闭 OMP 原生项目 MCP 与记忆），不实现也不声称 T19-B/C 路径。**

## 3. 先红后绿（探针）

探针文件（全部断言可观察行为，非源码文本）：

- `app/packages/omp-runtime/src/config-overlay.test.ts`（6 例，vitest；经 `spawnImpl` 捕获真实 spawn 参数）：overlay 随 `--config` 传入且位于 run root 内并含两个强制项、stop 后随 run root 消失；overlay 路径每次启动新建（非构造参数）；参数顺序（`--config` 最末、唯一、晚于 `--trusted-extension`/`--session-dir`）；启动失败不残留 run root 与 overlay；`prepareRun` 覆盖 overlay 后边界仍强制（hook 之后重写）；overlay 写入失败走统一清理（run root 无残留、`start-failed`）。
- `app/apps/desktop/test/omp-capability-source-boundary.test.mjs`（2 例，node --test；经真实生产构造器）：生产组装把网关作为**唯一**启动参数以 `--trusted-extension` 传入（禁止 `--extension`）；per-session supervisor 保留可信标志 + `--model`，且构造参数不含 `--config`（overlay 属 run 而非静态参数）。
- `app/apps/desktop/test/omp-capability-source-e2e.test.mjs`（5 例，真实固定 OMP 18.2.7，经产品 supervisor/bridge，launch 参数取自生产构造器）：T1 workspace MCP（项目根 `mcp.json`、`.omp/mcp.json`、`.claude/.mcp.json` decoy stdio 服务器写 marker；正对照 = 无边界裸启动会连接 decoy）；T2 workspace/global 配置重开记忆（`.claude/settings.json` + 隔离 global `config.yml` 设 `memory.backend: local`，canary 记忆文件经 fake provider 的系统提示断言不得出现）；T3 环境扩展（`<agentDir>/extensions/decoy.ts` 写 marker）不加载；T4 网关副本（环境路径中放第二份阻断 write 的策略）不执行、每个调用恰一次审批、写入恰好一次；T5 含空格与中文的 run 路径可启动/对话/清理（无残留 run root 与 overlay）。

### 3.1 红（基线 `ff4c1ef`）

- `config-overlay.test.ts`：**4/4 FAIL**——基线 spawn 参数不含 `--config`（`expected null not to be null`、`expected '--session-dir' to be '--config'`、启动失败例 `overlayAtSpawn` 为 null）。复核返修的 2 例（写失败清理、prepareRun 覆盖）针对修复后行为新增，未在基线重跑（基线无 overlay 机制，两者同样不成立）。
- `omp-capability-source-boundary.test.mjs`：**1/2 FAIL**——生产组装传 `--extension <gate>`（`--extension leaves ambient discovery on: --extension /…/omp-desktop-gate.ts`）；adapter 组合例基线即通过（守卫测试）。
- `omp-capability-source-e2e.test.mjs`（在干净基线 worktree `/tmp/omp-t19-baseline` 运行，产品源码 = `ff4c1ef`）：**4/5 FAIL、1/5 PASS**。T1 bounded run 中 workspace MCP decoy 被连接（marker 出现）；T2 模型请求携带 canary 记忆文本；T3 环境 decoy 扩展被执行（marker 出现）；T4 基线首个失败断言是 `the shipped gate must raise an approval`——时间线中 `call_write` 已 `tool_start`→`tool_end`，全程无 `tool_permission_request` envelope，写入结果为 `isError: true`、文本 `blocked by the duplicate gate copy`（环境中的网关副本在真实网关弹审批之前就以自身策略阻断了调用，真实网关被静默取代；单跑基线复核输出见下）；T5 路径守卫在基线即通过。（红跑期间一次 probe 自身缺陷修正见 §7：rpc-ui 无模型即退出 → 所有 supervisor 均携带 fake provider；T1 控制同样需要 models.yml。）

  T4 基线单跑复核（`--test-name-pattern` 仅 T4，基线 worktree + 调试打印）：
  ```
  T4-BASELINE-DEBUG tool result: {"content":[{"type":"text","text":"blocked by the duplicate gate copy"}],"details":{}} isError: true
  ✖ the desktop gate is the only policy over a tool call
    AssertionError: the shipped gate must raise an approval; timeline:
    … tool_start call_write → tool_end call_write …（无 tool_permission_request）
  ```

### 3.2 绿（本阶段产品基线）

- `config-overlay.test.ts`：**6/6 PASS**（含复核返修的 2 例：写失败清理、prepareRun 覆盖无效）。
- `omp-capability-source-boundary.test.mjs`：**2/2 PASS**。
- `omp-capability-source-e2e.test.mjs`：**5/5 PASS**（含 T1 正对照：裸启动确实发现并连接同一 decoy，证明 bounded 侧的缺席是边界事实而非夹具失效）。

## 4. 实现文件

| 文件 | 变更 |
| --- | --- |
| `app/packages/omp-runtime/src/config-overlay.ts` | 新增：overlay 内容（强制项置末）与写入函数 |
| `app/packages/omp-runtime/src/supervisor.ts` | `OmpRunPaths.configOverlay`；`startRuntime` 写 overlay 并追加 `--config`（参数最末）；注释 |
| `app/packages/omp-runtime/src/index.ts` | 导出 overlay 模块 |
| `app/apps/desktop/electron/main/runtime/engine-runtime.ts` | 生产网关参数 `--extension` → `--trusted-extension` + 注释 |
| `app/apps/desktop/electron/main/runtime/omp-session.ts` | 头注释（gate 加载语义） |
| `app/packages/omp-runtime/extensions/omp-desktop-gate.ts` | 头注释 |
| `app/apps/desktop/test/omp-session-{e2e,persistence-e2e,concurrent-approval-e2e}.test.mjs`、`omp-subagent-e2e.test.mjs` | 夹具 `--extension` → `--trusted-extension`（与生产一致） |
| `app/docs/adr/0304-omp-capability-source-ownership.md` | 新增：所有权契约 ADR |
| `app/docs/adr/0301-omp-session-surface.md` | 网关加载描述修正 |
| `app/docs/spec/03-runtime/02-agent-runtime.md` | §14 能力源边界 |
| `app/packages/omp-runtime/src/config-overlay.test.ts` | 新增：overlay 探针/回归 |
| `app/apps/desktop/test/omp-capability-source-boundary.test.mjs` | 新增：生产接线探针 |
| `app/apps/desktop/test/omp-capability-source-e2e.test.mjs` | 新增：真实 runtime 边界探针 |

## 5. 验证命令与结果

环境：Node `v24.14.0`（nvm）、Bun `1.4.2`（`~/.bun/bin`，仅作固定 OMP 启动器的解释器）、固定 OMP `omp/18.2.7`（`upstream/oh-my-pi` 仓库内启动器，非全局链接）。全部在分支 `codex/m5-capability-sources`（基线 `ff4c1ef`）工作树内执行；未调用付费模型（全部 fake/local fixture）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 定向探针（vitest） | `cd app/packages/omp-runtime && npx vitest run src/config-overlay.test.ts src/supervisor.test.ts` | 16 passed / 0 failed（overlay 6 + supervisor 10） |
| omp-runtime 全量 | `cd app/packages/omp-runtime && npx vitest run` | **249 passed / 0 failed**（T18 基线 243，本轮 +6 overlay 探针） |
| 接线探针 | `node --test apps/desktop/test/omp-capability-source-boundary.test.mjs` | 2 passed / 0 failed |
| 边界 E2E | `node --test --test-concurrency=1 apps/desktop/test/omp-capability-source-e2e.test.mjs` | **5 passed / 0 failed**（真实固定 OMP） |
| 既有真实 E2E | `node --test --test-concurrency=1 apps/desktop/test/omp-session-e2e.test.mjs …`（session、concurrent-approval、persistence、subagent 四份） | **6 passed / 0 failed**（M3/M4/M5 审批与停止语义在可信边界下保持） |
| 桌面定向 | `node --test apps/desktop/test/engine-runtime.test.mjs …`（engine-runtime、omp-runtime-launcher、engine-ipc-gates、omp-session-bridge、omp-session-failclosed 五份） | 93 passed / 0 failed |
| 桌面全量 | `cd app/apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | **2781 总数 / 2777 passed / 0 failed / 4 skipped**（T18 基线 2774；+7 为本轮新增：接线 2 + 边界 E2E 5） |
| typecheck | `pnpm --filter @pi-desktop/omp-runtime typecheck`、`pnpm --filter @pi-desktop/desktop typecheck` | 退出 0 / 退出 0 |
| 构建 | `pnpm build:js`（全部 workspace 包，含 shared/omp-runtime/desktop renderer） | 退出 0 |
| lint | `pnpm --filter @pi-desktop/desktop lint`（style tokens）、`pnpm lint:biome`（75 files） | 退出 0 / 退出 0 |
| 空白检查 | `git diff --check` | 退出 0 |

注意：desktop 全量套件必须在 `apps/desktop` 目录下运行（`node --test test/*.test.mjs`）；从仓库根以 `apps/desktop/test/*.test.mjs` 运行会让少量 cwd 相对夹具（`browser-cdp`、`bundled-plugins`、`plugin-work-panel-views`）报 ENOENT——与本轮变更无关。

## 6. 限制与已知边界

- `--trusted-extension` 只隔离扩展模块；custom tools、skills、rules、插件根等 OMP 原生能力按所有权契约仍由 OMP 拥有（本阶段刻意保留 rules 与 OMP 原生项目上下文，不使用 `--tools`/`--no-rules`/合成 HOME 替代源隔离）。
- overlay 只强制两个设置；未来 T19-B/C 若需更多强制项，向 `sourceIsolationOverlayYaml()` 追加（强制块保持在文档末尾）。
- 运行时自身 `settings.override()` 高于 overlay（固定 OMP 语义）；桌面不使用该通道写这两个设置。
- T19-B（host-tool RPC）与 T19-C（技能/记忆/插件用户路径）未实现；看板/HANDOFF 如实标记待开始。
- M1 实验脚本（`app/experiments/omp-bridge/e*.mjs`）与历史 results 是历史实验证据，保留 `--extension` 原样不重写。

## 7. 探针返修记录

1. **rpc-ui 无模型即退出**（红跑发现）：`rpc-ui` 在无任何模型配置时以 exit 1 终止（`No models available…`）。所有 e2e supervisor（含无 prompt 的 T1/T3）与 T1 正对照均携带本地 fake provider 的 models.yml；不影响产品实现（产品经 `projectSessionModels` 注入投影）。
2. **T2 等待断言方向错误**：把「provider 响应文本」当成「provider 请求体」等待（`requests` 只记录请求）。改为等待 bridge `message_end` envelope 中的响应文本；canary 断言扫描全部请求体。
3. **清理句柄误传 `rmSync`**：T1/T3 的 finally 把 `{close}` 句柄直接交给 `rmSync`（`ERR_INVALID_ARG_TYPE`），且 provider 服务器未关闭导致事件循环悬挂。改为与 T2/T4/T5 相同的 close-guard 清理。
4. **红跑基线环境**：基线 worktree 的子模块克隆缺生成文件（`tool-views.generated.js`），以本地 rsync 同步 untracked 产物后红跑通过。
5. **复核返修 1（overlay 写入失败泄漏路径）**：初版把 `writeSourceIsolationOverlay(configOverlay)` 放在 `startRuntime` 的 try 之前——写失败（磁盘/权限）会留下无主 runRoot 且不更新 `lastFailure`。修复：写入移入 try（`prepareRun` 之后、spawn 之前），写失败走统一 catch/`removeRunRoot`；新增 `writeOverlay` 测试缝 + 回归「overlay 写失败后 run root 无残留、`status().reason === "start-failed"`」。
6. **复核返修 2（prepareRun 可覆盖 overlay）**：`OmpRunPaths.configOverlay` 暴露给 `prepareRun`，初版先写 overlay 后跑 hook，hook 可覆盖边界文件——与「不受 embedder hook 影响」的注释矛盾。修复：改为 **hook 之后重写 overlay**（机械强制不依赖 hook 自律），新增回归「prepareRun 把 overlay 改写为 `enableProjectConfig: true`/`backend: local` 后，实际传给运行时的文件仍强制两项关闭」。ADR 0304 与 spec §14 同步更新写入时机。
