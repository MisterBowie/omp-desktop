# 执行任务看板

2026-10-22（聊天修复发布，进行中）：用户授权两项修复合并提交发布，保持 **0.1.4**。
最终构建/类型/lint/文档、42 项发布保护与 5 项更新记录测试通过。四平台安装包增加
首次提问/DeepSeek 空正文原生必过门（2/2、零跳过）。源码绑定独立 `+chatfix.<SHA>`
标签，原 v0.1.4 标签与资产保护；尚待固定候选、公开发布和全资产回读。
见[发布记录](validation/Chatfix014-release-20261022.md)。

2026-10-22（单点来源更正）：已对照 Pi/原生 OMP 复现 DeepSeek 工具消息空正文被
OMP 在后续请求补成 `.`，关闭该模型兼容开关后通过。不隐藏真实正文，不改写旧历史；
旧截图逐点来源缺原始 SSE，不再仅凭原生日志归因模型。159 桌面、3 原生及构建/
类型/lint/文档通过。仍在 `codex/fix-omp-first-response`，未提交、打包或更新安装。
见[补点专项](validation/OMP-dot-replay-20261022.md)。

2026-10-22（首次发送专项修复，本机完成）：自动改名误回收提问运行时的并发缺陷
已复现并修复，准备中/运行中及同一原生身份保持均通过。142 桌面、50 投影、2 原生
回归与构建/类型/lint/文档通过。单点已在原生记录；来源结论见上方更正。
`.worktrees/fix-omp-first-response` / `codex/fix-omp-first-response`，基线 `31ea1375`，
版本保持 0.1.4。未提交、打包、发布或替换用户安装；下一交付为固定候选安装包。
见[本轮记录](validation/OMP-first-response-20261022.md)。

2026-10-21（统一 0.1.4 已交付）：本会话及其他会话功能已统一提交并正式发布。
源码 `87894e73`，候选 run39609842689 完整源码 + 四目标均通过；各目标严格门
15/15、原生记忆 1/1（零跳过）及实际安装流程通过。晋升/公开回读 run39618493864
成功，28 资产（1,949,871,599 字节）、8 更新制品与 Mac 合并 feed 校验通过；
GitHub latest stable 为 0.1.4，稳定标签精确绑定接受源码。旧 Pi 不兼容、不迁移；
其他会话原工作树 108 快照文件均保持。未替换用户本机安装、未改用户数据或调用真实模型。
[正式下载](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.4)；
[最终证据](validation/Unified-014-release-20261021.md)。

2026-10-21（严格门同步修正）：Windows 首轮 14/15，安全诊断定位完成通知在数据库
落盘后异步到达，旧测试只等 runner idle 就检查次数。已同步真实回调，保留所有次数/
归属/状态断言与原等待预算；未改产品逻辑。源码原生严格门 15/15、桥接单元 57/57。
本机完整工作区 exit 0（桌面 3202/0，12 环境跳过）。最终候选四平台仍需完整重验。

2026-10-21（统一候选修正）：`119e2d29` / run39603239076 源码门检出旧 Pi
检查点恢复断言，与不迁移范围冲突。已本地复现并修正测试，组合 10/0；未改产品逻辑
或放宽发布门。此候选不可发布，修正后重建固定候选；完整源码与四目标待重新验收。

2026-10-21：用户授权跨会话统一提交部署，选定 **0.1.4**。已整合 OMP-only/记忆、
布局、供应商能力及 HTML/结算修复；关闭 Pi worker/远程入口和独立 Pi Host 资产。
291 桌面、504 shared 源码、47 runtime、25 i18n、652 宿主及构建/类型/lint/文档/
fmt/clippy 通过；跳过与重复单列。四目标候选与发布尚待执行，不记完成。
见[本轮发布](validation/Unified-014-release-20261021.md)。

2026-10-21（全新 OMP 产品）：**OMP 唯一执行引擎源码与本机验证已完成，未提交/打包/发布。**
用户明确不兼容、不迁移旧 Pi 会话，本条取代下条初始兼容方案。新会话和无引擎创建
统一 OMP；关闭 Pi 能力、worker 启动/重启/打包、旧历史发现/读取/导入及远程 Pi 入口。
旧磁盘数据不改写，列表/读取/搜索只暴露 OMP；记忆范围选择与正常原生保存/召回通过。
完整桌面 3170 通过、0 失败、9 跳过；最后关闭宿主/插件导入与旧恢复后，宿主 651、
Main 接线 9 与真实原生记忆/重启/工作树 3 项通过。shared 500 源码（连 dist 副本运行
1000）、相关桌面 147 和补充 25 项通过；构建/类型/lint/文档/fmt/clippy 通过。
各轮时点与重复/跳过、失败过程见新报告。
`codex/fix-memory-capture` / `.worktrees/fix-memory-capture`，基线 `4f5eb9c5`；
0.1.3 / schema 22 / 原生 `.7` 保持。未改用户安装、未调用真实模型或启动其他代理。
跨会话来源 ledger、原生完整历史分支等缺口明确保留，未借旧 Pi 执行冒充支持。
下一交付为安装包构建/验收，见[最新证据](validation/OMP-only-product-20261021.md)。

2026-10-21（记忆为空排查）：**已定位并完成本机源码修复，尚未提交或发布。**
已确认“家政”项目存在、两个开关开启，但本机三个会话均为 Pi。普通新建入口漏传
引擎，宿主兼容默认 Pi，因此不触发 Mnemopi。新建普通项目/临时会话现明确选择
OMP，不复用空 Pi 会话；旧会话的引擎和历史保持。记忆页增加 Pi 限制提示，并修复
worktree/临时会话选项被自动切回主项目的问题。35 项相关桌面回归、7 项记忆边界、
25 项语言和真实原生记忆流程通过；类型、lint、双语文档通过，最终构建结果见证据。
独立分支 `codex/fix-memory-capture`，工作树 `.worktrees/fix-memory-capture`，基线
`4f5eb9c5`（0.1.3），固定原生 `.7`/schema 22/版本均不变。未迁移安装态数据，
未调用真实模型。见[完整验证](validation/Memory-chat-engine-20261021.md)。下一步如需安装使用，须另行打包交付修复版。


2026-10-21（记忆页布局修复）：按用户截图修复间距失效、搜索按钮挤行、卡片无内边距、
字段样式及分页/清空混排，移除重复标题并适配窄内容区。独立工作树 `.worktrees/memory-settings-layout`，
分支 `codex/memory-settings-layout`，基线 `4f5eb9c5`。构建、类型、lint、文档与 6 项回归通过；
真实组件/生产 CSS 的 7 个隔离渲染场景（3 个基线、4 个修复后）通过，宽窄截图已查看。
仅布局源码修复；仍为 0.1.3，未提交/推送/发布或改安装态数据。见[验证与预览](validation/Memory-settings-layout-20261021.md)。

2026-10-20（0.1.3 正式发布）：**自动记忆及“排查 Claude 上下文识别”的修复已一并提交发布。**
[0.1.3 下载](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.3)，源码 `e4f04720`，原生 `.7` / `edec389`。
完整源码与 Mac ARM/Intel、Windows x64、Linux x64 全部验收通过；各严格 15/15、记忆 1/1、
真实设置页重启、安装态 8 项及两次正常退出零残留。发布/全量回读 run39375317391 success：
30 项公开资产、1,988,441,504 字节及全部更新清单/来源回执通过，latest 为 v0.1.3。
“设置 → 记忆”两个开关默认关闭；端点模型列表刷新保存后采用供应商上限，手动覆盖优先。
旧版标签/资产和用户安装态数据未改；schema 22 保持。首轮失败与额外诊断候选均保留，
不作为发布来源。见[完整发布记录](validation/Version-013-release-20261020.md)。本轮完成，不自动开始其他阶段。

以下保留准备和历史阶段的当时状态，以本节最新交付为准。


2026-10-21（0.1.3 原生记忆夹具）：当前保持 **0.1.3**，产品源码已正确合入发布基线。
4885554 的完整源码、Linux/macOS ARM 安装与所有平台 HTML 原生门通过；Windows
严格回合 15/15 后，原生记忆单用例触发 90 秒总时限。公开 0.1.3 同项耗时 81.3 秒，
已仅增加 Windows 测试整体预算、保留所有断言及产品时限，补充阶段诊断。
本机原生记忆 1/1、交付 16/16、安全边界 9/9 通过；下一轮四目标全部重跑。
完整源码按既有机制绑定到 4885554 的已通过证据；产品变化仍强制重跑。
详见 HTML 验收记录。以下是过程历史。

2026-10-21（版本基线纠正）：用户指出当前为 **0.1.3**，经公开 Release 的 BUILD-RECORD.json
确认产品源码为 e4f04720031d87148f92d4bd2048fe2609b117eb。已在本任务分支无损合入该发布基线，
保留 schema 22、自动记忆、供应商模型限制与 .7 / edec389 原生运行时。HTML 打开方式与结算顺序修复
将按 **0.1.3 不变**重新验证打包；下方本任务早期 0.1.0 记录是误用旧基线的历史，不是本次交付版本。
旧候选 run39558120889 不用于交付；新候选及验收结果待实际完成。

2026-10-21（首轮打包修复）：0fc02ee 的 HTML 原生四目标通过；完整源码门暴露
OMP 通知早于持久化的既有竞态。已遵循 PI finishTurn 顺序修复，2 项确定性 RED
对应修复后 89 项相关回归全通过，类型/lint/构建/双语文档/更新记录均通过。
原始 15 项 Plan/Goal 验收断言未改，版本仍 0.1.0，待新固定候选重新打包。
首轮失败及用户提供错误保留于[记录](validation/HTML-open-with-upstream-20261021.md)。

2026-10-21（追加授权提交/打包）：版本仍为 **0.1.0**。新候选四目标流程增加 HTML
菜单与文件预览原生验证，完整源码/截图/安装门保留；准备提交并以固定候选 tag 打包。
构建完成状态以实际 run 验收为准，下面源码阶段的“未提交”是过程历史。

2026-10-21（HTML 右键打开方式）：**已按 PI-Desktop #1713 完成本机源码交付。**
0.1.0 / `.worktrees/html-open-with` / `codex/html-open-with`；菜单、文件管理器恢复与
范围路径解析器沿用 beta.4 官方实现，三项逐字对比通过。HTML 引用可显式选择文件
管理器、内置浏览器或系统默认关联；普通点击兼容，内置预览限定已登记项目/会话范围。
175 个回归、真实 Electron 9 项交互和 3 项文件加载、类型/lint/构建/双语文档通过。
外部浏览器仅验收交接请求；未打包或改用户安装，修改未提交。
见[验收记录](validation/HTML-open-with-upstream-20261021.md)。下方保留历史。
2026-10-20（0.1.3 首轮源码门修正）：固定候选 `5c27bd59` / run39369317625 的
递归测试因旧 IPC 夹具缺少 memory sibling mock 失败，未发布；本机 0/1→6/0，定向组合23项通过。
产品行为及原有断言未放宽；补充清理测试 shell 覆盖变量，实际安装子环境原本已有白名单隔离。
下一固定候选将完整重跑源码与四目标验收。见[失败与修正](validation/Version-013-release-20261020.md)。

2026-10-20（0.1.3 合并发布准备）：用户授权将自动记忆和“排查 Claude 上下文识别”一并提交发布。
两项已分别提交，受控原生 `.7` / `edec389` 已推送；全部版本入口按 0.1.3 准备。
本机桌面 222、OMP 565、shared 源码 500、Rust 648 及真实原生/Electron 验收通过。
四目标候选与正式发布尚未执行，不能视为已发布。见[本轮状态](validation/Version-013-release-20261020.md)。

2026-10-20（供应商上下文修复整合）：用户要求将会话“排查 Claude 上下文识别”纳入本次发布。
已验证该会话源码摘要，只移入其发现/缓存/绑定保存与运行时解析差异，保留本分支的 0.1.2 修复。
模型列表发布的上下文与输出上限分别读取，手动配置优先；不按 Claude 名称硬编码 1M。
原会话 0.1.1 基线的历史验收原样保留于[来源记录](validation/Provider-model-limits-20261020.md)；当前合并候选验证与发布状态另记。

2026-10-20（自动记忆）：**Mnemopi 自动保存/读取、隔离记忆库与管理页面已完成本机源码验收。**
入口“设置 → 记忆”，两个开关默认关闭；支持项目/worktree/临时会话查看、搜索、刷新和确认清空。
原生 102、runtime 565、桌面 142、Rust 647 项及真实原生/Electron 流程通过；
JS 构建、类型、lint 与 80 对/520 页文档通过。标准原生构建与最终 .7 原生/页面流程通过，shared 994 / i18n 25 项通过。
用户已授权本地原生提交：`edec389`，受控补丁推进到 `.7`，此前 `.6` 保留历史。
应用仍 0.1.2 / schema 22，桌面未提交，原生未推送，未发布或改安装态数据。
工作树 `.worktrees/mnemopi-memory`，不自动进入其他阶段。见[验收与后续](validation/OMP-automatic-memory-20261020.md)。

2026-10-19（Skill 安装提示同版本修订）：**代码已提交并正式发布 [0.1.2 修订版](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.2%2Bskill.05cda4fb1b680656090bd6a8953913db4118c279)。**
应用、安装包与更新清单仍为 **0.1.2**；Skill 安装提示和桌面自有 Agent 身份改为
`OMP Desktop (omp-desktop)`，兼容 id、路径与外部正文保留。同版本需手动下载安装。
源码 `05cda4f`，完整源码和四目标原生/实际安装验收全部通过；同一八份制品原样晋升。
发布及全量回读 run39246092021 成功：30 项公开资产共 **1,988,207,883 字节**，八项
更新安装器、五份更新清单、源码/控制回执与合并 Mac 清单均通过，latest 正确。
原 `v0.1.2` 仍指向 `21969e5`，原版 30 项资产 id、大小、SHA256 全部未变。
本轮还修正测试的异步持久化等待和父 PID 复用误认；未放宽退出、权限或终止边界。
原生 OMP 18.3.0 / `.6` 和 schema 22 保持，未调用真实付费模型。此前失败与跳过
保留在[发布验收记录](validation/Skill-install-branding-release-20261019.md)及其 JSON 收据中。

2026-10-19：**九项修复已提交并正式发布 [v0.1.2](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.2)。**
产品源码 `21969e5`，完整源码与四目标原生/安装验收成功；Windows 实际安装五项
缺陷复测全通过（单屏，含宿主 UTF-16）。同一候选原样晋升，30 项公开资产共
1,988,212,725 字节全量回读通过，八项更新安装器及五份更新清单通过，latest 正确。
原生 OMP `.6` / schema 22 保持；B11 原生 UTF-16 排除，物理双屏未验收，构建链
仍有一项无官方修复的中危依赖告警。T25-B/T27 未新增交付；此前本机失败/跳过保留。
见[0.1.2 发布记录](validation/Version-012-release-20261019.md)。

以下为此前修复与发布阶段的历史记录。

2026-10-19（当前未发布源码）：**九项可修复缺陷已修复并通过定向回归**。
B01–B05、B08–B10、B12 已闭合；B11 原生 OMP UTF-16 能力按用户要求排除。
12 个适用审计场景通过，主/宿主运行时 774/36 项、桌面 458 项、Rust 646 项
及六种真实 Electron 截图通过。依赖告警 61→1（打包链 sprintf-js 尚无修复版本），
prod 范围 0；更新后构建、类型、lint、文档及其余工作区回归通过。
原生烟测因本机未构建参考启动器失败；OMP 其余 549 项通过、6 项资源测试跳过，
失败项已记录并显式排除，未放宽身份校验；不能称整个递归回归全绿。
分支 `codex/fix-post-release-bugs`，未提交、未发布，版本和原生运行时固定保持。
见[本轮修复记录](validation/Version-011-bug-fixes-20261019.md)。

以下为已经发布的 **原版 0.1.1** 的历史审计，不能与当前未发布修复混为一谈。


2026-10-21（供应商能力识别）：**思考/附件能力本机源码修复并验证，未打包安装。**
在同一 `provider-context-window` 工作树延续上下文修复，接通端点事实 → 设置显示/
保存 → Rust 缓存/数据库重开 → Node/OMP 投影。手动覆盖保留；自动调度按用户选择
继续手动；搜索声明不自动启用搜索。实际 43 个模型有思考、41 个有图片，未发布 PDF/
搜索支持，不据名称推断。101 桌面、504 shared、47 runtime、25 i18n、53 宿主及静态
门通过；原生 .7 隔离诊断成功但不代替固定 .6 验收。无付费推理、无真实数据迁移。
见[验证与交接](validation/Provider-model-capabilities-20261021.md)。

2026-10-20（供应商上下文识别）：**本机源码修复并验证，尚未打包/安装。**
`codex/provider-context-window` / `.worktrees/provider-context-window`，基线 8233c81。
保留端点 context/output 限制，修复网关未知 ID 回退 128k，并使端点窗口跨选择保存、
缓存、宿主配置与运行时解析保留；显式手动值不覆盖。实际只读 GET 返回的 Claude
窗口按型号为 200k/867k/872k/931k，没有按名称写死 1M。80 桌面、500 shared 源码、
46 运行时、52 宿主回归及构建/类型/lint/文档/fmt/clippy 通过；旧源码 6 项新发现回归
失败为 RED 证据。版本保持 0.1.1，未提交/推送/发版，未改真实用户配置、未调用付费
推理、未运行安装态 GUI。见[证据与交接](validation/Provider-model-limits-20261020.md)。

2026-10-19：**0.1.1 已提交并正式发布，发布后的 Bug 复测已执行。**
完整源码与四目标构建/安装验收全部成功；30 项公开资产全量回读通过。
419 项桌面、119 项运行时、真实 OMP 两流程、新安装与升级/回退通过。
13 个定向场景 3 通过、10 未通过，含等价路径移动丢文件、MCP/CDP、UTF-16、
规则/Token 和 Git textconv；依赖审计仍有告警，Windows 双屏未覆盖。
本轮复跑结果相同：9 个失败场景可对应 PI 官方修复，另 1 个为 OMP 原生 UTF-16 能力差距。
已按官方契约补查 BrowserHost 入口及 MCP 取消通知；Pi 兼容路径与默认 OMP 的结果分别标明，尚未修复。
schema 21→22 回退需关闭应用并恢复备份；固定运行时 .6 不变。
见[发布记录](validation/Version-011-release-20261019.md)与[完整复测/缺口](validation/Version-011-bug-audit-20261019.md)。

复测待修优先项：B10 宿主等价路径移动删除源文件、B12 工作面板执行 textconv、
依赖告警；其余 B01–B05/B08/B09/B11 按复测记录保留未解决状态。
T25-A 与 T26 核心现已发布；T25-B（完整原生分支/单子代理停止）及 T27 后台命令
仍未交付。没有自动启动下一阶段。下文保留此前按日期记录的本机阶段事实。


2026-10-18（会话 worktree）：**T26 核心流程已完成本机源码验收。** 项目菜单创建
全新隔离 OMP 会话，保留原项目配置作用域并绑定独立执行目录；支持原生恢复、
预览合并/同步/显示目录/删除，文件面板与聊天链接同根。643 宿主、345 桌面、556 OMP、
497 shared 源码、25 i18n 与真实原生两个流程通过；协议烟测 23 通过、2 个真实模型
跳过。schema v22 升级保留原会话/原生引用并先备份；旧版本回退需要该备份。
仅源码未发布，安装态 GUI 及其他原生平台未验收。PI 自动初始化/include/端口/
子代理独立工作树尚未接入，不宣称 worktree 全量对齐。T25-B 缺口不变，T27 后台
命令尚未开始。见[证据与后续](validation/OMP-worktrees-20261018.md)。


