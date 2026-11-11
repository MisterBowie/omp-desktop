# OMP 提问卡自定义答案导致整轮中止修复（R25）验证记录

日期：2026-11-11

## 来由

用户 2026-11-11 反馈：会话“Windows 应用传文件方法”（项目“家政”，OMP 引擎，模型 `deepseek-flash`）中，模型提问后用户作答，
之后没有继续执行，会话显示失败。

## 定位

- 原生会话文件（`~/.omp-desktop/omp-sessions/2026-11-10T16-10-31-106Z_…jsonl`，只读查看）：
  - 16:10:36Z 模型调用 OMP `ask` 工具：单个问题、4 个选项、`recommended: 0`；
  - 63 秒后（16:11:39Z）工具结果为 `Ask tool was cancelled by the user`（`isError: true`）；
  - 紧接一条空的助手消息，`stopReason: "aborted"`、`errorMessage: "Interrupted by user"`，整轮结束。
- 本机日志没有记录这次对话框的决策原因。
- OMP `ask` 在 RPC 下没有富对话框，每个问题以一个 `select` 下发：推荐项标签带 ` (Recommended)` 后缀，最后追加运行时自己的
  `Other (type your own)`；只有选中这一项后，运行时才再发一个 `editor` 对话框收文字（`upstream/oh-my-pi`
  `packages/coding-agent/src/tools/ask.ts` 第 42 行常量，第 609、643–654 行单选流程；受控补丁未改动 `ask.ts`）。`select` 收到
  `cancelled` 时，工具调用 `context.abort()`（第 1055 行）并抛出上述错误，即整轮按“用户中止”结束。
- 桌面端：提问卡对任何问题都提供“输入其他答案”文本框；主进程 `resolveAsk` 只接受与 `select` 原始选项完全一致的答案，
  其余一律按 M3 的失败关闭规则回 `cancelled`（[M3 记录](M3-workflow.md) §5.2：“OMP `select` 无法承载的自定义答案”）。
  于是用户输入的答案在 OMP 侧成了“用户取消”，整轮中止，也就是用户看到的现象。
- 同一处还有第二个缺口：卡片会把 `Other (type your own)` 作为普通选项列出；选中后运行时发来的 `editor` 对话框，桌面端只记一条
  警告，既不展示也不回答，回合会一直等待。M3 记录写的是“以 fail-closed 取消”，与代码不符。
- 结论的确定程度：取消只可能来自跳过、全部拒绝或自定义答案三条路径；用户说明是作答，并且等待了 63 秒，与输入文字一致。
  因此判断用户使用了“输入其他答案”，这一点是推断，日志中没有直接记录。
- 存在时间：桌面卡片的自定义输入与主进程的失败关闭规则自 M3 起即如此，不是 R17–R24 引入的回归。

## 修复

分支 `codex/omp-ask-custom-answer`（`.worktrees/omp-ask-custom-answer`），基于 `main`（`d8bef50b`），代码提交 `e52961dc`。没有修改 OMP 补丁。

- `packages/omp-runtime/src/session/ui-requests.ts`：新增 `OMP_ASK_FREE_TEXT_OPTION`（运行时保留的固定协议标签，不本地化）与
  `offersFreeText`。`resolve(…, { freeText })` 以该选项回答 `select`，并把文字留给同一轮紧接着的 `input`/`editor` 问题
  （`answerFollowUp`）。其他问题、新一轮或停止都会丢弃这段文字；并行工具的审批不会拿到文字，也不会使其失效。对不提供该选项的
  `select` 传入 `freeText` 时拒绝，且不消费该对话框。
- `packages/omp-runtime/src/session/runner.ts`：问题帧先尝试 `answerFollowUp`，命中则直接回答，不再展示；`resolveUiRequest`
  透传 `freeText`。
