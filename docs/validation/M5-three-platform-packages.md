# M5 三平台测试包：发布准备（macOS arm64 / Windows x64 / Linux x64）

本记录交付 M5 阶段的**发布准备**：可供根复审的三平台打包工作流、安装身份修正、发布前/发布后校验脚本及其测试与证据。
**本阶段不创建 tag、不触发 Actions、不创建或上传 Release**；真实三平台 native CI 与统一 prerelease 由根在复审通过后按受控 `m5-test-*` tag 触发。
2026-10-03 根在 `0a4750d0` 复审后列出 R1–R3 必须补正项，本轮普通追加提交完成（见 §10）；交付范围与功能不变。

- 工作树：`/home/vv/person/code/omp-desktop-m5-packages`，分支 `codex/m5-three-platform-packages`
- 基线：`860c264177314f5c9501f90c2ef6bcbcd6aaa11b`（根独立验收通过的 M5 功能最终提交）
- 固定子模块：PI `0111e306c120ad5820688d7608cb37bad8fbcc1f`、OMP `62bc57be1b03ef0802a33cf7f5f530e534527531`（未动）
- 受控 fork：`MisterBowie/oh-my-pi` @ `36483311dfff67be7504f591974df93fc512a45a`（tree `7ba57b6d06fb8fe7e3f6352c67692e56cf39c3cd`），补丁级 `62bc57b+omp-desktop.5`（从 `app/patches/oh-my-pi/manifest.json` 读取，工作流只引用不重写）
- 模型调用：**零**（全部本地 FakeProvider；不调用付费模型）
- Cursor + Plan/Goal 排除与 ADR 0306 全部门：**不变**（`docs/validation/M5-t20-capability-ui` 的既有证据不改写）

## 1. 先例核对（PI → 产品 → 自有 fork），哪些复用哪些不同

| 来源 | 观察 | 本阶段处理 |
| --- | --- | --- |
| PI `.github/workflows/release.yml` | 四平台矩阵（mac arm64/x64、win x64、Linux x64）、`ubuntu-22.04` 保 glibc 2.35、`verify` 前置作业、每平台 `dist:*`、mac 签名/公证与 `latest*.yml` 发布、node24/pnpm 冻结/`cargo --locked` | **复用**矩阵形态、runner 理由、`--locked` 与冻结安装、`--publish never`；**不继承**签名/公证/更新 feed/`softprops` 发布步骤，也不继承其"下载上游资产"式入口 |
| 产品 `app/.github/workflows/release.yml`、`linux-package.yml` | 包装链、`OMP_SIDECAR_SOURCE`、fork 检出（`fetch-depth: 0`）、bun 1.4.2、`bun install --frozen-lockfile`、安装产物断言 | 同形复用；**这些文件位于 `app/.github/`，在本仓库不会自动触发**，生效入口只有根 `.github/workflows/` |
| 根 `.github/workflows/mac-preview-package.yml` | 旧 Mac 预览：`gh release upload m5-preview --clobber`、无包内验收 | **保留不动**（旧 `m5-preview` 资产不 clobber、不继承其发布步骤）；仅同步其引用的产物名（身份改名后旧名不再存在） |
| `app/scripts/omp-sidecar.mjs`、`release-package.mjs`、`verify-packaged-runtime.mjs` | 打包链唯一入口；预检先于 electron-builder；打包资源验收入口（hash/provenance/version/protocol/get_state/精确 missing-gate 拒绝/停止回收/runroot 清理） | **直接复用**：工作流不新增打包路径，也不在 electron-builder 之后注入资源 |
| 自有 fork `packages/natives`（native addon） | 干净检出**没有** host N-API addon，编译内嵌前必须先构建（`bun run build:native`，rust-toolchain.toml 固定 nightly-2026-08-12） | 工作流新增该前置步骤；本地构建时实际复现了缺失报错（`No native addons found for linux-x64`）后才补齐 |

## 2. 交付物

### 2.1 根工作流 `.github/workflows/three-platform-test-packages.yml`

