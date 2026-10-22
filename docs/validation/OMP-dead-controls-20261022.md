# OMP 无效设置接通：图片附件、全局指令与 OAuth 入口（R09–R11，2026-10-22）

状态：**源码、原生 mock 与真实 Electron 界面验证完成，提交在 `codex/omp-dead-controls`；未打包、发布或替换
用户安装。** 范围是 2026-10-22 用户决定 5：“对 OMP 无效的设置能接通的就接通”。验证在 2026-10-23 凌晨完成。

## 基线与环境

- 工作树 `.worktrees/omp-dead-controls`，分支 `codex/omp-dead-controls`，基于修订线 `codex/chatfix-revision`。
  改动最初写在 `37fff5c4` 上，提交前快进到 `852ca1b9`（r3 远端失败的夹具补修，见
  [R07 证据](Chatfix-source-gate-races-20261022.md)）。
- macOS arm64；Node v24.14.0、pnpm 10.34.5、Bun 1.4.2。非交互 shell 中 `nvm use 24` 报 `24 -> N/A`，改为把
  NVM 的 v24.14.0 目录放到 PATH 前面，不改全局默认。host-core 以 stable 工具链做 debug 构建（crates 自
  `119e2d29` 未变）。
- 工作树参考子模块从根目录参考子模块的本地克隆初始化（固定 SHA、不联网、不改共享 git 配置），运行时构建载荷
  以 APFS 克隆复制；Electron 43.6.0 从本机缓存解压。
- 打包运行时：`~/Downloads/OMP-Desktop-0.1.4-arm64 (1).dmg`，SHA-256 `f5340b27…` 与已发布 v0.1.4 资产一致。只读
  挂载后把 Resources 复制到 `/tmp/omp-desktop-0.1.4-resources`（provenance 0.1.4、`62bc57b+omp-desktop.7`、fork
  `edec3898`、二进制 `36d59eba…`）。`/Applications/OMP Desktop.app` 现为 0.1.3，0.1.4 构建会拒绝其 provenance；
  本轮没有改动用户安装。
- 所有模型均为 127.0.0.1 FakeProvider，没有真实模型调用或费用。

## 实现事实与修复

**R09 图片附件**

1. 原状：Main 对带附件的 OMP 提示词、插话与排队跟进一律拒绝，粘贴图片即失败。
2. Main 的 `prepareOmpInput` 复用既有 `preparePromptAttachments`：路径必须在会话临时目录、附件存储或绑定项目内；
   会话投影模型声明图片输入（含模型级 `supportsImages` 覆盖）时内联，单张不超过 10 MB，单次输入合计不超过
   `MAX_SESSION_RECORD_BYTES / 2`（32 MiB，因为运行时把整条用户消息存为一条 base64 记录）；其他附件与超出预算的
   图片改为正文中的文件引用。
3. 运行器把图片放进 RPC `prompt`/`steer` 的 `images` 字段，回合围栏握手不携带图片。
4. 实测 OMP 会重新编码图片（96×64 PNG 变为 300×200 WebP）。事件转换器经注入的 `storeImage` 把运行时保存的字节
   写入 `attachments/<sha256>`，实时持久化行与恢复后的历史行引用同一副本，界面显示的就是模型收到的图片。
5. 宿主排队跟进与插话的附件走同一准备逻辑；协作消息来源仍拒绝。

**R10 全局指令**

1. 原状：设置 → 指令读写用户真实的 `~/.pi/agent/AGENTS.md`，OMP 运行从不读取。
2. 编辑器改为应用数据目录的 `<data>/AGENTS.md`（正式版 `~/.omp-desktop/AGENTS.md`）；不读写、不迁移 `~/.pi`。
3. 每次运行把去除首尾空白、32 KiB 有界（截断带说明）的内容写成合成 HOME 下的 `.agents/AGENTS.md`：先删除再独占
   写入，内容为空时只删除旧副本。固定 OMP 的 `agents` 能力提供方把它作为唯一的用户级上下文文件加载，排在项目
   上下文之前（`system-prompt.ts` 的 `dedupeContainedContextFiles`）。合成 HOME 的 `.agents` 是每次运行新建的空
   目录，不指向用户真实的 `~/.agents`。
4. 指令内容计入启动指纹：修改后在下一条提示词前替换空闲运行时，并恢复同一原生会话（复用 R06 的刷新路径）。

**R11 OAuth 入口**

1. 原状：模型配置页可以发起厂商 OAuth 登录，但 OMP 模型投影拒绝 OAuth 供应商，登录得到的账户不能用于 OMP 会话。
2. 隐藏“添加账户”；没有账户时整个区域隐藏；已有账户仍列出，可测试、编辑与删除。
3. 界面实测发现：凭据失效账户的提示仍是“移除后重新添加”，与隐藏入口矛盾。新增 `vendorDisconnectedRemoveDesc`
   （八种语言），入口隐藏期间只提示移除。

**文档**：新增 ADR 0332；运行时规格中英文修订；E2E 计划新增 `E2E-OMP-image-input`、`E2E-OMP-global-instructions`。
同时更正已过时的描述：会话操作修订与对应 ADR 中“仅文本、附件拒绝”，`E2E-OMP-session-controls` 的补充契约与边界，
`E2E-AGENTS-002` 的全局编辑器路径，规格 §7.3 注明 OMP 不使用 Pi 指令链，ADR 0037 状态。另更新用户说明，以及
0.1.4 更新记录八种语言各 3 条与数量断言。

