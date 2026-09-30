# M6 / T20-R4-3：可复现的 sidecar 构建（R4-3 闭合）

本记录闭合 M5/T20-R4B 遗留的唯一阻塞项 R4-3 的可复现条款：**相同输入重复构建必须产生逐位相同的
sidecar 与相同的 provenance 清单**，同时保留 remote/commit 的 fail-closed 校验。R3 未解除、ADR 0306
的 Cursor 产品门保留、T20-B/C/D 未开始、T21 未完成；本记录不使用真实付费模型。

- 桌面分支：`codex/m6-r4-3-reproducible-sidecar`（自 M5/T20-R4B 基线
  `f2dd40380d17ce1493315b376ef493dcdb765895` 起单线追加，不 amend/rebase/强推）
- 受控 fork：`MisterBowie/oh-my-pi`，分支 `codex/omp-desktop-18.3.0-patch-3`，commit
  `6226f805e92654344de04def413fa5cb91cb16b9`（tree `5249cb07059b009e890bece6f7d59daeb1cb94f6`）
  = can1357 `62bc57be1b03ef0802a33cf7f5f530e534527531`（omp/18.3.0）+ patch level
  `62bc57b+omp-desktop.3`（can1357 只作只读上游，未向其推送）
- 补丁构件：`app/patches/oh-my-pi/0001-omp-desktop-runtime.patch`（重命名自
  `0001-rpc-host-tool-transition-contract.patch`，因为 .3 起它不再只是 RPC 契约），
  sha256 `ad63ced9f7488ff088194754b4902732e1e7ebd0bdfa10a7926b3c5dc1beeaa9`、87190 字节、15 文件
- 2026-10-01 独立复审返修：fork 仅改两处 bytecode 文档注释（新提交 `6226f80…`，行为不变），补丁按
  显式 `git -c core.abbrev=7` 重生成，桌面 pins/工作流/证据随之更新。被取代的坐标（fork `6b5017bc…`、
  sha256 `27b19f19…`、86789 字节）只作为历史保留在 git 与 2026-09-28 的坐标记录中；与旧提交绑定的
  测量（§2 RED、§3 对照）按其原始提交标注，§5-§7 的验收/校验/计数已在本轮新坐标上重跑。
- 2026-10-01 第二次独立复审返修（工具门输出确定性，§9）：gate 编译 cwd 从瞬时 `mkdtemp` 运行根固定为
  工具门自身目录，新增跨 TMPDIR 深度的生产路径回归；两次真实构建（不同输出目录、不同深度 TMPDIR）的
  二进制与工具门 `cmp` exit 0、完整 provenance `diff -u` exit 0。工具门摘要由 10112 B/`bb110256…`
  变为 9897 B/`89c2d844…`（二进制仍为 283997664 B/`f69ee0b2…`）；修复前的深度敏感观测保留为日期化
  RED（§9.1 与 `.../depth-red/`）。
- 环境：Linux x64、Node v24.14.0、pnpm 10.34.5、**Bun 1.4.2**、git 2.x；网络经
  `http://127.0.0.1:7897`（任务书给的 `:7890` 未监听，与上一轮审计一致）
- fork 检出：`/home/vv/person/code/omp-fork-m6/oh-my-pi`（`origin` = 受控 fork；基座对象取自
  `upstream/oh-my-pi` 的本地对象库，fork 增量经代理从 GitHub 取回）

---

## 1. 先核对真实实现（任务要求 1-4）

