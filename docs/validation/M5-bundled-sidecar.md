# M5/T20-R4B：自有 OMP fork + bundled sidecar 的可验证闭环

更新时间：2026-09-27。桌面分支 `codex/m5-r4b-bundled-sidecar`，基线 `d8c0a35d34e424dec02acc24df444f7bb8a71cf4`（单线追加）。

状态：**R4B 完成**——建立自有 OMP fork 源码坐标、可复现（且 fail-closed 校验的）sidecar 构建入口与 provenance 清单、打包资源的 `app.isPackaged` 准入、启动前身份/协议断言，并用真实编译产物完成无费用启动、隔离 canary 与进程组/临时目录回收验证。**R3 仍为硬阻塞；ADR 0306 的 Cursor 产品门保留；T20-B/C/D 未开始；T20 未完成；T21 未完成。**

非目标（明确不做）：解除 R3、实现 Plan/Goal 运行时面、删除或放宽 Cursor 门、声称 PI parity、向 `can1357/oh-my-pi` 推送、executor-builder 真实打包与 macOS/Windows 实机。

---

## 0. 结论摘要

1. **自有 fork 坐标已建立并只推自有仓库**：`https://github.com/MisterBowie/oh-my-pi` 分支 `codex/omp-desktop-18.3.0-patch-2`，commit `3c845eb27f6f7b0a5b182f1868969ced86d10a3d`（tree `135ad4b6bc27f58a6220260233e9ff377b14f231`），内容 = can1357 `v18.3.0`（`62bc57be…`）+ 受控补丁 `62bc57b+omp-desktop.2`（10 文件，+1350/−34）。`git ls-remote` 回读与本地 HEAD 一致；`can1357/oh-my-pi` 只作只读 upstream（`git ls-remote` 仅用于读标签），未推送、未改写其历史。补丁应用后的 18.3.0 检出上，R4A 目标三套件 **177 pass / 0 fail**，`git apply --check --reverse` 通过。
2. **构建入口 fail closed**：`app/scripts/omp-sidecar.mjs` 在编译前校验 `origin`（规范化后必须等于清单 `fork.repository`，SSH/`ssh://`/HTTPS 三种写法等价）、`HEAD`（必须等于 `fork.commit`）、工作树干净、`packages/utils/package.json` 版本、`git diff --name-only <base> HEAD` 等于清单文件集、`git apply --check --reverse` 接受受控补丁。编译走 OMP 官方 `packages/coding-agent/scripts/build-binary.ts`（Bun 单文件、自包含），产物 + 工具门落到 `app/apps/desktop/resources/omp-runtime/`（gitignore），并写出机器可读 `provenance.json`。所有值由脚本从已校验检出/清单/本机/产物取得，无手填。
3. **打包态只接受被校验过的资源**：`resolveRuntimeLauncher` 在 `app.isPackaged` 下**只**考虑 `process.resourcesPath/omp-runtime/{omp|omp.exe}`，且 binary 与 `provenance.json` 的 schema/platform/arch/OMP 版本/patch level/upstream base SHA/fork 仓库/fork commit/文件名/字节数/SHA-256 全部校验通过才可用；缺失（或 `resourcesPath` 为空）、符号链接、目录逃逸、畸形 JSON、任一字段不符、字节数或摘要不符、binary 被篡改，一律 `OmpRuntimeError("bundled-runtime-invalid")`。同一状态下 `OMP_DESKTOP_RUNTIME`、向上资源树扫描（`appPath`/cwd）与 `PATH` **均不是候选**。开发态保留显式覆盖与固定子模块向上查找。
4. **启动前断言**：沿用既有路径——spawn 前 `--version` 探测、`ready` 后 `negotiate_protocol` v2；不符时引擎停在 `failed`（`version-mismatch` / `protocol-unsupported`，后者本轮从 `start-failed` 细分）且能力全关，因此不会产生可用会话。
5. **真实产物无费用验证通过（Linux x64，模型零调用）**：`omp-sidecar.mjs --build` 产出 283559392 字节、sha256 `a0cf758652e6a89b71c8717f49902c7732696016c59e2a963c7719ec5c2c4213` 的自包含可执行文件；在最小 PATH（`/usr/bin:/bin`，本机 `/usr/bin/node`、`/usr/bin/bun` 均不存在）下 `--version` 输出 `omp/18.3.0`。监督器真实启动到达 `idle`（runtimeVersion `18.3.0`、protocolVersion `2`），隔离诱饵目录零写入，异常死亡后的 `stop()`（`reaped`/`cleaned` 均为真）与永不 ready 的超时清理均通过。

