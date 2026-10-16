# 彩色像素 π 图标本机交付（2026-10-16）

已按用户提供的参考图完成：黑色圆角底板、紫蓝到青色的阶梯渐变横梁、青色/洋红竖笔、
左侧棋盘格像素尾部。图标不带模型名称文字。同步应用 PNG/ICNS/ICO、透明渲染标记、
单色 macOS 菜单栏模板、文档标志及 DMG 背景。

![图标预览](Pi-gradient-icon-local-20261016/pi-icon-preview.png)

## 源码和本机产物

工作树 `/Users/vv/Documents/对话/omp-desktop-pi-icon`，分支 `codex/pi-gradient-icon`。
基础 HEAD `215028eaee89084018230341625abf415f080644` 包含此前本机 LSP 修复，
`origin/main` `a23bfb9befea327e7924efd3004e030a11b587d2` 是其祖先。
本次修改留在专用工作树，未创建提交、标签、PR，未推送、发布或合并 main。
打包时的未提交源码差异以本机 `omp-icon-review-20261016/product.patch` 保存，
摘要见 [package-review.json](Pi-gradient-icon-local-20261016/package-review.json)。

主图形为 `app/apps/desktop/build/omp-mark.svg`；`app/scripts/make-brand.py` 从受控
SVG 矩形直接绘制彩色标记，不依赖字体或外部图片生成服务。随后运行 `make-icon.py`
与 `make-dmg-background.py` 派生各平台资源。相关英文/中文规格和 E2E-044 已同步。

本机版本 `0.15.3-icon.1`，16 个既有版本入口一致。Mac arm64 安装包：

`app/apps/desktop/release/OMP-Desktop-0.15.3-icon.1-arm64.dmg`

223,499,768 字节，SHA-256：

```text
4b0bac0b2dd47dd235af9af19fbcb1f573832f259435a72498cc2edf4e4b03fe
```

同目录另有 ZIP。原生 OMP fork 仍为 `d648d27` / 补丁 `.6`；二进制 SHA-256
`008c850b3f75c5a7682a83050cf145bc2fc63e3bee85daa00fb582857729f688` 与已验收 LSP 包一致。
原 LSP/M7 工作树、主检出和用户默认模型的 6 处修改/2 个新文件均保持原状。

## 实际验证

| 检查 | 结果 |
| --- | --- |
| 既有 development-branding / renderer-branding / packaging-footprint | 21 通过，0 失败/跳过 |
| 同工具链重复生成 | 12 项资源摘要完全一致；Python 3.12.0 / Pillow 12.1.0 |
| 图像格式与几何 | ICNS 解码逐像素等于母版；ICO 含 16/32/48/64/128/256 六档；透明角、散点、菜单栏单色、主题/文档派生通过 |
| 人工查看派生预览 | 16–256px、浅深背景均已查看 |
| Desktop 类型检查 / 文档检查 / diff 检查 | 通过；79 规格对、514 文档页 |
| 本机锁定构建与 dist:mac | 通过；DMG 和 ZIP 均生成 |
| 实际 DMG 安装、启动和资源检查 | 安装元数据、绑定 ICNS、菜单栏资源与源码摘要一致；浅深主题 PNG 数据一致；正常退出 1 次，最终自有进程 0 |

安装检查使用独立 HOME/profile 与含中文、空格、引号的自有目录，不发送模型提示词。
通过 `BrandLogo` 现有 `data-theme` 观察器检查两份内联 PNG。macOS 原有 CSS 隐藏
侧栏头部品牌，验证记录明确保存 `cssWidth=0`/`parentDisplay=none`；没有强行显示该标志，
也不将资源加载检查冒称可见侧栏、原生 Dock 绘制或系统主题跟随流程验证。

前四次检查器尝试因中文 URL 路径、既有隐藏规则、CSP 拒绝 `fetch(data:)`、固定主题偏好
与系统主题跟随的区别而调整。四次失败原始报告保留，均正常退出、零自有残留；
最终直接核对既有内联 PNG，不改产品布局、CSP 或主题设置逻辑。第一次沙箱内 `iconutil`
失败，核对 PNG 尺寸后使用本机图像服务重新生成成功。

这是静态图标与派生生成器修改，使用已有品牌测试及资源/安装验证，没有新增镜像实现的单测。
未重跑完整 OMP、严格 Plan/Goal、真实 LSP 工作流，也未构建 Windows/Linux 原生安装包；
此前专项验收继续作为这些未修改功能的证据。本包为未签名/未公证的本机测试产物。
未调用 DeepSeek 或其他付费模型。

汇总见 [acceptance.json](Pi-gradient-icon-local-20261016/acceptance.json)，
原始报告及日志见同目录；完整清单为 [SHA256SUMS.txt](Pi-gradient-icon-local-20261016/SHA256SUMS.txt)。
