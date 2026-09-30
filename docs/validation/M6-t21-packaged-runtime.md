# M6 / T21-A：真实打包资源验收（electron-builder unpacked）

本记录交付 M6/T21 的第一个可验证结果：**经产品真实的 `pack` 路径（含 sidecar 预检）产出
electron-builder 的 unpacked 应用，并对其中 `Resources/omp-runtime` 的 OMP 运行时完成机器可复用的
验收**——在仓库外含空格与中文的临时路径、子进程 PATH 只指向一个空目录、且启动环境带有
`NODE_PATH`/发现重定向变量/凭证的条件下，真实加载工具门、报告 `omp/18.3.0`、协商协议 v2、完成无
提供方 `get_state`，并正确停止与回收（进程组 reaped、run root cleaned、无残留 run 目录、诱饵目录零
写入）。T21 仍为**进行中**：本阶段**不是** macOS 安装包验收、**不是** GUI 启动、**不是** Windows
或其他架构证据。

> 2026-10-01 独立复审返修（本记录 §11）：四项发现已修复并重跑——工具门负对照此前会接受任意启动
> 失败、验收清理会吞掉回收失败并删除所有权记录、§1/§2 文档混写参考实现与真实命令、证据链接指向未
> 提交文件。修复只触及验收入口、其回归测试、spec 文字与本记录/证据；产品运行时与权限路径未改。

> 2026-10-01 最后一轮独立复审返修（本记录 §12、§13）：①gate 负对照的匹配仍是子串匹配，
> `<缺失路径>.another-file` 这样的同名前缀**不同**文件会被误接收；现要求在该路径自身的边界上精确
> 点名，并新增同名前缀拒绝回归（RED → GREEN）；②`git diff --check` 在 `bec20b21..6ee99ecb` 上确实
> 失败（RED 记录 4 行、回退补丁 2 行尾空格），现按"原始字节确定性 gzip + 归一化显示副本"归档，
> 补丁只保留可应用的 `.diff.gz`；③复审侧 macOS arm64 实测证据按原始字节归档到 `mac-review/`（§13，
> 属复审机实测，不是本工作区的结论）。同样只改验收入口、其回归、spec 文字与证据。

- 工作树：`/home/vv/person/code/omp-desktop-m6-t21`，分支 `codex/m6-t21-packaged-runtime`，
  基线 `da75c653d119918e9426c75c50e73f73d3e49784`（M6/T20-R4-3 复审返修末次提交；T21-A 首稿
  `bec20b214bee792b656d85aab5469e459b96eccc`，本轮复审返修在其后追加提交，不 amend / rebase /
  强推）
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
| PI `upstream/pi-desktop` @ `0111e306` | 实测 `apps/desktop/package.json` 的 `pack` 链为 `build:deps && build:host-release && bundle:runtime && electron-vite build && electron-builder --dir`（`dist:mac/win/linux` 同形，仅改平台开关与 `--publish`）；`packages/agent-runtime/package.json` 的 `bundle` 用 esbuild 产出 `dist-bundle/sidecar.js`（`--platform=node --format=esm --define:PI_BUNDLED_NODE=true`）并链式写出 `{"type":"module"}`。`apps/desktop/test/agent-runtime-bundle-package.test.mjs` 文件头自述只断言 bundle 脚本契约与 extraResources 映射、**不运行完整 esbuild、更不启动产物**；`release-asar.test.mjs` 用临时夹具对 `scripts/export-linux-asar.mjs` 的 `exportLinuxAsar` 做行为测试（导出 Linux 的 `app.asar` 资产、缺文件时报错）——它既不是 asar 修复的源码级断言，也不运行打包产物；`packaging-footprint.test.mjs` 是配置契约；`scripts/e2e-electron-boot.mjs` 是 dev 启动。 | PI 侧没有"实际安装包内 OMP 运行时启动"的等价验收，不能把上述测试冒充 T21-A 证据。本轮复用 PI 的 **extraResources 目录拷贝**思路，但验证对象换成 OMP sidecar。 |
| OMP `upstream/oh-my-pi` @ `62bc57be` | `packages/coding-agent/scripts/build-binary.ts` 是上游的 Bun 单文件编译入口，`compile-binary.ts` 在该提交**硬编码** `bytecode: true`（没有命令行开关）；`packages/natives/scripts/embed-native.ts` 在该提交生成内嵌原生插件归档，但**不固定时间戳**。 | 真实产物必须由该入口编译；本项目不另写编译器。上游本身不提供本阶段所需的可复现性开关。 |
| 受控 fork `MisterBowie/oh-my-pi` @ `6226f805`（patch-3） | 在 `build-binary.ts` 增加严格的 `--bytecode`/`--no-bytecode` 解析（未知/重复开关打印 `OMP-BUILD-ARGS` 并 exit 2），`compile-binary.ts` 增加 `bytecode` 选项（默认仍为上游的 `true`）；`embed-native.ts` 新增 `buildAddonArchive()`（固定每个 ustar 头的 mtime 并重算校验和）。sidecar 显式传 `--bytecode`，并把模式写入 provenance 的 `build.bytecode`。 | 本阶段的可复现字节与 `build.bytecode` 记录都来自 fork 的 patch-3，**不能归因给上游 `62bc57be`**。 |
| 当前产品 | `app/scripts/omp-sidecar.mjs`（`--check`/`--build`/`--preflight`）产出二进制 + `provenance.json` + 工具门；`app/scripts/release-package.mjs` 是 `pack`/`dist*` 链尾唯一入口，把同一目标交给预检与 electron-builder；`packages/omp-runtime/src/bundled.ts` 的 `verifyBundledRuntime`/`resolveBundledGate` 是打包态唯一准入；`OmpRuntimeSupervisor` 负责启动、隔离、停止与回收；Electron 侧 `resolveRuntimeLauncher` + `resolveGateExtension` 在 `isPackaged` 下**只**接受 `resourcesPath/omp-runtime/...`。 | T21-A 的验收入口直接复用这些生产模块，不写第二套 provenance/隔离/回收实现。 |

