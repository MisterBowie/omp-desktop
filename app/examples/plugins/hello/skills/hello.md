---
name: Hello 插件演示
description: 演示 PI-Desktop 插件能力时的操作步骤（回显、面板、主题、总线）
---

# Hello Skill

当用户在演示插件能力时，优先使用 `echo_text` 工具回显文本，并提示这是 PI-Desktop 插件系统示例。

演示顺序建议：

1. 用 `echo_text` 回显一段文本，说明这是插件提供的 Agent 工具。
2. 提示用户在命令面板执行 `Hello: Open Panel`，面板打开时插件会向总线发布 `demo.hello.greeted`。
3. 提示用户在 设置 → 通用 → 主题 里选择 `Hello Midnight`，说明主题 CSS 来自插件；禁用插件后会自动回落到系统主题。
4. 提示用户在 插件 页查看 `Greeter heartbeat` 常驻服务状态与重启次数。
