# M0 开发基线验证记录

日期：2026-09-22
分支/工作树：`codex/m0-baseline` @ `/home/vv/person/code/omp-desktop-m0`（base `origin/main` = `a23bfb9`）
阶段：M0（T01-T03）+ OMP 协议启动（T04 前置）

> 本记录所有命令均为实际执行；未运行或未通过的验证已明确标注，未标记为通过。

## 返修记录（复审，2026-09-22）

对提交 `44441d2` 的复审发现 6 项问题，本轮逐项修复并重验；旧验证的历史事实保留在正文，更正与新增证据如下：

1. **OMP 版本**（5.2 更正）：原记录误用 `command -v omp` 命中的 `/home/vv/.local/bin/omp`（用户自行安装的已编译 18.2.6 二进制）。固定源码入口是 `~/.bun/bin/omp` → `upstream/oh-my-pi/packages/coding-agent/scripts/omp` → `bun src/cli.ts`，版本来自 `packages/utils/package.json` = **18.2.7**；`~/.bun/bin/omp --version` 实测 `omp/18.2.7`。
2. **OMP 运行环境隔离**（5.4 完成）：原运行触碰 `~/.omp/agent/agent.db` 的 WAL/SHM。返修后同时设 `PI_CONFIG_DIR=.omp-m0-dev`、`PI_CODING_AGENT_DIR=<worktree>/.dev-data/omp-dev/agent`、`OMP_DEV_LAUNCH_DIR=<worktree>/.dev-data/omp-dev/dev-cwd`，三处全部离开 `~/.omp`；`~/.omp` 零写入，未迁移/删除用户数据。
3. **桌面全局配置隔离**（4.2 完成）：`PI_DESKTOP_DATA_DIR` 不覆盖 `~/.agents`。设 `PI_DESKTOP_AGENTS_DIR=<worktree>/.dev-data/agents`（Rust `global_agents_dir()` 读取），MCP 页仅显示受控 fixture `m0-test`，真实用户 3 台 MCP 服务器未加载。
4. **可复现材料**（新增）：`docs/validation/M0-rpc/verify-rpc.mjs`（环境/请求序列/断言/超时/清理）+ `docs/validation/M0-rpc/models.yml`（mock fixture），`node …/verify-rpc.mjs` 退出码 0。
5. **模型设置页**（4.3 更新）：`02-settings-models.png` 已重拍为真实“模型配置”页（默认模型/生图模型/AI 服务/厂商账户，无 AI 服务）；`02-settings.png` 重拍为隔离后的 MCP 页（仅 fixture）。
6. **测试表述**（3.1 修正）：单文件 14 项通过不再当作完整套件通过；完整 desktop 套件 `env -u SSH_ASKPASS node --test test/*.test.mjs` 实测 2523 项 / 2519 通过 / 0 失败 / 4 跳过（退出码 0）。

## 返修记录（第二轮复审，2026-09-22）

对提交 `f3ed7f3` 的第二轮复审针对 `verify-rpc.mjs` 提出 6 项问题，本轮重写脚本并补充假进程测试；历史事实保留，新增证据如下：

