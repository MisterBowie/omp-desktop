# M5/T20-R4B：自有 OMP fork + bundled sidecar 的可验证闭环（含复审返修）

更新时间：2026-09-27（第二轮独立复审返修）。桌面分支 `codex/m5-r4b-bundled-sidecar`；首个 R4B 提交 `b25eb60c077deb5b200cf5f5bf6e8a3cddbbf679`，返修提交追加在其上（不 amend、不强推）；第二轮复审返修见 §0.1，追加提交 `53d19ee`、`f9d133e`、`7b3b3de`、`f428940`（+ 本轮文档提交）。

状态：**R4B 部分完成 / 受阻（第一轮复审返修 + 第二轮独立复审返修）。** 第二轮独立复审的 5 项阻塞问题已按「先复现（RED）→ 修复 → 重跑（GREEN）」处理：①规范资源根比较（别名祖先不再误报逃逸）；②发布目标（平台/架构）只解析一次，预检与 electron-builder 使用同一目标；③打包态诊断（`bundled-runtime-invalid` + 具体细节）经生产桥接进入 prompt 与控制操作错误；④测试夹具默认跟随宿主目标；⑤扩展清单边界收紧并升级到 `/2` schema。**但 R4-3 的“可复现”条款仍未满足（见 §10），因此 R4B 不标记为完成。**

**R3 仍为硬阻塞；ADR 0306 的 Cursor 产品门保留；T20-B/C/D 未开始；T20 未完成；T21 未完成；R4-3 未满足。**

非目标：解除 R3、实现 Plan/Goal 运行时面、放宽 Cursor 门、声称 PI parity、向 can1357 推送、跑 electron-builder 真实打包。

---

## 0.1 第二轮独立复审返修（RED → GREEN）

| # | 复审问题 | 复现（RED） | 修复（GREEN） |
| --- | --- | --- | --- |
| 1 | 资源包含性用词法 `resourcesPath` 比较 realpath 后的 `omp-runtime`，别名祖先（macOS `/var` → `/private/var`）误报逃逸 | `src/bundled.test.ts` 新增「symlinked ancestor」两例：修前 2 failed / 18 passed | 根与子路径都取 canonical：`realpathSync(resourcesPath)` 后再比较；目录/二进制/manifest/gate 的符号链接拒绝保留。`bundled.test.ts` 20 passed |
| 2 | `verify:sidecar:mac` 不带 `--arch`，`--x64` 只追加到链尾 electron-builder，arm64 机器会打包 x64 壳 + arm64 sidecar | 新 `omp-release-gate.test.mjs` 目标绑定用例：修前 `release-package.mjs` 不存在（ERR_MODULE_NOT_FOUND） | 新增 `scripts/release-package.mjs`，唯一解析目标并同时驱动预检与 electron-builder；win/linux 固定 x64 对齐。7 passed |
| 3 | `resolveBundledGate()` 吞掉 `OmpRuntimeError`，桥接层只回通用“gate not found” | `omp-session-failclosed.test.mjs` 生产桥接用例：修前 `errorCode` = `ENGINE_CAPABILITY_UNAVAILABLE` / `NOT_FOUND` | 新增 `inspectBundledGate`（保留 `bundled-runtime-invalid` + detail），`requireGate`/`requireLauncher` 经 `launcherError` 传播；无开发态回退。23 passed |
| 4 | 夹具默认 `linux/x64`，而 `resolveBundledGate({resourcesPath})` 读真实宿主 | 模拟非宿主平台后 `writeFixture` 默认仍为 `linux` | 夹具与 `verify`/`refusal` 默认改为 `process.platform/process.arch`，显式 Windows/不匹配覆盖保留。21 passed |
| 5 | 扩展清单路径未拒绝绝对/盘符/UNC/`.`/空段/重复；`extensions`/`desktopVersion` 的强加复用了 `/1` | 边界用例修前 5 failed / 20 passed | 规范化并拒绝非法/重复路径，要求“恰好信任工具门”，schema 升为 `omp-desktop.bundled-sidecar/2`。25 passed（`omp-runtime` 全套 350 passed / 6 skipped） |

RED/GREEN 计数与命令见 §12.1。真实产物与 protocol/gate 无费用烟测见 §8（本轮以 `/2` 清单重新构建）。

