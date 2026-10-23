# 0.1.5 本地 Mac ARM 测试包（2026-10-23）

状态：**候选与本地测试包已构建并通过自动验收；等用户安装手动测试确认后发布。**
包未签名，不作为发布产物；正式发布的是 r2 远端候选的原始制品。

## 来源与构建

- 源码：`codex/omp-dead-controls` 的 `4194e804`（R09–R11 加 0.1.5 版本面）。远端候选
  `release-check-0.1.5-omp-controls-20261023-r2` → run [39956958677](https://github.com/MisterBowie/omp-desktop/actions/runs/39956958677)，
  guard、verify、四平台 build 全部成功。先前的 r1（run 39933396670，`8cae5e40`）在 verify 失败：一次性 chatfix
  控制器测试把当前工作区版本硬编码为 0.1.4，升到 0.1.5 后失效；`4194e804` 把该测试固定在它自己的 0.1.4
  隔离树里，产品代码不变。
- r2 远端产物需要 GitHub 登录才能下载：匿名 API 返回 401，本机没有 `gh` 或已存凭据。按上一轮同一标准链本地
  构建：
  `OMP_SIDECAR_SOURCE=/tmp/ohm-fork CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pi-desktop/desktop run dist:mac --arm64`。
- 受控 fork：`https://github.com/MisterBowie/oh-my-pi` 的 `edec3898`，`omp-sidecar.mjs --check` 通过；运行时为
  OMP 18.3.0、`62bc57b+omp-desktop.7`，二进制 SHA-256 `2ce166da…`（本机 Bun 1.4.2 编译，逐字节与官方不同，
  provenance 与包内校验以本次产物为准）。
- Node v24.14.0、pnpm 10.34.5、Bun 1.4.2、Electron 43.6.0。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.5-arm64.dmg | 221367652 | 2b802e73cc5c6cd8a8c8567e8a739df9da0b0a7feac9d3b74cc314f9028df105 |
| OMP-Desktop-0.1.5-arm64-mac.zip | 220271721 | 81db7d5d9c57e96d02822c1fed6bcab65c8881fda707c6ce255f343e9d47890d |

DMG 已按用户习惯移到 `~/Downloads/OMP-Desktop-0.1.5-arm64.dmg`（SHA-256 不变）；ZIP 在
`app/apps/desktop/release/`。

## 验证

环境：macOS arm64；以下全部 exit 0。

| 命令/范围 | 结果 |
| --- | --- |
| 工作区全量测试（`pnpm -r --if-present test`，内置 0.1.5 运行时与 FakeProvider） | desktop **3244 项：3234 通过、0 失败、10 跳过**（跳过项需专用资源）；其余包无失败 |
| 候选 verify 的脚本测试 13 个文件 | **81 项：77 通过、0 失败、4 跳过** |
| DMG `hdiutil verify` / ZIP `unzip -t` | VALID / 无错误 |
| `verify-packaged-runtime --resources <DMG 内 Resources>` | 18.3.0、协议 v2、`get_state` 通过、缺少 gate 被拒绝、停止/回收/清理完成 |
| `inspectInstalledProduct`（期望 0.1.5） | 通过：包名、版本、主页、更新源 `MisterBowie/omp-desktop`、许可证 |
| 安装态冒烟 `scripts/e2e-installed-smoke.mjs <DMG>` | **8/8**：建项目与 OMP 会话；拒绝写入后原字节不变；允许一次后真实写入；项目命令结果回到模型；Stop 回收三层外部进程；退出重启恢复同一原生历史且不重放；重启后新回合完成；默认数据根为隔离 HOME 下的 `.omp-desktop` |

所有模型都是 127.0.0.1 FakeProvider，没有真实模型调用。原始输出、截图与原生记录在
[Version-015-local-20261023/](Version-015-local-20261023/)，`SHA256SUMS.txt` 记录摘要。

### 冒烟探针修正

本机窗口处于隐藏状态（`document.hidden`）时，消息行上的 `content-visibility: auto` 会让
`document.body.innerText` 漏掉已经布局可见的回复文本：DOM 文本节点存在且矩形为 696×22、祖先全部可见，但
`innerText` 不含它，截图里回复正常显示。旧探针因此连续超时。`installed-workflow.mjs` 改为先在 DOM 文本中
查找，再要求该文本节点自身有非空矩形且 `display`/`visibility` 可见；没有放宽可见性要求。修正后冒烟 8/8
一次通过。该修正只改本地验收脚本，不进入安装包；候选与本地包的产物仍来自 `4194e804`。

## 边界

- 包未签名、未公证，首次打开可能需要在“系统设置 → 隐私与安全性”中放行。
- 自动验收只覆盖本机假模型；真实模型和人工界面流程由用户测试确认。
- 用户确认后，发布走 `publish-v0.1.5-run-39956958677`，发布 r2 候选的原始制品，不是本地包；0.1.5 正式版
  的更新源会向已安装用户推送。
