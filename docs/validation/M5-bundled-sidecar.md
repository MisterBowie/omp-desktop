# M5/T20-R4B：自有 OMP fork + bundled sidecar 的可验证闭环（含复审返修）

更新时间：2026-09-27。桌面分支 `codex/m5-r4b-bundled-sidecar`；首个 R4B 提交 `b25eb60c077deb5b200cf5f5bf6e8a3cddbbf679`，本文件记录的返修追加在其之上（不 amend、不强推）。

状态：**R4B 完成（含复审返修）。** 三项阻塞问题已按「先复现 → 修复 → 重跑」处理：①发布命令强制 sidecar 预检；②真实 smoke 走与桌面相同的 `--trusted-extension` 参数链并验证复制后的真实工具门；③打包态工具门解析彻底 fail closed。附带逐项处理了 diag 传播、provenance 信任分级、工具门完整性、`.gitignore` 打包、R4-3 可复现性冲突。

**R3 仍为硬阻塞；ADR 0306 的 Cursor 产品门保留；T20-B/C/D 未开始；T20 未完成；T21 未完成；R4-3 的“可复现”条款未满足（见 §10）。**

非目标：解除 R3、实现 Plan/Goal 运行时面、放宽 Cursor 门、声称 PI parity、向 can1357 推送、跑 electron-builder 真实打包。

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

* provenance 新增 `extensions[]`（门禁文件路径 + 字节数 + SHA-256）与既有 `desktopVersion`；`ompVersion`/`upstreamBase.version` 由产物与清单取得并互相校验。
* gate 由 `bun build <gate.ts> --target=bun --outfile <out>/extensions/omp-desktop-gate.js` 生成；构建后断言 bundle 文本中不存在 `from "./…"` / `from "../…"` 形式（自包含），否则 fail closed。
* 构建先 `rm -rf <out>/extensions`（构建自有目录），避免旧构建残留被发布。
* 所有校验值由脚本取得/校验，无手填。

当前产物（本机 Linux x64）：

```
binary : apps/desktop/resources/omp-runtime/omp       283559392 B  sha256 076b3531dc6eea7b497bb9d5ccfe9166172cb8ca238ab7fbd78c5a3a96455666
gate   : apps/desktop/resources/omp-runtime/extensions/omp-desktop-gate.js   sha256 bb110256984d6588108bd9e656ea3a874e0e81a8d9eb5655d2df129c2505b3f7
```

---

## 5. 发布门（问题 1）

`apps/desktop/package.json` 新增脚本与插入点：

```
"verify:sidecar":       "node ../../scripts/omp-sidecar.mjs --preflight"
"verify:sidecar:mac":   "… --preflight --platform darwin"
"verify:sidecar:win":   "… --preflight --platform win32 --arch x64"
"verify:sidecar:linux": "… --preflight --platform linux --arch x64"
pack/dist/dist:mac/dist:win/dist:linux:  … && pnpm run bundle:runtime && pnpm run verify:sidecar* && electron-vite build && electron-builder …
```

`--preflight` 语义（`scripts/omp-sidecar.mjs`）：

1. 始终先做完整的受控检出校验（`loadManifest` + `validateForkCheckout`）；
2. 目标是宿主 → 调 `buildSidecar()` 实际构建；
3. 目标非宿主 → 用**运行时包自己的** `verifyBundledRuntime`（而非第二套实现），`expected` **取自本次发布的受控清单**（ompVersion/patchLevel/baseSha/forkRepository/forkCommit/desktopVersion），任一不符即拒绝；缺 `--arch` 直接报错。

验证（RED/GREEN 与故障注入，均在不调用 electron-builder 的前提下）：

| 用例 | 命令/注入 | 结果 |
| --- | --- | --- |
| 覆盖性 | `node --test test/omp-release-gate.test.mjs` | 通过：每个发布命令都含对应的 `verify:sidecar*`，且位于 `bundle:runtime` 之后、`electron-builder` 之前 |
| GREEN | `--preflight --platform <非宿主> --arch x64 --source <fixture> --manifest <fixture> --out <staged>` | exit 0，`--json` 的 `fork.commit` = fixture HEAD |
| 缺产物 | `--out <空目录>` | **exit 1**，`does not match the controlled manifest` |
| 篡改 provenance | 改 staged `binary.sha256` | **exit 1** |
| 篡改 gate | 在 staged gate 末尾追加内容 | **exit 1**（字节数/摘要不符） |
| 外来产物 | staged 声明别的 patch level | **exit 1** |
| 陈旧控制 | fixture 工作树改脏 | **exit 1**（`uncommitted changes`） |
| 平台错配 | staged 用宿主平台名，目标为非宿主 | **exit 1** |
| 缺 arch | `--platform <非宿主>`（无 `--arch`） | **exit 1**（`--arch is required`） |

变异 RED：把 `dist:linux` 中的 `pnpm run verify:sidecar:linux &&` 删除后，覆盖性测试失败（见 §9）。

---

## 6. 打包态准入与工具门（问题 3 + 审计项）