---

## 0. 结论摘要（返修轮）

1. **发布命令现在是机械的 fail-closed 入口。** `pack`/`dist`/`dist:mac`/`dist:win`/`dist:linux` 各自在 `bundle:runtime` 与 `electron-vite build` 之间插入 `pnpm run verify:sidecar[:<platform>]`（`omp-sidecar.mjs --preflight`）。宿主目标**实际构建** sidecar（缺失/过期不可能被打包）；跨目标**拒绝编译**，要求存在恰好为该平台/架构暂存、且相对**本次发布的受控清单**校验通过的产物——宿主二进制绝不会被复用到别的平台，缺少 `--arch` 的跨目标发布也直接拒绝。对照：上游 PI Desktop 的 `pack`/`dist*` 同样把 sidecar bundle 串进发布命令（`bundle:runtime`），而不是信任磁盘上的既有产物；OMP 需要更严格的形式，因为产物是平台相关的原生可执行文件。
2. **真实 smoke 走生产参数链，并因此发现并修复了一个真实缺陷。** smoke 现在用与 `createDesktopEngineRuntime` 相同的 `--trusted-extension <Resources>/omp-runtime/extensions/omp-desktop-gate.js` 启动真实编译产物，完成 `--version`、`negotiate_protocol` v2 与一次无费用 RPC。**复现到的缺陷**：工具门此前只是被**复制**，而源 gate 会 `import "../src/..."`；该路径在 Resources 下不存在，运行时直接拒绝启动（实测 `Trusted extension failed to load: Cannot find module '../src/session/approval-protocol.ts'`，exit 1）。修复：构建把 gate **打成自包含 bundle**（`bun build … --target=bun`），校验 bundle 内不再有相对导入，并先清空构建自有的 `extensions/` 目录（避免旧构建残留被一起发布）；gate 的字节数与 SHA-256 进入 provenance 并在启动前校验。
3. **打包态工具门解析彻底 fail closed。** `resolveGateExtension` 与 `createOmpSessionBridge.gatePath()` 都改成「只要 `isPackaged`，就只允许 Resources 下经同一套校验的工具门」：`resourcesPath` 缺失、gate 缺失、符号链接、路径逃逸、摘要不符一律拒绝，**不再**落入 `findGateExtension(appPath)` 开发搜索；appPath、环境变量、PATH、dev candidates 都无法绕过。开发态行为不变。
4. **诊断不再被吞。** 解析失败的原因（`bundled-runtime-invalid: …`）现在通过 `launcherResolutionError` 进入 supervisor，`status()` 从一开始就是 `failed` + 真实原因（含文件名与失败种类），不再退化成 “no runtime executable is configured”。
5. **provenance 的信任分级被写死并测试。** 启动时**校验**：schema、平台、架构、OMP 版本、patch level、上游 base SHA 与版本、fork 仓库/提交、**desktopVersion**、二进制名、二进制与每个扩展的字节数/SHA-256。**仅记录不校验**：`fork.tree`、`capabilities`、`build.*`（打包应用无法自行推导），ADR 明确禁止把它们说成已验证，并有测试固定该语义。
6. **R4-3 的“可复现”条款未满足。** 同一提交本轮出现 **4 个不同**的二进制 SHA-256（`83bd4a7c…`、`12f4aee5…`、`a0cf7586…`、`8360d6a3…`、`021408a8…`、`076b3531…` 中的多次独立构建）。任务板与 ADR/spec/本文均按**未满足/阻塞**记录，未写成通过。（gate bundle 本身两次构建逐位一致。）

---

## 1. 证据源

| 来源 | 固定坐标 | 核验 |
| --- | --- | --- |
| PI Desktop | `0111e306c120ad5820688d7608cb37bad8fbcc1f` | `upstream/pi-desktop` 子模块 HEAD 一致、工作树干净（由本机 R4A 检出本地 `git clone` 重建，未走网络） |
| OMP 基线（子模块） | `62bc57be1b03ef0802a33cf7f5f530e534527531`（18.3.0） | `upstream/oh-my-pi` 同法重建；`git status --porcelain` 空 |
| 自有 fork 检出 | `MisterBowie/oh-my-pi @ 3c845eb27f6f7b0a5b182f1868969ced86d10a3d` | `/tmp/r4b/oh-my-pi`；远端回读一致 |
| can1357 上游 | `refs/tags/v18.3.0` = `62bc57be…` | 仅只读 `git ls-remote` |
| nornzach GUI | `313279965a30b14505934a78b584fedb095f117b` | 架构参考，未据其断言 R4B 契约 |

