# M5/T20-R4B：自有 OMP fork + bundled sidecar 的可验证闭环（含复审返修）

更新时间：2026-09-28（第五轮独立复审返修）。桌面分支 `codex/m5-r4b-bundled-sidecar`；首个 R4B 提交 `b25eb60c077deb5b200cf5f5bf6e8a3cddbbf679`，返修提交追加在其上（不 amend、不强推）；第二轮复审返修见 §0.1，追加提交 `53d19ee`、`f9d133e`、`7b3b3de`、`f428940`（+ 文档提交 `9bd7e50`）；第三轮独立复审返修见 §0.2（起点 `956841c`）；第四轮独立复审返修见 §0.3（起点仍是 `956841c85acf5e4c9b192ab7f837891416314680`）；**第五轮独立复审返修见 §0.4**（起点 `bf9d075365008478edd01d04d91c424aa4e93898`，提交随本文件一并追加，不 amend）。

状态：**R4B 部分完成 / 受阻（第一轮复审返修 + 第二轮独立复审返修 + 第三轮独立复审返修 + 第四轮独立复审返修 + 第五轮独立复审返修）。** 第三轮复审的 6 项问题（F1 发布参数透传、F2 packaging lane 的受控 fork 来源、F3 根 preview workflow 绕行、F4 canonical 路径断言、F5 Windows 夹具文件名、F6 证据更正）见 §0.2；第四轮复审的 2 项问题（F1 平台目标仍可分叉、F2 本地正式签名 lane 绕过 sidecar 预检）见 §0.3；**第五轮复审的 2 项问题（F1 wrapper 自有参数轴未收口、F2 最终打包来源可被 `--prepackaged`/`--projectDir`/`--config.*` 换掉）** 均按「先复现（RED）→ 修复 → 重跑（GREEN）」处理，见 §0.4。**但 R4-3 的“可复现”条款仍未满足（见 §10），因此 R4B 不标记为完成。**

**R3 仍为硬阻塞；ADR 0306 的 Cursor 产品门保留；T20-B/C/D 未开始；T20 未完成；T21 未完成；R4-3 未满足。**

非目标：解除 R3、实现 Plan/Goal 运行时面、放宽 Cursor 门、声称 PI parity、向 can1357 推送、跑 electron-builder 真实打包。

**仓库布局事实（本轮如实记录）**：GitHub 只识别仓库根 `.github/workflows/`。本仓库产品源码在 `app/`，因此 `app/.github/workflows/*`（含 `release.yml`、`linux-package.yml`）在当前仓库位置**不会自动触发**——它们是随 `app/` 交付的源码工作流（当 `app/` 作为仓库根时生效）；本仓库当下真正生效的打包工作流只有根 `.github/workflows/mac-preview-package.yml`。两者都被本轮新增的静态测试按同一「固定 fork 来源 + Bun + frozen install + 目标绑定的发布入口」契约锁定。

---

## 0.4 第五轮独立复审返修（RED → GREEN）

第五轮复审指出两点：①wrapper 虽已声明自己唯一拥有 platform/architecture/dir/publish 四个轴，但只识别了其中一部分拼写，electron-builder/yargs 接受的等价形式仍会漏进 `forwarded`；②wrapper 只校验仓库内 sidecar，而 electron-builder 仍能经 `--prepackaged`/`--projectDir`/`--config[.dotted]` 改换最终打包来源。本轮先复现 RED，再重写 `app/scripts/release-package.mjs` 的参数分类，**追加提交，不 amend/rebase/强推**；起点 `bf9d075365008478edd01d04d91c424aa4e93898`（本地/远端 HEAD 一致、工作树干净、两个固定子模块 gitlink 未动）。

**固定证据（动手前逐条核对，全部来自固定检出与已安装版本）：**

| 证据 | 坐标 | 结论 |
| --- | --- | --- |
| PI 发布命令链尾 | `upstream/pi-desktop/apps/desktop/package.json:27-31` | `pack`/`dist`/`dist:mac`/`dist:win`/`dist:linux` 都把 electron-builder 放在命令链**最后**，因此 workflow 的 `-- --<arch> -c.mac.*` 只能落在 builder 上（本仓库 `apps/desktop/package.json:29-33` 同形，链尾是本 wrapper） |
| PI 正式 macOS lane | `upstream/pi-desktop/.github/workflows/release.yml:245-287` | 追加 `--<arch>`、`-c.mac.forceCodeSigning=true`、`-c.mac.notarize=true`；本仓库本地 lane `scripts/release-macos.sh:109-111` 另加 `-c.mac.identity=…` |
| 已安装 CLI 的 yargs 契约 | `app/node_modules/electron-builder/out/builder.js` `configureBuildCommand`（electron-builder 26.15.3 / yargs 17.7.3），用一次性只读 Node 探针核实 | 声明 `mac`(别名 `m`,`o`,`macos`)、`linux`(`l`)、`win`(`w`,`windows`)、`x64`,`ia32`,`armv7l`,`arm64`,`universal`、`dir`、`publish`(`p`)、`prepackaged`(`pd`)、`projectDir`(`project`)、`config`(`c`)、`help`、`version`，并以 `.strict()` 拒绝未声明参数 |
| `prepackaged` 使正常打包被跳过 | `app/node_modules/app-builder-lib/out/platformPackager.js:146`（`prepackaged != null` 时直接 return）、`out/macPackager.js:268-270`（`appPath` 直接用外部路径） | 预检校验的仓库内 sidecar 与最终被打包/签名的输入可以不是同一个应用 |

**只读探针观察到的真实形式（GREEN 分类即按此表，不再靠正则猜测）：**

