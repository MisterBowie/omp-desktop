# 首次回复与 DeepSeek 空正文修复：0.1.4 同版本发布

## 授权与当前状态

用户要求“把首次不回复和补点这两个修复一起提交，打包发布，保持当前版本号”。
本任务仍在 `.worktrees/fix-omp-first-response` / `codex/fix-omp-first-response`；
应用所有版本入口保持 **0.1.4**，schema 22、固定原生 `.7` / `edec389` 不变。
本机修复和发布准备已通过验证；当前还没有提交固定候选或发布新安装包。
远端结果只能在实际完成后补入本记录。

## 改动与保留行为

- 首次提问与自动改名重叠时，改名收尾不再回收提问正在使用的运行时；继续复用
  已绑定的原生会话身份。确定性准备中/运行中竞态及真实原生流程均覆盖。
- DeepSeek 官方 Completions 投影显式关闭 `requiresAssistantContentForToolCalls`，
  空正文工具消息在下一次请求中保持为空。真实正文（包括真实 `.`）、思考与工具
  结构保留，不在 UI 隐藏正文、不改写用户旧历史。
- 更新记录在原 0.1.4 条目增加两个修复，八语言一致。两个新原生用例进入四平台
  打包后验收，要求 2 tests / 2 pass / 0 fail / 0 skipped。

根因、更正与原生证据分别见[首次回复](OMP-first-response-20261022.md)和
[补点来源](OMP-dot-replay-20261022.md)。旧截图缺原始 SSE，不能证明每个旧点的来源。

## 发布策略与保护

使用固定 `release-check-0.1.4-<候选>` 标签完成全部源码与四目标安装包验收，再由
`publish-chatfix-v0.1.4-run-<run>` 控制器晋升已接受的原始制品。新公开标签为
`v0.1.4+chatfix.<完整源码 SHA>`，应用内版本仍为 0.1.4；同版本安装需要手动覆盖，
自动更新不会将其视为更高版本。

原 v0.1.4 保护基线：源码 `87894e73dbc85d65555d3bf61c7d84caa2245a8b`，
Release ID `419670366`，28 项资产。发布前/后对比完整资产快照，回读再次验证；
原标签不移动、原资产不替换。原公开 API 响应保存在本记录同名证据目录。

控制器的有效来源/重试、错误仓库、错误触发标签、原稳定标签改变、原 Release 改变
均执行真实 Bash 绑定脚本测试，仅 mock GitHub 外部 API。macOS Bash 3.2 暴露的
失败条件继续执行问题已用显式 `|| exit 1` 修复，6 项测试全通过。

## 本机发布准备验收

环境：Node 24.14.0、pnpm 10.34.5、macOS ARM；命令均从本任务 worktree 的 `app/`
执行（原生测试在 `app/apps/desktop/`）。下列已运行并 exit 0：

- `pnpm build:js`；`pnpm --filter @pi-desktop/desktop typecheck`；`pnpm lint`。
- `pnpm docs:check`：80 对双语文档、522 页；`pnpm check:release-docs`：0.1.4 对齐。
- `node --test scripts/prepare-github-release.test.mjs scripts/github-update-provider.test.mjs scripts/verify-release-candidate.test.mjs scripts/stage-release-inputs.test.mjs scripts/check-release-workflows.test.mjs scripts/readback-workflow.test.mjs scripts/publication-tag.test.mjs scripts/chatfix-publication.test.mjs`：42/42，零失败、零跳过。
- `pnpm --filter @pi-desktop/shared exec vitest run src/changelog.test.ts`：5/5。
- 四份修改/新增的 GitHub workflow YAML 均解析通过。
- `OMP_BUNDLED_RESOURCES="/Applications/OMP Desktop.app/Contents/Resources" node --test --test-reporter=tap test/omp-first-response-e2e.test.mjs test/omp-deepseek-replay-e2e.test.mjs`：最终构建后 2/2、零失败、零跳过，临时原生进程和本机 mock 服务均正常清理。
- `git fetch origin main` 及祖先检查通过；`git diff --check` 通过，两个上游子模块固定提交且干净。

产品专项已实际通过 159 项相关桌面测试、50 项事件/历史投影测试及 3 项原生用例；
完整命令与各轮边界保留在上述两份专项记录。没有启动用户桌面应用、读写用户会话
或调用真实付费模型；没有运行 `verify:ui:*`，因为本任务未请求该入口。

## 待完成交付

1. 合并提交两项修复并推送固定候选；记录 commit/base/run。
2. 全部源码与 Mac ARM/Intel、Windows x64、Linux x64 打包/安装验收全部成功。
3. 晋升源码绑定修订，下载核对全部公开资产、更新 feed、来源回执和原 0.1.4 保护快照。
4. 回填真实结果和用户下载入口；本机已安装应用不作为构建输出替换。