---

## 2. 真实打包路径与产物（任务要求 1）

命令与退出码（原始小日志：`pack.txt`、`inventory.txt`；`pack.txt` 是该次运行的 stdout 实录，转录止于
electron-builder 的 `searching for node modules` 阶段，产物完整性与摘要以 `inventory.txt` 为准）：

```
cd app
OMP_SIDECAR_SOURCE=/home/vv/person/code/omp-fork-m6/oh-my-pi pnpm run pack
# exit 0，约 37 s（本机热缓存）
```

`pack` 链依次执行 `build:deps`（工作区 JS）→ `build:host-release`
（该 package script 原样为 `cargo build --release --manifest-path ../../Cargo.toml -p host-core`，
**不含** `--locked`；`pack.txt` 显示它复用了此前单独构建的缓存，`Finished ... in 0.03s`）→
`bundle:runtime`（`packages/agent-runtime/dist-bundle/sidecar.js`，esbuild）→ `electron-vite build` →
`release-package.mjs --dir`，后者先跑 sidecar 预检再跑 electron-builder。**锁文件校验不在 pack 链内**：
它是链外单独命令 `cargo build --release --locked -p host-core`（2026-10-01 复审返修时重跑 exit 0，
产物 sha256 与 `inventory.txt` 一致，见 `cargo-locked.txt`）：

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
- 工具门加载的负对照：用同一监督器把 `--trusted-extension` 指向同目录下不存在的文件，启动**必须以该
  missing gate 被拒**——失败必须带有运行时自己的 `Trusted extension must be an existing module
  file: <该缺失路径>`（失败对象的 `detail` 字段，见 §6）；超时、启动器/原生加载失败、命名了别的
  路径的拒绝、或竟然启动成功，都令入口以 exit 1 失败并报告观察到的原因。因此"带门启动成功"是
  "门确实被加载"的证据，而不是"参数被忽略"或"恰好启动失败"。
- 回收被检查而不是假定：`stop()` 与 gate 控制运行的 `reclaimAll()` 的结果和异常全部检查；只有进程组
  reaped、run root 已删除后才会删除验收根目录。未能回收的 run 保留其目录与 supervisor 的所有权记录
  （`runRoot`/pid/pgid），入口报告保留位置并以非零退出，不写第二套 kill 逻辑。启动环境
  （`NODE_PATH`、XDG、`OMP_PROFILE`、`PI_DESKTOP_DATA_DIR`、`ANTHROPIC_API_KEY`）在任何退出路径
  （含验收失败、回收失败、根目录删除失败）都会被恢复。
- `--verify-only` 只做校验（供篡改/错架构快速检查）；`--json` 输出机器可读报告。退出码：参数或输入
  契约问题 `2`，校验/启动/往返/工具门控制/回收失败 `1`；**从不校验隐式路径**，不给路径即非零退出。
  未回收干净的 run 绝不报成功。
- 它不是 GUI 启动：不启动 Electron 进程/窗口，不发 prompt，不接触 provider。

## 4. 真实验收执行（任务要求 3）

把 electron-builder 的整个 `resources/` 目录 `cp -a` 到仓库外、**含空格与中文**的路径后执行：

