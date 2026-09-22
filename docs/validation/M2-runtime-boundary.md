# M2 运行时边界与应用身份验证记录

本记录对应任务 T08-T10(阶段 M2)。每条结论都标注来源:**源码事实**、**实际运行证据**或**推断**。
未运行的验证一律标注为未运行。

## 1. 环境与基线

| 项目 | 值 |
| --- | --- |
| 工作区 | `/home/vv/person/code/omp-desktop-m2`(分支 `codex/m2-runtime`) |
| 基线提交 | `e3071904e892ea91c2515917eafc42c715ed94f5`(M1 第五轮返修) |
| 系统 | Linux 7.0.0-31-generic,x86_64(NVIDIA GTX 1080 Ti) |
| Node / pnpm | v24.14.0 / 10.34.5(worktree 内执行,未改全局默认) |
| Bun | 1.4.2(`~/.bun/bin`) |
| Rust | stable(桌面 `host-core`);OMP 原生插件按 `nightly-2026-08-12` 构建 |
| cmake / ninja | 4.4.3 / 1.13.2(经 `~/.pyenv/shims`) |
| PI-Desktop | `0111e306c120ad5820688d7608cb37bad8fbcc1f`(未升级) |
| OMP | `d49918fab2dba3986927f2d46721629ed0f3a02c`(未升级) |

准备步骤(每个 worktree 独立,均为已记录命令):

```bash
cd app && pnpm install --frozen-lockfile          # 首次;新增 workspace 包后用 pnpm install 更新锁文件
cd upstream/oh-my-pi && bun install               # 该 worktree 的子模块依赖(见 §6 发现 1)
cd upstream/oh-my-pi && bun run build:native      # pi_natives 原生插件(需要 cmake/ninja;PATH 需含 ~/.pyenv/shims)
node apps/desktop/node_modules/electron/install.js # electron 二进制(本 worktree 未随 pnpm install 下载)
cargo build --release -p host-core                # E2E boot 探针需要的宿主二进制
```

GUI 烟测的运行环境(本机非 root 且 `kernel.apparmor_restrict_unprivileged_userns=1`,与 M0 §4 记录一致):

```bash
DISPLAY=:1 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.AII2V3 ELECTRON_DISABLE_SANDBOX=1 \
  node scripts/e2e-electron-boot.mjs
```

## 2. 可重复命令与结果

| # | 命令 | 运行目录 | 退出码 | 关键结果 |
| --- | --- | --- | --- | --- |
| 1 | `pnpm -r --if-present build`(`pnpm build:js`) | `app/` | 0 | 全部 workspace 包构建通过(含新增 `@pi-desktop/omp-runtime`) |
| 2 | `pnpm --filter @pi-desktop/omp-runtime test` | `app/` | 0 | **6 文件 / 60 检查通过**(首次交付;返修后 7 文件 / 71 项) |
| 3 | `pnpm --filter @pi-desktop/shared test` | `app/` | 0 | 84 文件 / 968 检查通过(含新增 `engine.test.ts` 与 `app-identity.test.ts`,单独运行合计 20 项) |
| 4 | `node --test test/*.test.mjs`(env 见 §5) | `app/apps/desktop` | 0 | **2545 通过 / 0 失败**(首次交付时;含新增 4 个引擎相关测试文件:router 10 项、runtime 4 项、session-ipc 4 项、launcher 8 项)。复审返修后的数字见 §8 |
| 5 | `cargo test -p host-core` | `app/crates` | 0 | **579 通过 / 0 失败**(新增 2 项:引擎持久化、v19→v20 迁移) |
| 6 | `cargo fmt --check` | `app/crates` | 0 | 无差异 |
| 7 | `cargo clippy -p host-core --all-targets` | `app/crates` | 0 | 无告警 |
| 8 | `node scripts/check-architecture.mjs` | `app/` | 0 | 通过(`main/index.ts` 1500 行,上限 1500) |
| 9 | `node ../../scripts/check-style-tokens.mjs` | `app/apps/desktop` | 0 | style tokens OK |
| 10 | `npx biome lint` | `app/` | 0 | 75 文件,无问题 |
| 11 | `node docs/validation/M0-rpc/verify-rpc.test.mjs` | 根仓库 | 0 | pass 18 / fail 0 |
| 12 | `node docs/validation/M0-rpc/verify-rpc.mjs` | 根仓库 | 0 | PASS:ready + negotiate_protocol(v2) + get_available_models(无付费调用) |
| 13 | `node run-all.mjs` | `app/experiments/omp-bridge` | 0 | **13/13 实验、413/413 检查通过**,210.0 s(M1 回归,详见 §4) |
| 14 | `node scripts/e2e-electron-boot.mjs`(env 见 §1) | `app/` | 0 | **PASS boot-probe**:应用 v0.15.2、host protocol 11、800 会话列表刷新 8 轮全部 <1 s、主线程最大间隔 32 ms、项目删除往返成功 |
| 15 | `pnpm test`(根) | `app/` | 1(仅环境性失败) | 全部包测试通过;唯一失败为 §5 记录的 `SSH_ASKPASS` 环境用例 |
| 16 | `node --test`(docs) | `app/docs` | 0 | 11/11:locales、ADR 索引、引用、结构检查全部通过 |