- 平台：`--mac`/`-m`/`-o`/`--macos`/`--m`/`--o`、`--win`/`-w`/`--windows`/`--w`、`--linux`/`-l`/`--l`；`--win=portable`、`--mac=dmg`、`-m=dmg`、`--w=portable` 等带值形式；`--mac=`/`--m=` 与裸开关等价；`-mdmg`/`-mwl`/`-mw`/`-ow` 是短簇（`-mwl` 会构建三个平台）；`--no-mac` 让 `normalizeOptions` 抛 `type.lastIndexOf is not a function`；`--mac dmg zip`/`--m dmg` 是 target 列表。
- 架构：`--x64`、`--x64=true`、`--x64 true` 选中 x64；`--x64=false`/`--no-x64`/`--x64=`/`--x64=1` 全都是 **false**（`=1` 也被 yargs 折算成 false）。
- dir：`--dir`、`--dir=true`、`--dir true` 选中；`--dir=false`/`--dir=`/`--no-dir` 是 false。
- publish：`--publish never`、`--publish=never`、`-p never`、`-p=never`、`--p=never`；重复声明被 yargs 收集成数组（`--publish never -p always` → `["never","always"]`）。
- 来源改写：`--prepackaged`/`--pd`（含 `=` 形式）、`--projectDir`/`--project`、`--config`/`-c`/`--c` 的路径形式（字符串路径与 dotted 同时出现会被合成 `extends` 合并）、`-c.files[0].from=x` 之类的 dotted 全局/平台键。

**RED（起点 worktree `git worktree add --detach /tmp/r4b-red5 bf9d075…`，只换入本轮测试与 `packages/omp-runtime/dist` 符号链接，生产代码保持起点版本）：**

| 用例 | 命令 | RED 观察 |
| --- | --- | --- |
| 新增测试整文件 | `node --test apps/desktop/test/omp-release-gate.test.mjs` | **6 failed / 10 passed**（`the config allowlist…`、`an electron-builder platform switch…`、`every unsupported spelling…`、`a conflicting or repeated target…`、`the entry generates exactly one choice per axis…`、`every option the installed electron-builder CLI declares…`；起点模块不导出 `ALLOWED_CONFIG_OVERRIDES`/`PUBLISH_CHOICES`） |
| 平台 target 列表分叉 | `runRelease(["--platform","darwin","--arm64","--win=portable"])` | code **0**、spawn **2**；builder argv `--mac --arm64 --publish never --win=portable`；用 builder 自己的 parser 解析该 argv → targets `mac` + `windows`(portable) |
| 最终来源被换 | `runRelease(["--platform","darwin","--arm64","--prepackaged","/tmp/foreign.app"])` | code **0**、spawn **2**；builder 解析 → `prepackaged: "/tmp/foreign.app"`（预检只校验仓库内 sidecar） |
| 发布轴分叉 | `runRelease(["--platform","darwin","--arm64","--publish","never","-p","always"])` | code **0**、spawn **2**；builder 解析 → `publish: ["never","always"]` |
| 架构轴分叉 | `runRelease(["--platform","darwin","--x64","--no-x64"])` | code **0**、spawn **2**；预检 darwin/x64，builder argv `--mac --x64 --publish never --no-x64`，builder 解析 → `x64: false`（在 arm64 宿主上回落到宿主架构） |
| 项目目录被换 | `runRelease([…"--projectDir","/tmp/elsewhere"])` | code **0**、spawn **2**；builder 解析 → `projectDir: "/tmp/elsewhere"` |
| 外部配置被换 | `runRelease([…"-c","/tmp/foreign.yml"])` | code **0**、spawn **2**；builder 解析 → `config: "/tmp/foreign.yml"` |
| dotted 来源键 | `runRelease([…"-c.files[0].from=/tmp/foreign"])` | code **0**、spawn **2**；builder 解析 → `config: {"files[0]":{"from":"/tmp/foreign"}}` |

**修复（`app/scripts/release-package.mjs` 重写参数分类，三个桶）：**

1. **自有轴**：platform（含 `--m/--o/--w/--l` 这些 yargs 同样接受的别名长写、`=` 空值形式、短簇与 target 列表一律在 spawn 前拒绝）、architecture（`=true` 与 `true` 字面量接受；`=false`/`--no-<arch>`/`=<其它>` 拒绝；重复声明拒绝）、`--dir`（同理）、`--publish`/`-p`/`--p`（空格、`=`、附着值；重复拒绝；取值按已安装 CLI 的 `choices` 校验，`--p=draft` 这类值在预检之前就拒绝）。每个轴 wrapper 自己生成且恰好一次。
2. **拒绝**：`--prepackaged`/`--pd`、`--projectDir`/`--project`、`--config`/`-c`/`--c` 的路径形式、`--help`/`--version`（会让 builder 不打包就退出）、以及所有 `--no-*`、短簇、近似拼写；每条错误都指名被拒参数。
3. **source-neutral allowlist + 原样转发**：dotted 配置只接受 `mac.identity`、`mac.forceCodeSigning`、`mac.notarize` 三个签名相位键（追加式 allowlist，而不是"除危险键外全放行"的 denylist），且必须带 `=<value>`；这三个键只选证书或签名/公证闸门，无法增删/搬移被打包的文件。其余既不是 electron-builder 已声明选项、也不在被拒前缀族里的 token 仍按原序原样转发（builder 的 `.strict()` 会拒绝它们，属 fail closed）。

**GREEN 证据（本机 Linux x64、Node v24.14.0）：**

| 用例 | 命令 | GREEN 观察 |
| --- | --- | --- |
| 新增测试整文件 | `node --test apps/desktop/test/omp-release-gate.test.mjs` | **16 passed / 0 failed** |
| 危险组合（同一批探针） | `node /tmp/m5-probe/green-probe5.mjs`（与 RED 同一脚本，只换模块路径） | 七项全部 `code=2`、`spawns=0`，错误分别指名 `--win=portable`、`--prepackaged`、`-p`、`--no-x64`、`--projectDir`、`-c`、`-c.files[0].from=…` |
| 真实入口（pnpm exec） | `pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs --platform darwin --arm64 --win=portable` | `RELEASE-PACKAGE-FAIL a platform target list is not supported: --win=portable`，wrapper exit 2（pnpm 外层报 `Command failed with exit code 2`，其中 pnpm 自身 exit 1） |
| 签名 lane argv 真跑 | `OMP_SIDECAR_SOURCE=/tmp/r4b/oh-my-pi node scripts/release-package.mjs --platform darwin --arm64 --publish never -c.mac.identity=… -c.mac.forceCodeSigning=true -c.mac.notarize=true` | 参数全部被接受并进入预检：`preflight … --platform darwin --arch arm64`，随后按跨目标语义拒绝（`provenance platform is linux, this host is darwin`，exit 1，属环境性跨目标拒绝） |
| 契约测试（不靠人工核对） | 同 `omp-release-gate` 内的 `every option the installed electron-builder CLI declares is classified by the entry` | 用**已安装** electron-builder 的 `createYargs()` + `configureBuildCommand()` 读出全部选项/别名（`options.key` ∪ `options.alias`）与 `choices.publish`，逐个比对 wrapper 的归类表：缺项、多余项、别名或 choice 变化都会判红 |

