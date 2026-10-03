# M5 三平台测试包：R4 返修（真实 pnpm→发布入口参数边界）

2026-10-03。分支 `codex/m5-three-platform-packages`；基线（精确干净）`f5cdd276c79eda300b132f7afdd2f1bbeb78bdce`；
R4 代码提交 `13fe13958884ab68959ac629d48b36ff851d7df4`（父提交即基线）；本轮**不创建/不移动 tag、不触发 Actions、不创建 Release、不改 main、不建 PR**。
固定子模块 PI `0111e306`、OMP `62bc57be` 与受控 fork `36483311…`（补丁级 `.5`）均未动。模型调用：**零**。

## 1. 现象与根因（根已实证）

首次 native CI run `37133058318`（tag `m5-test-20261003-f5cdd276`，Linux job `111231905109`）在打包步骤失败：

```text
RELEASE-PACKAGE-FAIL the release entry does not support "--": it would hide the rest of the command line from electron-builder
pnpm ... run dist:linux: `... node ../../scripts/release-package.mjs --platform linux --publish never -- --x64`
Exit status 2
```

根因：`pnpm run <script> <args>` 把 `<args>` 追加到脚本命令链的**末尾**（即链尾的 `scripts/release-package.mjs`），而链尾入口拒绝独立 `--`（它会挡住 electron-builder 需要看到的其余命令行）。`-- --x64` 因此把分隔符原样送进生产入口并 exit 2；`--x64` 才是同一架构参数的正确拼写。固定 PI 的 `upstream/pi-desktop/.github/workflows/release.yml` 同样写 `-- --arch`，但其链尾是 electron-builder 本体（接受 `--`），直接照搬命令文本不适合本产品入口。

## 2. 修复（仅两个文件）

| 文件 | 变更 |
| --- | --- |
| `.github/workflows/three-platform-test-packages.yml` | 打包步骤调用改为 `pnpm --filter @pi-desktop/desktop run ${{ matrix.dist }} --${{ matrix.arch }}`（去掉了独立的 `--`），并在步骤注释中记录 argv 边界与 run `37133058318` 的失败原文。显式架构保留；`--publish never` 仍在 `dist:*` 脚本内。 |
| `app/apps/desktop/test/three-platform-package-workflow.test.mjs` | ①原静态断言（`:168`）此前锁定的正是错误的 `-- --${{ matrix.arch }}` 文本，改为锁定直接传架构的调用，并新增“构建作业内不得出现独立 `-- --`”断言；②新增执行测试 “the packaging invocation reaches the production parser for each matrix target”。 |

**未改**：`app/scripts/release-package.mjs` 的解析/拒绝守卫、`app/scripts/omp-sidecar.mjs`、`dist:*` 脚本、sidecar 预检、builder 参数来源、fork/补丁 pin、bundler 资源、Plan/Goal 契约。

新增执行测试的断言强度（不是文本匹配）：

- 从工作流**自身**读取 build 矩阵（`darwin/arm64`、`win32/x64`、`linux/x64`）与打包调用的 run 模板，按矩阵渲染；
- 在仓库外的临时夹具工作区里，用**真实 `app/apps/desktop/package.json`** 的 `dist:*` 链尾（`--platform <p> --publish never`）配出两段命令链，链尾为导入**生产 `parseReleaseArgs`** 的探针；
- 用真实 pnpm（`pnpm run` 环境下取 `npm_execpath`，否则取 PATH 上的 pnpm）执行渲染后的调用：必须 exit 0，`parsed` 恰为 `{platform, arch, dir:false, publish:"never", forwarded:[]}`，且 `--platform`/`--publish`/`--<arch>` 各**只出现一次**、argv 中不存在独立 `--`；
- **负对照**：把旧式 `-- --<arch>` 插回同一调用，三个平台都必须仍是生产拒绝（exit 2、argv 末尾 `["--","--<arch>"]`、错误文本与 run 37133058318 一字不差）。

若工作流回退为 `-- --${{ matrix.arch }}`，该测试会在真实 pnpm 调用处以生产拒绝失败（见 §4 的 RED 对照），而不是只让正则失配。

## 3. 已运行验证（真实退出码）

