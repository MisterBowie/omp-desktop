# OMP 插件市场集成验证（2026-10-27）

分支 `codex/omp-marketplace`（`.worktrees/omp-marketplace`），基于 `main@2663b54d`。设计见
[ADR 0333](../../app/docs/adr/0333-omp-plugin-marketplace.md)（状态 Proposed，待用户确认）。

## 实现事实

- 插件市场页改由 OMP 自身的 `omp plugin …` CLI 驱动（`packages/omp-runtime/src/marketplace/`、
  `electron/main/runtime/omp-marketplace.ts`、`ipc/omp-market-ipc.ts`）。CLI 在
  `<数据目录>/omp-marketplace/home` 下运行，不读写用户的 `~/.omp`，不转发凭证，只带桌面显式代理。
- 会话只加载插件的技能、命令、子代理与规则（运行目录内的声明式视图）；MCP、hooks、工具模块、LSP/DAP
  不会加载，界面列为“暂不加载”。安装改动计入启动指纹，下一条消息起生效。
- 原 PI-Desktop 目录市场面板、安装对话框、源设置与 `market*` IPC 已移除。host-core `market.*` 处理器与目录
  模块已无桌面调用方，留给 R12 删除。
- 未新增或扩大 OMP fork 补丁。

## 本轮补充改动

- ADR 0333 与 ADR 索引。
- 截图流程：删除已不存在的“自定义目录地址”场景（`window.ts`、`publish-screenshots.py`、中英文
  `screenshots.md` 与两张 webp），`settings-extensions` 场景改为 OMP 插件源区域。现有
  `settings-extensions.webp` 仍是旧界面，需下次重新生成截图。
- 中文“关闭/开启”改为“停用/启用”：详情页中“关闭”与右上角关闭按钮并列，含义冲突。
- 测试随移除的组件更新：`open-http-url`（改读 `OmpPluginDetailSheet.tsx`）、`utility-navigation`
  （浏览状态新增 `installedOnly`、`marketplace`）、`plugin-permission-review`（安装审查已移除）、
  `omp-session-ipc-result`（注册新 IPC 模块）。

## 验证

运行时：Node v24.6.0；OMP 资源为 `/Applications/OMP Desktop.app`（0.1.6，OMP 18.3.0）。

| 命令（`app/` 下） | 结果 | 输出 |
| --- | --- | --- |
| `node --test test/omp-marketplace-e2e.test.mjs`（`OMP_BUNDLED_RESOURCES=<0.1.6 Resources>`） | exit 0，1/1：真实运行时经产品服务安装本地市场插件；会话得到命令、技能、子代理，MCP 未启动、工具模块未导入；对照组（原始安装目录）确实会启动/导入 | — |
| `npx vitest run src/marketplace`（`packages/omp-runtime`） | exit 0，24/24 | — |
| `pnpm --filter @pi-desktop/omp-runtime test` | exit 0，39 文件，586 通过、6 跳过 | [omp-runtime](OMP-marketplace-20261027/omp-runtime.txt) |
| `pnpm --filter @pi-desktop/omp-runtime typecheck`、`pnpm --filter @pi-desktop/desktop typecheck` | exit 0 | [typecheck](OMP-marketplace-20261027/tc.txt) |
| `node scripts/check-architecture.mjs` | exit 0 | [architecture](OMP-marketplace-20261027/arch.txt) |
| `node scripts/e2e-plugin-detail-focus.mjs` | exit 0：焦点归还、安装与确认卸载往返 | — |
| 首轮桌面全量 `node --test test/*.test.mjs` | 3238 项，10 失败。4 项为本分支遗漏的测试更新（已修，见上）；6 项为环境：工作树 `upstream/` 子模块被检出到 OMP 18.13.1 与另一 pi-desktop 提交且缺构建产物 | — |
| 子模块从根仓库本地对象恢复到固定提交（`62bc57be`、`0111e306`），从 `context-ring-usage` 工作树复制被忽略的构建产物后重跑全量 | 3246 项：3235 通过、0 失败、10 跳过、1 取消（`npm-executable` 15 s 超时，与 UI 烟测并发）；该文件单独重跑 12/12 | [desktop-summary](OMP-marketplace-20261027/desktop-summary.txt) |
| 真实窗口烟测：`electron-vite build` + `cargo build -p host-core`，临时 `PI_DESKTOP_DATA_DIR`，CDP 驱动：打开扩展→插件市场，输入本地市场路径添加源，点击卡片，点击“安装” | 通过：源列表显示 1 个插件，安装成功提示，详情页显示“技能 · 1、命令 · 1”，MCP 服务列入“暂不加载” | [目录](OMP-marketplace-20261027/ui-market-catalog.png)、[已安装](OMP-marketplace-20261027/ui-market-installed.png) |

未调用付费模型；真实运行时 e2e 的模型为本地假提供方。未用网络市场源（如 GitHub）实测。

## 未解决

1. ADR 0333 需用户确认（尤其“只加载声明式内容、不加载 MCP/hooks/工具”的取舍）。
2. host-core `market.*` 与目录模块删除归入 R12。
3. `settings-extensions` 截图需重新生成。
4. GitHub/git 远程源只经 OMP 自身逻辑，未做联网实测。