代理事实：`127.0.0.1:7890` 未监听，实际使用 `127.0.0.1:7897`。全程未调用任何模型（无费用）。

---

## 2. 固定上游对照证据（要求：先查 PI，再查 OMP）

### 2.1 PI Desktop 的发布/构建链路（问题 1 的对照）

`upstream/pi-desktop/apps/desktop/package.json`（该固定检出）：

```
26|    "bundle:runtime": "pnpm -C ../../packages/agent-runtime bundle",
27|    "pack":      "pnpm run build:deps && pnpm run build:host-release && pnpm run bundle:runtime && electron-vite build && electron-builder --dir",
28|    "dist":      "... && pnpm run bundle:runtime && electron-vite build && electron-builder --publish never",
29|    "dist:mac":  "... && pnpm run bundle:runtime && electron-vite build && electron-builder --mac --publish never",
30|    "dist:win":  "... && pnpm run bundle:runtime && electron-vite build && electron-builder --win --publish never",
31|    "dist:linux":"... && pnpm run bundle:runtime && electron-vite build && electron-builder --linux --publish never"
```

即：PI **每个发布命令都在 electron-builder 之前构建自己的 sidecar bundle**（`extraResources` 指向 `../../packages/agent-runtime/dist-bundle`）。因此「发布命令必须自带 sidecar 步骤」与本产品一致；差异在于 OMP 的产物是**平台相关的原生可执行文件**，不能像 JS bundle 那样一次构建到处使用，故本产品在同一个位置上做更严格的入口（宿主构建 / 跨目标验证既有产物）。这与上游同一形状、更强约束。

PI 对内置资源的解析仍是「存在性 + 无 `isPackaged` 门」（`agent-sidecar.ts:18-27`、`host-process.ts:22-38`，见 ADR 0307 Context），所以“打包态只接受被校验资源”仍是本产品的新决策，未照抄。

### 2.2 OMP 侧（问题 2/3 的对照）

`packages/coding-agent/src/main.ts:1598-1613`：`--trusted-extension` 的值经 `realpathSync.native` + `statSync` 校验，必须是**存在的普通文件**，随后作为 `additionalExtensionPaths` 交给扩展加载器（`import()`）。因此：

* 工具门必须是运行时**能 import** 的模块——这正是「复制源码」失败的机制，也是选择 bundle 的依据；
* 加载器不做扩展名限制（`.js` 合法），故自包含 `.js` bundle 可用;
* `disableExtensionDiscovery = true`，即 `--trusted-extension` 是精确白名单，我们的 fail-closed 与之一致。

`packages/coding-agent/src/main.ts:526-529`：扩展加载失败会抛出 `Trusted extension failed to load: …` 并终止进程——实测复现了这条路径（见 §8）。

---

## 3. fork 源码坐标（要求 A，未变化）

fork 分支 `codex/omp-desktop-18.3.0-patch-2`，commit `3c845eb27f6f7b0a5b182f1868969ced86d10a3d`（tree `135ad4b6bc27f58a6220260233e9ff377b14f231`）= can1357 `v18.3.0` + 受控补丁 `62bc57b+omp-desktop.2`（10 文件）。`omp-sidecar.mjs --check` 与 `--preflight` 都会重新校验 origin/HEAD/干净/版本/文件集/补丁反向应用。本轮未改动 fork 内容。

---

## 4. 构建入口与 provenance（要求 B）

`app/scripts/omp-sidecar.mjs`：`--check` / `--build` / **`--preflight`**。

* provenance 写出 `extensions[]`（门禁文件路径 + 字节数 + SHA-256）与 `desktopVersion`；schema 为 **`omp-desktop.bundled-sidecar/2`**（强制 `extensions`/`desktopVersion` 改变了契约，故不静默重定义 `/1`）；`ompVersion`/`upstreamBase.version` 由产物与清单取得并互相校验。
* gate 由 `bun build <gate.ts> --target=bun --outfile <out>/extensions/omp-desktop-gate.js` 生成；构建后断言 bundle 文本中不存在 `from "./…"` / `from "../…"` 形式（自包含），否则 fail closed。
* 构建先 `rm -rf <out>/extensions`（构建自有目录），避免旧构建残留被发布。
* 所有校验值由脚本取得/校验，无手填。