| 验证 | 命令（要点） | 结果 | 证据文件 |
| --- | --- | --- | --- |
| 定向套件（11 文件，含 `three-platform-package-workflow`、`packaging-sidecar-source`、`ci-workflow`、`preview-workflow`、`test-package-staging` 等） | `node --test --test-reporter=tap <11 files>`（cwd `app/`） | **exit 0**；tests 80 / pass 79 / fail 0 / skipped 1（macOS 专属按既有约定跳过） | `targeted-workflow-suites.txt` |
| 发布守卫套件 | `node --test --test-reporter=tap apps/desktop/test/omp-release-gate.test.mjs` | **exit 0**；tests 16 / pass 16 / fail 0（既有 `--` 拒绝用例仍在其负对照表内） | `targeted-release-gate.txt` |
| 真实 pnpm→生产 parser 探针 | `bash r4-pnpm-argv-probe.sh` | **exit 0**；三个平台 direct 调用各 exit 0 且解析出唯一目标；legacy `-- --<arch>` 各 exit 2 且报同一生产拒绝；scratch 删除 | `r4-pnpm-argv-verification.txt`、`r4-pnpm-argv-probe.sh` |
| RED 对照 | `bash r4-workflow-red-control.sh` | **exit 0**：把独立 `--` 塞回工作流后，新执行测试以生产拒绝失败（RED run exit=1），随后工作流按字节还原（`cmp` 通过） | `r4-workflow-red-control.txt`、`r4-workflow-red-control.sh` |
| 文档检查 | `node scripts/check-release-docs.mjs`；`pnpm docs:check`（cwd `app/`） | 均 **exit 0**（0.15.2 对齐；79 对中英、513 页；notes 非失败） | `doc-checks.txt` |
| 修复 diff | `git diff f5cdd276 13fe139`（两文件） | 226 行 diff | `r4-source-diff.txt` |
| 证据完整性 | `node r4-evidence-integrity.mjs` | **exit 0**：manifest == disk == Git tracked，逐文件 SHA-256 匹配 | `r4-evidence-integrity.txt`、`SHA256SUMS.txt` |

探针输出中的关键事实（node `v24.14.0`、pnpm `10.34.5`）：

```text
$ pnpm --filter @pi-desktop/desktop run dist:mac --arm64   -> exit 0, parsed {darwin, arm64, publish never, forwarded []}
$ pnpm --filter @pi-desktop/desktop run dist:win  --x64    -> exit 0, parsed {win32,   x64,   publish never, forwarded []}
$ pnpm --filter @pi-desktop/desktop run dist:linux --x64   -> exit 0, parsed {linux,   x64,   publish never, forwarded []}
$ ... -- --arm64 / -- --x64                                -> exit 2, "the release entry does not support \"--\": it would hide the rest of the command line from electron-builder"
```

## 4. 与 R4 直接相关的未改项（供根决策，不在本轮最小范围内）

同样以独立 `--` 拼写调用本产品入口、但**不是**本矩阵生效入口的位置；本轮按“只修根三平台工作流及其直接调用测试/证据”保持不动：

- 根旧预览 lane `.github/workflows/mac-preview-package.yml:82`（`pnpm run dist:mac -- --arm64`；仅在手动 dispatch / 自身路径触发的分支 push 时运行，本矩阵不使用）。
- `app/.github/workflows/release.yml:226,237,313` 与 `app/.github/workflows/linux-package.yml:71`（产品参考 lane；嵌套目录在本仓库不自动运行，链尾同为本产品入口，若将来启用需同样去掉 `--`）。对应静态测试 `app/apps/desktop/test/ci-workflow.test.mjs:126,191`、`preview-workflow.test.mjs:53` 现锁定其旧拼写，与本文件同批修改才一致。
- 产品文档仍以旧拼写描述透传：`app/docs/adr/0307-bundled-omp-sidecar.md:226`、`app/docs/spec/03-runtime/02-agent-runtime.md:2207`、`app/docs/spec/06-delivery/06-release-runbook.md:593-594` 及其中文镜像（`zh-CN/spec/03-runtime/02-agent-runtime.md:1316`、`zh-CN/spec/06-delivery/06-release-runbook.md:492-493`），另 `app/scripts/release-package.mjs:9` 的模块头注释保留历史拼写作为设计由来。运行手册中的两条 macOS 示例命令按当前入口会 exit 2，属**已知文档陈旧**，未在本轮改动。

## 5. 未运行 / 不声称

- macOS/Windows **原生构建与验收**未在本机运行；三平台 native 结论仍只能来自根在已验收树上创建新 `m5-test-*` tag 后的 CI。首次失败的 run `37133058318`、旧 tag 与 macOS/Windows 首次 CI 保持原样，不取消、不重跑、不移动。
- 未重跑编译器 / 全量桌面套件 / `dist:linux` 等昂贵打包（改动仅工作流与对应测试；R1–R3 与 M5 功能既有证据未重跑、未改写）。
- R1–R3 证据目录与原始 Linux 运行日志**字节未改**；本轮新增证据只在本目录。
- 完整 M5 三平台交付与 M6/M7 仍未完成；本记录只描述 R4 这一轮。