| 证据源 | 事实（本轮观察） | 强度 |
| --- | --- | --- |
| PI Desktop `upstream/pi-desktop` @ `0111e306` | `packages/agent-runtime/package.json:20` 的 `bundle` 用 **esbuild** 产出 `dist-bundle/sidecar.js`（`--platform=node --format=esm --define:PI_BUNDLED_NODE=true`），`apps/desktop/electron/main/agent-sidecar.ts:54` 用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 启动它；`agent-sidecar.ts` 内 `grep -ni version` 无命中（无版本校验） | 观察 |
| PI Desktop 为什么没有同类归档差异 | PI 打包 lane 只做上格的 esbuild JS bundle，不做 Bun 单文件编译，**不含** OMP `packages/natives` 的 `embedded-addons.<platform>.tar.gz`。OMP 侧该归档由 `packages/natives/scripts/embed-native.ts` 生成，并经生成的 `native/embedded-addon.js` 以 `import archivePath from "../native/<archive>" with { type: "file" }` 原样内嵌进编译产物（`native/loader-state.js:8` 只读条目名/大小/负载）——所以 `Bun.Archive` 的 mtime 不确定性只会在 OMP lane 进入二进制，PI lane 没有这条路径 | 观察 |
| PI Desktop 测试 | `apps/desktop/test/agent-runtime-bundle-package.test.mjs` 只断言 extraResources 映射、bundle 脚本包含 esbuild/`--format=esm`/`--outfile`、链式写出的 `package.json` 为 `{"type":"module"}`、`--define:PI_BUNDLED_NODE=true`；**没有任何逐位稳定/确定性断言**（文件头自述“deliberately avoids running full esbuild”） | 观察 |
| OMP `build-binary.ts` / `compile-binary.ts` | `compileCodingAgent` 原本硬编码 `bytecode: true`，且**没有**任何关闭入口；`build-binary.ts` 原本完全忽略 argv | 观察 |
| `nornzach/oh-my-pi-gui` | 审计用的 `81b9f2507` **不可达**（`git fetch` 报 `couldn't find remote ref`，commit 页 404），本轮改为核对默认分支 tip `313279965a30b14505934a78b584fedb095f117b`（2026-09-26）：`scripts/build-bundled-omp.ts:301` 调用 `compileCodingAgent()` 且**不传** `bytecode`；全仓 `grep -rn bytecode`、`grep -rni sha256` 均无命中；README 第 7 步要求维护者**手工**“Record the monorepo commit”，没有 provenance 清单、没有 digests、没有重建一致性测试；`src/main/index.ts:67` 的 `OMP_BUNDLED_OMP` 与 `OMP_SIDECAR=source` 都**没有** `app.isPackaged` 门（`isPackaged` 只用于错误文案分支），但确实不从 `PATH` 解析 `omp` | 观察 |
| Bun PR `oven-sh/bun#42151` | 已合并（`mergedTime` 2026-09-11T00:11:05Z），**未进入任何 release**（最新 tag/release 仍是 v1.4.2）；作者自述只有在 `--compile --bytecode --splitting` **同时**出现时才不可复现（`--splitting` 无 bytecode、或 `bytecode` 无 `--splitting` 当时已可复现）；根因是 chunk 之间的占位符被 intern 进字符串表 | 观察 |

**因此不能把 nornzach 的流程写成 R4-3 已解决**：它有内置 Bun 二进制与无系统回退，但没有 provenance
校验、没有重复构建一致性测试。本轮也不把它当作对照基线。

## 2. RED：基线（patch-2 = `3c845eb2`）重复构建不一致

命令（两次独立输出目录，同一 fork commit、同一检出、同一 Bun 1.4.2）：

```
node app/scripts/omp-sidecar.mjs --build --source /home/vv/person/code/omp-fork-m6/oh-my-pi --out /tmp/r43/red-a
node app/scripts/omp-sidecar.mjs --build --source /home/vv/person/code/omp-fork-m6/oh-my-pi --out /tmp/r43/red-b
```

| 观测 | 结果 |
| --- | --- |
| 二进制 SHA-256 | A `fb96afe54a8864703bf14013b5993e73d1bc0e32b3713fedeba2b3cf8304560d`；B `b64d84a6911f35eb15c6f431f4360b9b25aaf821865d01287330ff91c51d795f` |
| 字节数 | 两者均 283559392 |
| `cmp` | **exit 1，首个差异在第 81260681 字节**（0-based 偏移 81260680） |
| 差异规模 | 12417 个差异区段、共 3211416 字节，范围 81260680–283501977 |
| provenance `diff -u` | **exit 1**，唯一差异行是 `binary.sha256` |
| 两产物可运行 | 最小 PATH（空目录）下 `omp --version` 均输出 `omp/18.3.0`、exit 0；用生产监督器（`OmpRuntimeSupervisor`）直接启动两者：`phase: idle`、`runtimeVersion 18.3.0`、`protocolVersion 2`、`get_state` 成功、隔离诱饵零写入、`stop()` 返回 `{stopped:true,reaped:true,cleaned:true}` 且 0 条残留 run 记录 |

差异字节的结构（`docs/validation/` 之外的原始产物保存在 `/tmp/r43/`，本节给出可复核片段）：

```
首差异（81260632..81260732）:
A: …8ccb3cc364000000 ea0966eaffffff7f … 9f102b02ffffff7f 27000000 9e96a100ffffffff 28a2190008000000
B: …8ccb3cc364000000 08b86f84ffffff7f … 9f102b02ffffff7f 27000000 7d140100ffffffff 28a2190008000000
（形如 0x7fffffff_xxxxxxxx 的 8 字节字：JSC 字节码/字符串表项随内嵌资产移动）

124971816..124971915（内嵌资产的 bunfs 名）:
A: …/$bunfs/root/embedded-addons.linux-x64.tar-d8wq
B: …/$bunfs/root/embedded-addons.linux-x64.tar-6vvy
```

