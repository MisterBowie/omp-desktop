# 项目路线审查与整理（2026-10-22）

状态：**整改任务 R01–R05 已完成**。决定与后续任务见[范围与决策](../00-scope-and-decisions.md)的
“2026-10-22 用户决定”和[任务看板](../04-task-board.md) R01–R14。本轮没有改产品代码，也没有调用模型。

## 审查结论（摘要）

- 主路线符合计划：`omp --mode rpc-ui` 结构化事件、受信 gate 在 `tool_call` 执行前阻断、审批与提问按结构区分、
  模型配置单向投影、OMP 子进程合成 HOME、独立 appId/数据目录/更新源。
- 偏离一：受控 OMP fork 持续扩大（`.7`：13 项能力、31 个文件、139,512 字节，基线仍为 18.3.0），
  范围文档的“不私有维护 OMP 业务分叉”没有修订，`source-baseline.json` 缺 `.6`/`.7` 记录，上游升级从未实际做过。
- 偏离二：OMP-only 只关闭了 Pi，约 1 MB Pi 代码仍在构建；全局指令、OAuth 登录、图片附件对 OMP 无效；
  `~/.agents` 与 PI-Desktop 共用。
- 偏离三：`origin/main` 停在 2026-09-21 初始提交；根检出停在 0.1.0；HANDOFF 250 KB、看板 143 KB 为重复流水账；
  12 个工作树中 10 个已并入发布线。

## 执行记录

| 操作 | 命令 / 方式 | 结果 |
| --- | --- | --- |
| R01 推送主线 | `git push origin 31ea1375…:refs/heads/main` | `a23bfb9b..31ea1375`，快进，未强推；发布类 workflow 只由标签触发，推送 main 不触发 CI |
| R01 根检出 | `git switch -c main --track origin/main` | 根目录 = `main` @ `31ea1375`，子模块指针不变（`62bc57be`、`0111e306`） |
| R02 归档未提交改动 | 临时索引 `git add -A` → `write-tree` → `commit-tree -p HEAD` → `update-ref` | `refs/archive/worktrees/memory-settings-layout` `6a921f1f`（24 个文件）、`provider-context-window` `031c1e4f`（79）、`release-0.1.1` `a107c5ec`（5）；`refs/archive/branches/codex/omp-session-operations` `6f0785ba` |
| R02 移除工作树 | `git worktree remove --force` ×10，`git branch -d` ×10，`git branch -D codex/omp-session-operations` | 剩余工作树：根 `main`、`fix-omp-first-response`、`fix-omp-user-subagents`；被删分支均为 `main` 祖先或已归档 |
| R03 归档过程记录 | 原 HANDOFF 全文、看板第 3–387 行移到 `docs/history/` | `diff` 证明正文逐字一致；62 个相对链接改为从新位置可解析，0 个失效 |
| R04/R05 | 范围文档、根 `AGENTS.md`、ADR 0305、运行时规格（中英）、`source-baseline.json`、`02`/`07` 文档 | 已写入 fork 管理规则、`.6`/`.7` 日期化记录、实际升级流程与 `~/.agents` 共享决定 |

审查时三份未提交改动与发布线的比对：新增代码行分别有 673/674、151/155、30/30 已在 `a8ee2f83`，
其余差异为后续提交改写或原始日志，因此以归档方式保留而非重新提交。

## 检查

环境：macOS arm64，Node v24.14.0（`nvm use 24` 在本机解析失败，改为 `nvm use 24.14.0`，未改全局默认）。

| 命令（目录 `app/docs`） | 结果 |
| --- | --- |
| `node scripts/check-locales.mjs` | exit 0，80 对中英规格 |
| `node scripts/check-docs.mjs` | exit 0，522 页；输出中的 ADR “Consequences” 提示为既有内容 |

## 未做与限制

- 未发布、未打包、未触发 Actions；`origin` 上既有的诊断分支与标签保留（文档引用它们作证据）。
- GitHub HTTPS 不可达、SSH 可用；未核对上游 OMP / PI-Desktop 当前最新版本（R13 时再做）。
- 本机 `.omp-sidecar-source/` 当时仍为 `.6`（`d648d27`），与当前锁定 `.7` 不一致；构建运行时前须切到清单中的 fork 提交。