```
STAGE="/tmp/omp-t21 打包验收 空格/资源"
cp -a app/apps/desktop/release/linux-unpacked/resources "$STAGE"
node app/scripts/verify-packaged-runtime.mjs --resources "$STAGE" --json     # exit 0
```

证据：`acceptance-staged.txt` 与 `acceptance-unpacked.txt`（首轮），以及复审返修后的重跑
`acceptance-staged-repair.txt`、`acceptance-unpacked-repair.txt`（同样的命令与判定，走新的严格
gate 控制与受检回收路径，均 exit 0）。关键字段（首轮与重跑一致）：

| 验收点 | 结果 |
| --- | --- |
| 身份 | 运行二进制 = `$STAGE/omp-runtime/omp`；`runtimeVersion 18.3.0`；`protocolVersion 2`；无提供方 `get_state` 成功 |
| 工具门 | 路径与摘要来自清单校验：9897 B / `89c2d844…`；负对照以该 missing gate 被拒（§6） |
| 子进程 PATH | `/tmp/omp-packaged-accept-*/empty-path`（唯一成员；父进程 PATH 未继承） |
| 子进程 HOME | `/tmp/omp-packaged-accept-*/data/omp-runtime/run-*/home`（run root 内，非用户 HOME） |
| 不继承 | `NODE_PATH`、`XDG_CONFIG_HOME`/`XDG_DATA_HOME`、`OMP_PROFILE`、`PI_DESKTOP_DATA_DIR`、`ANTHROPIC_API_KEY` 全部缺席（Linux `/proc` 直读） |
| 隔离副作用 | XDG/`PI_DESKTOP_DATA_DIR` 诱饵目录零写入；`OMP_PROFILE` 诱饵只剩预置 canary；`NODE_PATH` 诱饵零写入 |
| 停止/回收 | `stopped=true reaped=true cleaned=true`；残留 run 目录 0；验收自身的 accept root 仅在回收干净后删除（两次返修重跑后 `/tmp/omp-packaged-accept-*` 残留为 0） |
| 资源未被改写 | 验收（与随后的篡改回归）之后，暂存副本的 `omp`/工具门摘要仍为 `f69ee0b2…`/`89c2d844…` |

## 5. 拒绝回归（任务要求 4）

`app/apps/desktop/test/packaged-runtime-verify.test.mjs`（随 `node --test test/*.test.mjs` 常驻）：

- **常驻（无需真实产物，7 条）**：不给 `--resources`、未知参数、路径不存在、路径不是目录、目录不是
  electron-builder 输出——全部非零退出（`2`），且不打印 `PACKAGED-RUNTIME-OK`；另有 5 条经注入的
  supervisor 双（class seam）驱动失败路径：gate 负对照**只**接受在**该路径自身边界上**精确点名该缺失
  路径的真实拒绝（同名前缀的 `<缺失路径>.another-file`、命名别的文件、ready 超时、竟然启动成功都被
  拒），gate 控制运行回收失败会上报所有权，回收不完整或抛异常时
  验收根不被删除，只有回收干净才删除，较早步骤保留的所有权会扣住根目录。未设 `OMP_T21_RESOURCES`
  时其余 8 条显式 skip，**skip 不是通过**；入口本身在没给路径时也绝不报成功。
- **opt-in（`OMP_T21_RESOURCES=<真实 Resources>`，15 条）**：

| 场景 | 结果 |
| --- | --- |
| 真实产物只校验 | exit 0，报告的身份与清单/字节一致 |
| 工具门内容被掉包（长度不变，翻转首字节） | exit 1：`extension … does not match the provenance manifest` |
| 二进制内容被篡改（真实副本，末字节翻转） | exit 1：`binary SHA-256 does not match the provenance manifest` |
| 二进制缺失 | exit 1：`missing the bundled omp` |
| 清单声明的平台/架构不是本机（伪造 `platform`/`arch`） | exit 1：`provenance platform is …, this host is …` / `provenance arch is …, this host is …` |
| 伪造 `patchLevel` / 旧 schema `/2` | exit 1：`provenance patch level is …, this build pins …` / `provenance schema is …, expected …` |
| 运行未开始 + 回收不完整（注入 supervisor） | 验收失败、报告 `retained at <accept root>` 与该 run 的所有权；根目录**保留**；6 个启动环境变量全部恢复原值 |
| 运行未开始 + 回收干净（注入 supervisor） | 验收失败（不返回 OK），回收干净后临时根被删除；环境同样恢复 |