---

## 1. 证据源与完整性核验

| 来源 | 固定坐标 | 本机获取与核验 |
| --- | --- | --- |
| PI Desktop | `0111e306c120ad5820688d7608cb37bad8fbcc1f` | `upstream/pi-desktop` 子模块（`git submodule status` = 该 SHA，`git status --porcelain` 空）。由 R4A worktree 的本地副本 `git clone --no-checkout` 重建，**未走网络** |
| 当前 OMP（子模块） | `62bc57be1b03ef0802a33cf7f5f530e534527531`（omp/18.3.0） | `upstream/oh-my-pi` 同法由本地副本重建；`git rev-parse HEAD` 一致、`git status --porcelain` 空；按 worktree 单独 `bun install --frozen-lockfile` 并放入官方预编译 natives（`@oh-my-pi/pi-natives-linux-x64@18.3.0`，取自 `pi_natives.linux-x64-{baseline,modern}.node`） |
| 自有 fork 检出 | `MisterBowie/oh-my-pi @ 3c845eb27f6f7b0a5b182f1868969ced86d10a3d` | `/tmp/r4b/oh-my-pi`（`git clone --filter=blob:none` 经 `127.0.0.1:7897`）；`git rev-parse HEAD`、`git remote get-url origin` 均与记录一致；构建后 `git status --porcelain` 仍为空（`dist/`、`*.node` 被忽略） |
| can1357 v18.3.0 | `62bc57be1b03ef0802a33cf7f5f530e534527531`（`refs/tags/v18.3.0`） | `git ls-remote https://github.com/can1357/oh-my-pi refs/tags/v18.3.0`（只读）；fork 上同名标签指向同一 commit |

网络事实：任务书给出的 `http://127.0.0.1:7890` 代理未监听；本机可用的是 `127.0.0.1:7897`。`upstream/pi-desktop` 的 `git submodule update --init` 因网络 clone 过慢被外部终止一次；随后**未重试网络大仓库**，改用本机已存在的 R4A 检出做本地 `git clone`（`/home/vv/person/code/omp-desktop-m5-r4/upstream/*`），子模块状态因此可用且不需要网络。全程**未调用任何模型**。

---

## 2. 先查固定 PI Desktop 上游（要求 2）

PI Desktop `0111e306` 对内置可执行文件的解析（逐行核对，行号取自该固定检出）：

| 位置 | 事实 |
| --- | --- |
| `apps/desktop/electron/main/agent-sidecar.ts:18-27` | `resolveSidecarEntry()` 依次尝试 `process.resourcesPath/agent-runtime/sidecar.js`、`__dirname/../../../agent-runtime/dist/sidecar.js`、`__dirname/../../../../packages/agent-runtime/dist/sidecar.js`，**只用 `existsSync`** 判定，最后无条件回落到开发路径 |
| `apps/desktop/electron/main/host-process.ts:22-38` | `resolveHostBinary()` 先看 `PI_DESKTOP_HOST_BIN`（**存在即用，无 `app.isPackaged` 门**），再看 `process.resourcesPath/bin/pi-desktop-host-core{exe}`，再看开发 `target/{debug,release}`；同样只做存在性检查 |
| `apps/desktop/electron/main/host-process.ts:49-57` | `resolveBuiltinPluginsDir()`：`resourcesPath/plugins` → 开发相对路径，存在性检查 |

结论：**PI 上游没有「内置资源完整性校验」的先例，也没有把开发覆盖按打包态关闭**。因此 R4B 的「provenance 校验 + `app.isPackaged` 下忽略开发通道」是**本产品的新决策**（新 ADR，见 §7），不是照抄上游；同时它也不与上游冲突（我们不改变 PI 自身行为）。

参考架构（nornzach `oh-my-pi-gui@313279965`）的对照结论沿用 R3D 审计：该 GUI **不从 PATH 解析 `omp`**，但 `OMP_BUNDLED_OMP`（早于 `resourcesPath` 判断）、向上资源树扫描与 `OMP_SIDECAR=source` **都无 `app.isPackaged` 门**，故「打包态固定 sidecar」需自加门（R4-9）。我产品侧已按 R4-9 实现，未改其源码。

