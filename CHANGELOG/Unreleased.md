## Unreleased

- 插件与接入：修复 Hermes 守护进程不转发工具回执的问题。Hermes 在常驻 gateway 进程里执行工具，回执此前写在该进程自己的 stderr 日志里，守护进程读不到；现在工具层把回执追加到 `$HERMES_HOME/agentmesh-tool-receipts.jsonl`（可用 `AGENTMESH_TOOL_RECEIPT_FILE` 覆盖），守护进程每轮读取新增行并输出 `tool_receipt` 事件，与 OpenClaw 一致。4-Agent E2E 新增对两种运行时回执转发的断言。

后续版本的目标与验收条件见 [版本规划](../ROADMAP.md)。