当前产物（本机 Linux x64，第二轮复审以 `/2` 重新构建）：

```
binary : apps/desktop/resources/omp-runtime/omp       283559392 B  sha256 a3807b5e27cbb24109607442236be1bb733c93e895f67de8710d69d6003ff14a
gate   : apps/desktop/resources/omp-runtime/extensions/omp-desktop-gate.js   10112 B  sha256 bb110256984d6588108bd9e656ea3a874e0e81a8d9eb5655d2df129c2505b3f7
```

（同一 fork commit 多次构建的二进制 SHA-256 仍不同，见 §10；上表是本次构建值。）

---

## 5. 发布门（问题 1；第二轮复审后改为单一目标解析）

`apps/desktop/package.json` 脚本（第二轮复审问题 2 修复后）：

```
"verify:sidecar":       "node ../../scripts/omp-sidecar.mjs --preflight"   # 宿主目标手工检查
pack/dist/dist:mac/dist:win/dist:linux:
    … && pnpm run bundle:runtime && electron-vite build && node ../../scripts/release-package.mjs [--platform <p>] [--dir|--publish never]
```

**为什么不再把 `verify:sidecar[:<platform>]` 串进发布命令**：`pnpm run dist:mac -- --x64` 只会把 `--x64` 追加到 shell 链尾的 electron-builder，位于链中段的预检读不到它，于是 arm64 机器申请 x64 时会 `process.arch`（arm64）构建 sidecar、由 electron-builder 打进 x64 壳。现在 `scripts/release-package.mjs` 是链尾唯一入口，**只解析一次目标**：

1. `darwin`：架构取显式 `--x64`/`--arm64`/`--arch`，否则宿主架构；显式架构同时传给 electron-builder（跨架构需已暂存产物，由预检 fail closed）；宿主原生构建不向 electron-builder 传架构。
2. `win32`/`linux`：固定 x64，显式架构非 x64 直接拒绝；`--x64` 同时传给预检与 electron-builder，两侧契约不分离。
3. 目标不可用（如非宿主目标缺 `--arch`）→ 在 spawn 任何进程之前失败，退出码 2。

随后：预检（`omp-sidecar.mjs --preflight --platform <p> --arch <a>`）→ 仅当预检成功才运行 `electron-builder <--mac|--win|--linux> [--x64/--arm64] [--dir] --publish never`，保持 PI 「runtime 步骤先于 electron-builder」的顺序。

`--preflight` 语义（`scripts/omp-sidecar.mjs`）：

1. 始终先做完整的受控检出校验（`loadManifest` + `validateForkCheckout`）；
2. 目标是宿主 → 调 `buildSidecar()` 实际构建；
3. 目标非宿主 → 用**运行时包自己的** `verifyBundledRuntime`（而非第二套实现），`expected` **取自本次发布的受控清单**（ompVersion/patchLevel/baseSha/forkRepository/forkCommit/desktopVersion），任一不符即拒绝；缺 `--arch` 直接报错。

验证（RED/GREEN 与故障注入，均在不调用 electron-builder 的前提下）：

| 用例 | 命令/注入 | 结果 |
| --- | --- | --- |
| 覆盖性 | `node --test test/omp-release-gate.test.mjs` | 通过：每个发布命令都先 `bundle:runtime`、再 `release-package.mjs`，且不钉死架构 |
| 目标绑定 | 提取的参数/计划函数（stub spawn） | 通过：预检 `--platform/--arch` 与 electron-builder 架构开关一致；非宿主缺 arch 直接失败且不 spawn |
| GREEN | `--preflight --platform <非宿主> --arch x64 --source <fixture> --manifest <fixture> --out <staged>` | exit 0，`--json` 的 `fork.commit` = fixture HEAD |
| 缺产物 | `--out <空目录>` | **exit 1**，`does not match the controlled manifest` |
| 篡改 provenance | 改 staged `binary.sha256` | **exit 1** |
| 篡改 gate | 在 staged gate 末尾追加内容 | **exit 1**（字节数/摘要不符） |
| 外来产物 | staged 声明别的 patch level | **exit 1** |
| 旧 schema | staged 声明 `…/1` | **exit 1**（`schema`） |
| 陈旧控制 | fixture 工作树改脏 | **exit 1**（`uncommitted changes`） |
| 平台错配 | staged 用宿主平台名，目标为非宿主 | **exit 1** |
| 缺 arch | `--platform <非宿主>`（无 `--arch`） | **exit 1**（`--arch is required`） |


