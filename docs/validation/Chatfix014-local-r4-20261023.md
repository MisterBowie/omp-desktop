# 0.1.4+chatfix r4 本地 Mac ARM 测试包（R08，2026-10-23）

状态：**本地测试包已构建，并通过包内与安装态自动验收；用户已安装手动测试，2026-10-23 确认通过。**
包未签名，不作为发布产物；正式发布的是 r4 远端候选的原始制品，见
[chatfix 发布记录](Chatfix014-release-20261022.md)末节。

## 来源与构建

- 源码：修订线 `codex/chatfix-revision` 头 `477a4ac2`。与 r4 远端候选源码 `852ca1b9` 相比只多了文档记录
  （`git diff 852ca1b9 477a4ac2 -- app` 为空）。不含 R09–R11。
- r4 远端产物需要 GitHub 登录才能下载：匿名 API 返回 401，本机没有 `gh` 或已存凭据。因此按上一轮本地包的同一
  标准链在本机构建：
  `OMP_SIDECAR_SOURCE=<受控 fork 检出> CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pi-desktop/desktop run dist:mac --arm64`。
- 受控 fork 检出：从 `git@github.com:MisterBowie/oh-my-pi.git` 浅取 `edec3898`（树 `d7b02053`，与清单一致）和基线
  `62bc57be`，`omp-sidecar.mjs --check` 通过。补丁不改 Rust 原生源码和锁文件，依赖与原生模块从根目录参考子模块
  （同一锁文件）以 APFS 克隆复制。
- 第一次构建时 electron-builder 直连 GitHub 下载 Electron 超时（`ETIMEDOUT`）。按 `docs/07` 记录的做法，只对这一条
  命令设置本机代理 `127.0.0.1:7897` 后完成；没有关闭 TLS 或校验，也没有绕过 sidecar 预检。
- 内置 OMP 为 18.3.0、`62bc57b+omp-desktop.7`、fork `edec3898`。本次编译的二进制 SHA-256 为 `98a005a6…`，与官方
  0.1.4 的 `36d59eba…` 不同：Bun 单文件编译在不同构建之间不是逐字节相同，provenance 与包内校验都以本次产物为准。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.4-arm64.dmg | 221369823 | 1811b05cd291f9520a6e7ca3e3df4de20ead04867b010d9dde6ae90d4fe1f014 |
| OMP-Desktop-0.1.4-arm64-mac.zip | 220270311 | 8a89b167399f0e820ef3d09468614df05ee44cc4346e87cc7cf7535f681a5c01 |

产物构建在 `.worktrees/chatfix-revision/app/apps/desktop/release/`。DMG 之后按用户要求移到
`~/Downloads/OMP-Desktop-0.1.4-chatfix-r4-arm64.dmg`（SHA-256 不变），ZIP 仍在原目录。

## 本机验收

环境：macOS arm64，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2。以下全部 exit 0：

- DMG `hdiutil verify`：VALID；ZIP `unzip -t`：无错误。
- `inspectInstalledProduct`：包名 `omp-desktop`、版本 0.1.4、主页、更新源、图标、许可证均通过。`lipo -archs`：
  Electron、host-core、OMP 均为 arm64。177 个编译文件与包内 asar 逐一 SHA-256 相同，包内主进程含 R06 的
  `agents.active` 调用。
- `verify:packaged-runtime --resources <包内 Resources> --json`：运行时 18.3.0、协议 v2、get_state 通过，缺少 gate
  时被拒绝，停止/回收/清理完成，零残留运行。
- 用包内 Resources 跑原生 e2e，**5/5** 通过：DeepSeek 空正文回放、首次发送与自动命名、会话操作（插话、Todo、Skill
  跟进、压缩、取消）、设置子代理接入原生 `task`、工作树隔离。
- 安装态冒烟 `scripts/e2e-installed-smoke.mjs <DMG>`：只读挂载 DMG，把应用复制到临时 Applications 目录（路径含中文、
  空格与引号），隔离 HOME。8 步全部通过：建项目与 OMP 会话；拒绝写入后原字节不变；允许一次后真实写入；项目命令
  执行且结果回到模型；Stop 回收三层外部进程；有序退出后重启，恢复同一原生历史且没有重放模型或工具；重启后的新
  回合完成；默认数据根为隔离 HOME 下的 `.omp-desktop`，其他应用的数据未被读取或改动。

所有模型都是 127.0.0.1 FakeProvider，没有真实模型调用。原始输出、截图与报告在
[Chatfix014-local-r4-20261023/](Chatfix014-local-r4-20261023/)，`SHA256SUMS.txt` 记录摘要。

## 边界

- 包未签名、未公证，首次打开可能需要在“系统设置 → 隐私与安全性”中放行。
- 自动验收只覆盖本机假模型；真实模型和人工界面流程由用户测试确认。
- 用户确认后，发布仍走同版本修订流程，发布的是 r4 远端候选的产物，不是本地包。