## 3. 结构化定位（任务要求：不得只引用 PR，必须在本构建上验证）

### 3.1 内嵌原生插件归档不是逐位稳定的

`packages/natives/scripts/embed-native.ts` 用 `new Bun.Archive(entries, { compress: "gzip", level: 9 })`
生成 `packages/natives/native/embedded-addons.<platform>.tar.gz`，再由生成模块以
`import archivePath from "../native/<archive>" with { type: "file" }` 内嵌进二进制。同一份输入连续两次
运行 `bun scripts/embed-native.ts`：

| 观测 | 结果 |
| --- | --- |
| 归档 SHA-256 | `85279643af29babbb33433e611eb356980be6c1db5166ca8ca175f9ecae2e161`（88695390 B） vs `171d16ad7e6bac46e165a362fb4851429300162d3dd751fadef099b5134b6ff5`（88695392 B） |
| `cmp` | 第 13 字节起不同（gzip 负载；gzip 头 mtime 字段为 0） |
| 解压后的 tar | 逐字节比较**只有 4 字节不同**：两个 512 字节块里 136..148 的 mtime 字段（`…57` vs `…66`，相差 7 秒 = 两次运行之间的墙钟差），以及随它变化的头部校验和 |
| `Bun.Archive` 的字段布局（内存条目的探针） | `name@0`、`size@124(12)`、**`mtime@136(12) = now()`**、`checksum@148(8)`、`typeflag@156 = '0'` |

即：`Bun.Archive` 把“写归档的时刻”写进每个条目。该归档被原样内嵌 → bunfs 资产内容变化 → 资产名后缀
（内容哈希）变化 → 引用了该资产的字节码字符串表一起移动。这解释了 RED 里“字节码区域先于归档区域
出现差异”的现象。

### 3.2 bytecode 不是本次构建的原因（对照实验）

| 实验 | 命令 | 结果 |
| --- | --- | --- |
| Bun 1.4.2 最小案例（同一输出路径） | `bun build --compile [--bytecode] --outfile same.out app.ts` ×2 | `cmp` exit 0（`fb2c3b2d…` 两次）；换成不同输出路径时唯一差异是内嵌的**输出文件名** |
| 归档未修 + bytecode=off | `bun scripts/build-binary.ts --no-bytecode` ×2 | 仍不一致：`e24ffab5…` vs `00e0dbce…`，均 212399584 B，首差异在 93265022 |
| 归档已修 + bytecode=off | 同上 | **逐位一致**（`34ae33023c1fcc9ad0c6a9d335177f90eb4811b9b3b68292fa63e1636881176c` ×2） |
| 归档已修 + bytecode=on（默认） | `bun scripts/build-binary.ts` ×2 | **逐位一致**（`f69ee0b283691bf449e10734775995057cf7b89f4c68bfb077defaeaa7ffe02d` ×2） |

结论：本构建**不使用** `--splitting`（`compileCodingAgent` 未设置该选项），因此 PR 42151 覆盖的组合
在此不成立；Bun 1.4.2 的 bytecode 输出对同一输入是可复现的。此前“关掉 bytecode 是唯一出路”的假设被
上述对照推翻，**故不使用 `--no-bytecode` 作为桌面发布模式**：bytecode 是上游 release 行为与快速启动
路径（`--version` 约 30 ms vs 256 ms，+52 MB 体积），在没有可复现性收益的情况下去掉它是无谓的行为退化。

## 4. 实现（最小、显式、可测试）

### 4.1 受控 fork（patch level `62bc57b+omp-desktop.3`，5 文件）

| 文件 | 变更 |
| --- | --- |
| `packages/natives/scripts/embed-native.ts` | 新增 `buildAddonArchive()`：仍用 `Bun.Archive` 生成 tar 布局，随后把每个头部的 mtime 归一化为 `0` 并**重算头部校验和**，最后用 `Bun.gzipSync(tar, { level: 9 })` 压缩。运行期提取器（`native/loader-state.js`）只读条目名、大小与负载，`isEmbeddedAddonFileCurrent` 也只比大小，因此该字段无语义依赖 |
| `packages/coding-agent/scripts/compile-binary.ts` | 新增类型化选项 `CodingAgentCompileOptions.bytecode?: boolean`（默认仍为 `true`），`Bun.build` 使用 `options.bytecode ?? true`；**不读环境变量** |
| `packages/coding-agent/scripts/build-binary.ts` | 新增严格参数解析 `parseBuildBinaryArgs(argv)` 与 `BuildBinaryArgsError`：只接受 `--bytecode` / `--no-bytecode`，每轴至多一次；未知或重复开关打印 `OMP-BUILD-ARGS …` 并 `exit 2`（改动前 `bun … --no-bytecod` 会被静默忽略并照常构建，exit 0） |
| `packages/natives/test/embed-native.test.ts` | 新增：同一批 addon 两次嵌入得到**逐位相同**的归档（并断言首个 ustar 头的 mtime 为 `00000000000\0`，该断言在未修复实现上判红）；归档仍能被 `native/loader-state.js` 的 `extractEmbeddedAddonArchive` 正常解出且字节一致 |
| `packages/coding-agent/test/build-binary-bytecode.test.ts` | 新增：默认 `true`、`--bytecode` 为 `true`、`--no-bytecode` 为 `false`；未知开关与重复声明抛 `BuildBinaryArgsError` |