---

## 3. 要求 A：fork 源码坐标与补丁

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| origin 核对 | `git -C /tmp/r4b/oh-my-pi remote -v` | `origin https://github.com/MisterBowie/oh-my-pi (fetch/push)` |
| 建分支 | `git checkout -b codex/omp-desktop-18.3.0-patch-2 62bc57be…`（fork 上 `refs/tags/v18.3.0` 即该 commit） | HEAD = `62bc57be…` |
| 应用受控补丁 | `git apply -p1 <app/patches/oh-my-pi/0001-rpc-host-tool-transition-contract.patch>` | 干净应用，`git status --porcelain` 恰 10 个 `M`，`diff --stat` = 10 files changed, 1350 insertions(+), 34 deletions(−) |
| R4A 目标三套件 | `bun test packages/agent/test/agent-loop.test.ts packages/coding-agent/test/rpc-host-tools.test.ts packages/coding-agent/test/rpc-input-frame.test.ts` | **exit 0：177 pass / 0 fail，755 expect() calls，Ran 177 tests across 3 files**（与 R4A 记录一致） |
| 提交 | `git commit`（10 文件）| commit `3c845eb27f6f7b0a5b182f1868969ced86d10a3d`，tree `135ad4b6bc27f58a6220260233e9ff377b14f231` |
| 往返核验 | `git apply --check --reverse <artifact>`；`git diff --name-only 62bc57be… HEAD` | 反向应用 exit 0；差异文件集 = 清单 10 文件 |
| 推送 | `git push origin codex/omp-desktop-18.3.0-patch-2` | exit 0，`* [new branch]`；`git ls-remote origin refs/heads/codex/omp-desktop-18.3.0-patch-2` = `3c845eb2…` |

冻结坐标写进 `app/patches/oh-my-pi/manifest.json` 的新 `fork` 块（`repository`/`branch`/`commit`/`tree`），并由 `omp-patch.mjs` 在加载清单时校验（40 位十六进制 commit、可选 tree、非空 repository/branch）。

---

## 4. 要求 B：可复现构建入口与 provenance

`app/scripts/omp-sidecar.mjs`（新）提供 `--check` / `--build`：

* `validateForkCheckout(source, manifest, patchPath)`：remote 规范化比较 → `HEAD == manifest.fork.commit` → 工作树干净 → 版本 → `git cat-file -e <base>` → 差异文件集 → `git apply --check --reverse`。任一不满足抛 `PatchError`，CLI 退出码 1。
* `buildSidecar()`：调用 OMP 官方 `bun packages/coding-agent/scripts/build-binary.ts`（隔离环境、进程组回收、超时分级终止），把 `dist/omp`（或 `omp.exe`）与 `packages/omp-runtime/extensions/omp-desktop-gate.ts` 复制到输出目录，探测产物 `--version` 必须等于 `base.version`，随后写出 `provenance.json`。
* 输出目录安全：拒绝文件系统根、符号链接、非目录、位于源码 checkout 内或包含仓库根的路径。

生成逻辑不依赖任何网络：`bun install` 的依赖来自本机缓存，native 来自本机既有文件。

---

## 5. 要求 C：打包接入与打包态准入

* `apps/desktop/package.json`：`build.extraResources` 新增 `{ "from": "resources/omp-runtime", "to": "omp-runtime" }`；新增脚本 `build:sidecar`（`node ../../scripts/omp-sidecar.mjs --build`）。`resources/omp-runtime/.gitignore` 忽略 `omp`、`omp.exe`、`provenance.json`、`extensions/`；`git add -An` 只会加入该 `.gitignore`。
* `packages/omp-runtime/src/bundled.ts`（新）：`BUNDLED_RUNTIME_DIR`/`BUNDLED_PROVENANCE_FILENAME`/`BUNDLED_PROVENANCE_SCHEMA`、`bundledBinaryFilename(platform)`、`normalizeRepositoryUrl(url)`、typebox 形状校验 `BundledProvenanceSchema`、`verifyBundledRuntime({resourcesPath, platform, arch, expected})`（含分块 SHA-256，避免整文件分配）。
* `apps/desktop/electron/main/runtime/omp-runtime.ts`：`resolveRuntimeLauncher` 重排为「打包态只看校验过的资源 / 开发态看显式覆盖再看向上查找」；`LauncherResolutionInput` 增加 `platform`/`arch`（fixture 用），`ResolvedLauncher` 增加 `error`/`provenance`。
* 打包态的候选空间是**闭集**：`OMP_DESKTOP_RUNTIME`、`PATH`、`appPath`/cwd 向上扫描都不参与（R4-9）。

