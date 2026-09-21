# 环境准备与上游维护

## 1. 工作区与仓库

工作区：`/Users/vv/Documents/对话/omp-desktop`

| 路径 | 内容 | Git 用途 |
| --- | --- | --- |
| `.` | 规划、执行状态和产品源码 | 用户自己的主仓库，origin 指向 MisterBowie/omp-desktop |
| `app/` | PI-Desktop 产品基线 | 直接跟踪在主仓库中，不是子模块 |
| `upstream/pi-desktop/` | PI-Desktop 原始源码 | 固定提交的参考子模块，不在这里开发产品 |
| `upstream/oh-my-pi/` | OMP 完整源码参考 | 固定提交的子模块，用于协议核验与实验 |

首次源码从官方仓库浅克隆。为推送到用户仓库，`app/` 已按固定 SHA 导入为正常源码目录，两个原始参考仓库登记为子模块，克隆会获取父仓库记录的精确提交。`source-baseline.json` 保留最初分析基线及初始化布局，当前布局以本文件为准。

根仓库 `origin` 为 `git@github.com:MisterBowie/omp-desktop.git`，主分支 `main`。本机最初的 app worktree 保留在被忽略的 `.local-worktrees/pi-desktop-baseline/`，不是后续产品开发入口。上游仓库不是用户推送目标。

克隆完整项目：

```bash
git clone --recurse-submodules git@github.com:MisterBowie/omp-desktop.git
cd omp-desktop
git submodule status
```

已经克隆但缺参考源码时，运行 `git submodule update --init --recursive`。子模块的 SHA 由主仓库固定，不使用 `--remote` 自动切换到最新版本。

## 2. 本机环境观察

| 项目 | 准备规划时的状态 | 实现时的动作 |
| --- | --- | --- |
| 系统 | Darwin arm64 | 首个目标为 macOS Apple Silicon |
| Git | 2.45.1 | 可用 |
| 默认 Node | v20.10.0 | 不使用该版本构建 |
| 已安装 Node | v24.14.0，可由 NVM 切换 | 用户已确认 `nvm use 24` |
| pnpm | 10.33.0 | app 要求 `pnpm@10.34.5`，按锁定版本准备 |
| Bun | 当前 PATH 与 `~/.bun/bin` 未发现 | OMP 根声明 >=1.4，包级 engines 为 >=1.3.14；源码构建取较严格根要求 |
| Rust | 当前 PATH 与 `~/.cargo/bin` 未发现 | 桌面稳定版；OMP 源码固定 `nightly-2026-08-12`，分别配置 |

本轮没有安装依赖、构建应用或执行模型推理。不要因为代码已经克隆就跳过 M0。

## 3. Node 24

在工作区根目录或 `app/` 中运行：

```bash
source "$HOME/.nvm/nvm.sh"
nvm use 24
node --version
```

根目录 `.nvmrc` 已写入 `24`。不需要再次安装 Node，不执行 `nvm alias default`。

本机已核对的可执行文件：`/Users/vv/.nvm/versions/node/v24.14.0/bin/node`。执行模型应通过 NVM 加载，避免把这一本机绝对路径写进产品脚本。

本地 shell 的 Node 版本与生产 OMP 运行时是两个问题。Electron 自带 Node，OMP 可能需要 Bun 和目标平台原生模块；`nvm use 24` 不会自动解决打包后的 OMP 运行环境。

## 4. PI-Desktop 基线启动

先读取 `app/AGENTS.md`、根 package.json 和 lockfile。下面是在依赖与 Rust 已准备好之后，从 `app/` 执行的上游启动路径：

```bash
nvm use 24
pnpm install --frozen-lockfile
cargo build -p host-core --locked
pnpm build:js
pnpm dev
```

上游根 `package.json` 声明的 pnpm 版本应作为实现环境的依据；不能仅因为本机有 pnpm 10 就忽略具体基线差异。

运行开发界面前，先检查其 userData/测试目录配置及更新代码。使用隔离路径，必要时先做 T03 的最小改动。不要直接打开可能写入用户 PI-Desktop 数据的实例。