固定 PI 的三项 macOS 签名覆盖逐项与组合都以原顺序、原值进入 builder argv（`omp-release-gate` 的 `the release entry forwards the signature overrides it does not own`），且 `the config allowlist is exactly the signature overrides the fixed lanes pass` 直接从 `scripts/release-macos.sh` 与 `.github/workflows/release.yml` 提取 `-c.<key>=` 并断言集合相等——allowlist 既不会过宽也不会漏掉 lane 实际使用的键。

本轮改动文件：`app/scripts/release-package.mjs`、`app/apps/desktop/test/omp-release-gate.test.mjs`、`app/docs/adr/0307-bundled-omp-sidecar.md` §6、`app/docs/spec/03-runtime/02-agent-runtime.md` §17（+ zh 镜像）、本文、`docs/04-task-board.md`、`HANDOFF.md`。RED/GREEN 的逐条命令与计数见 §12.4。

---

## 0.3 第四轮独立复审返修（RED → GREEN）

本轮只修两项已复现问题（F1 平台目标分叉、F2 本地正式签名 lane 绕过 sidecar 预检），**追加提交，不 amend/rebase/强推**；起点 `956841c85acf5e4c9b192ab7f837891416314680`（本地/远端 HEAD 一致、工作树干净）。R4-3 的 Bun 构建非确定性仍按**未解决阻塞项**保留，未触碰。

固定证据先核对（本轮动手前）：PI Desktop 子模块仍为 `0111e306c120ad5820688d7608cb37bad8fbcc1f`；`upstream/pi-desktop/apps/desktop/package.json:27-31` 确认 `electron-builder` 位于 `pack`/`dist`/`dist:mac`/`dist:win`/`dist:linux` 每条命令链**最后**，`upstream/pi-desktop/.github/workflows/release.yml:245-287` 的签名 lane 正是通过 package 脚本追加 `-c.mac.forceCodeSigning=true` 与 `-c.mac.notarize=true`。因此**通用 builder 参数继续原样透传**，而平台/架构属于 wrapper 自己控制的维度。`nornzach/oh-my-pi-gui`（树 SHA `31327996…`）仅作架构对照：自有 fork + 随包 sidecar + `--mode rpc-ui` + 编译期 RPC 类型契约 + 启动协商，明确不回退系统 OMP；但其 `package:*` 只构建 Electron GUI、不自动重建或预检 sidecar（README 要求人工先跑 `build:omp*`），**这个缺口不照搬**——我们的发布门继续强制预检。

| # | 复审问题 | 复现（RED） | 修复（GREEN） |
| --- | --- | --- | --- |
| 1 | **F1 平台目标仍可分叉**：`--mac`/`--win`/`--linux` 作为未知参数被透传，预检与 builder 可落在不同平台 | 起点 `956841c`：`planRelease(["--platform","darwin","--arm64","--win"], {platform:"darwin",arch:"arm64"})` → builder argv `--mac --arm64 --publish never --win`（预检只校验 darwin/arm64，electron-builder 会同时构建 win32）；新增回归测试同起点 `node --test test/omp-release-gate.test.mjs` → **2 failed / 9 passed**，坐标 `:407`（`["--mac"]` 下 `--mac` 既被消费又出现在 builder argv）与 `:448`（混合 `--platform darwin --arm64 --win` 未被拒绝） | 平台别名与 `--platform` 归并进同一受控解析：`--mac`/`--macos`/`-m`/`-o`→darwin、`--win`/`--windows`/`-w`→win32、`--linux`/`-l`→linux；重复/同义重复/冲突**以及短开关簇 `-mwl`** 一律在 spawn 前 exit 2 拒绝；平台 target 列表（`--mac dmg`）拒绝而不是静默丢弃；builder argv **恰好一个**平台 flag。`omp-release-gate` **11 passed** |
| 2 | **F2 本地正式签名 lane 绕过 sidecar preflight**：`release-macos.sh` 让 watchdog 直接跑 `pnpm … exec electron-builder --mac …`，可把缺失/陈旧的 `resources/omp-runtime` 打进签名包 | 起点 `956841c`：重写的 `macos-release-lane.test.mjs`（真实驱动 `scripts/release-macos.sh` + 桩工具）`node --test test/macos-release-lane.test.mjs` → **2 failed**，坐标 `:191`「the lane runs scripts/release-package.mjs」（调用日志里只有 `pnpm … exec electron-builder`，wrapper 从未运行）与 `:273`「a refused preflight must fail the lane」（`PI_FAKE_SIDECAR_EXIT=1` 时 lane 仍 exit 0，因为根本没有预检） | watchdog 内改为 `pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs --platform darwin --${MAC_ARCH} --publish never -c.mac.identity=… -c.mac.forceCodeSigning=true -c.mac.notarize=true`：预检先于 electron-builder，预检失败则 builder 不运行，签名 identity/flags 完整到达 builder，bundle inventory → DMG 公证/装订 → 签名校验顺序不变。lane 测试 **2 passed**（本轮在 **Linux** 实跑；`uname` 桩使该文件不再因非 macOS 主机而跳过），`ci-workflow.test.mjs` **14 passed** |

**机制实证（不是文本断言）**：`cd app && pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs --platform win32 --arch arm64` → `RELEASE-PACKAGE-FAIL a win32 release is x64-only; refusing the requested arm64`（wrapper 真被执行、模块路径真解析，wrapper 自身 exit 2）；`pnpm --filter @pi-desktop/desktop exec which electron-builder` → `./node_modules/.bin/electron-builder`（wrapper 以裸命令名 spawn 的 builder 在该 cwd + `pnpm exec` 的 PATH 下确实可解析，未假设交互 shell）。

**本轮改动文件**：`app/scripts/release-package.mjs`、`app/scripts/release-macos.sh`、`app/apps/desktop/test/omp-release-gate.test.mjs`、`app/apps/desktop/test/macos-release-lane.test.mjs`、`app/apps/desktop/test/ci-workflow.test.mjs`、`app/docs/adr/0307-bundled-omp-sidecar.md` §6、`app/docs/spec/03-runtime/02-agent-runtime.md` §17（+zh 镜像）、`app/docs/spec/06-delivery/06-release-runbook.md` §4.2（+zh 镜像）、本文/任务板/`HANDOFF.md`。

