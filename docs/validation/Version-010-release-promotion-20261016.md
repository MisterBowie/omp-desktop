# 0.1.0 固定候选与原样发布（2026-10-16，进行中）

用户已授权“提交、推送并发布 v0.1.0”。产品源码固定为
`f8c0e5808224fbc59201258724462d362d5b7b07`，候选标签
`release-check-0.1.0-f8c0e58`，原生验收运行
[38845176146](https://github.com/MisterBowie/omp-desktop/actions/runs/38845176146)。
本页落盘时仍在执行，尚未创建稳定标签或发布公开更新清单。

固定 OMP fork `d648d27` 已非强制推送至用户自己的维护分支，并经 GitHub API
回读确认提交与树摘要。桌面源码已提交并推送；原默认模型及所有既有工作树保持原状。

## 已完成的本机候选验证

- 在固定 f8c0e58 上重新构建实际 0.1.0 DMG，再完整执行旧包项目保留、检查失败恢复、
  发现更新与新 GitHub 按钮；2 次正常退出，最终自有进程为 0。
- 完整 workspace 测试 exit 0；desktop 3,108 通过、0 失败、9 条件跳过；
  OMP runtime 540 通过、6 条件跳过。此为实际命令统计，未把跳过项记为通过。
- Rust host-core `cargo test -p host-core --locked`：606 通过、0 失败。
- 发布绑定/清单/真实 GitHubProvider：11 通过、0 失败/跳过；515 文档页及版本发布门通过。
  三份发布 YAML 和 29 段 Bash 语法已核对。

全量补查曾暴露两个旧夹具问题：签名脚本夹具漏复制许可证模块，图标检查仍匹配旧算法；
已在 f8c0e58 修复。源码态测试需要固定 PI/OMP 子模块、锁定依赖和原生 addon；补齐后
上述完整回归通过，CI 同样显式准备这些前提。首次沙箱运行无法监听本机测试端口，
随后在允许回环服务的环境重跑通过；没有因此跳过相关测试。

## 原样发布的边界

发布控制面作为后续普通提交保存，产品仍为 f8c0e58。晋升入口选择成功候选运行，
要求源码 SHA、固定工作流、四个原生作业中的实际构建/验收步骤及八份未过期资产一致；
再检出候选源码、复核真实安装包清单、合并 Mac feed、保存运行回执和原生证据。
只有此时才在候选提交创建 v0.1.0，并从完整 draft 发布为 stable/latest。
已存在的不同稳定提交拒绝覆盖；标签不移动。

共享发布器避免另行重建验收过的安装包。GITHUB_TOKEN 创建标签不会递归触发新的 push
构建，依据 [GitHub 官方事件说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)。
直接稳定标签构建与候选晋升共用一个发布器。发布后仍须回读公开资产摘要、三个更新
清单，并在本机实际公开 Mac 包中检查真实 GitHub 更新源；未完成前不记为交付完成。

未签名 Mac 使用 GitHub 手动更新；没有声称真实 Developer ID 自动安装已验收。
未调用 DeepSeek 或其它付费模型，不合并 main，不改写已有标签。

原始证据与摘要：[SHA256SUMS.txt](Version-010-release-promotion-20261016/SHA256SUMS.txt)。

发布前追加：处理 upload-artifact 的共同根目录布局，按唯一文件名原样暂存；Debian
`omp-desktop_0.1.0_amd64.deb` 仅重命名为 `OMP-Desktop-0.1.0-x64.deb`，字节保持不变，
从而纳入原有版本摘要命名空间。源路径、原始 SHA256 和发布名另有暂存回执。
新增重名、链接、旧版本与已有目录拒绝测试后，发布相关合计 14 通过、0 失败/跳过；
三份 YAML / 30 段 Bash 通过。证据归档采用确定性时间戳和 gzip header，允许安全重试。
