# M6/T22-A 本机身份、品牌与声明（2026-10-15）

状态：**局部代码和定向检查完成；完整M6仍进行中**。本机分支codex/m6-installed-isolation-local、工作树omp-desktop-local-m6，起点为已接受M5证据e1c034e；M5实际tag仍为m5-test-20261015-bdec5007。本次测试源码清单见同目录source-candidate.json；不改变受控fork36483311/.5、固定PI/OMP子模块或Cursor/非Cursor权限契约。

- 下载的M5 Mac包实际app-update.yml仍是@pi-desktopdesktop-updater。先用真实electron-builder26.15.3配置加载器写回归判RED，再以build.extraMetadata.name=omp-desktop修正，实际AppInfo缓存变omp-desktop-updater；workspace包名、协议和host文件名保持兼容。
- 8种UI语言、HTML标题、设置页、默认Header示例、MCP客户端/回调和诊断文字使用当前OMP身份。外部导入来源、上游作者/市场目录归属、内部工具id和旧wrapper识别标记保留。
- 新建原始矢量omp-mark.svg，以同一几何生成主图、两主题标记与透明模板，派生ICO/ICNS/PNG和原布局DMG背景。已查看主图/DMG，校验实际native ICNS、尺寸及模板alpha/单色；没有重写布局/交互。
- Resources/licenses保留PI LGPL、OMP MIT/原生聚合声明、固定Bun1.4.2说明、原始来源和摘要。发布入口在sidecar预检后/builder前生成冻结Node+目标Rust依赖声明，失败即不打包。原始字节可按inventory偏移恢复；809个Node+106个Rust组件、968份文件逐份SHA核对。未发布的notice文件仅保留元数据，不把构建依赖清单说成全部都已分发。
- 定向14文件最终139/139、0fail/skip；typecheck/lint/docs/release-docs通过。原始输出及环境/缓存限制见同目录。第一次导入门测试因新工作树尚无shared/dist失败，build:js后已实际重跑通过；不会把初次失败改写为通过。

下一步：普通提交本子任务后，从该代码构建真实Mac DMG/ZIP，核对实际Resources/ASAR/更新cache/声明；再完成真实安装的项目→消息→拒绝/批准→工具→停止→重启恢复，随后原生Windows/Linux差异与完整M6三平台包。完整M7/T24及其三平台包保留。现有结果不冒充这些未执行项或签名/公证。