RED/GREEN 的逐条命令与结果见 §12.3。

---

## 0.2 第三轮独立复审返修（RED → GREEN）

第三轮复审在**独立 macOS（Node 24.14.0）**上给出 `3 failed / 25 passed / 6 skipped`（`bundled.test.ts` + `bundled-smoke.test.ts`），失败坐标 `bundled.test.ts:172/195/403` 与 `omp-runtime-launcher.test.mjs:128/329`：实现返回规范路径（`/private/var/...`），断言仍用词法路径（`/var/...`）。本机（Linux x64，无 `/var` 别名）用**别名 TMPDIR**（`/tmp/canon-alias` → `/tmp/canon-real`）复现**同一失败类**：

```
$ TMPDIR=/tmp/canon-alias npx vitest run src/bundled.test.ts      # 起点 9bd7e50
 Tests  3 failed | 22 passed (25)        # 172 / 195 / 403，Expected /tmp/canon-alias/... Received /tmp/canon-real/...
$ TMPDIR=/tmp/canon-alias node --test test/omp-runtime-launcher.test.mjs
 ...:128  actual '/tmp/canon-real/omp-launcher-packaged-…/omp-runtime/omp'
          expected '/tmp/canon-alias/omp-launcher-packaged-…/omp-runtime/omp'
 ...:329  同类（gate 路径）
```

| # | 复审问题 | 复现（RED） | 修复（GREEN） |
| --- | --- | --- | --- |
| 1 | **F1 阻塞**：正式 macOS 签名发布被 wrapper 拒绝 | `node app/scripts/release-package.mjs --platform darwin --arch arm64 -c.mac.forceCodeSigning=true -c.mac.notarize=true` → `RELEASE-PACKAGE-FAIL unknown argument: -c.mac.forceCodeSigning=true`，exit 2 | 只消费自有 target/dir/publish 参数，其余 electron-builder 参数**按原始顺序逐项原样转发**；同一目标维度只允许声明一次（`--x64 --arm64`/`--x64 --arch arm64`/重复 `--platform` 直接拒绝、exit 2 且不 spawn）。`omp-release-gate` 10 passed |
| 2 | **F2 阻塞**：clean runner 无受控 fork、无 Bun/OMP 依赖 | 新 `packaging-sidecar-source.test.mjs`：4 断言失败（无 fork checkout、无 `OMP_SIDECAR_SOURCE`、无 Bun、无 frozen install） | `release.yml` build matrix 与 `linux-package.yml` 都：checkout `MisterBowie/oh-my-pi` @ manifest `fork.commit`（`fetch-depth: 0`，因为构建要 `git diff <base> HEAD` 与 `git apply --check --reverse`）→ `oven-sh/setup-bun@v2`（`bun-version: "1.4.2"`）→ `bun install --frozen-lockfile` → 作业级 `OMP_SIDECAR_SOURCE`；测试从 manifest 读 repo/commit 自动比较。4 passed |
| 3 | **F3 阻塞**：本仓库真正生效的 preview workflow 仍绕过 R4B | 新 `preview-workflow.test.mjs`：1 failed（仍 `gh release download v18.2.7 -R can1357/oh-my-pi`、`electron-builder` 后手工注入、复制 `omp-desktop-gate.ts`、`--prepackaged`） | 根 `.github/workflows/mac-preview-package.yml` 改为受控 fork checkout + Bun 1.4.2 + frozen install + `pnpm run dist:mac -- --arm64`（与正式发布同一 `release-package.mjs` 入口，builder 前构建并校验 sidecar）；删除上游下载/打包后注入/`.ts` gate/`--prepackaged`；保留未签名预览、产物重命名与上传。1 passed |
| 4 | **F4**：macOS canonical 路径断言失败 | macOS 复审机 3 failed（172/195/403）；本机别名 TMPDIR 同形复现 | 夹具改为以 canonical 形式返回根与路径（`realpathSync`），断言期望值天然规范；生产实现的 canonical containment **未回退**。别名 TMPDIR 下 `28 passed / 6 skipped`，launcher `12 passed` |
| 5 | **F5**：Windows failclosed 夹具硬编码 `omp` | 新增 win32 覆盖用例（stub `process.platform=win32`）：修前 `the fixture must write the Windows name` | `writePackagedRuntime` 与 launcher 夹具都改用生产的 `bundledBinaryFilename(process.platform)`；新增用例证明打包桥接解析 `omp.exe` 且 `launcherError === null`。failclosed 24 passed |
| 6 | **F6**：证据/状态必须更正 | — | 本文、`docs/04-task-board.md`、`HANDOFF.md`、ADR 0307 §6 与 spec §17（中英）按实际计数与事实更正；未执行的 macOS/Windows 实机与未运行的 clean-runner CI 均未写成通过 |

第三轮修复后的完整计数见 §9.1，命令见 §12.2。

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
7. **发布链路在本轮补齐（第三轮 F1-F3）。** `release-package.mjs` 现在只消费自有的 target/dir/publish 参数，其余 electron-builder 参数**按原序原样转发**（签名 macOS lane 的 `-c.mac.forceCodeSigning=true`/`-c.mac.notarize=true` 不再被拒），同一目标维度只允许声明一次；真正调用 `dist:*` 的每条 lane（`release.yml` build matrix、`linux-package.yml`、根 `mac-preview-package.yml`）都先 checkout 受控 fork 的固定 commit、`setup-bun` 1.4.2、`bun install --frozen-lockfile`，并把 `OMP_SIDECAR_SOURCE` 指向它；本仓库真正生效的根 preview workflow 改为走同一 `dist:mac` → `release-package.mjs` 入口，删除上游发布资产下载、打包后注入与非自包含 `.ts` gate。**未在 clean runner 实跑这些 lane**（§11 第 9 条）。

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

## 5. 发布门（问题 1；第二/四轮复审后改为单一目标解析）

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

