# 供应商思考与附件能力识别（2026-10-21）

## 结论与范围

源码已完成并验证，尚未打包安装。继续使用
`/Users/vv/person/omp-desktop/.worktrees/provider-context-window` /
`codex/provider-context-window`，基线仍为已发布 0.1.1 的
`8233c81398c170808c99aedc7bb525b47eeac467`，包含上一轮未提交的上下文修复。
运行时固定坐标和版本 0.1.1 均未改。当前文件摘要见
[源码清单](Provider-model-capabilities-20261021/source-manifest.json)。

用户截图中的思考强度/附件选项确有缺陷：发现层原本只接收模型 ID、名称和前轮
补齐的限制，仍丢弃了思考与输入能力。设置显示、保存及原生配置投影都有遗漏。
本轮用户另明确选择“保持手动勾选，保留已有选择”，因此自动调度继续由用户控制。

实际 GET `http://127.0.0.1:3425/v1/models`：**43** 个模型发布思考能力，**41** 个
发布图片输入，**0** 个声明 PDF 支持，**0** 个发布原生联网搜索支持字段。
Claude Opus/Sonnet 5.5 发布 `low/medium/high/xhigh/max`，输入为 text/image。
这只说明当前接口的发布情况，不能据此推断未发布的 PDF/搜索一定可用。
仅保存白名单规范化字段，见[接口记录](Provider-model-capabilities-20261021/endpoint-metadata.json)。
未发送模型推理、未记录认证值或修改真实用户配置。

## 实现与兼容语义

- 发现解析 `reasoning`、`reasoning_levels`、`supported_reasoning_levels[].effort`、
  `modalities`/input/output modalities、`supports_images`、`supports_pdf` 和明确的
  原生搜索支持布尔值。显式 false 保留；缺失字段不凭模型名补真。
- `none` 映射到 `off` 并保留线值。未知 `ultra` 等保存在不可执行元数据中，设置页
  用八语言提示当前运行时不支持；不映射成 max，不发给运行时当有效档位。
- `providerCapabilities` 快照跨 ModelInfo、绑定保存、配置导入、缓存与运行时。
  `thinkingLevelsSource` 区分 provider/user：继承值随刷新更新，手动编辑（包括清空）
  标记 user。旧版无来源的空集合按通用默认处理，非空旧选择保留。旧版没有来源
  记录时无法追溯空集合的编辑意图，这是一条明确的兼容规则。
- 附件 null 跟随端点/目录事实，显式 true/false 优先。已保存快照也用于缓存尚未
  加载时的图片/PDF 判断。发布事实独立于用户覆盖，避免覆盖值成为自己的发布证据。
- AI 自动调度不来自供应商字段，已有选择保留；原生联网支持的声明只作能力提示，
  不自动启用搜索。手动开关和现有 wire-style 限制继续生效。
- Rust 将结构化能力写入已有 KV `provider-model-capabilities`（provider→model），
  与模型缓存同一事务；输出写现有 `max_output_tokens` 列。删除提供商时与行删除
  同一事务清理该 KV，用户自建模型缓存行不被远端覆盖。不新增数据库列或版本。
- Node 先应用快照再应用用户覆盖。OMP YAML 补传 reasoning、text/image、最大输出；
  明确发布 OpenAI 兼容 effort 控制时传递档位/映射，其它 API 保留 OMP 原生
  budget/adaptive/Google 控制模式。不改上游参考源码或 OMP fork。

主要代码：desktop 的 discovery、provider IPC、设置选择器、OMP projection/wiring；
shared 的类型/发布能力解析/绑定与导入；agent-runtime 模型配置；Rust provider
模型、规范化、缓存及删除。更新中英规格/E2E、ADR 和八语言提示。

## 验证

工具链沿用 Node v24.14.0（NVM）、pnpm 10.34.5、rustc
1.99.0-nightly (3d6c19bb9 2026-08-11)、cargo 1.99.0-nightly
(b07e5a086 2026-08-07)。未改用户全局默认。

