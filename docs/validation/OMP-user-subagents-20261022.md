# OMP 用户子智能体接入修复（2026-10-22）

状态：**本地源码与原生 mock 验证完成，未提交、打包、发布或替换用户安装。**
范围仅为用户第二个问题：设置中存在 `code-implement`，OMP 会话却无法发现。
截图 1 的后台任务停止问题不在本次修改范围。

## 基线与环境

- 独立工作树：`.worktrees/fix-omp-user-subagents`，分支 `codex/fix-omp-user-subagents`。
- 已 fetch `origin/main`；远端 main 仍为初始化 `a23bfb9b`。工作树从该分支创建后，
  快进到已交付的最新本地 `a8ee2f83`，保留 0.1.4 与两项聊天修复；main 为当前
  HEAD 的祖先。未复用其他工作树的未提交改动。
- Node v24.14.0（加载现有 NVM 并 `nvm use 24`），pnpm 10.34.5；不改全局默认。
- 离线安装复用现有 `.pnpm-store`，安装 exit 0；原始根及参考源码均无 CodeGraph
  索引，未创建索引。参考源码使用根目录已初始化的固定 OMP 子模块。
- 原生验收为 macOS arm64，验证 `/Applications/OMP Desktop.app/Contents/Resources`
  中的内置 OMP 后，以**独立临时 HOME/配置/会话目录**运行二进制和当前源码 gate。
  OMP 18.3.0、fork `edec3898d44071206ec201beebea432a2786bd8c`、补丁
  `62bc57b+omp-desktop.7`；产品仍为 0.1.4、schema 22。未启动用户的 Electron 实例。

## 实现事实与修复

1. `agents.active` 已按绑定项目返回桌面全局用户定义，但 OMP 接线只投影父模型，
   没有向原生 `task` 投影用户目录。复用共享定义解析器、供应商 ID/厂商/名称匹配，
   不恢复 Pi 执行器或另建任务调度。
2. **实测校正发现目录**：OMP `task/discovery.ts` 经 `config.ts` 读取合成
   `HOME/PI_CONFIG_DIR/agent/agents`，独立于存放模型的 `PI_CODING_AGENT_DIR`。
   最初写到后者时原生回归仍失败；改成真实发现目录后可见。
3. 原生 Markdown 保留名称、说明、提示词和映射后的工具授权。主模型/显式备用模型
   使用逐定义供应商别名，按配置端点取必需凭证；输出上限只缩小模型限制。
   密钥只写运行期 `models.yml`，定义文档/日志无密钥原文，原用户文档不改写。
4. 每次显式消息重读启用范围、定义及相关公开模型信息；无关供应商变化不重建。
   有变化时只替换空闲运行时；使用原始 `get_subagents` 快照保护尚未归因的后台子任务。
   加载中 Stop 阻止派发，回收失败保留所有权并拒绝下一条消息。
5. **原生回归发现的依赖缺陷**：配置刷新重建后，若本条消息的宿主引用仍为空，旧实现
   会 `new_session`。现回用 entry 已验证的原生 ID/路径并 `switch_session`，保持历史，
   事件代号继续沿既有替换流程递增；未重放消息。
6. 最近的项目 `.omp/agents` 同名定义会按 OMP 原有优先级覆盖用户目录；现以
   `OMP_SUBAGENT_CONFLICT` 拒绝派发，避免默用其他模型/提示词/授权。

主要源码：`omp-user-subagents.ts`、`omp-session-wiring.ts`、`omp-model-projection.ts`、
`omp-session.ts`；新增投影/原生回归，扩展桥接生命周期回归；同步中英文运行时规格、
E2E 计划、ADR 0303、用户说明、八语言更新记录及条目数量断言。

## 红绿与实际验收

原始接线在修正后的同一 native 夹具上：**1 failed / 0 passed**，
`code-implement` 的调用返回 Unknown agent，指定子模型无请求。
只临时切换本任务自己的接线文件并自动恢复。更早的 localhost EPERM、宿主夹具缺少
执行目录/记忆设置 RPC 属于环境/夹具准备失败，不作为产品 RED。