## 3. 逐任务实现与证据

### 3.1 T08 最小运行时接口与原 Pi 行为保持

**源码事实**:`SessionSource`(`desktop` | `pi-native` | `remote`)表示 transcript 权威来源;
新增 `EngineId`(`pi` | `omp`)表示执行引擎,两者是不同维度,不共用取值。

| 位置 | 内容 |
| --- | --- |
| `app/packages/shared/src/engine.ts` | `EngineId`、`ENGINE_IDS`、`normalizeEngineId`(未知/缺省→`pi`)、`EngineCapability`(11 项)、`EngineCapabilities`(全键必需)、`PI_ENGINE_CAPABILITIES`、`OMP_ENGINE_CAPABILITIES`(本阶段全 false)、`engineSupports`、`engineCapabilityRefusal`、`SessionEngineRef` + `ENGINE_ADAPTER_VERSION`、`EngineRuntimeStatus`、`liveEngineCapabilities`、`EngineRuntimeHandle`/`EngineStopOutcome`、协议与版本常量 |
| `app/packages/shared/src/engine.test.ts` | 20 项:旧记录→Pi、轴分离、能力完整性与开关、引用校验、版本常量 |
| `app/apps/desktop/electron/main/runtime/engine-router.ts` | 唯一路由/能力判定点(纯模块,不依赖 Electron) |
| `app/apps/desktop/test/engine-router.test.mjs` | 10 项:旧会话→Pi、`source` 不被当成引擎、停机闭锁、OMP 全拒、无静默回退 |

**Pi 默认路径保持**:`normalizeEngineId` 对 `undefined`/`null`/`""`/未知值一律返回 `pi`;
`session.create` 不带 `engine` 时桌面**不发送**该字段(Rust 侧默认 `pi`);
`session.list`/`get` 原样保留 `engine`(含 `pi-native` 记录仍无该字段)。
证据:`app/apps/desktop/test/engine-session-ipc.test.mjs`(4 项)与宿主 `crates/host-core/src/sessions.rs::tests::engine_is_persisted_defaulted_and_inherited`。

### 3.2 T09 OMP 进程监督与协议适配包

新增 `app/packages/omp-runtime`(纳入 pnpm workspace,已写入锁文件),原有四个关注点各自成模块:

| 模块 | 责任 |
| --- | --- |
| `protocol.ts` | typebox 帧 schema(`ready`/`response`/`rpc_chunk`/通用帧)、`checkReadyFrame`(v2 必需、帧上限必须与本地常量完全一致)、协议 v2 分片重组(顺序、元数据、base64 规范形式、1 MiB/64 MiB 上限) |
| `ndjson.ts` | 显式行长上限(默认 4 MiB)+ `line-too-large` 重同步、跨块 UTF-8、CRLF、非法 JSON 继续 |
| `transport.ts` | 请求 ID 匹配、分片解码先于应答匹配、**等待中的流错误按真实错误返回**(只有真正到期才叫 timeout)、写失败/退出/取消全部 settle 挂起请求、**拒绝对外发送 `rpc_chunk`**、分片故障视为致命 |
| `launcher.ts` | 启动器解析(显式/打包内/固定子模块,**绝不从 PATH 解析**)、`--version` 探针、版本比对 |
| `isolation.ts` | 合成 `HOME`、发现目录预建、剥离 `PI_CONFIG_DIR`/重定向变量/代理(大小写各四组 + `NODE_USE_ENV_PROXY`)/凭证型变量、所有权安全的目录删除 |
| `process.ts` | 启动→ready→协商 v2→版本校验;停止顺序 `abort`→(必要时 `abort_bash`)→关 stdin(EOF)→TERM 组→KILL 组;按**进程组存活**判定回收 |
| `supervisor.ts` | 运行根所有权、单飞启动、状态上报、清理判定(`stopped`/`reaped`/`cleaned` 三独立事实)、`terminateOwnedTree` 显式终止入口、`prepareRun` 运行前配置投影 |

**实际运行证据**(首次交付:`app/packages/omp-runtime/src/*.test.ts`,6 文件 / 60 项;返修后 7 文件 / 71 项,见 §8):

- 启动/握手:正常 v2 会话;版本不符(`18.2.9` vs 校验值)在**进程创建前**失败;不广告 v2 的运行时被拒;
  帧上限不符被拒;永不 ready 超时后进程与进程组被回收;崩溃按 `not-started` 上报而非超时。
- 请求生命周期:ID 匹配与事件转发;1,200,000 字节响应经分片重组;分片损坏→`transport-failed` 并使后续请求快速失败;
  真实超时(`request-timeout`)与流错误区分;写回 `rpc_chunk` 被拒;运行中退出时两个挂起请求都 settle。
- 停止顺序(证据为 mock 写入的 `MOCK_OMP_LOG`):`abort` 在 `eof` 之前;`abort_bash` 在 `abort` 之后、`eof` 之前;
  忽略 TERM 与 EOF 的运行时升级到 SIGKILL(`escalated: "kill"`);**组长退出但后代存活**时仍按进程组回收;
  重复停止返回同一判定。
- 隔离:子进程 `HOME` 在运行根内、配置根在合成 HOME 内、无凭证型变量、无 `PI_DESKTOP_*`;代理按大小写全量归一化;
  运行根删除仅限自有前缀与目录内。