## 5. OMP 基线启动

从 `upstream/oh-my-pi/` 读取其 AGENTS、package.json、安装脚本与原生模块说明。上游文档提供的源码流程是：

```bash
bun setup
bun dev -- --version
```

`bun setup` 会安装依赖并构建本地原生模块。OMP 根 `packageManager` 为 `bun@>=1.4`，Rust 使用仓库 `rust-toolchain.toml` 固定的 nightly-2026-08-12。包级 Bun engines 的较低值不能覆盖根源码构建要求。安装行为可能产生 lockfile 或生成文件变化，必须检查并区分预期生成结果，不能自动删除用户修改。

M1 的生产接入优先候选是锁定版本的 `omp --mode rpc-ui`；普通 rpc 用作对照。源码已确认 `PI_CODING_AGENT_DIR`、session-dir 和 profile 相关逻辑，从源码启动时仍需核对参数传递和各配置优先级，再写入实验脚本。不要将本工作区文档中的候选形式当作已测试的完整启动命令。

正常构建不应依赖这个参考仓库的相对目录。产品要使用锁定依赖或固定运行时产物；参考仓库只服务于核验与实验。

## 6. Git 日常操作

根仓库统一提交源码和计划，参考子模块只核对版本：

```bash
git status --short
git branch --show-current
git remote -v
git submodule status
git -C upstream/oh-my-pi status --short
```

新的独立开发请求在根仓库建立专用分支和 worktree，再进入其中的 `app/` 构建。不要在上游参考子模块中开发产品，也不要复用另一个正在执行的任务工作树。用户要求提交后，才暂存明确文件并提交。

本项目中的 `origin/main` 现在指用户仓库的集成基线。创建任务 worktree 的示例，需在当前目录无冲突且相应分支/路径尚不存在时执行：

```bash
git fetch origin main
git worktree add -b codex/m0-baseline ../omp-desktop-m0 origin/main
git -C ../omp-desktop-m0 submodule update --init --recursive
```

新工作树同时包含计划和 app，子模块需分别初始化。上游源码最初导入为 `app/` 快照，不能把上游根目录直接 merge 到本仓库根目录。

## 7. 网络问题与重新拉取

本次直接连接 GitHub 下载缓慢且一次 HTTP/2 中断；通过系统已经配置的 `127.0.0.1:7897` 代理完成重试。代理参数仅作用于单次命令，没有写入 Git 全局配置。

若同一台机器获取子模块遇到直连问题，并且该代理仍在运行，可以使用单次代理设置：

```bash
git -c http.proxy=http://127.0.0.1:7897 submodule update --init --recursive
```

不要删除已有开发目录后重克隆。其他机器应使用自己的网络配置，不能照搬本机代理端口。根仓库使用 SSH 地址，HTTP 代理配置只作用于 HTTPS 上游子模块下载。

参考子模块复现由父提交中的 gitlink 保证。初始源码 SHA 另外记录在 `source-baseline.json`。需要上游历史时在对应子模块核对实际远程名称，再按需 fetch deepen 或 unshallow；本机预先克隆的远程叫 `upstream`，Git 新初始化的子模块通常叫 `origin`。

## 8. 上游升级流程

1. 保存当前工作、检查状态，记录当前 app 与 OMP 版本。
2. 在单独升级 worktree 获取新上游，比较旧/新 SHA；先保留原子模块基线，不直接覆盖产品工作分支。
3. PI-Desktop 检查 shared DTO、sidecar、权限、会话库、插件协议和 UI 变更。
4. OMP 检查 RPC 类型、帧协议、工具结果、扩展钩子、会话格式和原生模块要求。
5. 重跑协议 fixtures、拒绝/取消、会话恢复与打包烟测。
6. PI-Desktop 的差异以 `app/` 为前缀应用并审阅冲突；通过验证后才更新参考子模块指针。记录新旧 SHA、验证结果和回退方式，更新产品锁定版本。

原生会话格式变化先备份再验证。版本回退不能简单等同于把可执行文件换回去，需要确认旧版本是否能读取新格式。
