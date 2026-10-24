# 0.1.6 本地 Mac ARM 测试包（2026-10-24）

状态：**本地测试包已构建并通过自动验收；远端候选 r2 整轮通过；等待用户安装测试确认。**包未签名，不作为发布产物；
正式发布的是远端候选的原始制品。

## 来源与构建

- 源码：`codex/release-016` 的 `f0c9399a`（`main` `cf1b42ad` 上的 R15 错误卡片关闭按钮，加 0.1.6 版本面与
  八种语言更新记录）。用户 2026-10-24 决定以 0.1.6 正式版发布。
- 远端候选 r1：`release-check-0.1.6-error-card-20261024` → run
  [40083986066](https://github.com/MisterBowie/omp-desktop/actions/runs/40083986066)：guard 与 Linux、
  macOS arm64 构建成功，verify 在 `pnpm -r --if-present test` 失败。按现有诊断方式推
  `diagnose-source-tests-40083986066`，诊断分支 `codex/source-test-diagnostic-40083986066` 只记录失败位置：
  `app/apps/desktop/test/omp-plan-submit-e2e.test.mjs` 第 1113/1232 行（ASSERTION），即 T20-B2“已批准执行在终止
  先于派发返回时结算”的 30 秒等待未等到 `completed`。该用例与计划派发代码自 0.1.5 起未改动，0.1.5 r2 候选的
  verify 已通过它；本机单跑 3 次、4 路并发各 1 次均通过，未复现。判定为远端时序抖动，未改代码。
- 远端候选 r2：同一提交 `f0c9399a` 的 `release-check-0.1.6-error-card-20261024-r2` → run
  [40086409361](https://github.com/MisterBowie/omp-desktop/actions/runs/40086409361)：guard、verify、四平台
  build（macOS arm64/x64、Windows x64、Linux x64）全部成功，publish 按候选跳过，整轮 `success`。
- 本地构建：
  `OMP_SIDECAR_SOURCE=<根目录>/.omp-sidecar-edec389 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pi-desktop/desktop run dist:mac --arm64`。
- 受控 fork `MisterBowie/oh-my-pi` 的 `edec3898`，运行时 OMP 18.3.0、`62bc57b+omp-desktop.7`，来源清单桌面版本
  0.1.6；二进制 SHA-256 `98a005a6…`（本机 Bun 1.4.2 编译）。
- Node v24.14.0、pnpm 10.34.5、Bun 1.4.2、Electron 43.6.0。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.6-arm64.dmg | 221339080 | f49e862b8d1498f124f6c33cd23b0dba1eb66d4d95391dc3da9adff7130bbcac |
| OMP-Desktop-0.1.6-arm64-mac.zip | 220255997 | 63ce4a3d1cc93b74937f7b92f1bb96eca210befea5790ca9b4a430d3bac67421 |

DMG 已移到 `~/Downloads/OMP-Desktop-0.1.6-arm64.dmg`（SHA-256 不变）；ZIP 在 `app/apps/desktop/release/`。

## 验证

环境：macOS arm64。

| 命令/范围 | 结果 |
| --- | --- |
| `pnpm check:release-docs` | exit 0：文档与 0.1.6 一致 |
| `pnpm build:js`、`cargo build --release/--locked -p host-core`、desktop typecheck、`pnpm lint` | 均 exit 0 |
| 工作区全量测试（`pnpm -r --if-present test`，借用已安装 0.1.5 的包内运行时） | desktop 3249 项：3232 通过、10 跳过、7 失败；7 项均为原生 e2e，因 0.1.5 来源清单的桌面版本不等于 0.1.6 被按设计拒绝（`bundled-runtime-invalid`）；其余包无失败 |
| 上述 7 个原生 e2e 文件改用本次 0.1.6 包内运行时重跑 | 7/7 通过 |
| 候选 verify 的脚本测试 13 个文件 | exit 0 |
| `cargo test -p host-core --locked` | exit 0 |
| DMG `hdiutil verify` / ZIP `unzip -t` | VALID / 无错误 |
| `verify-packaged-runtime --resources <DMG 内 Resources>` | 18.3.0、协议 v2、`get_state` 通过、缺少 gate 被拒绝、停止/回收/清理完成 |
| `verify-installed-product --app <DMG 内应用>` | `verified: true`（包名、版本、更新源、图标、许可证） |
| 安装态冒烟 `scripts/e2e-installed-smoke.mjs <DMG>` | **8/8**：建项目与 OMP 会话；拒绝写入后原字节不变；允许一次后真实写入；项目命令结果回到模型；Stop 回收外部进程树；退出重启恢复同一原生历史且不重放；重启后新回合完成；默认数据根为隔离 HOME 下的 `.omp-desktop`；版本 0.1.6 |

所有模型都是 127.0.0.1 FakeProvider，没有真实模型调用。原始输出、截图与原生记录在
[Version-016-local-20261024/](Version-016-local-20261024/)，`SHA256SUMS.txt` 记录摘要。

## 边界

- 包未签名、未公证，首次打开可能需要在“系统设置 → 隐私与安全性”中放行。
- 自动验收只覆盖本机假模型；真实模型和错误卡片关闭的人工流程由用户测试确认。
- 用户确认后，发布走 `publish-v0.1.6-run-40086409361`（r2），发布候选的原始制品，不是本地包；
  0.1.6 正式版的更新源会向已安装用户推送。
