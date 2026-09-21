# OMP Desktop 开发交接

更新时间：2026-09-22。当前状态：**M0 开发基线（T01-T03）完成，原桌面可复现构建、开发数据已隔离、开发版 UI 基线已记录、OMP 隔离配置下无付费模型调用的协议启动已验证。下一阶段 M1（T04-T07）。**

## 1. 用户已确定的方向

- 基于 `vastsa/PI-Desktop` 实现 OMP 桌面端，界面和主要交互尽量保持一致。
- 按 `can1357/oh-my-pi` 的能力修改或增加功能。
- 由本轮模型负责规划，用户选择其他模型执行实现。
- 用户已有 NVM，使用 **`nvm use 24`**，不要重复安装 Node。

## 2. 已准备好

| 位置 | 内容 |
| --- | --- |
| `app/` | 本项目直接管理的产品源码，导入自 PI-Desktop 0.15.2 |
| `upstream/pi-desktop/` | PI-Desktop 原始源码子模块，固定基线提交 |
| `upstream/oh-my-pi/` | OMP 18.2.7 源码参考子模块，固定基线提交 |
| `docs/source-baseline.json` | 精确 SHA、工具版本与准备状态 |
| `docs/00-scope-and-decisions.md` | 范围和技术决策 |
| `docs/01-source-audit.md` | 本地源码入口、真实协议和兼容性边界 |
| `docs/02-target-architecture.md` | 目标架构、接口、会话和权限实现路径 |
| `docs/03-implementation-plan.md` | M0-M7 阶段计划与验收门 |
| `docs/04-task-board.md` | 24 个实现任务，当前全部待开始 |
| `docs/05-validation-and-release.md` | 测试矩阵、用户路径和发布验收 |
| `docs/06-executor-prompts.md` | 分阶段执行提示词 |
| `docs/07-environment-and-upstream.md` | 环境准备和上游维护 |
| `docs/validation/M0-baseline.md` | M0 验证记录（命令、版本、退出码、SHA、截图） |
| `docs/validation/M0-screenshots/` | M0 代表性界面基线截图（项目列表/设置/模型/扩展） |

PI-Desktop SHA：`0111e306c120ad5820688d7608cb37bad8fbcc1f`

OMP SHA：`d49918fab2dba3986927f2d46721629ed0f3a02c`

项目 GitHub 地址：`git@github.com:MisterBowie/omp-desktop.git`，主分支 `main`。根目录直接管理文档和 `app/`，上游参考采用固定提交的子模块。使用 `git clone --recurse-submodules` 或在克隆后运行 `git submodule update --init --recursive`。

首次规划的 `app/` worktree 结构已为 GitHub 交付调整；原始 worktree 仅在本机 `.local-worktrees/pi-desktop-baseline/` 保留，不是后续开发入口。`source-baseline.json` 中的初始化记录保持历史原样，当前布局以上述说明为准。

## 3. M0 已完成的工作

- 建立专用分支 `codex/m0-baseline` 与 worktree，初始化参考子模块到固定 SHA（pi-desktop `0111e306`、oh-my-pi `d49918fab`）。
- 准备并记录环境：Node 24、pnpm 10.34.5、Bun 1.4.2、rustc stable + nightly-2026-08-12、cmake/ninja。
- 原 PI-Desktop 按锁文件安装依赖并完成 `build:js`、typecheck、lint、host-core 构建与测试（`cargo test -p host-core` 577 通过）。
- 隔离开发数据/数据库/凭证/更新源（`PI_DESKTOP_DATA_DIR`）与全局 `.agents`（`PI_DESKTOP_AGENTS_DIR`），启动开发版，CDP 截取代表性界面基线。
- OMP `bun setup` 构建成功；`docs/validation/M0-rpc/verify-rpc.mjs` 绑定 `upstream/oh-my-pi` 内的启动器（repo 路径，非全局链接），核对 gitlink=submodule SHA 与版本 18.2.7，全量隔离（每次运行唯一的 `PI_CONFIG_DIR`/`PI_CODING_AGENT_DIR`/`OMP_DEV_LAUNCH_DIR`）下完成 `ready`/`negotiate_protocol`(v2)/`get_available_models` 协议启动，无付费模型调用；隔离路径为验收条件，流错误统一清理，默认无临时目录/进程残留。配套 `verify-rpc.test.mjs`（18 项假进程测试）+ fixture `models.yml` + `fake-omp.mjs`。
- 证据：`docs/validation/M0-baseline.md`（含顶部“返修记录”）与 `docs/validation/M0-screenshots/`；任务看板 T01-T03 已标记完成。