- `apps/desktop/electron/main/runtime/omp-session.ts`：卡片不再列出 `Other (type your own)`，并标出 `allowCustom`；不在选项内的
  答案，在运行时提供自由文本时走两步投递，否则仍失败关闭；没有卡片的 `input`/`editor` 对话框立即回 `cancelled`，不再悬挂。
- `packages/shared/src/types/agent.ts`：`AskToolQuestion.allowCustom?: boolean`（可选、向后兼容；缺省仍提供自定义答案）。
- `apps/desktop/src/components/AskToolCard.tsx`：`allowCustom === false` 时不显示“输入其他答案”。
- 规格：`docs/spec/03-runtime/17-asktool-questions.md` 新增 §5 OMP engine 及 `allowCustom` 字段说明；E2E 计划新增
  `E2E-OMP-ask-typed-answer`。
- 无持久化、权限语义或 OMP 补丁变化。问题的“跳过 / 全部拒绝”仍回 `cancelled`，由 OMP 按中止处理，行为不变。

## 验证

环境：macOS arm64，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2；OMP 18.3.0 补丁树（子模块 `62bc57be` + `62bc57b+omp-desktop.7`）。
全部使用本机假服务商，没有真实模型调用。

| 命令 | 结果 |
| --- | --- |
| `node --test test/omp-session-bridge.test.mjs`（`app/apps/desktop`），新增 4 项桥接用例，在 `main` 临时工作树上运行 | exit 1：4 项失败；自定义答案得到 `{ ok: true, outcome: 'cancelled' }`，没有卡片的 `input` 对话框未作回答 |
| 同上，修复后 | exit 0，68/68 |
| `node --test test/omp-ask-custom-answer-e2e.test.mjs`（真实补丁运行时 + 生产桥接 + 假服务商：输入答案、列出选项各一次） | 修复后 exit 0，1/1：两种答案均 `answered`，没有出现第二张卡，第二次模型请求中的 `ask` 结果含答案，回合 `completed` |
| 同上，4 个源码文件临时换回 `HEAD`（只去掉卡片形状断言） | exit 1：`typed answer: the answer was delivered`，实际 `{ ok: true, outcome: 'cancelled' }`，与用户现象一致 |
| `vitest run`（`packages/omp-runtime` 全量，含 `ui-requests.test.ts` 新增 6 项） | exit 0，599 通过、6 跳过 |
| `node --test test/asktool-card-custom-answer.test.mjs`（真实 React 挂载） | exit 0，2/2：`allowCustom: false` 时没有自定义行，`true` 或缺省时有；选中列出项提交原标签 |
| `node --test test/permission-inline.test.mjs` 等相关文件合跑（含上述桥接、组件、e2e） | exit 0，83/83 |
| `pnpm --filter @pi-desktop/shared test` | exit 0，1010/1010 |
| 桌面全量 `node --test test/*.test.mjs`，首轮（子模块未初始化） | exit 1，3303 项：3260 通过、5 失败、38 跳过；5 项均为新工作树缺少 `upstream/` 源码（`source does not look like the OMP checkout`、`ERR_MODULE_NOT_FOUND`、launcher 指向）。从根检出的本地子模块初始化后重跑：`omp-desktop-capabilities`、`omp-runtime-launcher` 通过；3 项补丁运行时 e2e 在提供已安装依赖的 OMP 源码后通过（2 项经 `OMP_TEST_SOURCE`，`omp-session-turn-fence-e2e` 在子模块补齐依赖后） |
| 桌面全量第二轮（子模块已初始化，`OMP_TEST_SOURCE=<根检出 upstream/oh-my-pi>`） | exit 0，3304 项：3266 通过、0 失败、38 跳过（15 项缺 host-core 二进制或补丁运行时，12+1 项需要已验证原生资源，8 项需要 `OMP_T21_RESOURCES`，LSP 与记忆各 1 项需要专用运行时；本机安装的是 0.1.8 本地包，与本分支 0.1.7 版本面不符，未提供） |
| omp-runtime / shared / desktop typecheck、`pnpm lint`、`git diff --check` | 均 exit 0 |

