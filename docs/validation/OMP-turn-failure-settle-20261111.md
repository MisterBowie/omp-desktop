# 模式切换失败后下一条消息被吞掉修复（R26）验证记录

日期：2026-11-11

## 来由

0.1.8 两次远端候选都没有通过，失败的是同一个测试：`omp-plan-submit-e2e.test.mjs` 中的 T20-D 用例“an unreadable committed
Enter reply stops the turn and recovers in Goal”，第 1869 行断言 `the Goal catalogue must return`。

- r1（run 42972600246，`c21c8467`）：只有 macOS Intel 的打包后验收失败（15 项中第 12 项），其余平台与源码门通过。
- r2（run 42977607568，同一提交）：四个平台构建全部通过，源码门 verify 失败在同一断言。

诊断标签 `diagnose-release-<run>` 由仓库工作流读取失败日志和验证制品，只输出白名单内的事实（[r1 摘要](OMP-turn-failure-settle-20261111/native-failure-42972600246.json)）。
用户 2026-11-11 选择“先修好再发”。

## 定位

- 打包运行时在本机很快（单次约 10 秒）。0.1.7 与候选交替各跑 12 次，0 次失败。
- 源码运行时较慢（单次约 35 秒），可以复现：候选 7 次中 2 次失败，0.1.7 基线第 3 次即失败（[逐次结果](OMP-turn-failure-settle-20261111/repeat-runs.txt)）。
  所以这不是 R16、R24、R25 引入的回归，0.1.7 及更早版本已有。
- 临时插桩副本（未入库）在断言前输出现场（[两次失败的现场](OMP-turn-failure-settle-20261111/probe-failures.json)）：
  - 整个用例中服务商只收到 1 个请求，即第一轮的请求。恢复的那一轮没有调用模型，却被记为 `completed`，数据库行也是 `completed`。
  - 断言看到的“智能体工具列表”来自第一轮。因此不是 Goal 模式拿到了 Agent 工具，不涉及权限。
  - 第一轮失败后的事件依次为 `turn_start, message_start, message_end, turn_end, agent_end`，没有新的 `agent_start`。
- 机制：
  1. 结构化的回合失败（模式切换结果读不出来）让桌面立即关闭这一轮，runner 回到空闲。
  2. 运行时仍在收尾被中止的循环，之后才发出这一轮自己的 `agent_end`。
  3. 如果下一条消息在这之前发出，它会落进正在结束的循环：运行时不调用模型就把它消化掉，迟到的 `agent_end` 又把新一轮记为完成。
  4. 第二种表现：新消息准备过程中被迟到的结束打断，报 “the run was stopped while the prompt was being prepared”（候选第 2 次失败）。
- 用户可见影响：进入 Plan/Goal 模式失败后，如果马上再发消息，这条消息可能得不到回复却显示完成。正常使用很少碰到，但门禁每个候选要在 5 个环境跑这个用例。

## 修复

分支 `codex/omp-turn-failure-late-frames`（`.worktrees/omp-turn-failure-late-frames`），基于 `main`（`3ac9ef66`），代码提交 `f0843924`。

- `packages/omp-runtime/src/session/runner.ts`：
  - 回合失败关闭这一轮后，记下运行时仍欠这一轮的 `agent_end`；如果转向（steering）已经扣住了终止帧，就不再等待。
  - 空闲时收到终止的 `agent_end`，等待结束（这一帧照旧计为迟到帧并丢弃）。
  - `prompt()` 在启动新一轮之前等待这个终止帧。超时（默认 5 秒）则再发一次 `abort` 并再等一次；仍不结束就以 `not-started` 拒绝这条消息，不让它被吞掉。拒绝只发生一次，重发不会再被拦。
  - 没有待结束的失败回合时，`prompt()` 的检查仍然是同步的，行为不变。`dispose` 会释放等待中的消息。
- 规格 `docs/spec/03-runtime/02-agent-runtime.md` 新增 “OMP failed-turn settlement”。
- 无 IPC、持久化或权限语义变化；没有改动 OMP 补丁。

## 验证

环境：macOS arm64，Node v24.14.0，pnpm 10.34.5，Bun 1.4.2；OMP 18.3.0 补丁树（子模块 `62bc57be` + `62bc57b+omp-desktop.7`）；host-core 为 `main` 的调试构建。
全部使用本机假服务商，没有真实模型调用。

| 命令 | 结果 |
| --- | --- |
| `vitest run src/session/runner.test.ts -t "turn failure settlement"`，修复前 | 3 项失败（下一条消息立即发出：期望 1 个用户请求，实际 2 个；不收尾时没有拒绝；`dispose` 不释放），1 项（终止帧已到时立即发送）本来就通过 |
| 同上，修复后 | 4/4 通过；`runner.test.ts` 全部 58/58 |
| T20-D 用例，源码运行时，逐次运行（临时插桩副本） | 修复前：候选 7 次 2 次失败、0.1.7 基线 3 次 1 次失败；修复后 **20/20 通过** |
| omp-runtime 全量 `vitest run` | 603 通过、6 跳过 |
| desktop 全量 `node --test test/*.test.mjs` | 3304 项：3281 通过、0 失败、23 跳过（需要打包资源的原生用例） |
| `pnpm build:js`、omp-runtime 与 desktop typecheck、`pnpm lint` | 均 exit 0 |

## 过程中的环境事故（已恢复）

修复后第一次跑全量检查时，那一组命令没有在 `app/` 下执行，而是在工作树根目录用 pnpm v11.1.2 运行。pnpm 向上找到了用户主目录的 `package.json`，
在 `~` 执行了一次安装：新建 `pnpm-lock.yaml`，把原有的 npm 安装（`claude-code` 1.0.0、`@magpie-community/opencode-factory-auth`
0.1.31）移进 `node_modules/.ignored`，换成 pnpm 的链接与 `.bin` 脚本。

- 已恢复为原来的 npm 布局：两个原包移回原位，`.bin/claude-code` 恢复为指向 `../claude-code/index.js` 的链接，和 `.package-lock.json`
  的记录一致；`pnpm-lock.yaml` 和 pnpm 生成的文件移到 `/tmp/home-node-modules-pnpm-backup-20261111`，没有直接删除。
- 仓库与各工作树没有被改动。之后的检查都通过脚本运行：先断言当前目录和 pnpm 版本（10.34.5），每次 pnpm 调用都显式指定 `--dir`。
- pnpm v11.1.2 的来源没有查明：PATH 上只有 10.34.5，corepack 缓存里只有 11.2.2。
