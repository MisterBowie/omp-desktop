# M6/T20-R4-3 原始证据：sidecar 二进制与 provenance 清单

本目录是 `docs/validation/M6-r4-3-reproducible-sidecar.md` §2/§5/§9 的原始证据，按“构建”原样保留，
不做手工编辑。产物本身（283 MB 二进制与 212 MB 对照产物）不入库，可按下面的命令重建并逐项比对。

## green/ — 修复后（fork `codex/omp-desktop-18.3.0-patch-3` @ `6226f80…`；2026-10-01 工具门上下文返修后重跑）

两次独立构建，**输出目录与 TMPDIR 根都不同、深度不同**：

```
TMPDIR=/tmp/r43g/tmp-a        node app/scripts/omp-sidecar.mjs --build --source <fork checkout> --out /tmp/r43g/out-a
TMPDIR=/tmp/r43g/tmp-b/x/y/z  node app/scripts/omp-sidecar.mjs --build --source <fork checkout> --out /tmp/r43g/out-b
```

| 文件 | 内容 |
| --- | --- |
| `build-a.provenance.json` / `build-b.provenance.json` | 两次构建写出的完整清单（schema `omp-desktop.bundled-sidecar/3`；`fork.commit 6226f80…`、tree `5249cb0…`；`patchLevel 62bc57b+omp-desktop.3`；`build {tool: bun, bunVersion: 1.4.2, bytecode: true}`） |
| `provenance.diff.txt` | `diff -u` 的原始输出：无差异（exit 0） |
| `sha256.txt` | `cmp` 与 `sha256sum` 的原始输出：二进制 `cmp` exit 0、工具门 `cmp` exit 0 |

两次构建的二进制 SHA-256 均为
`f69ee0b283691bf449e10734775995057cf7b89f4c68bfb077defaeaa7ffe02d`（283997664 字节），工具门均为
`89c2d84451e9b9403afc2169501bbb7a25c42eef607c9c8e88d6d71abed1963c`（9897 字节）。

- 二进制与上一轮 fork `6b5017bc…` / `6226f80…` 的 green 记录逐位相同：2026-10-01 的两轮返修只改了
  fork 注释与桌面侧工具门的**编译 cwd**，二者都不进入二进制；`provenance.json` 的 `fork.commit`/`tree`
  已指向新提交（旧值只保留在 git 历史与 2026-09-28 的坐标记录中）。
- 工具门摘要与上一轮不同（`bb110256…`/10112 B → `89c2d844…`/9897 B），这是本轮修复的直接结果：此前
  工具门用瞬时 `mkdtemp` 运行根作为 `bun build` 的 cwd，Bun 的按模块路径注释随 cwd 深度变化；现在固定
  为工具门自身目录（`app/packages/omp-runtime/extensions`），注释是稳定的 `../src/…` 与
  `omp-desktop-gate.ts`。见 `depth-red/` 与验证文档 §9。
- patch 构件的 sha256/字节数（`ad63ced9…`、87190）由 `app/patches/oh-my-pi/manifest.json` 与
  `node scripts/omp-patch.mjs --check` 证明——provenance schema `/3` 携带 `patchLevel`，不携带
  patch digest。

## depth-red/ — 修复前：工具门字节随构建运行根（TMPDIR 深度）变化（2026-10-01 实测）

修复前 `omp-sidecar.mjs` 用 `cwd: runRoot`（`mkdtemp(os.tmpdir())`）编译工具门，Bun 把每个模块的路径
注释写成相对该 cwd 的形式，于是同一源码、同一 Bun 1.4.2 在不同 TMPDIR 深度下产出不同字节：

| 文件 | 内容 |
| --- | --- |
| `regression-red.txt` | 生产路径回归测试在未修复代码上的失败输出（`node --test`，exit 1：两次 CLI 构建的工具门不相等） |
| `gate-shallow.js` / `gate-deep.js` | 与生产命令一致的复现（`bun build <gate> --target=bun --outfile …`，cwd 分别为浅/深运行根）：10130 vs 10157 字节 |
| `sha256.txt` | 两个不同 SHA-256 与 `cmp` exit 1，含复现命令 |
| `gate.diff.txt` | `diff -u` 原文：只有三处模块路径注释（`../…` 前缀层级）不同 |

更早（2026-09-28）的一次观测 10112 → 10130 B 记录在验证文档 §5/§8 的对应小节，保留为当时的日期化
事实；本目录给出的是 2026-10-01 的受控复现与生产路径 RED。修复后的绿色值见 `green/`。

## red/ — 修复前（fork `codex/omp-desktop-18.3.0-patch-2` @ `3c845eb2…`）

同一台机器、同一检出、同一 Bun 1.4.2 的两次构建（内嵌原生插件归档的 mtime 不确定性）：

| 文件 | 内容 |
| --- | --- |
| `build-a.provenance.json` / `build-b.provenance.json` | 两次构建的清单：只有 `binary.sha256` 不同 |
| `provenance.diff.txt` | `diff -u` 的原始输出（exit 1） |
| `sha256.txt` | 两个不同的 SHA-256（283559392 字节）与 `cmp` 的 exit 1 |
| `binary-diff.txt` | 全文件差异区段统计（12417 个区段 / 3211416 字节）、首个差异偏移的十六进制上下文、内嵌 bunfs 资产名（`…tar-d8wq` vs `…tar-6vvy`）与区段长度直方图 |
| `archive.diff.txt` | 根因隔离：未修复的 `embed-native.ts` 两次生成的内嵌 `tar.gz` 哈希/字节数不同，且解压后的 tar 只在两个头的 mtime 字段（与随之变化的校验和）上不同 |

两个 RED 产物都可运行：最小 PATH 下 `--version` 均为 `omp/18.3.0`，经生产监督器启动均到达
`idle`（runtimeVersion `18.3.0`、protocolVersion 2），`get_state` 无费用 RPC 成功，`stop()` 的
`stopped/reaped/cleaned` 均为真且无残留 run 记录（见验证文档 §2）。

## control-builds.txt

四组对照构建（归档修/未修 × bytecode 开/关）与 Bun 1.4.2 最小案例，用来证明“bytecode 不是本次差异
的原因”，并说明 `oven-sh/bun#42151` 覆盖的是本构建未使用的 `--splitting` 组合。

## 复核命令

```
# 重新构建两次并逐位比较（需要受控 fork 检出；命令见上）
cmp <out-a>/omp <out-b>/omp && cmp <out-a>/extensions/omp-desktop-gate.js <out-b>/extensions/omp-desktop-gate.js
diff -u <out-a>/provenance.json <out-b>/provenance.json
# 清单与 patch 一致性
node app/scripts/omp-sidecar.mjs --check --source <fork checkout>
node app/scripts/omp-patch.mjs --check
# 真实产物 smoke（opt-in，无付费模型；<resources> 必须包含名为 omp-runtime 的目录）
OMP_SIDECAR_TEST_RESOURCES=<resources> npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts
```

修复后的 scope：以上等价性只覆盖同一 fork commit、同一桌面检出配置、同一 Bun 1.4.2、同一目标平台/
架构（Linux x64）；不宣称跨工具链版本或跨目标平台的字节等价。未跑 electron-builder 真实打包、
macOS/Windows 实机，未调用真实付费模型。
