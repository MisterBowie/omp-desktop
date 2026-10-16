# OMP Desktop 使用说明

本项目在 PI-Desktop 界面基础上接入完整 OMP 运行时。`0.1.0` 已完成本机实现，
正在四目标原生验收，稳定版尚未发布。上一份公开测试版仍为
[M7 0.15.3-m7.1](https://github.com/MisterBowie/omp-desktop/releases/tag/m7-test-20261015-46e7bf7)。
正式发布后从 [OMP Desktop 下载](https://github.com/MisterBowie/omp-desktop/releases/latest)
选择对应平台；该地址属于本项目。

## 安装与开始使用

| 平台 | 测试产物 | 已执行的安装路径 |
| --- | --- | --- |
| macOS Apple Silicon / arm64 | DMG；ZIP 为另一份分发格式 | DMG 内实际应用复制后运行 |
| Windows x64 | setup EXE；portable EXE 为另一份分发格式 | NSIS 安装器实际安装后运行 |
| Linux x64 | AppImage；另提供 DEB/RPM | 实际 AppImage 提取后运行 |

这是未签名测试分发；Mac 未公证。Mac 首次打开的说明随 ZIP 一起提供。M6 已完成上述
三平台安装流程；M7三平台的安装、日常使用和真实升级回退也全部通过，根已完整回读公开资产及原始证明，见[M7验收](validation/M7-native-release-20261016.md)。没有用构建成功代替安装验收，
也没有把 DEB/RPM 系统注册、portable 的独立用户流程或其他CPU架构写成已验证。
Windows 的 Bash 工具沿用 PI 的 Git for Windows 前提；项目本身使用的语言工具仍由项目提供。
Linux使用系统sans字体；CI截图的中文项目名出现缺字方框，未证明CJK字体在该runner可用，
中文路径的实际操作/隔离已通过。需要中文显示时，系统应提供相应CJK字体；产品没有声明捆绑该字体。

1. 打开自己的项目目录，创建 OMP 会话；会话绑定创建时的项目、引擎和运行时。
2. 在提供方/模型设置中配置自己的受支持 HTTP 模型。普通验收只使用本机假模型，
   不预置或调用真实模型账号；当前 DeepSeek 服务恢复由用户另行通知。
3. 通过 Composer 发消息。工具审批会在执行前显示；拒绝、批准一次、自动权限是不同选择。
4. 用 Stop 结束执行中的回合。应用保留原生历史；重新打开会话读取历史不会重新执行工具。
5. 可以切换到另一项目继续工作。后台会话的相对路径仍绑定它自己的项目。

## 编码时的 LSP

`0.1.0` 候选已包含此前 `0.15.3-lsp.1` 的修复，会在写入和编辑匹配语言的代码文件后自动获取 LSP 诊断，
在工具完成前返回给模型，并在 Write/Edit 工具卡中显示。旧公开 `0.15.3-m7.1` 的
编辑后检查默认关闭，Write 卡也会遗漏诊断；该旧测试版尚未被稳定版替换。

项目需要可运行的对应语言服务器和正确的项目根标记，例如 TypeScript 项目的
`package.json` / `tsconfig.json`。OMP 保留原生自动发现和 `lsp.enabled` 开关；
没有服务器时，工具注册本身不能提供语义分析。本次不自动安装各语言服务器。

运行时使用隔离的 HOME 和 PATH；NVM 等用户 shell 路径不会直接继承。可以在所选
项目根的 `.omp/lsp.json` 中明确指定本机解释器及服务器，示例中的路径应替换为实际路径：

```json
{
  "servers": {
    "typescript-language-server": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/typescript-language-server/lib/cli.mjs", "--stdio"],
      "rootMarkers": ["package.json", "tsconfig.json"]
    }
  }
}
```

TypeScript 编译器需与服务器一起安装。修改服务器配置后重新建立运行时会话，或使用原生
`lsp reload`；服务端状态、诊断、定义、引用等功能可通过 `read xd://lsp` 发现。
自动写入/编辑诊断由运行时执行，不要求模型每次再主动调用一次 `lsp diagnostics`。
语义导航工具的选择仍由模型决定，不保证每一回合都产生独立 `lsp` 工具调用。

本次真实 TypeScript 服务端、安装包界面和重启历史的验证记录见
[LSP 本机专项验收](validation/LSP-coding-local-20261016.md)。

## 与 PI 界面的关系

布局、Composer、审批卡、侧栏和工具展示继续复用 PI 结构。应用名称、图标、appId、更新来源、
profile/数据/凭证命名已独立；不会自动迁移或覆盖现有 PI/OMP 用户配置。内部包名和原作者、
许可证声明保留。OMP 原生会话是历史来源，桌面保存索引和显示投影。

OMP 特有工具和子代理结构通过适配层显示；没有专用展示的结果仍可能使用通用工具卡。
子代理的单独停止等未支持入口遵循能力拒绝，不伪装为可执行能力。支持范围和证据见
[任务看板](04-task-board.md) 与各阶段验收记录。

Plan/Goal 仅在已经验证的非 Cursor 路线开放，保留整批工具零副作用等严格契约。
**Cursor + Plan/Goal 明确不支持并拒绝**；桌面当前也没有接通 Cursor 传输。

## 0.1.0 的版本重置与更新

从 `0.15.x` 测试版首次切换到 `0.1.0` 需要手动安装；版本序列重新开始，应用不会自动降级。
本机实际覆盖安装已验证原有 OMP 项目保留。后续版本在设置/版本入口手动检查更新，
更新来源固定为本项目的 GitHub 稳定发布，历史测试版不会被当作稳定更新。

| 安装形式 | 更新方式 |
| --- | --- |
| 未签名或临时签名 macOS | 检查 GitHub 后打开下载页，手动替换 |
| Developer ID 签名 macOS | 下载进度与重启安装；当前未声称真实签名包已发布 |
| Windows NSIS 安装版、Linux AppImage | 应用内下载与安装/重启 |
| Windows portable、Debian、RPM | 检查后手动下载 |

Mac 未公证版本首次启动如被系统拦截，按 ZIP 中的 `OMP-Desktop-macOS-opening-help.txt`
操作。更新检查失败可以重试；只下载到完整安装包后才允许触发安装。

## 备份、升级与回退

先完整退出应用，再备份整份 OMP 数据和 profile，保留其中的凭证材料和文件权限，
不要只复制 SQLite。产品数据默认在用户 HOME 的 `.omp-desktop`；Mac 默认 profile 已实测为
`Library/Application Support/OMP Desktop`。其他平台的 profile 由系统 Electron userData 位置管理，
测试运行报告记录其实际路径；测试中的自有 `--user-data-dir` 不是用户默认路径的证明。

M7 人工演练使用固定公开 M6 `0.15.2` 安装包，实际替换为 `0.15.3-m7.1`，在同一 profile/data
读取历史并完成新工具写入；关闭后恢复先前备份，再实际运行 `0.15.2`。备份和还原清单必须
逐文件相同，历史读取不能增加模型请求，旧工具不能重放，回退后仍可发送新回合。

恢复备份会让应用历史回到备份时刻；项目文件继续保持实际文件状态。需要回退项目代码时，
由项目自己的 Git/备份处理。该演练使用相同 OMP/schema，不能据此推定任意未来版本都可降级；
测试包没有发布自动更新 feed，因此这里验证的是人工安装包和数据备份流程。

## 故障与维护信息

提供方失败应保留错误行和诊断，服务可用后可发送新回合。M7 修复了原生401错误在历史刷新时
变成成功空回复的问题。断连重试和恢复已用真实本机HTTP边界验收；不据假模型断言真实服务质量。

维护所需的固定版本、构建命令、升级演练及回退证据见 [发布检查单](06-release-checklist.md)。
当前观测覆盖有限示例与40回合会话；资源采样和真实UI截图随维护证明保存，不是通用性能基准。