## 3.1 仍然没有做的工作

- 没有修改应用源码或 OMP 源码（M0 全部通过已有配置完成，未改产品代码；仅根 `.gitignore` 增加 `.dev-data/`）。
- 没有调用真实模型或付费 API（OMP 协议启动用 `auth: none` 的本地 mock 模型）。
- 没有创建 PR、发布安装包或部署产品，没有自动提交或推送。
- 没有证明两套运行时完整兼容；RPC 握手已实测，但 rpc-ui、审批、取消、恢复等实验属 M1。
- 没有做 macOS arm64 打包（本机为 Linux x64，与规划假设不同）。

## 4. 下一执行模型从哪里开始

**从 M1（T04-T07）开始，不直接改 Agent 引擎。**

M0 已完成并经四轮复审返修：原桌面可复现构建、开发数据与全局 `.agents` 隔离、UI 基线、OMP 协议启动（绑定 repo 内启动器、版本 18.2.7、`ready`/`negotiate_protocol` v2）均有记录（`docs/validation/M0-baseline.md`，顶部四段“返修记录”）。环境已就绪：Node 24、pnpm 10.34.5、Bun 1.4.2、桌面 Rust stable + OMP `nightly-2026-08-12`、cmake/ninja。复审结论以复审方为准。

M1 优先验证 rpc-ui + OMP 原有审批/受信扩展，验证不足才增加 SDK bridge。审批、取消和恢复实验通过前，不开放完整工具执行。OMP 运行环境隔离与协议验证已收口，M1 沿用 `docs/validation/M0-rpc/verify-rpc.mjs`（固定入口 + 全量隔离 + 分帧 + 进程组回收 + 隔离路径验收 + 流错误处理）与 `verify-rpc.test.mjs`（18 项假进程测试）。

## 5. 可直接交给执行模型

```text
打开 /home/vv/person/code/omp-desktop 作为整个工作区（M0 已完成）。

阅读 AGENTS.md、HANDOFF.md 和 docs 中的规划文档，以及 app/ 的适用规则。
本轮执行 M1（T04-T07），前置 M0 已完成（docs/validation/M0-baseline.md）。

环境已就绪：Node 24、pnpm 10.34.5、Bun 1.4.2（~/.bun/bin）、
桌面 Rust stable + OMP nightly-2026-08-12、cmake/ninja（pip 安装）。

依据 docs/01-source-audit.md 定位真实 RPC、SDK、扩展事件、host_tool_*、
子代理、会话恢复和配置发现入口，完成 E01-E09 实验。
使用隔离目录、本地 fake provider 和真实 OMP 内部工具链路验证；
优先验证 rpc-ui 加 OMP 原有审批 wrapper/受信扩展，证明拒绝发生在副作用之前。
普通 RPC 的交互提问不等于权限审批，set_host_tools 也不等于所有原生工具均受宿主控制。

根仓库管理 app/；upstream/ 是参考子模块。新任务按仓库规则创建专用分支和 worktree，
不修改参考子模块。不重写界面、不调用付费模型。

输出 docs/validation/M1-compatibility.md、docs/decisions/001-omp-transport.md，
更新任务看板和 HANDOFF.md。不要自动提交、推送或发布。
```

## 6. 下一轮必须保持的取舍

- 保留桌面 UI 和既有 Pi 行为，变更集中在运行时边界。
- 引擎 ID 与现有 `SessionSource` 分开；原生 Pi/远程会话不受新默认值误影响。
- OMP 原生工具和桌面宿主工具不是同一执行路径，权限覆盖需要证据。
- OMP 原生会话由 OMP 管理；桌面数据库仍归 Rust host-core，不做双重 transcript 写入。
- 使用结构化事件，复用已有协议/组件/测试；不解析终端输出，不预先设计多引擎大平台。
- 阶段失败如实记录，保持可回退的小范围变更，不将未运行验证标为通过。