**真实固定运行时无费用烟测**(`src/pinned-runtime.test.ts`,无 prompt、无付费模型):
固定启动器(仓库内 `upstream/oh-my-pi/.../scripts/omp`)→ 版本 `18.2.7` 校验通过 →
`ready` → `negotiate_protocol(2)` → 状态 `idle`/`reason: not-implemented` → `stop()` 返回
`reaped: true`、`cleaned: true`,状态目录内无遗留运行根。模型目录由 `prepareRun` 写入本地
`proxies: smoke`(指向关闭端口,从不请求)。

### 3.3 T10 会话引擎选择、能力门与应用身份

| 位置 | 内容 |
| --- | --- |
| `crates/host-core` | `sessions.engine TEXT NOT NULL DEFAULT 'pi'`(schema v20,迁移 `v19→v20` + 备份);`session.create` 接受并校验 `engine`;`fork`/协同 `spawn` 继承来源会话引擎;摘要/详情/SELECT 同步 |
| `apps/desktop/electron/main/runtime/engine-runtime.ts` | Pi/OMP 状态映射、gate 构造(含 host 会话查询)、运行时所有权、退出 reclaim 记录 |
| `apps/desktop/electron/main/ipc/agent-ipc.ts` | 执行/控制类入口统一过 gate:`agentPrompt`、`agentSteer`、`agentStop`、`agentAbort`、`agentCompact`、队列 push/prioritize/remove、`askToolResolve`、`plansResolve`(批准);读类(`agentGetStatus`、`agentQueueList`)按所属引擎作答且不进入 Pi 运行时 |
| `apps/desktop/electron/main/bootstrap/shutdown.ts` | 退出时 `ompRuntime.reclaim()`;回收未完成会写入 error 级日志 |
| `packages/shared/src/app-identity.ts` | `PRODUCT_IDENTITY`、`LEGACY_PI_DESKTOP_IDENTITY`、`assertIndependentIdentity`、保留目录检查 |
| `apps/desktop/package.json` | `appId` = `net.misterbowie.omp-desktop`,`productName` = `OMP Desktop`,publish = `MisterBowie/omp-desktop` |
| `apps/desktop/electron/main/data-paths.ts` | 目录名取自身份:`.omp-desktop` / `.omp-desktop-dev` |
| `apps/desktop/electron/main/updater.ts` | 发布页来自身份;无发布渠道时 `openReleases` 抛 `NO_RELEASE_CHANNEL`;开发构建 `disabled` |
| `scripts/dev-electron.mjs` | 开发 bundle 的名称/bundle id 由 `apps/desktop/package.json` 的 `productName`/`appId` 派生 |

**实际运行证据**:
`engine-session-ipc.test.mjs`(显式引擎原样送达宿主、缺省不发字段、列表保留各自引擎、未知引擎由宿主拒绝)、
`omp-runtime-launcher.test.mjs`(显式优先且失败不回退搜索、打包构建只用自带运行时、开发构建按目录向上找到固定启动器、
本 worktree 解析到 `upstream/oh-my-pi/.../scripts/omp`、身份无冲突、开发构建禁用更新)、
`engine-runtime.test.mjs`(Pi 仅在双进程就绪时报 `idle`;停机闭锁能力;OMP 运行中仍全闭)、
`cargo test v19_database_migrates_to_session_engine`(旧库升级后既有会话读出 `pi`)。

**E2E 实际运行证据**:`scripts/e2e-electron-boot.mjs`(真实 Electron、临时数据根、sandboxed preload)
在本次改动后仍通过 —— 说明启动期构造引擎运行时、能力门接线、退出回收与身份改名没有破坏真实应用;
该脚本自身的产品名断言(`probe.appName`)已按新身份改为 `OMP Desktop`。

**未运行的推断**:macOS 开发 bundle 的 plist 断言(`development-branding.test.mjs` 在非 darwin 上 skip)与
`PI-Desktop-macOS-open.command` 的 bundle id 已在本次改到新身份,但本机是 Linux,**未运行**这两条路径。

## 4. M1 回归与对照

