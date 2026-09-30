# M6 / T21-A：真实打包资源验收（electron-builder unpacked）

本记录交付 M6/T21 的第一个可验证结果：**经产品真实的 `pack` 路径（含 sidecar 预检）产出
electron-builder 的 unpacked 应用，并对其中 `Resources/omp-runtime` 的 OMP 运行时完成机器可复用的
验收**——在仓库外含空格与中文的临时路径、子进程 PATH 只指向一个空目录、且启动环境带有
`NODE_PATH`/发现重定向变量/凭证的条件下，真实加载工具门、报告 `omp/18.3.0`、协商协议 v2、完成无
提供方 `get_state`，并正确停止与回收（进程组 reaped、run root cleaned、无残留 run 目录、诱饵目录零
写入）。T21 仍为**进行中**：本阶段**不是** macOS 安装包验收、**不是** GUI 启动、**不是** Windows
或其他架构证据。

- 工作树：`/home/vv/person/code/omp-desktop-m6-t21`，分支 `codex/m6-t21-packaged-runtime`，
  基线 `da75c653d119918e9426c75c50e73f73d3e49784`（M6/T20-R4-3 复审返修末次提交；不 amend /
  rebase / 强推）
- 环境：Linux x64（kernel `7.0.0-34-generic`）、Node v24.14.0、pnpm 10.34.5、**Bun 1.4.2**、
  cargo/rustc 1.95.0、Electron 43.6.0、electron-builder 26.15.3；本机**无** Xvfb / xvfb-run
  （GUI 启动不在本阶段范围）
- 受控 fork：`MisterBowie/oh-my-pi` @ `6226f805e92654344de04def413fa5cb91cb16b9`
  （tree `5249cb07059b009e890bece6f7d59daeb1cb94f6`，patch level `62bc57b+omp-desktop.3`）；
  构建源 `/home/vv/person/code/omp-fork-m6/oh-my-pi`，其源文件与 pins 本轮未改动
- 子模块固定 SHA：PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`、OMP
  `62bc57be1b03ef0802a33cf7f5f530e534527531`（本工作树已按这两个 SHA 初始化并在此基线上读取参考实现；
  `git submodule status` 无 `-`/`+` 前缀）
- 模型调用：**零**（验收链路只做版本探测、协议握手与 `get_state`；写入 run root 的模型目录指向
  `http://127.0.0.1:9` 的关闭端口且从未被使用）

---

## 1. 先核对真实实现（参考顺序 PI → OMP → 自行处理）

| 证据源 | 事实（本轮观察） | 对 T21-A 的含义 |
| --- | --- | --- |
| PI `upstream/pi-desktop` @ `0111e306` | 实测 `apps/desktop/package.json` 的 `pack` 链为 `build:deps && build:host-release && bundle:runtime && electron-vite build && electron-builder --dir`（`dist:mac/win/linux` 同形，仅改平台开关与 `--publish`）；`packages/agent-runtime/package.json` 的 `bundle` 用 esbuild 产出 `dist-bundle/sidecar.js`（`--platform=node --format=esm --define:PI_BUNDLED_NODE=true`）并链式写出 `{"type":"module"}`。`apps/desktop/test/agent-runtime-bundle-package.test.mjs` 文件头自述只断言 bundle 脚本契约与 extraResources 映射、**不运行完整 esbuild、更不启动产物**；`release-asar.test.mjs` 是 asar 修复的源码级断言；`packaging-footprint.test.mjs` 是配置契约；`scripts/e2e-electron-boot.mjs` 是 dev 启动。 | PI 侧没有"实际安装包内 OMP 运行时启动"的等价验收，不能把上述测试冒充 T21-A 证据。本轮复用 PI 的 **extraResources 目录拷贝**思路，但验证对象换成 OMP sidecar。 |
| OMP `upstream/oh-my-pi` @ `62bc57be` | `packages/coding-agent/scripts/build-binary.ts`（Bun 单文件编译，`--bytecode`/`--no-bytecode` 显式开关）、`packages/natives/scripts/embed-native.ts`（固定时间戳的原生插件归档）与 natives README 是产物来源；本项目的受控 fork 就在这两个文件上做了 patch-3 改动。 | 真实产物必须由该入口编译；本项目不另写编译器。 |
| 当前产品 | `app/scripts/omp-sidecar.mjs`（`--check`/`--build`/`--preflight`）产出二进制 + `provenance.json` + 工具门；`app/scripts/release-package.mjs` 是 `pack`/`dist*` 链尾唯一入口，把同一目标交给预检与 electron-builder；`packages/omp-runtime/src/bundled.ts` 的 `verifyBundledRuntime`/`resolveBundledGate` 是打包态唯一准入；`OmpRuntimeSupervisor` 负责启动、隔离、停止与回收；Electron 侧 `resolveRuntimeLauncher` + `resolveGateExtension` 在 `isPackaged` 下**只**接受 `resourcesPath/omp-runtime/...`。 | T21-A 的验收入口直接复用这些生产模块，不写第二套 provenance/隔离/回收实现。 |