## 验证

工作目录均为本工作树 `app/`，以下结果全部 exit 0：

| 命令/范围 | 结果 |
| --- | --- |
| 16 个定向桌面测试文件（附件 IPC、全局指令、引擎门控、设置源码、会话桥接/配置/所有权/失败关闭/删除归档、子代理、模型投影等） | **223/223** |
| omp-runtime `vitest run src/session/events.test.ts src/session/runner.test.ts src/session/history.test.ts` | **102/102** |
| shared `vitest run src/changelog.test.ts` | **5/5** |
| `pnpm --filter @pi-desktop/i18n test` | **25/25** |
| `pnpm --filter @pi-desktop/desktop typecheck`、`pnpm lint` | 通过 |
| `pnpm docs:check`、`pnpm check:release-docs` | 通过（523 页；保留既有 5 条 ADR 格式提示） |
| `pnpm build:js` 后 `OMP_BUNDLED_RESOURCES=… OMP_E2E_PACKAGED_RESOURCES=… env -u SSH_ASKPASS pnpm -r --if-present test` | 全部包通过；desktop 3244 项：3234 通过、0 失败、10 跳过 |

完整套件里的原生 e2e（内置 0.1.4 运行时加本机 FakeProvider）都实际执行并通过，包括 `omp-image-prompt-e2e`
（视觉模型收到图片内容，实时行与恢复行引用同一 `attachments/<sha256>`）、`omp-global-instructions-e2e`（金丝雀
进入系统提示，没有指令的运行不含）、`omp-user-subagents-e2e`、`omp-first-response-e2e`、`omp-deepseek-replay-e2e`、
`omp-session-operations-e2e`、`omp-worktree-e2e`、`omp-plan-submit-e2e`、`omp-skill-path-e2e`，以及补丁运行时的
`omp-execution-policy-e2e`、`omp-runtime-state-e2e`、`omp-session-turn-fence-e2e`。10 项跳过需要专用资源：8 项
`OMP_T21_RESOURCES` 篡改用例、1 项真实 typescript-language-server、1 项 `OMP_MEMORY_TEST_RUNTIME`。

上一轮会话的完整套件有 7 项失败，均为环境缺失：工作树未初始化参考子模块（5 项）、缺少 debug host-core（1 项）、
本机 `SSH_ASKPASS`（1 项）。补齐环境后又暴露两类问题：`/Applications` 换成 0.1.3 后 provenance 被拒（改用 0.1.4
DMG 资源）；修订线 R06 遗留的两处夹具缺口（已在修订线 `852ca1b9` 修复）。

## 真实界面验收

一次性 CDP 脚本（未提交）驱动实际的 Electron 渲染层、preload、Main 与 host-core。HOME、数据目录与 profile 都是
临时目录，`OMP_DESKTOP_RUNTIME` 指向上述 0.1.4 内置运行时，模型为 FakeProvider；临时 HOME 中预置
`~/.pi/agent/AGENTS.md` 金丝雀。

| 场景 | 结果 |
| --- | --- |
| 模型配置，没有厂商账户（运行时报告 8 个 OAuth 厂商） | 没有“添加账户”，也没有“厂商账户”区域 |
| 设置 → 指令 | 路径为 `<临时数据目录>/AGENTS.md`，初始为空（未显示 `~/.pi` 金丝雀）；保存后写入数据目录，`~/.pi/agent/AGENTS.md` 字节不变 |
| 新会话粘贴 96×64 PNG 并发送 | 模型请求带 `image/webp` 图片内容；系统提示含刚保存的全局指令标记，不含 `~/.pi` 金丝雀；用户行显示 300×200 WebP |
| 重启应用后打开该会话 | 恢复行显示同一图片（尺寸、名称一致） |
| 预置一个无凭据的 Anthropic OAuth 账户后查看模型配置 | 区域列出该账户，可测试/编辑/删除；没有“添加账户”；提示为“请移除”，不再提示重新添加 |

截图与报告在同名子目录。脚本对 Electron 发送 SIGTERM，20 秒未退出后强制结束；单独探针显示开发版在没有任何会话
时同样不响应 SIGTERM，属既有行为，与本改动无关。两次运行后均没有残留的 host-core、Electron 或 OMP 进程。

## 交付边界与下一任务

- R09–R11 尚未并入修订线。是否随 `0.1.4+chatfix` 同版本修订一起发布由用户决定；更新记录已按同版本修订惯例写入
  0.1.4 条目。
- OAuth 账户仍不能驱动 OMP 会话；隐藏入口只阻止新建。
- 未运行付费模型、安装态 GUI 或 Windows/Linux 原生打包，不将这些列为通过。
- 未改 OMP 补丁、运行时固定坐标、版本、数据库结构、真实配置、凭证或历史。
- 已安装用户需要安装包含本修复的新包才能获得这些行为。

原始输出、截图与报告在 [OMP-dead-controls-20261022/](OMP-dead-controls-20261022/)，`SHA256SUMS.txt` 记录摘要。