---

## 6. 要求 D/E：启动断言、隔离 canary 与清理

`app/packages/omp-runtime/src/bundled-smoke.test.ts`（新，opt-in）：

* 恒开：用 mock 启动器验证「版本不符」→ `version-mismatch`、`phase=failed`、能力全关；「拒绝 v2」→ `protocol-unsupported`、能力全关。
* `OMP_SIDECAR_TEST_RESOURCES` 指向构建出的 resources 根时，3 项真实产物测试：
  1. `verifyBundledRuntime` 通过 → 监督器真实启动 → `idle`、`runtimeVersion=18.3.0`、`protocolVersion=2`；诱饵目录（`XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`OMP_PROFILE`/`PI_DESKTOP_DATA_DIR`）零写入、HOME 落在 run root 内、`configRoot` 在 HOME 内；`stop()` 的 `stopped/reaped/cleaned` 均为真、无残留 run 目录。
  2. 异常死亡：外部 `kill -9` 整个进程组后 `stop()` 仍 `cleaned`/`reaped` 为真，无残留。
  3. 永不 ready（`readyTimeoutMs=50`）：`start()` 以 `ready-timeout` 拒绝、`phase=failed`、无残留 run 目录。

EPIPE / 忽略 EOF / 组长退出但后代存活等终止语义由既有 mock 套件覆盖（`process.test.ts` 的 `exit-immediately`/`never-ready`/`deaf`/`detached-descendant`/`ignore-eof` 等模式），本轮未新增重复断言。

---

## 7. 要求 F：测试与 RED/变异证据

### 7.1 套件与计数

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test`（未设 `OMP_SIDECAR_TEST_RESOURCES`） | **exit 0：23 files / 335 passed / 3 skipped**（3 skipped = 真实产物块） |
| `OMP_SIDECAR_TEST_RESOURCES=<app>/apps/desktop/resources npx vitest run src/bundled-smoke.test.ts` | **exit 0：5 passed**（2 恒开 + 3 真实产物） |
| `env -u SSH_ASKPASS node --test test/*.test.mjs`（`apps/desktop`，全量） | **exit 0：tests 2919 / pass 2915 / fail 0 / skipped 4**（`duration_ms` 46619） |
| 其中 `test/omp-runtime-launcher.test.mjs` + `test/omp-sidecar.test.mjs` | 17/17 通过（10 + 7） |
| `pnpm -C packages/omp-runtime run build`、`pnpm -C packages/shared run build`、`pnpm -C apps/desktop typecheck` | 均 exit 0 |

新增/迁移的既有测试（行为契约变化，均已同步）：
* `packaging-footprint.test.mjs`：`extraResources` 期望值增加 `resources/omp-runtime → omp-runtime`。
* `omp-patch.test.mjs`：fixture 清单增加必需的 `fork` 块。

### 7.2 变异（RED）证据

| 变异 | 命令 | 结果 |
| --- | --- | --- |
| 移除 `omp-sidecar.mjs` 的 remote 校验 | `node --test test/omp-sidecar.test.mjs` | **exit 1：7 项中 2 项判红**——`the wrong remote, commit, cleanliness, version, file set, or patch is refused`、`--check runs the same gate as a process, exiting non-zero on refusal` |
| 移除 `bundled.ts` 的 SHA-256 比较 | `npx vitest run src/bundled.test.ts` | **exit 1：11 项中 1 项判红**——`refuses a binary that does not match the declared bytes or digest` |
| 关闭 `resolveRuntimeLauncher` 的 `isPackaged` 分支 | `node --test test/omp-runtime-launcher.test.mjs` | **exit 1：10 项中 3 项判红**——`a packaged build admits only a resource that matches its provenance`、`a packaged build ignores every development channel`、`a packaged build refuses a tampered or absent provenance manifest` |
| 移除 `omp-patch.mjs` 的 `fork` 块校验（开发过程中的自然红灯） | `node --test test/*.test.mjs` | `omp-patch.test.mjs` 报 `OMP-PATCH-FAIL manifest field fork.repository is missing`（`1 !== 0`），补 fixture 后转绿 |