- **触发**：仅 `push: tags: ["m5-test-*"]`。不声明 `workflow_dispatch`（该按钮只在默认分支可见，本分支不得写 main；分支 dispatch 也没有可绑定的已复审 tag）。推准备分支本身不启动任何打包。
- **guard 作业**：拒绝非 `m5-test-*` tag 事件；`git rev-parse refs/tags/<tag>^{commit}` 必须等于 `GITHUB_SHA`，检出 `HEAD` 也必须等于它（不使用默认分支、不使用任意 tag 指向的别的 SHA）；从产品 `package.json` 与 manifest 读出 version/patchLevel/fork commit 供下游使用。
- **build 作业矩阵**：macOS arm64（`macos-15`）、Windows x64（`windows-latest`）、Linux x64（`ubuntu-22.04`，沿用 PI 的 glibc 2.35 理由）。每格实际断言：`uname -m`（arm64 / x86_64）、Windows `PROCESSOR_ARCHITECTURE=AMD64`、以及 `process.platform/process.arch`；检出 `HEAD` 必须等于 guard 的 revision。
- **工具链**：`pnpm/action-setup` 从 `app/package.json` 的 `packageManager`（10.34.5）、node 24（缓存 `app/pnpm-lock.yaml`）、桌面 Rust 用 stable（与其自身 CI 一致）、fork 检出 `fetch-depth: 0` 后从 `rust-toolchain.toml` 安装其 nightly（**两者不混用**）、bun 1.4.2、`bun install --frozen-lockfile` + `bun run build:native`。
- **打包**：`pnpm install --frozen-lockfile`（app）与 `cargo build --release --locked -p host-core`，随后 `pnpm --filter @pi-desktop/desktop run dist:<platform> -- --<arch>`（cwd `app/`）。`--publish never` 在 dist 脚本内；工作流自身**不**传递平台/配置/publish 参数，也不使用 `--prepackaged`/`--projectDir`/`-c.*`。macOS 为未签名通道（`CSC_IDENTITY_AUTO_DISCOVERY=false`，无任何签名/公证 secret）。
- **包内验收**：把**本次 electron-builder 输出**的 `Resources` 复制到仓库外、含空格与中文的路径，配自有 HOME/XDG/TMPDIR，再运行生产 `verify-packaged-runtime.mjs --resources <copy> --json`（hash/provenance、version/protocol/`get_state`、精确 missing-gate 拒绝、停止/进程组回收/runroot 清理）。不使用源码目录 `apps/desktop/resources` 代替。
- **包内 Plan/Goal 回归**：`OMP_E2E_PACKAGED_RESOURCES` 指向同一份隔离副本，运行既有真实 `omp-plan-submit-e2e.test.mjs`（同一套 Entry/Goal/Submit 用例），驱动**包内** sidecar 与打包后的 gate bundle；仅本地 FakeProvider。回归用自有干净 scratch 根（见 §5 结论 3）。
- **上传**：每平台 `package-<platform>-<arch>`（实际包 + `build-record.json`）与 `reports-<platform>-<arch>`（原始 `packaged-runtime.json`、`plan-goal.txt`；失败时另含 `packaged-runtime.stderr.txt`＝verifier stderr + 退出状态）两组 Actions artifacts。隔离根在可能失败的验收命令之前写入 step output，失败时也上传诊断报告且保留原失败退出码（§10 R3）。
- **发布（仅 tag 事件，`needs: [guard, build]`）**：`assemble-test-release.mjs` 要求恰好三个平台、逐项复核 revision/version/stage/patchLevel/fork、重算每个载荷的 sha256、拒绝 `latest*.yml` 与 `*.blockmap`、生成**只含载荷**的 `SHA256SUMS.txt`（自排除）+ `BUILD-RECORD.json` + release notes；随后 `gh release create <tag> --verify-tag --prerelease`（不 `--latest`、不 `--clobber`、不触碰 `m5-preview`）；最后回读 `releases/tags/<tag>`（tag/prerelease/draft/资产名与字节/下载 URL）、断言该 Release **不是**仓库 `latest`、下载全部资产并 `sha256sum -c` 复核。

### 2.2 安装身份修正（并存所需的最小配置）