本轮实测（最后一轮复审返修后）：设 `OMP_T21_RESOURCES` 时 **15 tests / 15 pass / 0 fail / exit 0**
（`regression-repair2.txt`）；不设时 **7 pass / 8 skipped**（`regression-repair2-always-on.txt`）；
首轮返修时的对应证据为 `regression-repair.txt` / `regression-repair-always-on.txt`。同名前缀负例
（`<缺失路径>.another-file`）在修复前被误接收：修复前该套件 **1 failed / 6 passed / 8 skipped**、
exit 1（`repair-red-gate-path/regression-red.txt`，原始字节见同名 `.txt.gz`）。
夹具只对二进制用硬链接（同文件系统）且篡改前先复制，从不写穿到被测资源（§7.2 记录了修复前的一次
真实 RED）。注入的 supervisor 双只在测试中替换 class，验收自身的生产路径不变。

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
加载了已校验工具门**的结果。验收入口把这条负对照固化为运行的一部分（`gateLoadControl: refused`），
且要求精确匹配：失败的 `detail`（运行时 stderr 尾部，`errors.ts` 的 `OmpRuntimeError.detail`）中必须
有一行以 `Trusted extension must be an existing module file: <本次缺失的绝对路径>` **在该路径自身的
边界上结束**——同名前缀的 `<缺失路径>.another-file` 是另一个文件，不算点名该门（§12.1）；任何其他
启动失败（超时、启动器缺失、原生加载失败、以别的路径被拒）都让入口以 exit 1 失败并打印观察到的
原因，绝不把"启动失败"本身当作门被加载的证据（§11.1）。

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
| `cargo build --release --locked -p host-core`（`app/`；**链外单独命令**，2026-10-01 返修重跑） | exit 0（`cargo-locked.txt`；`target/release/pi-desktop-host-core` sha256 bf21f8a8… 与 `inventory.txt` 一致） |
| `OMP_SIDECAR_SOURCE=… pnpm run pack`（`app/`） | exit 0（约 37 s；预检 built linux/x64；electron-builder `--linux --x64 --dir`；链内 `build:host-release` 不含 `--locked`，见 `pack.txt`） |
| `node app/scripts/verify-packaged-runtime.mjs --resources <unpacked resources>` | exit 0（`acceptance-unpacked.txt`；返修后重跑 `acceptance-unpacked-repair.txt`，最后一轮返修后重跑 `acceptance-unpacked-repair2.txt` — 三者均 exit 0） |
| `node app/scripts/verify-packaged-runtime.mjs --resources '<stage 空格/中文>'` | exit 0（`acceptance-staged.txt`；返修后重跑 `acceptance-staged-repair.txt`，最后一轮返修后重跑 `acceptance-staged-repair2.txt` — 三者均 exit 0） |
| `OMP_T21_RESOURCES=<真实 resources> node --test test/packaged-runtime-verify.test.mjs`（`app/apps/desktop`） | **15/15 pass**、exit 0（最后一轮返修后 `regression-repair2.txt`；首轮返修后 `regression-repair.txt`；返修前 8/8 见 `regression.txt`） |
| `node --test test/packaged-runtime-verify.test.mjs`（不设 opt-in） | **7 pass / 8 skipped**、exit 0（最后一轮返修后 `regression-repair2-always-on.txt`；首轮返修后 `regression-repair-always-on.txt`；返修前 2 pass / 6 skipped） |
| RED 回归（第一轮返修的语义回退夹具，`repair-red/`） | **4 failed / 3 passed / 8 skipped**、exit 1（原始输出 `repair-red/regression-red.txt.gz`，可读副本 `regression-red.txt`；回退补丁 `repair-red/semantic-revert.diff.gz`，`git apply --check -p0` exit 0） |
| RED 回归（最后一轮返修：同名前缀不同路径，`repair-red-gate-path/`） | **1 failed / 6 passed / 8 skipped**、exit 1（原始输出 `repair-red-gate-path/regression-red.txt.gz`，可读副本 `regression-red.txt`） |
| `OMP_SIDECAR_TEST_RESOURCES='<stage>' npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts`（`app/`） | 9 passed、exit 0（`bundled-smoke.txt`；含无 bun/node 的 `--version`、诱饵零写入、异常死亡/永不 ready 回收） |
| `node --test test/omp-runtime-launcher.test.mjs`（`app/apps/desktop`） | 12 pass / exit 0（打包态只从已校验的 `resourcesPath` 解析运行时与工具门、不读 `OMP_DESKTOP_RUNTIME`/不扫 app path/不查 `PATH` 的既有契约，本工作树在初始化固定子模块后实跑） |

