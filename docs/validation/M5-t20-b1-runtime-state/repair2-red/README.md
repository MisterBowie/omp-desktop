# 第二次独立复审 RED 证据（未编辑归档）

2026-10-02，第二次独立复审（Mac arm64 / Node v24.14.0 / Bun 1.4.2，基线
`064c738ad585b8429a2d0d42d08719596a46f5cc`，即 §9 首轮返修提交）在 F1-F4 GREEN 之外
判 `changes-required`，本目录按原字节归档其四项原始证据：

| 文件 | 内容 | SHA-256 |
| --- | --- | --- |
| `second-review-summary-064c738a.json` | 复审自身判定摘要（R1/R2/R3 + `files` 哈希表） | `355959a982788ce393f66d0be05ad02554089d4c32d7fe01331529a26bae5e10` |
| `production-state-failure-probe-064c738a.json` | R1：`delete-channel-files` 策略下真实补丁 OMP + 生产 bridge/gate 仍发出 1 次 provider 请求（正常终态） | `ff19d737a4793356823ad678f3427a78ed09a444595412e4b36a0acd00a1009d` |
| `production-state-failure-probe.mjs` | R1/R2 复审脚本（Mac 绝对路径 import，仅作可读记录，不直接运行） | `0c774a73a0dd2e952fe2ee8d14d9892beae79e3fa91ab778efecd1c9189b45c6` |
| `start-refusal-replay-064c738a.json` | R3：生产 runner/codec + 脚本化正式帧——旧代精确描述符在下一代 `agent_start` 前重放后 `replayedNoticeClosedNewGeneration=true` | `e4a25b94cd5e01d53a631e08cadd33a75fba5d79af34aea3b66103b39659f4d8` |
| `start-refusal-replay-probe.mjs` | R3 复审脚本（同上，Mac 绝对路径，不直接运行） | `5e013f5a2f1a3e4b3bcfef2a493aafbabf51f469618b34de31dde959ed89de9e` |
| `SHA256SUMS.txt` | 上述文件的 sha256sum 输出 | — |

复审同时声明：`build:js` exit 0；R2 的 symlink 覆盖为真实 `markDesktopStateRequired`
（`desktop-state.ts:249`）行为，测试使用其自有的临时目录；这些原始字节未做归一化，
不做后处理。本目录只用于定位 RED，不代表修复后的行为——修复记录见
`../M5-t20-b1-runtime-state.md` §10。
