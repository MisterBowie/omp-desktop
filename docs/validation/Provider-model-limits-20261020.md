# 供应商模型 Token 限制识别修复（2026-10-20）

## 结论与源码坐标

本机源码修复完成，尚未打包或安装。分支 `codex/provider-context-window`，工作树
`/Users/vv/person/omp-desktop/.worktrees/provider-context-window`，基线
`8233c81398c170808c99aedc7bb525b47eeac467`（已发布 0.1.1）。
`origin/main` 仍为初始规划提交 a23bfb9，因此从已发布分支建立独立工作树，避免退回
旧产品代码；该基线包含 origin/main。原工作树及其他任务未改。根和 app 没有
`.codegraph/`，未自行索引；本轮未读取参考子模块代码，也未改 gitlink。

用户接口 `http://127.0.0.1:3425/v1/models` 实际返回 43 个模型，其中 13 个 ID
包含 Claude。Opus/Sonnet 5.5 及对应自动路由组的窗口为 **872000**，输出上限
**128000**；Sonnet 4.6 为 **931000 / 64000**；部分型号为 867000，Haiku 4.5
为 200000。接口没有统一声明 1000000。结果见
[脱敏字段记录](Provider-model-limits-20261020/live-model-limits.json)。
首次使用 urllib 只读确认，修复后再通过实际 `discoverProviderModels` GET 复核。
未请求 messages、responses 或 chat/completions；未调用付费推理。认证值未写入
源码、测试、日志或证据；记录只保留模型 ID、上下文和输出限制。

## 根因与改动

1. `model-discovery.ts` 只返回 ID/名称，丢弃接口的上下文/输出限制；IPC 装饰阶段
   只取 models.dev 或 generic。网关 ID 无目录匹配时，就落入通用 128000。
2. 发现现在校验并保留 `context_window`、`context_length`、`max_input_tokens`，
   依次优先；输出取 `max_output_tokens`，Google 对应 input/outputTokenLimit。
   必须是正整数且不超宿主 u32 范围。输出绝不回填上下文，不凭模型名猜 1M。
3. IPC 将端点限制作为目录的 Token 基线；缓存保存原始发现结果，避免把 generic
   默认值或手动覆盖值写成端点发布值。现有缓存结构保存上下文，已选绑定保存
   上下文及输出；未选模型的离线输出值仍依赖目录或默认值。
4. 现有绑定 JSON 的可选 `contextWindowSource` 新增 `provider`，shared resolver、
   宿主规范化和配置导入均保留它，避免已保存的端点窗口被 generic/models.dev
   覆盖。没有新增数据库列、schema 或协议版本；旧配置仍可读。
5. 实际设置 hook 让继承窗口显示并随保存采用新端点值；`user`（包括恰好 128000）
   及旧版非默认显式值保留。发现本身不持久修改用户绑定；已有配置需获取列表后保存。
   手动输出/思考/附件选项保持既有语义。

实现位置：desktop 的 `model-discovery.ts`、`ipc/provider-ipc.ts`、
`ModelSelectionPanes.tsx`；shared 的模型类型、catalog helper 和导入解析；
host-core 的 provider 来源规范化。新增跨发现/IPC/真实 React hook/缓存/运行时的
行为回归，更新既有源码契约定位、中英规格与 E2E 场景，新增范围明确的 ADR。
精确文件及摘要见 [源码清单](Provider-model-limits-20261020/source-manifest.json)。

## 验证

工具链：Node **v24.14.0**（现有 NVM，未改全局默认），pnpm **10.34.5**，
rustc **1.99.0-nightly (3d6c19bb9 2026-08-11)**，cargo
**1.99.0-nightly (b07e5a086 2026-08-07)**。下列命令均在工作树的 `app/` 运行，
基线重现除外。退出码为实际测试/检查退出码，不以采集用 tail 的状态代替。

| 命令/检查 | 退出 | 结果 |
| --- | --- | --- |
| 将 HEAD 的旧 `model-discovery.ts` 与当前发现回归复制至临时目录，`node --test` | 1（预期） | 12 项中 6 通过、6 失败，确认旧代码丢字段 |
| `node --test` 下列 9 个 desktop 文件 | 0 | 80 通过、0 失败、0 跳过 |
| `pnpm --filter @pi-desktop/shared exec vitest run src` | 0 | 45 文件、500 个源码用例通过，不把 dist 副本重复计数 |
| `pnpm --filter @pi-desktop/agent-runtime exec vitest run src/model-capabilities.test.ts src/provider-binding.test.ts src/context-budget.test.ts` | 0 | 3 文件、46 通过 |
| `cargo test -p host-core --locked --offline providers::` | 0 | 52 通过、592 过滤，含新来源 JSON 往返与缓存保护 |
| `pnpm build:js` | 0 | workspace JS/桌面构建通过，有既有大 chunk 提示 |
| `pnpm --filter @pi-desktop/desktop typecheck` | 0 | Main/renderer 类型通过 |
| `pnpm lint` | 0 | 配置内 91 文件与样式 token 检查通过 |
| `pnpm docs:check` | 0 | 79 对中英规格、518 页文档通过，5 条既有非失败注记 |
| `cargo fmt --all -- --check` | 0 | 新断言格式初检不通过，格式化后通过 |
| `cargo clippy -p host-core --all-targets --locked --offline` | 0 | 仅 `user_skills.rs:921` 既有 useless_format 警告，该文件未改 |
| 实际 `discoverProviderModels` 对用户接口的 GET | 0 | 43 模型，13 Claude 的窗口/输出与接口字段一致 |
| `git diff --check` | 0 | 无空白错误 |

Desktop 文件：`model-discovery`、`provider-discovery-limits`、
`model-discovery-precedence`、`model-binding-catalog-source`、`model-cache`、
`provider-model-config`、`provider-catalog-runtime`、`model-advanced-capabilities`、
`context-usage`，均为 `apps/desktop/test/<名称>.test.mjs`。

代表性路径覆盖：真正的 providersListModels IPC → 真实发现/目录/绑定 helper →
真实 React `useModelSelection` 显示及待保存值 → JSON 往返 → 无网络 cache hydrate →
运行时模型解析。网络与宿主 RPC 是夹具边界；宿主真实配置序列化另由 Rust 覆盖。
目录已知/未知、旧 128k、手动 128k、窗口再次改变和缓存缺失均覆盖。

过程失败保留：离线依赖准备缺少固定 pnpm 包，随后按锁文件安装成功且禁用安装脚本；
首轮扩展桌面回归为 79 通过/1 失败，因为源码契约仍定位旧的装饰后缓存语句，已改为
定位原始发现缓存，并保留原有配置模型并集断言，最终 80/80。
原始输出在 [证据目录](Provider-model-limits-20261020/)。

## 范围与下一步

版本仍为 **0.1.1**。未提交、推送、创建 PR、打包、发布、修改用户安装或真实数据库。
未执行安装态 GUI/真实进程重启、Windows/Linux 或真实付费模型烟测，不把这些记为通过。
已有旧缓存可能在重新获取列表前显示旧值。下次交付应构建/安装当前修复，再获取模型
列表并保存，以便已选继承绑定实际采用端点限制；本轮未自动启动其他项目阶段。