1. **运行环境隔离**（一）：脚本不再 `...process.env` 直接继承。`buildIsolatedEnv` 显式剔除 `OMP_PROFILE`/`PI_PROFILE`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`/`XDG_CONFIG_HOME`/`PI_CODING_AGENT_SESSION_DIR` 及凭据类变量，再显式设 `PI_CONFIG_DIR`（每次运行唯一 `~/.omp-m0-<hex>`）、`PI_CODING_AGENT_DIR`、`OMP_DEV_LAUNCH_DIR`。隔离目录每次运行唯一（`mkdtemp`），并发/跨 worktree 不共享状态；运行后 `verifyResolvedPaths` 核对 `agent.db`/`models.db`/`sessions`/`logs`/`run` 均落在隔离目录并打印。
2. **进程清理**（二）：`terminateTree` 以 `detached` 启动子进程为进程组，SIGTERM 整组 → 等待退出 → 超时 SIGKILL → 确认回收后才返回；成功、断言失败、超时、启动失败与异常路径统一走该清理，`runProtocolCheck` 绝不 reject。`signalCode=SIGKILL` 与 `isAlive(pid)=false` 断言覆盖“子进程忽略 SIGTERM 被强制回收”场景。
3. **stdout 分帧**（三）：改用 `readline` 按完整行解析，逐行 `JSON.parse`（非 JSON 行忽略），按解析后的 `type`/`command`/`id`/`success` 匹配响应，不再用字符串 `includes`。
4. **固定源码入口**（四）：`findPinnedLauncher` 定位 `upstream/oh-my-pi/packages/coding-agent/scripts/omp`（repo 路径，不依赖全局 `~/.bun/bin/omp` 链接）；`verifyPinnedSource` 用 `git ls-tree HEAD` 取 gitlink、`git -C … rev-parse HEAD` 取实际 SHA 比对，并以启动器 `--version` 与 `packages/utils/package.json` 版本（18.2.7）比对，不一致即失败退出。未修改用户全局 OMP 链接或参考源码。
5. **针对性验证**（五）：新增 `verify-rpc.test.mjs`（node:test，9 项）与 `fake-omp.mjs` 假进程，覆盖：正常传输、分段/合并/UTF-8 跨块重组、错误响应非零退出、启动失败非零退出、超时非零退出、忽略 SIGTERM 强制回收、profile/XDG/凭据剥离、入口绑定、缺失/不一致失败。测试不调用真实模型、不读取或输出用户密钥。
6. **交付表述**（六）：看板“全通过”明确为 desktop 包套件（`apps/desktop`）通过；未重跑完整 workspace 套件前不写“workspace 全通过”。HANDOFF 不写“复审通过”。

本轮实际执行（`docs/validation/M0-rpc/` 下）：

```bash
node --test docs/validation/M0-rpc/verify-rpc.test.mjs   # 9 tests, 9 pass, 0 fail (exit 0)
node docs/validation/M0-rpc/verify-rpc.mjs               # PASS: ready + negotiate v2 + models (exit 0)
```

真实运行关键输出：launcher 为 repo 路径、gitlink=submodule SHA=`d49918fab…`、pinned ver 18.2.7（reported 18.2.7）、config root `~/.omp-m0-<hex>`、resolved 全部 `=true`、`ready`/`negotiate_protocol(v2)`/`get_available_models` 均通过。

## 返修记录（第三轮复审，2026-09-22）

对提交 `a2ce8bf` 的复审针对 `verify-rpc.mjs` 提出 4 项问题 + 临时目录清理遗漏。本轮先补失败测试复现，再修复：

1. **首次运行**（一）：原 `main()` 在 `.dev-data` 不存在时直接 `mkdtempSync` → ENOENT。新增 `prepareRunRoot(baseDir)` 先 `mkdirSync(base,{recursive:true})` 再建 run root；新增测试 `first run: run root is created even when its parent dir is missing`，并在移除 `.dev-data` 的干净工作树上实测脚本退出码 0。
2. **统一异常清理**（二）：`runProtocolCheck` 改为单 try/catch/finally 覆盖整个生命周期，成功/断言失败/解析异常/流错误/超时/启动失败均经同一 `finally` 回收；响应结构用 `Array.isArray` 校验（不再 `.map` 直接抛）。复现场景（`success:true, data.models:{}`）在旧实现抛 `TypeError: … .map is not a function` 且子进程存活，修复后返回明确失败并回收子进程。
3. **完整回收进程组**（三）：`terminateTree` 不再以直接子进程退出为结束条件——SIGTERM 整组 → 等直接子进程 → 等进程组清空（`process.kill(-pgid,0)`）→ 超时 SIGKILL 整组 → 再等清空，仅在组清空时返回 `true`；清理失败时 `runProtocolCheck` 置 `ok=false`、`reaped=false`。复现场景（同组孙进程忽略 SIGTERM、父进程正常退出）在旧实现遗留孙进程，修复后被 SIGKILL 回收。只对本次 `detached` 创建的组发信号（`-child.pid`），不误杀其他进程。
4. **隔离路径验收条件**（四）：`verifyResolvedPaths` 拆出 required（`agent.db`/`models.db`/`sessions`）与 optional（`logs`/`run`/`launch`），并校验 scope（agent/launch 在 run root 内、config root 非 `~/.omp` 且名为 `.omp-m0-*`）；`ok = required && scope`。`main()` 在 `!paths.ok` 时非零退出，不再仅凭 `leaksIntoUserHome` 判断。
5. **临时目录回收**（五）：`verifyPinnedSource` 的版本探测目录（`omp-ver-*`）与探测用 config root 在 `finally` 回收；`main()` 用 try/finally 在成功/失败/异常路径统一回收本次 run root 与 config root；`--keep` 明确为保留本次 run root + config root（仅限本次创建），默认不留临时目录。只清理本次运行创建且拥有的目录。

测试先行证据（旧实现 → 修复后）：

```bash
# 修复前（a2ce8bf）：15 tests, 9 pass, 6 fail
#   失败含 TypeError: ((intermediate value) ?? []).map is not a function
#   并遗留 1 个 fake-omp 子进程与 3 个 /tmp/omp-ver-* 目录
node --test docs/validation/M0-rpc/verify-rpc.test.mjs
# 修复后：15 tests, 15 pass, 0 fail
node --test docs/validation/M0-rpc/verify-rpc.test.mjs
node docs/validation/M0-rpc/verify-rpc.mjs                      # exit 0
rm -rf .dev-data && node docs/validation/M0-rpc/verify-rpc.mjs  # clean tree, exit 0
```

## 返修记录（第四轮复审，2026-09-22）

对提交 `1385b85` 的复审提出 2 项问题，本轮集中修复测试与流错误处理（先复现、后修复）：

1. **环境恢复测试与凭据日志泄漏**（一）：旧断言 `assert.equal(process.env.OMP_PROFILE/OPENAI_API_KEY, undefined)` 假定恢复后必为 undefined——用户原本设置这些变量时既误报失败，又把真实值打印进失败日志。复现：`env -u OMP_PROFILE OPENAI_API_KEY=m0-review-not-secret node --test --test-name-pattern='env isolation' <旧测试文件>` → `actual: 'm0-review-not-secret'`。修复：`withEnv` 按“原本存在/不存在”保存与恢复；断言改为 `hasOwnProperty` 的布尔比较，失败信息不含值；新增 `env restore probe` 与两个子进程包装测试（原变量不存在 / 原变量已有值，均用合成值）。测试不做 `process.env` 序列化，不读取或打印真实凭据。
2. **管道错误绕过统一清理**（二）：旧实现只监听 `ChildProcess` 的 `error`，未处理 stdin/stdout/stderr/readline 的异步 `error`；子进程关闭 stdin 后写入 `negotiate_protocol` 触发未处理 EPIPE（复现：`Error: write EPIPE`），外层 try/catch 无法捕获。修复：在使用流之前安装各流 error 处理；新增守卫写入 `writeCommand`，写入失败记为流错误；`waitFor` 遇到流错误立即返回；失败原因携带流错误；仍经统一 `finally` 有界回收进程组，不用全局 `uncaughtException`，也不吞错报成功。

本轮实际执行（`docs/validation/M0-rpc/`，运行目录 `app` 之外）：

```bash
# 复现（旧实现）
env -u OMP_PROFILE OPENAI_API_KEY=m0-review-not-secret \
  node --test --test-name-pattern='env isolation' <旧测试>   # fail，并打印该假值