| 项目 | 结果 |
| --- | --- |
| `app/experiments/omp-bridge/run-all.mjs` | 13/13 实验、413/413 检查、退出码 0(见 §2 #13) |
| M0 `verify-rpc.test.mjs` / `verify-rpc.mjs` | 18/18 通过 / 真实无费用 RPC PASS |
| 原 Pi 对照 | 桌面 2545 项测试全通过(返修后 2559 项,见 §8);`session-message-input.test.mjs` 证明 prompt 仍走原路径(prompt IPC 持久化、slash 展开跳过、宿主账本优先) |

**对照源码位置(仅阅读,未运行)**:

- PI-Desktop:`packages/shared/src/network-proxy.ts`(`PROXY_ENV_KEYS`)、
  `packages/host-runtime/src/host-process.ts`(先 `stripProxyEnv` 再叠加)、
  `crates/host-core/src/permissions.rs`(`resolve` 先移除 pending)、
  `apps/desktop/electron/main/data-paths.ts`(开发/发行数据根分离)。
- OMP:`packages/coding-agent/src/modes/rpc/rpc-frame.ts`(帧与分片常量)、
  `rpc-client.ts:172`(客户端就绪判定)、`rpc-mode.ts:843`(ready 广告)与 `:1176`(v1 协商被拒)、
  `packages/utils/src/dirs.ts`(`VERSION` 来自包版本)。

## 4.1 残留审计(改动后)

| 检查项 | 结果 |
| --- | --- |
| mock/固定运行时进程 | 运行 `packages/omp-runtime` 全套与桌面全套后均为 **0** |
| `/tmp/omp-runtime-*`、`/tmp/omp-launcher-*` 临时运行根 | **0**(测试与监督层各自删除自己创建的运行根) |
| 用户数据目录 | 无 `~/.omp-desktop` / `~/.omp-desktop-dev` 残留(人工探针创建的已删除);用户的 `~/.pi-desktop`、`~/.config/PI-Desktop`、`~/.omp`、`~/.agents` 时间戳未变 |
| 子模块工作树 | `git -C upstream/oh-my-pi status --short` 为空(安装与原生构建产物均被忽略);两个子模块提交未变 |
| 全局 `~/.bun/bin/omp` | 未改动(只执行 `bun install` 与 `bun run build:native`,未执行 `link omp`) |

**一次已修正的泄漏与结论**:早期版本的一条 `deaf` 模式用例在 vitest 默认 5 s 超时下被放弃,
当时 `stop()` 仍处于升级链中(`abort` 1 s + EOF 3 s + TERM 宽限 3 s ≈ 7 s),三个 mock 进程因此留在系统里。
已改为显式缩短各阶段预算并给出 20 s 用例超时;修正后连续多次运行均无残留。
结论对包本身同样成立:**停止一旦被调用方放弃,运行时不会被回收**——调用方必须为停止留出预算。

## 5. 环境相关的测试注记

- 本机 shell 环境存在 `SSH_ASKPASS=/usr/bin/false`,会让 `remote-host-ssh-password.test.mjs` 中
  "a key-authenticated transport is handed no askpass material" 失败——该测试断言子进程环境里
  `SSH_ASKPASS` 未设置。**与本次改动无关**(未触碰 ssh 相关代码),用
  `env -u SSH_ASKPASS node --test test/*.test.mjs` 运行即为通过(首次交付 2537,返修后 2559);
  单独运行该文件在清除该变量后为 14/14 通过。
- `pnpm install` 首次在本 worktree 需要联网;新增 workspace 包后必须用 `pnpm install`(非 `--frozen-lockfile`)
  更新锁文件——锁文件差异仅新增 `packages/omp-runtime` 一条 importer。

## 6. 与计划不同的事实与原因

1. **子模块依赖必须按 worktree 单独安装**。M0 的 `bun setup` 已在 M0 worktree 完成,但 M2 worktree 的
   `upstream/oh-my-pi` 没有自己的 `node_modules`;此时固定启动器把 `@oh-my-pi/pi-utils` 解析到
   **bun 缓存中的已发布包**,`--version` 报出 `18.2.9`,而固定检出是 `18.2.7`。
   处理:在本 worktree 执行 `bun install` 与 `bun run build:native`(不执行 `link omp`,避免改写用户全局 `~/.bun/bin/omp`)。
   这正是运行时包坚持**启动前校验版本**的现实依据——若信任启动器输出,将运行一个未经该基线验证的运行时。
2. **真实运行时需要模型目录才能就绪**。空配置下它直接以 "No models available" 退出;
   因此监督层提供 `prepareRun(paths)` 投影入口,烟测写入指向关闭端口的本地 `models.yml`(M4 将在此投影桌面模型配置)。
3. **`main/index.ts` 有行数上限**(`check-architecture.mjs`,`≤1500`)。引擎装配因此放在
   `runtime/engine-runtime.ts`,index.ts 只保留一行构造调用。
4. **上游 dev bundle 脚本硬编码身份**。`scripts/dev-electron.mjs` 原先自己写死 `PI-Desktop` 与
   `net.aiuo.pi-desktop.dev`;现改为从 `apps/desktop/package.json` 的 `productName`/`appId` 派生。

## 7. 未执行项与剩余风险

| 项目 | 状态 | 说明 |
| --- | --- | --- |
| macOS 开发 bundle / 打开脚本的 bundle id | 未运行 | 本机 Linux;`development-branding.test.mjs` 相关用例被平台跳过 |
| Windows/Linux 打包身份与安装产物 | 未运行 | M6 范围(M2 只做运行期身份边界) |
| 图标、Windows 可执行文件/快捷方式命名 | 未改动 | 属 M6 品牌与打包;`productName` 已是新产品名,图标与 win 命名仍沿用上游值 |
| 打包内自带运行时 | 未实现 | `resources/omp-runtime/omp` 只是约定位置;未产出安装包,故引擎在打包构建中会报不可用 |
| OMP 对话/工具/审批 | 未实现 | M3;本阶段所有 OMP 能力显式关闭,拒绝而不回退 |
| 真实付费模型烟测 | 未执行 | 需用户指定提供方、模型与预算 |
| 子代理进程树自动回收 | 未实现 | 已提供 `terminateOwnedTree`,由 M3/T17 从子代理事件取 pid 调用 |
| 打包后安装/离线启动 | 未运行 | M6 |
| `PI_DESKTOP_*` 环境变量名 | 未改名 | 38 个文件引用;属开发/测试覆盖机制,改名与 M6 品牌一并处理 |
| 临时目录/工件命名 | 未改名 | E2E 探针的临时 profile 前缀 `pi-desktop-boot-` 是它与 `session-list-probe.ts` 的夹具契约;宿主二进制名 `pi-desktop-host-core` 同样属 M6 打包命名 |

## 8. 独立复审返修记录（R1-R7）

复审对象:`35570e3a595f759eabc0631ad9bc2023caa50d1a`。以下每条都先对照固定 PI-Desktop 与固定 OMP 源码,
再改本项目;新增测试均先验证“修复前失败、修复后通过”。

### R1 生产 session→engine 查询未接线

**原状(源码事实)**:`engine-runtime.ts` 只调用 `createEngineRouter({ status })`,`index.ts` 的生产构造也没有查询回调,
因此 `agentSteer`/`agentStop` 的 `requireForSession` 永远得到 `pi`。
**修正**:`createDesktopEngineRuntimeForApp` 现在接收 `getHost` 并构造 `createHostSessionLookup`(读 `session.get`,
`messageLimit: 1`,缺失会话返回 NOT_FOUND 而不是“旧会话”);`index.ts` 在同一次构造里传入。
**证据**:`engine-runtime.test.mjs` 的组合测试(存储 `engine: "omp"` 的会话在 `steer`/`stop` 上抛
`ENGINE_CAPABILITY_UNAVAILABLE`,且全程只有 `session.get` 一种 RPC,没有任何 sidecar 调用);
`engine-ipc-gates.test.mjs` 断言 OMP 会话下 sidecar 与队列桥调用数均为 0。

### R2 查询失败时 fail-open 到 Pi

**原状(源码事实)**:`engineForSession` 捕获任意异常后 `normalizeEngineId(undefined)` → `pi`。
**修正**:只有**成功读取且记录无 engine 字段**才归 `pi`;查询异常或本构建不认识的值一律以
`ENGINE_UNAVAILABLE` 拒绝(新增 `lookupFailure`),未配置查询的 router 同样拒绝。原先断言 fail-open 的测试已改写为
断言拒绝。
**证据**:`engine-router.test.mjs` 中 “a failed engine lookup refuses instead of assuming Pi”、
“an engine value this build does not know refuses”、“a router without a lookup refuses id-only gates”,
以及 `engine-runtime.test.mjs` 的 host 失败/缺失主机两条。

### R3 逐条审计按 sessionId 进入 Pi 执行路径的 IPC

**修正**:见 ADR 0300 的审计表——执行/控制类全部过 gate(拒绝时抛 `ENGINE_CAPABILITY_UNAVAILABLE`),
读类按所属引擎作答且不触碰 Pi 运行时,三条路径(原生 `native.session.*`、`promptEnhance`/`sessionSummarizeTitle`、
`toolResolvePermission`)在 ADR 中写明依据。计划批准在执行入口与**恢复/排空路径**两处都过 gate
(`plans.ts` 内新增 `getEngineRouter` 依赖,因排空的执行从未经过交互式批准)。
**证据**:`engine-ipc-gates.test.mjs`(7 项行为测试)。**先失败后通过**:临时移除 gate 后 5 项失败
(abort 一项因临时移除脚本只匹配带注释的行而仍保留 gate)。

### R4 supervisor 在 reaped:false 后丢失所有权

**原状(源码事实)**:`stop()` 无条件清空 `runtime`/`ownership` 并尝试删除 runRoot;`reclaimAll()` 对保留项只删目录,
从不按保存的 pgid 再次终止;status 会在 pendingCleanup 非空时报 stopped。
**修正**:未 reaped 时保留完整诊断与可重试所有权(不删活进程的 runRoot、status 报 `failed`/`unreclaimed`、
存在未回收所有权时拒绝再次 `start`);`reclaimAll()` 先按保存的 pgid 重新验证并终止,确认 reaped 后才删目录,
失败项保留以便重试。`EngineUnavailableReason` 新增 `"unreclaimed"` 并写明语义。
**证据**:`supervisor-lifecycle.test.ts`(8 项,注入受控 runtime)。**先失败后通过**:临时恢复旧语义后该文件 6 项失败。

### R5 stop/reclaim 并发竞态

**原状(源码事实)**:`OmpRuntimeProcess.stop()` 无 in-flight promise,并发 stop 会重复 abort/EOF/TERM/KILL;
supervisor `start()` 与 `stop()`/`reclaimAll()` 无协调,shutdown 可能在 start 装好 runtime 前返回 “nothing owned”。
**修正**:进程级 stop 单飞(并发调用共享同一 Promise 与同一结果,仅**成功**结果被记住,失败保持可重试);
监督层 `stopping` 单飞,并在 `performStop` 开始时等待 in-flight start。
**证据**:`process.test.ts` 的 “one stop sequence when several callers stop at once”(mock 日志中 `abort`/`eof` 各恰好 1 次)
与 “does not cache a stop whose process group survived”(注入终止实现:首次 unreaped、重试真正回收);
`supervisor-lifecycle.test.ts` 的并发 stop / start 竞态两条。**先失败后通过**:临时去掉进程级单飞后
并发用例得到 `['abort','abort','abort']`。

### R6 shutdown 吞掉 reclaim rejection

**原状(源码事实)**:shutdown 只在 resolved results 中检查 `stopped=false`,`reclaim()` 抛错会被
`Promise.allSettled` 吞掉且无日志。
**修正**:抽出 `reclaimOwnedRuntime(runtime, log)`,对 rejection 写 `OMP_RUNTIME_RECLAIM_FAILED`、对部分失败写
`OMP_RUNTIME_CLEANUP_FAILED`(字段仅含步骤与错误文本,不含凭证);shutdown 调用该函数。
**证据**:`engine-runtime.test.mjs` 的行为测试(注入 reject / 部分失败 / 干净三种 reclaim,断言日志条数与 code)。
`rpc-lifecycle-contract.test.mjs` 同步更新为断言 `reclaimOwnedRuntime(ompRuntime, …)` 且 `ompShutdown` 在
`Promise.allSettled` 列表中。

### R7 macOS/NVM 测试夹具不可移植

**原状(源码事实)**:mock 子进程脚本以 `#!/usr/bin/env node` 启动,而测试夹具沿用生产封闭 PATH
(`~/.bun/bin`、`/usr/local/bin`、`/usr/bin`、`/bin`),macOS 上 Node 位于 `~/.nvm`, `/usr/bin/node` 不存在 → exit 127。
**修正**:仅测试夹具新增 `mockPathEntries()`(在默认条目后追加 `dirname(process.execPath)`),
`test-harness.makeMockLayout` 与 supervisor 测试均使用它;生产 `buildOmpRuntimeEnv` 的 PATH 保持封闭。
**证据**:`isolation.test.ts` 新增用例断言夹具 PATH 含解释器目录、而生产 `defaultPathEntries()` 不含。
**限制**:本机为 Linux,**未运行** macOS 实测;该用例锁定的是成因与修法,不是跨平台结论。

### 另外修正的状态契约

supervisor 文件头声明 “caller must never read stopped out of a run it could not reclaim”,此前与实现不符:
未清理时 `status()` 仍返回 `stopped`。现改为:仍有存活所有权 → `failed`/`unreclaimed`;仅目录未删 → 同样 `failed`/`unreclaimed`。

### 返修后的验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm build:js` / `pnpm typecheck` | 0 错误 |
| `pnpm --filter @pi-desktop/omp-runtime test` | **7 文件 / 71 项通过**(新增 11 项) |
| `pnpm --filter @pi-desktop/shared test` | 84 文件 / 968 项通过 |
| `cd apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | **2559 通过 / 0 失败**(新增 3 个引擎测试文件共 20 项:router 13、gates 7、runtime 8) |
| `cd crates && cargo test -p host-core --locked` | 579 通过 / 0 失败 |
| `cd app/experiments/omp-bridge && node run-all.mjs` | 13/13 实验、413/413 检查、退出码 0 |
| 固定 OMP 无费用烟测(运行时包内) | 版本 18.2.7 → ready → negotiate v2 → stop 后进程组与运行根均已回收,未发送 prompt |

## 9. 第二轮独立复审返修记录（S1-S6）

复审对象:`9c0aa358a7ca346b854378e266e77e36942947ef`。同样先对照固定源码,再改本项目,
新增测试均验证“修复前失败、修复后通过”。

### S1 `agentQueueReorder` 绕过唯一 gate

**原状(源码事实)**:`agent-ipc.ts` 的 reorder 直接调用 `queue.reorder`,而 `remove`/`prioritize` 已经
`sessionOf` + `requireForSession(owner,"followUp")`。对照固定 PI-Desktop:`AgentHost.reorderTurn` 与
`prioritizeTurn` 同级,移动队列顺序会改变下一个被执行的 turn,属控制路径。
**修正**:reorder 与 prioritize/remove 使用同一 owner 查询与同一 `followUp` gate;`sessionOf` 缺失即视为无主(由队列自身报错)。
**证据**:`engine-ipc-gates.test.mjs` 的 “queue reorder refuses an OMP turn and still orders Pi turns”
(OMP 拒绝且 bridge 未收到 reorder;Pi 正常移动)。先失败后通过:移除该 gate 时该用例失败
(`agentHostBridge.queue.reorder is not a function`/bridge 收到 reorder)。

### S2 gate 之前修改持久状态

**A. 计划批准**:原状为 `plans.resolve` → `settleApproval` → 才 gate;固定 PI-Desktop ADR 0052 的
`plans.resolve` 是原子事务(pending→approved、会话转 agent、写权限模式、创建后续执行)。
**修正**:`action === "approve"` 时在读事务之前 gate;`reject` 不启动运行时,保留固定拒绝语义。
**证据**:`engine-ipc-gates.test.mjs` 的 “an approval for an OMP session mutates nothing”
(断言 `plans.resolve` 调用数 0、settlement 0、dispatch 0)、“a rejection still follows the host's own semantics”、
“an approval for a Pi session still runs the transaction and dispatches”。

**B. 恢复/排空**:原状为先 `plans.claimExecution`(queued→running),之后才 gate,失败还把执行改成 interrupted。
**修正**:先读持久 session 并 gate,再要求 sidecar;被拒的执行**带着警告跳过**,行保持 queued、不产生 turn、
drain 继续处理其余条目。
**证据**:`plan-drain-engine-gate.test.mjs`(真实 `createPlanRuntime` + 真实 `createSessionCoordination`):
OMP 队列执行时宿主只收到 `plans.queuedExecutions` 与 `session.get`,**没有** `claimExecution`/`beginTurn`/
sidecar/`finishExecution`;Pi 执行仍完整派发;缺 gate 时一条也不 claim。先失败后通过:临时恢复旧顺序后 3 项全失败。

### S3 在 engine 之前依赖 Pi sidecar/AgentHost

**修正**:本轮改过的 handler 统一为“参数/身份校验 → 读引擎并 gate → 才要求 Pi 运行时”
(`agentPrompt`、`agentSteer`、`agentStop`、`agentAbort`、`agentCompact`、`agentQueuePush/List/Remove/Prioritize/Reorder`、
`askToolResolve`;原生 `native-pi:` 分支保持先要 sidecar)。同时把 gate 语义明确为**按声明**判定:
运行时未启动是状态问题(`EngineRuntimeStatus`/`liveCapabilities`),不是“引擎不支持”,否则一次重启就会被当成永久拒绝,
队列也无法在重启期间暂存消息;需要活运行时的路径仍旧给出各自的 “sidecar unavailable”。
**证据**:`engine-ipc-gates.test.mjs` 的 “an OMP session is refused even when the Pi runtime is absent”
(8 条执行路径全部 `ENGINE_CAPABILITY_UNAVAILABLE`;`agentGetStatus`/`agentQueueList` 在 sidecar=null、bridge=null 时
仍返回稳定结果)与 “a Pi session still reports its own runtime's absence”。

### S4 启动失败后丢弃 reaped:false 的所有权

**原状(源码事实)**:`OmpRuntimeProcess.start` 的 catch 忽略 `stop()` 的 `reaped:false`;supervisor 拿不到 handle,
只按普通启动失败删目录。
**修正**:新增 `OmpStartupFailure`(携带 runtime 与 stop verdict,`ownsLiveProcess`)与 `startupFailureOwnership()`;
supervisor 采纳该所有权(记录 pid/pgid、保留 runRoot、`status` 报 `failed`/`unreclaimed`、拒绝第二次 start),
`stop()`/`reclaimAll()` 可重试并最终清理;未 reaped 时绝不删除活进程目录。
**证据**:`supervisor-lifecycle.test.ts` 的 S4 两条 —— 注入首次 termination 返回 `reaped:false` 且子进程真的存活
(`deaf-unready` mock:`deaf-unready` 既不 ready 又忽略 EOF/SIGTERM),断言失败对象携带所有权、目录保留、
二次 start 被拒、重试终止后进程与目录都清理干净;另一条断言成功回收时**不**携带所有权(fail-closed 的反面)。
先失败后通过:临时恢复“忽略 verdict”后该用例失败。

### S5 cleanup-only 记录用旧 PGID 再发信号

**原状(源码事实)**:进程已 reaped 但目录删除失败时,记录仍带原 pid/pgid;`reclaimAll` 对所有 `pgid>0` 都发 TERM/KILL。
**修正**:记录新增 `reaped` 事实;目录型记录把 pid/pgid 归零,`reclaimAll` 只重试删除,绝不发信号;
只有明确仍拥有活组的记录才重试终止(且先终止、确认 reaped 后才删目录)。
**证据**:`supervisor-lifecycle.test.ts` 的 “a directory-only retry never signals the old group”
(注入的终止实现调用次数必须为 0)与 “a live retry does terminate the retained group”
(注入实现被以该 pgid 调用,记录保留、目录不删)。先失败后通过:恢复旧语义后两条均失败。

### S6 交付物包含未跟踪的提示词文件

**修正**:删除任务临时文件 `.m2-executor-prompt.md`,最终以 `git status --porcelain` 为空(含未跟踪)为准。

### 返修后的验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm build:js` / `pnpm typecheck` | 0 错误 |
| `pnpm --filter @pi-desktop/omp-runtime test` | **7 文件 / 75 项通过**(本轮新增 4 项) |
| `pnpm --filter @pi-desktop/shared test` | 84 文件 / 968 项通过 |
| `cd apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | **2568 通过 / 0 失败**(本轮新增 `plan-drain-engine-gate` 3 项与 gates 6 项) |
| `cd crates && cargo test -p host-core --locked` | 579 通过 / 0 失败 |
| `cd app/experiments/omp-bridge && node run-all.mjs` | 13/13 实验、413/413 检查、退出码 0 |
| 固定 OMP 无费用烟测 | M0 `verify-rpc.mjs` PASS;运行时包 `pinned-runtime.test.ts` 通过(18.2.7 → ready → v2 → 回收),未发送 prompt |
| 残留 | mock/OMP/Electron 进程 0、临时运行根 0、无 `~/.omp-desktop*`、子模块 SHA 未变、`git status --porcelain` 为空 |

## 10. 第三轮独立复审返修记录（S7）

复审对象:`aa88fdfc0a502794b04fa4e8b511b0536384603a`。

### S7 扫描回收成功后残留“幽灵所有权”

**原状(源码事实)**:`reclaimAll` 先把未能回收的 ownership 复制进 `uncleanedRuns`,随后同一次遍历中
`terminateTree` 若成功且目录删除成功,只从 `uncleanedRuns` 删除记录,却未清空 `this.runtime`/`this.ownership`——
进程组与目录都已消失,supervisor 仍报 `failed`/`unreclaimed`,并继续拒绝 `start()`。

**修正**(不改变 cleanup failure 语义:`uncleanedRuns` 非空时 `status` 仍为 `failed`/`unreclaimed`,
`start()` 仍拒绝,直到清理完成):

1. 新增 `releaseOwnership(runRoot)`:仅当该 runRoot 与当前 `this.ownership.runRoot` **精确相同**时才清除
   `runtime`/`ownership` 与已消耗的 failure 记录;判定规则抽成导出的纯函数 `ownsRun(ownership, runRoot)`。
2. `performStop` 成功回收(进程组为空且目录已删除)时调用 `dropRecord(runRoot)`,把同一次运行在
   `uncleanedRuns` 中的副本一并删除:否则会留下 `reaped:false` 的陈旧记录,`status` 继续失败,
   下一次扫描还会向可能已被复用的 PGID 发信号。
3. 扫描中若 `terminateTree` 确认进程组已空、但目录仍无法删除:记录**原地降级**为 cleanup-only
   (`reaped:true`、`pid:0`、`pgid:0`),此时可清除已确认回收的 matching ownership;
   状态仍为 `failed`/`unreclaimed`、`start()` 仍拒绝,下一次扫描只重试删目录,绝不再向旧 PGID 发信号。

**证据**(`packages/omp-runtime/src/supervisor-lifecycle.test.ts`,本轮新增 4 项):

- **A** “releases ownership when the sweep reclaims the retained run”:`stop()` 返回 `reaped:false` →
  注入的 `terminateTree` 成功 → 目录移除 → `pendingCleanup` 为空 → `status` = `stopped` → **可再次 `start()`**。
  **先失败后通过**:移除修复后失败(`expected 'failed' to be 'stopped'`)。
- **B** “a retried stop clears the record the sweep retained for it”:首次 `reclaimAll` 留下 matching live record 后,
  常规 `stop()` 重试回收成功 → `pendingCleanup` 1 → 0、`status` = `stopped`、
  后续 `reclaimAll` 不再调用 `terminateTree`(调用计数不变)。
  **先失败后通过**:回退 `dropRecord` 后失败(残留 `{reaped:false,pid:4242}`)。
- **C** “keeps the directory debt without signalling the emptied group again”:扫描确认进程组已空但目录删不掉 →
  记录降级为 `{reaped:true,pid:0,pgid:0}`、`status` 仍 `failed`/`unreclaimed`、`start()` 仍拒绝、
  下一次扫描 `terminateTree` 调用次数不增加;恢复权限后目录被清除、`terminateTree` 总调用次数仍为 1。
  **先失败后通过**:回退 `updateRecord`/`releaseOwnership` 后失败(记录仍为 `{reaped:false,pid:4242}`)。
- “releases ownership only for the run that was reclaimed”:`ownsRun` 对 matching / 非 matching / 空 ownership
  三种取值的精确匹配断言。说明:`status`/`start` 不变量不变的前提下,当前公开路径不可能同时存在
  “活体 ownership + 非 matching 记录”(启动会被未清理记录拒绝),故该精度规则以纯函数行为验证,
  而不是放宽产品不变量来构造场景。

**关于语义偏移的更正**:本轮中途曾把 cleanup-only 目录债务改为 `stopped` 并允许其存在时启动新 runtime,
与文件头不变式“cleanup failure is a failure … caller must never read stopped out of a run it could not reclaim”
及既有测试冲突,已按复审意见全部撤回;相关测试预期同时恢复为 `failed`/`unreclaimed`。

### 本轮验证结果

| 命令 | 结果 |
| --- | --- |
| `pnpm build:js` / `pnpm typecheck` | 12 包构建通过 / 0 错误 |
| `pnpm --filter @pi-desktop/omp-runtime test` | **7 文件 / 79 项通过**(本轮新增 4 项) |
| `pnpm --filter @pi-desktop/shared test` | 84 文件 / 968 项通过 |
| `cd apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs` | 2568 通过 / 0 失败 |
| `cd crates && cargo test -p host-core --locked` | 579 通过 / 0 失败 |
| `cd app/experiments/omp-bridge && node run-all.mjs` | 13/13 实验、413/413 检查、退出码 0 |
| 固定 OMP 无费用烟测 | M0 `verify-rpc.mjs` PASS;运行时包 `pinned-runtime.test.ts` 通过,未发送 prompt |
| 残留 | mock/OMP/Electron 进程 0、临时运行根 0、无 `~/.omp-desktop*`、子模块 SHA 未变、`git status --porcelain` 为空 |

## 11. 下一阶段条件

- T08-T10 的接口、路由、监督、身份与测试均已落地并通过上述命令;M3(端到端对话与工具执行)可在
  `packages/omp-runtime` 的传输与监督之上实现回合事件、工具卡片与审批问答。
- M3 必须先解决的两点:MCP 工具进入模型工具表(T19 归属)、子代理审批的桌面策略与进程树终止(T17/M5)。
