# 0.1.0 固定候选与原样发布（2026-10-16，公开回读收尾中）

最新进展：[v0.1.0已稳定发布](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.0)。
产品源码154bc03 / 原生run38862126801整轮success；最终发布run38869364763 success。
四目标严格15/15、安装8项与两次正常退出零残留；同批安装包原样发布。
本机公开ARM DMG真实GitHub检查up-to-date/currentVersion0.1.0/manual，一次正常退出零残留。
API摘要与四份原始验收证明已回读；30份公开资产的本机全量下载仍在续传核验，
尚未将全量字节回读记为完成。以下保留全部候选和晋升失败过程，不覆盖历史事实。

固定 OMP fork `d648d27` 已非强制推送至用户自己的维护分支，并经 GitHub API
回读确认提交与树摘要。桌面源码已提交并推送；原默认模型及所有既有工作树保持原状。

## 已完成的本机候选验证

- 在固定 f8c0e58 上重新构建实际 0.1.0 DMG，再完整执行旧包项目保留、检查失败恢复、
  发现更新与新 GitHub 按钮；2 次正常退出，最终自有进程为 0。
- 完整 workspace 测试 exit 0；desktop 3,108 通过、0 失败、9 条件跳过；
  OMP runtime 540 通过、6 条件跳过。此为实际命令统计，未把跳过项记为通过。
- Rust host-core `cargo test -p host-core --locked`：606 通过、0 失败。
- 发布绑定/清单/真实 GitHubProvider：11 通过、0 失败/跳过；515 文档页及版本发布门通过。
  三份发布 YAML 和 29 段 Bash 语法已核对。

全量补查曾暴露两个旧夹具问题：签名脚本夹具漏复制许可证模块，图标检查仍匹配旧算法；
已在 f8c0e58 修复。源码态测试需要固定 PI/OMP 子模块、锁定依赖和原生 addon；补齐后
上述完整回归通过，CI 同样显式准备这些前提。首次沙箱运行无法监听本机测试端口，
随后在允许回环服务的环境重跑通过；没有因此跳过相关测试。

## 原样发布的边界

发布控制面作为后续普通提交保存。晋升入口选择成功候选运行，
要求源码 SHA、固定工作流、四个原生作业中的实际构建/验收步骤及八份未过期资产一致；
再检出候选源码、复核真实安装包清单、合并 Mac feed、保存运行回执和原生证据。
只有此时才在候选提交创建 v0.1.0，并从完整 draft 发布为 stable/latest。
已存在的不同稳定提交拒绝覆盖；标签不移动。

