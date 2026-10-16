# OMP Desktop 0.1.0 与 GitHub 更新本机验收（2026-10-16）

本机代码、Mac arm64 包和更新路径验证已完成。用户已明确授权提交、推送、同步固定
OMP fork、三平台构建验收及 v0.1.0 稳定发布。远程阶段正在执行，尚未声称公开更新源
已激活。先通过不可移动的 release-check 候选标签验收，再在同一提交创建稳定标签；
后续远程结果另行归档，下面保留本机阶段的实际证据。

## 本轮实现

- 当前 16 个版本入口统一为 `0.1.0`，应用内八语言更新记录从该版本开始。
  重置前记录保留为 `PRE_RESET_CHANGELOG`，协议/schema、数据目录和凭据命名不变。
- 下载、更新、文档入口、远程主机资源和反馈统一到
  [MisterBowie/omp-desktop](https://github.com/MisterBowie/omp-desktop)。历史 PI 来源身份保留。
- 实际 Mac Developer ID 签名决定更新能力。未签名/ad-hoc 包检查并打开 GitHub，
  不自动下载或安装；签名 Mac、Windows NSIS、Linux AppImage 保留下载安装流程。
  首次从旧 `0.15.x` 测试包切到 `0.1.0` 使用手动安装，不开启自动降级。
- 新增根 `.github/workflows/release.yml`：两种 Mac 架构、Windows/Linux x64 原生构建；
  包内运行时、15 项严格 Plan/Goal 和实际安装流程通过后才进入发布。
  校验安装包 SHA512/体积、远程主机 SHA256，合并 Mac 清单，再将完整 draft 发布为 stable。
  发布后回读 GitHub 的 latest、资产摘要和三个公开更新清单。
- 发布用自己的 Apple 凭据与 team；配置 `MACOS_REQUIRE_SIGNING=true` 可阻断签名密钥
  缺失的后续版本。未配置签名时，Mac 包明确使用 GitHub 手动更新。

源码工作树：`/Users/vv/Documents/对话/omp-desktop-v010-updates`，
分支 `codex/v010-github-updates`，基础 HEAD `215028e`；最新 `origin/main=a23bfb9` 是其祖先。
继承已交付的 π 图标和 LSP 修复；没有修改原图标、LSP、主检出及用户默认模型工作树。
本轮修改尚未提交，源文件摘要见 [source-inputs.json](Version-010-github-updates-local-20261016/source-inputs.json)。

## 实际验证

| 验证 | 结果 |
| --- | --- |
| 更新控制器、现有更新契约、超时、主机下载、签名/公证和清单测试 | 37 通过，0 失败/跳过 |
| 版本历史、应用身份和反馈共享模块 | 17 通过 |
| 真实 electron-updater GitHubProvider，HTTP 边界夹具 | 2 通过；新稳定版本优先，缺失 stable 时不退到旧测试包 |
| 反馈与 SSH/bootstrap 消费路径 | 25 通过 |
| 实际 DMG 的版本重置和更新按钮 | 旧项目保留；失败检查→重试发现 0.1.1→打开新 GitHub 链接；2 次正常退出，最终自有进程 0 |
| 最终 Mac ZIP/DMG 更新清单 | 实际产物 SHA512/体积匹配，Mac 清单合并通过 |
| Desktop typecheck、lint、版本发布门、文档、diff | 通过；79 规格对、515 文档页 |
| 根发布工作流 | YAML、25 段 Bash 语法、引用脚本与根 issue forms 检查通过；尚未远程执行 |

控制器回归在旧实现上为 1 通过/4 失败，再修复为通过。只有 Electron、更新引擎和 OS
签名/浏览器边界使用测试替身，控制器及内部 URL/超时/共享逻辑使用真实实现。
GitHubProvider 测试执行锁定第三方解析器，网络返回受控 Atom/latest/清单，未伪造解析结果。

实际安装流程先启动此前 `0.15.3-icon.1` DMG，设置项目、正常退出，再安装并启动
当前 `0.1.0`，确认同一项目仍在。以真实菜单/侧栏检查按钮访问本机更新清单服务，
从 503 恢复到 `0.1.1`，可更新提示出现；实际按钮交给 OS 浏览器的 URL 是
`https://github.com/MisterBowie/omp-desktop/releases/latest`。仅该 OS 边界被记录器替换，
不打开用户浏览器。未签名 Mac 未请求夹具 ZIP，验证没有虚假的自动安装入口。
未调用模型，临时 HOME/profile、已有 PI/OMP 哨兵和用户数据隔离保持完整。

![真实安装包的更新提示](Version-010-github-updates-local-20261016/02-update-available.png)

## 本机产物与发布前置

`app/apps/desktop/release/OMP-Desktop-0.1.0-arm64.dmg`：223,286,300 字节，SHA-256：

```text
7d750194fbc47c13323f0ac6e94f9ab93848b4d77fbd83fe1f743e32d78d1e6f
```

同目录 ZIP：222,240,395 字节，SHA-256：
`b8b5a1d1820fb2e1169a0b50fc5873a9fe59231f8b4ed1f90f858e809a64dbb2`。
`latest-mac.yml` 为 electron-builder 从这些真实字节生成，来源与校验见同目录原始报告。
原生 OMP 仍固定 `d648d27` / 补丁 `.6`，其二进制与 LSP 验收版相同。

只读 GitHub 核对显示当前公开资产仍是旧测试预发行，没有本轮稳定更新清单；固定 OMP
提交 `d648d27` 的远端查询返回 422 / No commit found。正式流水线必须先能取得该提交。
应先推送本地已固定补丁，再提交并推送本轮桌面源代码和 `v0.1.0` 标签；不改写旧标签，
不合并或覆盖用户旧 main。新工作流仅在全部四个原生目标通过后发布完整 stable。

本轮未运行 Windows/Linux 原生构建、远程发布作业、完整 OMP/LSP/PlanGoal 工作流，
也没有真实 Developer ID 的 Mac 自动替换验证。签名控制器的进度/下载完成/退出交接已测，
真实 Mac 自动安装仍需发布者自己的签名证书。没有将本机服务夹具冒称 GitHub 已上线。

证据清单：[SHA256SUMS.txt](Version-010-github-updates-local-20261016/SHA256SUMS.txt)。
压缩报告为完整 JSON/日志，`.mjs.txt` 是原执行脚本副本；原始执行目录为
`/Users/vv/Documents/对话/omp-update-review-20261016`。