| 位置 | 旧值 | 新值 |
| --- | --- | --- |
| `apps/desktop/package.json` `desktopName` | `pi-desktop.desktop` | `omp-desktop.desktop` |
| `win.executableName` / `nsis.shortcutName` | `PI-Desktop` | `OMP Desktop` |
| `portable.unpackDirName` | `PI-Desktop-Portable` | `OMP-Desktop-Portable` |
| `linux.executableName` | `pi-desktop` | `omp-desktop` |
| `deb/rpm.packageName` | `pi-desktop` | `omp-desktop` |
| artifactName（mac/dmg/linux/nsis/portable/deb/rpm） | `PI-Desktop-…` / `pi-desktop…` | `OMP-Desktop-…` / `omp-desktop…`（新增 `linux.artifactName`，AppImage 不再用带空格的默认名） |
| `description` / `homepage` | `PI-Desktop Electron application` / `vastsa/PI-Desktop` | `OMP Desktop Electron application` / `MisterBowie/omp-desktop`（deb/rpm 的 Description 与 Homepage/URL 由此而来） |
| `build.mac.extendInfo` 权限说明 | 含 `PI-Desktop` | 含 `OMP Desktop` |
| `PI-Desktop-macOS-open.command`、`PI-Desktop-macOS-opening-help.txt` | 旧名与旧文案 | 重命名为 `OMP-Desktop-macOS-*`，文案改 OMP，`APP_BUNDLE_NAME="OMP Desktop.app"`；**仍不使用 sudo、不接受任意路径、不要求任何密码**，只做原用途（校验 bundle id 后清 quarantine 并打开） |
| `scripts/export-linux-asar.mjs`、`scripts/verify-macos-release.sh`、mac 相关脚本注释 | 旧产物名 / `PRODUCT_NAME=PI-Desktop` | OMP 名 |

**保留**：`@pi-desktop/*` 内部命名空间、`pi-desktop-host-core` host 文件名、上游 `author`（vhk 与 LICENSE/版权声明）、许可证与 `THIRD_PARTY_NOTICES`。**未改动**：appId、productName、数据目录与更新源分离（此前已完成）。

### 2.3 新脚本与测试

| 文件 | 作用 |
| --- | --- |
| `app/scripts/stage-test-package.mjs` | 单平台：校验打包 `provenance.json` 对受控 manifest、校验验收报告与回归日志、按精确名收集载荷并改名发布、拒绝无关/意外产物、写 `build-record.json` |
| `app/scripts/assemble-test-release.mjs` | 三平台：要求恰好三平台、复核 revision/version/stage/pins 与磁盘字节、生成自排除 `SHA256SUMS.txt` + `BUILD-RECORD.json` + release notes；另有 `--release-json` 在线发布校验模式 |
| `app/apps/desktop/test/test-package-staging.test.mjs` | 上述两者的行为与拒绝面（夹具驱动，13→14 例） |
| `app/apps/desktop/test/three-platform-package-workflow.test.mjs` | 工作流静态契约（触发/矩阵/守卫/工具链/打包入口/包内验收/发布门） |
| `app/apps/desktop/test/packaging-footprint.test.mjs` | 新增"所有已安装身份均为 OMP 且不与 PI 冲突"契约 |
| `app/apps/desktop/test/packaging-sidecar-source.test.mjs` | 打包来源规则扩展到新的根工作流 |
| `app/apps/desktop/test/omp-plan-submit-e2e.test.mjs` | 新增包内模式（`OMP_E2E_PACKAGED_RESOURCES`）：用包内 sidecar + gate bundle 运行同一套用例并断言 provenance 与 manifest 一致；`resolveHostBinary` 增加 `.exe` 候选 |

## 3. 本机真实运行（Linux x64）