未机械重跑：`apps/desktop` 全量、`@pi-desktop/omp-runtime` 全套、`apps/desktop` 全量 E2E——本阶段
改动面是**新增脚本 + 新增测试文件 + 规格文字 + 本轮复审返修**（只改验收入口、其回归、spec 与本
记录），未改生产运行时代码；相关既有套件（launcher 契约、opt-in smoke）已按上述命令实跑。

## 9. 明确未做（不得用本记录替代的证据）

- **GUI / 实际安装包启动**：本机无 Xvfb/xvfb-run，本轮验收是无头运行时边界，不启动 Electron 窗口；
  安装包内打开项目、发消息、工具、停止、恢复属 T22/T24。
- **macOS arm64**：本机 Linux x64，**未**构建/未运行 dmg/zip，也未做代码签名/公证；独立复审侧在
  macOS arm64 实机上的 unsigned/unpacked `pack` 与原生 `.app` 启动证据已按原始字节归档于
  `mac-review/`（§13），但那是复审机实测，**不是**本工作区的构建结果、也不构成本阶段对 macOS 的
  支持声明（T22/T23）。
- **本地离线整个应用**：验收的运行时链路无网络（模型目录指向关闭端口、`get_state` 无提供方），但
  未验证"整机断网启动整个应用"。
- **Windows / 其他架构**：无实机；入口的 Windows 差异（二进制名 `omp.exe`、无 `/proc` 时子进程环境
  断言缺省）只由共享代码路径与既有测试覆盖，**不构成 Windows 支持证据**（T23）。
- **clean GitHub runner**：未在干净 runner 上跑 packaging workflow；本轮为本地热缓存构建。
- **R3 / T20-B/C/D**：未动摇。R3 仍是硬阻塞、ADR 0306 的 Cursor 产品门保留。

## 10. 状态

- **T21-A 完成，并已按 2026-10-01 两轮独立复审返修**（本文档 + `app/scripts/verify-packaged-runtime.mjs`
  + `apps/desktop/test/packaged-runtime-verify.test.mjs` + spec §17 中英镜像 + 证据目录
  `docs/validation/M6-t21-packaged-runtime/`，含 `repair-red/`、`repair-red-gate-path/`、
  `mac-review/`）。T21 本身仍为**进行中**：T21-B
  及之后的 macOS 安装产物、跨平台固定等仍待做；T22/T23/T24 未开始。
- 交接：`HANDOFF.md`、`docs/04-task-board.md` 已同步；下一阶段入口为 T22（品牌、更新源、许可证及
  macOS 安装产物）与 T21 剩余部分，等待本机独立复审。

## 11. 2026-10-01 独立复审返修（四项）

四项发现全部只影响**验收入口、其回归、spec 文字与本记录/证据**；产品运行时（`packages/omp-runtime`、
Electron 侧、RPC/权限路径）未改，fork、pins、打包配置保持。

### 11.1 工具门负对照此前会接受任意启动失败

- **发现**：`expectGateRefusal` 旧实现 `catch { refused = true }`，把超时、native 加载失败、启动器
  失败都当作"门确实被拒"，于是负对照可以在与 gate 无关的失败上"通过"。
- **修复**：失败必须来自该 missing gate——`detail`（运行时 stderr 尾部）中必须包含
  `Trusted extension must be an existing module file: <本次缺失的绝对路径>`；命名别的路径的拒绝、
  超时等其他失败、乃至竟然启动成功，都让入口以 exit 1 失败并打印观察到的 `code`/`message`/`detail`
  摘要。gate 控制运行本身也纳入受检回收（§11.2）。
- **RED/GREEN**：新增回归用 class 参数 seam 注入 supervisor 双（真实错误形状与真实缺失路径）。
  在语义回退夹具上 `the gate control accepts only the refusal that names the missing gate` 因
  "Missing expected rejection" 失败（另有 3 条清理相关用例失败，共 4 failed / 3 passed / 8 skipped，
  `repair-red/regression-red.txt.gz`，可读副本 `repair-red/regression-red.txt`；回退补丁
  `repair-red/semantic-revert.diff.gz`）；修复后同一套件
  opt-in **15/15**，真实 Linux 产物（unpacked 与含空格/中文暂存路径）两次运行均 exit 0 且
  `gateLoadControl: refused`（`acceptance-*-repair.txt`）。该轮修复仍是子串匹配，因而还会接受
  同名前缀的不同路径（`<缺失路径>.another-file`）——该缺口已由最后一轮返修补齐（§12.1）。

### 11.2 验收清理失败被吞掉并删除所有权记录

- **发现**：两处 `reclaimAll().catch(() => undefined)` 忽略回收失败，外层 finally 无条件
  `rmSync(acceptRoot)`——即使有 run 未回收也会删掉验收根，且导出函数在异常/删除失败时可能留下被
  临时覆盖的 `process.env`。
