# M6 冷缓存与原生检查修复

首个候选 `m6-test-20261015-f6dba8b7` / run38684841320 未通过：Windows 已通过
打包、包内运行时和 15/15 Plan/Goal，但安装观察器调用 ASAR 时使用硬编码 `/`，
原生 Windows 无法解析 `out/renderer/index.html`。已改用原生 `path.join`；这属于
观察器故障，不能推断产品工作流已失败或已通过。macOS/Linux 停在打包，公开注释
只有退出码；没有取得完整日志，不将下列本机复现冒称为远端错误原文。发布 skipped。

本机用全新的自有 Cargo home/target 运行实际 `cargo build --release --locked -p
host-core` 成功，紧接着实际声明生成器因离线缓存缺少 `fastrand 2.5.0` 失败。
同一缓存执行 `cargo fetch --locked` 后，原声明生成器通过：915 组件、968 原文文件、
2,849,500 字节。所有命令仅在本机运行；未连接模型。Cargo.lock 未变。

产品所有 pack/dist 入口共用的 `build:host-release` 现先 fetch 完整锁定依赖，
再执行锁定发布编译。收集器仍离线执行并按原文保存，不削减开发或跨目标清单。
新增本机 HTTP 稀疏仓库回归用真实 Cargo 编译普通依赖，让开发依赖保持未下载，
然后执行产品原命令：修复前准确报缺少开发 crate，修复后声明收集成功，逐字节验证
两份许可、锁文件不变。该回归与声明、真实 builder 身份测试共 6/6、0skip。

发布/安装观察回归 42/42、工作流及真实 pnpm 参数回归 10/10，均 0skip。
修正后的观察器重新读取实际 Mac 包，身份、ASAR、915 组件声明全部通过。

为在耗时原生编译前得到平台证据，M6 新增三平台轻量检查：直接运行生产环境策略，
用原生 Node 检查真实 homedir、PATH 分隔及 Windows SystemRoot。任一检查失败即
阻止全部构建与发布，错误使用限定长度的公开注释保存。正式打包失败也保留退出码
并注释输出末尾，不再只有无信息的 exit 1。本机 Mac 检查通过；Windows/Linux 的
新检查待原生运行，不以模拟结果宣称通过。M6 和 M7 仍未完成。

原始证据及摘要见同名目录，SHA256SUMS 自排除。保留全部旧 tag/run。
