# OMP 会话“审阅”标签显示文件改动验证（2026-11-05）

- 分支与工作树：`codex/omp-review-changes`，`.worktrees/omp-review-changes`，基线 `main` `da808825`。
- 依据：用户 2026-11-05 要求“先按照第一步”：让工作面板“审阅”标签在 OMP 会话里列出改动（上游“本回合改动”卡片留作第二步）。
- 运行时：Node `v24.14.0`（`nvm use 24`）；pnpm `10.34.5`；OMP 运行时为子模块固定的上游 18.3.0 检出（`62bc57b`），由测试通过 `findPinnedLauncher` 启动；模型为本地 `FakeProvider` 脚本，未调用任何真实或付费模型。

## 原状态（基线）

- “审阅”标签只读取 Pi 的 `Write`/`Edit` 工具结果里的审阅快照（`details.review`）。OMP 原生工具名是 `edit`/`write`，结果中没有这份快照，适配层也不生成，因此 OMP 会话的“审阅”标签始终显示“当前对话没有记录的改动”。
- 证据：新增的真实运行时 e2e 中，`reviewChangesFromMessages(history.messages)`（原有读取函数）对 7 个真实改动返回 `[]`。

## 实测的 OMP 结果结构

用真实 OMP 运行时 + 本地脚本化模型执行 `write`（新建、覆盖）与默认 hashline `edit`（一次改两个文件、删除、重命名、单文件修改），读取实时 `tool_end` 与恢复后的历史行：

| 结果 | `details` 内容 | 结论 |
| --- | --- | --- |
| `write` | 只有 `resolvedPath`（绝对路径） | 没有写入前内容，也不区分新建或覆盖，只能列出路径 |
| `edit` 单文件 | `path`、`op`、`diff`、`oldText`、`newText` | `diff` 是 OMP 自己逐行比较得到的带行号行（`-1|a1`、`+1|A1`、` 2|a2`），上下文行用旧行号；所有改动行都在，计数准确 |
| `edit` 多文件 | `perFileResults[]`，每项同上，另有拼接的总 `diff` | 按文件拆行 |
| 删除 | `op: "delete"`，`diff` 为空，`oldText` 为原内容 | 用 `oldText` 生成删除行 |
| 重命名 | `diff` 为空，`move`/`path` 为目标，`sourcePath` 为源 | 状态为重命名，计数 0/0 |
| 恢复后的历史行 | 没有 `toolArgs` | 不能依赖工具参数；只读 `toolResult.details`，实时与恢复一致 |

另据 OMP 源码（`crates/pi-edit/src/engine.rs`），`patch`/`apply_patch` 编辑模式下 `diff` 是普通 unified diff，适配层同时支持。

## 实现

- `apps/desktop/src/lib/omp-review-changes.ts`（新增）：只读适配层。只认 OMP 原生 `edit`/`write`（以工具名加结果形状判定，Pi `Edit`/`Write` 与名字以 edit 结尾的插件不受影响；带 Pi 快照的消息只由 Pi 卡片读取）。不伪造 Pi 快照、不生成快照 id、不调用宿主、不提供回退，与 M5 记录的“不伪造 Pi review 快照、不声称 revert 能力”一致。无法证明的计数（快照被裁剪的删除、被 4 MiB 行预算截断的结果、写入）为空，不算 0。展示行数上限 400，计数仍按全部行计算。
- `workspace-review.ts`：新增 `reviewTabEntriesFromMessages` 与 `summarizeReviewTabEntries`，按消息顺序合并 Pi 快照与 OMP 行；合计只计入有证据的行数。原有 Pi 函数不变。
- `OmpReviewChangeCard.tsx`（新增）：与 Pi 行相同布局；状态字母 A/M/D/R/W；路径相对当前工作区（与转录文件链接同一规则 `toWorkspaceRel`），工作区外显示绝对路径；重命名显示“源 → 目标”；展开后显示 diff 或说明，并注明只读；没有回退按钮。
- `ReviewChangeCard.tsx`：把 hunk 渲染抽成 `ReviewDiffHunks` 供两种行共用，Pi 行为不变。
- 转录中不为 OMP 结果增加 InlineReviewCard（工具行详情已显示 diff）。
- i18n：8 种语言各新增 5 个键（`written` 状态、只读说明、写入无差异说明、无计数时的展开/收起标签）。
- 规格（中英）：`04-ux/09-interaction-patterns.md`、`04-ux/08-component-spec.md`、`06-delivery/04-e2e-test-plan.md`（新增 `E2E-REVIEW-omp-native-changes-listed-read-only`）。
- 无 IPC、持久化、宿主或 OMP 补丁改动。