| 验证 | 命令（要点） | 结果 | 证据 |
| --- | --- | --- | --- |
| 真实打包链 | `OMP_SIDECAR_SOURCE=/home/vv/person/code/oh-my-pi pnpm run dist:linux`（cwd `app/apps/desktop`） | **exit 0**，2m38s；`OMP-SIDECAR-PREFLIGHT built linux/x64`；electron-builder 产出 AppImage/deb/rpm | `M5-three-platform-packages/linux-dist-build.log` |
| 打包运行时验收（隔离路径） | 复制真实 `linux-unpacked/resources` → `/tmp/omp-packages 隔离 with spaces-*/Resources`（286M），自有 HOME/XDG/TMPDIR 后 `node scripts/verify-packaged-runtime.mjs --resources … --json` | `mode=run`、omp/18.3.0、protocol v2、`getState=true`、`gateLoadControl=refused`、`stopped/reaped/cleaned` 全真、无残留 run 目录；子进程环境可读（Linux `/proc`）且 PATH/HOME 断言通过 | `linux-packaged-runtime.json` |
| 包内 Plan/Goal 回归 | `OMP_E2E_PACKAGED_RESOURCES=<隔离副本>/Resources node --test apps/desktop/test/omp-plan-submit-e2e.test.mjs` | **15 passed / 0 failed / 0 skipped**（B2 提交/审批/派发 + T20-D Entry/Goal/生命周期全部在包内 sidecar + 包内 gate 上重跑） | `linux-plan-goal-regression.txt` |
| 真实元数据 | deb 控制字段/文件清单、rpm 元数据/文件清单、安装后 desktop entry、AppImage 内嵌 desktop entry、unpacked 可执行名与 `app-update.yml` | deb `Package: omp-desktop`、`Homepage: MisterBowie/omp-desktop`、`Description: OMP Desktop Electron application`；安装路径 `/opt/OMP Desktop/`、`/usr/share/applications/omp-desktop.desktop`、`Icon/StartupWMClass=omp-desktop`、`Exec="/opt/OMP Desktop/omp-desktop" %U`；rpm `Name omp-desktop`、URL 同上；与 PI 的 `/opt/PI-Desktop`、`pi-desktop.desktop` 不冲突 | `linux-package-metadata.txt` |
| 发布装配（真实 Linux + 两个**合成**平台夹具） | `node scripts/assemble-test-release.mjs --input … --out …` | 装配通过：三平台记录一致、`SHA256SUMS.txt` 只含载荷（不含自身）、`BUILD-RECORD.json` 与 notes 生成 | `assemble-smoke-*`（其中 macOS/Windows 记录是夹具，**不是**真实产物证据） |
| 打包暂存（真实） | `node scripts/stage-test-package.mjs --platform linux --arch x64 …` | 三个载荷改名成功、`latest-linux.yml` 记为 excluded、`build-record.json` 记录 pins/验收/15-0-0/sha256 | `linux-build-record.json` |

本机 rpm 构建需要 `rpmbuild`（系统未安装、无 root）：用 `apt-get download` + `dpkg-deb -x` 把 `rpm`/`librpm*`/`cpio` 解到 `/tmp/m5pkg/rpmroot`（不改系统、不使用 sudo），以 `PATH`/`LD_LIBRARY_PATH`/`RPM_CONFIGDIR` 指向该前缀完成真实 rpm 构建。CI 的 `ubuntu-22.04` 镜像自带 rpmbuild（PI 的 Linux lane 同样在其中构建 rpm）。

## 4. 测试与门（Linux x64 本机，全部实际运行）

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| 身份/打包/工作流相关套件（`packaging-footprint`、`auto-update`、`development-branding`、`ci-workflow`、`macos-release-lane`、`macos-release-verification`、`release-asar`、`preview-workflow`、`packaging-sidecar-source`、`three-platform-package-workflow`、`test-package-staging`） | `node --test <files>` | **75 passed / 0 failed / 1 skipped**（macOS 专属用例按既有约定跳过） |
| 新增脚本的行为测试 | `node --test apps/desktop/test/test-package-staging.test.mjs apps/desktop/test/three-platform-package-workflow.test.mjs` | **20 passed / 0 failed** |
| 全量桌面套件 | `pnpm --filter @pi-desktop/desktop test`（cwd `app`） | **3067 tests / 3055 passed / 1 failed / 11 skipped**；唯一失败为 `remote-host-ssh-password` 的 `SSH_ASKPASS` 环境变量问题（M0 已记录，非回归）：`env -u SSH_ASKPASS node --test apps/desktop/test/remote-host-ssh-password.test.mjs` → **14/14 passed** |
| 构建 / 类型 / 静态门 | `pnpm build:js`、`pnpm --filter @pi-desktop/desktop typecheck`、`pnpm lint`、`pnpm docs:check`、`node scripts/check-release-docs.mjs`、`node scripts/check-t20-matrix-ids.mjs` | 全部 **exit 0** |
| 包内真实回归 | 见 §3 | **15/15** |