node --test --test-name-pattern='stream error' verify-rpc.test.mjs  # fail: Error: write EPIPE
# 修复后
env -u OMP_PROFILE OMP_PROFILE=m0-review-profile OPENAI_API_KEY=m0-review-not-secret \
  node --test verify-rpc.test.mjs        # 18 tests, 18 pass, 0 fail (exit 0)
node docs/validation/M0-rpc/verify-rpc.mjs  # exit 0
```

修复后套件输出中出现 `m0-review-not-secret` / `m0-review-profile` 次数为 **0**（无凭据泄漏）；默认运行无临时目录与进程残留。

## 1. 环境与版本

| 项目 | 版本/事实 | 说明 |
| --- | --- | --- |
| 系统 | Linux x86_64，Ubuntu 24.04.4 LTS，内核 7.0.0-31-generic | 与规划文档假设的 macOS arm64 不同；本机为 Linux x64 |
| CPU/内存 | Intel Core i5-14600KF，20 核，31 GiB RAM，NVIDIA GTX 1080 Ti | |
| Node | v24.14.0（NVM 管理，`nvm use 24`） | 未改全局默认版本 |
| pnpm | 10.34.5（corepack 按 `packageManager` 拉取） | app 锁定版本 |
| Bun | 1.4.2（`~/.bun/bin/bun`） | 满足 OMP 根要求 `bun@>=1.4` |
| rustc（桌面稳定） | 1.95.0 (59807616e 2026-04-14) | host-core 构建 |
| rustc（OMP nightly） | 1.99.0-nightly (3d6c19bb9 2026-08-11)，工具链 `nightly-2026-08-12` | OMP `rust-toolchain.toml` 固定 |
| cmake / ninja | 4.4.3 / 1.13.2（`pip install cmake ninja` 安装） | OMP 原生模块 `opusic-sys` 构建需要 |
| Electron | 43.6.0 | 见 2.3 网络说明 |

参考源码 SHA（已在工作树核实）：

| 仓库 | 固定 SHA | 文件数 |
| --- | --- | --- |
| `upstream/pi-desktop` | `0111e306c120ad5820688d7608cb37bad8fbcc1f` | 2093 |
| `upstream/oh-my-pi` | `d49918fab2dba3986927f2d46721629ed0f3a02c` | 7518 |

`git submodule status` 显示两个子模块均为空格前缀（与 gitlink 一致）。子模块初始化采用 `git fetch --depth 1 origin <sha>` 手动浅取到固定提交；默认 `git submodule update` 对 `shallow = true` 子模块会先浅克隆到 `heads/main`，再为固定提交做全量历史 fetch（本机代理下会停滞），故改为逐提交浅取。

## 2. 环境准备（T01）

### 2.1 网络与代理

- 系统代理 `127.0.0.1:7897` 已在环境变量中（`HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`）。
- 现象：npm registry（`registry.npmjs.org`）直连与代理均快（~760 KB/s）；GitHub releases 经代理被限速（约 14 KB/s）并间歇停滞；`git fetch` 全量历史与 bun 并发下载会停滞。
- 处置：
  - Electron 二进制改从 `https://npmmirror.com/mirrors/electron/` 下载（127 MB，~15 s），解压到 `app/node_modules/electron/dist/` 并写 `path.txt`。
  - Bun 二进制改从 `registry.npmjs.org/@oven/bun-linux-x64/-/bun-linux-x64-1.4.2.tgz` 下载解压到 `~/.bun/bin/`（`bun.sh/install` 的 GitHub 下载被限速，`npm i -g bun` 的 postinstall 因二进制损坏反复重试，最终以 registry tarball 直取解决）。