随后：预检（`omp-sidecar.mjs --preflight --platform <p> --arch <a>`）→ 仅当预检成功才运行 `electron-builder <--mac|--win|--linux> [--x64/--arm64] [--dir] --publish never <其余参数…>`，保持 PI 「runtime 步骤先于 electron-builder」的顺序。

**参数契约（第五轮复审 F1/F2 收口后）**：`release-package.mjs` 拥有 platform/architecture/dir/publish 四个轴，并**按已安装 CLI 的 yargs 契约**（`configureBuildCommand`，证据表见 §0.4）识别它们的全部拼写：平台 `--mac`/`-m`/`-o`/`--macos`/`--m`/`--o`、`--win`/`-w`/`--windows`/`--w`、`--linux`/`-l`/`--l`（含 `=` 取值形式与 `--mac=` 这类"空值等价于裸开关"的形式；短簇 `-mwl`/`-mdmg`、target 列表 `--mac dmg`/`--win=portable` 在 spawn 前拒绝）；架构布尔开关（`=true` 与 `true` 字面量接受；`=false`/`--no-<arch>`/其它取值拒绝）；`--dir`（同理）；`--publish`/`-p`/`--p`（空格、`=`、附着值，取值按已安装 CLI 的 `choices` 校验）。每个轴只允许一次声明，且由 wrapper 自己生成恰好一次：builder argv 恰好一个平台开关、至多一个架构开关、至多一个 `--dir`、一个规范化的 `--publish <value>`，它们排在转发参数之前，因此转发参数不可能追加第二个轴选择（`--x64 --arm64`、`--x64 --arch arm64`、重复 `--platform`/`--publish`、`--publish never -p always`、`--dir --dir=true` 都在 spawn 任何进程之前以退出码 2 拒绝）。**「其余参数全部原样透传」的旧表述已不成立**：不是已声明选项、也不在被拒前缀族里的 token 才原样转发。

**最终打包来源不可替换（第五轮复审 F2）**：`--prepackaged`/`--pd`（`prepackaged != null` 时 `doPack` 直接跳过、改用外部应用）、`--projectDir`/`--project`（换项目）、`--help`/`--version`（不打包就退出），以及 `--config`/`-c`/`--c` 的**路径**形式全部在 spawn 前拒绝。dotted 配置覆盖采用 **source-neutral allowlist**：只有 `mac.identity`、`mac.forceCodeSigning`、`mac.notarize` 三个签名相位键可按 `=<value>` 形式原样转发（固定 PI lane 与本仓库签名 lane 实际用的就是这三个：`upstream/pi-desktop/.github/workflows/release.yml:245-287`、`app/scripts/release-macos.sh:109-111`；测试直接从这两个文件提取 `-c.<key>=` 并断言与 allowlist 集合相等）。`files`、`extraResources`、`extraFiles`、`directories.app`、`extends` 以及平台级同类键（`-c.mac.type=dmg`、`-c.afterSign=…` 等）一律拒绝，而不是"危险键 denylist + 未知键全放行"。

**平台轴只有一个声明（第四轮复审 F1；第五轮补全别名长写）**：electron-builder 自己的平台开关是**可加的**——`--mac … --win` 会让它构建两个平台——因此透传它们等于同一个分叉换了个拼写：预检校验 darwin/arm64，打包再产出 win32。`--mac`/`--macos`/`-m`/`-o`/`--m`/`--o`→`darwin`、`--win`/`--windows`/`-w`/`--w`→`win32`、`--linux`/`-l`/`--l`→`linux` 与 `--platform` 归并进**同一**声明：重复、同义重复（`--mac --macos`、`--mac --m`）、冲突（`--platform darwin --win`）以及短开关簇（`-mwl`）全部在 spawn 前退出码 2 拒绝；wrapper 生成的 builder argv **恰好一个**平台 flag。平台后跟 target 列表（`--mac dmg zip`）或追加 `=` 取值（`--win=portable`）也拒绝，而不是被静默丢弃或转发到 wrapper 自己选的 flag 旁边——平台维度只负责选平台，产物 target 由 electron-builder 配置决定。

**本地签名 lane 走同一入口（第四轮复审 F2）**：`scripts/release-macos.sh` 的打包阶段改为 watchdog 内 `pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs --platform darwin --${MAC_ARCH} --publish never -c.mac.identity=… -c.mac.forceCodeSigning=true -c.mac.notarize=true`，使 bundled-sidecar 预检在 electron-builder 之前运行（缺失/陈旧 `resources/omp-runtime` 不再能进入签名并公证的包）；`pnpm exec` 把 desktop 包的 `node_modules/.bin` 放到 PATH 前部，所以 wrapper 以裸命令名 `electron-builder` spawn 时无需假设交互 shell 的 PATH。bundle inventory → DMG 公证/装订 → 签名校验的顺序保持不变，并由行为测试锁定。

**packaging lane 的输入（第三轮复审 F2/F3）**：真正调用 `dist:*` 的 lane（`release.yml` build matrix、`linux-package.yml`、根 `mac-preview-package.yml`）都在调用发布入口之前：checkout 自有 fork `MisterBowie/oh-my-pi` @ manifest `fork.commit`（`fetch-depth: 0`，因为构建要重新证明 `base..HEAD`）、`setup-bun` 固定 `1.4.2`、在该检出执行 `bun install --frozen-lockfile`，并把作业级 `OMP_SIDECAR_SOURCE` 指向它。`app/apps/desktop/test/packaging-sidecar-source.test.mjs` 与 `preview-workflow.test.mjs` 从 manifest 读取 repo/commit 后自动比较，避免文档式重复值漂移。**未在 clean runner 实跑这些 lane**（见 §11）。

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
| 参数透传 | `release-package.mjs --platform darwin --arm64 -c.mac.forceCodeSigning=true -c.mac.notarize=true`；stub spawn 的计划函数 | 通过：两个 `-c.mac.*` 按原序到达 electron-builder；预检仍先执行，预检失败时 builder 不执行 |
| 目标冲突/重复 | `--x64 --arm64`、`--x64 --arch arm64`、重复 `--platform`、重复 `--publish` | 通过：`must be given once` / `given more than once`，exit 2 且不 spawn |
| 平台开关同轴（第四轮） | `planRelease(["--mac"])` / `["--win","--linux"]` / `["-mwl"]` / `["--platform","darwin","--arm64","--win"]`；`runRelease` + stub spawn | 通过：别名归并为同一平台声明；重复/冲突/簇/目标列表在 spawn 前拒绝（exit 2、spawn 0）；builder argv 恰好一个平台 flag（`omp-release-gate` 11 passed） |
| 签名 lane 入口（第四轮） | `node --test test/macos-release-lane.test.mjs`（真实 `release-macos.sh` + 真实 wrapper/watchdog/inventory/公证/校验脚本 + 桩工具 + `uname` 桩） | 通过：lane 经 `pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs` 进入 wrapper；预检先于 builder、预检失败短路（builder/公证/校验都不运行）、签名参数完整到达 builder、inventory → 公证/装订 → verify 顺序（2 passed） |


