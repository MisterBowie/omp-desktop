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

## 2026-10-27 修订：完整加载插件

用户决定“先不管审批逻辑，先能用 MCP、hooks 等”。改动：

- `projectMarketplacePlugins` 不再构建声明式视图，运行注册表直接指向存储中的安装目录；删除
  `buildDeclarativeView`、`safeDeclaredPath`、`MARKETPLACE_VIEW_DIR` 等视图代码。
- 组件报告 `withheld` 改名 `executable`（目录元数据 `declaresWithheld` → `declaresExecutable`），界面改为
  “会运行：…”与“会运行程序”提示；市场说明改为“插件会完整加载……请只安装可信的插件”（八种语言）。
- ADR 0333 改写为完整加载，并记录风险：工具模块与 MCP 在会话启动时运行，桌面审批拦不住；插件 MCP
  工具调用是否经过桌面权限闸门未验证。上文“只加载声明式内容”的描述已被本节取代。

| 命令（`app/` 下） | 结果 |
| --- | --- |
| `node --test test/omp-marketplace-e2e.test.mjs`（0.1.6 资源） | exit 0：产品路径下插件命令、技能、子代理、规则进入会话，MCP 服务被启动，工具模块被导入（标记文件均写出）。hooks 未被触发验证（假模型不调用工具） |
| `npx vitest run src/marketplace` | exit 0，18/18 |
| `pnpm --filter @pi-desktop/omp-runtime test` | exit 0，580 通过、6 跳过 |
| 两个 typecheck、`check-architecture`、`biome lint`（改动文件）、`e2e-plugin-detail-focus` | 均 exit 0 |
| 桌面全量 | 3246 项：3235 通过、0 失败、10 跳过、1 取消（`npm-executable` 15 s 超时，全量负载下两次出现；单独重跑 12/12） |
| 真实窗口烟测（重建后） | 通过：卡片显示“会运行：MCP 服务”，详情页“会运行程序”提示，“停用/卸载”按钮 |

## 本地测试包（2026-10-27）

用户要求并入 `main` 并本地打包。`codex/omp-marketplace` 快进并入本地 `main`（`5c6582b7`），未推送 `origin`，
未发布。包未签名、未公证，版本面仍为 0.1.6，只用于本机测试。

- 命令（工作树 `app/`）：`OMP_SIDECAR_SOURCE=<根目录>/.omp-sidecar-edec389 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pi-desktop/desktop run dist:mac --arm64`，exit 0（约 128 s）。
- 运行时：受控 fork `edec3898`，OMP 18.3.0。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.6-arm64.dmg | 221374283 | 8a298d1d2ad3dfa4a3b90f647db6c652e33ab493fc0f65ac9c1abbbbb7c0f3d1 |
| OMP-Desktop-0.1.6-arm64-mac.zip | 220281698 | b6e4b9d89a4644a24b2ad8bb87edaef110cd68d42f92af85977aee7985d95276 |

DMG 复制为 `~/Downloads/OMP-Desktop-0.1.6-marketplace-5c6582b7-arm64.dmg`；ZIP 在工作树 `app/apps/desktop/release/`。

| 检查 | 结果 | 附件 |
| --- | --- | --- |
| `hdiutil verify` | VALID | [archive-verify](OMP-marketplace-20261027/local-package/archive-verify.txt) |
| 解出 `app.asar`，`out/main/index.js` 含 `pi-desktop/omp-market/install` | 是 | — |
| `verify-packaged-runtime --resources <DMG 内 Resources>` | exit 0 | [verify-packaged-runtime](OMP-marketplace-20261027/local-package/verify-packaged-runtime.txt) |
| `verify-installed-product --app <DMG 内应用>` | exit 0 | [verify-installed-product](OMP-marketplace-20261027/local-package/verify-installed-product.txt) |
| `scripts/e2e-installed-smoke.mjs <DMG> <证据目录>` | exit 0，8/8 检查（建会话、拒绝写入不改字节、允许一次后写入、项目命令结果回到模型、Stop 回收进程、重启恢复原生历史、恢复后新回合、默认数据根隔离） | [installed-smoke](OMP-marketplace-20261027/local-package/installed-smoke/) |

安装包内未单独跑插件市场界面；市场界面已在开发构建的真实窗口中验证（见上文）。所有模型为本地 FakeProvider。

## 2026-10-27 修复：添加 GitHub 源一直“正在添加…”

- 现象（用户反馈）：添加 `anthropics/claude-plugins-official` 长时间停在“正在添加…”。
- 根因：桌面网络代理为默认的“系统”模式时，市场 CLI 不带任何代理变量；git 不读 macOS 系统代理（本机为
  127.0.0.1:7897），且 CLI 的 HOME 是隔离存储，用户 `~/.gitconfig` 也不生效，于是 `git clone` 直连 GitHub，极慢。
  进程快照可见 `git clone --depth 1 … claude-plugins-official.git` 运行 1 分 39 秒仍在 `index-pack`。
- 修复：系统模式下用 `session.defaultSession.resolveProxy("https://github.com/")` 解析系统代理，转换为
  `http://`/`https://`/`socks5://` 地址交给 CLI（绕过 localhost）；直连模式不带代理；自定义模式不变。
- 验证：`omp-marketplace-service.test.mjs` 新增模式优先级用例，与 `main-wiring-contract` 共 14/14；desktop
  typecheck exit 0；真实运行时经系统代理添加该源：34 s 完成，315 个插件。
