# OMP Desktop 开发交接

本文件只记录**当前状态、进行中的工作和下一步**。2026-09-21 至 2026-10-21 的完整过程记录原样归档在
[docs/history/HANDOFF-20260921-20261021.md](docs/history/HANDOFF-20260921-20261021.md)。
任务状态见[任务看板](docs/04-task-board.md)，范围与决定见[范围与决策](docs/00-scope-and-decisions.md)，
证据见 `docs/validation/`。

## 当前状态（2026-10-22）

| 项 | 值 |
| --- | --- |
| 正式版本 | **0.1.4**：[GitHub Release v0.1.4](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.4)，产品源码 `87894e73`，发布记录 `31ea1375`（[发布证据](docs/validation/Unified-014-release-20261021.md)） |
| 主线 | `main` 指向已验证并发布的最新代码，已推送 `origin/main`。根目录检出固定在 `main`，只作协调，不在其中开发 |
| 执行引擎 | OMP 是唯一执行引擎（2026-10-21 决定）。Pi 执行入口已关闭，遗留代码待删除（看板 R12） |
| OMP 运行时 | 上游 OMP 18.3.0（`62bc57be`）+ 受控 fork `MisterBowie/oh-my-pi@edec3898`，补丁 `62bc57b+omp-desktop.7`；以 `app/patches/oh-my-pi/manifest.json` 为准 |
| 数据 | 存储 schema 22；数据目录 `~/.omp-desktop`；全局能力目录 `~/.agents` 与 PI-Desktop 等工具有意共享（2026-10-22 决定） |
| 安装包 | macOS arm64/x64、Windows x64、Linux x64，由 `.github/workflows/release.yml` 构建 |

## 进行中

| 分支 / 工作树 | 内容 | 状态 |
| --- | --- | --- |
| `codex/chatfix-revision`（`.worktrees/chatfix-revision`） | 同版本修订候选：首次发送不回复与 DeepSeek 补点（`b6834d05`、`a8e7872f`）、用户子代理接入（`f10a7c13`，R06）、源码门测试竞态修复（R07） | 本机验证通过；等远端候选整轮通过和用户本地测试确认后发布（R08）。证据：[首次回复](docs/validation/OMP-first-response-20261022.md)、[补点](docs/validation/OMP-dot-replay-20261022.md)、[chatfix 发布记录](docs/validation/Chatfix014-release-20261022.md)、[子代理](docs/validation/OMP-user-subagents-20261022.md)、[R07](docs/validation/Chatfix-source-gate-races-20261022.md) |
| `codex/fix-omp-first-response`（`.worktrees/fix-omp-first-response`，已推送） | 上一轮 chatfix 分支，已并入修订线 | 用户自测的本地 ARM64 包来自 `a8e7872f`，不含子代理修复；修订线发布后移除该工作树 |

发版方式：修订线按**同版本修订** `0.1.4+chatfix.<SHA>` 发布（用户 2026-10-22 选择），原 `v0.1.4`
标签与资产保持不变；已安装用户需手动覆盖安装。远端候选整轮通过、用户本地测试确认后才晋升发布。
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

## 下一步

1. 修订线 `codex/chatfix-revision` 跑远端候选（完整源码门与四目标）；整轮通过且用户确认本地测试后，按同版本修订流程发布，再把修订线并入 `main`。
2. 在修订候选之上用独立分支完成 R09–R11。
3. 下一阶段做 R12（删除 Pi 遗留代码）；R13（OMP 上游升级与 fork 精简）单独立项。

## 工作约定

- 每个请求从 `main` 建 `codex/<name>` 分支和 `.worktrees/<name>` 工作树；验证后并入 `main`，再移除
  工作树和已合并分支。完整规则见根目录 `AGENTS.md` 与 `app/AGENTS.md`。
- Node 使用 `nvm use 24`。构建运行时需要 `OMP_SIDECAR_SOURCE` 指向与清单一致的 fork 检出。
- 普通测试使用 mock，不调用真实付费模型。证据写入 `docs/validation/`，状态写入看板。
- 已移除工作树的未提交改动归档在 `refs/archive/worktrees/*`，被替代的旧分支归档在
  `refs/archive/branches/*`。取回方法：`git worktree add <path> refs/archive/worktrees/<name>`。