11 个 skip 全部是既有的平台/opt-in 跳过（macOS 专属 3 项、`OMP_T21_RESOURCES` 未设置时的 8 项 opt-in 用例）。

**环境对照（写入原始记录 `desktop-suite-environment-note.txt`）**：全新工作树第一次全量跑出现 **44 项失败**，全部集中在"从源码树启动固定运行时"的真实 E2E 文件；共同根因是该工作树**未给固定子模块安装依赖**，bun 对缺失依赖回退到 registry 自动安装（`@oh-my-pi/pi-natives@18.5.0`，其 native addon 不存在）导致运行时无法启动。用同一文件做对照：**基线工作树 `860c2641`（已装依赖）5/5 通过；本树未装依赖 0/5 失败**。按其他工作树同样的方式补齐（`bun install --frozen-lockfile` + `bun run build:native`，两者都不修改 tracked 文件、`git submodule status` 与子模块 `git status --porcelain` 均为空）后全量重跑即得上一行结果。这与三平台包的交付物无关，但记为"CI 之外跑 E2E 需要先完成子模块 provisioning"的操作事实；工作流本身在 CI 中显式执行这两步（见 §2.1），且**同一对步骤在受控 fork 检出上也验证为不脏树**（`bun install --frozen-lockfile` + `bun run build:native` 后 `git status --porcelain` 为空，因此 `omp-sidecar.mjs` 的"工作树必须干净"预检不会被这两步破坏）。

## 5. 实现中发现并处理的问题

1. **干净检出没有 host native addon**：`bun run build:native` 之前，sidecar 编译在 `embed-native` 处失败（`No native addons found for linux-x64. Expected one of: pi_natives.linux-x64-modern.node …`）。工作流因此新增该步骤；这与 fork 自身 `bun setup` 的第 2 步同义，不是自造编译器。
2. **rpm 目标需要 rpmbuild**：本机缺失时 `dist:linux` 在 rpm 处 exit 1（AppImage/deb 已成功）。这是环境前置而非产品缺陷；处理见 §3 末。
3. **隔离路径含空格会污染回归夹具**：把包内回归也放在含空格/中文的路径下时，夹具自身未加引号的 `touch ${marker}` 命令被 shell 拆词（`mixed batch` 用例失败）。修正为职责分离：**含空格/中文路径的隔离验收**由 `verify-packaged-runtime.mjs` 承担（它正是产品侧路径处理能力的证明）；回归改在自有干净 scratch 根运行，同时通过 `OMP_E2E_PACKAGED_RESOURCES` 仍驱动**隔离副本内**的包内 sidecar 与 gate。
4. **`node --test` 摘要格式随 reporter 变化**（TAP `# pass 15` vs spec `ℹ pass 15`）：staging 入口两种都接受、要求恰好一行；工作流固定 `--test-reporter=tap`（该处曾以真实日志复现为 0 行并被拒绝，属预期拒绝路径）。
5. **updater 缓存目录同名（已知、未处理）**：electron-builder 由包名派生 `updaterCacheDirName`（两个产品都是 `@pi-desktop/*` → 同名缓存目录），其值不可通过 electron-builder 配置覆盖；改名会涉及"内部命名空间不做全局替换"的边界。影响限于磁盘缓存共享（两个 feed 的下载文件名不同，不会互相安装）；记入 T22 品牌/分发清理时的待办。

## 6. 命令与退出码汇总

