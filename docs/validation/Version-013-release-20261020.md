# 0.1.3 合并发布（2026-10-20）

用户明确授权完成后提交并发版，同时纳入会话“排查 Claude 上下文识别”
（`01a1574a-a5fe-7633-a5c2-53c9e0df2043`）。按当前 0.1.2 的普通递增准备 **0.1.3**。
当前本机合并源码验证通过，远程候选与正式发布尚未执行；以下不能当作已发布证明。

## 包含内容与来源

1. 自动记忆：原生 Mnemopi 自动保存/读取独立开关、执行目录隔离、查看/搜索/确认清空、
   维护前回收空闲写入者与启动可用性检查。桌面提交 `ce74c76e`。
2. 供应商模型限制：只整合该会话相对其 0.1.1 基线的实际补丁，保留本分支 0.1.2 的已有修复。
   分别采用端点上下文与输出限制，保留手动覆盖和来源；提交 `bd3e6416`。
   原工作树未修改，其原始验收/失败记录无损 gzip 保存；参见[来源证据](Provider-model-limits-20261020.md)。
3. 原生 fork `edec3898d44071206ec201beebea432a2786bd8c` / `.7` 已推送到用户仓库，
   五个有效构建工作流的固定引用同步更新。上游参考 gitlink 不变，应用 schema 22 不变。
4. 八语言 0.1.3 更新记录、全部版本入口及最新 models.dev 快照统一；公开回读从所选发布
   标签派生版本，普通候选晋升后也完整下载核验安装包/更新 feed/来源收据。

现有 0.1.2 及 Skill 修订版标签/资产保持原样。候选先走四目标全部门，全部成功后才晋升
同一批安装包；不以本机 ARM 测试替代其他平台证据。原生和桌面源码推送都指向用户自有仓库。

## 本机合并候选验证

macOS ARM64，Node 24.14.0 / pnpm 10.34.5 / Bun 1.4.2。
JS 构建、桌面类型、lint、80 对/521 页文档、版本说明与 Rust fmt/clippy 均 exit 0。
OMP 565、桌面 222、shared 源码 500、agent-runtime 定向 46、Rust 648、交付脚本 31 项通过，
不把 dist 副本重复加作源码用例。7 份 YAML、100 段 Bash、4 段内联 JS 解析通过。
真实 .7 原生记忆 E2E 1/1、真实 Electron 设置与重启持久化通过；所有请求使用本地模拟模型。
原生及 UI E2E 使用独立临时目录，未修改已安装应用、真实数据库或调用付费模型。

关键命令：`pnpm build:js`、`pnpm --filter @pi-desktop/desktop typecheck`、`pnpm lint`、
`pnpm docs:check`、`pnpm check:release-docs`、`cargo test -p host-core --locked`、
`cargo clippy -p host-core --all-targets --locked -- -D warnings`；OMP 使用
`OMP_SIDECAR_TEST_RESOURCES=$PWD/.artifacts/omp-013-runtime`、`vitest run --maxWorkers 2`；
shared 使用 `vitest run src`；真实记忆测试指定同一 .7 标准二进制。
命令输出、摘要与变更后文件快照见[JSON 进度收据](Version-013-release-20261020.json)和同名证据目录。

## 新增发布门

每个平台在包内严格 Plan/Goal 验证后，用包内的原生程序运行自动记忆 E2E（必须 1/1、零跳过），
再以同源 release host-core 运行真实 Electron 设置页与重启验证，结果随原生验收制品上传。
Linux 通过既有 Xvfb。退出、权限、进程所有权和原有 15 项严格契约未放宽。
发布回读的版本绑定有真实 Bash/Node 用例，覆盖 0.1.3、旧版 Skill 修订及非法标签拒绝。

## 安装后使用

“设置 → 记忆”开启所需开关，默认均关闭。记忆整理可能增加会话模型 Token；
手动项目记忆独立保留。供应商设置需刷新模型列表并保存，旧继承的 128k 才会采用
端点最新限制；手动 128k 保留，也不把所有 Claude 型号硬设为 1M。

## 待完成

固定并推送合并候选，取得四目标完整成功证据后晋升，完成公开全量字节回读并更新本记录。