### 4.2 桌面侧

| 文件 | 变更 |
| --- | --- |
| `app/scripts/omp-sidecar.mjs` | 新增 `SIDECAR_BYTECODE = true` 与 `buildBinaryArgs(bytecode)`（单一事实来源），构建时**显式**传 `scripts/build-binary.ts --bytecode`；provenance 增加 `build.bytecode`；schema 升为 `omp-desktop.bundled-sidecar/3` |
| `app/packages/omp-runtime/src/bundled.ts` | type/schema 要求 `build.bytecode: boolean`（形状强制、取值仍属审计字段）；`BUNDLED_PROVENANCE_SCHEMA = /3`，`/2`、`/1` 一律拒绝 |
| `app/packages/shared/src/engine.ts` | `OMP_RUNTIME_PATCH_LEVEL` → `62bc57b+omp-desktop.3`；`OMP_RUNTIME_FORK_COMMIT` → `6226f80…`（2026-10-01 复审返修更新） |
| `app/patches/oh-my-pi/{manifest.json,0001-omp-desktop-runtime.patch}` | 新 patch level、新 fork 分支/commit/tree、重算的 patch sha256/bytes、15 文件清单、能力项 `reproducible-sidecar-build` 与 `explicit-bytecode-build-mode`、`.2` 的 history 记录、补丁文件重命名说明 |
| `apps/desktop/test/{omp-sidecar,omp-runtime-launcher,omp-session-failclosed}.test.mjs`、`test/helpers/omp-fork-fixture.mjs`、`packages/omp-runtime/src/bundled.test.ts` | 夹具升到 `/3` 并带 `build.bytecode`；新增用例：`/2` 与缺 `build.bytecode`（或类型错误）的清单被拒；桌面入口把模式映射为 fork 接受的两种拼写且发布模式为 `bytecode=true` |
| `.github/workflows/mac-preview-package.yml`、`app/.github/workflows/{release,linux-package}.yml` | fork checkout 的 `ref` 更新为新 fork commit（由 `packaging-sidecar-source.test.mjs` / `preview-workflow.test.mjs` 与清单自动比对） |

## 5. GREEN：逐位可复现（2026-10-01 第二次复审返修后在 `6226f80…` 上重跑，见 §9）

原始证据（两次构建的完整清单、`diff -u`、`sha256sum`/`cmp`、差异区段统计与对照构建记录）保存在
`docs/validation/M6-r4-3-sidecar-provenance/`，按构建原样保留、不做手工编辑。两次构建的输出目录与
TMPDIR 根都不同、深度不同：

```
TMPDIR=/tmp/r43g/tmp-a        node app/scripts/omp-sidecar.mjs --build --source /home/vv/person/code/omp-fork-m6/oh-my-pi --out /tmp/r43g/out-a
TMPDIR=/tmp/r43g/tmp-b/x/y/z  node app/scripts/omp-sidecar.mjs --build --source /home/vv/person/code/omp-fork-m6/oh-my-pi --out /tmp/r43g/out-b
```

| 验收点 | 结果 |
| --- | --- |
| 二进制 SHA-256 | 两者均 `f69ee0b283691bf449e10734775995057cf7b89f4c68bfb077defaeaa7ffe02d` |
| 二进制字节数 | 两者均 283997664 |
| `cmp out-a/omp out-b/omp` | **exit 0**（无任何差异） |
| 工具门 | 两者均 9897 B、`89c2d84451e9b9403afc2169501bbb7a25c42eef607c9c8e88d6d71abed1963c` |
| `cmp out-a/extensions/omp-desktop-gate.js out-b/extensions/omp-desktop-gate.js` | **exit 0** |
| `diff -u out-a/provenance.json out-b/provenance.json` | **exit 0** |
| provenance 形态 | `schema /3`、`fork.commit 6226f80…`、tree `5249cb0…`、`patchLevel 62bc57b+omp-desktop.3`、`build {tool: bun, bunVersion: 1.4.2, bytecode: true}`；patch 构件的 sha256/字节数（`ad63ced9…`、87190）由 `manifest.json` + `omp-patch.mjs --check` 证明（provenance schema `/3` 携带 `patchLevel`，不携带 patch digest） |
| 退出码/耗时 | 两次构建均 exit 0（各约 13 s，本机 Bun 1.4.2、热缓存） |
| 真实运行时 smoke（opt-in） | `OMP_SIDECAR_TEST_RESOURCES=/tmp/r43g/stage npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts` → **9 passed / exit 0**：自包含工具门、无 bun/node 亦可运行、`idle`/`runtimeVersion 18.3.0`/`protocolVersion 2`、`get_state` 无费用 RPC、诱饵变量零写入、`stop()` 的 `stopped/reaped/cleaned` 均为真且无残留、篡改工具门被拒、异常死亡与永不 ready 均被回收 |

