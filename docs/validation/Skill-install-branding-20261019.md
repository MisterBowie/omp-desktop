# Skill 安装提示名称修正（2026-10-19）

## 范围与来源

用户要求 Skill 安装相关提醒使用 omp-desktop。基线为已发布 0.1.2 的后续交接提交
`a173f5b7065c17bc6bbc9e8a189cfb37d2f5363f`；从最新 origin/main 创建专用
`codex/skill-install-branding` 工作树，再快进继承该基线。没有 CodeGraph 索引。

定位发现界面已使用 OMP 品牌，但 `mode-prompts.ts` 的默认/Plan/Goal 仍自称
PI-Desktop，运行时插件工具说明和内置插件开发 Skill 也保留旧名称。原生 OMP 使用
`composeModeSystemPrompt(mode, "")`，仅修改默认基础提示无法覆盖 Agent 模式。

## 修正

- 桌面自有身份文案读取共享 `APP_NAME`；模式拼装统一附带
  `OMP Desktop (omp-desktop)` 宿主上下文，要求安装说明和状态回复使用当前应用名。
- 覆盖默认、自定义及空基础提示；自定义角色继续替换默认角色设定。
- 项目指令前言、子代理身份与错误提醒、插件辅助工具及其延迟目录说明改为 OMP。
- 内置插件开发 Skill 标题、适用说明和正文使用 OMP Desktop。
- 原有自定义角色测试同步新产品名，继续验证角色替换与附加指令优先级。
- 中英运行时规格及 E2E 文档同步。保留旧兼容包名、Skill id、权限、安装路径，
  不重写外部 Skill 正文、用户指令或历史会话。

## 最终验证

Node 24.14.0 / pnpm 10.34.5。下列命令均退出 0，日志保存在忽略的
`app/.artifacts/skill-branding-20261019/`，不提交原始输出。

| 验证 | 结果 |
| --- | --- |
| 冻结依赖安装，禁用安装脚本 | 通过；复用现有缓存，不修改锁文件 |
| `pnpm build:js` | 全工作区 JS 构建通过 |
| `pnpm exec vitest run` 七个指定源码文件 | 275 通过；含模式、自定义提示、Skill、子代理、项目指令及 runtime |
| `node --test` 四个桌面相关文件 | 40 通过、0 失败、0 跳过 |
| `pnpm --filter @pi-desktop/desktop typecheck` | 通过 |
| `pnpm lint` | 通过 |
| `pnpm docs:check` | 79 对中英规格、517 页通过 |
| 编译后提示探针 | 9 种模式/基础提示组合、4 种工具说明、子代理与内置 Skill 均为 OMP；用户正文和兼容 Skill id 保留；0 网络请求 |
| `git diff --check` | 通过 |

Vitest 文件：`mode-prompts`、`custom-system-prompt`、`plugin-skills-prompt`、
`plugin-skills`、`subagent`、`project-instructions`、`runtime`，均为源码 `.test.ts`，
不混入编译产物重复计数。桌面文件：`plugin-skills.test.mjs`、
`omp-skill-path-adapter.test.mjs`、`omp-mode-entry-unit.test.mjs`、
`custom-system-prompt-launch.test.mjs`。

早期离线安装因当前缓存缺包失败，显式复用原有 store 并按冻结锁文件补齐后通过。
额外探针先后因缺少必填 shell、子代理字段名错误、无效资源断言失败；按真实接口
修正夹具后最终通过，早期失败不计通过。产品回归、类型、lint 与文档检查首轮通过。

## 交付边界

仅源码本机交付，工作树为 `.worktrees/skill-install-branding`，未提交/推送或发布；
APP_VERSION 仍为 0.1.2，已发布 v0.1.2 的标签和安装包没有修改。OMP 固定运行时
及存储 schema 保持。没有调用真实/付费模型、实际安装 Skill 或改写用户安装态数据。
未运行原生四平台安装验收或真实模型回复措辞验收；安装态生效需要后续构建发布。
测试基线、命令结果、编译探针和变更文件摘要见同名 JSON。