* `resolveRuntimeLauncher`（打包态）：唯一候选 `resourcesPath/omp-runtime/{omp|omp.exe}`，`verifyBundledRuntime` 通过才可用；`OMP_DESKTOP_RUNTIME`/PATH/向上扫描均不是候选。
* `resolveGateExtension`（`engine-runtime.ts`）与 `createOmpSessionBridge.gatePath()`（`omp-session.ts`）：`isPackaged` 时**只**用 `resolveBundledGate()`（同一套 `verifyBundledRuntime`），`resourcesPath` 缺失即 `null`，缺失/符号链接/逃逸/摘要不符即 `null`，**绝不**进入开发搜索。
* 删除已废弃的 `BUNDLED_GATE_PATH` 常量与 `omp-session.ts` 的重复路径拼接，gate 相对路径只由 `@pi-desktop/omp-runtime` 的 `BUNDLED_GATE_RELATIVE_PATH` 定义一次。
* provenance 新增 `extensions[]`；gate 的字节数与 SHA-256 启动前校验（问题 3 的“完整性”选项，已实现而非降级为“已知限制”）。
* `extraResources` 增加 `"filter": ["**/*", "!.gitignore"]`，打包不再复制无关 `.gitignore`；同时断言输出目录的 `.gitignore` 仍被跟踪（干净 checkout 才有构建位置）。

测试证据：`apps/desktop/test/omp-runtime-launcher.test.mjs` 新增/扩展——打包态只从被校验资源解析 gate；`resourcesPath` 缺失（即使 appPath 有 dev gate、PATH 有同名文件、环境变量指向 dev gate）→ `null`；gate 被篡改 → `null`；开发态仍走上向查找。`packages/omp-runtime/src/bundled.test.ts` 覆盖 extensions 缺失/符号链接/未声明/越界/摘要不符/空数组、desktopVersion 不符，以及“信息字段变化不影响接受”的语义测试。

---

## 7. 诊断传播（审计项）

`OmpRuntimeSupervisorOptions.launcherResolutionError`：解析失败原因在构造时即写入 `lastFailure`，并在 `startRuntime()` 失败时与候选列表一起进入 `detail`；`OmpRuntimeAdapter.launcherError` 暴露同一字符串。测试：篡改打包资源后 `createOmpRuntimeAdapter(...)` 的 `launcher === null`、`status().phase === "failed"`、`status().reason === "start-failed"`、`status().detail` 含 `bundled-runtime-invalid` 与 `SHA-256|bytes`。

---

## 8. 真实产物启动（问题 2，要求 D/E）

`packages/omp-runtime/src/bundled-smoke.test.ts`（opt-in：`OMP_SIDECAR_TEST_RESOURCES=<repo>/app/apps/desktop/resources`）：

* 参数链与生产一致：`args: ["--trusted-extension", <Resources>/omp-runtime/extensions/omp-desktop-gate.js]`（生产由 `createDesktopEngineRuntime` 传入同一 flag）。
* 断言产物来自 bundled resources：`verified.path === <resources>/omp-runtime/<filename>`，gate 路径在 `<resources>/omp-runtime/extensions/` 下，且 shipped gate **自包含**（不含 `from "../…"`）并含 gate 自身标记。
* 最小 PATH 自包含性：以 `PATH=<空目录>` 运行真实产物，`--version` 输出 `omp/18.3.0`（无 node/bun 可用；本机 `/usr/bin/node`、`/usr/bin/bun` 均不存在）。
* 真实启动：`idle`、`runtimeVersion=18.3.0`、`protocolVersion=2`，随后 `get_state` 无费用 RPC `success !== false`；诱饵 `XDG_*`/`OMP_PROFILE`/`PI_DESKTOP_DATA_DIR` 零写入，HOME 落在 run root 内；`stop()` 的 `stopped/reaped/cleaned` 均为真、无残留 run 目录。
* 异常与超时：外部 `kill -9` 进程组后 `stop()` 仍 `cleaned`/`reaped`；`readyTimeoutMs=50` 时 `start()` 以 `ready-timeout` 拒绝、无残留。
* 篡改 gate：同长度改一字节 → 校验以 `extension … does not match the provenance manifest` 拒绝。

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

### 9.1 计数（本机 Linux x64，Node v24.14.0、Bun 1.4.2）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test`（未设 opt-in 变量） | **23 files / 343 passed / 6 skipped（349）** |
| `OMP_SIDECAR_TEST_RESOURCES=… npx vitest run src/bundled-smoke.test.ts` | **9 passed**（3 恒开 + 6 真实产物/自包含/篡改/异常/超时） |
| `env -u SSH_ASKPASS node --test test/*.test.mjs`（`apps/desktop` 全量） | **tests 2925 / pass 2921 / fail 0 / skipped 4** |
| 其中 `omp-sidecar` 7、`omp-release-gate` 4、`omp-runtime-launcher` 12、`packaging-footprint` 9 | 均 0 fail |
| `pnpm -C packages/shared run build` / `pnpm -C packages/omp-runtime run build` / `pnpm -C apps/desktop typecheck` | 均 exit 0 |
| `git diff --check` | exit 0 |