与上一轮的关系：二进制摘要与 `6b5017bc…`/`6226f80…` 的 green 记录逐位相同（fork 注释与编译 cwd 都不
进入二进制产物）；工具门摘要从 10112 B/`bb110256…` 变为 9897 B/`89c2d844…`，因为本轮把 gate build 的
cwd 从瞬时运行根固定为工具门自身目录（§9.2）。此前观测到的深度敏感（10112 → 10130 B）作为日期化 RED
保留在 §9.1 与 `.../depth-red/`。清单完整性（`build.bytecode` 必填，`/2`、`/1` 拒绝）不变。本节的等价性
范围是同一 fork commit、同一检出配置、同一 Bun 1.4.2、同一目标平台/架构（Linux x64）；不宣称跨工具链
版本或跨目标平台的字节等价。

清单完整性（要求：清单必须表达影响字节的构建模式）：`build` 现在同时记录固定 Bun 版本与编译模式，
`build.bytecode` 是**必填**字段，缺少或类型错误的清单会被 `verifyBundledRuntime` 以
`bundled-runtime-invalid` 拒绝（RED：把 schema 放宽为可选后，该用例立即判红）。

## 6. patch 集合与 fail-closed 校验（2026-10-01 复审返修后重跑）

> 2026-10-01 第二次复审返修未改 fork、补丁构件、manifest pins 或 packaging workflow；本节只作为上一轮的
> 日期化证据保留，本轮复跑了 `node scripts/omp-patch.mjs --check`（exit 0，见 §7）。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 补丁重生成（显式缩写） | `git -C <fork> -c core.abbrev=7 diff 62bc57be… 6226f80… > app/patches/oh-my-pi/0001-omp-desktop-runtime.patch`，同一命令再输出到临时文件 | 两次输出 `cmp` exit 0（逐字节可重生成）；sha256 `ad63ced9f7488ff088194754b4902732e1e7ebd0bdfa10a7926b3c5dc1beeaa9`、87190 字节、15 文件 |
| patch-id 稳定 | `git patch-id --stable < <patch>` vs `git -c core.abbrev=7 diff 62bc57be… 6226f80… \| git patch-id --stable` | 两者均 `83fb26954ab5e76753902c038f943acbd013fdd6` |
| 补丁前向应用 | 基座 `62bc57be…` 的临时 worktree 中 `git apply --check <patch>` | exit 0（临时 worktree 已移除） |
| 文件集一致 | `git -C <fork> diff --name-only 62bc57be… HEAD \| sort` vs `manifest.files`（sort） | `diff -u` exit 0，15 文件完全一致 |
| 补丁反向应用 | `git -C <fork> apply --check --reverse app/patches/oh-my-pi/0001-omp-desktop-runtime.patch` | exit 0 |
| 清单工具 | `node scripts/omp-patch.mjs --check` | exit 0（`OMP-PATCH-OK 62bc57b+omp-desktop.3`，补丁 sha256/字节数与清单一致） |
| 打补丁树可用 | `node scripts/omp-patch.mjs --apply --out /tmp/r43f/patched-tree --prepare-build --verify` | exit 0：launcher 18.3.0，**162 pass / 0 fail**；同一树内新测试 **5 pass** |
| 错误 remote | `git -C <fork> remote set-url origin https://github.com/can1357/oh-my-pi` 后 `omp-sidecar.mjs --build …`（随后恢复 origin） | exit 1：`OMP-SIDECAR-FAIL source origin is github.com/can1357/oh-my-pi, expected github.com/misterbowie/oh-my-pi (https://github.com/MisterBowie/oh-my-pi)`；**输出目录未被创建**（未进入编译） |
| 错误 commit | 基座 `62bc57be…` 的临时 worktree 作为 `--source` 同上 | exit 1：`OMP-SIDECAR-FAIL source HEAD is 62bc57be1b03ef0802a33cf7f5f530e534527531, the manifest pins fork commit 6226f805e92654344de04def413fa5cb91cb16b9`；输出目录未被创建 |

