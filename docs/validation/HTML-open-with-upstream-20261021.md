# HTML 右键打开方式：按 PI-Desktop 上游逻辑移植

日期：2026-10-21。已完成当前 **0.1.0** 的本机源码实现及适用验证。
工作树 `/Users/vv/person/omp-desktop/.worktrees/html-open-with`，分支
`codex/html-open-with`；HEAD `31acbf9cda5abe01342f534a7f41d1e3ae52cf7f` 加本次未提交修改。
准备候选时已获取 origin/main `a23bfb9befea327e7924efd3004e030a11b587d2`，
它是候选 HEAD 的祖先；保留已验收的完整 0.1.0 基线。主检出、上游子模块和既有工作树未改产品源码。

## 上游依据及适配范围

- [PI-Desktop PR #1713](https://github.com/vastsa/PI-Desktop/pull/1713)，
  首次进入 v0.21.0-beta.3；核对 v0.21.0-beta.4 固定源码
  `589e5803a7a9f4ebf7ec1e8849c43e44b4a198f7`。
- `use-chat-file-menu.tsx`、文件管理器按需恢复函数、BrowserPreview 的真实路径解析器
  与该固定上游逐字一致；[比较结果](html-open-with-20261021/upstream-match.json)
  三项均为 true，压缩参考源保存在 evidence 的 `upstream/`。
- HTML/HTM 文件引用右键提供“打开方式 → 文件管理器 / 内置浏览器 / 默认浏览器”，
  共用先解析引用、再打开确切命中文件的流程；支持 Markdown 链接、行内路径、文件芯片、
  工具摘要与文件列表，并同步路径复制、子菜单键盘操作及 8 份语言。
- “默认浏览器”沿用上游 `fs/open` → Electron `shell.openPath` 的系统文件关联语义；
  适配当前版本仅接收路径的 `fsOpen`，未新增 IPC 参数或强制选择浏览器。
- 当前旧基线没有新版会话能力元数据，按现有 `remote:` 会话标记禁止本机文件操作。
  普通点击保持当前版本原有目的地；会话或项目切换会取消过期打开请求。
- 补齐内置浏览器兼容：只在已登记项目根、当前会话临时目录及附件目录中选择一个
  包含目标的根。上游真实路径校验拒绝范围外文件及符号链接越界，被拒绝的绝对路径/
  file URL 不转为 HTTP。Agent 的 BrowserPreview 仍保持原工作区范围。
- 未改 SDK、IPC schema、插件授权或持久化结构。规格、ADR、E2E 场景、用户说明及
  当前 0.1.0 内嵌更新记录已同步。

## 验证结果

环境：macOS 本机，Node 24.14.0、pnpm 10.34.5、Electron 43.6.0。
以下命令从 `app/` 执行；单独 CDP 复测从 `app/apps/desktop/` 执行。
日志在 [证据目录](html-open-with-20261021/)，压缩日志保留原始结果。

| 验证 | 命令或范围 | 结果 |
| --- | --- | --- |
| 新增打开方式回归 | `node --test apps/desktop/test/chat-file-open-with.test.mjs`，包含菜单选择、解析失败、远程会话、插件恢复、复制及切换竞态 | 最初 15 项在原代码 4 pass / 11 fail；完成后扩至 23 项，全部通过 |
| 对话/菜单/链接回归 | `node --test`：chat-file-open-with、transcript-file-chips、chat-context-menu-items、chat-context-menu、chat-context-menu-surface、chat-links、tool-row-file-refs | 79 pass / 0 fail / 0 skip |
| 文件范围回归 | `node --test`：fs-panel-guard、chat-ref-resolve | 30 pass / 0 fail / 0 skip |
| 浏览器回归 | `node --test`：browser-pane-navigation、browser-host-session、browser-preview-tool、preview-workflow、browser-screenshot | 31 个用例通过 |
| CDP 单独复测 | 桌面目录 `node --test test/browser-cdp.test.mjs` | 5 pass / 0 fail / 0 skip |
| 国际化 | `pnpm --filter @pi-desktop/i18n test` | 25 项通过 |
| 更新记录 | shared 包 Vitest `src/changelog.test.ts` | 5 项通过；当前版本仍 0.1.0 |
| 依赖构建 | `pnpm --filter @pi-desktop/desktop build:deps` | exit 0 |
| 类型检查 | `pnpm --filter @pi-desktop/desktop typecheck` | exit 0 |
| lint | `pnpm lint` | exit 0 |
| 桌面构建 | `pnpm --filter @pi-desktop/desktop build` | exit 0；原有大 chunk 提示保留 |
| 双语文档 | `pnpm docs:check` | exit 0，79 对 / 515 页；既有 ADR 格式提示非失败 |
| 版本/发布文档 | `pnpm check:release-docs` | exit 0，0.1.0 对齐 |
| 基线及补丁空白 | `node scripts/check-pr-base-main.mjs`、`git diff --check` | exit 0 |
| 原生交互及文件加载 | `node scripts/e2e-chat-html-open-with.mjs <evidence-dir>` | 9 项真实菜单/存储交互及 3 项生产 BrowserPane 文件加载通过 |

上述单元/回归最终共 **175 个通过用例**，另有原生 9 + 3 项。
第一次浏览器组合命令从 app 根运行旧 CDP 测试时，该文件因相对路径 ENOENT 失败，
其余 31 用例通过；随后从该测试要求的桌面目录复测 CDP，5 项通过。
没有把第一次 31/1 的组合命令记为成功，也没有修改 CDP 测试规避错误。
早期 UI 夹具分别因使用不存在的 tab.pluginId 和遗漏 plugin/views 边界回复失败，
修正为真实 tab.resource 及完整 IPC 边界回复后通过，保留早期日志。

原生验证使用独有可见窗口和独立 profile，运行真实 React、ContextMenu、hooks、store；
仅 preload IPC 边界记录五次外部交接，不实际启动系统浏览器。
同一 Electron 主进程另运行生产 BrowserPane，实际加载项目、同级根、会话临时 HTML，
核对真实 file URL，并拒绝范围外根；单元测试覆盖符号链接及不转 HTTP。
见 [原生报告](html-open-with-20261021/report.json) 和
[菜单截图](html-open-with-20261021/menu.png)。

## 交付状态与验证边界

按本次源码功能范围完成，保持未提交状态，未推送、打包或发布，未替换用户已安装应用；
不调用真实模型，不修改用户数据。代码位于上述专用工作树，并非主检出的未提交修改。
未运行无关的 Rust/完整工作区测试，未进行 Windows/Linux 原生、安装包或真实系统浏览器
启动验收；当前证据覆盖本机源码、Electron 文件加载和外部打开请求边界。

[源码摘要清单](html-open-with-20261021/source-manifest.json) 固定本次产品及规格文件内容；
后续若修改代码应重新验证受影响项。证据文件的 SHA256 见
[SHA256SUMS](html-open-with-20261021/SHA256SUMS)。

## 追加授权：提交并同版本打包

用户于 2026-10-21 授权提交并打包、版本不变。继续使用本次工作树，源码和安装包
均保持 0.1.0。四目标 release workflow 增加真实 HTML 菜单/BrowserPane 验证及证据
归档，先构建已有 JS 依赖，Linux 使用既有 Xvfb。完整源码、截图、包内 15 项和实际
安装验收继续保留。使用新的 `release-check-0.1.0-*` 固定候选 tag 触发，制品保存在
该 run 的 Artifacts；当前稳定 v0.1.0 tag/Release 不覆盖。实际提交、run 与验收状态
以本节后续记录为准，前述“未提交”是本机源码阶段的历史状态。

提交前追加检查：发布脚本/候选验收 10/10、四目标新增步骤 Bash 解析与证据归档、
桌面/宿主/root 三处 0.1.0、main 祖先与 diff 空白检查全部通过；
见 evidence 的 `release-gates.txt.gz` 和 `release-workflow-check.json`。