- **修复**：新增 `releaseAcceptanceRoot()`：检查 `reclaimAll()` 的结果与异常（`stopped`/`reaped`/
  `cleaned` 三者齐全才算干净，复用 supervisor 协议，不写第二套 kill 逻辑）；未回收干净的 run 保留
  其 run root 与 supervisor 所有权记录（`pendingCleanup` 的 runRoot/pid/pgid），入口报告保留位置并
  非零退出；只有回收干净才删除验收根。gate 控制运行保留的所有权经错误的 `acceptanceRetention`
  传给外层，同样扣住验收根。启动环境在验收失败、回收失败、删除失败等所有路径上恢复。
- **RED/GREEN**：`the acceptance root survives a reclamation that cannot complete`、
  `an ownership held by an earlier step withholds the acceptance root` 与 gate 控制保留用例在语义
  回退夹具上失败（同上 RED 日志）；修复后用 supervisor 双 + 真实产物验证：`retained at` 报告含具体
  run 路径、目录保留、6 个环境变量恢复；回收干净时目录删除且验收仍以非零退出（不返回 OK）。真实
  Linux 产物两次重跑 `stopped=true reaped=true cleaned=true`、残留 run 目录 0、`/tmp/omp-packaged-
  accept-*` 残留 0。

### 11.3 文档把参考实现和真实命令写混

- §1 的 OMP 行已拆分：上游 `62bc57be` 只有 Bun 单文件编译与 `compile-binary.ts` 中硬编码
  `bytecode: true`、以及不固定时间戳的归档生成；命令行 `--bytecode`/`--no-bytecode` 开关、固定
  mtime 并重算校验和的 `buildAddonArchive()` 与 provenance 的 `build.bytecode` 均归因给受控 fork
  `6226f805`（patch-3）。
- PI 行已修正：`release-asar.test.mjs` 是临时夹具中对 `exportLinuxAsar` 的行为测试，不是 asar 修复
  的源码级断言，也不运行打包产物。
- §2/§8 已区分两条命令：`pack` 链内的 `build:host-release` 原样为
  `cargo build --release --manifest-path ../../Cargo.toml -p host-core`（不含 `--locked`，`pack.txt`
  显示复用了缓存）；`--locked` 是链外单独执行的 `cargo build --release --locked -p host-core`
  （2026-10-01 重跑 exit 0，`cargo-locked.txt`），不写成链内已保证锁文件。

### 11.4 证据链接指向未提交文件

- `pack.log` 从未被 git 跟踪（根 `.gitignore` 的 `*.log`），文档却引用它。已保留脱敏后的原始输出为
  `pack.txt`（真实 stdout 实录、未手写、未篡改），并修正 §2/HANDOFF 的引用；新增证据
  `cargo-locked.txt`、`regression-repair*.txt`、`acceptance-*-repair.txt`、`repair-red/`。本记录
  引用的全部证据文件均已随本提交进入 git（`git ls-files docs/validation/M6-t21-packaged-runtime/`
  可核对）。`pack.txt` 的转录止于 electron-builder `searching for node modules` 阶段，完成判定以
  exit 0 与 `inventory.txt` 的产物摘要为准（未重新打包，不伪造缺失日志）。第一轮返修的 RED 证据在
  最后一轮被重新归档：原始字节改为确定性 gzip（`repair-red/*.gz`），可读副本只做行尾空白归一化
  （§12.2）。

## 12. 2026-10-01 最后一轮独立复审返修（两项）

两项发现同样只影响验收入口、其回归、spec 文字与证据；产品运行时（`packages/omp-runtime`、Electron
侧、RPC/权限路径）、fork、pins、打包配置未改。

### 12.1 gate 负对照把"点名"当作子串匹配

- **发现**：`expectGateRefusal` 用 `detail.includes("<refusal>: <缺失路径>")` 判定，因此
  `error: Trusted extension must be an existing module file: <缺失路径>.another-file` 也会被接收——
  它命名的是**另一个文件**，与本次 `--trusted-extension` 无关。用 supervisor class seam 已在本机
  复现该误接收。
- **修复**：新增 `namesMissingGate()`（与 `expectGateRefusal` 同文件）：把 `detail` 按行切分，只
  接受某一行在 `Trusted extension must be an existing module file: ` 之后**恰好以该缺失路径结束**
  （允许行尾 `\r`）；字面比较、不用正则，路径元字符不会把匹配放宽为前缀搜索。真实错误格式（运行时
  stderr 尾部）正是单行 `… file: <path>` 加随后的堆栈，因此"行内剩余部分 == 该路径"就是完整边界。