两种拒绝都发生在任何编译器运行之前；`--source` 的临时 worktree 与 origin 变更都在同一条命令内恢复，事后 fork 检出
`git status --porcelain` 为空、`git worktree list` 只剩主检出。

打包态准入、gate 摘要、版本/协议断言、隔离与进程回收行为均未改动，沿用 R4B 已验收的规则。

## 7. 测试计数与命令（2026-10-01 第二次复审返修后重跑；Linux x64，Node v24.14.0，Bun 1.4.2）

| 命令 | 结果 |
| --- | --- |
| fork：`bun test packages/natives/test/embed-native.test.ts packages/coding-agent/test/build-binary-bytecode.test.ts` 等 | **上轮实跑**（5 pass、R4A 三套件 177 pass、natives 全套 134 pass / 18 文件、两包 `check:types` exit 0、打补丁树内新测试 5 pass）；本轮无 fork/补丁变更，按约定未重跑 |
| 桌面：`pnpm --filter @pi-desktop/omp-runtime test` | 23 files / **351 passed** / 6 skipped |
| 桌面：`OMP_SIDECAR_TEST_RESOURCES=/tmp/r43g/stage npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts` | **9 passed / exit 0** |
| 桌面：`node --test apps/desktop/test/{omp-sidecar,omp-runtime-launcher,omp-session-failclosed,ci-workflow,packaging-sidecar-source,macos-release-verification}.test.mjs`（`app/`） | **71 tests / 71 pass / 0 fail**（含新增跨 TMPDIR 深度回归） |
| 桌面：`env -u SSH_ASKPASS node --test test/*.test.mjs`（`app/apps/desktop`） | **2954 tests / 2951 pass / 0 fail / 3 skipped / exit 0** |
| `pnpm build:js`、`--filter @pi-desktop/{shared,omp-runtime,desktop} typecheck` | 全 exit 0 |
| `node app/scripts/omp-patch.mjs --check`（仓库根） | exit 0（本轮另实测：`--check` 通过，fork/patch 未改） |
| `git diff --check` | exit 0 |
| `node scripts/check-release-docs.mjs`（`app/`） | exit 0（与 0.15.2 对齐） |
| `node docs/scripts/check-docs.mjs`（`app/`） | exit 1，**6 项预存在**（`adr/0301` H1 + `adr/0301–0305` 缺索引行），507 页，无新增 |
| `node docs/scripts/check-locales.mjs`（`app/`） | exit 0（79 对；§17 中英镜像同结构） |
| `node scripts/check-t20-matrix-ids.mjs`（`app/`） | exit 0 |
| `node scripts/check-architecture.mjs`（`app/`） | exit 1（**预存在**：`apps/desktop/electron/main/index.ts` 1550 LOC > 1500；`New TS/TSX files checked: 0`，本轮无新增超限） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs`（`app/`） | exit 1（**预期**）：`SUMMARY: 3 gap(s) open [g1, g2, g3]` —— R3 未动摇 |

RED/GREEN 的判红判绿对照：本轮新增回归在未修复实现上判红（两次工具门 Buffer 不等，§9.1），修复后
9 pass；`embed-native` 确定性用例在未修复实现上判红（收到 `15256271510 ` 而非 `00000000000\0`）；桌面
“清单未声明构建模式”用例在把 schema 放宽为可选后判红；改动前的 `build-binary.ts` 对 `--no-bytecod` 静默
继续构建（exit 0），改动后 exit 2 并指名参数。

## 8. 状态更新与仍有限制

- R4-3 **已满足**（2026-09-28 首次闭合；2026-10-01 第一次复审返修在 `6226f80…` 上重跑、结论不变；
  同日第二次返修把工具门的构建上下文固定为源码目录，并在不同 TMPDIR 深度/不同输出目录下重跑全部
  构建验收，见 §9）：
  `docs/validation/M5-bundled-sidecar.md` §10 的未决阻塞项在本节被日期化闭合，历史结论保留原样；
  ADR 0307、spec §17（中英）与任务板同步更新。
- **未动摇**：R3 仍阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、**T20/T21 均未完成**、
  未向 can1357 推送、未合并 main、未建 PR、未调用真实付费模型。
- 限制：仅在 Linux x64 实跑；未跑 electron-builder 真实打包、未做 macOS/Windows 实机、未在 clean
  runner 实跑 packaging workflows（仍由静态契约测试 + manifest pin 比对锁定）；RED 用的 fork 检出是
  本机重建（基座对象来自固定子模块对象库，fork 增量经代理取回）。
- 工具门的环境敏感项已由 2026-10-01 第二次复审返修修复（§9）：gate build 的 cwd 固定为工具门自身
  目录，同一源码不再随 TMPDIR 深度或检出位置改变字节；修复前的 10112 → 10130 B 观测保留为日期化 RED
  （§9.1 与 `.../depth-red/`）。
- 依赖事实：PR 42151 已并入 Bun main 但**未进入 release**（最新 1.4.2）；本构建未使用
  `--splitting`。若将来升级 Bun 后 bytecode 输出形态变化，需按 §3.2 的对照实验重新测量，再决定是否
  改用 `--no-bytecode`（该入口已在 fork 中提供并测试，fail closed）。

---

## 9. 2026-10-01 第二次独立复审返修：工具门构建上下文固定（R4-3 输出确定性边界）

独立复审在 macOS（Bun 1.4.2）上用同一份 gate 源码复现：不同 `TMPDIR` 深度下工具门字节与 SHA-256 不同，
diff 只有模块路径注释；把编译 cwd 换成 gate 源码目录后两次都得 9897 B/同一 SHA-256（复审机数值）。其
结论是：只通过默认 `TMPDIR` 的重复构建对“可复现构建”边界来说太窄。本轮按该要求复现、修复并重跑验收。

### 9.0 与 PI Desktop 的对照（避免错误宣称）

复核 `upstream/pi-desktop` @ `0111e306`：`packages/agent-runtime/package.json` 的 `bundle` 用 esbuild、
以包目录为上下文（相对路径 `src/sidecar.ts` → `dist-bundle/sidecar.js`）；
`packages/agent-runtime/src/extensions/bundle.test.ts` 的两个 describe（E2E-245 与 packaged sidecar
loader）都在 `mkdtemp` 工作目录里构建 bundle 并从仓库外的目录加载 TS 扩展，但没有重复构建、跨
TMPDIR 或哈希一致性断言。PI 没有与本项相同的 OMP Bun gate 构建器，因此**不能**把 PI 写成已有
重复哈希测试；本项检查在 OMP lane 才必要。

### 9.1 RED（生产路径与字节级复现，均在 `d1a73205` 的未修复实现上）

- 生产路径：新增回归用例经真实 CLI 两次构建（仅 TMPDIR 深度不同，见 §9.3）→ `node --test
  apps/desktop/test/omp-sidecar.test.mjs` **1 failed / exit 1**，`AssertionError: the gate bundle must
  not depend on the run root`（两份工具门 Buffer `deepStrictEqual` 不等）；原始输出
  `docs/validation/M6-r4-3-sidecar-provenance/depth-red/regression-red.txt`。
- 字节级：与生产相同的 gate 命令（`bun build <gate> --target=bun --outfile …`，cwd 为 `mkdtemp` 运行
  根）在两组不同深度的运行根下得到 10130 B/`f6a10e7b…` 与 10157 B/`8340b5b1…`；`cmp` exit 1，
  `diff -u` 只有三处模块路径注释（`../…` 前缀层级不同）。原始 bundle、sha256 与 diff 见
  `.../depth-red/`。此前 2026-09-28 观测的 10112 → 10130 B 保留在 §5/§8 的历史文本中。
- 根因：Bun 为每个模块写出相对构建 cwd 的路径注释；未修复实现的 cwd 是 `mkdtemp(os.tmpdir())`，于是
  注释（进而字节与摘要）随 TMPDIR 深度变化，也会泄漏检出绝对路径。

### 9.2 修复（只改编译上下文）

`app/scripts/omp-sidecar.mjs` 新增 `gateContext = dirname(gateSource)`，gate 编译改为
`cwd: gateContext`（工具门自身目录），并注明原因。未改动：`isolatedEnv(runRoot)`（HOME/XDG/profile
隔离）、runRoot 内的运行时探针、watchdog/reaping/清理、权限行为与全部 fail-closed 校验；运行期会话
cwd、bytecode 模式（`SIDECAR_BYTECODE=true`）、loader 回退、provenance schema `/3`、受控 fork 均不变。
稳定上下文使注释固定为 `../src/…` 与 `omp-desktop-gate.ts`：

| 编译 | cwd | 字节 | SHA-256 |
| --- | --- | --- | --- |
| 同一目录两次 | `app/packages/omp-runtime/extensions` | 9897 / 9897 | `89c2d844…` / `89c2d844…` |
| 复制到 `/tmp/r43fix/relocated/deeper/pkg/omp-runtime/extensions` 后编译 | 该副本的 extensions 目录 | 9897 | `89c2d844…` |

即字节不再依赖运行根深度，也不再依赖检出被放在哪里。

### 9.3 回归测试（新增，走生产路径；无 283 MB 编译）

`apps/desktop/test/omp-sidecar.test.mjs` 新增
`the tool gate bundle is identical under temporary roots of different depth`：夹具（tiny git 检出 +
可用的 `build-binary.ts` 假二进制，仍由真实 Bun 执行）经真实 CLI `--build` 两次，`TMPDIR` 指向浅/深
两棵根、输出目录不同；断言两次工具门的**实际字节**与**完整 provenance** 相等，并断言工具门仍是
自包含 bundle（无相对导入）。夹具在 `apps/desktop/test/helpers/omp-fork-fixture.mjs` 中升级：假
build entry 写出一个 `--version` 如真实 sidecar 的极小可执行文件（`dist/` 已 gitignore，后续构建仍
看到干净树），因此每个用例只编译真实工具门，不编译真二进制。

- RED（未修复）：1 failed（§9.1）；GREEN（修复后）：该文件 **9 pass / 0 fail**（用例耗时 110.8 ms）。
- 用例有两个互相独立的 skip 原因：①Bun 缺失（app 的 CI unit-test 作业不安装 Bun）；②**win32**——夹具
  的 `build-binary.ts` 写出并被 `--build` 实际执行的 `#!/bin/sh` 假二进制，Windows 上必然不能执行，
  因此该回归显式 skip 于 win32，原因写明「Windows 原生等价验证留待 T23」。两者同时成立时都记录；
  **skip 是范围边界，不是 Windows 支持证据**。本机（Linux x64）实测命令 `node --test
  apps/desktop/test/omp-sidecar.test.mjs`（`app/`，Node v24.14.0 / Bun 1.4.2）**exit 0，9 pass /
  0 fail / 0 skipped**，新用例实际执行（约 114 ms）。