| 命令 | 退出码 | 输出摘要 |
| --- | --- | --- |
| `pnpm run dist:linux`（cwd `app/apps/desktop`，`OMP_SIDECAR_SOURCE` 指向受控 fork 检出） | 0 | 2m38s；`OMP-SIDECAR-PREFLIGHT built linux/x64`；`release/OMP-Desktop-0.15.2-x86_64.AppImage`、`omp-desktop_0.15.2_amd64.deb`、`omp-desktop-0.15.2-x86_64.rpm`、`latest-linux.yml`、`linux-unpacked/` |
| `node scripts/verify-packaged-runtime.mjs --resources "<隔离副本>" --json` | 0 | 见 `linux-packaged-runtime.json` |
| `OMP_E2E_PACKAGED_RESOURCES=<隔离副本>/Resources node --test apps/desktop/test/omp-plan-submit-e2e.test.mjs` | 0 | 15 passed / 0 failed / 0 skipped |
| `node scripts/stage-test-package.mjs --platform linux --arch x64 …` | 0 | 三个载荷改名 + `build-record.json`（`latest-linux.yml` 记为 excluded） |
| `node scripts/assemble-test-release.mjs --input <dist> --out <release> …`（真实 Linux + 2 个合成平台夹具） | 0 | `SHA256SUMS.txt`（3 真实 + 2 合成行、自排除）、`BUILD-RECORD.json`、`RELEASE-NOTES.md` |
| `node --test apps/desktop/test/test-package-staging.test.mjs apps/desktop/test/three-platform-package-workflow.test.mjs` | 0 | 20 passed |
| `node --test <11 个身份/打包/工作流相关文件>` | 0 | 75 passed / 1 skipped |
| `pnpm --filter @pi-desktop/desktop test` | 1 | 3067 / 3055 pass / 1 fail（`SSH_ASKPASS` 环境变量）/ 11 skip |
| `env -u SSH_ASKPASS node --test apps/desktop/test/remote-host-ssh-password.test.mjs` | 0 | 14 passed |
| `pnpm build:js` / `typecheck` / `lint` / `docs:check` / `check-release-docs` / `check-t20-matrix-ids` | 全 0 | — |

## 7. 未运行 / 未证明（不声称）

- **macOS 与 Windows 原生构建/验收未在本机执行**（无对应主机）；其真实结论只能来自根创建 tag 后的 native runner。工作流对"平台/架构/来源/资产集合/发布身份"的静态与脚本级校验**不是**原生通过。
- **未签名、未公证**（macOS 测试通道明确如此）；未做安装器/快捷方式/desktop entry 的真实用户会话验证（T22/T23）。本机只验证了包内元数据（deb/rpm/AppImage 内的 desktop entry 与路径），不是"安装后行为"验收。
- **`.dmg`/`.exe` 未在本机产出或检查**（Linux 无法构建）；Windows 的包内回归是否全绿、是否有平台性 skip，只能由 CI 报告，且发布记录会逐平台写明通过/跳过数。
- **rpm/dmg/exe 的真实安装与共存实测**（与 PI-Desktop 同时安装的实机验证）未做。
- **工作流本身未在 GitHub Actions 实跑过**（本轮不触发）；`gh release create`/`gh api` 路径由脚本与静态测试覆盖，加发布后回读校验，但仍是首次真跑的输入。
- **未创建 tag / 未发布 / 未触碰 `m5-preview` / 未改 main / 未建 PR**。

## 8. 根复审通过后的入口

1. 在根已验收的**精确最终提交**上创建受控 tag（形如 `m5-test-<date>`）并推送；只有该 tag 事件会启动 `Three-platform test packages`。
2. 三个平台 build 作业全绿（含隔离路径验收与包内回归）后，publish 作业才会创建绑定该 tag 的 prerelease（含 7 个载荷、`SHA256SUMS.txt`、`BUILD-RECORD.json`，不含更新 feed、不设为 latest）。
3. 根按 §2.1 的回读断言独立核对 tag→revision、Actions conclusion、每个资产的名称/字节/摘要与下载链接后向用户交付。

## 9. 证据清单

目录 `docs/validation/M5-three-platform-packages/`（含自排除 `SHA256SUMS.txt`，`sha256sum -c` 全 `OK`）：

- 真实运行：`linux-dist-build.log`（R1 后由 Git 精确跟踪，字节未改）、`linux-packaged-runtime.json`、`linux-plan-goal-regression.txt`、`linux-build-record.json`、`linux-package-metadata.txt`
- 装配烟雾（含合成夹具说明）：`assemble-smoke-release-notes.md`、`assemble-smoke-BUILD-RECORD.json`、`assemble-smoke-SHA256SUMS.txt`
- 测试与环境：`tests-and-gates.txt`、`desktop-suite-after-provisioning.log.gz`（确定性 gzip）、`desktop-suite-environment-note.txt`
- 说明：`README.md`（区分真实证据与夹具，避免误读）

返修轮 R1–R3（2026-10-03）另有 `docs/validation/M5-three-platform-packages-repair1-20261003/`（含自排除 `SHA256SUMS.txt`）：R1 完整性检查脚本与输出、R3 失败路径 probe 脚本与输出、相关套件输出、命令账本。