- **RED/GREEN**：在已有 gate-control 用例中新增同名前缀断言（`${missing}.another-file` 也必须被
  拒）。修复前该套件 **1 failed / 6 passed / 8 skipped**、exit 1，失败即新断言
  `AssertionError: Missing expected rejection`（RED harness 用 HEAD `6ee99ecb` 的入口原样 + 带新断言
  的测试文件；原始输出 `repair-red-gate-path/regression-red.txt.gz`，可读副本 `regression-red.txt`，
  复现与摘要见该目录 `README.md`）。修复后：常驻 **7 pass / 8 skipped**、opt-in（真实 Resources）
  **15/15**，两个真实 Linux 资源树（unpacked 与含空格/中文暂存路径）重跑均 exit 0 且
  `gateLoadControl: refused`（`regression-repair2*.txt`、`acceptance-*-repair2.txt`，字段见 §8）。

### 12.2 提交内容的 `--check` 证据必须来自提交本身

- **发现（本机复核的 RED）**：`git diff bec20b214bee792b656d85aab5469e459b96eccc HEAD --check`
  实际 **exit 2**：`repair-red/regression-red.txt` 4 行、`repair-red/semantic-revert.diff` 2 行尾随
  空白。上一轮只在提交后的 clean 工作树跑 `git diff --check`，那只比较工作树与索引/HEAD 的差异，
  **不能**证明已提交内容通过。
- **修复（保留原始字节，不用归一化副本替代证据）**：两份原始捕获改存为确定性 gzip（`gzip -n -9`：
  不带原始文件名、`mtime` 0；同一输入两次压缩逐字节相同，已用 `cmp` 复核）——
  `repair-red/regression-red.txt.gz` 与 `repair-red/semantic-revert.diff.gz`。解压后 SHA-256 分别为
  `4360e51441053788e58ce1d7f43f342b8456e91565630cbf2c3b6fbf305f814a` 与
  `0516a82c4f54fab1fc5962011f334971dd6d5d5c52a08df280d193d29296c1c1`，与它们在 `6ee99ecb` 的
  Git blob 逐字节一致（`gunzip -c <f>.gz | sha256sum` 与 `git show 6ee99ecb:<path> | sha256sum`
  相等，另用 `git hash-object` 复核）。
- **显示与补丁**：`repair-red/regression-red.txt` 是归一化**可读副本**（仅去掉行尾空格/制表符，并在
  文件头注明"原始输出见 `.txt.gz`"）；回退**补丁只保留** `.diff.gz`，不保留任何去掉 diff 正文空白
  的版本——原文件的两处"空白行"是 diff 正文（一处上下文空行、一处新增空行），归一化会让补丁不可
  应用。解压方法：`gunzip -c semantic-revert.diff.gz > /tmp/semantic-revert.diff`，对 `6ee99ecb` 的
  `app/scripts/verify-packaged-runtime.mjs` 运行 `git apply --check -p0` exit 0；应用后得到回退语义
  （文件 sha256 `f367d37b50b95f9bea0e073a5609d3069b02aacfe7e76e0eb49486b356cf857c`、
  `15 insertions(+), 59 deletions(-)`），方法记录在 `repair-red/README.md`。
- 本轮新增的 RED 输出按同一约定归档：`.txt.gz` 存原始字节、`.txt` 为可读副本（该输出本身无行尾
  空白，两份逐字节相同，已用 `cmp` 确认）。Mac 归档中唯一触发 `diff --check` 的
  `mac-review/sidecar-smoke.txt`（文件尾多一个空行）同样处理：原始字节见
  `mac-review/sidecar-smoke.txt.gz`，`README.md` 记录摘要与差异（§13）。

### 12.3 最终空白检查（实际执行结果）

- `git diff --cached --check`（暂存差异）→ **exit 0**（未加宽泛忽略规则；`core.whitespace` 未设置，
  本轮未新增任何 `.gitattributes` 空白豁免——`app/.gitattributes` 里既有的
  `patches/oh-my-pi/*.patch -whitespace` 来自 M5/T20-R3A 的 `474408d`，只作用于补丁构件，本轮未触碰）。
- `git diff bec20b214bee792b656d85aab5469e459b96eccc HEAD --check`（基线到最终代码状态）→
  **exit 0**（提交后以最终 `HEAD` 实跑；本项修复前对 `6ee99ecb` 的实跑结果是 exit 2、上述 7 处
  空白）。

## 13. 独立复审侧 macOS arm64 证据归档（`mac-review/`，属复审机实测）

