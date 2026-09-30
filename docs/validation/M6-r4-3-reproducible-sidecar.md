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

## 5. GREEN：逐位可复现（2026-10-01 复审返修后在 `6226f80…` 上重跑）

原始证据（两次构建的完整清单、`diff -u`、`sha256sum`/`cmp`、差异区段统计与对照构建记录）保存在
`docs/validation/M6-r4-3-sidecar-provenance/`，按构建原样保留、不做手工编辑。

```
node app/scripts/omp-sidecar.mjs --build --source /home/vv/person/code/omp-fork-m6/oh-my-pi --out /tmp/r43f/green-a
node app/scripts/omp-sidecar.mjs --build --source /home/vv/person/code/omp-fork-m6/oh-my-pi --out /tmp/r43f/green-b
```

| 验收点 | 结果 |
| --- | --- |
| 二进制 SHA-256 | 两者均 `f69ee0b283691bf449e10734775995057cf7b89f4c68bfb077defaeaa7ffe02d` |
| 二进制字节数 | 两者均 283997664 |
| `cmp green-a/omp green-b/omp` | **exit 0**（无任何差异） |
| `diff -u green-a/provenance.json green-b/provenance.json` | **exit 0** |
| 工具门 | 两者均 10112 B、`bb110256984d6588108bd9e656ea3a874e0e81a8d9eb5655d2df129c2505b3f7` |
| 默认输出目录构建（`app/apps/desktop/resources/omp-runtime`） | exit 0，同一 SHA-256（283997664 B） |
| provenance 形态 | `schema /3`、`fork.commit 6226f80…`、tree `5249cb0…`、`patchLevel 62bc57b+omp-desktop.3`、`build {tool: bun, bunVersion: 1.4.2, bytecode: true}`；patch 构件的 sha256/字节数（`ad63ced9…`、87190）由 `manifest.json` + `omp-patch.mjs --check` 证明（provenance schema `/3` 携带 `patchLevel`，不携带 patch digest） |
| 最小 PATH 启动 | `env -i PATH=<空目录> green-{a,b}/omp --version` → 均 `omp/18.3.0`，exit 0 |
| 真实运行时 smoke（opt-in） | `OMP_SIDECAR_TEST_RESOURCES=/tmp/r43f/stage npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts` → **9 passed**：自包含工具门、无 bun/node 亦可运行、`idle`/`runtimeVersion 18.3.0`/`protocolVersion 2`、`get_state` 无费用 RPC、诱饵变量零写入、`stop()` 的 `stopped/reaped/cleaned` 均为真且无残留、篡改工具门被拒、异常死亡与永不 ready 均被回收 |

与上一轮坐标的关系：新提交的两次构建与 `6b5017bc…` 的 green 记录逐位相同（二进制与工具门摘要一致），
因为本轮 fork 变更只有注释、注释不进入编译产物；`provenance.json` 的 `fork.commit`/`tree` 已指向
`6226f80…`，旧坐标只保留在 git 历史与 2026-09-28 的记录中。本轮另测得一个环境敏感项：工具门 bundle 的
按模块路径注释相对构建 cwd 写出，而 sidecar 的构建 cwd 是 `os.tmpdir()` 下的 mkdtemp；把 TMPDIR 换成深
两层的目录后二进制不变、工具门变为 10130 B / `f6a10e7b…`（同一源码、同一 Bun 1.4.2）。记录中的两次
green 均使用默认 `/tmp`；这不改变 R4-3 的结论（同一构建环境下逐位可复现），但把“构建环境”明确为输入的
一部分，属于未修的残留限制（见 §8）。

清单完整性（要求：清单必须表达影响字节的构建模式）：`build` 现在同时记录固定 Bun 版本与编译模式，
`build.bytecode` 是**必填**字段，缺少或类型错误的清单会被 `verifyBundledRuntime` 以
`bundled-runtime-invalid` 拒绝（RED：把 schema 放宽为可选后，该用例立即判红）。

## 6. patch 集合与 fail-closed 校验（2026-10-01 复审返修后重跑）

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

## 7. 测试计数与命令（2026-10-01 复审返修后重跑；Linux x64，Node v24.14.0，Bun 1.4.2）

