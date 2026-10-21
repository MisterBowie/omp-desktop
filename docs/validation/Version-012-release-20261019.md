# 0.1.2 发布记录（2026-10-19）

用户已授权提交本轮修复并正式发布 0.1.2。本次发布包含 B01–B05、B08–B10、B12
九项桌面/Pi 兼容修复，详见 [修复记录](Version-011-bug-fixes-20261019.md)。
B11 原生 OMP UTF-16 能力不在本次范围。

## 版本与兼容性

- 所有工作区包、Rust workspace/host lock、APP_VERSION 统一为 0.1.2。
- 八种应用内语言均新增 0.1.2 的五条说明，保留 0.1.1 与 0.1.0 历史。
- 按既有发布脚本刷新 models.dev 公开快照；无模型调用或真实费用。
- OMP 仍为 18.3.0 / `62bc57b+omp-desktop.6`，fork `d648d27bcf0db16caecb876142d891cf49a51bc2`。
- 存储 schema 仍为 22，0.1.1 → 0.1.2 无迁移。回退到 0.1.0 仍须恢复 schema 21 备份。
- npm 安全告警 61 → 1，prod 类型范围为 0；剩余构建链 sprintf-js 中危告警没有
  官方修复版本，未抑制。不能据 prod 范围推断全部打包依赖无告警。

## 本机验证与发布门

此前修复候选：12 个适用审计场景、458 桌面、774 agent-runtime、36 host-runtime、
646 Rust 和六种真实 Electron 截图通过。完整本机递归曾因未构建的参考启动器失败；
OMP 其余 549 项通过、6 项缺少捆绑资源跳过，历史失败保持记录。

0.1.2 版本化后的冻结安装、完整 JS 构建、桌面类型、lint、79 对中英规格检查、
497 项 shared 源码、38 项发布链路测试、新宿主构建及 12 个适用审计场景全部通过
（命令退出 0，审计零跳过）。Node 为 24.14.0、pnpm 为 10.34.5；桌面宿主使用
stable Rust 1.98.1 构建。此前修复阶段的 fmt/clippy 使用 nightly，不冒称运行过
本机未安装的 stable fmt/clippy。

固定候选 [39191848177](https://github.com/MisterBowie/omp-desktop/actions/runs/39191848177)
已整轮成功：重新准备固定 OMP 参考源码依赖，完成冻结安装、完整 JS/Rust 构建、
类型、lint、全部工作区测试、发布链路回归与 Rust 测试；macOS arm64/x64、Windows x64、
Linux x64 四目标均完成六种真实截图夹具、原生模块构建、安装包、包内严格检查与
实际安装流程验收。远程已完成本机未能执行的完整源码门和安装门；不改写本机
失败，也不将此前六项资源测试跳过计为通过。

使用现有 `verify-release-candidate.mjs`（Node 24.14.0，退出 0）接受八份非空、
未过期且 SHA256/源码绑定齐全的制品。候选标签为 `release-check-0.1.2-21969e58`，
产品源码为 `21969e58f7d97177795ce06f393e8853c45cfb20`。没有复用 0.1.1 安装包、
放宽来源或原生权限校验，没有调用付费模型或迁移用户数据。

## Windows 安装态缺陷复测

[39196263052](https://github.com/MisterBowie/omp-desktop/actions/runs/39196263052) 成功。
先核对已验收候选的 Windows ZIP 实际 SHA256，再从中提取 0.1.2 安装器并隔离安装；
全屏绘制、任务栏/窗口恢复、宿主 UTF-16 读取、PowerShell 输出/退出码、有序退出
五项全部通过，退出后无自有进程残留。单屏 CI（1 个显示器），未验收物理双屏。
宿主 UTF-16 通过不代表 B11 原生 OMP 工具已经支持。

验证控制提交为 `c124831d74cd811a58b90f82019932540ac55bf3`，只增加/更新验证工作流
和测试驱动的版本绑定；与产品源码提交的运行时代码、UI、包和 Rust 代码树相同。
不把验证控制提交或后续交接文档提交冒充安装包源码。

## 正式发布与公开资产回读

**已正式发布 [v0.1.2](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.2)。**
发布运行 [39196683475](https://github.com/MisterBowie/omp-desktop/actions/runs/39196683475)
成功，控制标签 `publish-v0.1.2-run-39191848177` 原样晋升同一候选。公开 Release
为 stable、非 draft，`latest` 返回同一 Release（416884992）。已通过 SSH 获取并
核对稳定 tag，准确指向产品源码 `21969e58f7d97177795ce06f393e8853c45cfb20`。

独立 [39197020014](https://github.com/MisterBowie/omp-desktop/actions/runs/39197020014)
在 CI 中完整下载全部 **30 项公开资产、1,988,212,725 字节**，逐项 SHA256/大小、
SHA256SUMS、BUILD-RECORD、源码/候选/原生来源回执均通过；八项更新安装器
SHA512/大小通过，五份更新清单通过，合并 Mac 清单实际字节一致。本机读取并逐项
比对了公开摘要与资产回执，未冒称本机完整下载约 1.99 GB 文件。

四目标制品摘要、全部公开资产摘要、Windows 五项结果、运行编号和本机门退出状态
见[结构化验收记录](Version-012-release-20261019.json)。公开独立证据：
[Windows 回执](https://github.com/MisterBowie/omp-desktop/blob/codex/published-bug-results-39196263052/docs/validation/Candidate-012-windows-39196263052.json)、
[资产回读回执](https://github.com/MisterBowie/omp-desktop/blob/codex/public-asset-readback-39197020014/docs/validation/Published-012-assets-39197020014.json)。

原始日志、截图和依赖缓存保持私有；其他工作树的已有改动保留。没有移动旧稳定
标签、合并本地 main、修改原生 fork 或迁移用户安装态数据。B11、物理双屏与剩余
构建依赖告警仍按上文边界记录；本次没有自动开展 T25-B 或 T27。