---

## 2. 真实打包路径与产物（任务要求 1）

命令与退出码（原始小日志：`pack.log`、`inventory.txt`）：

```
cd app
OMP_SIDECAR_SOURCE=/home/vv/person/code/omp-fork-m6/oh-my-pi pnpm run pack
# exit 0，约 37 s（本机热缓存）
```

`pack` 链依次执行 `build:deps`（工作区 JS）→ `build:host-release`
（`cargo build --release --locked -p host-core`，单跑 exit 0，约 38 s）→ `bundle:runtime`
（`packages/agent-runtime/dist-bundle/sidecar.js`，esbuild）→ `electron-vite build` →
`release-package.mjs --dir`，后者先跑 sidecar 预检再跑 electron-builder：

```
OMP-SIDECAR-PREFLIGHT built linux/x64 in app/apps/desktop/resources/omp-runtime
  fork commit: 6226f805e92654344de04def413fa5cb91cb16b9
  sha256     : f69ee0b283691bf449e10734775995057cf7b89f4c68bfb077defaeaa7ffe02d
RELEASE-PACKAGE linux/x64: electron-builder --linux --x64 --dir --publish never
  • packaging       platform=linux arch=x64 electron=43.6.0 appOutDir=release/linux-unpacked
```

> 操作提示（记录以免复审重复踩坑）：`pnpm pack` 是 pnpm 的**内置命令**（等同于生成 tarball），
> 不会执行同名 package script；必须用 `pnpm run pack`。第一次误调用产出的
> `app/pi-desktop-desktop-0.15.2.tgz` 已删除，未进入任何证据。

产物（`app/apps/desktop/release/linux-unpacked`，598 MB）：

| 路径 | 观测 |
| --- | --- |
| `resources/omp-runtime/omp` | 283997664 B，sha256 `f69ee0b283691bf449e10734775995057cf7b89f4c68bfb077defaeaa7ffe02d`（与 R4-3 可复现构建一致） |
| `resources/omp-runtime/provenance.json` | schema `/3`、`patchLevel 62bc57b+omp-desktop.3`、`ompVersion 18.3.0`、`desktopVersion 0.15.2`、`platform linux`、`arch x64`、`build {bun 1.4.2, bytecode true}`、二进制与工具门摘要 |
| `resources/omp-runtime/extensions/omp-desktop-gate.js` | 9897 B，sha256 `89c2d84451e9b9403afc2169501bbb7a25c42eef607c9c8e88d6d71abed1963c` |
| `resources/bin/pi-desktop-host-core` | 存在（electron-builder `extraResources` 生效） |
| `resources/agent-runtime/sidecar.js` | 28a3dbdf…（Pi runtime bundle 生效） |
| `resources/{app.asar,models.dev,plugins,skills,tray-icon.png,app-update.yml}` | 均存在 |

打包资源与预检暂存目录 `app/apps/desktop/resources/omp-runtime` 的二进制/工具门摘要**逐位相同**，
说明 electron-builder 复制未改写产物。

## 3. 实际资源验收入口（新增；任务要求 2）

新增 `app/scripts/verify-packaged-runtime.mjs`（并在 `apps/desktop/package.json` 暴露
`verify:packaged-runtime`），**最小且复用生产实现**：

- 输入只有 `--resources <打包应用的 Resources 目录>`（即 `process.resourcesPath`）。它先做入口
  自己的输入契约检查（必须存在、是目录、含 `omp-runtime/`），这不是第二套校验；随后加载
  `packages/omp-runtime/dist/{bundled,supervisor}.js` —— 与 `omp-sidecar.mjs --preflight` 相同的
  "生产模块、缺构建即硬失败"约定。
- 校验阶段调用生产 `verifyBundledRuntime`（不自行读 digest），并从其返回的扩展列表取工具门
  （路径规范、摘要必须与清单一致）。