变异 RED：把 `dist:mac` 中的 `node ../../scripts/release-package.mjs` 替换成裸 `electron-builder` 后，覆盖性测试失败（见 §9.2）。

---

## 6. 打包态准入与工具门（问题 3 + 审计项；第二轮复审后更严）

* `resolveRuntimeLauncher`（打包态）：唯一候选 `resourcesPath/omp-runtime/{omp|omp.exe}`，`verifyBundledRuntime` 通过才可用；`OMP_DESKTOP_RUNTIME`/PATH/向上扫描均不是候选。
* **规范包含性（第二轮复审问题 1；第三轮 F4 补齐测试侧）**：`verifyBundledRuntime` 对 `resourcesPath` 与 `omp-runtime` 都取 `realpathSync` 后再比较，别名祖先（macOS `/var` → `/private/var`、symlink 目录）不再误报 `resolves outside the resources root`；`omp-runtime`、二进制、`provenance.json`、gate 仍以 `lstat` 拒绝符号链接。第三轮 F4 修正的是**测试夹具**（`bundled.test.ts`、`omp-runtime-launcher.test.mjs`）：夹具改以 canonical 形式返回根与路径（`realpathSync`），因此期望值天然规范；生产实现的 canonical containment 未做任何回退。
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

### 9.1 计数（本机 Linux x64，Node v24.14.0、pnpm 10.34.5；第五轮复审后）

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @pi-desktop/omp-runtime test`（未设 opt-in 变量） | **23 files / 350 passed / 6 skipped（356）**（本轮复跑） |
| `OMP_SIDECAR_TEST_RESOURCES=… npx vitest run src/bundled-smoke.test.ts`（真实产物） | **9 passed**（本轮复跑；第三轮构建的产物） |
| `env -u SSH_ASKPASS node --test test/*.test.mjs`（`apps/desktop` 全量，第五轮） | **tests 2952 / pass 2949 / fail 0 / skipped 3** |
| 其中 `omp-release-gate` 16（第五轮 +5）、`macos-release-lane` 2、`ci-workflow` 14、`omp-sidecar` 7、`omp-runtime-launcher` 12、`packaging-footprint` 9、`omp-session-failclosed` 24、`packaging-sidecar-source` 3、`preview-workflow` 1、`window-menu` 9 | 均 0 fail（第五轮逐个实跑） |
| `TMPDIR=<别名>` 重跑 `src/bundled.test.ts` 与 `omp-runtime-launcher.test.mjs` | `bundled.test.ts` **25 passed**；launcher **12 passed**（第五轮实跑） |
| `pnpm build:js` / `pnpm --filter @pi-desktop/omp-runtime typecheck` / `pnpm --filter @pi-desktop/desktop typecheck` | 均 exit 0（第五轮实跑） |
| `git diff --check` | exit 0（第五轮实跑） |


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

第三轮（本轮，逐项「先红后绿」，命令见 §12.2）：

| 复审问题 | RED 观察 | GREEN 观察 |
| --- | --- | --- |
| 1 F1 参数透传 | `release-package.mjs --platform darwin --arch arm64 -c.mac.forceCodeSigning=true -c.mac.notarize=true` → `RELEASE-PACKAGE-FAIL unknown argument: …`，exit 2 | 转发后的签名参数计划/调用：`omp-release-gate` **10 passed**（含冲突/重复目标拒绝） |
| 2 F2 workflow 来源 | 新 `packaging-sidecar-source.test.mjs`：**3 failed**（`release.yml` 的 fork checkout、`OMP_SIDECAR_SOURCE`、Bun + frozen install 各一） | 同文件 **3 passed**（Manifest 的 repo/commit 自动比较） |
| 3 F3 根 preview | 新 `preview-workflow.test.mjs`：**1 failed**（`repository: MisterBowie/oh-my-pi` 不匹配） | **1 passed** |
| 4 F4 canonical 断言 | 别名 TMPDIR：`bundled.test.ts` **3 failed / 22 passed**（172/195/403）；launcher 128/329 两处 `actual /tmp/canon-real/… expected /tmp/canon-alias/…` | 同一别名 TMPDIR：`28 passed / 6 skipped`；launcher **12 passed**（普通 TMPDIR 同值） |
| 5 F5 win32 夹具 | 新增 win32 用例：`the fixture must write the Windows name`（1 failed） | `omp-session-failclosed` **24 passed** |

第四轮（本轮，逐项「先红后绿」，命令见 §12.3）：

| 复审问题 | RED 观察 | GREEN 观察 |
| --- | --- | --- |
| F1 builder 平台开关混入透传 | 起点 `956841c`：`planRelease(["--platform","darwin","--arm64","--win"], …)` → builder argv `--mac --arm64 --publish never --win`；`omp-release-gate` **2 failed / 9 passed**（`:407` `["--mac"]`、`:448` 混合声明） | `omp-release-gate` **11 passed**；同 argv 在 `parseReleaseArgs` 即拒绝（`the release platform must be given once; got --platform darwin, --win`），`runRelease` 解析失败时 exit 2 且 spawn 数 0 |
| F2 本地签名 lane 绕过预检 | 起点 `956841c`：`macos-release-lane` **2 failed**（`:191` wrapper 从未运行、`:273` 预检失败时 lane 仍 exit 0）；`ci-workflow` **1 failed**（`:319` 旧断言仍是直接调用 electron-builder） | `macos-release-lane` **2 passed**（真实经过 wrapper：预检先于 builder、失败短路、签名参数完整、inventory → 公证/装订 → verify 顺序含 stdout 阶段标记断言）；`ci-workflow` **14 passed** |

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
8. **上游测试随契约移动**：`apps/desktop/test/window-menu.test.mjs` 原先断言发布脚本里出现 `electron-builder` 字面量；electron-builder 现由 `release-package.mjs` 调用，故该断言改为「`build:host-release` 先于打包入口」，其余断言不变（第三轮后全量桌面套件 2945 tests / 2941 pass / 0 fail / 4 skipped）。
9. **未在 clean runner 实跑 packaging workflows**：F2/F3 的 fork checkout、`OMP_SIDECAR_SOURCE`、固定 Bun、`bun install --frozen-lockfile` 只以**静态测试 + manifest pin 自动比较**锁定（本机无网络与干净 fork 克隆）。真实 sidecar 构建仍在本机 fork 检出（`/tmp/r4b/oh-my-pi`，`3c845eb2…`）验证：`--check`/`--preflight` exit 0，opt-in 无费用 smoke **9 passed**。
10. **平台实测边界**：F4 的 macOS RED 坐标（`bundled.test.ts:172/195/403`、`omp-runtime-launcher.test.mjs:128/329`）来自独立 macOS 复审机（Node 24.14.0）；本机用**别名 TMPDIR** 复现同一失败类并验证修复，但**未在 macOS 上复跑本轮修复**，留待规划方复跑验收。F5 的 win32 覆盖是 stub `process.platform`，**不是** Windows 实机；打包后的应用仍未启动过（同第 1、2 条）。
11. **第四轮的 signed lane 证据在 Linux 上以桩工具实跑**：`macos-release-lane.test.mjs` 用 `uname` 桩模拟 Darwin、用桩 pnpm/electron-builder/codesign/xcrun 驱动真实的 `release-macos.sh` + `release-package.mjs` + watchdog + inventory + 公证/校验脚本，证明的是命令构造、预检先行、失败短路与阶段顺序，**不是**真实 macOS 签名/公证结果；真实 lane 仍需在带证书的 macOS 上实跑（同第 1、2 条）。第四轮**未**执行 `--preflight` 的真实 sidecar 构建（§8 的 9 条 smoke 仍是第三轮产物与计数）。
12. **第五轮的口径边界**：本轮验证集中在**参数分类与 spawn 前拒绝**这一层，外加用已安装 electron-builder 的 yargs 契约做静态一致性比对；仍未跑真实 electron-builder 打包、未在 clean runner 实跑 packaging workflows、未在 macOS/Windows 实机验证（同第 1、2、9、11 条）。`--prepackaged` 的“会改用外部应用”结论来自固定版本的源码坐标（`platformPackager.js:146`、`macPackager.js:268-270`），未真机打包验证。
13. **第五轮未重建 sidecar 产物**：产物仍是第三轮构建值（283559392 B、sha256 `a3807b5e…`），本轮只复跑 opt-in smoke（9 passed）与 `omp-runtime` 全套（350 passed / 6 skipped）；R4-3 的非确定性结论（§10）不变。第五轮的一次性探针脚本（`/tmp/m5-probe/red-probe5.mjs`、`green-probe5.mjs`、yargs 探针）不进入交付，其可复现的等价物是仓库内的 `every option the installed electron-builder CLI declares is classified by the entry` 契约测试。

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

### 12.2 第三轮复审的 RED/GREEN 复核命令

RED 均在起点提交 `9bd7e50`（F1/F4 直接跑旧实现；F2/F3/F5 在加入新测试、尚未修复时）复现：

| 复审问题 | RED 命令 | GREEN 命令（本轮） |
| --- | --- | --- |
| F1 | `node app/scripts/release-package.mjs --platform darwin --arch arm64 -c.mac.forceCodeSigning=true -c.mac.notarize=true` → `unknown argument: -c.mac.forceCodeSigning=true`，exit 2 | 同命令不再报参数错误（随后进入预检）；`node --test test/omp-release-gate.test.mjs` → 10 passed |
| F2 | `node --test test/packaging-sidecar-source.test.mjs` → 3 failed | 同命令 → 3 passed |
| F3 | `node --test test/preview-workflow.test.mjs` → 1 failed | 同命令 → 1 passed |
| F4 | `TMPDIR=/tmp/canon-alias npx vitest run src/bundled.test.ts` → 3 failed / 22 passed；`TMPDIR=/tmp/canon-alias node --test test/omp-runtime-launcher.test.mjs` → 128、329 两处断言失败 | 同两条命令 → `28 passed / 6 skipped`（含 smoke）与 `12 passed`；普通 TMPDIR 同值 |
| F5 | `node --test test/omp-session-failclosed.test.mjs` → `the fixture must write the Windows name` | 同命令 → 24 passed |

复核用别名 TMPDIR：`mkdir -p /tmp/canon-real && ln -s /tmp/canon-real /tmp/canon-alias`（模拟 macOS `/var` → `/private/var` 的别名祖先）。

### 12.3 第四轮复审的 RED/GREEN 复核命令

RED 全部在起点 `956841c` 的独立 worktree（`git worktree add --detach /tmp/r4b-red4 956841c85acf5e4c9b192ab7f837891416314680`）里复现：只把本轮三个测试文件拷进该 worktree，`release-package.mjs`/`release-macos.sh` 保持起点版本（`node_modules` 与 `packages/omp-runtime/dist` 以符号链接复用本机工作区已构建产物），因此每一项判红都只可能来自 F1/F2 本身。

| 复审问题 | RED 命令（起点 `956841c`，worktree） | RED 观察 | GREEN 命令（本轮工作树） | GREEN 观察 |
| --- | --- | --- | --- | --- |
| F1 目标分叉 | `node -e "…planRelease(['--platform','darwin','--arm64','--win'], {platform:'darwin',arch:'arm64'})…"` | target `darwin/arm64`，builder argv `--mac --arm64 --publish never --win`（预检一个平台、打包两个平台） | 同命令 | `refused … the release platform must be given once; got --platform darwin, --win` |
| F1 回归 | `node --test apps/desktop/test/omp-release-gate.test.mjs` | **2 failed / 9 passed**；`:407` `["--mac"]` 下 builder 收到 `['--mac','--mac']`，`:448` 混合声明未被拒绝 | 同命令 | **11 passed / 0 failed** |
| F2 lane | `node --test apps/desktop/test/macos-release-lane.test.mjs` | **2 failed**；`:191`「the lane runs scripts/release-package.mjs」（调用日志只有 `pnpm … exec electron-builder`）、`:273`「a refused preflight must fail the lane」（lane exit 0） | 同命令 | **2 passed / 0 failed** |
| F2 CI 断言 | `node --test apps/desktop/test/ci-workflow.test.mjs` | **1 failed / 13 passed**；`:319`「the local signed macOS lane enters the release wrapper」 | 同命令 | **14 passed / 0 failed** |
| F2 机制（非文本） | — | — | `pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs --platform win32 --arch arm64`；`pnpm --filter @pi-desktop/desktop exec which electron-builder` | 前者 `RELEASE-PACKAGE-FAIL a win32 release is x64-only; refusing the requested arm64`（wrapper 真执行、自身 exit 2）；后者 `./node_modules/.bin/electron-builder`（`pnpm exec` 的 cwd = `apps/desktop`，故 `../../scripts/…` 与裸 `electron-builder` 都解析） |

本轮 GREEN 计数（本机 Linux x64，Node v24.14.0、pnpm 10.34.5）：`pnpm build:js` exit 0；`pnpm --filter @pi-desktop/omp-runtime typecheck` exit 0；`pnpm --filter @pi-desktop/desktop typecheck` exit 0；`git diff --check` exit 0；`omp-runtime` 全套 **23 files / 350 passed / 6 skipped**；`apps/desktop` 全套 `env -u SSH_ASKPASS node --test test/*.test.mjs` **2947 tests / 2944 passed / 3 skipped / 0 failed**。桌面全套与 `omp-runtime` 全套并发时曾出现一次 `src/process.test.ts > reports the runtime's stderr as diagnostics only` 判红；该文件单跑与全套串行重跑都通过，且本轮未改动 `packages/omp-runtime` 任何源码——按**负载引起的 flaky** 记录，不写入通过计数之外。

### 12.4 第五轮复审的 RED/GREEN 复核命令

RED 在起点 `bf9d075` 的独立 worktree（`git worktree add --detach /tmp/r4b-red5 bf9d075365008478edd01d04d91c424aa4e93898`）里复现：只把本轮测试文件拷进该 worktree，并把 `app/node_modules` 与 `app/packages/omp-runtime/dist` 以符号链接指向本机已构建产物；`app/scripts/release-package.mjs` 保持起点版本（sha256 `e4685c901d0d816f23235c6df17714642b1c068f670cea289ac14520b5eb26ab`）。因此每一条判红都只可能来自 F1/F2 本身，而不是环境。

| 复审问题 | RED 命令（起点 worktree） | RED 观察 | GREEN 命令（本轮工作树） | GREEN 观察 |
| --- | --- | --- | --- | --- |
| F1/F2 全部新增用例 | `node --test apps/desktop/test/omp-release-gate.test.mjs` | **6 failed / 10 passed**（失败项：`the config allowlist is exactly the signature overrides the fixed lanes pass`、`an electron-builder platform switch is the same axis as --platform`、`every unsupported spelling of an owned axis or a packaging input is refused before spawning`、`a conflicting or repeated target is refused instead of silently picked`、`the entry generates exactly one choice per axis and the same target for both steps`、`every option the installed electron-builder CLI declares is classified by the entry`；第一条失败即 `["--platform","darwin","--arm64","--win=portable"] must be refused with exit code 2`） | 同命令 | **16 passed / 0 failed** |
| F1 平台/发布/架构轴分叉 | `node /tmp/m5-probe/red-probe5.mjs`（把 RED/GREEN 共用探针指到起点 worktree） | `--win=portable`：code 0、spawn 2、builder targets `mac`+`windows`(portable)；`--publish never -p always`：`publish: ["never","always"]`；`--x64 --no-x64`：预检 darwin/x64 而 builder `x64: false` | `node /tmp/m5-probe/green-probe5.mjs`（同一探针切到本轮工作树） | 七项全部 `code=2`、`spawns=0`，错误分别指名 `--win=portable`、`--prepackaged`、`-p`、`--no-x64`、`--projectDir`、`-c`、`-c.files[0].from=…` |
| F2 最终来源可被换 | 同上探针（`--prepackaged /tmp/foreign.app`、`--projectDir /tmp/elsewhere`、`-c /tmp/foreign.yml`、`-c.files[0].from=/tmp/foreign`） | 四项均 code 0、spawn 2；builder 自己的 parser 解析出 `prepackaged`/`projectDir`/`config`（含 dotted 合成对象） | 同上 | 四项全部 code 2、spawn 0 |
| 契约来源 | — | — | `omp-release-gate` 的 `every option the installed electron-builder CLI declares is classified by the entry` | 用已安装 electron-builder 的 `createYargs()` + `configureBuildCommand()` 读出 `options.key` ∪ `options.alias` 与 `choices.publish`，与 wrapper 的归类表/取值表逐项比对；缺项、多项或 choice 变化都会判红 |
| 真实入口（非探针） | — | — | `pnpm --filter @pi-desktop/desktop exec node ../../scripts/release-package.mjs --platform darwin --arm64 --win=portable`；`OMP_SIDECAR_SOURCE=/tmp/r4b/oh-my-pi node scripts/release-package.mjs --platform darwin --arm64 --publish never -c.mac.identity=… -c.mac.forceCodeSigning=true -c.mac.notarize=true` | 前者 `RELEASE-PACKAGE-FAIL a platform target list is not supported: --win=portable`、wrapper exit 2（pnpm 外层 exit 1）；后者参数全部接受并进入 `--preflight --platform darwin --arch arm64`，随后按跨目标语义拒绝（`provenance platform is linux, this host is darwin`，exit 1） |

第五轮 GREEN 计数（本机 Linux x64，Node v24.14.0、pnpm 10.34.5）：`pnpm build:js` exit 0；`pnpm --filter @pi-desktop/omp-runtime typecheck` exit 0；`pnpm --filter @pi-desktop/desktop typecheck` exit 0；`git diff --check` exit 0；`omp-runtime` 全套 **23 files / 350 passed / 6 skipped**；opt-in 真实产物 smoke **9 passed**；`apps/desktop` 全量 `env -u SSH_ASKPASS node --test test/*.test.mjs` **2952 tests / 2949 passed / 3 skipped / 0 failed**。
