# 超长浏览器截图修复验证（2026-10-17）

## 结论与范围

按用户要求先检查 PI Desktop 与 OMP 官方源码，随后直接同步 PI Desktop 已有修复。
整页截图不裁剪，等比缩小至宽 1280、高 2048 CSS 像素以内，不放大小页面。
实际编码尺寸包含设备缩放比；2 倍屏的高度上限为 4096 像素。

这是本机源码交付，版本仍为 0.1.0；没有提交、推送、发布、更新远端已安装程序，
也没有重写用户的历史图片。已有超限图片仍需单独恢复。任意附件、原始 CDP 调用
和其他工具的图片不在本次捕获边界修复范围内；未调用真实模型验证或产生模型费用。

以上为最初修复阶段状态。用户随后明确授权提交 GitHub 打包，要求版本不变。
本次保持 0.1.0，并在原生工作流增加截图验证，Linux 使用 Xvfb，四目标均保留
生成图片及原始报告。独立 `release-check-0.1.0-*` 构建标记不会改写既有稳定 tag
或覆盖稳定发布；GitHub 构建结果必须单独验收，不以本机通过代替。

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
双轴边界或页尾完整性断言。未运行无关完整工作区/Rust 测试、`verify:ui:*` 或
Linux 原生安装验证；本次生产变化只涉及 Electron 截图参数。

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