- 运行阶段用生产 `OmpRuntimeSupervisor`，参数链与桌面打包态一致：
  `args: ["--trusted-extension", <Resources>/omp-runtime/extensions/omp-desktop-gate.js]`、
  `pathEntries: [<空目录>]`；启动环境（脚本自身进程）刻意带有 `NODE_PATH`、`XDG_*`、
  `OMP_PROFILE`、`PI_DESKTOP_DATA_DIR` 与 `ANTHROPIC_API_KEY`，用于证明**继承**被隔离策略切断。
- 断言：`phase=idle`、`runtimeVersion=18.3.0`（pins 来源为 `@pi-desktop/shared`，不是清单自述）、
  `protocolVersion=2`、`get_state` 成功、诱饵目录零写入、`stop()` 的
  `stopped/reaped/cleaned` 全为真、无残留 `run-*`；在宿主可读处（Linux `/proc/<pid>/environ`）再
  直接断言子进程 `PATH` 等于那个空目录、`HOME` 在 run root 内，且 `NODE_PATH`、重定向变量与
  `ANTHROPIC_API_KEY` 均不在子进程环境中。
- 工具门加载的负对照：用同一监督器把 `--trusted-extension` 指向同目录下不存在的文件，启动**必须
  失败**（编译产物在该路径不可加载时以 exit 1 退出，见 §6），因此"带门启动成功"是"门确实被加载"
  的证据，而不是"参数被忽略"。
- `--verify-only` 只做校验（供篡改/错架构快速检查）；`--json` 输出机器可读报告。退出码：参数或输入
  契约问题 `2`，校验/启动/往返/回收失败 `1`；**从不校验隐式路径**，不给路径即非零退出。
- 它不是 GUI 启动：不启动 Electron 进程/窗口，不发 prompt，不接触 provider。

## 4. 真实验收执行（任务要求 3）

把 electron-builder 的整个 `resources/` 目录 `cp -a` 到仓库外、**含空格与中文**的路径后执行：

```
STAGE="/tmp/omp-t21 打包验收 空格/资源"
cp -a app/apps/desktop/release/linux-unpacked/resources "$STAGE"
node app/scripts/verify-packaged-runtime.mjs --resources "$STAGE" --json     # exit 0
```

证据：`acceptance-staged.txt`（同时保留 `acceptance-unpacked.txt`——直接对仓库内
`release/linux-unpacked/resources` 的同一条命令，也 exit 0）。关键字段：

| 验收点 | 结果 |
| --- | --- |
| 身份 | 运行二进制 = `$STAGE/omp-runtime/omp`；`runtimeVersion 18.3.0`；`protocolVersion 2`；无提供方 `get_state` 成功 |
| 工具门 | 路径与摘要来自清单校验：9897 B / `89c2d844…`；负对照按预期被拒（§6） |
| 子进程 PATH | `/tmp/omp-packaged-accept-*/empty-path`（唯一成员；父进程 PATH 未继承） |
| 子进程 HOME | `/tmp/omp-packaged-accept-*/data/omp-runtime/run-*/home`（run root 内，非用户 HOME） |
| 不继承 | `NODE_PATH`、`XDG_CONFIG_HOME`/`XDG_DATA_HOME`、`OMP_PROFILE`、`PI_DESKTOP_DATA_DIR`、`ANTHROPIC_API_KEY` 全部缺席（Linux `/proc` 直读） |
| 隔离副作用 | XDG/`PI_DESKTOP_DATA_DIR` 诱饵目录零写入；`OMP_PROFILE` 诱饵只剩预置 canary；`NODE_PATH` 诱饵零写入 |
| 停止/回收 | `stopped=true reaped=true cleaned=true`；残留 run 目录 0；验收自身的 accept root 在 finally 中删除 |
| 资源未被改写 | 验收（与随后的篡改回归）之后，暂存副本的 `omp`/工具门摘要仍为 `f69ee0b2…`/`89c2d844…` |

## 5. 拒绝回归（任务要求 4）

`app/apps/desktop/test/packaged-runtime-verify.test.mjs`（随 `node --test test/*.test.mjs` 常驻）：

- **常驻（无需真实产物）**：不给 `--resources`、未知参数、路径不存在、路径不是目录、目录不是
  electron-builder 输出——全部非零退出（`2`），且不打印 `PACKAGED-RUNTIME-OK`。未设
  `OMP_T21_RESOURCES` 时其余 6 条显式 skip，**skip 不是通过**；入口本身在没给路径时也绝不报成功。