## 本地包真实窗口验证

用户 2026-11-11 要求提交后实测。

- 本地包：`e52961dc` 的未签名 arm64 包，
  `OMP_SIDECAR_SOURCE=<根目录>/.omp-sidecar-edec389 CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @pi-desktop/desktop run dist:mac --arm64`。
  第一次在 electron-builder 下载阶段遇到 TLS 断连而失败，随后在 `app/apps/desktop` 下用
  `pnpm exec node ../../scripts/release-package.mjs --platform darwin --publish never --arm64` 只重跑打包步骤并成功。
  版本面仍是 0.1.7（分支基于 `main`）；`OMP-Desktop-0.1.7-arm64.dmg` SHA-256
  `121ab1849a53a9daaf7dce23abb0b00827b306144915fd97456320b093342a25`，在 `app/apps/desktop/release/`（不入库）。
  包内运行时为 fork `edec3898`，SHA-256 `98a005a6…`，与 0.1.6/0.1.7 本地包一致。
- 驱动：临时探针 [ask-window-check.mjs](OMP-ask-typed-answer-20261111/ask-window-check.mjs)（复用
  `scripts/e2e/installed-application.mjs` 的隔离安装与 HOME，以及 `installed-workflow.mjs` 的真实 Composer 操作）。DMG 只读挂载
  后拷到隔离目录启动，数据根在隔离 HOME 下，没有读写用户的 `~/.omp-desktop`。模型是 127.0.0.1 FakeProvider，第一轮调用
  `ask`（2 个选项、推荐第 1 项），第二轮回复固定文字。
- 操作：在真实窗口中通过 Composer 发送“和项目无关 windows app 如何传文件？”；卡片出现后点“输入其他答案”，用 CDP
  `Input.insertText` 输入“从 Mac 通过局域网把文件传到另一台 Windows 电脑”，点“提交答案”。
- 结果：`node ask-window-check.mjs <app> <dmg> <evidence>` exit 0，`result: pass`（[报告](OMP-ask-typed-answer-20261111/ask-window-report.json)）：
  - 卡片只列出模型给的两项（推荐项带 `(Recommended)`）和“输入其他答案”，没有 `Other (type your own)`
    （[截图 1](OMP-ask-typed-answer-20261111/1-ask-card.png)、[截图 2](OMP-ask-typed-answer-20261111/2-typed-answer.png)）；
  - 提交后没有出现第二张卡，模型收到第二次请求，`ask` 工具结果为 `User provided custom input: 从 Mac 通过局域网把文件传到另一台 Windows 电脑`；
  - 原生会话记录依次为用户消息、`toolUse`、`ask` 结果（`isError: false`）、助手回复（`stopReason: stop`），没有 `aborted`；
  - 界面显示模型回复，没有 “Interrupted by user” 或错误卡片，会话不再运行；工具详情显示 `customInput`
    （[截图 3](OMP-ask-typed-answer-20261111/3-turn-completed.png)）。
- 回合正常完成后，侧栏会话行显示的空心圆图标与用户截图中的相同。可见这个图标是正常状态，不表示失败；用户看到的失败是会话中
  “Interrupted by user”的中止。
- 有序退出后无残留进程，隔离目录已清理，临时项目 `/Users/Shared/omp-ask-check` 已删除。

## 未做与遗留

- 本地包只用于本机验证，未签名，版本号仍为 0.1.7，没有覆盖用户安装的应用；真实模型下的人工确认由用户进行。
- 0.1.8 更新记录未写，发布时随版本面一起补。
- OMP 多选 `ask` 仍按运行时的逐次 `select` 显示为单选卡片（既有行为，本次未改）。
- `Other (type your own)` 是运行时的固定标签；升级 OMP 时若该常量变化，`ui-requests.test.ts` 与 e2e 会失败，需要同步。
