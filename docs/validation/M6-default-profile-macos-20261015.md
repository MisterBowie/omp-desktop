# M6 Mac 原生默认 profile 验证（2026-10-15）

实际本机 M6 DMG（产品构建 `de691ca`）在未传 `--user-data-dir` 或数据目录覆盖参数时，选择的 Electron `userData` 为自有 HOME 内 `Library/Application Support/OMP Desktop`，产品数据为 `.omp-desktop`。原生默认身份的运行验证通过，exit 0；不是只读配置字段推断。

为避免碰触用户真实目录，先在明确指定的临时 profile 下启动同一安装副本，额外使用测试环境 `CFFIXED_USER_HOME`，只读确认原生 `app.getPath("home")`/`app.getPath("appData")` 都位于本次自有 HOME。该守卫成立后才允许第二次启动移除 profile 参数；若不成立就拒绝第二次启动。macOS `/var` 和 `/private/var` 别名按实际路径归一，不能以字符串别名差异判断目录归属。

第二次启动保留既有 Main/renderer 身份及进程所有权验证，只从测试启动参数删除唯一的 `--user-data-dir`；没有修改产品 ASAR、设置应用路径、调用 profile setter 或伪造 Electron 响应。原始测试主体副本、生成脚本及 SHA 在同名目录，便于核对该差异。应用实际返回预期默认 profile，独立 `.omp-desktop` 根同样由产品自行解析，PI/OMP 假配置哨兵原字节不变。

两次退出均经过正常生产关闭；原生进程观察归零，临时根已删除。退出确认仅在 teardown 复用现有自动化旁路。此处没有验证系统确认框、签名公证或 Windows/Linux 默认 profile；完整 M6 仍待三平台原生结果与发布资产回读。