- **opt-in（`OMP_T21_RESOURCES=<真实 Resources>`）**：

| 场景 | 结果 |
| --- | --- |
| 真实产物只校验 | exit 0，报告的身份与清单/字节一致 |
| 工具门内容被掉包（长度不变，翻转首字节） | exit 1：`extension … does not match the provenance manifest` |
| 二进制内容被篡改（真实副本，末字节翻转） | exit 1：`binary SHA-256 does not match the provenance manifest` |
| 二进制缺失 | exit 1：`missing the bundled omp` |
| 清单声明的平台/架构不是本机（伪造 `platform`/`arch`） | exit 1：`provenance platform is …, this host is …` / `provenance arch is …, this host is …` |
| 伪造 `patchLevel` / 旧 schema `/2` | exit 1：`provenance patch level is …, this build pins …` / `provenance schema is …, expected …` |

本轮实测：设 `OMP_T21_RESOURCES` 时 **8 tests / 8 pass / 0 fail / exit 0**（`regression.txt`）；
不设时 **2 pass / 6 skipped**。夹具只对二进制用硬链接（同文件系统）且篡改前先复制，从不写穿到
被测资源（§7.2 记录了修复前的一次真实 RED）。

## 6. 工具门确实被加载（负对照）

`gate-load-probe.txt`：对同一个打包二进制，用生产监督器分别以"不存在的 trusted extension"和
"清单里的真实工具门"启动：

```
missing: START_FAIL {"code":"not-started","message":"OMP runtime exited (code 1, signal null)",
         "detail":"… error: Trusted extension must be an existing module file: …/does-not-exist.js"}
real   : START_OK  {"phase":"idle","runtimeVersion":"18.3.0","protocolVersion":2, …}
         RECLAIM   [{"stopped":true,"reaped":true,"cleaned":true, …}]
```

即：该运行时对不可加载的 `--trusted-extension` **拒绝启动**，所以本阶段的成功启动只能是**真实
加载了已校验工具门**的结果。验收入口把这条负对照固化为运行的一部分（`gateLoadControl: refused`）。

## 7. 过程中的发现与返修（均只影响本轮新增的测试/操作，未改产品行为）

### 7.1 操作层：`pnpm pack` 是内置命令

见 §2 提示。误调用只产生一个 gitignore 命中的 tarball，已删除；正式证据全部来自 `pnpm run pack`。

### 7.2 测试夹具写穿硬链接（真实 RED → GREEN）

第一版 opt-in 回归把工具门**硬链接**进脚手架目录后直接 `writeFileSync` 翻转字节，实际改写了共享
inode，即**篡改了被测的暂存资源**。RED（随后运行的既有 vitest smoke，指向同一暂存目录）：

```
6 failed | 3 passed (9)    # verifyBundledRuntime 全部拒绝；掉包门用例 detail 为空
sha256(暂存工具门) 由 89c2d844… 变为 aac6dfaf…（打包产物本身未被触碰）
```

修复：夹具对**会被改写**的文件（工具门）用私有副本（几 KB），只对不写穿的大二进制保留硬链接，
并在注释中写明"改动二进制前必须先复制"。GREEN：同一 opt-in 回归 **8/8**，运行后暂存副本摘要不变，
既有 smoke 在同一暂存路径 **9/9**。这条 RED 也顺带证明：分层验收确实在读**真实产物**，而不是被
缓存或前一次结果掩盖。

### 7.3 验收脚本自身的 `extraEnv` 误用（RED → GREEN）

第一版入口经监督器 `extraEnv` **注入** `NODE_PATH`，然后断言子进程没有它——这在语义上测的是
"extraEnv 白名单"，而不是任务要求的"不继承"。RED：`PACKAGED-RUNTIME-FAIL the child inherited
NODE_PATH`（8.3 事实：`buildOmpRuntimeEnv` 只从启动环境白名单携带变量，`extraEnv` 是显式添加通道，
`NODE_PATH` 不在保留/凭据名单内，因此注入会生效）。修复：改为在**启动环境**（脚本进程）里设置
`NODE_PATH`/`XDG_*`/`OMP_PROFILE`/`PI_DESKTOP_DATA_DIR`/`ANTHROPIC_API_KEY` 并在 finally 恢复，
断言子进程全都不含；GREEN 如上表。产品代码未改：生产 `omp-session-wiring.ts` 的
`createSupervisor` 不传 `extraEnv`，隔离策略本身（只携带白名单、剥离 steering/代理/凭据）无缺口。

