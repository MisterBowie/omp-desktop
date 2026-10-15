# M6 Windows 原生路径别名与失败清理

候选 d2d1dc8 / run38690408029 已结束：macOS、Linux 完整平台 job 成功；Windows
通过打包、包内运行时、Plan/Goal 回归、实际安装后的资源/身份及 Main/renderer
启动，随后在 `projectSet` 结果比较处失败。同一真实目录被分别写成 `runneradmin`
和 `RUNNER~1`，是 8.3 别名引起的验收器字符串断言问题。发布 skipped，旧 tag/run
保留，不把两个平台成功冒称为本阶段完成。

先参考 PI 的 `scripts/e2e-smoke.mjs` 对 Host canonical project path 的处理，
再用 Node 原生 `realpathSync.native` 统一安装根和已有路径身份。项目比较读取真实
文件系统路径，不跳过断言、不把不同路径统一当作同一项目；别名逃出根的测试继续
辨认它实际指向外部目录。

该次失败的紧急清理另有“可执行文件在根外”拒绝，原注释没有指明那个 executable，
不能断言原因也只在 8.3。失败时现在先走实际应用正常退出；紧急清理继续拒绝根外
镜像，记录拒绝后仍可处理其它已核实的自有镜像，不因一个拒绝中断所有安全清理。
根必须是存在的 `omp-installed-*` 目录，进程仍以同一个 Win32 HANDLE 精确核对
FILETIME 和实际镜像，拒绝根外程序和复用 PID。诊断只公开最多16条自有进程身份，
不读取/输出 argv 或环境；RED→GREEN 测试覆盖该边界。

新增编译前 Windows 原生检查：真实 Node 副本从短路径启动；读取真实创建时间和
exe；证明同名前缀的外部 sibling 不会被认领；错误创建时间不得终止进程；宽泛
SystemRoot 不能成为测试根；混入外部 sibling 时只回收自有进程且外部进程仍存活。
这个检查尚待下一候选的 Windows 真机执行，不能把本机 Mac 当作 Windows 证明。

本机路径/观察/证据/诊断/工作流定向回归19/19、0skip；双语文档及语法检查通过。
另在真实 Mac DMG 上直接调用 live-app cleanup，实际走正常退出1次、零残留、
没有紧急信号。这是对失败清理分支所用公共接口的测试，没有故意触发失败断言。
本节同名目录保存精确脚本、报告、原始 Windows 注释和校验清单；当时是 d2d1dc8
上的未提交 harness 修复，产品安装包仍为 d2d1dc8，归因见 results.json。

下一步提交候选、重跑实际 Mac 安装流程及受控原生 Windows 轻量检查，随后完整
三平台安装/发布和公开回读。产品源码没有变更，完整 M6/M7 继续保留。
