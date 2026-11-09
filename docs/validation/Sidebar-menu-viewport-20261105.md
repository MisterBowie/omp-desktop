# 侧栏行菜单底部被遮挡修复验证（2026-11-05）

- 分支与工作树：`codex/sidebar-menu-viewport`，`.worktrees/sidebar-menu-viewport`，基线 `main` `da808825`。
- 问题：侧栏靠下的会话行右键或点“更多”时，菜单底部超出窗口（截图中“复制会话 ID”及其后的项被裁掉）。
- 运行时：Node `v24.14.0`（`nvm use 24`）；pnpm `10.34.5`；Electron `43.6.0`。

## 根因

`Sidebar.tsx` 的 `placeMenu` / `placeMenuAtPoint` 用固定值 `window.innerHeight - 220` 夹住菜单顶部，
假设菜单高度不超过约 220px，菜单容器也没有 `max-height`。R20 等改动给会话菜单加入“复制标题 / 复制项目路径 /
复制会话 ID”后，会话菜单实测高 269px，靠下行的菜单因此超出视口。

## 上游做法（照搬）

PI-Desktop 上游（子模块 `upstream/pi-desktop` 已抓取的 `origin/main` `5aa25388`）已有修复，本次照其移植：

| 上游提交 | 内容 | 本次移植 |
| --- | --- | --- |
| `a6d0135f` fix(sidebar): prevent viewport clipping of session row actions | 菜单容器加 `max-height` 与 `overflow-y: auto` | 是 |
| `d7cb8440` fix(sidebar): keep row menus inside the viewport | 抽出 `lib/sidebar-floating-menu.ts`；`max-height: min(360px, calc(100vh - 16px))`；单元测试与规格 | 是 |
| `d427d87d` fix(sidebar): keep project menus near bottom rows | `placeSidebarFloatingMenuTop`：下方放不下时按实测高度翻到锚点上方；`useLayoutEffect` + `ResizeObserver` 重新定位；E2E 场景 E2E-021c | 是 |

`lib/sidebar-floating-menu.ts` 与 `test/sidebar-floating-menu.test.mjs` 与上游 `origin/main` 逐字相同。
上游后来把菜单改成 `SidebarMenuPanel` 组件，属于无关重构，未移植；因此 `sidebar-navigation.test.mjs`
的源码断言采用 `d427d87d` 版本（3 处 `ref={floatingMenuRef}`），未采用上游最新版本（4 处 `menuRef=`）。
E2E 检查在上游项目行场景之外增加了会话行场景（本次问题所在）。

## 改动文件（`app/`）

- `apps/desktop/src/lib/sidebar-floating-menu.ts`（新增，上游原样）
- `apps/desktop/src/components/Sidebar.tsx`：使用 helper；记录锚点；测量实际高度重新定位；三个浮动菜单挂 `floatingMenuRef`
- `apps/desktop/src/styles/sessions.css`：`.sidebar-row-menu, .sidebar-popover` 加 `max-height` 与 `overflow-y`
- `apps/desktop/test/sidebar-floating-menu.test.mjs`（新增，上游原样）、`apps/desktop/test/sidebar-navigation.test.mjs`
- `scripts/e2e/sidebar-row-states.mjs`：E2E-021c，底部项目行与会话行的右键、更多按钮共 4 项检查
- 规格（中英两份）：`04-ux/09-interaction-patterns.md`、`06-delivery/04-e2e-test-plan.md`（E2E-021 更新，新增 E2E-021c）