### 2.2 环境命令与结果

```bash
source "$HOME/.nvm/nvm.sh"; nvm use 24      # node v24.14.0
corepack enable                               # pnpm shim
# app/ 下运行 pnpm，corepack 按 packageManager 拉取 10.34.5
rustup toolchain install nightly-2026-08-12 --profile minimal
pip install cmake ninja                       # cmake 4.4.3 / ninja 1.13.2
```

均成功（退出码 0）。

## 3. 原 PI-Desktop 构建与测试基线（T02）

从 `app/` 执行（先 `nvm use 24`）：

| 命令 | 结果 | 退出码 | 关键输出 |
| --- | --- | --- | --- |
| `pnpm install --frozen-lockfile` | 成功 | 0 | `Done in 3m 54.1s using pnpm v10.34.5`；node-pty 原生编译、electron-builder install-app-deps 完成 |
| `pnpm build:js` | 成功 | 0 | 所有 workspace 包构建；desktop renderer `✓ built in 5.70s`（chunk 体积告警为警告） |
| `pnpm --filter @pi-desktop/desktop typecheck` | 成功 | 0 | `tsc -p tsconfig.json --noEmit` |
| `pnpm lint` | 成功 | 0 | biome `Checked 75 files`；desktop `style tokens OK` |
| `cargo build -p host-core --locked` | 成功 | 0 | `Finished dev profile [unoptimized + debuginfo] target(s) in 1m 39s`；产物 `target/debug/pi-desktop-host-core` |
| `cargo test -p host-core --locked` | 通过 | 0 | `577 passed; 0 failed; 0 ignored`（54.47 s） |
| `cargo fmt --check` | 通过 | 0 | 无输出 |
| `pnpm -r --if-present test` | 1 项失败 | 1 | 见 3.1 |

### 3.1 原始测试失败（环境导致，非本次适配回归）

失败用例：`apps/desktop/test/remote-host-ssh-password.test.mjs` — “a key-authenticated transport is handed no askpass material”，断言 `HAS_ASKPASS === ""`，实际为 `"set"`。

