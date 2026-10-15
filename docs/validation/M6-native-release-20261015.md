# M6 原生安装与三平台发布验收（2026-10-15）

**M6 / T21–T23 已接受。完整 M7 / T24 及其三平台发布仍须完成。** 最新结论覆盖交接文档中早先的“运行中/未接受”；失败 tag、run 和原始证据保留。

验收源码 `438b389620217a551add62ae662c17b2e3562d21`，分支 `codex/m6-installed-isolation-local`。受控 [测试发布 m6-test-20261015-438b389](https://github.com/MisterBowie/omp-desktop/releases/tag/m6-test-20261015-438b389)，[原生 run 38695889572](https://github.com/MisterBowie/omp-desktop/actions/runs/38695889572) 的全部 8 个作业 completed/success：tag 绑定、三个轻量原生环境检查、三个原生打包/安装验证、统一发布。桌面 0.15.2，OMP 18.3.0、protocol 2、Bun 1.4.2；PI/OMP 参考与 fork 36483311、patch 62bc57b+omp-desktop.5 均未改。

根本机完整下载并读完全部 **12 个资产、1,497,063,033 B**，逐一核验 GitHub digest、SHA 清单、BUILD-RECORD、源码/run/tag、固定坐标与三份公开原始安装证明。7 个安装载荷保存在本机 `omp-local-m6-review-20261015/release-download/`，不提交到 Git；本目录归档原始压缩证明、元数据、摘要、截图、回读脚本与自排除的证据 SHA 清单。

| 平台 | 包内 Plan/Goal | 实际安装工作流 | 正常退出/最终残留 | 载荷 |
| --- | --- | --- | --- | --- |
| macOS arm64 | 15 pass / 0 fail / 0 skipped | 8/8 | 2 次 / 0 | DMG、ZIP |
| Windows x64 | 15 pass / 0 fail / 0 skipped | 8/8 | 2 次 / 0 | NSIS setup、portable EXE |
| Linux x64 | 15 pass / 0 fail / 0 skipped | 8/8 | 2 次 / 0 | AppImage、DEB、RPM |

实际安装工作流包括创建项目/OMP 会话、真实拒绝写入并保留原字节、批准一次执行真实写入、外部项目检查返回 42、Composer Stop 回收实际三级进程树、正常关闭/重启恢复原生 JSONL 且不重放、重启后新回合及默认数据隔离。根独立回读证明：每份历史有两个不同 write 调用及两个结果，恰好一拒绝一成功；关闭历史以前缀保留退出前历史，重开后与关闭历史逐字节一致。原生 HOME/cwd 正确；Windows USERPROFILE 位于自有运行根，PATH 使用分号。不是仅从验收器布尔值推断。

根又在 **macOS 13.4 arm64** 实际安装运行该公开 DMG（SHA b243c975…，非早期本地包），同样完成 8 项流程、2 次正常退出、最终零残留并清理自有根。`public-macos-installed/` 保留原始报告、截图、历史及应用输出。无全局 Bun/OMP 运行依赖不等于无外部项目工具：样例明确复制自己的 Node；Windows Bash 工具沿用 PI 的 Git for Windows 前提，未捆绑 Git。

## T21–T23 的覆盖与补充证据

- **T21 固定资源与冷缓存构建**：生产 release 入口固定 fork/patch/provenance，打包包内 binary/gate/目标依赖；三平台无全局 Bun/OMP 启动、版本/protocol/get_state、精确 missing-gate 拒绝、停止/回收/清理均通过。冷 Cargo 真实 RED→GREEN、冻结完整依赖图准备及 ASAR 原生路径见 [冷缓存检查](M6-cold-cache-native-preflight-20261015.md)。
- **T22 身份、品牌与声明**：独立 appId/profile/data/凭证命名/更新源与 cache；图标/8 语品牌；保留 LGPL/MIT/Bun 和冻结 Node/Rust 第三方原文，逐文件字节摘要。见 [身份品牌](M6-identity-branding-local-20261015.md)、[实际默认 profile](M6-default-profile-macos-20261015.md)、[实际 PI 0.15.0 并存](M6-pi-coexistence-macos-20261015.md)。并存证明与参考源码版本不同，未运行或改写用户原应用/配置。
- **T23 原生平台差异**：Windows 原生 HOME 逃逸已修复并由三平台检查重测；8.3 路径别名按物理身份校验。Windows 精确创建时间/镜像/handle 负对照与根外/相似前缀拒绝通过，优先正常退出，禁止杀外部进程。见 [原生 HOME](M6-windows-native-home-20261015.md)、[别名/清理](M6-windows-alias-cleanup-20261015.md)。Linux 实际 AppImage 安装提取；不冒称已执行 DEB/RPM 系统注册。
- **离线与崩溃**：Mac 运行时 kernel outbound denied + TCP EPERM 负对照通过；真实 GUI 拒绝代理离线启动通过；实际 Main SIGKILL 时三级工具进程全部自行结束，重启不重放，正常退出零残留。整个 GUI 的 kernel Seatbelt 测试受 Chromium 嵌套沙箱限制而失败，保留原证据，不声称该项通过。见 [离线/崩溃](M6-offline-crash-macos-20261015.md)。
- 本机完整 OMP 回归 **542/542、0 fail / 0 skip / 0 excluded**，参考源码依赖/生成物/原生绑定准备与早期错误环境结果均保留，见 [d2 本机验收](M6-d2-installed-macos-20261015.md)。后续 438 是验收器/工作流修复，公开包仍在 438 从源码新构建。

## 回读过程与边界

瞬时下载连接错误只重试缺失 ranges，最终 12 个完整文件全部核验通过。首次把公开 BUILD-RECORD 直接喂给内部验证函数时，因公开格式有意省略 sourceName 而失败；回读脚本按受控 PLATFORM_PAYLOADS 还原预期 sourceName 后，重新打开全部三个原始证明并通过，未从报告自报字段生成预期。早期摘要和原始 stdout 有继承 M5 的过时 scope 文案；最终 audit JSON 仅改正文案并说明，原有断言、SHA 与 verified 结果未改。

测试 prerelease 非 latest，无更新 feed；未签名/未公证。原生文件夹选择器、系统退出确认、全平台桌面快捷方式/系统注册没有在本轮自动化覆盖，报告明确 false。模型边界仅 loopback FakeProvider，未调用付费模型。仅 Cursor + Plan/Goal 排除，ADR0306 及全部非 Cursor 严格契约保留。

M7 必须另行完成真实隔离示例编码、并发项目、长会话、故障恢复、UI 差异/资源观察、版本升级回退、上游维护演练和用户交接，再交付并独立回读 M7 三平台包。M6 通过不代表整个目标完成。