三次变异均已还原；`grep -rn "false &&"` 在三个改动文件中返回 NONE，还原后两套件 17/17 通过。

### 7.3 平台命名与校验边界的 fixture 覆盖

`bundled.test.ts` 用 `platform`/`arch` 参数覆盖：`omp.exe`（win32）命名与解析、platform/arch 不符拒绝、schema 不符、fork commit/repository 不符、base SHA 不符、文件名不符、字节数与摘要不符、畸形 JSON、`omp-runtime` 目录为符号链接。**这些是逻辑覆盖，不代表 macOS/Windows 实机打包通过。**

---

## 8. 真实构建与启动记录（要求 B/E 的实跑）

| 命令 | 结果 |
| --- | --- |
| `node scripts/omp-sidecar.mjs --check --source /tmp/r4b/oh-my-pi` | exit 0：`OMP-SIDECAR-OK 62bc57b+omp-desktop.2 (fork 3c845eb2…)` |
| `node scripts/omp-sidecar.mjs --build --source /tmp/r4b/oh-my-pi` | exit 0：`OMP-SIDECAR-BUILT omp in app/apps/desktop/resources/omp-runtime`，sha256 `a0cf758652e6a89b71c8717f49902c7732696016c59e2a963c7719ec5c2c4213`，bytes `283559392` |
| `env -i HOME=… PATH=/usr/bin:/bin ./omp --version` | `omp/18.3.0`（exit 0；本机 `/usr/bin/node`、`/usr/bin/bun` 均不存在） |
| `ldd ./omp` | 仅 `libc`/`libpthread`/`libdl`/`ld-linux`（自包含 Bun） |
| `OMP_SIDECAR_TEST_RESOURCES=… npx vitest run src/bundled-smoke.test.ts` | exit 0：5 passed（真实启动到达 idle、协议 v2、隔离 canary、异常/超时清理） |

产物 `provenance.json`（脚本生成，未手填）：

```json
{
  "schema": "omp-desktop.bundled-sidecar/1",
  "fork": { "repository": "https://github.com/MisterBowie/oh-my-pi",
            "commit": "3c845eb27f6f7b0a5b182f1868969ced86d10a3d",
            "tree": "135ad4b6bc27f58a6220260233e9ff377b14f231" },
  "upstreamBase": { "sha": "62bc57be1b03ef0802a33cf7f5f530e534527531", "version": "18.3.0" },
  "patchLevel": "62bc57b+omp-desktop.2",
  "capabilities": ["rpc-host-tool-concurrency","rpc-host-tool-sole-batch-policy",
                   "agent-tool-result-terminate","rpc-host-tool-result-terminate"],
  "ompVersion": "18.3.0",
  "desktopVersion": "0.15.2",
  "platform": "linux", "arch": "x64",
  "binary": { "filename": "omp", "bytes": 283559392,
              "sha256": "a0cf758652e6a89b71c8717f49902c7732696016c59e2a963c7719ec5c2c4213" },
  "build": { "tool": "bun", "bunVersion": "1.4.2" }
}
```

**非逐位可复现（实测）**：同一 commit、同一检出连续两次直接 `bun scripts/build-binary.ts` 得到 sha256 `83bd4a7ca3b61c2053c53d6a9b3092f715a38f77d5c9ca94e55a33b25404e9ab` 与 `12f4aee5cd3132eea843c2b638098e909aca6fbacee0194abeba6a35874bfc7a`（`cmp` 在第 81260545 字节不同）；经构建脚本的第三次得到 `a0cf7586…`。因此清单描述**单次构建**，不声明字节可复现；`--check` 校验的是输入（确定性的），不是编译器输出。

---

## 9. 要求 G：文档与仓库检查

