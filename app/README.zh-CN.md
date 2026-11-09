<div align="center">

<img src="docs/image/readme/logo.png" alt="OMP Desktop" width="88" />

# OMP Desktop 源码

[项目说明](../README.zh-CN.md) ·
[下载](https://github.com/MisterBowie/omp-desktop/releases/latest) ·
[文档](docs/zh-CN/spec/README.md) ·
[English](README.md)

</div>

本目录是 OMP Desktop 的源码。OMP Desktop 是 [Oh My Pi](https://github.com/can1357/oh-my-pi)（OMP）
编码智能体的桌面应用。功能、安装和数据处理见[项目说明](../README.zh-CN.md)。

> **当前版本线：0.1.x。**

## 架构

```text
渲染进程（React）→ Preload IPC → Electron 主进程 ─┬─ Rust host core（持久化、凭证、宿主工具）
                                                  └─ OMP 运行时（`omp --mode rpc-ui` 子进程）
```

- 智能体在内置的 OMP 运行时中执行，运行时是独立进程。桌面通过 OMP 的 RPC 协议驱动它，并把
  结构化事件映射到界面，不解析终端输出。
- 工具权限由加载到运行时中的受信扩展在工具执行前裁决。
- SQLite 只由 Rust host core 管理，渲染进程不直接访问。
- OMP 相关的差异集中在适配层：`packages/omp-runtime` 与 `apps/desktop/electron/main/runtime/`。

设计决策以 ADR 记录在 [`docs/adr`](docs/adr/README.md)，OMP 引擎相关的从
[0300](docs/adr/0300-engine-boundary.md) 开始。

## 目录

| 路径 | 内容 |
| --- | --- |
| `apps/desktop/` | Electron 应用：主进程、preload、React 渲染进程及 `node --test` 测试 |
| `crates/host-core/` | Rust 宿主：持久化、加密凭证和宿主工具（二进制 `pi-desktop-host-core`） |
| `packages/omp-runtime/` | OMP 运行时监管、RPC 适配、工具权限扩展和插件市场 |
| `packages/shared/` | IPC 与协议契约、错误码和应用内更新记录 |
| `packages/i18n/` | 八种语言的界面文案 |
| `packages/host-runtime/`、`packages/agent-host/`、`packages/racp/` | 传输、回合生命周期和远程控制协议 |
| `packages/plugin-sdk/`、`packages/plugin-devkit/` | 桌面插件 SDK 与命令行工具 |
| `apps/pi-host/`、`packages/agent-runtime/` | 从 PI-Desktop 保留的 Pi 引擎代码；OMP 会话不使用，也不单独发布 |
| `patches/oh-my-pi/` | 应用内置的受控 OMP fork 清单 |
| `docs/` | 规格、ADR 和指南（英文与简体中文） |
| `scripts/` | 构建、发布、验证和 E2E 脚本 |

内部包名沿用 PI-Desktop 的 `@pi-desktop/` 作用域。

## 开发

环境要求：

- Node.js 24（不低于 22.19）和 pnpm 10
- Rust stable
- 构建内置 OMP 运行时还需要：Bun 1.4 或更高版本、Rust `nightly-2026-08-12`，以及
  [MisterBowie/oh-my-pi](https://github.com/MisterBowie/oh-my-pi) 的检出，提交须与
  [`patches/oh-my-pi/manifest.json`](patches/oh-my-pi/manifest.json) 一致

```bash
pnpm install
pnpm build:js
cargo build -p host-core --locked
```

### 运行

```bash
pnpm dev
```

开发版使用独立的数据目录（`~/.omp-desktop-dev`），可以与已安装的应用同时运行。OMP 会话需要
运行时：可通过 `OMP_DESKTOP_RUNTIME` 指定 `omp` 可执行文件，或由应用在固定的
`upstream/oh-my-pi` 参考检出中查找启动器。macOS 开发版是位于 `.cache/electron-dev/` 下的改名
Electron 应用包，与正式包一样只接受其 `Contents/Resources/omp-runtime/` 中经过校验的运行时。
用 `OMP_SIDECAR_SOURCE=/path/to/oh-my-pi node scripts/omp-sidecar.mjs --build` 构建运行时
（输出到 `apps/desktop/resources/omp-runtime/`），再把该目录复制到应用包中
（[ADR 0307](docs/adr/0307-bundled-omp-sidecar.md)）。

### 测试

```bash
pnpm typecheck
pnpm lint
pnpm test          # 先测 JS 包，再运行 cargo test -p host-core
```

自动化测试使用本机假服务商，不调用付费模型。E2E 场景见
[E2E 测试计划](docs/zh-CN/spec/06-delivery/04-e2e-test-plan.md)。

### 打包

```bash
OMP_SIDECAR_SOURCE=/path/to/oh-my-pi pnpm --filter @pi-desktop/desktop run dist:mac   # 或 dist:win、dist:linux
```

本地包未签名，输出到 `apps/desktop/release/`。OMP 检出与清单不一致时，打包会拒绝执行。

### 发布

正式版本由仓库根目录的 GitHub Actions（[`release.yml`](../.github/workflows/release.yml)）构建。
推送 `release-check-<版本>-*` 标签会在所有平台构建并验证候选；随后用
`publish-v<版本>-run-<编号>` 标签发布该候选的原始制品，不重新构建。用
`node scripts/release.mjs <版本>` 更新所有版本号，用 `node scripts/check-release-docs.mjs <版本>`
核对更新记录。完整流程见[发布手册](docs/zh-CN/spec/06-delivery/06-release-runbook.md)。

## 文档

[规格](docs/zh-CN/spec/README.md) ·
[架构](docs/zh-CN/spec/02-architecture/01-architecture.md) ·
[ADR](docs/adr/README.md) ·
[E2E 测试计划](docs/zh-CN/spec/06-delivery/04-e2e-test-plan.md) ·
[发布手册](docs/zh-CN/spec/06-delivery/06-release-runbook.md) ·
[插件开发](docs/zh-CN/plugin-development.md) ·
[贡献指南](CONTRIBUTING.md) ·
[安全](SECURITY.md) ·
[智能体约定](AGENTS.md)

## 许可证

采用 [GNU LGPL v3.0](LICENSE) 许可证。本代码源自 [PI-Desktop](https://github.com/vastsa/PI-Desktop)，
保留其版权声明。内置的 OMP 运行时采用 [MIT 许可证](https://github.com/can1357/oh-my-pi/blob/main/LICENSE)。