| 验证 | 退出 | 实际结果 |
| --- | --- | --- |
| 增加能力发现回归，修复前 `node --test .../model-discovery.test.mjs` | 1 | 14 项中 12 通过、2 失败，缺少能力字段 |
| desktop 下列 11 个测试文件 | 0 | 101 通过、0 失败/跳过 |
| `pnpm --filter @pi-desktop/shared exec vitest run src` | 0 | 45 文件、504 源码用例通过，不重复计算 dist |
| agent-runtime 的 model-capabilities/provider-binding/context-budget | 0 | 3 文件、47 通过 |
| `pnpm --filter @pi-desktop/i18n test` | 0 | 3 文件、25 通过 |
| `cargo test -p host-core --locked --offline providers::` | 0 | 53 通过、592 过滤；含真实 SQLite 重开、覆盖保留和删除清理 |
| `pnpm build:js` + desktop typecheck | 0 | workspace/桌面构建及 Main/renderer 类型通过；既有大 chunk 提示保留 |
| `pnpm lint` | 0 | 配置内 91 文件及样式 token 通过 |
| `pnpm docs:check` | 0 | 79 对规格、518 页文档通过，既有 5 条非失败注记保留 |
| `cargo fmt --all -- --check` / clippy all-targets locked offline | 0 | 仅 user_skills.rs:921 既有 useless_format 警告，该文件未改 |
| 生产发现函数对用户接口的 GET | 0 | 43/41/0/0，Claude 思考五档与接口一致 |
| 隔离原生 catalog/state RPC 诊断 | 0 | 图片、872000 窗口、128000 输出及五档回读正确；low 设置/回读成功；零推理；stopped/reaped/cleaned |
| `git diff --check` | 0 | 无空白错误 |

Desktop 文件位于 `apps/desktop/test/`：model-discovery、provider-discovery-limits、
model-discovery-precedence、model-binding-catalog-source、model-cache、
provider-model-config、provider-catalog-runtime、model-advanced-capabilities、
context-usage、omp-model-projection、omp-session-wiring，均为 `.test.mjs`。
代表路径使用真实发现、IPC 装饰、React 设置 hook、shared/runtime helper 和 YAML
输出；只在网络及宿主 RPC 边界使用夹具，宿主持久化另由真实临时 SQLite 覆盖。

原生诊断命令：`node scripts/verify-provider-capabilities.mjs <显式 OMP 二进制>`。
本机传入 `/Applications/OMP Desktop.app/Contents/Resources/omp-runtime/omp`，只读取
安装中的二进制及 provenance，并在全新临时 HOME/配置中运行，不启动或接管桌面 UI。
实际 OMP 18.3.0，补丁 **62bc57b+omp-desktop.7**，SHA256
`c64e04c04cf7a357d97062a9a5aff0fa602b715b5ac22b0ae0cadb7daab10e03`。
此为当前安装运行时的兼容诊断，**不冒称本源码固定 .6 的完整打包验收**。
详细输出见[原生记录](Provider-model-capabilities-20261021/native-probe.txt)。

参考源码核对：工作树子模块初始化先因浅 reference、后因 GitHub 网络失败；改为
读取主检出中已初始化、同一 `62bc57be...` 的 OMP。根与该参考仓库没有 CodeGraph
索引。确认 native EffortSchema 只支持 minimal/low/medium/high/xhigh/max，模型
配置支持 reasoning/input/maxTokens/thinking。没有自行索引、升级或修改参考源码。

## 交接与边界

本轮未提交、推送、创建 PR、合并、打包、发布或更新当前安装。未跑安装态 GUI、
Windows/Linux 或真实付费模型；这些不记通过。旧日志与本轮 RED 均保留。

如需交付安装包，先将本修复整合到将交付的版本，保留其它工作树及已安装 .7
对应功能，再运行固定候选打包验收。使用新构建后，模型设置获取列表并保存，即可
修复旧继承值；已经运行的旧会话和用户显式覆盖不会被后台发现流程直接改写。
本轮不自动进入其它项目阶段。
