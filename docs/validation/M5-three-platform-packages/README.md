# M5 三平台测试包：证据目录说明

对应记录：`docs/validation/M5-three-platform-packages.md`（本目录只放原始输出，结论与解读在该记录中）。

## 真实运行（Linux x64 本机，2026-10-03）

| 文件 | 内容 |
| --- | --- |
| `linux-dist-build.log` | 产品真实打包链 `pnpm run dist:linux` 的完整日志（exit 0，2m38s；`OMP-SIDECAR-PREFLIGHT built linux/x64`、AppImage/deb/rpm 构建行） |
| `linux-packaged-runtime.json` | 生产 `verify-packaged-runtime.mjs --json` 对**本次打包输出** `Resources` 的隔离副本（含空格/中文路径、自有 HOME/XDG/TMPDIR）的运行报告：omp/18.3.0、protocol v2、`get_state`、gate control refused、stopped/reaped/cleaned、无残留 run |
| `linux-plan-goal-regression.txt` | 包内 Plan/Goal 回归（`OMP_E2E_PACKAGED_RESOURCES` 指向同一隔离副本）的完整输出：15 passed / 0 failed / 0 skipped |
| `linux-build-record.json` | `stage-test-package.mjs` 对真实 Linux 产物生成的记录（pins、验收摘要、15-0-0、载荷 sha256、被排除的 `latest-linux.yml`） |
| `linux-package-metadata.txt` | 真实元数据：deb 控制字段/文件清单/安装后 desktop entry、rpm 元数据/文件清单、AppImage 内嵌 desktop entry、unpacked 可执行名与 `app-update.yml`、打包资源摘要与 provenance |

## 装配烟雾测试（**不是**发布证据）

| 文件 | 内容 |
| --- | --- |
| `assemble-smoke-release-notes.md`、`assemble-smoke-BUILD-RECORD.json`、`assemble-smoke-SHA256SUMS.txt` | `assemble-test-release.mjs` 的装配输出：Linux 平台记录来自上一节**真实**产物；macOS/Windows 两条记录与载荷是**合成夹具**（文件名带 `-fixture`），只用来验证"三平台齐全/摘要重算/自排除清单/notes 渲染"这条路径。**不构成 macOS 或 Windows 的平台证据**。 |

## 未在本目录（另见记录 §7）

macOS/Windows 原生构建与包内验收、签名/公证、安装器真实交互、Actions 首次真跑：全部待根创建受控 `m5-test-*` tag 后的 native CI。本目录不含任何 tag、Release 或 Actions 产物。
