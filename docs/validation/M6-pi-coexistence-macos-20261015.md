# M6 实际 PI/OMP 并存验证（2026-10-15）

本机实际安装的 PI-Desktop **0.15.0** 与本机 M6 OMP Desktop **0.15.2** 的独立副本同时运行、配置隔离及相互不干扰已通过。此证据不替代正在执行的 M6 三平台原生 CI，也不表示完整 M6/M7 已完成。

## 实际对象与隔离

- PI 来源是本机 `/Applications/PI-Desktop.app`，Info.plist 为 `net.aiuo.pi-desktop` / `PI-Desktop` / 0.15.0，ASAR package 为 `@pi-desktop/desktop`，homepage 指向原 `vastsa/PI-Desktop`。不从已安装版本反推未知源码提交，不把它写成固定参考子模块的 0.15.2 构建。
- OMP 来源为实际生产构建 `de691ca` 的 DMG；测试脚本所复用的验收器 HEAD 为已提交的 `f6dba8b`，产品输入未变。
- 只读读取原应用元数据，以系统 `ditto` 将 PI 包复制到独立临时根；OMP 从只读挂载的 DMG 复制到另一临时根。没有启动或修改 `/Applications` 中两个用户原应用，也没有读取/迁移用户的真实数据库和凭据。
- 两个副本共用**同一自有 HOME**，分别使用自有 `--user-data-dir`。PI 明确覆盖到该 HOME 的 `.pi-desktop` 以保证旧版参考包隔离；OMP 未传数据覆盖参数，自行使用 `.omp-desktop`。这不声称覆盖了 PI 的默认目录选择或系统默认 profile 查找。
- 两边都由真实 Main inspector 验证 `isPackaged`、名称/版本、可执行文件、resources、profile、HOME 和实际 dataRoot；实际渲染页来自该 Main 的主窗口。PI 是真实现有产品，不是同名占位进程。

## 已执行检查

1. 两个真实 arm64 应用同时就绪，bundle ID 不同，HOME 相同，profile 与数据库根不同。
2. 通过各自公开 preload IPC 创建专属假提供方，再列出各自记录；PI 不出现 OMP 的记录，OMP 不导入 PI 的记录。仅写入自有假数据；测试结束通过公开 API 删除这些假提供方。
3. 记录 PI 的原生 PID 与出生时间后，正常关闭 OMP 并确认其树回收；同一个 PI 进程仍存活并能读回自己的提供方。
4. 重启 OMP，只恢复自己的记录；同一个 PI 进程继续响应，未被重启或终止。
5. 两边均按生产关闭顺序退出，原生观察显示各自进程树归零；两份临时根全部删除。提供方夹具记录的模型 POST 为 **0**，没有付费或远端模型调用。

结果为 exit 0；原始 `coexistence.json.gz` 包含身份、两边所有权观察/关闭报告，3 张截图及可重放脚本在同名目录，文件由 SHA 清单固定。每个进程归属依据其独立副本路径和出生时间；不以共用 HOME 当作进程所有权，所以关闭 OMP 不会认领或误杀 PI。

限制：原生退出确认仍只在 teardown 使用已有自动化确认旁路；不声称覆盖系统确认框、系统快捷方式注册、签名公证或 Windows/Linux 并存。独立 profile 是显式指定的；默认产品数据根的实际选择由 OMP 此次运行和前一批完整安装流程证明。