2026-10-18（会话交互续做）：**T25-C 已完成本机源码验收。** 原生 Todo 折叠清单及
当前分支恢复、`/skill:` 命名空间及派发时作用域校验、左侧会话日期/项目运行与
待审批状态/复制菜单已实现；`steer` / `followUp` 补齐组件→Store→真实原生路径。
命令目录迟到后误派发到新会话的竞态已 RED→GREEN。497 shared 源码、556 OMP
（零跳过）、49 agent-host、25 i18n、300 桌面回归和原生流程 1 项通过，构建/类型/
lint/规格/架构门通过。版本仍为 0.1.0，未提交或发布；安装态 GUI 未验收。
T25-B 既有分支/子代理接口缺口不变，T26 worktree 与 T27 后台命令仍未开始。
见[验证与交接](validation/OMP-session-ui-20261018.md)。

2026-10-18（会话操作优先）：**T25-A 已完成本机源码验证；T25-B 接口缺口保持关闭。**
独立分支 `codex/omp-session-operations`，基线 31acbf9，版本保持 0.1.0。
实现文本插话、宿主持久 FIFO 跟进、手动压缩与取消，修复原生快速结束时队列错误
归属/复活回合。548 OMP（7 显式跳过）、988 shared、49 agent-host、188 桌面回归、
真实 OMP E2E 1 项通过，类型/lint/双语规格检查通过。完整分支和单独停止子代理仍受
固定运行时接口限制，**未实现、不开放、不记完成**。按单阶段约定，T26 worktree
与 T27 后台命令尚未开始；未提交/推送/打包。见[验证与交接](validation/OMP-session-operations-20261018.md)。

