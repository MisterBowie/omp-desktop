# 首次发送无回复与正文缺失排查（2026-10-22）

## 结论

首次发送失败已在 0.1.4 源码上复现并修复，本机验证完成，尚未提交、打包或发布。
单点已存在于原生记录，但不能据此断言是模型主动生成。用户追问后已确认并修复
OMP 向 DeepSeek 工具历史合成补点的差异，见[更正与补点证据](OMP-dot-replay-20261022.md)。

- 工作树：`.worktrees/fix-omp-first-response`。
- 分支：`codex/fix-omp-first-response`。
- 产品基线：`31ea13750aec289317d0d66089b1046edf69e8da`，包含已发布 0.1.4。
- 当前 `origin/main`：`a23bfb9befea327e7924efd3004e030a11b587d2`；修复分支包含它，
  另快进至最新已交付基线。原主检出及其他工作树不改动。
- 版本保持 0.1.4，schema 22、原生 18.3.0 / `62bc57b+omp-desktop.7` 不变。
- 环境：macOS arm64，NVM Node 24.14.0、pnpm 10.34.5。

## 已确认的事实与修改

`queue-slice.ts` 首次发送会并发调用 `renameSession` 和 `prompt`。冷会话改名会
启动 OMP，原 `rename` 的 finally 根据进入时的 `startedForOperation` 无条件
`disposeSession`，没有检查运行时已经被提问借用。提问停在目录发现期间时，
回收后的 `registerHostTools` 精确抛出截图中的
`NOT_STARTED: the OMP runtime is not available after start`；已进入运行的提问也会被终止。

修复集中在 `app/apps/desktop/electron/main/runtime/omp-session.ts`：

1. 改名清理前重查同一条目的 `isBusy()` 与注册表对象身份。准备中的提问也算忙；
   运行时交给它继续使用。独立空闲改名仍按原有规则回收，失败清理仍保留责任。
2. 提问捕获引用时，改名可能还未持久化原生引用；当前存活 runner 已绑定的原生
   身份应继续复用，不因为调用参数仍为空而再次 `new_session`。不可用运行时不走
   该捷径，清理债务的 `NOT_STARTED` 拒绝行为保持。

新增两条可控时序回归，覆盖 preparing / running；初始源码均失败，准备中路径
出现与截图完全相同的错误。身份断言也先实测失败（`new_session` 2 次），再修复到 1 次。
扩展验证曾暴露快捷路径改变了清理债务错误归属，已补上可用运行时检查后重跑通过。

只读检查本次原生会话，仅保存[聚合计数](OMP-first-response-20261022/diagnostic-counts.json)：
14 条助手记录中，4 条正文就是 `.`，9 条没有正文（思考/工具，其中末条 aborted），
1 条有完整问候正文。未复制用户正文、原生文件身份或私有项目路径。
不把思考伪造成正文，不过滤真实正文；原始供应商响应未留存，点的来源不能只凭
此计数确定。本段此前对模型来源的推断不成立，以后续补点排查为准。

## 验证

以下命令均在修复工作树 `app/` 执行，先加载 NVM 并 `nvm use 24`。
重复运行不叠加为新的独立用例。

| 命令/范围 | 结果 | 证据 |
| --- | --- | --- |
| `node --test --test-name-pattern='first prompt survives' apps/desktop/test/omp-session-bridge.test.mjs`（修复前） | exit 1，0 通过 / 2 失败；精确 NOT_STARTED 及错误回收 | [RED](OMP-first-response-20261022/red-lifecycle.txt) |
| 同两例补上身份断言、身份修复前 | exit 1，0/2；重复创建原生会话 | [身份 RED](OMP-first-response-20261022/red-identity.txt) |
| 桌面 10 个相关文件的 `node --test` | exit 0，142 通过 / 0 失败 / 0 跳过 | [原始结果](OMP-first-response-20261022/desktop-green.txt) |
| `pnpm --filter @pi-desktop/omp-runtime exec vitest run src/session/events.test.ts src/session/history.test.ts` | exit 0，50/0/0 | [投影回归](OMP-first-response-20261022/projection-green.txt) |
| `OMP_BUNDLED_RESOURCES='/Applications/OMP Desktop.app/Contents/Resources' node --test apps/desktop/test/omp-first-response-e2e.test.mjs apps/desktop/test/omp-session-operations-e2e.test.mjs` | exit 0，2/0/0 | [原生回归](OMP-first-response-20261022/native-green.txt) |
| `pnpm build:js` | exit 0 | [构建](OMP-first-response-20261022/build.txt) |
| `pnpm --filter @pi-desktop/desktop typecheck` | exit 0 | [类型](OMP-first-response-20261022/typecheck.txt) |
| `pnpm lint` | exit 0 | [lint](OMP-first-response-20261022/lint.txt) |
| `pnpm docs:check` | exit 0，80 对规格 / 522 页；已有 ADR 格式建议保留 | [文档](OMP-first-response-20261022/docs.txt) |

桌面 10 文件为：`omp-session-bridge`、`omp-session-failclosed`、`omp-history-read`、
`omp-session-configure`、`omp-session-configure-ipc`、`omp-session-ipc-result`、
`omp-session-ownership`、`session-transcript`、`transcript-settle`、`queued-turn-finalization`，
均在 `app/apps/desktop/test/`，后缀 `.test.mjs`。

新增原生用例经过生产 provenance 校验后只读使用已安装包的 OMP 二进制，启动的是
夹具独有进程；全部 HOME、项目、原生会话、模型配置位于临时目录，本机脚本模型
无密钥、无付费请求。验证：改名与首问并发、原生身份/标题保留、两次只读工具、
正文/点/最终答案在渲染结束事件及存活/冷读历史中逐字一致、退出完整回收。
既有原生流程另覆盖插话、Todo、Skill 跟进、压缩和取消。

首次沙箱内原生运行因本地监听 `EPERM` 未启动；授权后的隔离回归通过。
离线安装 813 个依赖；安装时提示构建前 CLI dist 缺失，随后源码构建通过。没有修改锁文件或全局 Node 默认值。

## 交接与边界

本轮仅本机源码交付。主要改动为会话桥、两条并发回归、新增原生用户流程回归，
以及对应中英运行时规格和 E2E 场景文档。没有更改权限、模型配置或历史数据格式。
没有运行用户应用实例、调用真实模型、改写用户历史或替换安装包。
未跑 Windows/Linux、安装态 GUI、全工作区测试或发布流水线，本轮不声称这些通过。

下一交付若需要在安装版使用：基于此工作树提交固定候选、构建并验证安装包；
当前已安装的 0.1.4 尚不包含本轮源码修复。
