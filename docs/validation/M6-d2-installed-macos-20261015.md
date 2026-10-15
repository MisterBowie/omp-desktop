# M6 d2d1dc8 本机安装复验

后续原生结论：run38690408029 已失败，Mac/Linux job success，Windows 路径
别名断言失败，未发布。本文本机证据仍有效；后续修复见
`M6-windows-alias-cleanup-20261015.md`，不继续沿用下文“仍在运行”的历史状态。

源码 `d2d1dc8a43e09987bd4c2df9ebb4b77e6395fd2f`，专用工作树
`omp-desktop-local-m6`。实际运行产品 `dist:mac --arm64` 全链，固定 fork
`36483311dfff67be7504f591974df93fc512a45a`、补丁 `.5`、Bun 1.4.2 与桌面
0.15.2 未变。首次遗漏显式 fork 环境变量，预检正确拒绝不存在的默认来源；
随后显式选择干净的本机 `omp-runtime-fork` 重跑，exit0。没有绕过预检或后塞资源。

完整 OMP 包测试最终为 **35 文件、542/542、0fail/skip/excluded**，包含此前失败
的固定参考源码启动器和实际 compiled sidecar。先用 Bun 冻结安装补齐参考依赖，
再执行官方 `gen:tool-views` 生成被忽略的 HTML 工具视图；native binding 以已证明
Rust/native 清单完全相同的本机 fork 构建字节作 COW 副本并核 SHA。所有参考源码及
锁文件保持干净。旧失败、缺失生成资源的真实 stderr、安装/生成/最终完整日志均
保留；这补齐了 `M6-windows-native-home-20261015` 中记载的参考测试环境限制。

实际 DMG 只读挂载后复制到仓库外自有中文、空格、单引号目录，使用隔离 HOME、
显式测试 profile、空 PATH 启动真实打包应用；没有数据根或 runtime 覆盖参数。
真实 Main/renderer/host/OMP 完成项目、拒绝写入、单次批准写入、外部项目检查、
三级进程 Stop、重启不重放、恢复后新回合、默认目录/PI 与 OMP canary 隔离共
8 项；2 次正常退出均零残留，最后测试根删除。原生 closed JSONL 重开逐字节一致。

同一包中的实际 sidecar 通过 18.3.0、protocol2、get_state、精确 missing-gate
拒绝、stopped/reaped/cleaned/leftover0；Mac 不提供 `/proc` 环境读取，未冒称读到
真实子进程环境。包内 Plan/Goal 完整 15/15、0fail/skip，136.709s。

实际发布 staging 绑定此源码、安装器 SHA、完整安装报告和原始证据，生成 DMG、ZIP、
validation.json.gz 三资产。重新打开 validation 包后逐文件校验、安装行为与
摘要均通过。本机 run-id 明确为 `local-macos-d2`，没有冒称 CI 产物或替代远端
三平台验收。原始报告、7 张截图、3 份 JSONL、版本/回收报告、staging 记录和
校验清单保存在同名目录；安装二进制留在本机 review，不进 Git。

此包未签名、未公证。Windows/Mac/Linux 原生环境检查已全部通过，对应受控 tag
`m6-test-20261015-d2d1dc8` / run38690408029 的三平台构建及安装验收仍在运行。
完整 M6 必须再通过本轮三平台与公开资产回读，完整 M7/T24 继续保留。