变异 RED：把 `dist:mac` 中的 `node ../../scripts/release-package.mjs` 替换成裸 `electron-builder` 后，覆盖性测试失败（见 §9.2）。

---

## 6. 打包态准入与工具门（问题 3 + 审计项；第二轮复审后更严）

* `resolveRuntimeLauncher`（打包态）：唯一候选 `resourcesPath/omp-runtime/{omp|omp.exe}`，`verifyBundledRuntime` 通过才可用；`OMP_DESKTOP_RUNTIME`/PATH/向上扫描均不是候选。
* **规范包含性（第二轮复审问题 1）**：`verifyBundledRuntime` 对 `resourcesPath` 与 `omp-runtime` 都取 `realpathSync` 后再比较，别名祖先（macOS `/var` → `/private/var`、symlink 目录）不再误报 `resolves outside the resources root`；`omp-runtime`、二进制、`provenance.json`、gate 仍以 `lstat` 拒绝符号链接。
* **扩展清单边界（第二轮复审问题 5）**：扩展路径规范化为相对 POSIX 路径，拒绝 POSIX 绝对路径、Windows 盘符、UNC、空段/`.`/`..` 段与重复项；清单必须**恰好**声明信任工具门（多发扩展需 ADR）；schema 升为 `omp-desktop.bundled-sidecar/2`。
* `resolveGateExtension`（`engine-runtime.ts`）与 `createOmpSessionBridge`（`omp-session.ts`）：`isPackaged` 时**只**用被校验的 Resources 工具门，`resourcesPath` 缺失/缺失/符号链接/逃逸/摘要不符一律拒绝，**绝不**进入开发搜索。
* 删除已废弃的 `BUNDLED_GATE_PATH` 常量与 `omp-session.ts` 的重复路径拼接，gate 相对路径只由 `@pi-desktop/omp-runtime` 的 `BUNDLED_GATE_RELATIVE_PATH` 定义一次。
* provenance 的 `extensions[]` 记录 gate 的字节数与 SHA-256，启动前校验。
* `extraResources` 增加 `"filter": ["**/*", "!.gitignore"]`，打包不再复制无关 `.gitignore`；同时断言输出目录的 `.gitignore` 仍被跟踪（干净 checkout 才有构建位置）。

测试证据：`apps/desktop/test/omp-runtime-launcher.test.mjs`（打包态只从被校验资源解析 gate；`resourcesPath` 缺失/篡改 → `null`；开发态仍走上向查找）；`packages/omp-runtime/src/bundled.test.ts` 覆盖 extensions 缺失/符号链接/越界/摘要不符/空数组、非法与重复路径、非唯一工具门、desktopVersion 不符、旧 schema、别名祖先接受与成员符号链接拒绝，以及“信息字段变化不影响接受”的语义测试。

---

## 7. 诊断传播（审计项；第二轮复审问题 3）

`OmpRuntimeSupervisorOptions.launcherResolutionError`：解析失败原因在构造时即写入 `lastFailure`，并在 `startRuntime()` 失败时与候选列表一起进入 `detail`；`OmpRuntimeAdapter.launcherError` 暴露同一字符串。

第二轮复审补齐了**桥接层**：`inspectBundledGate()` 保留 `verifyBundledRuntime` 的 `bundled-runtime-invalid` 代码与具体 `detail`（此前 `resolveBundledGate()` 直接吞成 `null`）；`createOmpSessionBridge` 的 `requireGate()` 在打包态用 `inspectBundledGate()`，`requireLauncher()` 在打包态用 `launcherError`，两者抛出的错误都带 `errorCode: "bundled-runtime-invalid"` 与具体细节（缺失文件名、`SHA-256`、`extension … does not match the provenance manifest` 等），并**没有**开发态回退。

