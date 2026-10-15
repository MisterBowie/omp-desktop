# M5 Windows 原生测试包：本机路径夹具返修

日期2026-10-15；代码提交`e52ab74a9e903b6fe8eb4aec73c29de2894f15f7`，父34aeff23。用户已恢复完整目标并要求本机根模型执行；DeepSeek服务恢复由用户通知，本轮没有调用该服务。

## 实际失败与定位

原native run37135789443的Mac/Linux均15/15；Windows14/15、0skip，失败仅为mixed[ bash,SubmitPlan ]整批拒绝后ordinary tool的control marker不存在。精确原始日志与三平台reports已在本机completion-audit保存。

先参考固定PI0111e306的`scripts/e2e-plan.mjs:87–104`：每个marker路径是quoted POSIX参数，其他shell另按dialect编码。OMP62bc的procmgr说明Windows外部shell发现用于PTY/ACP，默认bash工具执行在embedded brush-core；本轮不改其选择、权限或生产解析器。当前夹具五处裸`touch $path`会让POSIX词法吃掉Windows驱动路径反斜杠。真实本机Bash参数探针证明未quoted路径失真，现有shellQuote保持单参数（这是Mac解析证据，不冒充native Windows）。

为同一个真实bridge/gate/host E2E用例建立自有root下的“项目 with spaces 'quoted'”目录，旧命令真实RED：exit1、ordinary tools still execute after a rejection断言false，与原Windows失败边界相同。`red-case-source.patch`保留其相对于34ae的精确路径场景变更。

## 修复与实际验证

仅五处marker命令使用现有shellQuote，完整批次计数、兄弟零副作用、非terminate、ordinary tool继续执行、后续请求与全部其他15项断言都保留。中文/空格/引号项目路径在全部平台都实际执行；没有Windows skip、platform分支或缩减套件。

本机fresh host-core/build:js通过；fixed fork.5独立编译出218367872B运行时，SHA dbb6ef2acf0bd757a8a8c78478c9c52adeab9eebbe132bea1579e864e6e39633，与此前根Mac.5产物字节一致；gate SHA3dd09910f71ee63f2b1ba13e06d8655f9b73af5e88f2c4dd29a92e0f11cd528b。原缓存.3未用于验收。Darwin native addon由相同未变Rust/绑定基线缓存复用，当前.5改动的嵌入脚本实际重编译；不宣称重新编译该addon。fork源工作树仍干净。

真实compiled.5/Host/production bridge全套15/15、0fail/skip/cancelled（FakeProvider，仅loopback，无收费模型）。发布guard及真实pnpm参数边界24/24、0skip。原始输出、完整provenance、命令与摘要在本目录；SHA256SUMS只自排除清单本身。

## 范围及下一步

本机本轮是macOS arm64的staged Resources验证，尚非electron-builder安装输出，也不是native Windows证明。下一步根review后正常push此新分支，在最终提交新建唯一m5-test-* tag，完整3native lanes实际通过才统一发布。旧tag/原失败run保留，main与受控fork固定不动。T21整体/T22/T23/T24/M6/M7仍需完成；只排除Cursor+Plan/Goal，其他严格契约持续。