工作目录均为本任务 `app/`，以下最终结果全部 exit 0：

| 命令/范围 | 结果 |
| --- | --- |
| `node --test apps/desktop/test/omp-user-subagents.test.mjs apps/desktop/test/omp-model-projection.test.mjs apps/desktop/test/omp-session-bridge.test.mjs apps/desktop/test/omp-session-configure.test.mjs apps/desktop/test/omp-session-configure-ipc.test.mjs apps/desktop/test/omp-session-ownership.test.mjs apps/desktop/test/omp-session-failclosed.test.mjs apps/desktop/test/omp-session-delete-archive.test.mjs` | **129 passed / 0 failed / 0 skipped** |
| `OMP_BUNDLED_RESOURCES=<上述 Resources> node --test apps/desktop/test/omp-first-response-e2e.test.mjs apps/desktop/test/omp-user-subagents-e2e.test.mjs` | **2 passed / 0 failed / 0 skipped** |
| `pnpm build:js` | 所有 JS 构建完成；保留既有大 chunk 提示 |
| `pnpm --filter @pi-desktop/desktop typecheck` | 通过 |
| `pnpm lint` | Biome 与 style tokens 通过 |
| `pnpm docs:check` | 双语检查与 522 文档检查通过；既有 5 条 ADR 格式提示保留 |
| `pnpm --filter @pi-desktop/shared build` | 更新记录及其测试编译通过 |
| `pnpm --filter @pi-desktop/shared exec vitest run src/changelog.test.ts` | **5 passed / 0 failed** |
| `git diff --check` | 通过 |

原生用户路径实际验证：设置来源的启用定义 → 原生 `task` → 独立本地子供应商 →
模型 ID 与自定义提示词正确 → 未声明 Bash 实际无副作用 → 已授权 Write 完成 →
显式 `inherit` 后 Bash 出现在子模型工具表、嵌套 task 仍不可用 → 编辑/禁用各自
触发空闲进程替换 → 同一原生会话身份、旧运行期目录已回收 → 禁用定义不再展示。
所有 provider 均为 127.0.0.1 mock，无真实模型调用或费用。

新增五项桥接回归覆盖：空引用恢复、加载时停止、运行中不回收、回收失败、父回合
空闲但仍有未归因后台子任务时拒绝重建。投影回归另覆盖只读默认、范围参数、模型
别名/备用链/限额、缺失及禁用供应商、空密钥、损坏定义、项目同名冲突与原文件保持。

测试准备中曾误用 Node runner 跑 Vitest 文件而失败；改用包内 Vitest 后，新增第九条
更新记录触发现有数量断言失败。将所有语言仍一致的预期数量由 8 更新为 9 后，5/5
通过；未降低检查条件。Node runner 失败输出与产品 RED 输出保留；数量断言失败
的结果与修正原因在本节记录。

## 交付边界与下一任务

- 配置接入仅针对设置中的**全局用户定义**；既有 OMP 原生内置/项目来源仍由 OMP
  管理，未将旧 Pi 内置目录伪装成 OMP 原生目录。
- 实际子工具仍以 OMP 可用性为准：本次不实现 Pi 专属 BrowserPreview 或另建子级
  宿主工具传输。子调用保持父会话权限；非继承权限覆盖带诊断排除，逐定义 Pi
  watchdog 不冒称支持，沿用原生期限。
- 未运行付费模型、安装态 GUI 或 Windows/Linux 原生打包；不将这些列为通过。
- 未改上游源码、运行时固定坐标、版本、数据库结构、真实配置、凭证或历史。
- 下一任务：按用户选择构建/交付包含此次修复的本地安装包；在用户当前已安装的
  0.1.4 上，仅重启不会获得源码修复。提交/推送/发布另按授权处理。

本次原始输出与改动文件摘要在同名子目录；记录测试过的未提交源码，不冒称 PR
集成候选。`source-baseline.json` 的历史未覆盖。