测试：`apps/desktop/test/omp-session-failclosed.test.mjs` 用**生产桥接**（`createOmpRuntimeAdapter` + `createOmpSessionBridge`）对缺失二进制、篡改二进制、篡改 manifest、篡改 gate 分别验证 prompt 与 `rename`（控制操作）都返回上述代码与细节，并验证适配器自己的 launcher 拒绝原因原样透传。

---

## 8. 真实产物启动（问题 2，要求 D/E）

`packages/omp-runtime/src/bundled-smoke.test.ts`（opt-in：`OMP_SIDECAR_TEST_RESOURCES=<repo>/app/apps/desktop/resources`）：

* 参数链与生产一致：`args: ["--trusted-extension", <Resources>/omp-runtime/extensions/omp-desktop-gate.js]`（生产由 `createDesktopEngineRuntime` 传入同一 flag）。
* 断言产物来自 bundled resources：`verified.path === <resources>/omp-runtime/<filename>`，gate 路径在 `<resources>/omp-runtime/extensions/` 下，且 shipped gate **自包含**（不含 `from "../…"`）并含 gate 自身标记。
* 最小 PATH 自包含性：以 `PATH=<空目录>` 运行真实产物，`--version` 输出 `omp/18.3.0`（无 node/bun 可用；本机 `/usr/bin/node`、`/usr/bin/bun` 均不存在）。
* 真实启动：`idle`、`runtimeVersion=18.3.0`、`protocolVersion=2`，随后 `get_state` 无费用 RPC `success !== false`；诱饵 `XDG_*`/`OMP_PROFILE`/`PI_DESKTOP_DATA_DIR` 零写入，HOME 落在 run root 内；`stop()` 的 `stopped/reaped/cleaned` 均为真、无残留 run 目录。
* 异常与超时：外部 `kill -9` 进程组后 `stop()` 仍 `cleaned`/`reaped`；`readyTimeoutMs=50` 时 `start()` 以 `ready-timeout` 拒绝、无残留。
* 篡改 gate：同长度改一字节 → 校验以 `extension … does not match the provenance manifest` 拒绝。

第二轮复审以 `/2` 清单重新构建真实产物（283559392 B、sha256 `a3807b5e…`）后重跑整套真实块：**9 passed** —— `--version` 输出 `omp/18.3.0`（最小 PATH）、监督器到达 `idle`（runtimeVersion `18.3.0`、protocolVersion `2`）、`get_state` 无费用 RPC 成功、隔离与回收通过、篡改 gate 被拒。`bundled.test.ts`（25 passed）与 `bundled-smoke.test.ts`（9 passed）都以 `BUNDLED_PROVENANCE_SCHEMA = omp-desktop.bundled-sidecar/2` 运行。

**复现到的真实缺陷与修复（本节最重要的一条）**：

```
$ <Resources>/omp-runtime/omp --mode rpc-ui --trusted-extension <Resources>/omp-runtime/extensions/omp-desktop-gate.ts
error: Trusted extension failed to load: Failed to load extension:
  Cannot find module '../src/session/approval-protocol.ts?mtime=…'
  imported from <Resources>/omp-runtime/extensions/omp-desktop-gate.ts
（exit 1）
```

同一位置换成自包含 bundle 后，同一命令可正常进入模型发现阶段（不再报 extension 加载失败）。这正是“只复制源码”在打包态不可用的证据。

---

## 9. 测试与 RED 证据

### 9.1 计数（本机 Linux x64，Node v24.14.0、Bun 1.4.2；第二轮复审后）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test`（未设 opt-in 变量） | **23 files / 350 passed / 6 skipped（356）** |
| `OMP_SIDECAR_TEST_RESOURCES=… npx vitest run src/bundled-smoke.test.ts`（`/2` 清单重新构建后） | **9 passed**（3 恒开 + 6 真实产物/自包含/篡改/异常/超时） |
| `env -u SSH_ASKPASS node --test test/*.test.mjs`（`apps/desktop` 全量） | **tests 2937 / pass 2933 / fail 0 / skipped 4** |
| 其中 `omp-sidecar` 7、`omp-release-gate` 7、`omp-runtime-launcher` 12、`packaging-footprint` 9、`omp-session-failclosed` 23 | 均 0 fail |
| `pnpm build:js` / `pnpm -C packages/omp-runtime typecheck` / `pnpm -C apps/desktop typecheck` | 均 exit 0 |
| `git diff --check` | exit 0 |