## 命令与结果

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test test/omp-review-changes.test.mjs` | 0 | 9 通过：多文件、多段 hunk 行号、unified diff、删除/新建/重命名/快照裁剪、写入、失败/no-op/Pi/插件排除、截断、展示上限、合并顺序与合计 |
| `node --test test/omp-review-tab-mounted.test.mjs` | 0 | 1 通过：真实 store 挂载 ReviewTab，Pi 与 OMP 混排、相对路径、重命名显示、展开 diff、只读说明、无回退按钮、写入说明、合计 |
| `node --test test/omp-review-changes-e2e.test.mjs` | 0 | 1 通过：真实 OMP 运行时；基线函数返回 `[]`；7 条条目与预期逐项一致；实时行与恢复行结果相同；磁盘文件确实被改 |
| `node --test test/chat-review-entry.test.mjs` 等相关套件 | 0 | 通过（源码断言随 `ReviewDiffHunks` 与新函数名更新） |
| `node --test test/*.test.mjs`（desktop 全量） | 0 | 3269 项：3234 通过，35 跳过，0 失败 |
| `pnpm --filter @pi-desktop/desktop run typecheck` | 0 | 通过 |
| `pnpm --filter @pi-desktop/i18n test` | 0 | 25 通过 |
| `pnpm --filter @pi-desktop/docs run check:locales` | 0 | 80 组规范对通过 |
| `node scripts/check-architecture.mjs` | 0 | 通过 |
| `git diff --check` | 0 | 通过 |
| `npx biome lint <改动文件>` | — | 不适用：biome 配置的 `files.includes` 不覆盖这些目录（与 R20 相同） |

全量与真实运行时测试需要上游子模块：本工作树的两个子模块目录为空，运行期间临时链接到主检出同 SHA 目录，运行后已恢复为空目录，未提交。

## 未验证与限制

- 未在打包后的桌面应用里实际点开“审阅”标签截图；界面层由挂载测试覆盖，数据层由真实运行时 e2e 覆盖。
- e2e 使用上游固定检出 `62bc57b`，不是产品使用的受控 fork `edec3898`；fork 补丁集中在桌面闸门，不涉及 `edit`/`write` 结果结构，但未用 fork 实测。
- `write` 只能显示路径，不显示内容和计数（OMP 未提供）。
- 路径相对化依赖 OMP 报告的路径与工作区路径前缀一致；macOS 上 `/private/var` 与 `/var` 这类符号链接等价路径会显示为绝对路径（与转录文件链接现状相同）。
- 未提交、未合并。

## 第二步：回复下方的“本轮改动”卡片（2026-11-06）

用户 2026-11-05 要求“做第二步”，并要求完成后本地打包自测。同一分支与工作树继续。

### 上游做法与移植

上游 PI-Desktop `73b714ed`（feat(chat): summarize each turn's changed files under the reply）与 `c19c3387`
（fix(transcript): collapse turn change summaries by default）。移植内容：

| 上游 | 本仓库 | 差异与原因 |
| --- | --- | --- |
| `lib/turn-changed-files.ts`：按路径合并本回合的 Pi 审阅快照 | 同名文件 | 改为基于第一步的合并条目（Pi 快照与 OMP 行）；状态增加 `R`（重命名，保留源路径）与 `W`（OMP 整文件写入）；任一改动缺少行级证据时该文件计数为空，合计只计有证据的行；`snapshotIds` 改为通用的审阅行键 `reviewKeys` |
| `lib/review-focus-request.ts` | 同名文件 | 字段名 `snapshotIds` → `reviewKeys`，其余相同 |
| `TurnChangesCard.tsx`（`c19c3387` 最终版，默认折叠） | 同名文件 | 本仓库没有 `useSlotSessionId` 与渲染插槽，打开“审阅”改用单窗格的 `openWorkPanelTab`（当前会话）；折叠状态键改为 `disclosureKey("turn-changes", turnId)`；路径按工作区相对显示，重命名显示“源 → 目标”；无计数时使用新键 `chat.turnChangesOpenNoCounts` |
| `styles/turn-changes.css`（`c19c3387` 版） | 原样 | R/W 沿用 M 的标记颜色 |
| `AssistantTurn.tsx`：`slotReply` 时挂载 | 同位置 | 本仓库没有 `slotReply`，用等价条件 `complete && actionMessage`；工具消息取自本回合活动项 |
| `ReviewTab.tsx` / `ReviewChangeCard.tsx`：焦点请求、`openRequest`、`data-snapshot-id` | 同 | 两种行统一用 `data-review-key`，OMP 行同样支持展开请求 |
| i18n（9 种语言） | 本仓库 8 种语言 | 上游译文原样，另增 `turnChangesOpenNoCounts` |
| 测试 `turn-changes-card.test.mjs`（依赖上游 `slot-ssr` 辅助） | 同名文件 | 本仓库无该辅助，改用已有的 `TranscriptEntryView` 挂载方式；补 OMP 用例 |
| 规格 | 中英 `08-component-spec.md`、`04-e2e-test-plan.md`（`E2E-CHAT-turn-changed-files-summary`） | 写明 OMP 状态与计数规则 |

未移植：上游 0.22 的 `SidebarMenuPanel`/渲染插槽等无关重构；上游的 `capture-rig` 截图钩子。

### 命令与结果（第二步）

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test test/turn-changes-card.test.mjs` | 0 | 9 通过：Pi 合并计数与状态、回退标记、失败/临时/非文件不计、OMP 合并（W/R/D、未知计数、合计）、焦点请求、无边框 CSS；挂载：回复下方默认折叠、展开后相对路径与状态、点行打开“审阅”并只展开该行、15 个文件的紧凑行/12 行上限/“还有 3 个”/查看全部只揭示不展开、Pi 回退标记、流式/失败/无改动不显示 |
| `node --test test/*.test.mjs`（desktop 全量，含第一步与第二步全部新测试及真实运行时 e2e） | 0 | 3278 项：3243 通过，35 跳过，0 失败 |
| `pnpm --filter @pi-desktop/desktop run typecheck` | 0 | 通过 |
| `pnpm --filter @pi-desktop/i18n test` | 0 | 25 通过 |
| `pnpm --filter @pi-desktop/docs run check:locales` | 0 | 80 组规范对通过 |
| `node scripts/check-architecture.mjs` | 0 | 通过 |
| `git diff --check` | 0 | 通过 |

全量运行时两个子模块目录临时链接到主检出同 SHA 目录，运行后恢复。

### 第二步的限制

- 卡片只在回复完成且无错误时显示（与上游一致）；回合中途出错时不显示，即使已经改了文件。
- “审阅”标签只能显示当前会话的改动；点击后台会话卡片的行不会发生（卡片只在当前会话转录中渲染）。
- 未在打包应用中实际操作卡片，本地测试包交由用户验证。

## 本地测试包（2026-11-06）

用户要求完成后本地打包自测。包由工作树未提交的改动构建（基线 `main` `da808825` + 第一步与第二步），
未签名、未公证，版本面仍为 0.1.6，只用于本机测试；不含 R21（侧栏菜单修复，位于另一分支）。

- 命令（工作树 `app/`）：`OMP_SIDECAR_SOURCE=<根目录>/.omp-sidecar-edec389 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pi-desktop/desktop run dist:mac --arm64`。
  第一次 exit 1：electron-builder 下载时 TLS 连接被断开（`Client network socket disconnected before secure TLS connection was established`）；
  加 `HTTPS_PROXY`/`HTTP_PROXY=http://127.0.0.1:7897`（本机代理）重试 exit 0。
- 运行时：受控 fork `edec3898`，OMP 18.3.0（与 `app/patches/oh-my-pi/manifest.json` 一致）。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.6-arm64.dmg | 221369368 | ca0581a4a0baa6cd68d0662c08fc49ef91b22a33eceae21d5221362708cb8aec |
| OMP-Desktop-0.1.6-arm64-mac.zip | 220294818 | 7d21c093f1bcf81bbafa3e5723703a668c271a4d0f31fd5d1b120863131c1322 |

DMG 复制为 `~/Downloads/OMP-Desktop-0.1.6-review-changes-20261106-arm64.dmg`；ZIP 在工作树 `app/apps/desktop/release/`（已忽略）。

| 检查 | 结果 |
| --- | --- |
| `hdiutil verify` | VALID |
| `verify-installed-product --app <DMG 内应用>` | exit 0 |
| `verify-packaged-runtime --resources <DMG 内 Resources>` | exit 0（停止后 `stopped/reaped/cleaned` 均为 true） |
| 解出 `app.asar`：渲染进程含 `turn-changes-card` 样式与组件、`turnChangesOpenNoCounts`、`ompWriteNoDiff` | 是 |

未在安装包中运行真实模型或操作界面；界面验收由用户进行。

## 补充：变动列表右键“打开文件 / 在文件夹中打开”（2026-11-06）

用户看到卡片后要求“直接能预览文件，不只是 diff”。讨论后决定：点行仍进“审阅”看 diff；在变动列表的行上增加右键菜单，
含“打开文件”和“在文件夹中打开”。

上游参照：PI-Desktop `ea89f43f`（feat(review): add native turn history and guarded file actions）在“审阅”标签为每个文件
提供内置打开、外部打开、在文件夹中显示，并要求精确路径匹配（不回退到同名文件）。本仓库没有其审阅历史面板，这次只在
变动列表行上加右键菜单，复用本仓库聊天文件引用已有的打开路径。

实现：
- `hooks/use-preview-target.ts`：打开选项新增 `exact`，解析结果不是 `exact-relative`/`exact-absolute` 时提示找不到并停止，
  不打开同名文件；新增 `useRevealChatFileRef`，经宿主解析后调用已有的 `fsReveal`（主进程按会话允许范围校验）。
  不传 `exact` 的既有调用行为不变。
- `TurnChangesCard.tsx`：行 `onContextMenu` 打开共享 `ContextMenu`，菜单项由导出的纯函数 `turnChangedFileMenuItems` 生成：
  “打开文件”走与聊天文件引用相同的应用内预览；“在文件夹中打开”调用系统文件管理器。已删除的文件、远程会话两项均禁用。
  会话允许范围以外的文件（如 `/tmp/...`）由宿主拒绝，提示找不到。
- i18n：8 种语言新增 `turnChangesOpenFile`、`turnChangesRevealFile`、`turnChangesFileActions`、`fileRevealFailed`。
- 规格（中英）：`08-component-spec.md` 本轮改动行、`E2E-CHAT-turn-changed-files-summary` 步骤与预期。
- 无新增 IPC、权限或文件读取范围。

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `node --test test/turn-changes-card.test.mjs` | 0 | 12 通过（新增 3：菜单项与禁用条件；经模拟宿主的精确打开/显示，同名文件被拒绝且提示，未加 `exact` 的聊天引用仍可补全；挂载后右键弹出两项且不打开“审阅”） |
| `node --test test/*.test.mjs`（desktop 全量） | 0 | 3281 项：3261 通过，20 跳过，0 失败（跳过数比上次少 15：本工作树打包后存在运行时资源，环境门控用例得以运行） |
| `pnpm --filter @pi-desktop/desktop run typecheck` | 0 | 通过 |
| `pnpm --filter @pi-desktop/i18n test` | 0 | 25 通过 |
| `pnpm --filter @pi-desktop/docs run check:locales` | 0 | 80 组规范对通过 |
| `node scripts/check-architecture.mjs` | 0 | 通过 |

重新打本地测试包（同一命令，经本机代理）：exit 0。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.6-arm64.dmg | 221372588 | 0c8fbdd5afacd436ff0db0bbfbd93b49367a1b9ee5cd0058fd7145410735d2e9 |
| OMP-Desktop-0.1.6-arm64-mac.zip | 220297943 | 38d56f20077bfeb2e5268da4f4904f50ea58c51f324ddf5487475562ce7f8803 |

`hdiutil verify` VALID；`verify-installed-product` exit 0；`verify-packaged-runtime` exit 0；`app.asar` 含
`turnChangesRevealFile`、`fileRevealFailed`、`reveal-file`。DMG 复制为
`~/Downloads/OMP-Desktop-0.1.6-review-changes-menu-20261106-arm64.dmg`（上一包保留）。未在安装包中实际右键操作，由用户验收。


## 合并本地测试包：R21 + R22（2026-11-09）

用户要求“本地打包一个看下效果”。R22 自 11-06 打包后只改了文档，已有包即为最新；R21（侧栏菜单修复）尚无安装包。
因此另建临时分离工作树 `.worktrees/preview-r21-r22`（基线 `main` `da808825`），放入两份未提交改动，一次安装可同时验收：

- R22：本工作树相对 `main` 的全部已跟踪改动与未跟踪文件。
- R21：`codex/sidebar-menu-viewport` 工作树中 `app/apps`、`app/scripts` 的改动与未跟踪文件（`Sidebar.tsx`、`sessions.css`、
  `sidebar-floating-menu.ts` 及其测试）；R21 的文档改动与 R22 重叠，构建不需要，未放入。两份产品代码无重叠文件，`git apply` 无冲突。
- `node_modules` 与 `app/target` 由本工作树 `cp -Rc` 克隆。

运行时：Node v24.14.0、pnpm 10.34.5；受控 fork `edec3898`（`OMP_SIDECAR_SOURCE=<根目录>/.omp-sidecar-edec389`，与清单一致）。

| 命令（临时工作树） | 退出码 | 结果 |
| --- | --- | --- |
| `pnpm --filter @pi-desktop/desktop run typecheck`（先跑） | 2 | 依赖包 `dist` 未构建，找不到 `@pi-desktop/shared`；同时启动的测试挂起 10 分钟后被手动终止 |
| `pnpm run build:deps`（`apps/desktop`） | 0 | 通过 |
| `pnpm run typecheck`（`apps/desktop`） | 0 | 通过 |
| `node --test --test-timeout=120000` 六个文件：`sidebar-floating-menu`、`sidebar-navigation`、`turn-changes-card`、`omp-review-changes`、`omp-review-tab-mounted`、`chat-review-entry` | 0 | 53 通过，0 失败，0 跳过 |
| `OMP_SIDECAR_SOURCE=… CSC_IDENTITY_AUTO_DISCOVERY=false HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:7897 pnpm --filter @pi-desktop/desktop run dist:mac --arm64`（`app/`） | 0 | 未签名、未公证；版本面 0.1.6 |

未运行桌面全量测试与 E2E。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| OMP-Desktop-0.1.6-arm64.dmg | 221372468 | ad83459069d778d5cc191438f5e3486b8e396c54ff79e36848efff43e1a20484 |
| OMP-Desktop-0.1.6-arm64-mac.zip | 220296223 | 20e23c246406fc4eaab23290182ed67743780ba0fb3632aa5e21493f37364534 |

| 检查 | 结果 |
| --- | --- |
| `hdiutil verify` | VALID |
| `verify-installed-product --app <DMG 内应用>` | exit 0 |
| `verify-packaged-runtime --resources <DMG 内 Resources>` | exit 0（`stopped/reaped/cleaned` 均为 true，无残留 run；本机无 `/proc`，子进程环境不可读） |
| 解出 `app.asar`：含 `turnChangesRevealFile`、`fileRevealFailed`、`turn-changes-card`、`sidebar-floating-menu` | 是 |
| 构建产物 CSS：`.sidebar-row-menu,.sidebar-popover` 含 `max-height:min(360px,100vh - 16px)` 与 `overflow-y:auto`（R21） | 是 |

DMG 复制为 `~/Downloads/OMP-Desktop-0.1.6-review-sidebar-20261109-arm64.dmg`（之前两个包保留）；ZIP 在临时工作树
`app/apps/desktop/release/`（已忽略）。未在安装包中实际操作界面，由用户验收。临时工作树只用于打包，R21/R22 后续改动不会自动同步到其中。
