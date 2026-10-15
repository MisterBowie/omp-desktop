# M6 原生安装发布门与本机验证（2026-10-15）

本批实现 M6 受控三平台发布门，**不表示 Windows/Linux 已通过，也不表示 M6/M7 完成**。本机产品安装包来自 `de691ca`；工作流提取步骤运行时 HEAD 为 `09660ba`，发布通道改动尚未提交，原始结果和脚本由本批保存。

- 入口只接受 `m5-test-*`/`m6-test-*` tag push，同一 source revision 和固定 fork/patch；不开放任意 tag、分支 push、manual dispatch 或尚未具备门的 M7。M5 既有三平台、包内运行时和 Plan/Goal 门保留。
- M6 强制每个原生平台对实际 DMG/NSIS/AppImage 运行完整安装流程；Windows 测试故障清理使用钉住 HANDLE 的出生时间和自有路径校验，Linux 使用真实 Xvfb 显示。只构建成功、只传 Resources 或重用 M5 报告不能发布 M6。
- `--installed-report` 强制绑定源码/平台/架构/产品版本/安装器文件名/字节/SHA、8 项工作流、两次已回收退出与最终零进程观察。独立 updater 身份、声明摘要、默认数据根及原生恢复一致性都必须成立。
- 新增公开、限大小的 `*-validation.json.gz`，包括实际报告、7 张 PNG、退出前/后/恢复后原始记录和退出输出；逐文件 SHA，整个证明再与安装器摘要、build-record 和 Release SHA 关联。装配再次读取原始证明，拒绝仅改摘要或原始记录字节。
- 发布仍等待所有三平台成功；不发布 feed/blockmap、不设 latest、不覆盖旧 preview。只有 publish 作业有 contents:write。条件输出为空时不会把上传路径变成 `/*`。

实际验证结果：

1. 新旧交付门及侧车/发布入口套件 **49 pass / 0 fail / 0 skipped**。拒绝面包括缺失安装证明、来源/安装器摘要错误、步骤缺失、历史变化、进程残留、伪造摘要/原始证明以及不完整平台集合。
2. 从真实 YAML 提取 Mac 原生安装步骤，在本机逐字执行（只代入平台和版本），完整 8 项安装流程通过，退出码 0；同一 `de691ca` DMG，实际报告 HEAD `09660ba`，无全局 Bun/OMP 路径或数据覆盖参数。
3. 同一实际 Mac Resources 的生产运行时验收通过：omp/18.3.0、protocol 2、get_state、精确 missing-gate 拒绝、stopped/reaped/cleaned、leftoverRuns 0。Mac 无 `/proc`，裸运行时 verifier 未观察子环境，不将其写成已观察；实际安装工具的 HOME/cwd 则由外部项目进程真实回传。
4. 同一包内 sidecar/gate 的既有 Plan/Goal 套件 **15 pass / 0 fail / 0 skipped**，130.30s。
5. 用上述真实 Mac 安装报告、实际两份安装载荷、运行时及 15 项报告执行生产 staging，成功产生 DMG、ZIP、公开证明三项记录。这里只是本机 `m6-test-local-verification` 命名验证，未创建该 tag、未发布 Release。
6. `docs:check`、发布文档一致性、YAML 解析和 diff whitespace 均通过；实际构建为 unsigned/unnotarized 测试通道。

`app/scripts/installed-acceptance-record.mjs` 是证明消费边界，`test-release-stage.mjs` 是阶段枚举；原始证据和 SHA 在同名目录。Node/Python 观察不会读取其他进程的参数或环境；公开证明只来自本次自有假模型项目，没有数据库或真实凭据。

原生文件夹/退出确认框、系统快捷方式注册、签名/公证和付费模型兼容性未由此证明。下一步是提交本批后建立受控 M6 候选，执行三平台原生 CI；实际失败必须先保留 RED，再按 PI→OMP→自定义顺序处理。完整 M7/T24 及其三平台包继续保留。