根因：本机 shell 环境预设 `SSH_ASKPASS=/usr/bin/false`，测试的 SSH 传输 fixture 从父环境继承了该变量。复现与证明：

```bash
# 完整 desktop 包测试套件（默认环境，1 项失败）
pnpm --filter @pi-desktop/desktop test   # 2523 tests, 2518 pass, 1 fail, 4 skipped
# 完整 desktop 包测试套件（去掉 SSH_ASKPASS 后重跑）
env -u SSH_ASKPASS node --test test/*.test.mjs  # 2523 tests, 2519 pass, 0 fail, 4 skipped (exit 0)
```

结论：该失败为上游既有、受本机环境变量触发的用例，未改动源码，不计为适配回归。验证范围如实标注：完整 desktop 包测试套件（2523 项）在 `env -u SSH_ASKPASS` 下全通过（2519 通过 / 0 失败 / 4 跳过）；`pnpm -r --if-present test` 因 desktop 包失败而中断，其余 workspace 包的测试未在本轮重跑（仅 desktop 包重跑并记录）。

## 4. 开发数据/凭证/更新源隔离与 UI 基线（T03）

### 4.1 隔离机制

- 通过已有配置隔离，未改产品源码：启动开发版时设置 `PI_DESKTOP_DATA_DIR=/home/vv/person/code/omp-desktop-m0/.dev-data/pi-desktop`（该目录已加入根 `.gitignore`）。
- 数据目录解析（`apps/desktop/electron/main/data-paths.ts`）：`PI_DESKTOP_DATA_DIR` 显式覆盖一切；开发 profile 默认 `~/.pi-desktop-dev`，出厂 `~/.pi-desktop`。
- Electron `userData`（`applyDevelopmentUserData`）开发构建使用 `${APP_NAME} Dev`（即 `~/.config/PI-Desktop Dev`），与出厂 `~/.config/PI-Desktop` 分开。

### 4.2 隔离验证结果

| 项 | 位置 | 证据 |
| --- | --- | --- |
| 数据库 | `.dev-data/pi-desktop/pi.sqlite`（含 `-wal`/`-shm`） | 由开发版创建 |
| 凭证存储 | `.dev-data/pi-desktop/secrets/.machine-key`（加密 secret store） | 由开发版创建 |
| 日志/插件/窗口态 | `.dev-data/pi-desktop/{logs,plugins,window-state.json,crash-dumps,cache,scratch}` | 由开发版创建 |
| Electron userData | `~/.config/PI-Desktop Dev` | 进程参数 `--user-data-dir=...PI-Desktop Dev` |
| 全局 `.agents`（MCP/技能/子代理） | `PI_DESKTOP_AGENTS_DIR=/…/.dev-data/agents` | 见返修记录第 3 项；MCP 页仅显示受控 fixture `m0-test`，真实用户的 3 台 MCP 服务器未加载 |
| 用户既有数据 | `~/.pi-desktop`（2026-09-21 22:05 起存在） | `find ~/.pi-desktop -newermt "2026-09-22 00:00"` 为空 → 本次运行零写入 |
| 更新源 | dev（unpackaged）构建 `resolveUpdateMode` 返回 `"disabled"` | 源码 `apps/desktop/electron/main/updater.ts`；dev 无 `app-update.yml`，不自动更新 |

`RELEASES_URL` 常量仍指向 `https://github.com/vastsa/PI-Desktop/releases/latest`，仅打包构建使用；应用改名与发布源切换属 M6，本阶段未改。

### 4.3 开发版启动与代表性 UI 基线

启动命令（隔离 + 关闭沙箱 + 开 CDP）：

```bash
NO_SANDBOX=1 REMOTE_DEBUGGING_PORT=9222 \
PI_DESKTOP_DATA_DIR=/home/vv/person/code/omp-desktop-m0/.dev-data/pi-desktop \
PI_DESKTOP_AGENTS_DIR=/home/vv/person/code/omp-desktop-m0/.dev-data/agents \
pnpm dev
```

说明：本机为非 root 用户且 `kernel.apparmor_restrict_unprivileged_userns=1`，`chrome-sandbox` 无法 chown 4755，故用 `NO_SANDBOX=1`（electron-vite 据此加 `--no-sandbox`）以启动开发版；仅影响开发基线，非生产安全姿态。

