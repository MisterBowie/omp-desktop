# M6/T20-R4-3 原始证据：sidecar 二进制与 provenance 清单

本目录是 `docs/validation/M6-r4-3-reproducible-sidecar.md` §2/§5 的原始证据，按“构建”原样保留，
不做手工编辑。产物本身（283 MB 二进制与 212 MB 对照产物）不入库，可按下面的命令重建并逐项比对。

## green/ — 修复后（fork `codex/omp-desktop-18.3.0-patch-3` @ `6226f80…`；2026-10-01 复审返修后重跑）

两次独立构建（默认 TMPDIR，输出 `/tmp/r43f/green-{a,b}`）：

```
node app/scripts/omp-sidecar.mjs --build --source <fork checkout> --out <out-a>
node app/scripts/omp-sidecar.mjs --build --source <fork checkout> --out <out-b>
```

| 文件 | 内容 |
| --- | --- |
| `build-a.provenance.json` / `build-b.provenance.json` | 两次构建写出的完整清单（schema `omp-desktop.bundled-sidecar/3`；`fork.commit 6226f80…`、tree `5249cb0…`；`patchLevel 62bc57b+omp-desktop.3`；`build {tool: bun, bunVersion: 1.4.2, bytecode: true}`） |
| `provenance.diff.txt` | `diff -u` 的原始输出：无差异（exit 0） |
| `sha256.txt` | `sha256sum` 与 `cmp` 的原始输出：二进制相同、`cmp` exit 0，均 283997664 字节 |

两次构建的二进制 SHA-256 均为
`f69ee0b283691bf449e10734775995057cf7b89f4c68bfb077defaeaa7ffe02d`，工具门均为
`bb110256984d6588108bd9e656ea3a874e0e81a8d9eb5655d2df129c2505b3f7`（10112 字节）。

这两个值与上一轮 fork `6b5017bc…` 的 green 记录相同：2026-10-01 的复审返修只改了 fork 的注释，
注释不进入编译产物，因此同一构建环境下二进制逐位相同；`provenance.json` 的 `fork.commit`/`tree`
已指向新提交（旧值只保留在 git 历史与 2026-09-28 的坐标记录中）。patch 构件的 sha256/字节数
（`ad63ced9…`、87190）由 `app/patches/oh-my-pi/manifest.json` 与 `node scripts/omp-patch.mjs --check`
证明——provenance schema `/3` 携带 `patchLevel`，不携带 patch digest。

## red/ — 修复前（fork `codex/omp-desktop-18.3.0-patch-2` @ `3c845eb2…`）

同一台机器、同一检出、同一 Bun 1.4.2 的两次构建：

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
cmp <out-a>/omp <out-b>/omp && diff -u <out-a>/provenance.json <out-b>/provenance.json
# 清单与 patch 一致性
node app/scripts/omp-sidecar.mjs --check --source <fork checkout>
node app/scripts/omp-patch.mjs --check
# 真实产物 smoke（opt-in，无付费模型；<resources> 必须包含名为 omp-runtime 的目录）
OMP_SIDECAR_TEST_RESOURCES=<resources> npx vitest run packages/omp-runtime/src/bundled-smoke.test.ts
```

注（本轮实测的环境敏感项）：工具门 bundle 由 `bun build` 生成，其按模块的路径注释相对构建 cwd 写出，
而 sidecar 用 `os.tmpdir()` 下的 mkdtemp 作为构建 cwd；因此同一 TMPDIR 深度下两次构建逐位一致，换用
更深的 TMPDIR 会改变工具门字节（实测深两层 → 10130 字节、`f6a10e7b…`）。二进制不受影响：它在检出内
以固定 cwd 编译。记录中的两次 green 构建均使用默认 `/tmp`。