- macOS arm64 的独立复审（拉回 `6ea1057a`）已在 macOS 实机实跑完整桌面套件 **2954/2954 pass、0 fail /
  0 skip**（含真实 Bun gate 编译回归），确认稳定 cwd 修复生效；该结果来自复审侧实机，不是本工作区
  Linux 运行的计数。

### 9.4 两次完整真实构建（CLI；输出目录与 TMPDIR 根都不同、深度不同）

```
TMPDIR=/tmp/r43g/tmp-a        node app/scripts/omp-sidecar.mjs --build --source /home/vv/person/code/omp-fork-m6/oh-my-pi --out /tmp/r43g/out-a --json
TMPDIR=/tmp/r43g/tmp-b/x/y/z  node app/scripts/omp-sidecar.mjs --build --source /home/vv/person/code/omp-fork-m6/oh-my-pi --out /tmp/r43g/out-b --json
```

| 项目 | out-a | out-b |
| --- | --- | --- |
| 退出码 | 0 | 0 |
| 二进制 | 283997664 B、`f69ee0b2…` | 283997664 B、`f69ee0b2…` |
| 工具门 | 9897 B、`89c2d844…` | 9897 B、`89c2d844…` |

`cmp out-a/omp out-b/omp` **exit 0**；`cmp` 两份工具门 **exit 0**；`diff -u` 两份完整 provenance
**exit 0**（原始输出在 `.../green/`，含两条构建命令的 TMPDIR 根）。fork commit `6226f80…`、tree
`5249cb0…`、patch level `62bc57b+omp-desktop.3`、Bun 1.4.2、bytecode 模式均与原记录一致；二进制逐位
不变说明该修复只影响工具门。

