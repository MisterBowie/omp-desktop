# 00. 概述

> **翻译说明：** 本页是与 [英文源规格](/spec/01-product/00-overview) 一一对应的机器辅助翻译。代码、协议字段和标识符保持原文；如翻译与英文源事实有歧义，以英文版本为准。

## 一行定义

**PI-Desktop** 是本地优先的 AI 编码代理桌面客户端，构建于：

- Electron 桌面外壳
- Rust主机后端核心
- 用于 model/agent 循环的 pi Agent 线束
- 用户可安装的插件扩展性
- 独立的 MCP 服务器、技能和子代理

## 产品配方

```text
PI-Desktop =
 Electron Shell
 + React UI (English-first)
 + Rust Host Core
 + pi Agent Runtime
 + Local Tools
 + Plugin System
```

## 目标

1. 为 pi 支持的代理提供稳定的桌面用户体验
2.支持多提供商流媒体聊天
3、显式权限下执行本地工具
4. 在本地保留会话、设置和机密
5.允许用户使用install/develop插件
6. 作为全球产品发货，默认语言为英语
7. 让同一个 Agent 检查任务，提交结构化的 Plan，然后继续
   Agent 仅在单独的用户批准后
8. 让同一个 Agent 协商一份已批准的 Goal 合约，然后继续执行其
   在 Agent 模式下自主设定验收标准
9. 使项目会话、导入、扩展和预定提示切实可行
   用于日常本地工作

## 非目标 (MVP)

- 远程WebUI/网关控制
- 完整的 IDE 替换
- 多人协作
- 在 Rust 中重写 pi
- 市场优先的分销

## 关键架构决策

| 决定 | 选择 |
|---|---|
| 桌面外壳 | Electron |
| 用户界面 | React + Vite + TypeScript |
| 默认语言 | 英语 |
| 主机后端 | Rust |
| Agent 引擎 | pi (`pi-ai` + `pi-agent-core`) |
| Agent 流程 | Node sidecar / 受控过程 |
| Renderer 访问 | 仅限 preload IPC |
| 扩展 | 用户可安装的插件 |
| 存储 | SQLite + 安全密钥存储 |

## 最小用户循环

1. 启动PI-Desktop
2.配置provider/API密钥
3. 打开项目工作区
4. 创建会话并发送任务
5. 选择 Agent、Plan 或 Goal；可选择检查项目并提交
   降价检查点
6. 批准或拒绝检查点并选择执行权限模式
7. 需要时批准本地工具执行
8. 在工作面板中查看差异、终端输出、浏览器预览和文件
9. 重新启动应用程序；中断的合同工作不会重播

## 质量原则

1. **引擎稳定性第一** - 在功能蔓延之前纠正 pi 循环
2. **最低权限默认** — 默认拒绝有风险的 tools/plugins
3. **可观测性** — 每个工具调用和失败都是可追踪的
4. **可替代性** — providers/tools/storage 可以进化
5. **全球就绪** - 早期英文源字符串和语言环境架构

## 文档地图

- 基线：`../00-baseline.md`
- 产品范围：`01-product-scope.md`
- 架构：`../02-architecture/01-architecture.md`
- IPC：`../03-runtime/01-ipc-protocol.md`
- Agent 运行时：`../03-runtime/02-agent-runtime.md`
- Tools/permissions：`../03-runtime/03-tools-and-permissions.md`
- 里程碑：`../06-delivery/01-mvp-milestones.md`
- 插件：`../07-plugins/01-plugin-system.md`