### 7.4 打包资源本身没有发现缺失/依赖/路径问题

真实 `pack` 一次通过：`omp-runtime`（二进制 + 清单 + 工具门）、`bin/pi-desktop-host-core`、
`agent-runtime`、`app.asar` 等全部到位，且打包副本与暂存副本摘要一致。因此本阶段**没有**触发
"缺失资源/依赖/路径"的最小修复路径（也就没有为此改动产品代码）。

## 8. 命令与计数

| 命令（cwd） | 结果 |
| --- | --- |
| `pnpm install --frozen-lockfile`（`app/`） | exit 0（808 包复用本地 store；Electron 43.6.0 取缓存） |
| `cargo build --release --locked -p host-core`（`app/`） | exit 0（约 38 s；`target/release/pi-desktop-host-core` bf21f8a8…） |
| `OMP_SIDECAR_SOURCE=… pnpm run pack`（`app/`） | exit 0（约 37 s；预检 built linux/x64；electron-builder `--linux --x64 --dir`） |
| `node app/scripts/verify-packaged-runtime.mjs --resources <unpacked resources>` | exit 0（`acceptance-unpacked.txt`） |
| `node app/scripts/verify-packaged-runtime.mjs --resources '<stage 空格/中文>'` | exit 0（`acceptance-staged.txt`） |
| `OMP_T21_RESOURCES='<stage>' node --test test/packaged-runtime-verify.test.mjs`（`app/apps/desktop`） | 8/8 pass、exit 0（`regression.txt`） |
| `node --test test/packaged-runtime-verify.test.mjs`（不设 opt-in） | 2 pass / 6 skipped、exit 0 |
| `OMP_SIDECAR_TEST_RESOURCES='<stage>' npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts`（`app/`） | 9 passed、exit 0（`bundled-smoke.txt`；含无 bun/node 的 `--version`、诱饵零写入、异常死亡/永不 ready 回收） |
| `node --test test/omp-runtime-launcher.test.mjs`（`app/apps/desktop`） | 12 pass / exit 0（打包态只从已校验的 `resourcesPath` 解析运行时与工具门、不读 `OMP_DESKTOP_RUNTIME`/不扫 app path/不查 `PATH` 的既有契约，本工作树在初始化固定子模块后实跑） |

未机械重跑：`apps/desktop` 全量、`@pi-desktop/omp-runtime` 全套、`apps/desktop` 全量 E2E——本阶段
改动面是**新增脚本 + 新增测试文件 + 规格文字**，未改生产运行时代码；相关既有套件（launcher 契约、
opt-in smoke）已按上述命令实跑。

## 9. 明确未做（不得用本记录替代的证据）

- **GUI / 实际安装包启动**：本机无 Xvfb/xvfb-run，本轮验收是无头运行时边界，不启动 Electron 窗口；
  安装包内打开项目、发消息、工具、停止、恢复属 T22/T24。
- **macOS arm64**：本机 Linux x64，未构建/未运行 dmg/zip，也未做代码签名/公证。
- **本地离线整个应用**：验收的运行时链路无网络（模型目录指向关闭端口、`get_state` 无提供方），但
  未验证"整机断网启动整个应用"。
- **Windows / 其他架构**：无实机；入口的 Windows 差异（二进制名 `omp.exe`、无 `/proc` 时子进程环境
  断言缺省）只由共享代码路径与既有测试覆盖，**不构成 Windows 支持证据**（T23）。
- **clean GitHub runner**：未在干净 runner 上跑 packaging workflow；本轮为本地热缓存构建。
- **R3 / T20-B/C/D**：未动摇。R3 仍是硬阻塞、ADR 0306 的 Cursor 产品门保留。

## 10. 状态

- **T21-A 完成**（本文档 + `app/scripts/verify-packaged-runtime.mjs` +
  `apps/desktop/test/packaged-runtime-verify.test.mjs` + spec §17 中英镜像 + 证据目录
  `docs/validation/M6-t21-packaged-runtime/`）。T21 本身仍为**进行中**：T21-B 及之后的
  macOS 安装产物、跨平台固定等仍待做；T22/T23/T24 未开始。
- 交接：`HANDOFF.md`、`docs/04-task-board.md` 已同步；下一阶段入口为 T22（品牌、更新源、许可证及
  macOS 安装产物）与 T21 剩余部分，等待本机独立复审。