> 本节证据由独立复审者在 macOS arm64 实机上取得并上传（`/tmp/omp-t21-mac-review-evidence-20261001/`）；
> 本工作区只做**原始字节归档**到 `docs/validation/M6-t21-packaged-runtime/mac-review/`（与源目录
> 逐字节一致），**不**把它计入本 Linux 会话的实测结论，也不改变 §9 的未做清单。逐文件摘要与说明见
> 该目录 `README.md`。

- **产物与身份**：首稿 `bec20b214bee792b656d85aab5469e459b96eccc` 的 `pack` 产出真实
  `app/apps/desktop/release/mac-arm64/OMP Desktop.app`（unsigned/unpacked，约 500 MB）；`ditto`
  完整拷到 `/private/tmp/omp-t21 Mac 打包验收/OMP Desktop.app`。`review-inventory.json` 记录
  `installerBuilt`/`codeSigned`/`notarized` 均为 false，以及各构件字节数/SHA-256：
  `Contents/Resources/omp-runtime/omp` 216435968 B / `501cc225…`、工具门 9897 B / `89c2d844…`、
  `app.asar` 20495298 B / `e6173140…`、`Contents/MacOS/OMP Desktop` 33968 B / `b8aab981…`。
- **构建**：`pack-bec20b21.txt` —— Node 24.14.0 / Bun 1.4.2、桌面 Rust stable 1.98.1（不改全局
  默认）、Electron 43.6.0；`CSC_IDENTITY_AUTO_DISCOVERY=false RUSTUP_TOOLCHAIN=stable
  OMP_SIDECAR_SOURCE=/private/tmp/omp-fork-r4-3-review-20260928 pnpm --filter @pi-desktop/desktop run
  pack` **exit 0**；无签名/公证、无 DMG、未发布。`sidecar-build.txt` 为该产物的 provenance
  （schema `/3`、`platform darwin`、`arch arm64`、`build.bytecode`）。
- **sidecar smoke**：`sidecar-smoke.txt` —— fork `6226f805…` 使用**自己的**冻结依赖与精确 native
  leaf（`@oh-my-pi/pi-natives-darwin-arm64@18.3.0`）构建，**9 passed**；复审说明：第一次试编译误用
  上游 `node_modules` 符号链接导致 native 归档为空（7 pass / 2 fail），那是复审环境错误、不是产品
  修改，旧二进制不作为通过证据。
- **打包资源验收**：`acceptance-unpacked-bec20b21.json`（首稿产物目录）与
  `acceptance-staged-6ee99ecb.json`（`ditto` 拷贝到含空格/中文路径的 `…/OMP Desktop.app/Contents/
  Resources`，入口为 `6ee99ecb`）均 exit 0：`runtimeVersion 18.3.0`、`protocolVersion 2`、
  `getState`、`gateLoadControl: refused`、`stopped/reaped/cleaned` 全真、`leftoverRuns 0`。macOS 无
  `/proc`，故 `child.readable=false`（"子进程环境不可读"是该宿主的缺省分支，**不是** Linux 式 OS
  环境读取证明；PATH 由生产 supervisor 注入这一事实另由本机的 Linux `/proc` 证据支撑）。
- **回归**：`regression-6ee99ecb.txt` —— 复审机在 `6ee99ecb` 上以真实 `Resources` 跑
  `node --test test/packaged-runtime-verify.test.mjs`：**15 passed / 0 failed / 0 skipped**。
- **原生 .app 启动（复审侧临时 harness）**：`packaged-boot-harness.mjs` + `packaged-boot.txt` ——
  借鉴现有 PI `scripts/e2e-electron-boot.mjs`，仅把可执行文件换为打包的
  `OMP Desktop.app/Contents/MacOS/OMP Desktop`：argv=[]、cwd=临时 profile（仓库外）、
  `HOME`/`PI_DESKTOP_DATA_DIR`=临时 profile、PATH=空目录、`NODE_PATH` 空、rendererURL 空。实际
  `app.asar`/preload/host-core IPC 运行后 **exit 0**：boot-probe `0.15.2` / host protocol 11 / 6 个
  原生菜单组（darwin）；800 个合成会话下 8 次 refresh 全部完成且响应指标通过；`projectRemove` IPC
  的 empty-target 边界通过；临时 profile 自动删除。harness 保留复审机绝对路径，**只是证据**，不是
  跨平台产品入口。
- **边界**：这是 **Pi/默认 host IPC** 启动证明，不是 OMP 对话/工具 UI 烟测，没有真实提供方请求、
  没有模型花费；完整 installer、签名/公证、OMP 消息/工具/停止/恢复 UI、整机离线与 clean runner
  仍待做（§9 不变，T21 未完成）。