| 命令 | 结果 |
| --- | --- |
| fork：`bun test packages/natives/test/embed-native.test.ts packages/coding-agent/test/build-binary-bytecode.test.ts` | 5 pass / 0 fail |
| fork：R4A 目标三套件（`agent-loop`、`rpc-host-tools`、`rpc-input-frame`） | 177 pass / 0 fail |
| fork：`packages/natives` 全套 `bun test` | 134 pass / 0 fail（18 文件） |
| fork：`packages/natives` / `packages/coding-agent` 的 `bun run check:types` | 均 exit 0 |
| 打补丁树（`/tmp/r43f/patched-tree`）内新测试 | 5 pass / 0 fail |
| 桌面：`pnpm --filter @pi-desktop/omp-runtime test` | 23 files / **351 passed** / 6 skipped |
| 桌面：`OMP_SIDECAR_TEST_RESOURCES=/tmp/r43f/stage npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts` | **9 passed** |
| 桌面：`node --test apps/desktop/test/{omp-sidecar,omp-runtime-launcher,omp-session-failclosed,ci-workflow,packaging-sidecar-source,macos-release-verification}.test.mjs`（`app/`） | **70 tests / 70 pass / 0 fail** |
| 桌面：`env -u SSH_ASKPASS node --test test/*.test.mjs`（`app/apps/desktop`） | **2953 tests / 2950 pass / 0 fail / 3 skipped** |
| `pnpm build:js`、`--filter @pi-desktop/{shared,omp-runtime,desktop} typecheck` | 全 exit 0 |
| `node app/scripts/omp-patch.mjs --check`（仓库根） | exit 0 |
| `git diff --check` | exit 0 |
| `node docs/scripts/check-docs.mjs`（`app/`） | exit 1，**6 项预存在**（`adr/0301` H1 + `adr/0301–0305` 缺索引行），507 页，无新增 |
| `node docs/scripts/check-locales.mjs`（`app/`） | exit 0（79 对；§17 中英镜像同结构） |
| `node scripts/check-t20-matrix-ids.mjs`（`app/`） | exit 0 |
| `node scripts/check-architecture.mjs`（`app/`） | exit 1（**预存在**：`apps/desktop/electron/main/index.ts` 1550 LOC > 1500；`New TS/TSX files checked: 0`，本轮无新增超限） |
| `OMP_T20_GAP_PROBE=1 node scripts/check-omp-plan-goal-gaps.mjs`（`app/`） | exit 1（**预期**）：`SUMMARY: 3 gap(s) open [g1, g2, g3]` —— R3 未动摇 |

RED/GREEN 的判红判绿对照（2026-09-28 实现的原始测量）：`embed-native` 确定性用例在未修复实现上判红
（收到 `15256271510 ` 而非 `00000000000\0`）；桌面“清单未声明构建模式”用例在把 schema 放宽为可选后
判红；改动前的 `build-binary.ts` 对 `--no-bytecod` 静默继续构建（exit 0），改动后 exit 2 并指名参数。

## 8. 状态更新与仍有限制

- R4-3 **已满足**（2026-09-28 首次闭合，2026-10-01 复审返修在 `6226f80…` 上重跑、结论不变）：
  `docs/validation/M5-bundled-sidecar.md` §10 的未决阻塞项在本节被日期化闭合，历史结论保留原样；
  ADR 0307、spec §17（中英）与任务板同步更新。
- **未动摇**：R3 仍阻塞、ADR 0306 的 Cursor 产品门保留、T20-B/C/D 未开始、**T20/T21 均未完成**、
  未向 can1357 推送、未合并 main、未建 PR、未调用真实付费模型。
- 限制：仅在 Linux x64 实跑；未跑 electron-builder 真实打包、未做 macOS/Windows 实机、未在 clean
  runner 实跑 packaging workflows（仍由静态契约测试 + manifest pin 比对锁定）；RED 用的 fork 检出是
  本机重建（基座对象来自固定子模块对象库，fork 增量经代理取回）。
- 未修的环境敏感项（2026-10-01 实测）：工具门 bundle 由 `bun build` 生成，其按模块的路径注释相对构建
  cwd 写出，而 sidecar 的构建 cwd 是 `os.tmpdir()` 下的 mkdtemp；同一 TMPDIR 深度下逐位一致，深两层会
  改变工具门字节（10112 → 10130 B、`f6a10e7b…`），二进制不受影响。修法（如把 gate build 的 cwd 固定为
  检出或包目录）属于后续变更，本轮复审返修不改 `omp-sidecar.mjs` 行为。
- 依赖事实：PR 42151 已并入 Bun main 但**未进入 release**（最新 1.4.2）；本构建未使用
  `--splitting`。若将来升级 Bun 后 bytecode 输出形态变化，需按 §3.2 的对照实验重新测量，再决定是否
  改用 `--no-bytecode`（该入口已在 fork 中提供并测试，fail closed）。
