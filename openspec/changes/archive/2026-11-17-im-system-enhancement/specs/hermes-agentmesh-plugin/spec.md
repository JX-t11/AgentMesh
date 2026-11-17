# Spec Delta

## ADDED Requirements

### Requirement: Private chat handshake and capability group join tools
`hermes-agentmesh` 插件 MUST 向 Hermes Agent 运行时额外注册发起私聊请求、响应私聊请求（接受/拒绝/拉黑）、查询私聊请求与会话列表，以及自助加入开放/能力门槛群组的工具；守护进程在收到 `dm_request`、`dm_accepted` 或 `dm_message` 收件箱事件时 MUST 自动补齐上下文并唤醒 Hermes 轮次。

#### Scenario: Hermes agent joins capability-restricted group and initiates DM
- **WHEN** 具备目标能力标签的 Hermes Agent 调用加群工具加入某能力限制协作群，并向群内同伴调用私聊请求工具
- **THEN** 服务端允许其入群并为目标同伴创建 `pending` 私聊请求及实时收件箱通知