### 9.2 变异（RED）矩阵

| 变异 | 期望判红 | 实测 |
| --- | --- | --- |
| 删除 `dist:linux` 的 `verify:sidecar:linux` | 发布覆盖性 | ✖ `every release command runs the sidecar preflight before electron-builder` |
| `resolveGateExtension` 恢复 `isPackaged && resourcesPath` 落空即开发搜索 | 打包态 gate | ✖ `a packaged build resolves the gate only from verified resources` |
| 关闭 extension 摘要比较 | gate 完整性 | ✖ `refuses a gate whose content changed, even when the length did not` |
| 关闭 desktopVersion 校验 | 发布版本钉住 | ✖ `pins the desktop release the artifact was built for` |
| 适配器不再传 `launcherResolutionError` | 诊断传播 | ✖ `a refused bundled resource keeps its reason instead of a generic missing runtime` |

五处变异同时施加时各命中且仅命中上述用例（`16 项中 3 失败` + `18 项中 2 失败`），全部还原后 `grep -rn "false &&"` 无残留，两处套件复绿（18/18、32/32）。

---

## 10. R4-3 状态：**未满足（阻塞）**

R4-3 原文要求「构建脚本输出可核验清单…**重复构建在相同输入下产出相同清单**」。本轮实测：

* 同一 fork commit、同一检出、同一 Bun 1.4.2，独立构建的二进制 SHA-256 依次为 `83bd4a7c…`、`12f4aee5…`、`a0cf7586…`、`8360d6a3…`、`021408a8…`、`076b3531…`（同一提交出现了多个不同值；`cmp` 曾观察到首处差异位于第 81260545 字节）。
* 清单因此只描述**单次构建**；`--check`/`--preflight` 仍然确定性（校验输入与暂存产物，而非编译器输出）。
* 唯一可复现的构件是 gate bundle：两次 `bun build` 输出逐位一致（`48001135…`）。

结论：R4-3 的“构建时校验 remote/commit/list”部分已满足；“相同输入产出相同清单”部分**未满足**，作为 M6/T21 的未决阻塞项记录（ADR 0307 Consequences、spec §17、任务板同口径），未写成通过。

---

## 11. 限制与未做

1. **未跑 electron-builder 真实打包**：只验证发布脚本覆盖性、预检行为与 `extraResources` 契约；没有产出安装包，也没有在打包后的应用里启动 sidecar。
2. **平台**：Linux x64 实跑；macOS/Windows 仅以参数化 fixture 覆盖 `omp.exe` 命名、平台/架构不符、跨目标禁止复用宿主二进制等逻辑，**不声称**这两个平台打包通过。
3. **R4-3 可复现性未满足**（§10）。
4. **gate bundle 的确定性**只在同一 Bun 版本、同一源文件下验证过；升级 Bun 后需重新确认。
5. **未触碰**：R3 未解除、Cursor 产品门未动、T20-B/C/D 未开始、未向 can1357 推送、未合并 main、未建 PR。
6. **预存在失败**：`check-docs` 6 项、`check-architecture` 1 项（见 §12），本轮不做顺带修复。
7. 子模块工作树由本机 R4A 检出本地重建（网络 clone 过慢），HEAD 与 gitlink 一致。

---

## 12. 命令、退出码与检查

| 命令 | 结果 |
| --- | --- |
| `node scripts/omp-sidecar.mjs --check --source /tmp/r4b/oh-my-pi` | exit 0 |
| `node scripts/omp-sidecar.mjs --preflight --source /tmp/r4b/oh-my-pi` | exit 0：`built linux/x64` |
| `env -i PATH=<空目录> <resources>/omp-runtime/omp --version` | `omp/18.3.0`，exit 0 |
| `node docs/scripts/check-locales.mjs` | exit 0（79 对；§17 中英镜像同结构） |
| `node docs/scripts/check-docs.mjs` | **exit 1，6 项预存在**（`adr/0301` H1 + `adr/0301–0305` 缺索引行），无新增 |
| `node scripts/check-t20-matrix-ids.mjs` | exit 0 |
| `node scripts/check-architecture.mjs` | **exit 1，预存在**（`electron/main/index.ts` 1550 > 1500 LOC） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | **exit 1（预期）**：`SUMMARY: 3 gap(s) open [g1, g2, g3]`（R3 未动摇） |
| `git status --short` | 仅本轮应有改动；`resources/omp-runtime/{omp,provenance.json,extensions/}` 被 gitignore（`git add -An` 只加 `.gitignore`） |

复核入口：`node app/scripts/omp-sidecar.mjs --preflight`；`OMP_SIDECAR_TEST_RESOURCES=<repo>/app/apps/desktop/resources pnpm --filter @pi-desktop/omp-runtime exec vitest run src/bundled-smoke.test.ts`；`cd app/apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs`；文档见 `app/docs/adr/0307-bundled-omp-sidecar.md`、`app/docs/spec/03-runtime/02-agent-runtime.md` §17、`app/patches/oh-my-pi/manifest.json`。
