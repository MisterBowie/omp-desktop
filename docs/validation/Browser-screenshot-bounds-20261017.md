# 超长浏览器截图修复验证（2026-10-17）

## 结论与范围

按用户要求先检查 PI Desktop 与 OMP 官方源码，随后直接同步 PI Desktop 已有修复。
整页截图不裁剪，等比缩小至宽 1280、高 2048 CSS 像素以内，不放大小页面。
实际编码尺寸包含设备缩放比；2 倍屏的高度上限为 4096 像素。

用户随后授权提交 GitHub 打包，要求版本不变。最终源码 `08987f9` 已推送，
四目标构建及安装验收完成，版本仍为 **0.1.0**；最终 run、制品与回执见末节。
既有稳定 Release、远端已安装程序及历史图片未修改。已有超限图片仍需单独恢复。
任意附件、原始 CDP 调用和其他工具的图片不在本次捕获边界修复范围内；未调用
真实模型验证或产生模型费用。以下保留本机验证和前两轮失败的过程记录。

## 原因与上游依据

已安装 0.1.0 的报错会话使用 Pi 引擎、内置 Browser 工具，整页 JPEG 为
345 × 9663 像素，文件可正常解码。历史中的同一图片造成连续七次 HTTP 400。
旧桌面代码只约束宽度，遗漏高度。DeepSeek 官方规定图片单边最长 8192 像素，
15 张及以上图片时为 4096，见[官方限制](https://api-docs.deepseek.com/zh-cn/guides/vision/#限制)。

2026-10-17 实时读取并固定了两份官方 main 坐标，未修改参考子模块：

- PI Desktop：`e219a3e4c0e4cc73ddacde78005987a85d5977d6`。
  [browser-cdp.ts](https://github.com/vastsa/PI-Desktop/blob/e219a3e4c0e4cc73ddacde78005987a85d5977d6/apps/desktop/electron/main/browser-cdp.ts)
  已有 `SCREENSHOT_MAX_HEIGHT = 2048`，缩放为
  `Math.min(1, 1280 / width, 2048 / height)`。修复后整个 `screenshot` 方法与官方逐字一致。
- OMP：`58195a453b8627421f1119a60586e3c17d76a27e`。
  [image-resize.ts](https://github.com/can1357/oh-my-pi/blob/58195a453b8627421f1119a60586e3c17d76a27e/packages/coding-agent/src/utils/image-resize.ts)
  默认双轴 1568 和 500 KiB；
  [原生浏览器](https://github.com/can1357/oh-my-pi/blob/58195a453b8627421f1119a60586e3c17d76a27e/packages/coding-agent/src/tools/browser/tab-worker.ts)
  截图另调用同一缩放器，使用 1024 × 1024、150 KiB。

故采用同一桌面 CDP 边界的现成修复，不升级引擎、不复制依赖 Bun.Image 的原生
缩放器、不增加第二套模型图片处理。历史消息和权限边界均保持原状。

## 工作树与变更

- 工作树：`omp-desktop-image-guard`；分支：`codex/image-dimension-guard`。
- 已 fetch 的 origin/main：`a23bfb9befea327e7924efd3004e030a11b587d2`。
- 从该坐标新建后，在请求工作树快进至已接受的
  `f8a130d6174f33ff8f032905578576ee2798ad1b`，包含全部 0.1.0 发布修复。
- 生产改动仅 `app/apps/desktop/electron/main/browser-cdp.ts`：新增高度常量，
  将单宽度缩放替换成官方双轴最小比例；公共接口、保存路径及普通视口行为不变。
- 新增 Node 回归、隔离 Electron 原生截图夹具；同步插件 API 与 E2E 双语规格。
  scripts README 的旧全局 E2E 禁令与根 AGENTS 工作流冲突，改为根规则要求的
  最小隔离 E2E，并保留 `verify:ui:*` 明确授权限制。

## 验证

Node 24.14.0、pnpm 10.34.5、Electron 43.6.0、macOS arm64。

1. 新增九项调用真实 BrowserCdp、只替换外部 debugger 的回归，在旧代码上
   **5 通过 / 4 失败**；失败均由长页面的高度未限制导致。
2. 修复后运行 `node --test --test-reporter=tap test/browser-screenshot.test.mjs
   test/browser-cdp.test.mjs test/browser-host-session.test.mjs`：
   **22 通过 / 0 失败 / 0 跳过，exit 0**。覆盖长/宽/双轴/边界/小页面、CSS 优先、
   旧版 metrics 回退、普通视口、空结果错误，以及现有 CDP 和会话隔离回归。
3. `node scripts/e2e-browser-screenshot.mjs <evidence-dir>`：
   **六场景全部通过，Electron 正常退出，exit 0**。真实内置 Browser 工具调用生产
   BrowserHost/CDP；JPEG 实际解码，保存文件与返回给模型的图片逐字一致；检查
   顶部/中部/页尾三种颜色均存在。

| 场景 | 原始 CSS 尺寸 | 设备倍率 | 实际 JPEG 像素 |
| --- | --- | --- | --- |
| 原报错尺寸 | 345 × 9663 | 1 | 73 × 2048 |
| 宽页面 | 10000 × 800 | 1 | 1280 × 102 |
| 双轴大页面 | 5000 × 12000 | 1 | 853 × 2048 |
| 限制内页面 | 800 × 900 | 1 | 800 × 900 |
| 高分屏长页面 | 345 × 9663 | 2 | 146 × 4096 |
| 普通视口 | 345 × 720 | 2 | 690 × 1440 |

4. `pnpm --filter @pi-desktop/desktop typecheck`：exit 0。
5. `pnpm lint`：exit 0，Biome 和 style tokens 通过。
6. `pnpm docs:check`：exit 0，515 页检查通过；保留已有 ADR 格式警告。
7. `git diff --check` 与官方方法逐字比对通过。
8. 提交打包前，发布工作流/候选验收回归 **10/10、exit 0**；
   `pnpm check:pr-base`、`pnpm check:release-docs`、release YAML 与四平台 Bash
   解析、关键版本仍为 0.1.0 的检查全部通过。

真实 Electron 验证初次受沙箱阻止，授权后继续。夹具曾使用原生设备模拟 API 导致
崩溃，最终改用测试专属 CDP metrics；增加绘制完成同步，并按 Chromium 文档尺寸
至少包含视口的事实修正小页面夹具。最终结果来自当前夹具和生产源码，未放宽
双轴边界或页尾完整性断言。本机阶段未运行完整工作区/Rust 测试、`verify:ui:*`
或 Linux 原生安装；后续最终 GitHub 候选已通过完整源码及四目标安装验收。

原始日志、官方源码快照、源码摘要和原生图片在本机
`omp-image-review-20261017/`；精简证据见同名子目录。

## 同版本 GitHub 打包首轮阻断与修复

已提交、推送 19f38e52db3a4dbb8fb6dc051297436f1d9e2ebc，使用
`release-check-0.1.0-19f38e5` 触发
[run39043492205](https://github.com/MisterBowie/omp-desktop/actions/runs/39043492205)。
Linux / Mac ARM 在新增截图门失败，尚未进入安装包构建。Linux 精确错误为
`Electron binary missing`，来自开发依赖的 `electron/dist/electron` 缺失，
并未运行图片尺寸断言。无登录 API 返回 403，已通过用户现有 Chrome GitHub
登录态只读展开该失败步骤确认原因。

修复仅调整 CI 准备：显式执行锁定 Electron 包自带的 `install.js`，沿用官方
下载、缓存、摘要校验和解压逻辑。将 SDK 准备及截图预检移到 OMP 原生编译之前，
不改图片断言、产品源码或版本。对本机同样缺失 dist 的安装执行该命令后，
无需 `PI_BROWSER_SCREENSHOT_ELECTRON` 覆盖的原生六项全部通过。
首轮失败保留，不能将它记为打包完成。

第二轮 d268777b73dcbb8b88bd452f25bf2495794d149d /
[run39045061849](https://github.com/MisterBowie/omp-desktop/actions/runs/39045061849)
SDK 准备已恢复，Mac ARM/Intel 截图门通过。用户提供的 Linux 完整错误为
`target closed while handling command`；Windows 为 45 秒夹具超时后 SIGTERM，
尚无尺寸断言失败证据。字体与 D-Bus 的警告不是已证明的原因。浏览器日志读取
随后持续超时，未通过系统命令或读取浏览器凭据绕过。

夹具采用本项目实际安装验证已有的可见/聚焦窗口做法，避免隐藏窗口的绘制等待；
测试窗口只包含生成的颜色页面。一次导航后在同一页面修改尺寸，避免把跨导航
target 生命周期混入截图参数验收。增加固定阶段日志和 renderer 退出原因，保留
45 秒上限、全部尺寸与颜色断言。生产 CDP 代码和版本均未修改；本机默认路径
六场景再次通过。此项改动仍需新轮 Linux/Windows 结果，不能把本机通过当作修复证明。

## 最终同版本 GitHub 打包已验收（2026-10-18）

- 产品源码：`08987f90f918a2946f4762988762e69cd7e72200`；分支 `codex/image-dimension-guard`。
- 固定标记：`release-check-0.1.0-08987f9`，版本仍为 `0.1.0`。
- [最终 run39045810964](https://github.com/MisterBowie/omp-desktop/actions/runs/39045810964)：`completed/success`。
  guard、verify 及四目标 build 全成功；publish 按候选标记设计为 skipped。
- 完整源码门实际执行并通过 JS 构建、host-core release 构建、桌面类型检查、lint、
  workspace 测试、发布脚本回归及 host-core Rust 测试，没有复用旧产品的源码结果。
- 四目标各自的锁定 Electron 准备、真实截图六场景、OMP fork 原生编译、
  全部安装包构建及包内/实际安装验收步骤均 success。第二轮 Linux target closed /
  Windows SIGTERM 未在最终候选复现；原有断言与 45 秒夹具上限保留。

| 目标 | 安装包制品 | 验收制品 |
| --- | --- | --- |
| macOS ARM64 | `release-darwin-arm64` | `validation-darwin-arm64` |
| macOS Intel | `release-darwin-x64` | `validation-darwin-x64` |
| Linux x64 | `release-linux-x64` | `validation-linux-x64` |
| Windows x64 | `release-win32-x64` | `validation-win32-x64` |

八份制品共 **1,982,280,495 字节**。通过已有 `verifyReleaseCandidate`：严格核对仓库、
工作流、push tag、精确源码、整轮/源码/四原生作业和关键步骤成功、八份完整名称、
非空、未过期、同源码来源及 GitHub SHA256 摘要；额外核对四份截图门和 SDK 准备
均成功、publish skipped。回执见同名目录 `accepted-candidate.json`，API 作业与
步骤摘要见 `github-build-summary.json`。本机仅核验不可变制品元数据，未下载八份
ZIP 逐字节复核；不将其写成已经完成的验证。

安装包从该 run 的 Artifacts 手动下载。既有稳定 `v0.1.0` 仍指向 `154bc03`，
未覆盖其资产或更新清单；同版本不会触发更高版本更新。未合并 main，未安装到
192.168.3.21，未改写既有报错会话。当前提交/打包请求已完成。
