# OMP Desktop 发布与维护检查单

当前 `0.1.0` 已发布：[稳定版](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.0)。
固定源码154bc03 / 原生run38862126801全部成功；发布run38869364763成功，
四目标（Mac ARM/Intel、Windows x64、Linux x64）各包内15项与实际安装8项通过。
本机公开ARM包真实GitHub更新检查通过，当前未签名/临时签名Mac为manual；
30份公开资产全量下载尚在续传核验，最终完整下载回执待归档。
固定运行时为fork `d648d27bcf0db16caecb876142d891cf49a51bc2` / tree `dab846754da313b09470a5d37aa1e255633d58cb`，
补丁 `62bc57b+omp-desktop.6`，包含默认编辑后LSP诊断。0.15.x首次切换0.1.0需手动安装。
来源、失败、重试、重复构建受控取消及当前回读见[0.1.0发布记录](validation/Version-010-release-promotion-20261016.md)。

以下为已接受的 **M7 测试分发基线**及历史维护证据，不表示0.1.0已经发布。

M7历史状态：M7/T24已接受（测试分发）。本表准入已由三平台原生run及根完整回读/公开Mac复测验证；
详见[M7最终记录](validation/M7-native-release-20261016.md)。M6 的最终基线为
`438b389620217a551add62ae662c17b2e3562d21` / `m6-test-20261015-438b389`。

| 检查 | 准入要求 |
| --- | --- |
| 源码 | 当前专用分支包含最新 origin/main；固定 PI/OMP 子模块，普通提交；精确 tag 与 run revision 一致 |
| 运行时 | 生产 dist 入口；受控 fork、patch、Bun与来源清单；缺 gate、错误版本/架构/摘要必须拒绝 |
| 原有契约 | 每平台真实包内 Plan/Goal 15/15、0 fail/skip；保留 ADR0306 与全部非Cursor严格契约 |
| 实际安装 | 每平台M6八项流程、两次正常退出、最终零残留；品牌/声明/隔离/停止/历史恢复 |
| M7日常 | 实际示例代码和项目检查、并发cwd、40回合、HTTP错误和恢复、原生历史无重放、新回合 |
| M7维护 | 精确公开旧版安装器→当前版→关闭备份还原回退；实际三个版本、相同路径/数据、三次退出零残留 |
| 原始证明 | `*-validation.json.gz` 与 `*-maintenance.json.gz`；公开截图、JSONL、报告及备份还原清单逐项摘要 |
| 三平台发布 | macOS arm64、Windows x64、Linux x64原生CI全部成功后统一prerelease；不设latest、不发feed |
| 根回读 | 完整下载所有公开资产；GitHub digest、SHA清单、BUILD-RECORD、source/tag/run/pins及原始证明重新核验 |
| 用户交接 | 安装说明、实际观察、限制、上游演练和回退记录更新；没有待执行关键项才完成目标 |

本机执行和测试使用 Node24.14.0、私有 pnpm10.34.5、Bun1.4.2；不修改用户全局默认工具链。
桌面 Rust stable 与 OMP 自身 nightly-2026-08-12 分开；参考子模块只读，产品在 `app/` 修改。
包内运行时来自受控 fork `36483311…` / tree `7ba57b6d…` / base `62bc57be…`，版本18.3.0，
patch `62bc57b+omp-desktop.5`。构建前通过 `OMP_SIDECAR_SOURCE` 明确选择自有干净fork；
不得用临时bunx/latest或全局omp替代生产入口。

## 维护演练

本机源码演练重新应用历史18.2.7补丁并反向回退，升级到18.3.0当前补丁后重建出精确fork树，
当前171项上游测试通过，回退源被当前发布准入门拒绝，再返回受控fork通过。
这是源码/补丁维护演练，未运行历史18.2.7二进制；详见
[M7投影修复与源码演练](validation/M7-provider-error-projection-20261015.md)。
实际应用升级与关闭数据备份回退见 [M7本机安装](validation/M7-installed-macos-local-20261015.md)。

后续升级先检查 PI 对应实现和测试，再看 OMP 文档/源码，最后补自己的适配；每次固定新source、
更新patch/manifest及日期化记录，重建并重跑协议、权限、历史、停止和严格Plan/Goal门。
存在schema变化时先验证备份恢复及旧版读取边界，再声明回退支持，不能沿用本次相同schema结论。

## 当前本机观察

macOS13.4 arm64、实际公开M7 DMG（产品46e7bf7、验收器5c41843置前自有窗口）、本机假模型：
40次Composer回合耗时最小219ms、中位223ms、最大252ms；包括测试驱动UI往返，
不代表真实模型推理。7个Electron进程working-set在4个采样点相加约895–1102MiB，
共享页可能重复计数，不包括外部OMP/Rust host，也不是系统峰值或与PI的性能对比。
三平台原生CI和根本机的原始采样均随[M7证据](validation/M7-native-release-20261016.md)保存。

UI实际截图显示OMP品牌、复用的侧栏/Composer/工具卡、两个项目并行、长会话及错误行。
保留的限制：未签名/未公证；原生选择器/退出确认框、系统快捷方式/DEB/RPM注册、真实付费模型、
macOS Intel/Windows ARM64没有被当前自动化证明覆盖。40回合未声称触发上下文压缩或长时间压力测试。
本机早期ASAR缓存与验收器准备失败、一次最后空闲判定超时均保留，不用后续通过覆盖原始事实。

Linux CI实际截图有中文目录名缺字，字体栈与固定PI一致、依赖系统字体；不声明已验证runner的CJK字体。
本机DOM验收会显示/置前精确核验的自有窗口，并等待新文档load；隐藏窗口的原生回合可以完成而DOM暂停绘制，
不能用后台DOM的瞬时空白断言消息丢失。可见性对照和旧失败均保留在[窗口复审](validation/M7-native-window-review-20261016.md)。
