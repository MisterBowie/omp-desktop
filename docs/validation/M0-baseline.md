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