## 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test test/sidebar-floating-menu.test.mjs`（修复前，仅加测试） | 1 | 模块不存在，失败 |
| `node --test test/sidebar-floating-menu.test.mjs test/sidebar-navigation.test.mjs` | 0 | 25 通过 |
| `pnpm -r --if-present build` | 0 | 全部包构建通过 |
| `pnpm --filter @pi-desktop/desktop run typecheck` | 0 | 通过 |
| `node --test test/*.test.mjs`（desktop 全量） | 1 | 3262 项：3222 通过，35 跳过，5 失败（见下） |
| 上述 5 项所在 5 个文件，子模块临时链接到主检出后重跑 | 0 | 22 通过 |
| `pnpm --filter @pi-desktop/docs run check:locales` | 0 | 80 组规范对通过 |
| `npx biome lint <改动的 ts/mjs>` | 0 | 通过 |
| `git diff --check` | 0 | 通过 |
| `node scripts/check-architecture.mjs` | 0 | 通过 |
| `pnpm test:e2e:layout` | 1 | 未进入界面：种子步骤调用 `session.import`，OMP Desktop 已在 host-core 拒绝（`UNSUPPORTED`），`main` 上同样失败 |
| 本地临时副本 E2E（见下），修复前渲染进程 | 1 | 新增 4 项菜单检查全部失败 |
| 本地临时副本 E2E，修复后渲染进程 | 1 | 172/175；新增 4 项菜单检查全部通过；其余 3 项失败与本改动无关 |

### 全量失败说明

5 项失败（`omp-desktop-capabilities`、`omp-execution-policy-e2e`、`omp-runtime-launcher`、
`omp-runtime-state-e2e`、`omp-session-turn-fence-e2e`）均因新工作树的 `upstream/` 子模块为空
（`Cannot find module .../upstream/pi-desktop/...`、`source does not look like the OMP checkout`）。
与 R20 相同，临时把两个子模块目录换成指向主检出同 SHA 目录的符号链接后重跑，22 项全部通过；随后恢复为空目录，未提交。

### 渲染 E2E（本地临时副本，不提交）

`test:e2e:layout` 的种子步骤依赖已禁用的 `session.import`，因此复制了一份本地脚本（运行后已删除）：种子改用
`session.create` + 映射后的会话 ID，`sidebar-row-states.mjs` 中写死的 `e2e-state-standalone` 换成映射 ID。
host-core 使用 `.worktrees/p0-gap-fixes/app/target/release/pi-desktop-host-core`（同基线 `da808825`，
本次未改 Rust）。窗口视口高 800px，数据目录为临时目录。

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| 底部项目行右键菜单 | 失败：top 580，bottom 816.9（超出视口） | 通过：锚点上方 4px，482–719 |
| 底部项目行更多按钮菜单 | 失败：bottom 816.9 | 通过：上方 4px |
| 底部会话行右键菜单 | 失败：top 580，bottom 849（菜单高 269px，裁掉 49px） | 通过：上方 4px，349–618 |
| 底部会话行更多按钮菜单 | 失败：bottom 849 | 通过：上方 4px |

修复后其余 3 项失败：
1. `the modal veil covers the work-panel toggle in the titlebar band`：修复前后都失败，与菜单无关。
2. `the seeded multi-row group draws its rows and every date label`：本地种子无法设置历史时间戳，不产生日期分组，属于临时种子方式造成的。
3. 一项按钮悬停底色检查（两次运行分别落在 `pulls/dark toggle-sidebar` 和 `scheduled/light new-task`，修复前那次未出现），属偶发，与菜单无关。

## 未验证与遗留

- 未做安装包，未在用户实际窗口尺寸下手动点击。
- `test:e2e:layout` 的种子方式与 OMP Desktop 不兼容，整套布局 E2E 在 `main` 上无法运行；修复该种子需要另立任务。
- 未提交、未合并；等待用户决定。

## 本地测试包（2026-11-09）

用户要求本地打包查看效果。本修复与 R22（`codex/omp-review-changes`）合在一个包里：临时分离工作树
`.worktrees/preview-r21-r22`（基线 `main` `da808825`）放入本工作树 `app/apps`、`app/scripts` 的改动和 R22 的全部改动，
未签名 arm64 包 `~/Downloads/OMP-Desktop-0.1.6-review-sidebar-20261109-arm64.dmg`（SHA-256 `ad834590…a20484`）。
`sidebar-floating-menu.test.mjs`、`sidebar-navigation.test.mjs` 与 R22 的四个测试文件 53 通过；`hdiutil verify`、
`verify-installed-product`、`verify-packaged-runtime` 均通过；构建产物 CSS 含本修复的限高与滚动。完整命令与哈希见
R22 证据 [OMP-review-changes-20261105.md](OMP-review-changes-20261105.md) 末节（该文件在 R22 工作树中，未提交）。
未在安装包中手动点击，由用户验收。
