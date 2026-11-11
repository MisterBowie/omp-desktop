# OMP Desktop 开发交接

本文件只记录**当前状态、进行中的工作和下一步**。2026-09-21 至 2026-10-21 的完整过程记录原样归档在
[docs/history/HANDOFF-20260921-20261021.md](docs/history/HANDOFF-20260921-20261021.md)。
任务状态见[任务看板](docs/04-task-board.md)，范围与决定见[范围与决策](docs/00-scope-and-decisions.md)，
证据见 `docs/validation/`。

## 当前状态（2026-11-11）

| 项 | 值 |
| --- | --- |
| 正式版本 | **0.1.8**：[GitHub Release v0.1.8](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.8)（`releases/latest`），产品源码 `a746e7b7`，2026-11-11 18:43（北京时间）发布，更新源已指向 0.1.8（[发布证据](docs/validation/Release-018-20261110.md)）。含 R16、R24、R25、R26。此前版本：[v0.1.7](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.7)（`60cf1aab`，R17–R22，[证据](docs/validation/Release-017-20261109.md)）、[v0.1.6](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.6)（`f0c9399a`，R15，[证据](docs/validation/Release-016-20261024.md)）、[v0.1.5](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.5)（`4194e804`，R09–R11，[证据](docs/validation/Release-015-20261023.md)）、[0.1.4 同版本修订](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.4%2Bchatfix.852ca1b952ae64e0bcc660ffe89a3c0da06867d9)（`852ca1b9`，[证据](docs/validation/Chatfix014-release-20261022.md)）与 [v0.1.4](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.4)（`87894e73`，[证据](docs/validation/Unified-014-release-20261021.md)），标签与资产均未改动 |
| 主线 | `main` 指向已验证并发布的最新代码（含 0.1.8 发布分支），已推送 `origin/main`。根目录检出固定在 `main`，只作协调，不在其中开发 |
| 执行引擎 | OMP 是唯一执行引擎（2026-10-21 决定）。Pi 执行入口已关闭，遗留代码待删除（看板 R12） |
| OMP 运行时 | 上游 OMP 18.3.0（`62bc57be`）+ 受控 fork `MisterBowie/oh-my-pi@edec3898`，补丁 `62bc57b+omp-desktop.7`；以 `app/patches/oh-my-pi/manifest.json` 为准 |
| 数据 | 存储 schema 22；数据目录 `~/.omp-desktop`；全局能力目录 `~/.agents` 与 PI-Desktop 等工具有意共享（2026-10-22 决定） |
| 安装包 | macOS arm64/x64、Windows x64、Linux x64，由 `.github/workflows/release.yml` 构建 |

## 进行中

R17–R22 与 0.1.7 版本面（`codex/release-017`）已随 0.1.7 发布并入 `main` 并推送。各项证据：R17 [上下文圆环](docs/validation/Context-ring-usage-20261026.md)、R18 [插件市场](docs/validation/OMP-marketplace-20261027.md)、R19 [生成速度](docs/validation/Token-throughput-20261027.md)、R20 [P0 差距修复](docs/validation/P0-gap-fixes-20261028.md)、R21 [侧栏菜单](docs/validation/Sidebar-menu-viewport-20261105.md)、R22 [审阅改动](docs/validation/OMP-review-changes-20261105.md)。

