# 首次回复与 DeepSeek 空正文修复：0.1.4 同版本发布

最新状态：**本地 Mac ARM 0.1.4 测试包已构建并通过包内专项验收，等用户自行测试。**
正式发布未完成；第二候选完整源码门仍有失败，须定位并通过后才可晋升。下方保留各轮事实。

## 授权与当前状态

用户要求“把首次不回复和补点这两个修复一起提交，打包发布，保持当前版本号”。
本任务仍在 `.worktrees/fix-omp-first-response` / `codex/fix-omp-first-response`；
应用所有版本入口保持 **0.1.4**，schema 22、固定原生 `.7` / `edec389` 不变。
本机修复和发布准备已通过验证，两项修复合并提交为
`b6834d050f36f20094636277fb87301d889c14bd`，最新 `origin/main`
`a23bfb9befea327e7924efd3004e030a11b587d2` 为其祖先。候选标签
`release-check-0.1.4-chatfix-20261022` 已推送，
[run39703805424](https://github.com/MisterBowie/omp-desktop/actions/runs/39703805424)
的完整源码测试失败；本候选拒绝发布。尚未发布新安装包，远端结果只能在实际完成后补入本记录。

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

1. 合并提交两项修复并推送固定候选：已完成，来源见上。
2. 全部源码与 Mac ARM/Intel、Windows x64、Linux x64 打包/安装验收全部成功。
3. 晋升源码绑定修订，下载核对全部公开资产、更新 feed、来源回执和原 0.1.4 保护快照。
4. 回填真实结果和用户下载入口；本机已安装应用不作为构建输出替换。

## 首轮源码门失败与同步修正

run39703805424 的 `verify` 在完整 `pnpm -r --if-present test` 失败。
仓库现有安全诊断仅输出公共源码坐标：`packages/omp-runtime/src/process.test.ts:259`，
对应“reports the runtime's stderr as diagnostics only”，类别 `ASSERTION`；原始日志不转存。
该测试在 stdout 回复完成后立即读取另一个 stderr 管道，两个独立管道没有到达顺序保证。
mock 仍先写 stderr 再写 stdout，产品仍按独立数据事件采集；没有产品实现变化。

仅使用已有的有界 `waitFor` 等待诊断文本到达后保留原有内容断言。不跳过测试、
不降低内容要求、不改产品时限。原 22 项进程测试本机通过；完整运行时首轮 558 通过、
1 失败、6 跳过，唯一失败是已初始化但未构建的参考源码 launcher 版本不可读。
随后以 `OMP_SIDECAR_TEST_RESOURCES="/Applications/OMP Desktop.app/Contents/Resources"`
显式指定通过生产校验的本机 0.1.4 原生包，`pnpm --filter @pi-desktop/omp-runtime test`
实际 **565/565、零跳过**，exit 0；`pnpm lint` exit 0。没有使用未构建源码冒充原生通过。

两个聊天修复仍在同一 `b6834d05` 提交；测试同步修正另作可审阅提交，随后生成新固定候选，
完整源码与四平台均重跑。首轮失败候选和其安全诊断保留，不用于交付。

第二固定候选：`a8e7872f07164e414a6422b2596bcc1a443d4677`，标签
`release-check-0.1.4-chatfix-20261022-r2`，
[run39706079958](https://github.com/MisterBowie/omp-desktop/actions/runs/39706079958)。
源码与四平台均从该提交重新执行，当前仍在进行中；原生包和正式发布尚未验收完成。

## 用户优先要求的本地 Mac ARM 测试包

用户追加“先本地打包一个 mac arm 的版本，我自己测试下”。本地包先交付，正式发布
等待本地测试结果；远端构建继续。实际应用版本仍为 **0.1.4**，可执行源码是上方
`a8e7872f`（两个修复在同一 `b6834d05` 提交，另有测试同步修正）。

采用标准 `dist:mac --arm64` 链：当前宿主源码 release 编译，JS 全量构建，固定
`.7` / `edec389` 原生 CLI 与 gate 在本任务隔离 checkout 重建，预检后再由
electron-builder 生成 DMG/ZIP；`--publish never`，证书自动发现关闭。原生 addon
复用相同固定提交的本地 ARM 缓存，再以冻结锁文件离线安装依赖；没有修改其他工作树。
Electron 43.6.0 的本地缓存与官方公开资产 SHA-256 一致，官方校验清单也单独核对，
网络等待结束后标准封装入口自然完成，没有关闭 TLS/校验或绕过预检。

本机实际检查全部 exit 0：

- DMG `hdiutil verify`：VALID；ZIP `unzip -t`：零错误。
- `inspectInstalledProduct`：应用身份、0.1.4 元数据、图标、更新源、许可证均通过。
- `lipo -archs`：包内 Electron、Rust 宿主、OMP 都是 `arm64`；177 个编译文件逐一
  与包内 asar SHA-256 相同，确保新修复实际进入包内。
- `verify-packaged-runtime --resources <本地包 Resources> --json`：版本 18.3.0、
  协议 v2、get_state、缺失 gate 反向控制、停止/回收/清理通过，零残留。
- 使用本地包 Resources 运行 `omp-first-response-e2e` 与 `omp-deepseek-replay-e2e`：
  **2 tests / 2 pass / 0 fail / 0 skipped**。没有启动用户桌面应用或真实模型。

产物位于本任务 `app/apps/desktop/release/`，未签名，未替换用户安装：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.4-arm64.dmg | 218921180 | a4574e1168008e99974e01a763bf46adfdc0de3923e8ce4b1d1c9a2e45047a8a |
| OMP-Desktop-0.1.4-arm64-mac.zip | 217864519 | da19ec5991d3daf938e782da504a411e4c16d06ddd52e36f22e09d4ffc765b32 |

本机应用界面由用户自行验收，不声称已完成 GUI 流程测试。交包时第二候选
run39706079958 的 Mac ARM/Linux 打包安装任务成功，但完整源码测试门再次失败；
安全诊断 `diagnose-source-tests-39706079958` 已回读：类别 ASSERTION，坐标为
`omp-plan-submit-e2e.test.mjs:1988,2059,2099` 和 `omp-skill-path-e2e.test.mjs:617,679`。
这只是失败坐标，根因尚未定位；下一步须独立复现，不把它们视为已通过。Windows/Mac Intel
仍构建中，当前不具备正式发布条件，不晋升任何失败候选。
