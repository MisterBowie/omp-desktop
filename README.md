# OMP Desktop 项目工作区

目标：以 `vastsa/PI-Desktop` 为桌面产品基线，保留其界面和主要交互，接入 `can1357/oh-my-pi` 的 Agent 能力，再按需求增加或修改功能。

本工作区交付的是 **源码基线、实施规划和模型执行说明**。尚未实现 OMP 接入，不能将当前 `app/` 当作已经可用的 OMP Desktop。

项目仓库：[MisterBowie/omp-desktop](https://github.com/MisterBowie/omp-desktop)。克隆完整项目：

```bash
git clone --recurse-submodules git@github.com:MisterBowie/omp-desktop.git
cd omp-desktop
nvm use 24
```

已有克隆可运行 `git submodule update --init --recursive` 获取固定版本的上游参考源码。

## 从这里开始

1. 阅读 [HANDOFF.md](HANDOFF.md)，其中有可以直接交给执行模型的首轮任务。
2. 阅读 [项目范围与决策](docs/00-scope-and-decisions.md)。
3. 按 [实施计划](docs/03-implementation-plan.md) 和 [任务看板](docs/04-task-board.md) 逐阶段执行。
4. 通过 [验收规范](docs/05-validation-and-release.md) 留下证据，再推进下一阶段。

## 目录

```text
omp-desktop/
  README.md                 项目入口
  AGENTS.md                 执行模型必须遵守的工作约定
  HANDOFF.md                交接状态和首轮执行提示词
  .nvmrc                    Node 24
  docs/
    00-scope-and-decisions.md
    01-source-audit.md
    02-target-architecture.md
    03-implementation-plan.md
    04-task-board.md
    05-validation-and-release.md
    06-executor-prompts.md
    07-environment-and-upstream.md
    source-baseline.json     实际拉取的提交和版本
  app/                      本仓库直接管理的桌面产品源码
  upstream/pi-desktop/       PI-Desktop 原始基线子模块
  upstream/oh-my-pi/         OMP 源码参考子模块
```

根目录统一管理规划文档和 `app/` 源码；`app/` 不是子模块，也不再是上游仓库的 worktree。两个 `upstream/` 子模块固定到分析时的提交，供核对和实验使用。`app/` 首次导入保留了 PI-Desktop 的完整源码、许可证和版权，导入基线见 `docs/source-baseline.json`。

本机最初准备的开发 worktree 已保留到 `.local-worktrees/pi-desktop-baseline/`，它被忽略且不上传。新的开发任务应在本项目仓库创建专用分支和 worktree，再进入其中的 `app/` 构建。

## 当前默认选择

- 首个验证平台：本机 macOS Apple Silicon。
- Node：使用现有 NVM，执行 `nvm use 24`，不重复安装。
- 产品路线：fork PI-Desktop + 独立 OMP 适配层。
- 运行时首选验证路径：OMP 独立进程及 `rpc-ui`，结合已有审批机制和受信扩展；是否需要 SDK 桥接由实验决定。
- 旧 Pi 引擎先保留作为对照；未经能力验证的功能不宣称支持。
- 不在本轮安装依赖、调用付费模型、修改应用功能或发布产品。

## 文档导航

| 文档 | 用途 |
| --- | --- |
| [范围与决策](docs/00-scope-and-decisions.md) | 目标、非目标、取舍和待验证事项 |
| [源码核对](docs/01-source-audit.md) | 真实文件位置、已确认接口和兼容风险 |
| [目标架构](docs/02-target-architecture.md) | 进程、数据、权限、会话和事件设计 |
| [实施计划](docs/03-implementation-plan.md) | 阶段依赖、交付物和退出条件 |
| [任务看板](docs/04-task-board.md) | 可直接分配给模型的任务及状态 |
| [验收与发布](docs/05-validation-and-release.md) | 测试矩阵、故障场景和打包要求 |
| [执行提示词](docs/06-executor-prompts.md) | 分阶段任务指令和完成报告模板 |
| [环境与上游](docs/07-environment-and-upstream.md) | 启动准备、版本固定、Git 和上游更新方法 |

文档中的“拟新增”路径是设计建议，不代表当前已有实现。最终以锁定提交的源码和验证记录为准。

`app/` 的上游代码遵循 [LGPL-3.0](app/LICENSE)，OMP 主项目遵循其 [MIT 许可证](upstream/oh-my-pi/LICENSE)，第三方组件另有声明。仓库上传不代表已完成 OMP 接入或产品发布。
