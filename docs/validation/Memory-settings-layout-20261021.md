# 记忆设置页布局修复（2026-10-21）

当前状态：源码已修复并验证，工作树 `.worktrees/memory-settings-layout`、分支
`codex/memory-settings-layout`，基线 `4f5eb9c5`。应用仍为 0.1.3；未提交、推送或重新发版。

## 原因与修复

原记忆 CSS 使用未定义的 `--space-2/3`，间距和 margin 计算失效；公共输入框的
`width: 100%` 又占满可换行 flex 行，把搜索按钮挤到下一行。混合内容卡片没有内边距，
原生 select 也没有使用统一字段样式；分页与清空没有独立分组。页面大标题和卡片标题重复。

修复集中于 `MemorySettingsPage.tsx`、`memory-settings.css`：使用项目已有 Select、
带内边距的浏览区、带间距的网格搜索栏与独立页脚分组。内容宽度不足时输入框独占一行，
清空操作移到独立行。说明文字使用已有字号/行高与主题令牌，长记忆文本在卡片内换行。
标题仅由设置页容器提供。未改开关、查询、分页、清空确认、IPC、数据库和原生运行时语义。

## 验证

macOS arm64，Node 24.14.0 / pnpm 10.34.5 / Electron 43.6.0。
`pnpm build:js`、桌面 build/typecheck、`pnpm lint`、`pnpm docs:check` 均 exit 0。
记忆服务和响应式设置回归：6 pass / 0 fail / 0 skip。

隔离 Electron 夹具加载真实组件和构建后的生产 CSS，全部 API 用内存模拟值。
发布版与修复版分别验证 1024、720、390 CSS 像素宽度；另验证窄屏长文本、长项目名和
英文清空确认，共 7 个渲染用例（3 个基线、4 个修复后）。基线复现零间距/按钮换行/重复标题；
修复后对齐、实际内容内边距、控件无重叠及横向无溢出通过，并已查看宽屏和窄屏底部截图。
早期 lint 指出的裸行高已替换成现有令牌，最终全量 lint 通过。

复现夹具与输出按原字节 gzip 归档，摘要见同名 JSON。没有调用付费模型、启动已安装的
OMP Desktop 或读取真实记忆。此次没有重新执行四目标安装验收，不把 macOS 夹具当作跨平台发布证明。

## 证据与后续

- [修复前](Memory-settings-layout-20261021/before-wide.png)
- [宽屏预览](Memory-settings-layout-20261021/after-wide.png)
- [窄屏预览](Memory-settings-layout-20261021/after-narrow.png)
- [窄屏长文本及清空确认](Memory-settings-layout-20261021/after-narrow-confirmation.png)
- [实际几何结果](Memory-settings-layout-20261021/rendered-layout.json)

已同步自动记忆中英文规格与布局验收场景。当前修复可供审阅，正式提交和发布另按用户要求执行。