### 9.2 变异（RED）矩阵

第一轮（保留）：

| 变异 | 期望判红 | 实测 |
| --- | --- | --- |
| `resolveGateExtension` 恢复 `isPackaged && resourcesPath` 落空即开发搜索 | 打包态 gate | ✖ `a packaged build resolves the gate only from verified resources` |
| 关闭 extension 摘要比较 | gate 完整性 | ✖ `refuses a gate whose content changed, even when the length did not` |
| 关闭 desktopVersion 校验 | 发布版本钉住 | ✖ `pins the desktop release the artifact was built for` |
| 适配器不再传 `launcherResolutionError` | 诊断传播 | ✖ `a refused bundled resource keeps its reason instead of a generic missing runtime` |

第二轮（本轮，逐项「先红后绿」，命令见 §12.1）：

| 复审问题 | RED 观察 | GREEN 观察 |
| --- | --- | --- |
| 1 规范包含性 | `bundled.test.ts`：**2 failed / 18 passed**（`omp-runtime resolves outside the resources root`） | **20 passed** |
| 2 发布目标绑定 | `omp-release-gate.test.mjs`：模块缺失 `ERR_MODULE_NOT_FOUND`（文件失败） | **7 passed** |
| 3 诊断传播 | `omp-session-failclosed.test.mjs`：`errorCode` = `ENGINE_CAPABILITY_UNAVAILABLE` / `NOT_FOUND` | **23 passed** |
| 4 夹具默认目标 | `-t "defaults the fixture target"`：`Expected "darwin" / Received "linux"`（1 failed / 20 skipped） | `bundled.test.ts` **21 passed** |
| 5 清单边界 + `/2` | `bundled.test.ts`：**5 failed / 20 passed** | **25 passed**；`omp-runtime` 全套 **350 passed / 6 skipped** |

---

## 10. R4-3 状态：**未满足（阻塞）**

R4-3 原文要求「构建脚本输出可核验清单…**重复构建在相同输入下产出相同清单**」。本轮实测：

* 同一 fork commit、同一检出、同一 Bun 1.4.2，独立构建的二进制 SHA-256 依次为 `83bd4a7c…`、`12f4aee5…`、`a0cf7586…`、`8360d6a3…`、`021408a8…`、`076b3531…`（同一提交出现了多个不同值；`cmp` 曾观察到首处差异位于第 81260545 字节）。
* 清单因此只描述**单次构建**；`--check`/`--preflight` 仍然确定性（校验输入与暂存产物，而非编译器输出）。
* 唯一可复现的构件是 gate bundle：两次 `bun build` 输出逐位一致（`48001135…`）。

结论：R4-3 的“构建时校验 remote/commit/list”部分已满足；“相同输入产出相同清单”部分**未满足**，作为 M6/T21 的未决阻塞项记录（ADR 0307 Consequences、spec §17、任务板同口径），未写成通过。

第二轮独立复审没有解除该阻塞：schema 升为 `/2` 只改变清单格式与校验严格度，**不改变** Bun 单文件编译输出的非确定性；`--check`/`--preflight` 仍只校验输入与暂存产物。因此 R4B 一律按**部分完成 / 受阻**记录，未标记完成。

---

## 11. 限制与未做

