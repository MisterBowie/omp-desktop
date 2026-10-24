# 错误卡片关闭按钮（2026-10-24）

状态：**源码与组件测试完成，已提交到任务分支；未并入 `main`，未打包、发布或替换用户安装。**

## 来由

用户反馈：发送被拒（`OMP_PROJECTION_INVALID`：思考等级 `off` 不被 `factory/claude-opus-5-5` 接受）后留下的
红色错误卡片一直显示在转录末尾，后续一轮正常运行时仍挡在下面，没有办法关掉。

只读核对用户本机数据（未读密钥）确认：两次被拒发送在 01:52:34、01:52:49（北京时间），没有形成主机 turn
记录；错误卡片是渲染层在 `queue-slice.ts` 中追加的本地行（随机 id，不持久化）。之后 01:54:42 起的一轮在
会话文件中持续有工具调用，并非卡住。

## 基线与环境

- 工作树 `.worktrees/dismiss-error-card`，分支 `codex/dismiss-error-card`，基于 `main` `43c7cd55`
  （已 fetch，`origin/main` 相同）。
- Node v24.14.0，pnpm 10.34.5（`PATH` 指向 NVM 中的 v24.14.0，不改全局默认）。依赖从根目录检出 APFS 克隆，
  未联网安装；参考子模块从根目录本地克隆按固定 SHA 初始化（`62bc57be`、`0111e306`），并复制 OMP 原生模块与
  生成文件。仓库无 `.codegraph/`，未建索引。

## 实现

1. `AssistantErrorMessage` 新增可选 `onDismiss`；提供时在标题操作区末尾显示仅图标的关闭按钮
   （`chat.dismissError`，带无障碍名称和提示，八种语言）。
2. 新模块 `features/chat/transcript/dismissed-errors.ts`：渲染层内存集合，最多保留 500 次关闭。
   匹配键为行 id 和“失败签名”（`createdAt` + 错误码 + 错误文本）。OMP 实时行（`omp:<s>:<ctx>:<n>`）
   与之后读到的持久化行（`omp:<s>:entry:<id>`）id 不同，但时间戳取自同一条 OMP 消息，签名一致，所以一起
   关闭；同样文本的新失败时间戳不同，仍会显示。
3. `ChatTranscript` 只在生成转录行之前过滤（`withoutDismissedErrors`）；`TurnOutcomeCard` 与复制菜单
   仍读原始消息，所以关闭后不会冒出通用的失败卡片。行本身不删除，事件层的错误去重不受影响。
   同一行中错误前已有的回答文字保留，只去掉卡片。
4. 子代理视图（`ToolRow` 内的子代理回答）不提供关闭按钮。
5. 规格：`04-ux/08-component-spec.md`、`03-runtime/08-error-codes.md`、`06-delivery/04-e2e-test-plan.md`
   （US-UI-60c）。中文规格镜像原本已落后于英文（仍写“重试”），本次未改。

与最初设想的差异：起初只按 id 记录，核对 OMP 事件转换后发现实时行与持久化行 id 不同，改为同时按失败签名匹配。

## 验证

| 命令（目录） | 结果 |
| --- | --- |
| `node --test test/transcript-error-dismiss.test.mjs`（`app/apps/desktop`） | exit 0，5/5：过滤语义、实时/持久化孪生行、新失败不被隐藏、幂等与上限、挂载后点击关闭、源码约定 |
| 同上，临时去掉 `AssistantTurn` 的 `onDismiss` 接线 | 挂载用例失败（找不到关闭按钮），已恢复；证明用例能发现缺失 |
| `pnpm --filter @pi-desktop/desktop typecheck`（`app`） | exit 0 |
| `pnpm --filter @pi-desktop/i18n test`（`app`） | exit 0，3 个文件 25 项 |
| `node --test test/*.test.mjs`（`app/apps/desktop`，去掉 `SSH_ASKPASS`） | 3249 项：3216 通过、32 跳过、1 失败（`npm-executable.test.mjs` 的安装预算计时用例，`LOCAL-PROJECT.md` 已记录的并发超时）；该文件单独连跑 3 次均 12/12 通过 |
| 首轮全量（子模块未初始化） | 5 项因缺少 `upstream/*` 失败；初始化后这 5 个文件 22/22 通过 |
| `node scripts/check-architecture.mjs`、`pnpm lint`（`app`） | 均 exit 0 |
| `git diff --check` | 通过 |

## 未执行

- 未启动 Electron 实例目视确认按钮位置与深浅色主题；不使用用户正在运行的 OMP Desktop。
- 未跑 Electron E2E：改动只在渲染层，没有跨进程行为；US-UI-60c 新增步骤留待发版前的界面验收。
- 未打包、未发布；是否随 0.1.6 或同版本修订发布由用户决定，届时补更新记录（八种语言）。

## 遗留

- 关闭只在本次应用运行内有效：重启后持久化的错误会再次显示（本地拒绝行不持久化，不会回来）。
- 发送被拒时界面撤回用户消息并把错误行追加到当前消息列表末尾，因此可能出现在后面一轮的下方；
  本次让它可以关闭，没有改变它的位置。
- 同一调查中发现、尚未处理：OMP 自动重试事件未映射到“重试中”状态；思考等级与模型不匹配的提示不可操作、
  “继续”会原样重发；界面可能允许选到模型不支持的思考等级。
