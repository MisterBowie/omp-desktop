# 0.1.1 发布后缺陷修复（2026-10-19，未发布源码）

## 范围与候选

用户要求“除了 OMP 原生不支持的，能处理的就处理”。本轮只闭合已复现的九项
桌面/Pi 兼容缺陷及必要的依赖安全修补；不开放 T25-B，不进入 T27。

- 分支：`codex/fix-post-release-bugs`，独立工作树。
- 当前 HEAD：`8233c81398c170808c99aedc7bb525b47eeac467`，修复为其上的未提交改动。
- 准备候选时已获取并包含 `origin/main`：`a23bfb9befea327e7924efd3004e030a11b587d2`。
- 产品版本仍为 `0.1.1`；没有更新 v0.1.1 标签、安装包或更新源。
- OMP 保持 `18.3.0`、`62bc57b+omp-desktop.6`、fork `d648d27bcf0db16caecb876142d891cf49a51bc2`。
- 参考 PI `v0.21.0-beta.3` 的官方修复，审阅参考提交
  `5e1655893ce6181b3e9324b0f49b52f1c7f79762`，没有整体升级 Pi SDK 或修改参考子模块。
- Node `24.14.0`、pnpm `10.34.5`、Electron `43.6.0`，macOS arm64。
  Rust `1.99.0-nightly`（2026-08-11），另用桌面 CI 的 stable `1.98.1` 编译并复测。pnpm 在任务私有目录安装并校验官方 SHA512，
  没有修改全局默认 Node/pnpm。

此前已发布版本的结果仍见 [版本差异审计](Version-011-bug-audit-20261019.md)。
该记录描述原版，不能据本轮源码修复声称已发布的安装包也已修好。

## 修复映射

