# OMP Desktop 开发交接

本文件只记录**当前状态、进行中的工作和下一步**。2026-09-21 至 2026-10-21 的完整过程记录原样归档在
[docs/history/HANDOFF-20260921-20261021.md](docs/history/HANDOFF-20260921-20261021.md)。
任务状态见[任务看板](docs/04-task-board.md)，范围与决定见[范围与决策](docs/00-scope-and-decisions.md)，
证据见 `docs/validation/`。

## 当前状态（2026-10-24）

| 项 | 值 |
| --- | --- |
| 正式版本 | **0.1.5**：[GitHub Release v0.1.5](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.5)（`releases/latest`），产品源码 `4194e804`，2026-10-24 01:34（北京时间）发布，更新源已指向 0.1.5（[发布证据](docs/validation/Release-015-20261023.md)）。含图片附件接入 OMP、全局指令改存数据目录、隐藏 OAuth 登录入口（R09–R11）。此前版本：[0.1.4 同版本修订](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.4%2Bchatfix.852ca1b952ae64e0bcc660ffe89a3c0da06867d9)（`852ca1b9`，[证据](docs/validation/Chatfix014-release-20261022.md)）与 [v0.1.4](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.4)（`87894e73`，[证据](docs/validation/Unified-014-release-20261021.md)），标签与资产均未改动 |
| 主线 | `main` 指向已验证并发布的最新代码（修订线已并入），已推送 `origin/main`。根目录检出固定在 `main`，只作协调，不在其中开发 |
| 执行引擎 | OMP 是唯一执行引擎（2026-10-21 决定）。Pi 执行入口已关闭，遗留代码待删除（看板 R12） |
| OMP 运行时 | 上游 OMP 18.3.0（`62bc57be`）+ 受控 fork `MisterBowie/oh-my-pi@edec3898`，补丁 `62bc57b+omp-desktop.7`；以 `app/patches/oh-my-pi/manifest.json` 为准 |
| 数据 | 存储 schema 22；数据目录 `~/.omp-desktop`；全局能力目录 `~/.agents` 与 PI-Desktop 等工具有意共享（2026-10-22 决定） |
| 安装包 | macOS arm64/x64、Windows x64、Linux x64，由 `.github/workflows/release.yml` 构建 |

## 进行中

R15 转录错误卡片关闭按钮（`codex/dismiss-error-card`）：源码、组件测试与本地开发版界面验证通过，按用户 2026-10-24 要求已并入 `main`（`cf1b42ad`，已推送）（[证据](docs/validation/Error-card-dismiss-20261024.md)）。
0.1.6 发版（`codex/release-016`，`.worktrees/release-016`）：版本面与更新记录已升到 0.1.6，待远端候选与用户本地测试。
`codex/omp-dead-controls` 已随 0.1.5 并入 `main`。

发版方式：正式版按 `v<版本>` 发布并推送更新源；同版本修订按 `0.1.4+<名称>.<完整源码 SHA>` 发布，原稳定标签与
资产保持不变，已安装用户需手动覆盖。固定 `release-check-*` 远端候选整轮通过、用户本地测试确认后才由
`publish-*` 控制标签晋升原始制品。
2026-10-22 修复分支的原始过程记录见 [docs/history/fix-branch-notes-20261022.md](docs/history/fix-branch-notes-20261022.md)。

## 2026-10-22 用户决定

1. 主线：`main` 指向已发布版本并推送；修复从 `main` 建分支，验证后再并入。
2. 发版：保持同版本修订（`0.1.4+chatfix`）。
3. OMP fork：承认受控 fork；新增或扩大补丁须先有 ADR 并取得用户授权，不再把桌面业务逻辑放进 OMP
   核心；上游升级与补丁精简另立阶段（R13）。
4. `~/.agents`：继续与 PI-Desktop 等工具共享，属有意设计；其余数据、凭证与更新源保持隔离。
5. 对 OMP 无效的设置能接通的就接通：图片附件接入 OMP；全局指令改存 OMP Desktop 数据目录并注入
   OMP，不再写 `~/.pi/agent/AGENTS.md`，不自动迁移；OAuth 登录入口先隐藏（R09–R11）。
6. Pi 遗留代码下一阶段单独删除（R12）。

## 2026-10-23 用户决定

R09–R11 以 **0.1.5 正式版**发布，不走同版本修订：版本面、Cargo 与 `APP_VERSION` 已升到 0.1.5，新增 0.1.5
更新记录（R09–R11 六项，八种语言），0.1.4 条目恢复为已发布内容。正式版更新源会向已安装用户推送。

## 2026-10-24 用户决定

R15 并入 `main` 后以 **0.1.6 正式版**发布：版本面、Cargo 与 `APP_VERSION` 升到 0.1.6，新增 0.1.6 更新记录
（R15 一项，八种语言）。正式版更新源会向已安装用户推送。

## 下一步

0. 0.1.6 候选：固定 `release-check-0.1.6-*` 远端候选整轮通过后，用户本地测试 macOS arm64 包，确认后推
   `publish-v0.1.6-run-<候选运行 ID>` 发布并回读；发布后 `main` 快进到发布源码。
1. 下一阶段做 R12（删除 Pi 遗留代码）；从 `main` 新建分支和工作树。
2. R13（OMP 上游升级与 fork 精简）单独立项。
3. 0.1.5 发布后若用户反馈问题，从 `main` 建修复分支，按同版本修订或 0.1.6 另行发布。

## 工作约定

- 每个请求从 `main` 建 `codex/<name>` 分支和 `.worktrees/<name>` 工作树；验证后并入 `main`，再移除
  工作树和已合并分支。完整规则见根目录 `AGENTS.md` 与 `app/AGENTS.md`。
- Node 使用 `nvm use 24`。构建运行时需要 `OMP_SIDECAR_SOURCE` 指向与清单一致的 fork 检出。
- 普通测试使用 mock，不调用真实付费模型。证据写入 `docs/validation/`，状态写入看板。
- 已移除工作树的未提交改动归档在 `refs/archive/worktrees/*`，被替代的旧分支归档在
  `refs/archive/branches/*`。取回方法：`git worktree add <path> refs/archive/worktrees/<name>`。
