# M6 Mac 离线与实际崩溃验证（2026-10-15）

本批针对 M6 计划第 4 项补充实际安装产物的离线与崩溃路径。产品包仍为本机 `de691ca` 的真实 DMG，复用 `f6dba8b` 验收器；没有修改产品 ASAR、关闭 Chromium sandbox 或调用真实付费模型。全部测试目录为自有临时目录，均已回收。

## 包内运行时的内核断网

用系统 `sandbox-exec` 策略 `(version 1) (allow default) (deny network-outbound)` 启动生产 verifier。先以真实 TCP 连接负对照证明内核返回 `EPERM`，随后同一策略下运行实际 Resources 的生产 verifier，通过 omp/18.3.0、protocol 2、`get_state`、精确 missing-gate 拒绝、stopped/reaped/cleaned、leftoverRuns 0。原始 JSON 和网络负对照均保存。

## 实际 GUI 的不可用代理冷启动

通过公开 settings IPC 给隔离应用保存自有本地拒绝代理，正常退出后重新启动。该本机代理接受连接后立即关闭，绝不转发到互联网；启动环境同时选择该代理用于 Node 环境代理。产品真实 renderer/host 就绪，providers IPC 成功，实际 Main 的 `fetch` 通过该代理失败为 `net::ERR_CONNECTION_RESET`，且拒绝服务器记录到对应连接；这不是替换应用 API 后制造的返回值。两次正常退出和最终回收通过。

这是网络边界故障烟测，不冒称 GUI 在内核全断网策略下通过。曾尝试把整个 Electron GUI 置于上述外层 Seatbelt 策略；Chromium 子进程无法再次初始化自己的 sandbox，GPU 反复退出后 Main 结束。因此该方式记录为**测试环境不兼容**，没有作为产品离线失败或通过；原始失败报告也保留，进程和临时根均已回收。内核全断网结论仅属于上一节实际包内运行时。

## Main 在真实工具执行时被 SIGKILL

1. 在实际安装应用内，通过真实 Composer、权限卡和包内 OMP 启动一个真实 Node 父/子/孙进程树；原生观察记录三者 PID、出生时间和自有可执行路径。
2. 已核对身份的 Main 向**自身**发 `SIGKILL`，跳过所有异步正常退出步骤；不是以裸历史 PID 猜测目标，也不是仅模拟关闭事件。
3. Main 的确因 SIGKILL 退出。没有先由测试发送任何树清理信号，原生观察即确认全部自有进程消失，包括正在运行的三层工具进程。
4. 重启同一安装副本和 profile，实际侧栏恢复原生会话；状态 idle、pendingToolConfirmations 0、历史 3 条。模型 POST 从崩溃前的 1 条保持为 1 条，长进程记录仍只有原来的 3 条，没有模型或工具重放。
5. 新进程正常退出，最终 cleanup 观察仍为零，临时根删除。exit 0。

原始进程报告、截图、准确复用的测试 controls 副本和可重放脚本见同名目录与 SHA 清单。Mac 安装/并存/默认 profile/崩溃和网络故障烟测均有实际证据；原生 Windows/Linux 及 M6 三平台发布仍未完成，本批不缩减后续 M7/T24。