结果：Electron 43.6.0 窗口启动，renderer 位于 `http://localhost:5173/`，标题 `PI-Desktop`（v0.15.2）。经 CDP 截取代表性界面，存于 `docs/validation/M0-screenshots/`：

| 文件 | 界面 | 核对要点 |
| --- | --- | --- |
| `01-project-list-onboarding.png` | 项目列表 + 引导 | 侧栏“会话/项目”，项目 `apps`，引导卡“添加 AI 模型服务/保存 API 密钥/打开项目文件夹/发送第一条消息” |
| `02-settings.png` | 设置 → MCP | 侧栏“偏好/常规/AI/快捷键/智能体/指令/模型/技能/MCP/子智能体/工作区/导入/项目/系统/信息”；MCP 全局 1 项（受控 fixture `m0-test`）、项目 0 项，真实用户服务器未加载 |
| `02-settings-models.png` | 设置 → 模型配置 | “模型配置”页：默认模型/生图模型/AI 服务/厂商账户，显示“还没有 AI 服务”、内置目录 7865 个模型 |
| `03-extensions.png` | 扩展 | 已安装 2 个内置插件（`pi.file-manager` v0.5.2、`pi.browser` v1.0.0），1 个可更新 |
| `04-main-after-settings.png` | 主界面 | 返回应用后的主视图 |

界面尺寸：窗口 1200×800（截图原始分辨率），侧栏/主区/引导卡布局完整。

## 5. OMP 隔离配置下的协议启动（T04 前置验证）

### 5.1 OMP 构建（`bun setup`）

```bash
# 完整 PATH（含 ~/.cargo/bin 与 ~/.pyenv/shims，供 cargo/cmake/ninja）
bun setup   # scripts/setup.ts: bun install → build:native → coding-agent link → link omp
```

结果（退出码 0）：

- `bun install`：595 packages 解析，438 installs（首次因代理停滞分两段完成，缓存复用后 141.84 s）。
- `build:native`：`pi_natives.linux-x64-modern.node` 构建成功（`Finished local profile [optimized] target(s) in 1m 42s`）。
- `link omp`：`~/.bun/bin/omp -> packages/coding-agent/scripts/omp`。

过程中发现并记录：首次 `build:native` 因 PATH 缺 `~/.cargo/bin` 报 `cargo metadata failed`；补 PATH 后因缺 `cmake` 报 `opusic-sys` 构建失败；`pip install cmake ninja` 后通过。OMP 原生模块构建对系统 `cmake`/`ninja` 的依赖未在上游文档显式列出。

### 5.2 版本（返修更正）

- 固定源码 CLI 版本来自 `packages/utils/package.json`（`dirs.ts` 中 `import { version } from "../package.json"` → `VERSION`），为 **18.2.7**。
- `command -v omp` → `/home/vv/.local/bin/omp`（用户自行安装的已编译 18.2.6 二进制，2026-09-20 23:09），不是固定源码入口。原记录误用了该二进制，把版本记成 18.2.6。
- 固定源码入口：`~/.bun/bin/omp` → `upstream/oh-my-pi/packages/coding-agent/scripts/omp`（`bun setup` 的 `link omp` 建立）→ `bun src/cli.ts`。
- 用源码入口重跑：`PATH="$HOME/.bun/bin:…" ~/.bun/bin/omp --version` → `omp/18.2.7`（与 pi-utils/package.json 一致）。

### 5.3 隔离配置下的协议启动（无付费模型调用）

隔离方式（返修后，全量隔离，见 5.4）：可复现脚本 `docs/validation/M0-rpc/verify-rpc.mjs` + fixture `docs/validation/M0-rpc/models.yml`。脚本 spawn 固定源码入口 `~/.bun/bin/omp --mode rpc --model m0mock/local-model`，设置 `PI_CONFIG_DIR=.omp-m0-dev`、`PI_CODING_AGENT_DIR=<worktree>/.dev-data/omp-dev/agent`、`OMP_DEV_LAUNCH_DIR=<worktree>/.dev-data/omp-dev/dev-cwd`，读 `ready`、写 `negotiate_protocol`、断言响应后 SIGTERM。fixture 声明 `auth: none`、`baseUrl: http://127.0.0.1:9`（不可达）的本地 mock 模型，使 `session.model` 成立而不触发任何付费/网络模型调用。