2026-10-18（超长截图同版本 GitHub 打包）：**已完成并验收。**
版本保持 0.1.0，产品源码 `08987f9`，固定 tag `release-check-0.1.0-08987f9`；
[run39045810964](https://github.com/MisterBowie/omp-desktop/actions/runs/39045810964)
整轮 success。完整源码门及四目标截图、打包、包内和实际安装流程步骤全通过；
八份非空且未过期制品的固定来源及 GitHub SHA256 摘要由候选验收器接受。
安装包在该 run 的 Artifacts；既有稳定 Release 未覆盖，同版本需手动下载安装。
本机未下载八份 ZIP 逐字节核验；远端安装/历史图片未修改。
见[最终证据](validation/Browser-screenshot-bounds-20261017.md)。下方旧状态保留为历史。

2026-10-17（超长浏览器截图）：**已按 PI Desktop 最新官方实现完成本机源码修复。**
官方 e219a3e 截图方法与本地修复逐字一致，完整页面等比缩放至 1280 × 2048 CSS
像素以内；真实长页面 345 × 9663 → 73 × 2048，2 倍屏 → 146 × 4096。
22 项回归、真实 Electron 六项流程、类型/lint/双语文档检查通过；未发布或修改远端
会话，历史超限图片不自动改写。见[验证记录](validation/Browser-screenshot-bounds-20261017.md)。
用户已追加授权提交 GitHub 打包并保持 0.1.0；四目标构建增加原生截图门，
10 项发布回归及版本/基线检查通过，构建结果待同候选 run 验收。
首轮 19f38e5 / run39043492205 新增截图门因 Electron 开发 dist 缺失而失败，
已补官方安装步骤并前移预检；本机相同缺失场景恢复后默认路径六项通过。
第二轮 d268777 / run39045061849 Mac 双架构截图通过，Linux/Windows 夹具仍失败。
已调整为独有可见窗口及单页面尺寸更新，本机六项通过；保留全部断言及超时，待新轮原生验证。

2026-10-16（0.1.0 + GitHub 更新）：**已完成稳定发布、真实更新检查与全量公开资产回读。**
[下载v0.1.0](https://github.com/MisterBowie/omp-desktop/releases/tag/v0.1.0)，源码154bc03，
原生run38862126801及发布run38869364763均success。Mac双架构、Windows、Linux
各包内严格15项/0skip、实际安装8项、两次正常退出零残留；同批安装包原样晋升。
包括彩色像素π、已验收LSP修复、0.1.0版本线及自己的GitHub下载/更新源。
公开ARM DMG已本机安装实测GitHub up-to-date/currentVersion0.1.0/manual，
一次正常退出无残留；预置PI/OMP哨兵不变。0.15.x首次需手动安装，未签名Mac后续手动更新。
30项公开资产、1,984,514,132字节均已完整下载，API摘要、SHA清单、来源和四份
原始证明核对通过；五份公开feed的实际SHA512/大小与双Mac合并通过。详情见[发布记录](validation/Version-010-release-promotion-20261016.md)。

2026-10-16（后续请求：彩色像素 π 图标）：**已完成本机交付。**
专用工作树 `omp-desktop-pi-icon` / `codex/pi-gradient-icon`，版本 `0.15.3-icon.1`，
参考图配色、像素尾部与黑色圆角底板已覆盖应用/渲染/文档/安装资源。
21 品牌检查、12 项确定性资源、类型/双语文档、本机 DMG/ZIP 与实际安装资源核对通过，
最终正常退出且零自有进程；继承已验收 LSP 修复。修改未提交，未推送/发布/合 main，
未调用付费模型。见 [本机交付](validation/Pi-gradient-icon-local-20261016.md)。

2026-10-16 本机追加 LSP 专项已完成：`0.15.3-lsp.1` / 源码 `8260c37` / fork
`d648d27` / 补丁 `.6`。Write/Edit 自动诊断与结果显示、真实 TypeScript 语义跳转、
实际安装界面及重启历史均通过，2 次正常退出无残留；546/161/81 回归及包内严格
Plan/Goal 15 项通过。只保存在独立本机工作树，未发布或替换公开 M7；不调用 DeepSeek。
详见 [LSP 专项验收](validation/LSP-coding-local-20261016.md)。

截至2026-10-16，M0–M7 / T01–T24已完成并经根复审（测试分发范围）。M7源码46e7bf7、
tag`m7-test-20261015-46e7bf7`、run38717467884全部8作业成功；三平台各15/0/0严格回归、
安装8项/日常6项/升级回退7项，7次正常退出零残留。根完整回读15资产1,500,450,318B及六份
原始证明，并实际复测公开Mac DMG。见[最终M7验收](validation/M7-native-release-20261016.md)。仅Cursor+Plan/Goal排除，
用户原工作和旧main保留。以下日期化旧候选/等待叙述是历史，不能覆盖本条。

M6 / T21–T23 已由根独立接受：源码 438b389、tag `m6-test-20261015-438b389`、run38695889572 全部8作业 success；12公开资产1,497,063,033B已完整下载核验。三平台各包内15/15、实际安装8/8、2次正常退出、最终零残留；本机另运行公开 Mac DMG 同样通过。最终证据 `validation/M6-native-release-20261015.md`。以下旧候选失败/运行中的叙述仅作历史，不覆盖本条。完整 M7/T24（编码/并发/长会话/故障/升级回退/维护交接及三平台包）尚须继续，不提前结束目标。根在本机执行，不等待或调用 DeepSeek，保留所有用户工作与旧 main。

2026-10-15 最新：d2d1dc8/run38690408029 失败，Mac/Linux job success，Windows
安装后项目路径8.3别名断言失败，紧急清理拒绝根外镜像，发布 skipped。已修复
验收器实际路径与正常退出优先，新增 Windows 轻量原生边界检查；本机19/19及
真实 live-app cleanup 零残留。见 `validation/M6-windows-alias-cleanup-20261015.md`。
T21–T23/M6继续原生重测，M7/T24未开始；以下“运行中”已过时。

2026-10-15 最新 M6：d2d1dc8/run38690408029 三平台原生环境检查成功，Linux
整个平台 job（打包、包内回归、实际安装工作流）success；Mac/Windows 尚在运行。
本机新版 Mac 8项流程、2次退出零残留、包内15/15；完整OMP测试542/542、0skip/
excluded。见 `validation/M6-d2-installed-macos-20261015.md`。完整M6未接受，
M7/T24仍是下一大阶段，以下旧状态按本条最新进展理解。

2026-10-15 M6 原生环境：9e59c932/run38689745755 的 Windows homedir 真实逃出
合成 HOME，Mac/Linux检查通过；构建/发布被门阻断。Windows环境策略已修复，
Mac实际bundled回归541/541、0skip，等待新候选三平台原生验收。见
`validation/M6-windows-native-home-20261015.md`。

2026-10-15 M6：首个三平台候选 run38684841320 失败、未发布。Windows 在安装
ASAR 观察器处失败，Mac/Linux 打包失败。冷 Cargo 缓存缺口已本机复现并修复，
ASAR 使用原生路径；新增三平台 HOME/PATH 预检，后续原生验证待跑。见
`validation/M6-cold-cache-native-preflight-20261015.md`。T21–T23/M6 继续进行，
完整 M7/T24 尚未开始；旧 run/tag 保留。

2026-10-15 M6 原生候选已触发：`m6-test-20261015-f6dba8b7` / run38684841320，三平台构建运行中；发布门定向回归49/49、实际本机包内15/15与8项安装流程通过。另完成真实 PI-Desktop 0.15.0 与 OMP 同 HOME 并存、配置分离及 OMP 退出/重启不影响 PI 的原生验证，最终双方零残留，见 `M6-pi-coexistence-macos-20261015`。完整 M6 仍待三平台结果和公开资产回读；M7/T24 未开始。

2026-10-15 M6 本机安装验收补充：产品构建 `de691ca`、验收脚本 `44da48e` 的真实 macOS arm64 DMG 流程已通过：默认 `.omp-desktop` 目录、预置 PI/OMP 配置隔离、实际拒绝/批准一次/项目测试/三级子进程停止、正常退出/无重放恢复/新回合、最终自有进程为零。原始证据 `docs/validation/M6-installed-macos-local-20261015.md`。T22 继续进行中，T23 原生 Windows/Linux 与完整 M6 三平台交付尚未完成；随后仍需完整 M7/T24 和三平台包。

2026-10-15现行状态：用户已恢复完整目标，由根模型本机执行；DeepSeek恢复由用户通知。**M5功能与三平台交付已完成并接受**：tag `m5-test-20261015-bdec5007`、源码bdec5007、run38671315205全部成功；Mac/Windows/Linux各15/15、0fail/skip，9个公开资产已在本机完整下载并核对全部摘要/字节/固定坐标。证据`docs/validation/M5-native-release-20261015.md`。当前完整M6/T21–T23进行中（本机T22-A身份/品牌/声明代码与139/139定向检查完成，真实安装/平台生命周期仍待验收），随后M7/T24；各阶段3平台包仍必需，下面2026-10-03及更早长段是历史。

状态：`待开始`、`进行中`、`已完成`、`阻塞`。只有附验证证据才能将实现任务标为已完成。

2026-10-03三平台准备状态（历史）：**M5 功能已由根独立接受（`860c264177314f5c9501f90c2ef6bcbcd6aaa11b`）；M5 三平台 GitHub 测试包为当前待交付项**——发布准备（根工作流三平台矩阵、安装身份修正、包内验收与发布校验脚本、测试与文档）已在分支 `codex/m5-three-platform-packages` 完成；根复审后在 `0a4750d0` 列出 R1–R3 补正项，2026-10-03 已普通追加提交完成（Git 证据完整性、发布说明观测局限、失败诊断上传与退出码）；首次 native CI run `37133058318` 又暴露 R4——pnpm 把独立 `--` 送进发布入口致 exit 2，2026-10-03 已普通追加修复 `13fe139`（工作流调用直接传架构 + 真实 pnpm→生产 parser 执行测试与负对照），待根复核；复核通过后由根创建受控 `m5-test-*` tag 触发 native CI 与统一 prerelease（本轮不创建 tag、不触发 Actions、不发布、不 clobber 旧 `m5-preview`）。证据 `docs/validation/M5-three-platform-packages.md`（返修见其 §10/§11）与 `docs/validation/M5-three-platform-packages-repair1-20261003/`、`docs/validation/M5-three-platform-packages-repair2-20261003/`。**T21 整体、T22、T23、T24/M7 仍未交付**，完整目标保持 active。

阶段历史（截至三平台准备前）：M5/T20 **进行中（2026-10-03：B1/C/B2 已独立验收（`bff27e11`/`94910160`/`2d96fa1e`）、D-Enter 已由根验收（`68519ea1`）、T20-D 首稿 `8a1dd8fc` 的 R1–R4 已由根独立复验闭合；根随后在 `2093f271` 判 changes-required（R5 用户气泡重复、R6 重启后历史不可见），第二轮定向返修后根再在 `b6a9e4c2` 判 changes-required（R7 失败的历史浏览改写原生文件、R8 临时 reader 生命周期、R9 元数据失败伪装空历史、R10 显式 null 叶回退）；第三轮定向返修后根再在 `e33bc98c` 判 changes-required（R11 完整无 LF 末行被丢弃、R12 损坏/半写记录被伪装成成功历史），第四轮定向返修完成；根在 `80ce94ac` 复核 R11/R12 闭合，但以原始已提交 UI 脚本两次真跑判出 R13（清理把共享 patched tree 当所有权凭据、SIGTERM 外围复验父进程组），第五轮定向返修完成、本机验证通过；根在 `76118d5f` 再判 changes-required（R13b 主清理函数在身份被拒后仍向旧 PID/组发信号、R13c 缺失 birth 的裸 PID root 被数字认领），第六轮定向返修完成、本机验证通过、待根复审）**——用户已把 **Cursor + Plan/Goal 移出范围（不支持且拒绝，ADR 0306 门全部保留；不全局禁用 Cursor——组合门不拒绝 Cursor + Agent，桌面尚未接通 Cursor 传输、本轮不新增该能力）**；非 Cursor、由已补丁 agent loop 裁决的受支持 HTTP 模型路线仍在范围内，且必须满足严格契约（全部 `toolCall` 计数、混合批次零副作用、`sole` 关闭投机、终支 terminate；不得降级为"尽量阻断"或缩小批次计数）。2026-10-02 在现基线（OMP `62bc57be` + patch `62bc57b+omp-desktop.3`）复测：`t20-feasibility.mjs --patched` **46/46、exit 0**；Cursor 门三份 desktop test **18/18**、共享 predicate **7/7**、host-core `plan_goal_guard` **15/15**、manifest 消费方回归 **13/13**（证据 `docs/validation/M5-t20-non-cursor-scope.md`）。**T20-B1（运行域 mode/policy 状态与合约工具目录）首稿未通过独立复审（F1 缺失/不可解析状态静默继续、F2 拒绝无终态、F3 Plan 中新增插件在 Agent 丢失、F4 `ast_edit`/`debug`/`lsp` 被提升顶层），首轮返修提交 `064c738a` 通过 F1-F4 复核但被第二次独立复审判 R1-R3（R1 删除状态+标记文件后强制通道仍降级为可选并发出 1 次 provider 请求；R2 新增的标记 writer 跟随符号链接覆盖外部目标；R3 上一代精确拒绝描述符在下一代 `agent_start` 前重放会关闭新代），2026-10-02 第二次返修完成并通过本机全量验证、待复审（分支 `codex/m5-t20-b1-runtime-state`，证据 `docs/validation/M5-t20-b1-runtime-state.md` §9/§10、RED 归档 `.../repair-red/`、`.../repair2-red/`）；T20 未完成、Plan/Goal 未实现、`plan`/`goal` 能力保持关闭**。**2026-10-03 更新：B1 已由根复审独立验收（`bff27e11363d3a60b59265ff91d2fb3d814b574a`，根证据归档 `docs/validation/M5-t20-b1-runtime-state/root-acceptance-20261003/`，附归档整理提交 `95023d5`（RED 日志确定性 gzip）与 `02bf603`）；T20-C（执行时权限硬拒绝与插件真实 mode）已实现并通过本机全量验证、待独立复审（分支 `codex/m5-t20-c-execution-policy`，提交 `a7d0291bf500918e754b6a7e9870e3b8961d4e71`，证据 `docs/validation/M5-t20-c-execution-policy.md`）**；gap 探针现为 g1/g2 RETIRED + g3 open（exit 1 预期）；**2026-10-03 更新 2：T20-B2（提交/审批/派发）已由根独立验收（`2d96fa1e`），T20-C 已由根独立验收（`94910160`）；T20-D 首稿 `8a1dd8fc` 被判 changes-required（R1–R4）、定向返修完成、本机验证通过、待根复审（分支 `codex/m5-t20-d-capability-ui`，基线 `68519ea1`，补丁级 `.5`，证据 `docs/validation/M5-t20-d-capability-ui.md` 与 `.../repair-20261003/`）。**下一阶段：根复审 T20-D。**用户目标第 9 条（2026-10-02 落盘）**：B1/C/B2/D 是 M5 内部步骤，整个 M5 验收后执行三平台 native 构建（至少 macOS arm64 / Windows x64 / Linux x64）、真实 Resources 验收与独立 prerelease 下载交付，之后 M6 等大阶段同样交付；交付附精确已验收 commit/hash/provenance/构建链接，诚实标注未签名/未公证、不发 latest 更新 feed。既有 `m5-preview` 仅有 Linux/Mac、无 Windows且不代表本轮；根仓库仅 `mac-preview` workflow 有效（嵌套 `app/.github` 不自动触发），后续由根 workflow 三平台真实跑绿后才发布；用户已授权测试包发布，本轮 B1 返修不发布、不启用流水线。**历史事实（保留）**：T20-A（Plan/Goal 能力审计、基线红灯诊断与最小实现契约）已完成并经三轮复审返修（R1-R4、F1-F7、F8-F12）与一轮纯文档澄清（F13/F14）（分支 `codex/m5-plan-goal-capability-gates`；坐标：审计基线 `2ca2565` → T20-A 初稿 `07de0a7` → R1-R4 `5da616f` → F1-F7 `dd2ec72` → F8-F12 `25e0d4d`）。**T20-R3B（provider/bridge 层可行性审计，分支 `codex/m5-r3-provider-gate`，基线 `e56979e`）已完成并返修（复审 F1-F5，`docs/validation/M5-omp-transition-patch.md` §9/§10）**：本轮用真实 Cursor exec provider 派发器 + 真实 `CursorExecHandlers` 桥接的确定性 RED 实验证明混合批次的兄弟调用在批次裁决前物理执行（**严格 R3 契约检查 12 项全部违反 = 0/12 成立**；另 3 项候选方案检查单独统计 1 成立 / 2 违反，不计入契约、不参与退出码），并逐项判定两个候选方案——**延迟 exec 到 message_end 自锁死**（`cursor.ts:949-960` 在 `done` 前 drain 所有 exec handler，上游 http2 测试 `cursor-terminal-error.test.ts:453-521` 同断言）、**全 loop 路由（关 `mcp` bridge + `cursorExternalToolExecutor`）仅非原生半边在 exec 分支一级可测（未证明 loop 接管或恰好一次）且原生帧无任何请求侧开关**（`AgentRunRequest`/`RequestContext` 字段枚举无此能力；`cursorExternalToolExecutor` 仅 auth-gateway 设置），只能"永久拒绝原生帧 = 伪造 `Tool not available`" = 产品限制。**故 R3 仍为硬阻塞，T20-B/C/D 不得开始**；未改生产代码/patch/manifest/测试/子模块（证据 `docs/validation/M5-omp-transition-patch.md` §9、`app/experiments/omp-bridge/t20-cursor-exec-order.mjs`）。**T20-R3A（OMP 过渡工具契约补丁轮）已完成返修**（分支 `codex/m5-omp-transition-hooks`，基线 `ba7806c`，patch level `d49918f+omp-desktop.1`）：补丁提供 loop 层收敛（全部 toolCall 计数、声明 sole 工具的会话关闭工具投机、批次拒绝、terminate 透传、RPC 边界严格校验）与可复现的 patch/应用脚本入口，但独立复审 **F3 判定严格契约在本层不可实现**——OMP 的 `kCursorExecResolved` 调用在 assistant message 形成前已由 provider/editor bridge 执行，副作用不可撤销，任何 loop 层实现都无法保证「整批零副作用」。**因此 R3 仍是硬阻塞，T20-B 不得开始；上一轮「R3 已解除 / T20-B 可以开始」的声明已撤回。** 第二轮独立复审返修（F6-F9，`474408de` 之上，补丁 artifact 未改动）修完脚本层的 canonical 解析（macOS 系统别名 + `--source` 保护边界）、进程组退化 pid 防护与 flag 取值边界，脚本测试 17 → **24 项全过**；第三轮只做跨平台测试修正（`81ab2ce` → `47d0258`），其后 macOS **24/24（连续两次）** 已由独立复审在本机实跑确认；**R3 结论不变**。证据：`docs/validation/M5-omp-transition-patch.md`。**T20-R3C（Plan/Goal × Cursor 产品门）已实现并验证，并经独立复审返修 F1-F7**（分支 `codex/m5-cursor-plan-goal-gate`，基线 `eaf014f`，最新一轮 F7 为 `692994c` 之上的追加提交）：守卫是每连接 TEMP 触发器，升级路径固定为「**迁移前**清理 `876fb07` 留下的持久残留 → 迁移链 → **迁移后**安装 TEMP 守卫」，因此从 `876fb07` 直接跳到带新迁移的版本不会被旧触发器中止（历史迁移会写 `sessions.mode`，如 v7→v8 的 `chat`→`plan`）；清理只删两个确切名字，未识别（`user_version=0` 有表 / 高于 `SCHEMA_VERSION`）的库先拒绝且不被改动。证据：`docs/validation/M5-cursor-plan-goal-gate.md`。T20-B/C/D 未开始，T20 未完成。**T20-R3D（OMP 18.3 与 nornzach fork/bundled-sidecar 架构审计，分支 `codex/m5-omp-18-3-architecture`，基线 `4a7a5d82`）已完成（只读审计 + 确定性对比 + `/tmp` scratch 的 `git apply --check`；不改生产代码/子模块/patch/manifest；独立复审 F1-F6 已返修）**：以源码核对 oh-my-pi-gui 的架构——Electron spawn 的 sidecar argv 以固定模式前缀 `--mode rpc-ui` 开头并追加受控参数（`--mode` 在 flag 拒绝名单内，模式不可被用户改道），**不从系统 PATH 解析 `omp`**，常规打包产物以 `Resources/omp` 为首选内置资源（但 `OMP_BUNDLED_OMP`/资源树扫描/`OMP_SIDECAR=source` 均无 `app.isPackaged` 门，打包态“固定 sidecar”需我们自己加门 = R4-9），运行期不需要 Bun；sidecar 由外层 monorepo（设计上的 nornzach fork）用 Bun 编译为独立二进制（`resources/omp*` 被 gitignore），但构建脚本不校验外层仓库 remote/commit、0.9.9/0.9.10 的 CHANGELOG 无 SHA，**不能**把已发布产物精确归因到 `81b9f250`；13 个指定文件中 6 个在 can1357 v18.3.0 与 fork 之间逐字相同，其余差异分为「与过渡契约无关的 fork 产品改动」「fork 专有 RPC（`rpc-plan.ts`/`rpc-modes.ts`/`set_plan_mode`/`plan_proposal`/`plan_approval`/`set_goal`）」「格式化漂移」（符号级核验为**弱证据**，只说明未发现符号级缺失）；fork 未实现 PI 的 SubmitPlan/SubmitGoal 合同（全树 0 命中），其 Plan/Goal 为 OMP 原生语义（Plan=`write xd://propose` → `plan_proposal` → 静默 abort → `plan_approval`；Goal=`GoalRuntime` create/replace/pause/resume/drop + continuation）；18.3 的 `BeforeToolCallContext.assistantMessage` 只有整批可见、没有整批裁决，`prepareToolCallDispatch` 只在最终/常规 loop dispatch 前执行而投机可在 `toolcall_end` 抢跑（`deferBeforeToolCall` 只有本地读宿主声明），Cursor 预执行路径与 18.2.7 同构，**R3 仍阻塞**；补丁 40 个 hunk 对 18.3 适用 39/40（修 1 个注释锚点）、对 fork 38/40（修 2 个锚点），**已进上游 0 项**。证据 `docs/validation/M5-omp-18-3-fork-audit.md`（返修核对见 §12.1）。T20-B/C/D 未开始，T20 未完成。

2026-10-03（M5 三平台测试包：发布准备与原始 Git 交付）：**分支 `codex/m5-three-platform-packages`，基线 `860c264177314f5c9501f90c2ef6bcbcd6aaa11b`（根已独立验收的 M5 功能最终提交），普通追加提交，不 amend/rebase/强推；本轮不创建 tag、不触发 Actions、不创建/上传 Release、不合 main、不建 PR。**固定子模块（PI `0111e306`、OMP `62bc57be`）与受控 fork（`36483311…`、补丁级 `.5`）未动；证据 `docs/validation/M5-three-platform-packages.md`（R4 见其 §11 与 `docs/validation/M5-three-platform-packages-repair2-20261003/`）。

- **根工作流** `.github/workflows/three-platform-test-packages.yml`：仅由受控 `m5-test-*` tag push 触发（无 `workflow_dispatch`，推准备分支不启动打包）；guard 作业把 tag 与 `GITHUB_SHA` 绑定并拒绝任何其它事件；矩阵 macOS arm64（`macos-15`）/Windows x64/`ubuntu-22.04` Linux x64，实际断言 `uname -m`/`PROCESSOR_ARCHITECTURE` 与 `process.platform/arch`；node 24 + 产品 `packageManager` pnpm 10.34.5 + 冻结 lockfile + 桌面 stable Rust（与 fork 的 `rust-toolchain.toml` nightly 分离）+ bun 1.4.2 + fork `fetch-depth: 0`/冻结依赖/host native addon；打包只走 `dist:mac|win|linux`（`--publish never` 在脚本内），不传平台/配置/publish 参数、不 `--prepackaged`、不在 builder 之后注入资源；macOS 为未签名通道（无签名/公证 secret）。
- **包内验收与包内回归**：把本次 electron-builder 输出的真实 `Resources` 复制到仓库外含空格与中文的路径（自有 HOME/XDG/TMPDIR）后运行生产 `verify-packaged-runtime.mjs`（hash/provenance、version/protocol/`get_state`、精确 missing-gate 拒绝、停止/回收/runroot 清理）；再由 `OMP_E2E_PACKAGED_RESOURCES` 驱动既有真实 `omp-plan-submit-e2e.test.mjs` 对**包内** sidecar 与 gate bundle 重跑 Entry/Goal/Submit 用例（本地 FakeProvider，零付费调用）。
- **发布装配与回读**：`stage-test-package.mjs`（单平台：pins/验收/回归三重校验后按精确名暂存并写 `build-record.json`）与 `assemble-test-release.mjs`（三平台恰好齐全、复核 revision/version/stage/pins 与磁盘摘要、自排除 `SHA256SUMS.txt`、`BUILD-RECORD.json`、release notes；`--release-json` 在线校验）。publish 作业 `needs: [guard, build]`、`contents: write`、`gh release create <tag> --verify-tag --prerelease`（不 `--latest`、不 `--clobber`、不触碰 `m5-preview`），随后回读 tag/prerelease/资产名与字节/下载 URL、断言不是仓库 `latest`、下载全部资产 `sha256sum -c` 复核。
- **安装身份（并存最小改动）**：`desktopName`→`omp-desktop.desktop`；Windows `executableName`/`shortcutName`→`OMP Desktop`、portable `unpackDirName`→`OMP-Desktop-Portable`；Linux `executableName`/deb/rpm `packageName`→`omp-desktop`；全部 artifactName 改 OMP（新增 `linux.artifactName`，AppImage 不再用带空格默认名）；`description`/`homepage` 改 OMP/MisterBowie；mac 权限说明与两个帮助文件改名改文案（**不使用 sudo、不接受任意路径、不要求密码**）。保留 `@pi-desktop/*` 内部命名空间、`pi-desktop-host-core` 文件名与上游 author/许可证。
- **本机真实证据（Linux x64）**：`pnpm run dist:linux` **exit 0**（2m38s，AppImage+deb+rpm）；隔离路径 `verify-packaged-runtime` `mode=run`/omp 18.3.0/protocol v2/`get_state`/gate control refused/stopped+reaped+cleaned；包内回归 **15 passed / 0 failed / 0 skipped**；真实元数据 deb `Package: omp-desktop`/Homepage OMP/`/opt/OMP Desktop/`/`omp-desktop.desktop`（`Icon`/`StartupWMClass=omp-desktop`）、rpm `Name omp-desktop` URL 同上、AppImage 内嵌同名 desktop entry；发布装配以真实 Linux + 两个**合成**平台夹具跑通（合成部分不冒充平台证据）。
- **未做/不声称**：macOS/Windows 原生构建与验收（待根创建 tag 后的 native CI）、签名/公证、安装器真实交互、`.dmg`/`.exe` 产物、Windows 包内回归是否有平台 skip、工作流在 Actions 的首次真跑；未创建 tag/Release，未触碰 `m5-preview`。已知未处理项：electron-builder 由包名派生的 updater 缓存目录名在两产品间同名（不可配置覆盖，影响仅限磁盘缓存共享），记入 T22。
- 返修轮 R1–R3（2026-10-03，根在 `0a4750d0` 复审后，普通追加提交）：R1 把清单列出但被根 `.gitignore` 的 `*.log` 忽略的 `linux-dist-build.log`（18052 B/`9eb36eaa…`，字节不改）用 `git add -f` 精确纳入 Git，并校验清单/磁盘/Git tracked 三个 12 文件全集相等（自排除 `SHA256SUMS.txt`，12/12 摘要匹配）；R2 发布 notes 不再把无 `/proc` 主机的 child PATH/HOME 写成已断言（`not observed (…isolated launch config used, PATH/HOME not asserted)`），新增夹具测试覆盖 true/false 输出；R3 验收步骤在可能失败的 verifier 之前发布 `iso` step output、把 verifier stderr 与退出状态保存到 failure artifact 上传的 `packaged-runtime.stderr.txt`、以 `exit "$verify_status"` 保留原失败退出码（不 mask、不变绿），另有工作流契约测试与从工作流提取真实步骤体、以失败 stub 运行的 probe。相关 11 文件套件 **78 passed / 0 failed / 1 skipped**（macOS 专属跳过）。证据 `docs/validation/M5-three-platform-packages-repair1-20261003/` 与验证记录 §10。
- 返修轮 R4（2026-10-03，首次 native CI `37133058318` 后，普通追加提交 `13fe139`）：pnpm 会把独立 `--` 追加到链尾 `scripts/release-package.mjs`，入口拒绝该分隔符并 exit 2（run `37133058318` 的 Linux job 失败原文 `... --platform linux --publish never -- --x64`，Exit status 2；原 run/tag 保留未动）；工作流打包调用改为直接传架构（`... ${{ matrix.dist }} --${{ matrix.arch }}`；显式架构与脚本内 `--publish never` 保留，入口/守卫/sidecar 预检/builder 参数来源/fork pin 未动）。静态断言（`:168`）此前锁定的正是错误文本，已同步为正确调用并加“构建作业不得出现独立 `-- --`”断言；新增执行测试用**真实 pnpm** 在仓库外夹具驱动**生产 `parseReleaseArgs`**，覆盖 darwin/arm64、win32/x64、linux/x64（每轴恰一次声明、`forwarded` 为空、argv 无独立 `--`），旧 `-- --<arch>` 负对照必须仍 exit 2 且错误文本一致；RED 对照把旧拼写塞回工作流时该测试以生产拒绝判红并按字节还原。定向 11 文件套件 **80 tests / 79 pass / 0 fail / 1 skipped**、`omp-release-gate` **16/16**、真实 pnpm 探针/RED 对照/证据完整性（11/11）与 `check-release-docs`/`docs:check` 全 exit 0；同拼写仍留在旧预览 lane、`app/.github/workflows/*` 参考 lane 与 app 文档/入口头注释（均非本矩阵生效入口，按 R4 最小范围未改，见证据 README §4）。未重跑编译器/全量桌面套件/昂贵打包。证据 `docs/validation/M5-three-platform-packages-repair2-20261003/`（含自排除 `SHA256SUMS.txt` 与完整性脚本）。

2026-10-03（M5/T20-D 能力键、真实桌面闭环与完整矩阵）：**分支 `codex/m5-t20-d-capability-ui`，基线 `68519ea19f6fee37fec2c5817256f3a68ea8606e`（根已接受的 D-Enter 最终原始提交），普通追加提交，不 amend/rebase/强推，不发布、不合 main、不建 PR。**补丁级保持 `62bc57b+omp-desktop.5`（fk/固定子模块未动）。

2026-10-03（M5/T20-D 第二轮定向返修 R5/R6）：**同一分支 `codex/m5-t20-d-capability-ui`，基于 `2093f271318294881085f2ee8d047ace2e51ad41`（根已独立复验的 R1–R4 提交）普通追加提交，不 amend/rebase/强推，不发布、不合 main、不建 PR。**补丁级、fork（`36483311…`）、gate、host-core 未动。根在 `2093f271` 判 changes-required：R5 一次提交的用户气泡渲染两次（`agent-ipc` 自行回显 + 转换器另铸 id）；R6 重启后 OMP 会话面板看不到已产生历史（`sessionGet` 只读宿主 messages）。修复：①prompt 身份绑定（乐观 id 随 prompt 进 bridge/runner，转换器报 `user_message_persisted`，Main 不再回显）；②OMP 只读历史投影（`get_entries` → 活动分支 → entry id 行；已有运行时复用、否则用不带凭据的只读配置启动瞬时 runtime，读完 `new_session` 后再回收以保证原生文件字节不变；fail-closed）；③实时行台账 + 尾部读取的 `replacedLiveMessageIds`（渲染层按 id 丢弃被替换行，绝不用内容/时间去重）。证据 `docs/validation/M5-t20-d-capability-ui/repair2-20261003/`（双树 RED/GREEN 探针、bridge/真实 runtime 读取测试、受影响套件、真实 UI E2E 13 张截图 + raw JSON）。ADR 0313；runtime spec §18（英/中）同步。
- **B9 能力与入口（ADR 0312）**：`EngineCapability`/`ENGINE_CAPABILITY_KEYS` 新增 `plan`/`goal`，Pi/OMP 均声明开放；`EngineRouter.requireContractMode` 判定声明（未启动≠永久不支持）；Main 三个边界（`sessionCreate`/`sessionConfigure`/`agentPrompt`）在任何写入/启动前用同一张表拒绝未声明的契约模式；渲染层 `offeredModes(engine)` 驱动 composer 模式循环（不支持的不出现、单模式禁用、无模式隐藏）。RED：实现暂存后 shared 2 失败、desktop 3 失败；GREEN：shared 14/14、desktop 20/20。Pi 行为零变化。
- **D3 真实用户路径**：新脚本 `app/scripts/e2e-omp-plan-ui.mjs` 用真实 Electron 渲染层 → preload/Main → 真实 host-core/SQLite → 生产 bridge/gate → 固定 patched 运行时（`OMP_DESKTOP_RUNTIME`）+ 本地 FakeProvider，完成切 Plan、真实 SubmitPlan 与审批卡、不可变工件、Reject 后修改重提（旧字节不变、审批不串会话）、ask 批准真实权限卡 + Allow once 落盘、accept-edits 无卡落盘、第四份 pending 后真实应用重启（interrupted、completed 不重放、无新 provider 请求）；`SUMMARY 1 passed, 0 failed`。证据 `docs/validation/M5-t20-d-capability-ui/`（日志 + 8 张截图）。
- **D3 定向返修（R1–R4，2026-10-03，仅 harness 与文档）**：R1 补**第三种权限 auto**（真实审批菜单，high-risk `bash` 无卡执行，durable `target_permission_mode=auto`）与**已批准执行中的应用/Host 重启**（`/bin/sleep` 子进程把 execution 持在持久 `running`；终止旧应用/Host/OMP 进程组并核对退出后原数据目录重启 → `interrupted`/`PLAN_EXECUTION_INTERRUPTED`、turn `aborted`、audit 行、provider 请求不变、副作用不重复、恢复回合可用）；R2 子进程专属 HOME/XDG/TMPDIR 隔离 + PID/PPID/PGID/starttime/cmdline 自有进程身份与 SIGTERM→SIGKILL 回收验证（仍存活即失败、保留 scratch 且非零退出）；R3 结构化 `repair-20261003/omp-plan-ui-raw.json`（provider 请求、真实身份、只读 SQLite、工件 sha、进程/回收/清理；redact 凭据形状字段）并修正摘要里 proposal id 冒充 execution id；R4 同步英/中 runtime spec、矩阵状态说明与 ADR 索引（`docs:check` 现 exit 0）。返修轮 `SUMMARY 1 passed, 0 failed`、exit 0、`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`；证据 `docs/validation/M5-t20-d-capability-ui/repair-20261003/`（12 张截图 + raw JSON + 自排除清单）。
- **发现并修复的产品缺陷**：`sidecar.ts` 的事件扇出把 **Pi** 回合所有权过滤施加到 OMP 终止事件上（OMP 会话无 Pi `activeTurns` 条目），OMP `agent_end`/`error` 全部被丢弃，渲染层永远"运行中"、Reject 后无法重提。修复：抽出 `runtime/agent-event-fanout.ts`，`guardPiTurnOwnership` 默认开启，`wireOmpSessions` 以关闭门扇出（OMP runner 自身按代际守卫）；新增单测与组合根接线断言，UI E2E 断言渲染层收到 `agent_end`。
- **D1 Goal + B13 生命周期**：`omp-plan-submit-e2e.test.mjs` 新增两例真实 E2E（Goal 工件 `.pi/goal` 字节/sha/大小、Goal block 与只读目录、批准后普通 Agent 回合自停无延续定时器；同一 native session Agent→Plan→Goal→Agent→Plan 目录严格对照无残留、mode block 逐字节同 PI）；`2 passed / 0 failed`、exit 0。
- **全矩阵**：B1–B14/C1–C8/D1–D3 共 25 行映射见 `docs/validation/M5-t20-d-capability-ui.md` §3；D2 按矩阵可选、未实现。T20 整体待根复审；M5 三平台包、T21/T22/T23/T24/M7 未交付。

2026-10-03（M5/T20-D 第三轮定向返修 R7–R10）：**同一分支 `codex/m5-t20-d-capability-ui`，基于 `b6a9e4c2ac0625ffd37b61f3d007f9992b8dfa23`（根在第二轮后判 changes-required 的候选）普通追加提交，不 amend/rebase/强推，不发布、不合 main、不建 PR。** fork（`36483311…`）、补丁级（仍 `.5`）、gate、host-core、固定子模块与 UI E2E 脚本未动。根以真实 macOS arm64 原生运行时故障注入（`history-failure-native-mac.json`：成功 1821→1821；`get_entries` 拒绝 1821→2028；`get_state` 身份不符 2028→2235；detach 取消 2235→2442；detach 超时 2442→2649，后两项还错误返回成功）与注册 IPC 的受控边界探针（`history-boundary.json`）判定四组缺陷：R7 失败的历史浏览改写被浏览文件；R8 临时 reader 未纳入 bridge 生命周期（stop 未回收仍报成功、dispose 跨 await 后 reader 继续启动）；R9 引擎/引用读取失败被降级为 Pi 或空历史；R10 显式 null 活动叶回退到最后存储分支。修复：①**删除瞬时只读 runtime 读取路径与只读模型投影**，新增进程内直读器 `packages/omp-runtime/src/session/native-session-file.ts`（无 writer/锁/子进程；折叠 title slot、校验 header 身份与版本 2/3、v2 `hookMessage`→`custom` 内存改名、宽松跳畸形、未落幕尾行忽略、叶=最后物理 entry、文件/单记录字节上界），冷读 0 supervisor 构造、0 run 目录；②`withOmpHistory` 的引擎与 `session.getEngineRef` 失败不再 catch 成 pi/null（错误沿 sessionGet/sessionOpen 上抛可重试，成功无引用才是空历史）；③显式 `leafId:null` 渲染空活动分支，缺失/畸形叶拒绝。证据 `docs/validation/M5-t20-d-capability-ui/repair3-20261003/`（30 件 + 自排除 manifest、13 张 UI 截图 + raw JSON 1039569 B）：真实 runtime 等价性与字节纯度（live/cold 行 id 全等；sha `a176c4a2…`/3371 B 跨成功、版本拒绝、身份拒绝与 final 不变；provider 2 不增；supervisor 构造 1/0；run 目录 `[]`）、runtime 35 files/530 passed/6 skipped、shared 86/986、desktop 全量 3045/3034/0/11、UI E2E `SUMMARY 1 passed, 0 failed`（provider 16 无重放、CLEANUP 干净、9/9 历史 overlap、同文本两次两 entry 稳定）、typecheck/lint/docs/矩阵 exit 0。整 M5 仍未完成、待根复审。

2026-10-03（M5/T20-D 第四轮定向返修 R11/R12）：**同一分支 `codex/m5-t20-d-capability-ui`，基于 `e33bc98c1e16500ad9f1b9b068fb1ceb9a70600c`（根在第三轮后判 changes-required 的候选）普通追加提交，不 amend/rebase/强推，不发布、不合 main、不建 PR。**fork（`36483311…`）、补丁级（仍 `.5`）、gate、host-core、固定子模块与 UI E2E 脚本未动。根以真实 macOS arm64 compiled `.5` + production bridge + 原生 writer 的读取探针（5/8；R7–R10 具体缺陷维持闭合）判定两条直读器尾部缺陷：**R11** 完整 JSON 末行无 LF 被一并丢弃（从真实 writer 字节截到第二条完整 user 记录末尾，bridge 返回 2 行/1 user，期望 3 行/2 user，`8fa50d76` 消失；固定 loader 对同字节无 LF 返回同一 user、`malformedRecords=0`，文件未被改写）；**R12** 畸形完整行被跳过（实测 bridge 成功返回 4 行）、合法 header + 不完整 JSON 尾被丢弃（成功返回 0 行，与真正空会话无法区分）。修复：EOF 残片不再一律丢弃——完整 JSON 尾片段按普通记录解析并走同一 header 身份/版本/结构校验（稳定 id、末尾记录为叶），非法 JSON 记录（完整行或未终止残尾）以 `OMP_HISTORY_INVALID` typed 错误拒绝整次读取，消息区分二者，沿 bridge/IPC 可见、可重试；并发写者写到一半时拒绝本次快照、写者提交后重试即可成功；不补写换行、不删除/截断/恢复文件；合法空白行、header-only 与显式空结果语义不变。低层 `parseSessionContent` 的宽松与 `malformedRecords` 保留，桌面读取契约有意不再复制其宽松（文档化分歧）。产品改动仅 `packages/omp-runtime/src/session/native-session-file.ts` + 同步单测/bridge/真实 runtime E2E/规格/ADR。证据 `docs/validation/M5-t20-d-capability-ui/repair4-20261003/`（unit 27、runtime 全量 534/6skip、bridge 9/9、真实 runtime E2E 1/1 且 sha `7892f203…`/3371 B 跨成功/拒绝/final 不变、定向 137/137、IPC 12/12、真实 UI E2E 1/1 于最终源码复跑 13 张截图 + raw JSON、provider 无重放、读取/重选 sha 不变；typecheck/lint/docs/矩阵 exit 0；旧 92 件清单全 OK）。未做/不声称：不改 Cursor 门、不改 fork/补丁、未跑 macOS/Windows 实机；整 M5/T20 与三平台包仍未完成。

2026-10-03（M5/T20-D 第五轮定向返修 R13：UI 清理只能作用于本次自有进程）：**同一分支 `codex/m5-t20-d-capability-ui`，基于 `80ce94ac6cb2a04b883a1062e0ac984b11939c70`（根在第四轮后判 changes-required 的候选）普通追加提交，不 amend/rebase/强推，不发布、不合 main、不建 PR。**fork（`36483311…`）、补丁级（仍 `.5`）、gate、host-core、固定子模块、产品代码与产品会话逻辑未动，本轮只改 UI harness、新增归属 helper/回归与文档。根已在 `80ce94ac` 判定 R11/R12 闭合（构建/类型/lint/docs/source diff、runtime 定向 108、desktop 定向 133、IPC/null 叶边界 8/8、真实 macOS compiled `.5` writer + production bridge 冷读 8/8）；但根两次用**未改的已提交** UI 脚本在 Linux 真 Electron/Host/OMP 上运行时，两次业务断言 `1 passed, 0 failed` 都伴随外围复验父进程被杀：`running-restart.before` 把 Python 复验器 PID/PGID `2279095`（重跑 `2282200`/`2282199`）列入自有，随后 `SIGTERM-owned-groups` 对其整组发 SIGTERM，外围 `root-review.json` 与 shell exit 文件缺失、SSH 退出 255。**R13 根因**：harness 的 `ownedProcessSnapshot` 用 `[tempRoot, patchedTree]` 对全部 `/proc` 命令行做 substring 匹配，而 `patchedTree` 是**共享构建树**（外围正是以 `--patched-tree /tmp/omp-patched-t20d-ui-repair1` 启动它），父级因此被误判为自有；同一树的任何并发使用者都可能被误杀。**修复**：新增 `app/scripts/e2e/process-ownership.mjs` —— 归属只看本次运行的真实证据（记录的 spawn 根 + `starttime` 及其 ppid 后代；argv 元素或环境值中出现的**本次唯一 scratch root**，按路径元素边界匹配、读 `/proc/<pid>/cmdline` 与 `environ`，供被 reparent 的脱离运行时归属；**共享 patched tree 不再是任何所有权信号**；自身与全部祖先（含外层启动器）无条件排除），发信号按组判定（只有组内全部存活成员都是已核对 `starttime` 的自有目标才 `kill(-pgid)`；混合组、自身组、祖先组、显式排除组退化为逐 PID 信号，绝不扩大为整组终止；PID 复用/消失记为 `stale`，`ESRCH` 视为已退出、其余 kill 错误原样上报），重启第一阶段仍只拆 Electron 组（`onlyGroups`）但纯度按**完整自有集合**判定；raw JSON 继续记录 `runRoots`/`roots`/`protectedAncestors`/`excludedAncestors` 与每阶段 `groups`/`pids`/`mixedGroups`/`protectedTargets`/`stale`。回归 `app/scripts/e2e/process-ownership.test.mjs` 16 例（受控进程表 + kill spy：共享树使用者/祖先/路径边界/PID 复用与消失/纯自有组/混合组/自身与祖先组/`onlyGroups` 收窄），另加三例真实 sentinel 子进程冒烟（自有脱离组回收、仅环境携带 run root 的被 reparent 进程归属、混合组只杀自有成员且无关成员存活），只对本任务自己创建的进程发信号。本机先在源码状态用根脚本的等价包装器（仅放宽 HEAD/clean/harness-hash 三条一次性断言）真跑完整 UI 两轮，均 `passed: true`、exit 0、无 `forcedCleanup`/survivors，父级存活并写出报告；提交候选 `a4c1903` 后按根原脚本原样复跑，外围 `passed: true`、exit 0、`statusAfter=''`、无 `forcedCleanup`/survivors，harness `1 passed, 0 failed`、`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`；raw 中父 Python 只出现在 `protectedAncestors`，`before` 无 `python3`，三个阶段均判为整组信号且无 `stale`/失败——详见 `docs/validation/M5-t20-d-capability-ui.md` §1.9/§2.4（主证据 `repair5-20261003/root-review.json` 等 21 件，自排除 manifest）。R11/R12 未重复返修；三种审批权限、running/pending 真实重启、不重放、消息身份、原生字节不变与隔离 HOME/XDG/TMPDIR 断言全部保留。

2026-10-03（M5/T20-D 第六轮定向返修 R13b/R13c：身份拒绝必须贯穿清理全程）：**同一分支 `codex/m5-t20-d-capability-ui`，基于 `76118d5fde020d7bcc8140d0e4a4fa8cb13f9a17`（根在第五轮后判 changes-required 的候选）普通追加提交，不 amend/rebase/强推，不发布、不合 main、不建 PR。** fork（`36483311…`）、补丁级（仍 `.5`）、gate、host-core、固定子模块、产品代码与产品会话逻辑未动，本轮只改 UI harness、归属 helper/回归与文档。根在 `76118d5f` 判 changes-required：**R13b** `terminateOwnedApp` 在 snapshot supported 但 rootEntry 为空（恰是新 helper 判 root-gone/root-reused 的结果）时仍直接 `process.kill(-child.pid, SIGTERM)`、超时分支还直接 SIGKILL——根用受控进程表 + 信号 spy 复现（`ui-cleanup-integration-review.mjs` 1/3、`unexpectedError=false`）；**R13c** `startElectron`/`terminateOwnedApp` 在 `readProcessIdentity` 失败时回退 `{pid}`，helper 只在 starttime 非 null 时比较，裸 PID root 会认领当前同 PID 及其后代（根 missing-birth 探针：unrelated pid100 进入 owned 并计划 `groups:[100]`）。修复：①删除"无法证明拥有时改走直接组信号"的语义——supported 快照下 root 未被认领（gone/reused/缺失身份）时不再对旧 PID 或旧组发任何 SIGTERM/SIGKILL，只清理仍能证明的自有残余（唯一 scratch root 的 argv/环境证据，按其身份/组成员），无法证明则明确失败、`report.rootRefusal` 记录原因、scratch 保留；非 Linux 平台保留原"只验证直接 spawn 组"的诚实降级，Linux 无进程表时同样拒绝信号；②spawn 身份读取失败不再伪造裸 PID 记录（`electronBirth=null` + `spawnIdentityMissing`），helper 拒绝缺失/空/无效 starttime 的 root（`root-identity-missing`），信号计划永不以无身份记录为目标（`identity-missing` → stale）；③新增 6 例回归（2 helper + 4 例从 harness 提取的**实际** `terminateOwnedApp`：reused/gone 零信号、identity-missing 含超时升级零信号并失败、root 被拒时仍回收已证明残余、有效 root 保持 owned 信号路径），保留原 16 例与真实 sentinel 冒烟；④RED→GREEN：`76118d5f` 上根集成脚本 1/3 与 missing-birth 探针 reproduced=true（`-100/SIGTERM`、owned `[100]`），候选 `a6c146d` 上根脚本 3/3、8/8、探针 passed、回归 22/22、语法 3×0；真实 UI 用根原通用外围 wrapper 原样复跑 `a6c146d`：`passed: true`、exit 0、`forcedCleanup=[]`/survivors 空、`statusAfter=''`、harness `1 passed, 0 failed`、`CLEANUP scratchRemoved=true survivingOwnedProcesses=0 errors=0`、13 张截图、provider 18（16 无重放 + 同文本恰 +2）；三个终止阶段均为已证明自有的 Electron 整组信号（`groups=[<electron pgid>]`、`pids=[]`、无 mixed/stale/失败），父 Python 复验器只出现在 `protectedAncestors`（`before` 中 python3 计数 0）。R13 implemented、待根复审；整 M5/T20 与三平台包仍未完成。证据 `docs/validation/M5-t20-d-capability-ui/repair6-20261003/`（27 件自排除 manifest；旧 140 件不可变）与 `docs/validation/M5-t20-d-capability-ui.md` §1.10/§2.5。

2026-10-03（M5/T20-D-Enter 模型侧两种模式入口）：**分支 `codex/m5-t20-d-mode-entry`，基线 `2d96fa1e8bf3848021d1f265c0a258a9c455ef4c`（根已接受的 B2 最终原始提交），普通追加提交，不 amend/rebase/强推，不发布、不合 main、不建 PR。**补丁级升级为 `62bc57b+omp-desktop.5`（fork `codex/omp-desktop-18.3.0-patch-5`，commit `36483311dfff67be7504f591974df93fc512a45a`，patch 118548 B/`64524286…`），固定子模块不动：- **需求与 RED**：固定 PI（`runtime.ts:3595-3630`、测试 `:2138-2320`）与产品 spec（runtime §5b、state-machine 第 12 条）要求模型可调 `EnterPlanMode`/`EnterGoalMode`、成功进入不终止同回合。基线实测（真实 patched 运行时 + 真实 host + FakeProvider + 可信探针扩展）：Agent 目录无两个 Enter 工具；扩展 API 无实时 system-prompt 动作；同回合 `setActiveTools` 能改下一请求目录而 prompt 不变——因此需要最小 fork 扩展（可选 `ExtensionAPI.setTurnSystemPrompt`，缺省即拒绝）而不是按 provider payload 打补丁（ADR 0311、`docs/validation/M5-t20-d-mode-entry/baseline-probe.json`）。
- **实现**：PI 逐字 Enter 工具定义（空对象 schema、essential/exclusive/sole、不 terminate、risk low）；bridge 仅 Agent 目录加入两者；仅新增 `plans.enter` 端点（身份仅来自 binding/run/frame，返回严格校验）；host 提交后 bridge 更新本 live 回合模式并重注册目录（Enter 移除、本模式 Submit 注册），经 settled result `details` 的严格记录（`mode-transition.ts`）到 gate `tool_result` 处理器：校验 native session/fence token/tool-call id/Agent-only/单次使用后，用注入时缓存分片重建 live prompt（base 逐字节、能力块恰一次、仅 mode block 变化）、安装新准入记录（旧记录 delegate 全部退役）并对新目录契约夹取——下一 provider 请求即见新契约。失败/取消：host 拒绝可纠正；记录非法/`state:"failed"`/应用失败则退役准入 + `turn-failure` 结构化通知 + abort，runner 仅对 live running 代际按 **error** 收尾（不误报 completed），durable 行留待下一 prompt 恢复。
- **证据（无付费模型）**：真实 E2E 整文件 **10 passed / 0 failed**（B2 7 项回归 + Plan/Goal/混合批次 3 项新增；Enter 后同一 run 下一请求的 prompt/目录断言、真实审批卡、写零副作用、未声明插件零执行、Submit 工件与终止、Goal 错 kind 不触达宿主、混合批次整批零效果后单调用重试）；omp-runtime **33 files / 495 passed / 6 skipped**；受影响 desktop 套件 **142 passed**；`build:js`/`typecheck`/`lint` 全 0；fork `.5` 六套件 **277 passed** 与 `tsgo` 通过；`omp-patch --check`/`omp-sidecar --check` 通过；真实 Linux sidecar 构建（`omp` 244295136 B/`f6111efd…`、工具门 51786 B/`7cf4fe24…`、provenance `.5`）并经生产 verifier `PACKAGED-RUNTIME-OK`（v2 协商、`get_state`、最小 PATH/隔离 HOME、reaped+cleaned）。
- **首轮独立复审返修（2026-10-03，同一分支追加提交；fork/固定子模块/补丁坐标未动）**：根判 changes-required。**R1** 带 `details` 的错误结果经 frame 顶层 `isError` 被运行时 reject 丢失 → 已提交迁移失败被当普通错误、Write 落盘、turn completed；修复为带 details 的错误改用 `result.isError` 形态结算（普通错误路径不变）。**R2** 非法/不可读的已提交回复被当可纠正；修复为仅四个 CAS 前宿主拒绝码保留可纠正，其余一律 `state:"failed"` 停回合。**R3** Stop/后继回合开始后旧 Enter 的 catalog await 恢复，经当前 runtime 注册旧目录并写坏缓存；修复为 `enterMode` 逐 await 校验准入记录/runner 对象身份与 runner 当前 turn，`registerHostTools` 在请求前与 ACK 后写缓存前复核。**R4** gate 迁移在两个 await 后不再校验 ownership，迟到完成会替换/失败后继 B；修复为 continuation 按记录身份+判定 token 逐 await 复核、丢失即弃权，failure 描述符显式携带该 token。**复审期望修正**：失败回合 `turns.status` 只能是 `completed|aborted|error`（宿主唯一写入点与固定 PI 同），探针实测请求 `"failed"` 会被静默写成 `completed`、`"error"` 才是失败终态，故修复后 durable turn=`error`（脚本原断言保留，修正记录 `repair-20261003-corrections/`）。**返修证据**：根四组脚本本机 RED 复现→gate 5/5、catalog 2/2、normal 2/2、failure-boundary 四例 provider=1/零副作用/error/恢复（2 Stop 对照绿；唯一失败断言为状态词）；新增产品回归（gate stale 3、details 结算 1、adapter 不可判定 2、真实 E2E 3——修前 RED 已存）；omp-runtime 33 files **499 passed**/6 skipped；11 个 desktop 套件 **164 passed**、整 E2E **13 passed**；`build:js`/`typecheck`/`lint` 全 0；gate 重建工具门 52297 B/`dbefff57…` + `PACKAGED-RUNTIME-OK run`；`--check` 通过。
- **第二轮独立复审返修（2026-10-03，同一分支追加提交 `06c73aa2`；fork/固定子模块/补丁坐标未动）**：根在 `171754dc` 仍判 changes-required。**①`before_agent_start` continuation 跨代未绑定**：注入处理器在两处契约夹取 await（transitioned continuation、普通 prompt-time 分支）与统一 catch 后读全局 record/cache/token，后继回合在窗口内启动后，旧回调会返回后继缓存 prompt 或以**后继 token** 发 start-refusal 并清除/abort 后继（根脚本 2/4，本地复现）。修复：每次 await 前捕获真正拥有的 record 本体、token 与应返回的 prompt parts，恢复后返回/缓存发布/refusal/retire/abort 一律先验同一代身份，失去所有权即静默弃权；`refuseStart` 参数化判定 token；当前回合 clamp 失败仍拒绝并终止。**②返修清单自引用**：顶层 `repair-20261003-SHA256SUMS.txt` 先截断再纳入自身（空文件 SHA）；现排除自身、明确覆盖集合，并新增 `evidence-integrity-check.mjs` 验证 10 个清单的摘要/Git 追踪/自排除/文件全集（0 mismatch）。**③受影响套件暴露的首轮遗留**：三条打包 lane 仍 pin `.4`（`manifest.json` 已 `.5`），`packaging-sidecar-source`/`preview-workflow` 两测试因此失败，已对齐清单。本机结果：五个根脚本 4/4、5/5、2/2、6/6、2/2 全 exit 0；新增 5 个 registered-handler 回归 RED→GREEN（`gate-mode-transition.test.ts` 19/19）；omp-runtime **504 通过**/6 skipped；受影响 desktop **166 通过**/0 失败（含真实 plan-submit E2E 13 项）；`build:js`/`typecheck`/`lint` 全 0；重建 gate bundle 53025 B/`3dd09910…` + `PACKAGED-RUNTIME-OK`（provenance `.5`）。证据 `docs/validation/M5-t20-d-mode-entry/repair2-20261003-*`、`evidence-integrity-repair2-20261003.txt`、验证记录 §0.6。
- **未做/不声称**：不开放 `plan`/`goal` 能力键、不改 composer/UI 与整矩阵（留 T20-D）；不改 Cursor 门（ADR 0306）；无 Goal 延续定时器；gate 无法直接核 `liveTurnId`（运行时无 live generation 面；绑定为 fence token+会话+tool-call+单次使用，durable turn 由宿主核验）；原生工具绕过夹取的门层拒绝由 C 证据覆盖；仅 Linux x64；未发 release/tag、未合 main。首轮独立复审未获接受（`f56fe838`）；第二轮复审在 `171754dc` 仍判 changes-required（`before_agent_start` continuation 跨代未绑定、返修清单自引用；另由受影响套件暴露三条打包 lane 仍 pin `.4`）；两轮返修完成（`6a4ecbd`、`06c73aa2`）待根复验，不自行宣称通过。

2026-10-03（M5/T20-B2 提交/审批/派发闭环）：**分支 `codex/m5-t20-b2-approval`，基线 `9491016062e36a2967cf3db74d2a4990421d9d30`（C 的根已接受最终提交），追加提交，不 amend/rebase/强推，不发布、不合并 main。**在用户授权范围内实现矩阵 B4-B8、B13 与 D1/D3 的闭环；`plan`/`goal` 能力键与 UI 按引擎门禁的整体验收留 T20-D，本阶段未证明（`EngineCapability` 目前没有这两个键、`ComposerToolbar` 无 engine/capability 输入，键缺失不能证明 UI 隐藏/禁用）：

- **补丁级 `.4`**（fork `codex/omp-desktop-18.3.0-patch-4`，commit `512370a1b177cf45e4d12781104506ea372fb8a9`，tree `78886eaf…`，patch 101113 B/`d6d30785…`，15 文件）：新增 `AgentTool.terminateOnSettle` / `RpcHostToolDefinition.terminateOnSettle`（默认关闭，非布尔值整批拒绝），在 agent loop 的唯一结算边界按**已解析工具定义**执行——成功、失败、`beforeToolCall` 拒绝/变换异常、execute 抛错与从未到达 execute 的 **schema 校验失败**都在提交后终止、无后续 provider 请求；被批次准入拒绝/中断跳过与外部 Stop 不终止，流式 partial 永不终止，混合批次仍整批零副作用 `block-and-continue`。`.3` 的 artifact/坐标保留在 manifest history；上游子模块仍 `62bc57be`。
- **提交工具**：bridge 在每次提示词的唯一目录装配点按合约模式追加 `SubmitPlan`/`SubmitGoal`（PI 逐字名称/描述/schema，`essential`+`exclusive`+`sole`+`terminateOnSettle`，策略表 `{risk: low, origin: "desktop"}`）；gate 只放行本模式自己的提交工具（另一种 kind `PLAN_KIND_MISMATCH`）、目录夹取保留它；executor 只接受绑定中的 `{sessionId, hostTurnId, 真实 toolCallId}`，未绑定 durable turn/错 mode/空参数/宿主错误/无效返回都 fail closed，宿主 `plans.submit` 仍是权威（durable kind、单 pending、live turn、不可变工件）。
- **持久 host turn**：bridge 成为 OMP 每次被接受提示词（普通与批准执行入口共用同一路径）唯一 begin/end 责任方——提交前恰一次 `session.beginTurn`，runner 关闭该代时恰一次结算（`recoverInflight: false`、无任务通知、native JSONL 仍是唯一正文来源）；live `omp-turn:` 代号与 host turn id 分开保存；失败/Stop/dispose 只结算自己那一代；下一提示词先等上一行结算，避免 `AGENT_BUSY`。
- **派发**：`runtime/plans.ts` 在任何持久变更前判定引擎：OMP 等本会话 live 回合结束、queued→running CAS 恰一次、经 `session.getEngineRef` 恢复同一 native 会话、用共享 `approvedPlanInstruction`（PI 同一实现，工件路径/标题/问题/边界标签内完整 Markdown）经 bridge 提交；Pi 路径不变；引擎拒绝/未接线在 claim 前跳过；完成/中断按 durable host turn id 结算（`settleOmpTurnEnd`）；拒绝/过期/CAS 失败者/重启维护都不发提示词、不重放。审批 IPC 不再拒绝 OMP（approve 前仍先过引擎门），复用既有 `plans.resolve` + `PlanApprovalBar`/`plans.changed`，不新增第二审批队列。Goal 延续定时器仍未实现（如实记录）。
- **行为证据（Linux x64 / Node v24.14.0 / Bun 1.4.2；全部本地 FakeProvider，无付费模型）**：真实 fixed patched OMP（patch `.4` 源码树）+ 生产 bridge/gate/host-tool adapter + 真实 host-core（`pi.sqlite`，`node:sqlite` 只读核对）+ 本地 FakeProvider 的 E2E **4 passed**（有效提交终止=provider 1/工件 sha+size+字节+不可覆盖；schema 缺字段终止且宿主 0 调用/无兄弟副作用；`[bash, SubmitPlan]` 整批零副作用、不终止、普通工具随后照常执行；重复 pending 拒绝、reject→重提产生新工件；批准派发恰一次 prompt、指令含工件路径与完整 Markdown、双派发竞争只一次、completed 不重放；重启后 queued 行被 boot maintenance 置 interrupted、drain 不再执行）；omp-runtime **31 files/474 passed/6 skipped**（新增 gate 提交工具/夹取/决策用例与 runner/注册字段回归）；受影响 desktop 套件（drain/提交单元/bridge/failclosed/launcher/sidecar/patch/packaging 等）全绿；`pnpm build:js`/`typecheck`/`lint` 与 `git diff --check` 全 0；`omp-patch --check` / `omp-sidecar --check` 均在 `.4` 上通过。**未做/不声称**：capability/UI 开放与整矩阵仍属 T20-D；未跑三平台发布包；未改 Cursor 门（ADR 0306）；未用真实外部模型。证据 `docs/validation/M5-t20-b2-submit-approval.md` 与同名目录，ADR 0310。

2026-10-03（M5/T20-C 第三次复审返修 R5：嵌套委派必须逐层属于同一准入回合）：**同一分支追加提交，不 amend/rebase/强推。**根复审在 `e0d03cd7` 复核 R1-R4 全通过（原 4 项直接子任务代际反例 4/4、授权隔离/同回合文件变更/真实 PluginRuntime 子进程、B1 终止态/恢复、清单 46/46），仅剩 R5：新加的嵌套父链没有把"不能借用更早/更新/foreign 准入"落实到中间祖先——根脚本 `registered-delegate-lineage-review.mjs`（真实 gate 注册回调、真实 state/fence/准入编解码、公开 `getSessionFile`/`getHeader`；不执行 provider 或工具体）7 步 6 过 1 败：childA 在 A(ask) 下拒绝、A 终止后拒绝、B(auto) 后仍拒绝，B 下新 childB 放行，无观察 unknown 子拒绝，但 **B 已准入后新创建、header `parentSession`=已退休 childA 文件、时间戳晚于 B 的 grandchildA 被放行**（`delegateParents` 只存 file→parent 且跨准入保留，`delegateDescendsFrom` 只要求走到同一 owner 文件；A/B 同属一个原生父会话，旧链因此仍可达、时间戳又通过新鲜度）；grandchildB 阳性对照放行。返修：`delegateLineage`（file→`{parentFile, admission}`，初值 null=被观察但未归属，仅在该会话首次成功绑定时一次性写入准入记录本体、之后绝不重写，退役绑定保留原记录引用）取代 `delegateParents`；`delegateDescendsFrom` 逐跳要求 `link.admission === 正在被绑定的准入记录`（记录身份比较而非 token），中间跳已退役/别代/从未归属时与未知中间跳一样 fail closed；直接子、当前回合 child 的合法多跳嵌套与既有绑定/退役粘性语义不变。**证据**：`gate-delegate-ownership.test.ts` 新增根同序 7 步与边界（stale/未知中间跳、多跳合法嵌套、下一准入下重观察旧链后新后代仍拒绝、新回合直接子放行）并保留全部原用例；`omp-sidecar.test.mjs` 编译产物探针扩为 7 步；**RED（仅 gate 还原为修复前 HEAD 版本、新测试不动）2 failed / 7 passed → 修复后 9/9**；运行时 31 files/471 passed/6 skipped、C E2E 1 passed、B1+fence-Stop+PluginRuntime 4 passed、sidecar 10 passed、受影响桥接套件 76 passed、build/typecheck/lint 全 0。**仍是登记回调层反例与同层修复，不声称原生跨代调度可达性**（ADR 0309 §7.3；held-child 夹具限制保持原样、不重跑）。证据记录 `docs/validation/M5-t20-c-execution-policy.md` §0.3/§4/§6。

2026-10-03（M5/T20-C 执行时权限决策与插件真实模式）：**分支 `codex/m5-t20-c-execution-policy`，基线 `bff27e11363d3a60b59265ff91d2fb3d814b574a`（B1 独立验收），实现提交 `a7d0291bf500918e754b6a7e9870e3b8961d4e71`（另有归档整理提交 `95023d5`/`02bf603`），追加提交，不 amend/rebase/强推。**用户授权范围内实现矩阵 C1-C8：①gate `tool_call` 决策改为 PI §1.3.1 顺序、输入为每 prompt 单一运行域快照——合约硬拒绝最先（PI allowlist 之外的原生工具、`mcp_*`、无非空 `planSafeActions` 的插件在任何 permissionMode/legacy allow/Low/grant/外部路径/无 UI 之前 block，拒绝码 `*_DISABLED_IN_PLAN`），随后外部路径（`auto`/grant 放行、否则卡）、Low/`auto`/`accept-edits`（仅 Write/Edit）/grant、其余弹卡；②`session/tool-paths.ts` 移植 host-core `workspace.rs`（词法归一、组件包含、最深祖先 canonicalize、有界悬空符号链接、双根 + 拼写重写、`requires_external_path_permission`）；③风险保真（PI 原生映射、声明风险表、`mcp_*` Low 仅非合约、BrowserPreview Medium 不虚构；默认 gated 名单增加 browser/computer/browserpreview）；④插件执行收到被准入回合真实 mode（`modeForTurn` 回合绑定，未知拒绝）、PI 逐 action guard 生效、非 agent 的 MCP 适配器边界拒绝；**修复上游缺口**：`plugin-host-process.mjs` 现转发 `planSafeActions`；⑤卡片 risk/reason/mode/permissionMode 与决策同源；强制通道下不可读状态 block 全部调用，委托按进程级快照 + 年龄界。**行为变更（有意）**：Agent+auto 不再弹卡、Agent+ask 的 `mcp_*` Low 直接执行、默认 gated 名单扩展——B1/host-tool E2E 断言按 PI 语义更新。**验证**（Linux x64/Node v24.14.0/Bun 1.4.2，全本地 FakeProvider + 真实已补丁 OMP）：omp-runtime **27 files/437 passed/6 skipped**；desktop 全量 **2983 tests/2972 pass/0 fail/11 skipped**；新生产 E2E `omp-execution-policy-e2e.test.mjs` **1 passed**（12 场景，含副作用计数与委托 ask/auto）；真实 PluginRuntime 子进程 `omp-plugin-plan-safe.test.mjs` **2 passed**；B1 生产 E2E **1 passed**；真实 Bun 打包工具门 `omp-sidecar.test.mjs` **10 passed**（新增编译产物决策表探针）；T17-T19 定向回归 **70 passed**；build:js/typecheck/lint exit 0；matrix-id OK、gap 探针 g1/g2 RETIRED + g3 open（exit 1 预期）、omp-patch `62bc57b+omp-desktop.3`、release-docs/agent-policy/locales(79 对) 通过、check-docs 6 项预存在（509 页）、`git diff --check` 干净。**未做**：不注册 SubmitPlan/SubmitGoal、不接通审批/派发（B2 未动）、不开放 plan/goal 能力、不改 Cursor 门；隐藏工具的 gate 层硬拒绝只在单元/编译产物层证明，生产层如实标为目录夹取。证据 `docs/validation/M5-t20-c-execution-policy.md` + 同名目录（9 份原始日志 + SHA256SUMS）。下一任务 **T20-B2**。

2026-10-03（M5/T20-C 复审返修 R1/R2：真实 session grant 与准入回合策略）：**同一分支追加提交，不 amend/rebase/强推。**根复审在原始远端提交 `fc0fb298` 复现两条 P1，原始 RED 报告与脚本逐字节归档于 `docs/validation/M5-t20-c-execution-policy/root-review-20261003/`：**R1** 真实 UI `allow-session` 在 `responseFor` 被折叠为 `Allow once`、grant 又只存在于运行时进程内，同会话下一 Plan 回合与 Plan→Agent 重建后仍弹卡；**R2** gate `tool_call` 每次调用重读运行域状态文件并覆盖准入快照，同一 Plan/ask 提示词内工具体把文件 `permissionMode` 改成 `auto` 后，下一个 Bash 无卡执行。返修：①wire 按用户所选选项原样回传（`allow-session` → gate 第二选项），gate 只在第二选项上授予会话范围；②grant 改由 bridge 按桌面会话 id 拥有（PI `AppState.session_grants` 对应物），仅在 `resolvePermission(..., "allow-session")` 对真实 gate 审批送达成功时记账，带 native 身份标签、身份更换即丢弃，删除会话经 `clearSessionGrants`（PI `permissions.clearSessionGrants`，已接 IPC）清除，归档保留；grant 只随准入下发、不落盘；③新增 `session/turn-admission.ts`：`{nativeSessionId, mode, permissionMode, hostTools, grants}` 随 `/omp-desktop-turn` 握手安装，ack v2 回传参数 SHA-256，runner 只认匹配回执；`tool_call` 只依据该回合记录（含 `hasUI=false` 委托），`agent_start` 武装、终止 `agent_end`/拒绝/stop 退役，产品路径不再为策略回读状态文件；已准入回合忽略 legacy `OMP_DESKTOP_GATE_MODE`、`OMP_DESKTOP_GATE_TOOLS` 只能增加 gated 名字；④`tool-paths` 更正"相对路径永远不是外部"的不实注释（相对逃逸确实走外部分支，PI 同语义），macOS `/var` 别名按 PI 的"先词法根、后 realpath"如实记录为兼容边界。便携化产品测试：`gate-review-matrix.test.ts`（canonical 20 + 两条 extended 边界）、`gate-admission.test.ts`、`turn-admission.test.ts`、`runner.test.ts` 回执绑定、`omp-session-bridge.test.mjs` grant 记账/清除、`omp-execution-policy-e2e.test.mjs` 场景 10/11/12（真实 native body）。**C 仍待根复审；g3 仍 open、B2/D 未开始。**

2026-10-03（M5/T20-C 第二次复审返修 R3/R4：委托准入归属与证据清单）：**同一分支追加提交，不 amend/rebase/强推。**根复审在 `4d532524` 上复核 R1（真实 grant wire/lifetime **5/5**）与 R2（同回合 mutation/control **2/2**）通过，仅剩两条：**R3** 委托准入归属未完成——根脚本 `registered-delegate-generation-review.mjs` 用真实 gate 注册回调/状态序列化/准入编解码记录 3/4：旧 `hasUI=false` 子在父代 A（ask）下被 no-UI block、A 终止后仍被拒，但父代 B（auto）被准入后**同一旧子被放行**（借用更新的回合策略）；`production-delegate-turn-fc0fb298.json` 扣住真实子响应推进父代未走到代 B，明确为不确定夹具（父回合保持非 idle，固定 OMP `agent-session.ts` `#hasPendingAsyncWake`/settle），不当作漏洞复现或通用隔离证明。**R4** 证据清单：父清单 28 条中 27 匹配、1 不匹配（子清单把自身哈希写进列表）。返修：①新增 `bindDelegate`——委托在**自身**生命周期（`session_start`/`before_agent_start`/`agent_start`）且准入存活已武装时**一次性绑定到该记录本体**，首次绑定生效、绝不重新指向；记录退役（终止 `agent_end`/启动拒绝）或被下一次 fence 替换后，绑定过的会话一律 `policy-unavailable`，退役会话记入永久拒绝集；②准入在 fence 时捕获所属会话的公开会话文件（`createCommandContext().sessionManager.getSessionFile()`）与武装时刻，委托父链（`getHeader().parentSession` 沿已记录中间委托上溯，32 跳）在双方都暴露文件身份时必须抵达该文件；③header 显示创建早于本准入（延迟启动/parked/revived/旧文件）的委托永久拒绝（只在接口暴露可解析 header 时生效），**不**把延迟启动顺手归入更新的回合；④只用公开接口（生命周期事件、命令上下文、`ReadonlySessionManager`），不触私有字段、不打补丁；⑤fence 回执 SHA-256 明确为同一受信进程内 runner↔gate 的应用自有一致性校验，**不声称**是密码学认证（ADR 0309 §7.1、spec 中英）。证据：`gate-delegate-ownership.test.ts`（A 下绑定→A 拒绝→终止后拒绝→B 下仍拒绝、B 新子放行；session_start 单独绑定、不复指向、过期 header 拒绝、父链/嵌套链、无观察者 fail closed、legacy 夹具缓存不变）经真实注册回调层；`omp-sidecar.test.mjs` 真实 Bun 打包探针（同一子 ask→auto 三次均 block）；生产 E2E 追加断言真实子会话 header `parentSession`=所属会话文件、本回合子会话创建时间晚于父代首次 provider 请求（归属链与新鲜度在真实运行时确有其据）。计数：omp-runtime **31 files / 469 passed / 6 skipped**、desktop 全量 **2984 / 2973 pass / 0 fail / 11 skip**、C E2E 1 passed、B1+plugin+fence-Stop 4 passed、sidecar **10 passed**、build:js/typecheck/lint 全绿。R4：子清单不再自引用，父清单改为单一 sha256sum 兼容列表（相对路径含 `root-review-20261003/` 前缀，35 条 = 全部本目录文件 + 子目录 12 文件）；两基准 `sha256sum -c` 全 OK、逐条受 Git 跟踪、集合与磁盘逐一相等、根原始报告与归档提交 blob 逐位相同（`manifest-verify-repair2.txt`）。**不声称原生跨代调度不可达**（无原生跨代 E2E）；revived/parked worker 因公开接口无法与延迟启动区分而保守 fail closed（ADR 0309 §7.2 记录所需形式化信号）。**C 仍待根复审；g3 仍 open、B2/D 未开始。**

2026-10-02（M5/T20-B1 生产 mode/policy 状态与合约工具目录）：**分支 `codex/m5-t20-b1-runtime-state`，基线 `27d5c88a1334b32dbd8c8ac17a6c262e81a8df32`，产出提交 `7ecf8c8b31e25c7d3d367888051645a3cdecf6a0`，追加提交，不 amend/rebase/强推。**运行范围状态升级为 schema v2：每 prompt 单次组装并原子写入会话 `mode`、生产 `composeModeSystemPrompt(mode,"")` 块、已解析有效 `permissionMode`（`inherit`→应用当前默认，否则 `ask`）与每宿主工具 `{name, risk, planSafeActions, origin}` 策略表 + T19-C 技能/记忆；策略半部分强制（读取/枚举/compose/写入/自校验任一失败→提交前拒绝 prompt，无 tombstone、不按 Agent 继续），技能/记忆 best-effort。gate 先追加能力块、最后追加 mode 块（纯追加、恰一次、单 system、无 PI base），Plan/Goal 用真实 `setActiveTools` 夹取 PI 合约目录（read/glob/grep/bash/ask/new_context ∩ 实际 + 非空 planSafeActions 插件；Write/Edit/未知/用户 MCP/未声明插件不可见；不虚构 BrowserPreview），回 Agent 恢复夹取前选择且不复活用户禁用工具；owner-state 失效用 `ctx.abort()` 拒绝（实测 throw 会被吞、提示词仍投递）；子代理零注入；风险/安全动作进目录指纹；审批描述符携带有效 permissionMode。**验证**（Linux x64 / Node v24.14.0 / Bun 1.4.2，全部本地 FakeProvider）：omp-runtime 370 passed/6 skipped；desktop 全量 2977 tests/2966 pass/0 fail/11 skipped（含真实补丁树 8 阶段生产 E2E、子代理零注入、重启基线、inherit 解析、描述符 permissionMode=auto）；start-handler 语义探针 1/1；B14 反例 2/2 + 注入反例的 RED 1 failed/exit 1；真实 Bun 编译工具门 9/9；host-core 606/606；build:js/typecheck/lint/fmt/clippy exit 0；gap 探针 g1 退场为行为测试、g2/g3 仍 open（exit 1，未通过删问题得全绿）。**未做**：不注册提交工具、不接通审批/派发、不实现执行期决策表、不开放 plan/goal 能力。证据 `docs/validation/M5-t20-b1-runtime-state.md`。下一任务 **T20-C**（执行时契约硬拒绝与插件真实 mode），随后 B2、D。
2026-10-02（M5/T20-B1 第二次独立复审返修 R1-R3）：**同一分支追加提交 `745ceec`（代码/测试）+ `2523652`（文档/证据），不 amend/rebase/强推；已推送 `origin/codex/m5-t20-b1-runtime-state`。**①**强制通道改为启动域开关**：`OmpRuntimeSupervisorOptions.desktopStateRequired`（生产 wiring 恒 `true`，未写状态的夹具显式 `false`）在 spawn 时**显式**写 `OMP_DESKTOP_STATE_REQUIRED=1|0`（覆盖 ambient/`extraEnv`），gate 只读 env；删除状态文件与第一次返修的 `desktop-state.required` 标记（连同其 symlink 跟随写入路径）后仍拒绝并保持零 provider 请求（R1/R2）。②**turn-fence 回合绑定**：每次准入 prompt 前 runner 经正式 `get_available_commands` 确认 gate 以 `source=extension` 注册了内部命令 `/omp-desktop-turn`（缺失即提交前拒绝，握手文本绝不流入 provider），再用正式 RPC `prompt` 安装随机 32-hex token 并等 gate `notify` 的版本化 ack；拒绝描述符 `v:2` 携带 `turnToken`，只有 native 身份 + fence 已确认 + 本代 token + 未 `agent_start` 才关代，重复/旧代迟到/错误 token/他会话/stop 退役/已 dispose 一律忽略（R3）；顺带修复已关闭代不再被 transport 失败补发第二个终态。**验证**（Linux x64 / Node v24.14.0 / Bun 1.4.2，全部本地 FakeProvider）：omp-runtime 25 files **400 passed/6 skipped**；B1 生产 E2E **1 passed**（第 9 阶段覆盖首/后续回合同时删通道文件、malformed/oversize/unknown-schema/identity-missing/owned-invalid、伪造描述符负对照、Plan→Agent 重建后拒绝+恢复；provider 计数精确、恰一 error/turnEnd、身份/历史无重放）；真实运行时套件组 **24 passed**；desktop 全量 **2977/2966 pass/0 fail/11 skipped**；真实 Bun 编译 gate **9/9**；build:js/typecheck/lint exit 0；matrix/omp-patch/release-docs/agent-policy/locales(79 对) 全绿、check-docs 6 项预存在、gap 探针 `GAP-RETIRED g1` + g2/g3 open（exit 1）。未跑 host-core/打包（未改 Rust/patch/pins）。证据 `docs/validation/M5-t20-b1-runtime-state.md` §10 + `.../repair2-red/` + 7 份原始日志。T20-C → B2 → D 顺序不变；用户目标第 9 条（M5 验收后三平台 native 包）继续保留。


2026-10-02（M5/T20-B1 第三次独立复审返修 R4：turn-fence 准备期 Stop 竞态）：**同一分支追加提交（代码/测试 + 文档/证据两笔，不 amend/rebase/强推；已推送 `origin/codex/m5-t20-b1-runtime-state`）。**第三次复审（候选 `7fa4be02`，F1-F4/R1/R3 复核全 GREEN）判 R4：新的异步 fence 准备忽略准备期间到达的 Stop——真实线序 `get_available_commands → abort → 内部绑定 prompt → 用户 prompt`，Stop 时 provider0、`state=stopping`，但被取消的 prompt 之后仍被提交并执行（`accepted=true`/`providerRequests=1`）；固定运行时 `abort` 为普通串行命令、早于 `agent_start` 不发 `agent_end`，无法取消尚未分发的 prompt。修复：`runner.prompt` 捕获被准入的那一代（`RunRecord`），`armTurnFence` 在 discovery 响应后（缓存可用性之前）、握手异常/响应后、ACK 等待后，以及写用户内容之前的同步检查与 catch 中重验 `isCurrentRun`（`state === "running"` 且 run 身份一致）；被取消的代以 `aborted` 恰一次关闭（Stop `converged=true`/`toreDown=false`，保留活进程），prompt 以 typed `stopping` 拒绝；迟到握手/ACK 不 arm 过期 fence、不提交内容、不触碰替换代；`performStop` 置 `stopping` 后立即 settle 待决 ACK（不等 fence 截止时间）。新增 runner 三边界 + dispose 单测、bridge held-boundary 用例、生产反例 E2E `omp-session-turn-fence-e2e.test.mjs`（真实补丁 OMP + 生产 bridge/runner/gate + FakeProvider；seam 只用公开 `runtimeFactory` 包裹真实 request 转发，control + discovery/handshake 两 Stop 策略）。**GREEN**：omp-runtime 25 files **404 passed/6 skipped**；新 E2E 1 passed；bridge 51 passed；B1 生产 E2E 1 passed（15.4s）；真实运行时组 24 passed；desktop 全量 **2979/2968/0/11**；build:js/typecheck/lint exit 0；matrix/omp-patch/release-docs/agent-policy/locales 全绿、check-docs 6 项预存在、gap 探针 g2/g3 open（exit 1 预期）；未重跑 host-core/pack/编译工具门（未改 Rust/patch/pins/gate）。RED 归档 `docs/validation/M5-t20-b1-runtime-state/repair3-red/`（复审原始文件未编辑 + 本轮三份新测试 RED `EXIT=1`），记录 `docs/validation/M5-t20-b1-runtime-state.md` §11。

2026-10-02（M5/T20 范围修正：排除 Cursor + Plan/Goal；非 Cursor 路线就绪复测）：**分支 `codex/m5-t20-non-cursor-scope`，基线 `c8b358706417d2f8fa1949fe589f1d5f5512ce8d`，追加提交，不 amend/rebase/强推。**用户指示把 Cursor + Plan/Goal 移出范围（不支持且拒绝；ADR 0306 的 host-core 持久写入门、Main/渲染层拒绝、派发门全部保留；不全局禁用 Cursor Agent——组合门不拒绝 Cursor + Agent，桌面尚未接通 Cursor 传输、本轮不新增该能力）；非 Cursor、由已补丁 loop 裁决的受支持 HTTP 模型路线仍在范围内，且仍按严格契约验收。**只做范围落盘与验证，不改产品运行时**：①现基线（OMP `62bc57be` + patch `62bc57b+omp-desktop.3`，真实固定运行时 + 真实补丁 scratch 树 + 本地 FakeProvider，无付费/远程调用）`node t20-feasibility.mjs --patched` **46/46、exit 0**——混合批次零副作用（含顺序颠倒与重复提交）、gate 逐调用 block 保护不了兄弟（批次级裁决）、成功/失败终支 0 后续 provider 请求、abort 按 targetId 取消且会话可观察、目录顺序/生命周期严格相等、`r4d` attempts `2/1/2`、mode block 纯追加（blockBytes 176/1726/2156、`system = prefix + block`）；②Cursor 门回归：三份 desktop test **18/18**、共享 predicate **7/7**、host-core `plan_goal_guard` **15/15**、manifest 消费方 **13/13**，`omp-patch.mjs --check` exit 0（manifest 只新增 `status.scopeNote` 日期化说明，未改 patchLevel/patch/hash/bytes、fork commit/tree、capability ids 或构建 pin）；③旧 R3A/B/D、T20-A 与 R3C 报告加日期化范围说明并链接本记录。**T20 未完成、Plan/Goal 未实现、`plan`/`goal` 能力保持关闭**；g1/g2/g3 未实现；下一阶段拆分 T20-B1（运行域 mode/policy 状态与目录）→ T20-C（执行时权限硬拒绝）→ T20-B2（提交/审批/派发）→ T20-D（整体验收与能力开放），见 `docs/validation/M5-t20-non-cursor-scope.md`。

2026-10-01（M6/T21-A 最后一轮独立复审返修：gate 拒绝的路径边界 + 证据原始字节）：**同样在 `bec20b214bee792b656d85aab5469e459b96eccc` 之后追加提交（分支 `codex/m6-t21-packaged-runtime`，不 amend/rebase/强推）；只改验收入口/回归/spec/证据，产品运行时未改。**①**gate 负对照仍是子串匹配**——上轮修复后 `detail.includes("Trusted extension must be an existing module file: <缺失路径>")` 仍会接受 `<缺失路径>.another-file`（同名前缀的**不同**文件），本机用 supervisor class seam 复现该误接收；新增 `namesMissingGate()`：按行切分、只接受该行在固定前缀之后**恰好以该缺失路径结束**（字面比较、允许行尾 `\r`，不做正则），并在已有 gate-control 用例加入同名前缀拒绝断言。RED（HEAD `6ee99ecb` 的入口原样 + 新断言）**1 failed / 6 passed / 8 skipped**、exit 1（`docs/validation/M6-t21-packaged-runtime/repair-red-gate-path/regression-red.txt.gz`，可读副本同名 `.txt`，harness/摘要见该目录 `README.md`）→ GREEN 常驻 7 pass / 8 skip、opt-in 15/15，真实 Linux 产物（unpacked 与含空格/中文暂存路径）重跑 exit 0 且 `gateLoadControl: refused`。②**提交内容的空白检查证据不足**——`git diff bec20b21..6ee99ecb --check` 实际 exit 2（`repair-red/regression-red.txt` 4 行、`repair-red/semantic-revert.diff` 2 行尾随空白；上轮只在提交后的 clean 工作树跑过该检查）；两份原始捕获改存确定性 gzip（`gzip -n -9`，解压后 SHA-256 `4360e514…`/`0516a82c…` 与 `6ee99ecb` 的 Git blob 逐字节一致），RED txt 仅保留去掉行尾空白的**可读副本**（文件头注明原始输出在 `.txt.gz`），回退补丁只保留完整原始 `.diff.gz`（其两处"空白行"是 diff 正文，归一化会让补丁不可应用；解压后 `git apply --check -p0` exit 0，应用后得到回退语义 `f367d37b…`、`15 insertions(+), 59 deletions(-)`），方法见 `repair-red/README.md`；最终 `git diff --cached --check` 与 `git diff bec20b214bee792b656d85aab5469e459b96eccc HEAD --check` 均 exit 0，未加宽泛 whitespace 忽略规则。③**复审侧 macOS arm64 证据归档**：unsigned/unpacked `pack`（darwin/arm64，sidecar 216435968 B/`501cc225…`，smoke 9/9）、两个真实 `Resources` 验收 exit 0（`gateLoadControl: refused`）、`6ee99ecb` 回归 15/15、以及借鉴 PI `scripts/e2e-electron-boot.mjs` 的临时 harness 启动打包 `.app`（boot-probe 0.15.2 / protocol 11 / 6 menus / 800 sessions refresh / `projectRemove` 边界，exit 0）均按原始字节归档到 `docs/validation/M6-t21-packaged-runtime/mac-review/`（属**复审机实测**：无签名/公证、无 DMG、非 OMP 对话/工具烟测，见 `docs/validation/M6-t21-packaged-runtime.md` §13）。**T21-A 仍只是 headless 运行时资源验收 + 复审侧 unsigned/unpacked 实机启动；T21 未完成，R3 硬阻塞、ADR 0306 Cursor 门、T20-B/C/D、T22/T23/T24 均未动。**

2026-10-01（M6/T21-A 独立复审返修：打包资源验收的两条安全边界与证据链）：**在 T21-A 首稿 `bec20b214bee792b656d85aab5469e459b96eccc` 之后追加提交（分支 `codex/m6-t21-packaged-runtime`，不 amend/rebase/强推）**。①**gate 负对照过宽**——`expectGateRefusal` 旧实现把任何 `start()` 失败都当"门被拒"；现要求失败 `detail` 命中运行时自己的 `Trusted extension must be an existing module file: <本次缺失的绝对路径>`，超时/启动器/原生加载失败/命名别的路径/竟然启动成功一律使入口 exit 1 并报告观察到的原因。②**清理吞错**——两处 `reclaimAll().catch(() => undefined)` 与无条件删除验收根改为 `releaseAcceptanceRoot()`：检查回收结果与异常，未回收干净时保留 run root 与 supervisor 所有权记录、报告 `retained at …` 并非零退出，只有回收干净才删除验收根；被覆盖的启动环境在所有出口恢复；复用 supervisor 回收协议，不写第二套 kill 逻辑。RED（语义回退夹具 + class seam 注入 supervisor 双）**4 failed / 3 passed / 8 skipped**（`docs/validation/M6-t21-packaged-runtime/repair-red/regression-red.txt.gz` 原始字节 + 可读副本、`semantic-revert.diff.gz`），GREEN opt-in **15/15 pass / exit 0**、无产物 **7 pass / 8 skip**；真实 Linux unpacked 与含空格/中文暂存路径两次重跑 exit 0（`stopped/reaped/cleaned` 全真、残留 run 与 accept root 0）。③**文档归因**——§1 区分上游 `62bc57be`（无命令行 bytecode 开关、不固定归档时间戳）与受控 fork `6226f805`（patch-3 提供二者），PI `release-asar.test.mjs` 改为"临时夹具中 `exportLinuxAsar` 的行为测试"；§2/§8 区分 `pack` 链内 `build:host-release`（原样不含 `--locked`）与链外单独 `cargo build --release --locked -p host-core`（2026-10-01 重跑 exit 0，`cargo-locked.txt`）。④**证据入库**——`pack.log` 因根 `.gitignore` 从未被跟踪，已保留真实输出为 `pack.txt` 并修正全部引用；spec §17 中英镜像同步收紧契约；产品运行时/RPC/权限路径未改。**R3 仍为硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T21 进行中（T21-B 及后续未开始）、T22/T23/T24 未开始。**

2026-10-01（M6/T20-R4-3 第二次独立复审返修：工具门构建上下文，R4-3 输出确定性边界补齐）：**①问题（生产路径 RED）**——`app/scripts/omp-sidecar.mjs` 的 gate 编译 cwd 是 `mkdtemp(os.tmpdir())` 运行根，Bun 按模块路径注释相对该 cwd 写出，于是同一源码、同一 Bun 1.4.2 在不同 `TMPDIR` 深度下产出不同工具门字节与摘要。新增回归（经真实 CLI 两次构建：夹具假二进制 + 真实 Bun 编译真实工具门，不编译 283 MB）在未修复代码上 **1 failed / exit 1**（两次工具门 Buffer `deepStrictEqual` 不等，日志 `docs/validation/M6-r4-3-sidecar-provenance/depth-red/regression-red.txt`）；字节级复现 10130 B/`f6a10e7b…` vs 10157 B/`8340b5b1…`，`cmp` exit 1，`diff -u` 仅三处模块路径注释。**②修复（只改编译上下文）**——`gateContext = dirname(gateSource)`、gate 编译 `cwd: gateContext`；`isolatedEnv(runRoot)`、runRoot 内探针、watchdog/回收/清理、权限行为、全部 fail-closed 校验、bytecode 模式、provenance schema 与受控 fork 均未动。同一源码在三种编译上下文（同目录两次 + 把包复制到另一绝对路径）均 9897 B/`89c2d844…`，不再随运行根深度或检出位置变化。**③GREEN**——`apps/desktop/test/omp-sidecar.test.mjs` **9 pass / 0 fail**（断言两次工具门实际字节与完整 provenance 相等，且工具门保持自包含无相对导入；Bun 缺失时显式 skip，本机 Bun 1.4.2 实测运行）；夹具 `apps/desktop/test/helpers/omp-fork-fixture.mjs` 增加可用的假 `build-binary.ts`（`dist/` gitignore，后续构建仍见干净树）。**④两次完整真实构建**（输出目录不同、`TMPDIR` 根不同且深度不同）：均 exit 0；二进制均 283997664 B/`f69ee0b2…`（`cmp` exit 0）、工具门均 9897 B/`89c2d844…`（`cmp` exit 0）、完整 provenance `diff -u` exit 0；新产物 opt-in smoke **9 passed / exit 0**。**⑤验证**——`@pi-desktop/omp-runtime` 23 files/351 passed/6 skipped；六个桌面入口测试 **71/71**；`apps/desktop` 全量 **2954 tests / 2951 pass / 0 fail / 3 skipped**；`pnpm build:js`、shared/omp-runtime/desktop typecheck、`omp-patch.mjs --check`、`git diff --check`、`check-release-docs`、`check-locales`(79 对)、`check-t20-matrix-ids` 全 exit 0；`check-docs` 6 项预存在（507 页）、`check-architecture` 1 项预存在、opt-in gap probe 仍 `3 gap(s) open [g1,g2,g3]`。**⑥平台范围返修（同日追加提交）**——gate 深度回归此前只在 Bun 缺失时 skip；夹具 `build-binary.ts` 写出并被 `--build` 实际执行的 `#!/bin/sh` 假二进制在 Windows 有 Bun 时仍会运行、必然失败，现增加独立 win32 skip（原因写明依赖 POSIX 夹具、Windows 原生等价验证留待 T23），Bun 缺失的 skip 原因保留；Linux x64 + Bun 1.4.2 重跑该文件 **9 pass / 0 skipped**（新用例实际执行）；macOS arm64 的 2954/2954（0 fail / 0 skip）为复审侧 macOS 实机结果；Windows 未验证、不宣称支持。证据 `docs/validation/M6-r4-3-reproducible-sidecar.md` §5/§9 与 `docs/validation/M6-r4-3-sidecar-provenance/`（green 按新构建刷新，depth-red 为日期化 RED）。**R3 仍为硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T20 与 T21 均未完成。**

2026-10-01（M6/T20-R4-3 独立复审返修）：**两处与实测矛盾的 bytecode 文档注释已修正，R4-3 证据在新 fork 提交上重跑**（桌面分支 `codex/m6-r4-3-reproducible-sidecar` 追加提交，不 amend/rebase/强推；fork 分支 `codex/omp-desktop-18.3.0-patch-3` 追加 `6226f805e92654344de04def413fa5cb91cb16b9`，tree `5249cb07059b009e890bece6f7d59daeb1cb94f6`，仍为 patch level `62bc57b+omp-desktop.3`、15 文件）。①**文档与实测矛盾**：`packages/coding-agent/scripts/{compile-binary,build-binary}.ts` 原称 bytecode 是同源两次构建的唯一差异、桌面为逐位一致而传 `false`；现改为 bytecode 默认 `true` 且仍是 release/桌面模式、开关显式且不读环境（可审计、拼错会被拒绝），`--no-bytecode` 只是显式退出/对照/诊断模式，可复现来自归档时间戳归一化。仅注释、无行为变化——新提交构建出的二进制与上一坐标逐位相同（`f69ee0b2…`）。②**补丁重生成**：显式 `git -c core.abbrev=7 diff` 逐字节可重生成（sha256 `ad63ced9…`、87190 字节、15 文件），patch-id `83fb2695…` 与直接 diff 一致，前向应用基座/反向应用于 fork 均 exit 0；manifest、`@pi-desktop/shared` pin、三条 packaging workflow、`source-baseline.json`（新增 2026-10-01 记录）同步到新提交，manifest 重建指令含显式缩写（缺省会随机器 `core.abbrev` 改字节而语义不变）。③**新提交可复现证据**：两次独立默认构建（Bun 1.4.2、bytecode 开、默认 TMPDIR）二进制均 283997664 B / `f69ee0b2…`，`cmp` 与 provenance `diff -u` 均 exit 0，工具门 10112 B / `bb110256…`；provenance `schema /3`、fork commit/tree 为新值、`build.bytecode=true`；最小 PATH `--version`=`omp/18.3.0`；opt-in 真实产物 smoke **9 passed**；错误 remote 与错误 commit 仍在编译前 exit 1 且不创建输出目录。**新测得残留限制**：工具门 bundle 的模块路径注释相对构建 cwd 写出，TMPDIR 深度会改变其字节（深两层 → 10130 B），二进制不受影响。④**验证**：fork 两套件 5 pass + 7 pass；`pnpm build:js`、`@pi-desktop/omp-runtime` 与 `@pi-desktop/desktop` typecheck 全 exit 0；`@pi-desktop/omp-runtime` 23 files / 351 passed / 6 skipped；6 个桌面入口测试 70/70；`apps/desktop` 全量 **2953 tests / 2950 pass / 0 fail / 3 skipped**；`omp-patch.mjs --check`、`git diff --check` 均 exit 0。证据：`docs/validation/M6-r4-3-reproducible-sidecar.md`、`docs/validation/M6-r4-3-sidecar-provenance/`。**R3 仍为硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T20 与 T21 均未完成。**

2026-09-28（M6/T20-R4-3）：**R4-3 的可复现条款已闭合**（桌面分支 `codex/m6-r4-3-reproducible-sidecar`，基线 `f2dd40380d17ce1493315b376ef493dcdb765895`）。自有 fork 新分支 `codex/omp-desktop-18.3.0-patch-3`（commit `6b5017bc297a357e88287763ef701b87775737c8`，tree `60a39b24…`，= 18.3.0 基线 + patch level `62bc57b+omp-desktop.3`）承载两项受控构建改动：`packages/natives/scripts/embed-native.ts` 以固定时间戳写出内嵌原生插件 `tar.gz`（并重算头部校验和），`packages/coding-agent/scripts/{build-binary,compile-binary}.ts` 提供显式的 `--bytecode`/`--no-bytecode`（默认仍为上游 release 行为 true；未知或重复开关打印 `OMP-BUILD-ARGS` 并 exit 2）。根因由对照实验定位：`Bun.Archive` 把墙钟时间写进每个 tar 条目，而该归档被原样内嵌（RED 首差异在第 81260680 字节，内嵌资产名 `…tar-d8wq`→`…tar-6vvy`）；**bytecode 不是原因**——归档修好后 bytecode on/off 各自两次构建都逐位一致，且 Bun 1.4.2 上 PR 42151 只在 `--splitting` + bytecode 组合下出现（本构建不使用 splitting），因此桌面 sidecar 仍显式以 `--bytecode` 构建，并把模式写入 provenance。GREEN：两次独立构建 SHA-256 均 `f69ee0b283691bf449e10734775995057cf7b89f4c68bfb077defaeaa7ffe02d`（283997664 B），`cmp` 与 `diff -u provenance.json` 均 exit 0，工具门摘要相同；真实产物在最小 PATH 下 `--version`=`omp/18.3.0`，opt-in smoke **9 passed**；错误 remote 与错误 commit 都在编译前 exit 1 且不创建输出目录。provenance schema 升为 `omp-desktop.bundled-sidecar/3`（`build.bytecode` 必填），patch 构件重命名为 `0001-omp-desktop-runtime.patch`（sha256 `27b19f19…`、86789 字节、15 文件），`@pi-desktop/shared` 的 patch level / fork commit pin 与三条 packaging workflow 的 fork `ref` 同步。**R3 仍为硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T20 与 T21 均未完成**。证据 `docs/validation/M6-r4-3-reproducible-sidecar.md`。

2026-09-28（第五轮独立复审返修）：**M5/T20-R4B 的 2 项已复现问题已修复**（追加提交，不 amend/rebase/强推；起点 `bf9d075365008478edd01d04d91c424aa4e93898`）。①**F1 wrapper 自有参数轴未收口**：platform/architecture/dir/publish 四轴此前只认部分拼写，`--win=portable`/`--mac=dmg`/`-m=dmg`/`--w=portable`（平台 target 列表）、短簇 `-mwl`/`-mdmg`/`-mw`/`-ow`、yargs 同样接受的长写别名 `--m`/`--o`/`--w`/`--l`（`--win --m` 会让 builder 同时构建两个平台）、`--publish never -p always`（builder 读到 `["never","always"]`）、`--x64 --no-x64`（builder 读到 `x64: false`）、`--dir=false`/`--no-dir`、`--platform=darwin`/`--arch=arm64` 都会漏进 `forwarded`；现按已安装 electron-builder 的 yargs 契约（`configureBuildCommand`；选项/别名与 `choices.publish` 由测试从已安装包读回比对）把四轴的每种拼写收进 wrapper——每个轴至多声明一次、由 wrapper 恰好生成一次（builder argv 恰好一个平台开关、至多一个架构开关、至多一个 `--dir`、一个规范化的 `--publish <value>`，且排在转发参数之前），重复/同义重复/冲突/否定/短簇/target 列表一律在 spawn 任何进程之前 exit 2。②**F2 最终打包来源仍可被换**：`--prepackaged`/`--pd`（`prepackaged != null` 时 `doPack` 被跳过、改为打包外部应用：`app-builder-lib/out/platformPackager.js:146`、`out/macPackager.js:268-270`）、`--projectDir`/`--project`、`--config`/`-c`/`--c` 路径形式、`--help`/`--version` 一律 spawn 前拒绝；dotted 配置改走 **source-neutral allowlist**（只放行 `mac.identity`/`mac.forceCodeSigning`/`mac.notarize` 三个签名相位键，测试直接从 `scripts/release-macos.sh` 与 `.github/workflows/release.yml` 提取 `-c.<key>=` 并断言集合相等），`files`/`extraResources`/`extraFiles`/`directories.app`/`extends` 及平台级同类键全部拒绝，取代此前“未知参数一律原样透传”的表述。RED/GREEN：起点独立 worktree（`/tmp/r4b-red5`，仅换入新测试）`node --test apps/desktop/test/omp-release-gate.test.mjs` **6 failed / 10 passed** → 修复后 **16 passed / 0 failed**；一次性探针七项（平台 target 列表、`--prepackaged`、publish 轴分叉、架构轴否定、`--projectDir`、`-c <path>`、`-c.files[0].from=…`）由「code 0 + spawn 2」变为「code 2 + spawn 0」。桌面全套 **2952 tests / 2949 pass / 0 fail / 3 skipped**；`omp-runtime` 23 files / 350 passed / 6 skipped；`pnpm build:js`、两个 typecheck、`git diff --check` 均 exit 0。证据 `docs/validation/M5-bundled-sidecar.md` §0.4/§12.4。**R3 仍为硬阻塞；ADR 0306 的 Cursor 产品门保留；T20-B/C/D 未开始；T20 未完成；T21 未完成；R4-3 未满足。**

2026-09-28（第四轮独立复审返修）：**M5/T20-R4B 的 2 项已复现问题已修复**（追加提交，不 amend/rebase/强推；起点 `956841c85acf5e4c9b192ab7f837891416314680`）。①**F1 平台目标仍可分叉**：electron-builder 的平台开关是可加的（`--mac … --win` 构建两个平台），透传它们等于同一分叉换拼写——`planRelease(["--platform","darwin","--arm64","--win"])` 在起点让预检校验 darwin/arm64、builder argv 却是 `--mac --arm64 --publish never --win`；现 `--mac`/`--macos`/`-m`/`-o`→darwin、`--win`/`--windows`/`-w`→win32、`--linux`/`-l`→linux 与 `--platform` 归并为**唯一平台声明**，重复/同义重复/冲突/短开关簇 `-mwl`/平台 target 列表（`--mac dmg`）一律在 spawn 前 exit 2 拒绝，builder argv 恰好一个平台 flag；通用 builder 参数（`-c.mac.forceCodeSigning=true` 等）原样透传契约不变。RED（起点 worktree）：`node --test test/omp-release-gate.test.mjs` **2 failed / 9 passed**（`:407` builder 收 `['--mac','--mac']`、`:448` 混合声明未拒绝）；GREEN：**11 passed**。②**F2 本地正式签名 lane 绕过 sidecar 预检**：`scripts/release-macos.sh` 的 watchdog 内改为 `pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs --platform darwin --${MAC_ARCH} --publish never -c.mac.identity=… -c.mac.forceCodeSigning=true -c.mac.notarize=true`，预检先于 electron-builder、失败短路（builder/公证/校验都不运行），签名参数完整、bundle inventory → DMG 公证/装订 → verify 顺序不变；`pnpm exec` 的 PATH 使 wrapper 裸名 spawn 的 `electron-builder` 可解析（`pnpm exec which electron-builder` → `./node_modules/.bin/electron-builder`）。RED：`macos-release-lane` **2 failed**（`:191` wrapper 从未运行、`:273` 预检失败仍 exit 0），`ci-workflow` **1 failed**（`:319`）；GREEN：**2 passed** / **14 passed**。同轮实跑：`pnpm build:js`、`@pi-desktop/omp-runtime` 与 `@pi-desktop/desktop` typecheck、9 个定向测试文件、桌面全套 **2947 tests / 2944 passed / 3 skipped / 0 failed**、`omp-runtime` 全套 **23 files / 350 passed / 6 skipped**、`git diff --check` 均 exit 0；**未**跑 electron-builder 真实打包、macOS/Windows 实机、clean runner CI。证据 `docs/validation/M5-bundled-sidecar.md` §0.3/§12.3。**R4B 仍按部分完成/受阻记录（R4-3 的「相同输入产出相同清单」未满足）；R3 硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T21 未完成。**

2026-09-27（第三轮独立复审返修）：**M5/T20-R4B 的 F1-F6 已修复**（追加提交，不 amend，不重写历史；本轮提交随本文件一并追加）。①**F1 发布参数透传**：`app/scripts/release-package.mjs` 只消费自有的 target/dir/publish 参数，其余 electron-builder 参数**按原始顺序逐项原样转发**（固定 PI 签名 lane 的 `-c.mac.forceCodeSigning=true`/`-c.mac.notarize=true` 此前被 `unknown argument` 拒绝、exit 2），同一目标维度只允许声明一次（`--x64 --arm64`、`--x64 --arch arm64`、重复 `--platform`/`--publish` 在 spawn 任何进程之前 exit 2 拒绝），避免额外参数把预检与打包带到不同目标；②**F2 clean runner 的受控来源**：`app/.github/workflows/release.yml` 的 build matrix 与 `linux-package.yml` 都增加 checkout `MisterBowie/oh-my-pi` @ manifest `fork.commit`（`fetch-depth: 0`，构建要重新证明 `base..HEAD`）、`oven-sh/setup-bun@v2`（1.4.2）、`bun install --frozen-lockfile` 与作业级 `OMP_SIDECAR_SOURCE`；③**F3 根 preview workflow**：本仓库真正生效的 `.github/workflows/mac-preview-package.yml` 改为走同一 `pnpm run dist:mac -- --arm64` → `release-package.mjs`（builder 之前构建并校验 sidecar），删除 can1357 v18.2.7 下载、打包后手工注入、`.ts` gate 与 `--prepackaged`。**仓库布局事实**：GitHub 只读仓库根 `.github/workflows/`，`app/.github/workflows/*` 在当前布局不会自动触发，本仓库当下生效的打包工作流只有根 preview 一条；④**F4 canonical 断言**：夹具改以 `realpathSync` 规范形式返回根与路径（生产实现的 canonical containment **未**回退），macOS 复审 RED 坐标 `bundled.test.ts:172/195/403`、`omp-runtime-launcher.test.mjs:128/329` 在本机以别名 TMPDIR 同形复现并修复；⑤**F5 Windows 夹具**：打包夹具改用生产的 `bundledBinaryFilename(process.platform)`，新增 win32 解析用例；⑥**F6 证据更正**：本文件、`docs/validation/M5-bundled-sidecar.md`、`HANDOFF.md`、ADR 0307 §6 与 spec §17（中英）同步，未执行的 macOS/Windows 实机与 clean-runner CI 未写成通过。计数：`@pi-desktop/omp-runtime` 350 passed / 6 skipped、桌面全量 2945 tests / 2941 pass / 0 fail / 4 skipped、opt-in 真实无费用 smoke 9 passed。**R3 仍为硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T20/T21 未完成、R4-3 未满足。** 证据 `docs/validation/M5-bundled-sidecar.md` §0.2/§9.2/§12.2。

2026-09-27（第二轮独立复审返修）：**M5/T20-R4B 的 5 项阻塞问题已修复**（追加提交，不 amend：`53d19ee`/`f9d133e`/`7b3b3de`/`f428940`）。①资源包含性改 canonical——`verifyBundledRuntime` 对 `resourcesPath` 与 `omp-runtime` 都取 `realpathSync` 再比较，别名祖先（macOS `/var`→`/private/var`）不再误报逃逸，目录/二进制/manifest/gate 的符号链接仍拒绝；②新增 `scripts/release-package.mjs` 作为 `pack`/`dist`/`dist:*` 链尾唯一入口，把发布目标（平台/架构）只解析一次并同时交给 sidecar 预检与 electron-builder（arm64 机器申请 `--x64` 不再打包错架 sidecar），跨目标缺 `--arch` fail closed，win/linux 保持固定 x64；③`inspectBundledGate` 保留 `bundled-runtime-invalid` + 具体细节，`createOmpSessionBridge` 的 `requireGate`/`requireLauncher`（经 `launcherError`）把它带进 prompt 与控制操作错误，无开发态回退；④测试夹具与 `verify`/`refusal` 默认跟随宿主目标；⑤扩展清单边界收紧为“恰好信任工具门”，拒绝绝对/盘符/UNC/`.`/空段/重复路径，schema 升为 `omp-desktop.bundled-sidecar/2`。逐项 RED/GREEN 见 `docs/validation/M5-bundled-sidecar.md` §0.1、§9.2、§12.1。**R4-3 的「相同输入产出相同清单」仍未满足，故 R4B 一律按部分完成/受阻记录，不标记完成。** **R3 仍为硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T20 未完成、T21 未完成。**

2026-09-27（复审返修）：**M5/T20-R4B 三项阻塞问题已修复**（追加提交，不 amend）。①**发布命令强制 sidecar 预检**：`pack`/`dist`/`dist:mac`/`dist:win`/`dist:linux` 在 `bundle:runtime` 与 `electron-vite build` 之间执行 `verify:sidecar[:<platform>]`（`omp-sidecar.mjs --preflight`）；宿主目标实际构建，跨目标只接受为精确平台/架构暂存且相对本次受控清单校验通过的产物，绝不复用宿主二进制，缺 `--arch` 直接拒绝（与 PI Desktop 把 sidecar bundle 串进发布命令同形，但更强）。②**真实 smoke 走生产参数链**：以 `--trusted-extension <Resources>/omp-runtime/extensions/omp-desktop-gate.js` 启动真实编译产物，完成 `--version`、协议 v2 与一次无费用 RPC，并证明最小 PATH 下无需系统 Bun/Node；**因此复现并修复了一个真实缺陷**——只复制源码 gate 会因 `import "../src/…"` 在 Resources 下无法解析而使运行时拒绝启动（实测 `Trusted extension failed to load: Cannot find module '../src/session/approval-protocol.ts'`），现改为构建自包含 bundle、断言无相对导入、清空构建自有 `extensions/` 目录并把 gate 字节数/SHA-256 纳入 provenance 校验。③**打包态 gate 解析彻底 fail closed**：`resolveGateExtension` 与 `createOmpSessionBridge.gatePath()` 在 `isPackaged` 时只接受 Resources 下经同一套校验的 gate，`resourcesPath` 缺失/缺失/符号链接/逃逸/摘要不符一律拒绝，appPath、环境变量、PATH、dev candidates 均不可绕过（开发态不变）。连带处理：解析失败原因经 `launcherResolutionError` 进入 `status().detail` 不再被吞；provenance 信任分级（校验 schema/平台/架构/OMP 版本/patch level/base/fork/desktopVersion/文件名/二进制与扩展摘要；`fork.tree`/`capabilities`/`build.*` 仅记录，ADR 明示禁止称已验证）；`extraResources` 用 filter 排除无关 `.gitignore`。**R4-3 的「相同输入产出相同清单」未满足**（同一提交多次构建 SHA-256 不同），按未决阻塞项记录，未写成通过。**R3 仍为硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T20 未完成、T21 未完成。** 证据 `docs/validation/M5-bundled-sidecar.md`。

2026-09-27：**M5/T20-R4B（自有 OMP fork + bundled sidecar 的可验证闭环）交付，但按部分完成/受阻记录**（R4-3 的「相同输入产出相同清单」未满足；第二轮独立复审的 5 项阻塞问题已在后续提交修复，见上条）。自有 fork `MisterBowie/oh-my-pi` 分支 `codex/omp-desktop-18.3.0-patch-2`（commit `3c845eb27f6f7b0a5b182f1868969ced86d10a3d`，tree `135ad4b6…`，= 18.3.0 基线 + `62bc57b+omp-desktop.2` 补丁，can1357 仅作只读上游）承载 sidecar 构建来源；`app/scripts/omp-sidecar.mjs` 是唯一构建入口（remote 规范化比较 / HEAD == 清单 fork commit / 工作树干净 / 版本 / 差异文件集 / 补丁反向应用，任一不符 fail closed），用 OMP 官方 Bun 单文件编译产出独立可执行文件与 `provenance.json`；打包态 `resolveRuntimeLauncher` 只接受 `process.resourcesPath/omp-runtime/{omp|omp.exe}` 且 binary 与清单的 sha256/bytes/platform/arch/fork commit/版本/patch level 全部校验通过，`OMP_DESKTOP_RUNTIME`、向上资源树扫描与 PATH 在 `app.isPackaged` 下全部失效；启动前 `--version` 身份断言 + 现有 `negotiate_protocol` v2 路径复用，失败时不产生可用会话。真实编译产物已完成无费用启动（版本 18.3.0、协议 v2）、隔离目录 canary 与进程组/临时目录回收验证。**R3 仍为硬阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、T20 未完成、T21 未完成**。证据 `docs/validation/M5-bundled-sidecar.md`；设计 `app/docs/adr/0307-bundled-omp-sidecar.md` + spec `03-runtime/02-agent-runtime.md` §17（中英镜像）。

2026-09-24：按用户要求以 `6914e68ef6e2bad632a8f549fde718e1f7f9db54` 做了一次 Linux x64 预览打包，发布 prerelease `m5-preview`（Linux AppImage 与 macOS arm64 dmg/zip，均内置固定 OMP 18.2.7 运行时，仅为试用；证据见 `docs/validation/M5-preview-package-2026-09-24.md`）。该产物不是 M6/T21、T22 的完成证据。

## 准备工作

| 编号 | 工作 | 状态 | 证据 |
| --- | --- | --- | --- |
| P01 | 确认项目目标及两份仓库 | 已完成 | 用户确认及 `00-scope-and-decisions.md` |
| P02 | 建立独立项目与文档工作区 | 已完成 | 根目录 README、AGENTS 与 docs |
| P03 | 拉取两份源码并固定基线 | 已完成 | `source-baseline.json`；GitHub 交付时 app 改为直接跟踪源码，上游固定为子模块 |
| P04 | 源码核对、路径校验和最终交接 | 已完成 | `01-source-audit.md`、HANDOFF、`validation/planning-2026-09-21.md` |

## 实现任务

| 编号 | 阶段 | 任务与交付 | 依赖 | 验收重点 | 状态 |
| --- | --- | --- | --- | --- | --- |
| T01 | M0 | Node 24、pnpm、Rust、Bun 环境与版本记录 | P03 | 可复现命令，不改全局 Node 默认 | 已完成 |
| T02 | M0 | 原桌面构建与测试基线 | T01 | 上游失败独立记录，尚不启动真实用户实例 | 已完成 |
| T03 | M0 | 开发数据/凭证/更新源隔离及代表性 UI 基线 | T02 | 先隔离再启动，不读写原产品数据、不自动更新 | 已完成 |
| T04 | M1 | OMP RPC 启动、版本协商、命令/事件 fixtures | T01 | ready、分片、应答与回合结束区分 | 已完成 |
| T05 | M1 | 工具执行前审批与拒绝实验 | T03,T04 | 拒绝无副作用；覆盖原生工具入口 | 已完成 |
| T06 | M1 | 取消、子代理及宿主工具实验 | T04,T05 | 后台实际终止，挂起请求清理 | 已完成 |
| T07 | M1 | 会话恢复、配置隔离及接入 ADR | T04-T06 | 原生会话映射；选定主路径 | 已完成 |
| T08 | M2 | 最小运行时接口和原 Pi 行为保持 | T07 | 旧流程对照测试 | 已完成（`docs/validation/M2-runtime-boundary.md` §3.1；`packages/shared/src/engine.ts` + `engine.test.ts` 20 项、`runtime/engine-router.ts` + 10 项、`engine-session-ipc` 4 项） |
| T09 | M2 | OMP 进程监督与协议适配包 | T08 | 退出/超时/帧错误，资源回收 | 已完成（`docs/validation/M2-runtime-boundary.md` §3.2；`packages/omp-runtime` 62 项含 mock 子进程与真实固定运行时无费用烟测；M1 413/413 未回归） |
| T10 | M2 | 会话引擎选择、能力判断和应用身份 | T03,T08,T09 | 新旧会话路由准确 | 已完成（`docs/validation/M2-runtime-boundary.md` §3.3；host-core schema v20 + 579 项、桌面 2537 项、身份隔离与开发构建禁用更新） |
| T11 | M3 | 文本、思考、工具、错误与用量事件 | T09,T10 | 顺序、隔离与未知工具退化 | 已完成（`docs/validation/M3-workflow.md` §1） |
| T12 | M3 | 审批与提问 UI、权限桥接 | T05,T11 | 请求关联、拒绝/超时/取消 | 已完成（同上 §2） |
| T13 | M3 | 停止与端到端编码流程 | T06,T11,T12 | 文件/命令副作用与 UI 一致 | 已完成（同上 §3） |
| T14 | M4 | 会话字段、迁移、恢复、归档 | T07,T13 | 旧库/新库，缺文件与中断恢复 | 已完成（`docs/validation/M4-persistence.md` §1-§3；host-core schema v21 + 582 项、`session.bindEngine`/`getEngineRef`、持久 `--session-dir`、registry 恢复/命名/归档；**分支 branch 关闭**——固定 OMP `branch` 语义与 PI fork 不兼容） |
| T15 | M4 | 模型配置、认证投影和凭证脱敏 | T07,T13 | 配置不串用，凭证不泄漏 | 已完成（同上；`omp-model-projection.ts` + canary 扫描；model change 为最小投影约束下的**离线 reclaim-first/persist-second restart**，thinking-only 在线 `set_thinking_level` 并回滚，mode/permissionMode 一次持久化） |
| T16 | M4 | 并发项目、队列、压缩与故障恢复 | T14,T15 | cwd 不漂移、无重复执行 | 已完成（同上；per-session registry、并发/恢复 E2E、`resume`/`modelSwitch` 开放、`branch`/`steer`/`followUp`/`compact` 保持拒绝） |
| T17 | M5 | OMP 子代理面板与编排归属 | T16 | 父子事件、查看、停止、恢复边界 | 已完成（`docs/validation/M5-subagents.md`；ADR 0303；验收代码基线 `ab07a888d6afb916561b80e5661ed27aa6be612a`；真实固定 OMP 子代理端到端验收 + macOS arm64 独立复审；`subagentEvents` 能力开放；限制：`stopSubagent` 恒拒（无 per-child stop RPC）、子代理 `hasUI=false` 工具 gating、批拓扑近似、`branch`/`steer`/`followUp`/`compact` 仍关闭；历轮返修见 §0.1-§0.14） |
| T18 | M5 | edit/LSP/DAP 结果与必要的专用展示 | T16 | 结构正确、未知结果可读 | 已完成（`docs/validation/M5-tool-results.md`；`tool-presentation.ts` 新增 OMP edit/LSP/debug 只读展示，LSP 诊断/失败/request 文本可见、debug snapshot/evaluation/断点 message/未知字段可见、edit 单/多文件/rename/create/delete/no-op/partial-error/pruned/diagnostics/firstChangedLine 可读且路径可点开；live 与 durable/子代理路径同 presenter，Pi/插件兼容与 4 MiB 预算不变；独立复审返修 R1-R4、S1-S4、Residual2、Create/Delete Duplicate 与诊断余量有界已完成——快照不抑制空结果文本、只消费已渲染值（含嵌套余量与 malformed/未来值回退）、裁剪非 no-op、rename 关系 + 挂载交互回归、residual 探针扩至 19/19；独立复审方已验收，验收产品基线 `a35da2f87a745fbedd8f5beb46368607c2f6b72e`） |
| T19 | M5 | MCP、规则、技能、记忆及插件分类适配 | T16 | 单一加载责任、不重复工具注册 | **已完成**（T19-A：`docs/validation/M5-capability-sources.md`、ADR 0304；T19-B：`docs/validation/M5-host-tool-rpc.md`；T19-C：`docs/validation/M5-capability-user-paths.md`、ADR 0304 §5——桌面技能目录+项目记忆经可信 gate 注入、按需 `Skill` host tool 实时读、原生技能/记忆源保持关闭或原样） |
| T20 | M5 | Plan/Goal 和高权限工具能力门 | T17-T19 | 不借用不适用的原权限/模式语义 | **已完成**（功能根接受860c2641；Windows夹具e52ab74经真实RED→GREEN及Windows原生验证；最终bdec5007/tag m5-test-20261015-bdec5007/run38671315205全3native各15/15、0skip并已统一发布，根完整下载9资产/SHA/记录固定坐标全一致，见M5-native-release-20261015。仅Cursor+Plan/Goal排除，ADR0306门与非Cursor严格契约保留；M6/M7继续） |
| T21 | M6 | OMP 运行时资源打包与版本固定 | T16 | 无全局 Bun/OMP 依赖也能启动 | **已接受**：固定资源/版本/来源，冷 Cargo 完整锁定准备；三平台包内版本/protocol/get_state、missing-gate 拒绝、停止/回收/清理与15/15回归；完整公开资产回读见 [M6 最终验收](validation/M6-native-release-20261015.md)。 |
| T22 | M6 | 品牌、更新源、许可证及 macOS 安装产物 | T20,T21 | 新旧应用并存，发布源独立 | **已接受（测试分发）**：独立品牌/图标/appId/profile/data/凭证命名/更新源与cache、冻结第三方声明，实际 PI 并存、默认profile、Mac离线/崩溃及公开DMG工作流。unsigned/unnotarized、原生对话框未覆盖等边界见 [M6 最终验收](validation/M6-native-release-20261015.md)。 |
| T23 | M6 | Windows/Linux 分平台验证 | T22 | 平台原生依赖、取消和路径 | **已接受（测试分发）**：三平台轻量原生检查与实际安装8/8，各2次正常退出/零残留；Windows USERPROFILE/PATH/8.3与精确handle负对照，Linux AppImage。DEB/RPM系统注册未测；Windows Bash需Git for Windows。见 [M6 最终验收](validation/M6-native-release-20261015.md)。 |
| T24 | M7 | 日常任务验收、升级回退及维护交接 | T22 | 真实工作流、限制说明、升级演练 | **已接受（测试分发）**：三平台固定源码46e7bf7，包内15/15、安装8/8、日常6/6、实际升级回退7/7，全部正常退出零残留；根完整下载15资产/六份原始证明，另复测同一公开Mac包。用户说明、维护检查单、上游演练及边界均已交接；见 [M7最终验收](validation/M7-native-release-20261016.md)。 |

T23 不阻塞仅面向 macOS arm64 的首次交付，但未通过前不能宣称跨平台可用。T17-T20 按用户实际功能优先级逐项开放，不要求在基本开发版之前全部完成。

## M0 完成记录（T01-T03）

证据详见 `docs/validation/M0-baseline.md`（命令、退出码、版本、SHA、界面截图均已记录）。

- **T01 环境**：Node v24.14.0（nvm）、pnpm 10.34.5（corepack）、Bun 1.4.2、rustc stable 1.95.0 + nightly-2026-08-12（1.99.0-nightly）、cmake 4.4.3 + ninja 1.13.2（pip）；参考子模块浅取到固定 SHA（pi-desktop `0111e306`、oh-my-pi `d49918fab`）。
- **T02 构建/测试**：`pnpm install --frozen-lockfile`、`build:js`、`typecheck`、`lint`、`cargo build -p host-core --locked`、`cargo test -p host-core --locked`（577 通过）、`cargo fmt --check` 均通过；`pnpm -r --if-present test` 1 项失败（`remote-host-ssh-password.test.mjs`，本机 `SSH_ASKPASS` 环境变量触发，非回归）；重跑范围明确为 **desktop 包套件**（`env -u SSH_ASKPASS node --test apps/desktop/test/*.test.mjs` → 2523 项 / 2519 通过 / 0 失败 / 4 跳过），其余 workspace 包未重跑。
- **T03 隔离/UI**：开发版以 `PI_DESKTOP_DATA_DIR` 隔离，`pi.sqlite`/`secrets/.machine-key`/日志/插件写入 `.dev-data/pi-desktop`，`~/.pi-desktop` 零写入，更新源 dev 构建 `disabled`；Electron 43.6.0 启动，CDP 截取项目列表/设置-MCP/模型/扩展 5 张基线截图。
- **OMP 协议启动（M0 步骤 7，T04 前置）**：`bun setup` 成功；`node docs/validation/M0-rpc/verify-rpc.mjs`（绑定 `upstream/oh-my-pi/.../scripts/omp` 的 repo 路径入口，gitlink=submodule SHA=`d49918fab`、版本 18.2.7 核对一致；全量隔离 + readline 分帧 + 进程树回收）输出 `ready`、`negotiate_protocol`(v2)、`get_available_models`（mock 模型，无付费模型调用）。

> 复审返修（2026-09-22，四轮）：第一轮 6 项 + 第二轮 6 项 + 第三轮 4 项及临时目录清理 + 第四轮 2 项（环境恢复断言/凭据日志泄漏、管道错误统一清理）均已修复并重验。详见 `docs/validation/M0-baseline.md` 顶部四段“返修记录”。

## 单任务记录模板

```text
任务：Txx
状态：
当前阶段：
基线 SHA / 本次测试代码状态：
目标与可观察行为：
实际修改文件：
验证命令及结果：
代表性用户路径：
已确认的接口 / 数据归属：
未完成项及原因：
风险或需要用户决定的事项：
下一任务：
证据文档：docs/validation/...
```

如果只完成源码分析，没有完成行为实验，应标记“进行中”，不能把推测写成“已验证兼容”。

## M1 任务记录（2026-09-22）

```text
任务：T04 OMP RPC 启动、版本协商、命令/事件 fixtures
状态：已完成
基线 SHA / 本次测试代码状态：M0 基线 4321095；OMP d49918fa；分支 codex/m1-compatibility；新增未跟踪文件
目标与可观察行为：锁定源码启动 rpc-ui，读取 ready，协商协议版本，记录命令/事件帧与帧限制
实际修改文件：app/experiments/omp-bridge/（e01、e02、lib/rpc.mjs、lib/provider.mjs、fixtures/e01、e02）
验证命令及结果：node run-all.mjs → e01 26/26、e02 12/12 通过；M0 verify-rpc.test.mjs 18/18、verify-rpc.mjs 通过
代表性用户路径：会话建立、发消息、看到文本/思考/工具事件、回合结束
已确认的接口 / 数据归属：NDJSON 帧；帧限制 1 MiB / 64 MiB；negotiate_protocol 只接受 v2（广告 [1,2] 但 v1 被拒绝）；prompt 立即应答而 agent_end 才是回合结束
未完成项及原因：无
风险或需要用户决定的事项：不要把 ready 的 supportedProtocolVersions 当可回退清单
下一任务：T05
证据文档：docs/validation/M1-compatibility.md
```

```text
任务：T05 工具执行前审批与拒绝实验
状态：已完成
基线 SHA / 本次测试代码状态：同上
目标与可观察行为：受信扩展在工具执行前阻断原生 write/bash，并覆盖宿主工具入口
实际修改文件：app/experiments/omp-bridge/（e03、e04、e08、e10、extensions/approval-gate.ts、fixtures/e03、e04、e08、e10）
验证命令及结果：node run-all.mjs → e03 23/23、e04 29/29、e08 23/23、e10 18/18 通过
代表性用户路径：模型请求写文件/执行命令 → 桌面审批 → 拒绝或批准一次
已确认的接口 / 数据归属：tool_call 钩子执行前可达且带具体目标；拒绝无副作用；宿主工具同走该钩子；只有 rpc-ui 提供工具级 UI（含 ask）
未完成项及原因：无
风险或需要用户决定的事项：审批 UI 必须先于执行；交互提问本身不等于权限审批
下一任务：T06
证据文档：docs/validation/M1-compatibility.md
```

```text
任务：T06 取消、子代理及宿主工具实验
状态：已完成
基线 SHA / 本次测试代码状态：同上
目标与可观察行为：取消运行中的工具与挂起对话，验证宿主工具往返/取消与子代理事件
实际修改文件：app/experiments/omp-bridge/（e05、e08、fixtures/e05、e08-host-tool-cancel.json、e08-subagent-events.json）
验证命令及结果：node run-all.mjs → e05 28/28、e08 23/23、e11 42/42 通过（第五轮复审后重跑：全套 13/13、413/413、退出码 0）
代表性用户路径：执行中停止；审批弹窗中停止；宿主工具回灌结果；委派子代理并观察进度
已确认的接口 / 数据归属：挂起对话与宿主工具调用都会被取消（均按 targetId 关联）；子代理三类帧与存活期快照可用。**复审 R1/F1 修正**：①旧结论"abort 不回收命令进程"已撤回（旧命令 `echo $$; exec sleep 300` 从未运行，退出码 127），用真实外部程序重做后顶层 `abort` 即可回收命令进程及其子进程，不先停止就杀桥接进程组会留下孤儿；②旧 E11 用共享响应队列，父会话抢走了本应属于子代理的轮次，其"子代理审批"结论无效；按会话身份路由重做后：子代理工具调用进入同一钩子但 `hasUI=false`（无法弹窗，须由策略/带外通道决定），父 `abort` 不回收 detached 子代理命令树；**第三轮 R1 追加**：父 `abort` 也不会取消子代理的挂起审批（迟到 allow 会真的执行），已撤回旧结论并由桥接侧取消实现，ADR 第 5 条据此重写
未完成项及原因：子代理在父回合停止后的存活语义已测到"不回收"，其恢复/重启边界留待 T17
风险或需要用户决定的事项：停止顺序必须为"先协议内停止，再拆桥接"；子代理后台进程树必须显式终止；子代理审批无法交互，桌面必须实现策略或带外通道
下一任务：T07
证据文档：docs/validation/M1-compatibility.md
```

```text
任务：T07 会话恢复、配置隔离及接入 ADR
状态：已完成
基线 SHA / 本次测试代码状态：同上
目标与可观察行为：原生会话的新建/命名/恢复/分支，配置与凭证隔离，选定主接入路径
实际修改文件：app/experiments/omp-bridge/（e06、e07、e09、e12、e13、lib/base.mjs、lib/ndjson.mjs）、docs/decisions/001-omp-transport.md、docs/00-scope-and-decisions.md
验证命令及结果：node run-all.mjs → e06 23/23、e07 36/36、e09 30/30、e12 93/93、e13 30/30 通过；总计 13/13 实验、413/413 检查、退出码 0
代表性用户路径：重启后恢复会话；切换项目不串数据；发送含中文与 emoji 的长消息；桌面崩溃后不留孤儿进程
已确认的接口 / 数据归属：原生会话归 OMP；桌面只存索引与投影；rpc-ui 为唯一提供 ask 工具的模式；桥接断开时 OMP 自退出并被回收
未完成项及原因：MCP 工具未进入模型工具表（T19）；macOS 进程终止未验证（T23）
风险或需要用户决定的事项：接入路径已定案，M2 必须按决策文档 §3 的十条约束实现
下一任务：T08
证据文档：docs/validation/M1-compatibility.md、docs/decisions/001-omp-transport.md
```

