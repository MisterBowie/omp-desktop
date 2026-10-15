# M5三平台原生交付（2026-10-15）

状态：**M5功能与三平台测试包交付已由根独立接受**。所有5个native/publish jobs通过，根本机已完整下载全部9资产（1500824153B）并逐一比对GitHub digest、7载荷SHA清单、BUILD-RECORD的字节/摘要/源码/运行时固定坐标。证据为同目录release-audit.json、independent-review.json及自排除SHA256SUMS.txt。完整M6/M7继续。

源码候选`bdec50076f081d5d8042fe5a58912e7743a802fe`，分支`codex/m5-windows-package-local`；代码修复`e52ab74a9e903b6fe8eb4aec73c29de2894f15f7`，基线`34aeff2329bd34a3b98a6561894a9d3273343a43`。仅marker路径夹具quoting与自有中文/空格/引号项目路径强化，产品runtime/policy/fork无改动；本机RED→15/15与guard24/24见此前`M5-windows-package-local-20261015/`。

受控tag：[m5-test-20261015-bdec5007](https://github.com/MisterBowie/omp-desktop/releases/tag/m5-test-20261015-bdec5007)。原生run：[38671315205](https://github.com/MisterBowie/omp-desktop/actions/runs/38671315205)，所有5个job completed/success：绑定tag、macOS arm64、Windows x64、Linux x64、统一发布。

| 平台 | 包内Plan/Goal | 路径/运行时/停止 | 交付 |
| --- | --- | --- | --- |
| macOS arm64 | 15 pass / 0 fail / 0 skipped | 中文空格路径，18.3.0 / protocol2 / get_state，missing-gate精确拒绝，stopped/reaped/cleaned，leftover0 | DMG、ZIP |
| Windows x64 | 15 pass / 0 fail / 0 skipped | 同上；本机夹具修复已由Windows实际执行验证 | NSIS setup EXE、portable EXE |
| Linux x64 | 15 pass / 0 fail / 0 skipped | 同上；实际/proc子环境可读并断言 | AppImage、DEB、RPM |

CI中macOS与Windows无/proc子环境证据；隔离启动配置实际使用，但不把不可读写成已断言。上述stop证明该套包内验收的运行时回收，不冒充T23长子孙进程/异常退出覆盖。所有7个载荷+BUILD-RECORD.json+SHA256SUMS.txt共9资产；版本0.15.2、OMP18.3.0、fork36483311dfff67be7504f591974df93fc512a45a、patchLevel62bc57b+omp-desktop.5。测试prerelease、非latest、无更新feed，未覆盖旧m5-preview或失败tag。

## 验收边界

M5已接受的核心功能（860c2641）与三平台交付分别记录。M6/T21–T23、M7/T24仍未完成：实际安装后的Electron项目/消息/审批/工具/停止/恢复用户路径、独立图标/品牌/更新缓存/许可证装配、平台进程树与异常回收、日常示例任务/并发/长会话/故障、升级回退及三平台阶段包继续保留。未签名/未公证测试构建不称已正式签名。仅Cursor+Plan/Goal排除，ADR0306门与非Cursor严格契约保持。

## 原始记录

同目录native-ci.json是根从本机公共GitHub API读取的精确run/全部job与step状态；BUILD-RECORD.json与release-public-metadata.json来自已发布tag，其固定身份/版本/平台与代码清单比对。根全量资产下载与SHA复核已在release-audit.json记录；二进制留在本机review/release-download，不将1.5GB载荷提交Git。历史失败run与旧证据均保留。


根另从下载的224780296B Mac ZIP实际解包到自有中文/空格Applications目录：Info.plist的CFBundleIdentifier=net.misterbowie.omp-desktop、CFBundleDisplayName=OMP Desktop、Mach-O架构arm64。实际app-update.yml为MisterBowie/omp-desktop，但updaterCacheDirName仍为@pi-desktopdesktop-updater（M6/T22已知待修项）；未运行Electron用户流程，不用该inventory替代安装E2E。原始输出与复现脚本见macos-download-inventory.json、audit-macos-download.py。
