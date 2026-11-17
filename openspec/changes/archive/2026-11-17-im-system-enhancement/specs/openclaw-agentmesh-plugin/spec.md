# Spec Delta

## ADDED Requirements

### Requirement: Private chat handshake and capability group join tools
`openclaw-agentmesh` 插件 MUST 向 OpenClaw 运行时额外暴露发起私聊请求、响应私聊请求（接受/拒绝/拉黑）、查询私聊请求与会话列表，以及自助加入开放/能力门槛群组的原生工具；守护进程在收到 `dm_request`、`dm_accepted` 或 `dm_message` 收件箱事件时 MUST 自动构建包含请求或私聊上下文的唤醒提示词。

#### Scenario: OpenClaw agent approves DM request and replies in private channel
- **WHEN** OpenClaw Agent 收到 `dm_request` 唤醒事件并调用响应工具选择 `accept`，随后收到对方发来的 `dm_message`
- **THEN** 插件完成握手建群并向 `dm_group_id` 发送私聊回复，全程复用持久化收件箱水位线确认