### 9.5 新产物上的真实 smoke（无付费模型）

```
OMP_SIDECAR_TEST_RESOURCES=/tmp/r43g/stage npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts
→ 1 file passed, 9 tests passed, exit 0
```

即 §5 表格中的 9 项：自包含工具门、无 bun/node 亦可运行、`idle`/`runtimeVersion 18.3.0`/protocol v2、
`get_state` 无费用 RPC、诱饵变量零写入、`stop()` 的 `stopped/reaped/cleaned` 与零残留、篡改工具门被拒、
异常死亡回收、永不 ready 清理。

### 9.6 范围与限制

本修复不宣称跨工具链版本（Bun 升级后需按 §3.2 重新测量）或跨目标平台（仅 Linux x64 实跑）的字节
等价；未跑 electron-builder 真实打包、macOS/Windows 实机与 clean-runner packaging workflows，未调用
真实付费模型。gate 深度回归与其夹具 `--build` 路径同样只覆盖 POSIX 宿主：win32 上该用例显式 skip，
Windows 原生等价验证留待 T23（未在 Windows 实机运行，不宣称 Windows 支持）。R3 仍为硬阻塞、ADR 0306
的 Cursor 产品门保留、T20-B/C/D 未开始、T20/T21 未完成；fork 与 patch 构件未改动。