| 场景 | 修复后的可观察行为 | 主要实现 | PI 参考 |
| --- | --- | --- | --- |
| B01 | 主代理/委派循环使用独立消息数组；重放调用按 wire ID 去重，不插入重复工具结果；单独结果 ID 重映射也生效 | agent-runtime `runtime.ts`、`subagent.ts`、`tool-call-dedupe.ts` | [#856](https://github.com/vastsa/PI-Desktop/pull/856) |
| B02 | 全局与项目 AGENTS 各有 32 KiB 预算；UTF-8 安全截断并明示来源及字节数 | `project-instructions.ts` | [#1495](https://github.com/vastsa/PI-Desktop/pull/1495) |
| B03 | BrowserHost 的 CDP 操作 30 秒超时并断开；重连后旧回复不能继续旧点击 | `browser-host.ts`、`browser-cdp.ts` | [#1619](https://github.com/vastsa/PI-Desktop/pull/1619) |
| B04 | MCP HTTP 收到完整 SSE 消息即分派，无需等 EOF；跨块 UTF-8/CRLF 及 4 MiB 累计上限有效 | `plugin-mcp.ts` | [#1189](https://github.com/vastsa/PI-Desktop/pull/1189) |
| B05 | 请求超时发送带原请求 ID 的 `notifications/cancelled`；initialize 除外；HTTP 使用实际请求预算 | `plugin-mcp.ts` | [#1552](https://github.com/vastsa/PI-Desktop/pull/1552) |
| B08 | 宿主 Read/Edit 支持有效带 BOM 的 UTF-16 LE/BE，写回保留编码、字节序、BOM、换行；仍拒绝畸形与 NUL | Rust tools/hashline | [#1445](https://github.com/vastsa/PI-Desktop/pull/1445) |
| B09 | 上下文占用不再额外累加已包含在 output 中的 reasoning；明细与账单汇总不变 | `context-usage.ts` | [#1553](https://github.com/vastsa/PI-Desktop/pull/1553) |
| B10 | 规范路径相同的 MV 返回 EDIT_NO_CHANGE；组合 PUT+MV 在任何写入前原子拒绝，源字节和旧 Read 凭据保留 | Rust `tools/mod.rs` | [#1451](https://github.com/vastsa/PI-Desktop/pull/1451) |
| B12 | 工作面板对 tracked/untracked diff 都禁用 textconv，显示补丁不会执行仓库转换程序 | host-runtime `workspace-diff.ts` | [#1660](https://github.com/vastsa/PI-Desktop/pull/1660) |

B01/B02/B08/B10 是 Pi 兼容路径，不据此认定默认原生 OMP 存在相同缺陷。
B09 是共享用量辅助函数，OMP 事件目前不提供 reasoningTokens。
B11 是原生 OMP Read 的 UTF-8-only 能力差距，按用户要求排除，没有伪造支持。
B12 与 Rust worktree 合并路径不同，后者原本已经禁用 textconv。

## 已运行验证

所有模型输入、网络回复、文件与会话均为隔离夹具；没有真实付费提供方调用。
原始日志位于工作树被忽略的 `app/.artifacts/bug-fixes-20261019/`，不公开。

| 命令/验证 | 结果 | 说明 |
| --- | --- | --- |
| 原版源码/宿主运行 `scripts/audit-released-bugs.mjs` | 13 项：3 通过、9 失败、1 跳过；退出 1 | 此次基线主动跳过 B11；九个失败与原版缺陷对应 |
| 当前源码/新编译宿主运行同脚本，`--test-skip-pattern="B11 OMP native Read"` | 12 项全部通过，退出 0 | Node 的 CLI 排除后不计 B11，不能写成 13 项通过 |
| `pnpm --filter @pi-desktop/agent-runtime test` | 54 文件、774 项通过，退出 0 | 包含真实 Pi adapter、消息配对、指令预算、委派上下文回归 |
| `pnpm --filter @pi-desktop/host-runtime test` | 7 文件、36 项通过，退出 0 | 包含真实 Git textconv 夹具 |
| 桌面定向回归 | 56 文件、458 项通过，退出 0 | 沿用原 48 文件，加入 BrowserHost/MCP 时限、真实 Markdown 渲染及现有 Markdown/Mermaid 安全约束；文件集合见配套 JSON |
| `cargo test -p host-core --locked` | 646 项通过，退出 0 | 包含真实临时文件编码与同源 MV；不把 76 项 tools 子集重复累计 |
| `cargo +stable test -p host-core --locked` | 646 项通过，退出 0 | stable 构建也通过；不把同一套测试重复计数 |
| `cargo fmt --check` | 通过，退出 0 | |
| `cargo clippy -p host-core --all-targets --locked -- -D warnings` | 通过，退出 0 | 两处新 UTF-16 写法已按当前 Rust lint 修正；顺带移除原有无效 format |
| `pnpm lint` | 通过，退出 0 | 配置只覆盖其声明的文件，非所有 mjs/ts 都接受 Biome 检查 |
| `pnpm docs:check` | 79 对中英规格、517 文档通过，退出 0 | 5 条既有 ADR 格式提示非失败 |
| 真实 Electron `scripts/e2e-browser-screenshot.mjs` | 6 场景通过，退出 0 | 长页、宽页、双轴、小页、2x、viewport；实际 JPEG 内容与尺寸验证 |

基线/回归包括修正测试夹具的过程，不把错误工作目录、缺失 fixture 字段或清理函数名
错误视为产品缺陷。新增迟到回复夹具曾独立复现 2 次旧点击鼠标事件，补齐 epoch
校验后通过。正常 CDP 完成也验证不会残留迟到断开计时器。

## 依赖与最终构建

已完成锁文件审阅、`pnpm install --frozen-lockfile --ignore-scripts`（退出 0）及更新后审计。
首次在线解析因 npm 慢请求停止，保留官方缓存后通过 `--prefer-offline` 完成；
没有改用未验证镜像、关闭完整性检查或修改用户全局配置。

- 完整工作区：**61 → 1** 条；高危 37 → 0、中危 17 → 1、低危 7 → 0。
  `pnpm audit --json --registry https://registry.npmjs.org` 仍退出 **1**，未宣称全绿。
- `--prod` 依赖类型范围：0 条，退出 0。此范围不等于所有打进 renderer 的依赖，
  例如 KaTeX 和 DOMPurify 虽声明为开发依赖，仍须通过完整审计覆盖。
- 剩余 [sprintf-js 中危告警](https://github.com/advisories/GHSA-hp3w-g68c-fv3c)：
  `electron-builder > app-builder-lib > @electron/get > global-agent > roarr > sprintf-js`。
  官方最新版仍为 1.1.3，尚无修复版本；没有抑制告警或强行跨主版本替换下载器/日志器。
- DOMPurify 3.4.17、KaTeX 0.18.2、Vue 3.5.44、Vitest 4.1.12、undici 6.29.1/7.30.1，
  以及 brace-expansion、js-yaml、fast-uri、xmldom、http-cache-semantics、source-map-js
  的安全更新已安装。SDK 0.86.1、Electron 43.6.0、TypeScript 和 OMP 固定保持。
  本轮只审计 npm 锁文件，未做 Rust/Bun 依赖审计。

更新后的 `pnpm build:js`、桌面 `typecheck`、lint、文档检查均退出 0。
构建保留既有 chunk 大小与 gitignore 语法高亮提示；安装保留既有 Vite override
导致的 peer 范围提示，未扩展到 Vite 主版本迁移。
KaTeX 固定为官方未弃用的 `0.18.2`，避免被弃用的 `0.18.11` 意外破坏兼容。
公式通过生产 Markdown 管线验证，并检查危险 URL、可信 HTML 和外部图片命令未启用。
不隐藏审计条目，不将没有修复版本的告警伪报为已解决。

## 扩展工作区回归的原生环境边界

安全依赖安装后首次递归测试退出 **1**：`pinned-runtime.test.ts` 向上找到本机
未构建的参考源码启动器，版本探针退出 1（unreadable version）。这是本轮仍未
通过的验证项，不能把整条递归命令标成通过。现有已安装资源声明 desktopVersion
0.1.0，不能冒充当前 0.1.1 bundle；没有改写 provenance 或放宽生产校验。

随后明确分开运行：

- `pnpm -r --filter '!@pi-desktop/desktop' --filter '!@pi-desktop/omp-runtime' --if-present test`
  退出 0，覆盖 agent-runtime、host-runtime、shared、agent-host、i18n、SDK/devkit、
  RACP、pi-host 与 docs。shared/SDK/devkit 的默认命令会发现源码及编译副本，
  **不加总或宣称这些执行次数都是独立测试**。
- OMP 包执行 `pnpm exec vitest run --exclude src/pinned-runtime.test.ts`：36 文件、
  549 项通过，6 项捆绑资源测试因未提供当前已验证资源跳过，0 失败，退出 0；
  原来失败的真实原生烟测显式排除，未隐藏为通过。
- 此后的九项缺陷审计仍为 12/12，agent-runtime 774、host-runtime 36、桌面 458
  均在更新依赖后通过。原生捆绑/完整 OMP 流程留待可用的当前资源包验证，
  本轮没有原生源码改动。

## 验证边界与交接

stable 未安装 rustfmt/clippy 组件，这两项没有在 stable 上通过的声明；已安装的
nightly 上 fmt 与严格 Clippy 均通过，未修改全局 Rust 默认版本或自动安装组件。

本轮结果属于未提交的源码候选及本地新宿主，不属于新安装包验收。真实 Electron
截图夹具使用既有官方 Electron 43.6.0，执行的是当前工作树的 BrowserHost/CDP。
未重新构建发布四目标、未做 Windows 双屏、未更新官方安装包；没有修改原生 OMP，
本轮不将先前已发布版本的两个原生流程记录冒充新候选结果。

规格已同步中英文 runtime、Edit/error、上下文组件、插件 MCP/CDP/安全及 E2E；
ADR 0193 和 D355 的当前占用公式相应校正。历史源码基线文件保持不变。

配套 [机器可读结果与源码指纹](Version-011-bug-fixes-20261019.json) 保存确切场景、命令状态及限制。
