# DeepSeek 工具历史补点修复（2026-10-22）

## 对此前结论的更正

用户指出 Pi 时没有单点。此前只看原生 JSONL，确认 4 条正文是 `.`，就把它归因于
模型，这个结论不充分：JSONL 是运行时处理之后的结果，不是原始供应商响应的证明。
本轮确认 Pi 与 OMP 的请求历史处理存在实质差异，并已本机修复。

仍在 `.worktrees/fix-omp-first-response` / `codex/fix-omp-first-response`，保留首次
回复修复及其证据。基线 `31ea1375`，版本 0.1.4、schema 22、原生 `.7` 不变；未提交、
打包或发布，用户安装和历史不改写。

## 来源与复现

- 固定 OMP `62bc57be` 的 `packages/catalog/src/compat/resolve.ts` 对 DeepSeek 直连
  思考模型设置 `requiresAssistantContentForToolCalls: true`。
- `packages/ai/src/providers/openai-completions.ts` 的 `convertMessages` 在工具调用
  没有正文时，把后续请求的 `assistantMsg.content` 填为 `.`。
- 产品携带的 Pi 0.86.1 序列化器对同一条“思考 + 工具调用、无正文”消息保持空正文；
  它另有仅思考且无工具时的填充逻辑，不应混淆两条路径。
- 仅查询本次提供方的公开端点分类，实际为 DeepSeek 官方 Completions 路径，
  确认会命中该兼容策略；未读取密钥、打印用户端点或复制用户正文。
- [DeepSeek 官方思考模式示例](https://api-docs.deepseek.com/guides/thinking_mode/)
  直接回传 `content`、`reasoning_content` 和 `tool_calls`，不要求把空正文替换为点。
  [接口说明](https://api-docs.deepseek.com/api/create-chat-completion/)亦将正文与思考分开。

新增原生回归使用已安装包经过 provenance 校验的 OMP 与本机脚本供应商。三次模型
响应为：纯思考 + 读取、真实点 + 第二次读取、正常答案。模型第一条响应完全没有
正文，原生事件同样无正文，但修复前第二次请求已含 `content: "."`；Pi 对照为空。
同一条原生消息经过真实 Pi 序列化器对照，不启动旧 Pi 进程。

这证明 OMP 会自行向模型上下文写入点，可能诱发后续模仿；没有本次真实请求的原始
SSE，不能逐个断言旧截图中的点都是它诱发的，也不能声称被丢弃的完整句子可恢复。

## 修改与边界

`app/apps/desktop/electron/main/runtime/omp-model-projection.ts` 沿用已有 DeepSeek
端点识别，在 Completions 模型配置显式投影：

```yaml
compat:
  requiresAssistantContentForToolCalls: false
```

固定 OMP 本身支持这个显式覆盖，无需改上游子模块或 fork。修复后真实请求保持
空正文，思考、工具调用 ID/参数与工具结果保持；真正收到的 `.` 原样保留。
没有通过隐藏 UI 文本或改写原生历史掩盖问题。Kimi、中转端点与 Responses 维持
原生配置。旧会话已保存的点仍是原始数据，本轮不自动清洗。

## 验证

macOS arm64，NVM Node 24.14.0、pnpm 10.34.5；所有模型请求都到本机脚本服务。
命令从工作树 `app/` 执行；重复运行不叠加计数。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| `OMP_BUNDLED_RESOURCES='/Applications/OMP Desktop.app/Contents/Resources' node --test apps/desktop/test/omp-deepseek-replay-e2e.test.mjs`，修复前 | exit 1，`'.' !== ''`；Pi 对照已通过 | [RED](OMP-dot-replay-20261022/native-red.txt) |
| 原生补点 + 首次发送 + 会话操作三个 E2E 文件 | exit 0，3 通过 / 0 失败 / 0 跳过 | [原生 GREEN](OMP-dot-replay-20261022/native-green.txt) |
| 前轮 10 个桌面文件 + `omp-model-projection.test.mjs` | exit 0，159/0/0 | [桌面 GREEN](OMP-dot-replay-20261022/desktop-green.txt) |
| `pnpm build:js` | exit 0 | [构建](OMP-dot-replay-20261022/build.txt) |
| `pnpm --filter @pi-desktop/desktop typecheck` | exit 0 | [类型](OMP-dot-replay-20261022/typecheck.txt) |
| `pnpm lint` | exit 0 | [lint](OMP-dot-replay-20261022/lint.txt) |
| `pnpm docs:check` | exit 0，80 对规格 / 522 页；既有格式建议保留 | [文档](OMP-dot-replay-20261022/docs.txt) |

原生绿色命令为 `OMP_BUNDLED_RESOURCES=... node --test` 后接
`apps/desktop/test/omp-deepseek-replay-e2e.test.mjs`、`omp-first-response-e2e.test.mjs`、
`omp-session-operations-e2e.test.mjs`（后两者同目录）。原生用例断言空正文不补点、
真实点不丢失、思考逐字回传、工具只读和退出完整回收；其他两项继续保护首次发送、
插话、跟进、Todo、Skill、压缩和取消。桌面新增对照确保覆盖不泄漏到其他 API/端点。

首次新夹具缺少 Pi 必填输入模态，先修正夹具再取得上述真实 RED。参考子模块远程
初始化遇 HTTP/2 early EOF，终止后用本机已有同 SHA 检出完成；两子模块固定 SHA
保持，源码目录均无 CodeGraph 索引，没有创建索引。

未调用真实 DeepSeek，未跑 Windows/Linux、安装态 GUI 或发布流水线。下一交付为
提交固定候选和构建验收安装包；当前安装仍未包含这两项源码修复。