- R23 README 截图：已完成。用 0.1.7 安装包驱动真实 OMP 会话（只有模型是本机假服务）截取审阅、审批、子智能体、插件市场四个场景的中英文截图，脚本 `app/scripts/readme-screenshots.mjs` 可重复生成（[证据](docs/validation/Release-017-20261109.md)）。
- R24 `codex/omp-stream-start-text`：审批等待期间回复文字重复显示已修复，并入本地 `main`（[证据](docs/validation/OMP-stream-start-text-20261110.md)）。
- **0.1.8 已发布**（`codex/release-018`，`.worktrees/release-018`）：R16 + R24 + R25 + R26。前两次候选因 R26 所修的竞态失败，未发布任何内容；第三次候选 run42998711279 整轮通过后，经 run43005740813 发布。公开资产、更新源和旧版本已核对（[证据](docs/validation/Release-018-20261110.md)）。远端 `codex/release-018` 仍停在变基前的 `c21c8467`：强制更新被本机权限规则拦下，等用户决定更新还是删除。
- R25 `codex/omp-ask-custom-answer`：用户 2026-11-11 反馈回答提问后整轮“失败”。原因是提问卡的“输入其他答案”在 OMP 侧被回成取消，OMP 按用户中止结束回合。已改为经运行时 `Other (type your own)` → `editor` 两步投递（`e52961dc`），测试与本地包真实窗口验证通过（[证据](docs/validation/OMP-ask-typed-answer-20261111.md)），已并入 `main`，随 0.1.8 发布。
- R26 `codex/omp-turn-failure-late-frames`：0.1.8 两次候选都失败在 T20-D 用例。查明是 0.1.7 已有的竞态：模式切换失败后紧接的下一条消息可能没送到模型却显示完成。用户 2026-11-11 决定先修好再发；runner 已改为等待失败回合的终止帧（`f0843924`），验证通过，已并入 `main`，随 0.1.8 发布（[证据](docs/validation/OMP-turn-failure-settle-20261111.md)）。
- 截图时发现、待处理：项目位于符号链接目录（如 `/tmp`）时“本轮改动”显示绝对路径、“审阅”行末尾多一个斜杠。
- R21 发现的遗留问题：`test:e2e:layout` 种子依赖已禁用的 `session.import`，整套布局 E2E 在 `main` 上无法运行，需另立任务。
- R16 `codex/omp-turn-feedback`：三项回合反馈修复，2026-11-10 变基复验通过后与 R24 一起并入本地 `main`（`d8bef50b`，未推送）（[证据](docs/validation/OMP-turn-feedback-20261026.md)）。

发版方式：正式版按 `v<版本>` 发布并推送更新源；同版本修订按 `0.1.4+<名称>.<完整源码 SHA>` 发布，原稳定标签与
资产保持不变，已安装用户需手动覆盖。固定 `release-check-*` 远端候选整轮通过、用户本地测试确认后才由
`publish-*` 控制标签晋升原始制品。
2026-10-22 修复分支的原始过程记录见 [docs/history/fix-branch-notes-20261022.md](docs/history/fix-branch-notes-20261022.md)。

## 2026-11-11 用户决定

1. R25（OMP 提问卡输入其他答案后整轮中止）合入 `main`，与 R16、R24 一起进 **0.1.8**。
2. 用户试用 R25 本地包后确认“可以发布”。候选失败后，在“先发后修”和“先修好再发”中选择后者：R26 修复后随 0.1.8 发布。

## 2026-11-10 用户决定

1. R16 变基到 0.1.7 之后的 `main`，与 R24（审批等待时回复文字重复）一起以 **0.1.8 正式版**发布。
2. 先交本地测试包由用户用真实模型试用（R16 未做过真实窗口验证），用户确认后再推送远端候选并发布。
3. 符号链接项目目录的路径显示问题不进 0.1.8，单独处理。

## 2026-11-09 用户决定

1. R22、R21 合并进 `main`，0.1.6 之后的全部改动（R17–R22）以 **0.1.7 正式版**发布到 GitHub。
2. README 等按正式项目重写：根目录 README 为产品主页（英文、简体中文），`app/README` 为源码说明，`SECURITY.md` 改用本仓库私密漏洞报告。
3. README 需要 OMP Desktop 自己的截图，重点展示特有功能。

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

1. 下一阶段做 R12（删除 Pi 遗留代码）；从 `main` 新建分支和工作树。
2. R13（OMP 上游升级与 fork 精简）单独立项。
3. 远端 `codex/release-018` 停在 `c21c8467`，需要用户决定强制更新或删除。已合并的 `.worktrees/omp-turn-feedback`（R16）、`.worktrees/omp-stream-start-text`（R24）、`.worktrees/release-018`、`.worktrees/omp-turn-failure-late-frames`（R26）可清理。

## 工作约定

- 每个请求从 `main` 建 `codex/<name>` 分支和 `.worktrees/<name>` 工作树；验证后并入 `main`，再移除
  工作树和已合并分支。完整规则见根目录 `AGENTS.md` 与 `app/AGENTS.md`。
- Node 使用 `nvm use 24`。构建运行时需要 `OMP_SIDECAR_SOURCE` 指向与清单一致的 fork 检出。
- 普通测试使用 mock，不调用真实付费模型。证据写入 `docs/validation/`，状态写入看板。
- 已移除工作树的未提交改动归档在 `refs/archive/worktrees/*`，被替代的旧分支归档在
  `refs/archive/branches/*`。取回方法：`git worktree add <path> refs/archive/worktrees/<name>`。