1. **未跑 electron-builder 真实打包**：只验证发布脚本覆盖性、预检行为与 `extraResources` 契约；没有产出安装包，也没有在打包后的应用里启动 sidecar。
2. **平台**：Linux x64 实跑；macOS/Windows 仅以参数化 fixture 覆盖 `omp.exe` 命名、平台/架构不符、跨目标禁止复用宿主二进制等逻辑，**不声称**这两个平台打包通过。
3. **R4-3 可复现性未满足**（§10）；schema 升为 `/2` 不改变这一点。
4. **gate bundle 的确定性**只在同一 Bun 版本、同一源文件下验证过；升级 Bun 后需重新确认。
5. **未触碰**：R3 未解除、Cursor 产品门未动、T20-B/C/D 未开始、未向 can1357 推送、未合并 main、未建 PR。
6. **预存在失败**：`check-docs` 6 项、`check-architecture` 1 项（见 §12），本轮不做顺带修复。
7. 子模块工作树由本机 R4A 检出本地重建（网络 clone 过慢），HEAD 与 gitlink 一致。
8. **上游测试随契约移动**：`apps/desktop/test/window-menu.test.mjs` 原先断言发布脚本里出现 `electron-builder` 字面量；electron-builder 现由 `release-package.mjs` 调用，故该断言改为「`build:host-release` 先于打包入口」，其余断言不变（全量桌面套件 2937/2933/0 fail/4 skip）。

---

## 12. 命令、退出码与检查

| 命令 | 结果 |
| --- | --- |
| `node app/scripts/omp-sidecar.mjs --check --source /tmp/r4b/oh-my-pi` | exit 0：`62bc57b+omp-desktop.2 (fork 3c845eb2…)` |
| `node app/scripts/omp-sidecar.mjs --preflight --source /tmp/r4b/oh-my-pi` | exit 0：`built linux/x64`，二进制 283559392 B、sha256 `a3807b5e…`，schema `/2` |
| `pnpm build:js`（`app/`） | exit 0 |
| `pnpm -C packages/omp-runtime typecheck` / `pnpm -C apps/desktop typecheck` | 均 exit 0 |
| `env -i PATH=<空目录> <resources>/omp-runtime/omp --version` | `omp/18.3.0`，exit 0 |
| `node docs/scripts/check-locales.mjs`（在 `app/`） | exit 0（79 对；§17 中英镜像同结构） |
| `node docs/scripts/check-docs.mjs`（在 `app/`） | 6 项**预存在**（`adr/0301` H1 + `adr/0301–0305` 缺索引行），无新增 |
| `node scripts/check-t20-matrix-ids.mjs`（在 `app/`） | exit 0（`B1-B14, C1-C8, D1-D3 each appear exactly once`） |
| `node scripts/check-architecture.mjs`（在 `app/`） | **预存在失败**：`apps/desktop/electron/main/index.ts` 1550 > 1500 LOC（本轮 `app/` 未新增超限文件） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs`（在 `app/`） | **exit 1（预期）**：`SUMMARY: 3 gap(s) open [g1, g2, g3]`（R3 未动摇） |
| `git diff --check` | exit 0 |

复核入口：`node app/scripts/omp-sidecar.mjs --preflight`；`OMP_SIDECAR_TEST_RESOURCES=<repo>/app/apps/desktop/resources pnpm --filter @pi-desktop/omp-runtime exec vitest run src/bundled-smoke.test.ts`；`cd app/apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs`；文档见 `app/docs/adr/0307-bundled-omp-sidecar.md`、`app/docs/spec/03-runtime/02-agent-runtime.md` §17、`app/patches/oh-my-pi/manifest.json`。

### 12.1 第二轮复审的 RED/GREEN 复核命令

| 复审问题 | RED 命令（起点 `3613f56`） | GREEN 命令（本轮） |
| --- | --- | --- |
| 1 | `npx vitest run src/bundled.test.ts` → 2 failed / 18 passed | 同命令 → 20 passed |
| 2 | `node --test test/omp-release-gate.test.mjs` → `ERR_MODULE_NOT_FOUND`（wrapper 不存在） | 同命令 → 7 passed |
| 3 | `node --test test/omp-session-failclosed.test.mjs`（旧桥接）→ `ENGINE_CAPABILITY_UNAVAILABLE`/`NOT_FOUND` | 同命令 → 23 passed |
| 4 | `npx vitest run src/bundled.test.ts -t "defaults the fixture target"` → Expected `darwin` / Received `linux` | `npx vitest run src/bundled.test.ts` → 21 passed |
| 5 | `npx vitest run src/bundled.test.ts` → 5 failed / 20 passed | 同命令 → 25 passed |

（工作目录：`app/packages/omp-runtime` 运行 vitest；`app/apps/desktop` 运行 node --test。所有 RED 均在起点提交上复现，GREEN 均在修复提交上复跑；计数见 §9.1 与 §12。）
