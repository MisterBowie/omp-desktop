# OMP Desktop 开发交接

更新时间：2026-09-21。当前状态：**规划及本地源码准备完成，产品实现尚未开始。**

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

PI-Desktop SHA：`0111e306c120ad5820688d7608cb37bad8fbcc1f`

OMP SHA：`d49918fab2dba3986927f2d46721629ed0f3a02c`

项目 GitHub 地址：`git@github.com:MisterBowie/omp-desktop.git`，主分支 `main`。根目录直接管理文档和 `app/`，上游参考采用固定提交的子模块。使用 `git clone --recurse-submodules` 或在克隆后运行 `git submodule update --init --recursive`。

首次规划的 `app/` worktree 结构已为 GitHub 交付调整；原始 worktree 仅在本机 `.local-worktrees/pi-desktop-baseline/` 保留，不是后续开发入口。`source-baseline.json` 中的初始化记录保持历史原样，当前布局以上述说明为准。

## 3. 没有做的工作

- 没有修改应用源码或 OMP 源码。
- 没有安装项目依赖、Bun 或 Rust，没有构建、启动应用或运行产品测试。
- 没有调用真实模型或付费 API。
- 用户已授权将源码与计划提交并推送到指定 GitHub；没有创建 PR、发布安装包或部署产品。
- 没有证明两套运行时已经兼容；静态源码结论与待实验事项已分开记录。

## 4. 下一执行模型从哪里开始

**从 M0（T01-T03）开始，不直接改 Agent 引擎。**

先加载根 AGENTS 和 `app/AGENTS.md`。确认 Git 状态后切换 Node 24；pnpm 按 10.34.5；桌面 Rust 稳定工具链与 OMP 固定 `nightly-2026-08-12` 分开管理。OMP 根要求 Bun >=1.4，不能只看 coding-agent 包级的 >=1.3.14。

M0 先证明原桌面和 OMP 基线可运行，并隔离数据与凭证。M1 优先验证 rpc-ui + OMP 原有审批/受信扩展，验证不足才增加 SDK bridge。审批、取消和恢复实验通过前，不开放完整工具执行。

## 5. 可直接交给执行模型

```text
打开 /Users/vv/Documents/对话/omp-desktop 作为整个工作区。

阅读 AGENTS.md、HANDOFF.md 和 docs 中的规划文档，以及 app/ 的适用规则。
本轮执行 M0（T01-T03），不要一次做完整项目。

我已有 NVM 和 Node 24，使用 nvm use 24。按锁定基线准备 pnpm、Bun、Rust，
证明原 PI-Desktop 能构建，并隔离开发数据、凭证存储和更新源。
OMP 只做隔离配置下的无费用协议启动，不调用真实付费模型。

根仓库管理 app/；upstream/ 是参考子模块。新任务按仓库规则在项目根
创建专用分支和 worktree，再进入其中的 app/ 开发，不修改参考子模块。

遵循 docs/03-implementation-plan.md 和 docs/05-validation-and-release.md，
将命令、结果及未完成项写入 docs/validation/M0-baseline.md，
更新 docs/04-task-board.md 与 HANDOFF.md。不要自动提交或发布。
```

## 6. 下一轮必须保持的取舍

- 保留桌面 UI 和既有 Pi 行为，变更集中在运行时边界。
- 引擎 ID 与现有 `SessionSource` 分开；原生 Pi/远程会话不受新默认值误影响。
- OMP 原生工具和桌面宿主工具不是同一执行路径，权限覆盖需要证据。
- OMP 原生会话由 OMP 管理；桌面数据库仍归 Rust host-core，不做双重 transcript 写入。
- 使用结构化事件，复用已有协议/组件/测试；不解析终端输出，不预先设计多引擎大平台。
- 阶段失败如实记录，保持可回退的小范围变更，不将未运行验证标为通过。