运行（退出码 0，`PASS: ready + negotiate_protocol(v2) + get_available_models`）：

```bash
node docs/validation/M0-rpc/verify-rpc.mjs
```

关键 stdout 帧（脱敏样本，无密钥/凭证）：

```json
{"type":"ready","protocolVersion":1,"supportedProtocolVersions":[1,2],"maxFrameBytes":1048576,"maxReassembledFrameBytes":67108864}
{"id":"m0","type":"response","command":"negotiate_protocol","success":true,"data":{"protocolVersion":2}}
{"id":"m1","type":"response","command":"get_available_models","success":true,"data":{"models":[{"id":"local-model","name":"local-model","api":"openai-completions","provider":"m0mock","baseUrl":"http://127.0.0.1:9","reasoning":false,"input":["text"],"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0},"contextWindow":32000}]}}
```

结论：

- `ready` 握手（protocolVersion 1，supported [1,2]，帧上限 1048576/67108864）已实测。
- `negotiate_protocol` 协商到 v2 成功。
- `get_available_models` 返回隔离目录内的 mock 模型，未访问真实提供商。
- 全程未设置任何 API key、未发送 `prompt`，未产生付费模型调用；模型 baseUrl 指向不可达 localhost，无外呼。

### 5.4 OMP 运行环境隔离（返修完成）

原运行只设 `PI_CODING_AGENT_DIR`，触碰到用户真实 `~/.omp`（`~/.omp/agent/agent.db` 的 WAL/SHM、`~/.omp/natives`、`~/.omp/run/daemons`、`~/.omp/puppeteer`、`~/.omp/.dev-cwd`）。返修后同时设置三个环境变量，全部重定向离开 `~/.omp`：

| 目录 | 环境变量 | 返修后位置 |
| --- | --- | --- |
| 配置根（natives/run/daemons/puppeteer/logs） | `PI_CONFIG_DIR=.omp-m0-dev` | `~/.omp-m0-dev/` |
| agent 数据（agent.db/models.db/sessions/config） | `PI_CODING_AGENT_DIR` | `<worktree>/.dev-data/omp-dev/agent/` |
| 启动目录（源码启动器默认 `~/.omp/.dev-cwd`） | `OMP_DEV_LAUNCH_DIR` | `<worktree>/.dev-data/omp-dev/dev-cwd/` |

验证：`verify-rpc.mjs` 运行后，`~/.omp-m0-dev` 与 `.dev-data/omp-dev/` 由本次创建（时间戳 01:01），`agent.db`/`models.db`/`sessions`/`models.yml` 均落在隔离 agent 目录；`~/.omp` 未被本次运行写入。未迁移、删除或清理用户真实 `~/.omp` 数据。

注意：源码启动器 `scripts/omp` 即使只跑 `--version` 也会创建默认 `~/.omp/.dev-cwd`（除非设 `OMP_DEV_LAUNCH_DIR`）；因此所有源码入口调用都必须带上三个隔离变量。

## 6. 未完成项与剩余风险

1. 原 PI-Desktop 1 个上游测试因本机 `SSH_ASKPASS` 环境变量失败（非回归，`env -u SSH_ASKPASS` 后完整 desktop 套件全通过，见 3.1）。
2. OMP 原生模块构建对 `cmake`/`ninja` 的依赖未在上游文档显式列出（已在本机补齐）。
3. 未做 Rust `cargo clippy`（M0 基线以 build/test/fmt 为准，clippy 属宿主行为变更时才需，本阶段未改 host-core 源码）。
4. 平台差异：本机为 Linux x64，与规划文档假设的 macOS arm64 不同；macOS 打包与安装产物（M6）未验证。

（返修已收口：OMP 配置根隔离与版本字符串两项均已解决，见 5.2/5.4。）

## 7. 下一阶段入口

M1（T04-T07）：以本基线记录的环境（Node 24 / pnpm 10.34.5 / Bun 1.4.2 / nightly-2026-08-12 / cmake+ninja）继续；M1 复用 `docs/validation/M0-rpc/verify-rpc.mjs` 已验证的 RPC 握手（固定源码入口 + 全量隔离），验证 rpc-ui + OMP 原有审批 wrapper/受信扩展（E01-E09）。
