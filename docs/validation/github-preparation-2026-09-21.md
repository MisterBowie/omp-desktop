# GitHub 交付准备记录

用户指定仓库：`git@github.com:MisterBowie/omp-desktop.git`。准备时通过 `git ls-remote` 确认远程没有已有引用，无需覆盖任何远程分支。

## 仓库布局

- 根仓库直接跟踪规划文档与 `app/` 完整桌面源码。
- `upstream/pi-desktop` 与 `upstream/oh-my-pi` 通过 `.gitmodules` 和固定 gitlink 提交引用公开上游源码。
- 本机最初的 app worktree 保留在被忽略的 `.local-worktrees/pi-desktop-baseline/`；未删除原始克隆或用户改动。
- 新机器使用 `git clone --recurse-submodules`，不依赖本机的 worktree 绝对路径。

## 源码一致性

PI-Desktop 基线 SHA：`0111e306c120ad5820688d7608cb37bad8fbcc1f`。

已验证暂存区 `app/` 的 Git tree 与上游该提交的根 tree 完全相同：

```text
50e2b9216a2bd93d0b119cf800d06cea8c4a5f59
```

共 2,093 个源码/资源文件。所有文件内容、路径和 Git 文件模式保持上游原样，许可证及版权声明未删除。OMP 子模块固定在 `d49918fab2dba3986927f2d46721629ed0f3a02c`。

## 验证范围

执行源码 tree 比较、子模块登记与指针核对、规划文档路径检查和提交范围核对。

全量首次导入执行 `git diff --cached --check` 时，上游原有代码/文档存在行尾空白及末尾空行提示。为保留准确基线，没有为此修改上游源码；新增规划及仓库配置单独检查。没有安装依赖或运行应用构建/测试，产品实现状态仍为规划阶段。

这次授权用于提交并推送源码与计划，不包含安装包发布、部署或真实模型调用。