| 命令（`app/`） | 结果 |
| --- | --- |
| `node docs/scripts/check-locales.mjs` | exit 0：`Verified 79 English/Chinese specification pairs.` |
| `node docs/scripts/check-docs.mjs` | **exit 1，6 项预存在**（`adr/0301` H1 不以 `ADR` 开头 + `adr/0301`–`0305` 缺索引行）；页数 506 → **507**（新增 ADR 0307），**新增页面零新增问题** |
| `node scripts/check-t20-matrix-ids.mjs` | exit 0：`MATRIX-ID-OK: B1-B14, C1-C8, D1-D3 each appear exactly once` |
| `node scripts/check-architecture.mjs` | **exit 1，预存在**：`apps/desktop/electron/main/index.ts is 1550 LOC; maximum is 1500`（本轮未改该文件） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs` | **exit 1（预期）**：`SUMMARY: 3 gap(s) open [g1, g2, g3]`；R3 未因本轮动摇 |
| `git diff --check`（根仓库） | exit 0 |

文档更新：新增英文 ADR `app/docs/adr/0307-bundled-omp-sidecar.md` + `docs/adr/README.md` 索引行；spec `app/docs/spec/03-runtime/02-agent-runtime.md` §17 与中文镜像 `app/docs/zh-CN/spec/03-runtime/02-agent-runtime.md` §17；`docs/source-baseline.json` 追加日期化 fork 记录（不改历史）；`docs/04-task-board.md` T20 行与新增日期段落、T21 行注记；`HANDOFF.md` 新增 §0 摘要与状态行、下一阶段入口。中文 ADR 镜像按仓库既有惯例未新增（`docs/zh-CN/adr/` 目前仅 1 份 ADR 有镜像）。

---

## 10. 限制与未做（如实记录）

1. **未做真实 electron-builder 打包**：只验证了 `extraResources` 声明、构建产物落入 `resources/omp-runtime/` 与打包态解析逻辑；没有产出安装包，也没有在打包后的应用里启动 sidecar。
2. **平台**：本机 Linux x64 实跑；macOS/Windows 仅以参数化 fixture 覆盖命名（`omp.exe`）与 platform/arch 不符的拒绝，**不声称**这两个平台的打包通过。
3. **非逐位可复现**：见 §8；因此「重复构建清单完全一致」在本轮**不成立**，已在 ADR 0307 与本文件记录，未把它写成通过。
4. **工具门完整性**：`omp-runtime/extensions/omp-desktop-gate.ts` 由构建复制进 Resources，但运行时仍按**存在性**解析（与 M5/T19-A 相同），未纳入 provenance 摘要校验；其完整性依赖应用包自身签名。这是已知限制，不是已实现能力。
5. **打包含量**：sidecar 约 283 MB，未提交进 git（`.gitignore` 覆盖），也**不应**提交；发布产物与 fork commit 的对应关系由 `provenance.json` 声明并由运行时复核，而不是由发布说明保证。
6. **未触碰的范围**：R3 未解除、Cursor 产品门未动、T20-B/C/D 未开始、未实现 Plan/Goal 运行时面、未向 can1357 推送、未合并 main、未创建 PR。
7. **预存在失败**：`check-docs` 6 项、`check-architecture` 1 项，均为起点提交即存在，本轮不做顺带修复。
8. **`upstream/pi-desktop` 与 `upstream/oh-my-pi` 的本地重建**：本次两个子模块工作树由本机 R4A 检出本地 `git clone` 得到（网络 clone 过慢被终止），HEAD 与该 worktree 的 gitlink 完全一致；`git submodule status` 无 `-` 前缀、`git status --porcelain` 为空。

---

## 11. 复核入口

* 构建：`node app/scripts/omp-sidecar.mjs --check --source <fork checkout>` / `--build`。
* 真实产物启动：`OMP_SIDECAR_TEST_RESOURCES=<repo>/app/apps/desktop/resources pnpm --filter @pi-desktop/omp-runtime exec vitest run src/bundled-smoke.test.ts`。
* 桌面全量：`cd app/apps/desktop && env -u SSH_ASKPASS node --test test/*.test.mjs`。
* fork 坐标：`git ls-remote https://github.com/MisterBowie/oh-my-pi refs/heads/codex/omp-desktop-18.3.0-patch-2`。
* 相关文档：`app/docs/adr/0307-bundled-omp-sidecar.md`、`app/docs/spec/03-runtime/02-agent-runtime.md` §17、`app/patches/oh-my-pi/manifest.json`、`docs/validation/M5-omp-18-3-fork-audit.md` §10（R4 验收矩阵）。