共享发布器避免另行重建验收过的安装包。GITHUB_TOKEN 创建标签不会递归触发新的 push
构建，依据 [GitHub 官方事件说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow#triggering-a-workflow-from-a-workflow)。
直接稳定标签构建与候选晋升共用一个发布器。发布后仍须回读公开资产摘要、三个更新
清单，并在本机实际公开 Mac 包中检查真实 GitHub 更新源；未完成前不记为交付完成。

未签名 Mac 使用 GitHub 手动更新；没有声称真实 Developer ID 自动安装已验收。
未调用 DeepSeek 或其它付费模型，不合并 main，不改写已有标签。

原始证据与摘要：[SHA256SUMS.txt](Version-010-release-promotion-20261016/SHA256SUMS.txt)。

发布前追加：处理 upload-artifact 的共同根目录布局，按唯一文件名原样暂存；Debian
`omp-desktop_0.1.0_amd64.deb` 仅重命名为 `OMP-Desktop-0.1.0-x64.deb`，字节保持不变，
从而纳入原有版本摘要命名空间。源路径、原始 SHA256 和发布名另有暂存回执。
新增重名、链接、旧版本与已有目录拒绝测试后，发布相关合计 14 通过、0 失败/跳过；
三份 YAML / 30 段 Bash 通过。证据归档采用确定性时间戳和 gzip header，允许安全重试。

首轮失败与返修：run38845176146 的 verify 完整通过，Mac/Linux 的 Build all release
installers 以 exit 2 失败；真实 planRelease 复现额外 `--` 被拒绝。修正为架构参数
直接传入 pnpm 脚本，六种实际 shell 路径（四原生目标和两签名 Mac）均调用真实规划器
通过。该历史候选将日志尾部写入作业注释；现行控制面只返回固定错误分类和阶段布尔值，
不公开捕获的日志、路径或名称。发布相关合计 25 通过、0 失败/跳过。

修正候选仍重新构建并实际安装四个原生目标。只有所有产品路径和固定子模块逐项相同
时，才复用首轮已经通过的源码套件；只允许文档及明确列出的发布脚本/测试不同。
版本、锁文件、运行代码、构建入口或子模块变化及回执不可用都要求完整源码检查。
专门回归证明从 app 工作目录调用仍比较仓库根 app 路径，运行代码变化不会被误漏掉。
首轮失败标签保留，未改写；后续安装产物必须归属修正后的候选，不能声称 f8 原生通过。

## 第二轮原生失败与跨平台修复

候选 `e69177202856704b21cac689f0e3d0148a811046` / run38850057597：源码门通过，
Linux x64 原生打包、包内严格契约和实际安装流程均通过；Mac arm64、Mac x64、Windows
在打包步骤失败，未发布。安全诊断可用固定分类定位：Mac 均已进入 electron-builder，
报文件打开失败；Windows 在此之前报工作区 shared 导出缺失。

Mac 的发布步骤导出了空 CSC_LINK。真实 electron-builder 26.15.3 的 Mac 证书解析器
把空字符串当作提供了证书，本机直接调用真实解析器复现 4 条失败后修正；无签名路径移除
所有证书变量，签名路径保留真实配置。六条目标 shell 回归及隐私分类共 27 项通过。
补充仅实际打包步骤的诊断后，两种 Mac 均为 NOT_A_REGULAR_FILE，与空证书解析为当前
项目目录的真实解析器行为相符；先前整份作业日志中的 node_modules 文件缺失属于清理
阶段，不能据此归因为打包。新增阶段范围回归确保不再混入初始化和清理错误。

Windows 的 build:deps 在 package.json 中用单引号包围 pnpm 筛选器；cmd.exe 不会像 Bash
那样去掉单引号，导致没有匹配工作区包却返回成功，后续 esbuild 缺少 shared/dist/index.js。
修正为跨平台双引号并启用 --fail-if-no-match。新增真实 pnpm + 原生包脚本 shell 的冷
工作区夹具，检查全部九个依赖产物存在，并排除 desktop 自身和无关包；每个平台构建都运行。
本机先移出 shared/dist，再走真实旧 build:deps，证实 POSIX 正常生成产物；没有把本机
POSIX 结果冒充 Windows 已通过。新候选仍须完整源码与四原生验收。

修正后本机发布相关 29 项全部通过，真实 f9a1675 Mac 打包 exit 0；实际旧包→0.1.0
项目保留、503 检查失败后重试、发现未来 0.1.1 夹具版本、新 GitHub 按钮与两次正常退出
均通过，最终自有进程为 0。DMG SHA256 为
`92a5addd3c8e1e118f7a16f4293fe8c5b9952807e68a011562d15f6609ac2d7d`。
这仍是本机包的证明；公开发布后的 Mac 下载与真实 GitHub 检查须另行完成。

自动审批拒绝了将原始失败日志片段公开为注释的诊断推送，原因是可能含敏感路径；该推送
没有执行。后续仅提交和运行固定分类与布尔输出的安全诊断；未输出日志内容。

## 第三轮源码门失败与真实契约替换

run38854346905 的 build:js、host-core release、typecheck 和 lint 均通过，但完整 workspace
发现 runtime-build-contract 仍硬编码旧单引号命令，本机原样复现 3 通过 / 1 失败。
将该字符串检查替换为同一个真实 pnpm 原生 shell 工作区夹具，保持九个依赖输出、排除
自身与无关包的行为断言；其他三个构建顺序和 tsbuildinfo 契约保留，修正后 4/4 通过。
没有通过更新一个预期字符串来放过测试。

下一候选的快速 guard 先校验仓库、版本和触发入口，完整源码检查与四原生构建随后并行。
稳定标签的直接发布仍同时依赖 verify 与 build；候选晋升也仍要求整个 run 成功及全部
原生证明。所有原有门保留，失败候选不能晋升。新版需重跑完整 workspace 和完整 CI。

本机修复后完整 workspace exit 0：desktop 3,108 通过 / 0 失败 / 9 条件跳过，OMP runtime
540 通过 / 6 条件跳过；31 项发布回归和 Biome lint 通过。四份 YAML、35 段 Bash 解析通过。
本机原始日志保留在 review 目录，仓库只记录本轮摘要与日志 SHA256，避免再发布完整诊断日志。

## 第四轮原生验收定位中

候选 ae173d361370b1840f6781d8822186d743dce06b / run38856995305 的完整源码门通过。
Mac ARM、Linux 的包内15/15、实际安装8/8与两次正常退出零残留均通过。Windows
原生安装包已生成，包内运行时 get_state 成功，但包内严格契约第5/6/8项失败，
共12通过/3失败/0跳过，因此后续安装UI验收尚未运行，不能称为安装后UI失败。
诊断仅返回固定字段、计数和源文件数字坐标；未知文本与原始日志不公开。
稳定发布仍被阻断，保留失败候选与原始报告，继续查明断言后修复。

Mac Intel 最终包内15/15，但安装前 inspectInstalledProduct:139 的架构断言失败；
真实 lipo 返回 x86_64，Node 使用 x64。以 clang 实际交叉编译 Intel/ARM Mach-O：
原实现1通过/1失败，修复后2/2，并验证 universal 不可冒充单目标。
Windows 第5/6项的异常坐标均在 entryFor 项目目录拒绝处，夹具经 JS realpath 保留
TEMP 8.3短名，与 host-core 持久长路径不相等；改为 native realpath，不改产品目录守卫。
第8项审批缺失仍须新原生回归确认，不据此声称Windows通过。33项交付回归、2项隐私
回归及4YAML/36Bash通过；完整源码门固定复用最新 ae173d3 已完成的六步检查，
仅明确列出的验收器、发布脚本和文档允许变化，所有产品输入变化仍触发全套源码门。
四原生目标仍须重新打包、严格15项、实际安装8项全部通过，未放宽任一断言。

修复后本机实际打包运行时严格契约15/15、0失败/跳过；测试夹具清理正常完成。
本轮原始日志仅本机保留，仓库记录 [计数与摘要](Version-010-release-promotion-20261016/native-harness-repair-summary.json)。

## 原生接受与首次晋升阻断

run38862126801整轮success，四目标原生作业通过；本机严格门读取最新run/jobs/artifacts，
接受八份非空、未过期、SHA256完整且head_sha一致的资产。见[接受回执](Version-010-release-promotion-20261016/accepted-candidate.json)。
首次晋升run38866649933完成下载、暂存与原生证据保存，但prepare-github-release:26/58
拒绝latest-linux.yml的不安全或旧名称；后续稳定tag与Release步骤均skipped。
实际electron-builder26.15.3会合并AppImage/Deb/RPM条目，暂存仅改Debian文件名而未改引用。
真实writer→暂存→严格validator及复制到临时目录的CLI回归，原提交3通过/2失败，
修复后5/5；恶意URL与篡改SHA512仍拒绝。安装器字节不变，只改准确Debian引用并记录
原始/暂存清单摘要。35项交付回归和4YAML/36Bash通过。
发布额外记录控制面commit/ref、暂存脚本摘要、候选run与发布run，明确产品来源与发布控制面。
本轮原始测试日志仅本机保留，仓库记录[计数和摘要](Version-010-release-promotion-20261016/publication-feed-repair-summary.json)。

## 公开稳定版与本机真实更新检查

晋升第二次run38868283977通过全部清单摘要后，在创建稳定tag时遇到API403；
随后用已授权Git SSH将v0.1.0固定在154bc03，远端回读一致。该push触发的重复
run38869227396由受控run38869402506重新验证接受回执后取消，最终为cancelled；
原已接受run38862126801仍为success。第三次晋升run38869364763完整success，
正式发布[OMP Desktop v0.1.0](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.0)，
共30项公开资产、1,984,514,132字节，draft/prerelease均false。

本机完整下载公开ARM DMG，224,145,172字节，SHA256
`02aabb1ce1e7675b3d1486fdfc13e1a6834e86fc10fce45ffdf5594cc0a89cdf`，
与GitHub API及发布校验记录一致。实际安装到隔离目录并启动，点击版本入口，
通过真实GitHub稳定源返回currentVersion=0.1.0/status=up-to-date/manual=true，
mode=manual符合当前未签名或临时签名Mac；未使用测试feed覆盖。一次正常退出，
零自有残留，预置PI/OMP哨兵不变。[回执摘要](Version-010-release-promotion-20261016/public-installed-update-summary.json)。
截图仅证明实际公开窗口中的v0.1.0；更新结果以生产IPC回执记录，不把截图当作可见状态提示证明。

其余公开安装格式仍在逐字节下载和摘要核验，待完整回读通过后归档最终结果。