## 10. 返修轮 R1–R3（2026-10-03，根在 `0a4750d0` 复审后）

普通追加提交完成；不重跑编译器/全部桌面套件/昂贵打包（变化仅发布脚本、工作流与对应测试），Mac 77/77、Linux 包内 15/15 与 M5 功能证据继续准确引用。提交坐标：R1 = `2d71acb`，R2/R3 = `615ac93`，文档/证据提交为二者之后的普通追加子提交（最终 HEAD 见 `git log`）。

| 项 | 根列出的问题 | 修复 | 定向证据（`M5-three-platform-packages-repair1-20261003/`） |
| --- | --- | --- | --- |
| R1 | `SHA256SUMS.txt` 列出 `linux-dist-build.log`，但该文件被根 `.gitignore` 的 `*.log` 忽略；原始交付只有 12 个 tracked 文件，清单中的日志缺失 | 仅对该唯一路径 `git add -f`（不改字节、不改其它证据、不重写历史），提交 `2d71acb` | `r1-evidence-integrity.txt`：清单/磁盘/Git tracked 三个 12 文件全集相等（自排除 `SHA256SUMS.txt`），12/12 摘要 `sha256sum` 匹配，日志 18052 B / `9eb36eaa…` tracked=true；修复前 RED 见 `r1-evidence-integrity-pre-add.txt`（恰为 `only manifest: linux-dist-build.log`） |
| R2 | 发布 notes 在 `childEnvironmentReadable=false` 时仍生成 `child PATH/HOME asserted (host does not expose /proc)`；生产 verifier 对无 `/proc` 主机明确返回 readable=false，且只在 childEnv 存在时断言 PATH/HOME | `assemble-test-release.mjs`：可读 → `child PATH/HOME asserted (child environment readable)`；不可读 → `child env not observed (host does not expose /proc; isolated launch config used, PATH/HOME not asserted)`，表后补充"隔离启动配置照常使用、观测不可得时不写已实测"；新增夹具测试覆盖 true/false 两个分支 | `targeted-tests.txt`：相关 11 文件 **78 passed / 0 failed / 1 skipped**（macOS 专属用例按既有约定在 Linux 跳过；含 2 个新增用例）；新增用例 "release notes state the child-environment observation limit instead of asserting it"（Windows false 行不得出现 asserted、Linux true 行断言存在） |
| R3 | 工作流在 `set -e` 下先跑 verifier、后写 `iso` step output；verifier 失败时 `:404` 的 failure artifact 条件 `steps.acceptance.outputs.iso != ''` 为假，报告上传被跳过，verifier stderr 只剩 job log | ① `iso` 在可能失败的验收命令（含 `cp`）之前写入 `GITHUB_OUTPUT`；② verifier 的 stderr 与退出状态保存到 `$iso/packaged-runtime.stderr.txt`（`set +e` → `verify_status=$?` → `set -e` → `exit "$verify_status"`，不 mask）；③ failure artifact 路径加入该文件 | `r3-failure-path-probe.txt`：从工作流提取真实步骤体、将 verifier 替换为以 `PACKAGED-RUNTIME-FAIL`+exit 1 失败的 stub 后运行 → step exit=1（未变绿）、iso 在失败前已发布、stderr 文件含失败消息与 `exit status: 1`；工作流契约测试 "a refused package fails the lane and its diagnosis stays uploadable" 钉住顺序/退出码/上传路径 |

说明：

- verifier 判定强度未降低：readable=false 不跳过断言——同一次运行仍以进程内观测（run root 前缀、config root、decoy 目录、停止/回收/清理）断言隔离，只是 OS 子进程环境观测在无 `/proc` 主机不可得（与 `verify-packaged-runtime.mjs` 现有行为一致，未改动该文件）。
- 原证据目录字节未改：装配烟雾 `assemble-smoke-release-notes.md` 是 R2 修复前的历史输出（Linux 主机可读，行文本为旧 true 分支措辞）；新措辞由新增测试覆盖，不回写旧证据。
- macOS/Windows native 构建/验收仍未在本机运行；tag 与 native CI 仍待根复核后触发（§7/§8 不变）。
