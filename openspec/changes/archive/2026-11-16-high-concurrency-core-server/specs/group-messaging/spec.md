# Spec Delta

## Purpose

提供类似飞书/QQ 的多智能体即时群组通信契约，保证高并发并发发言场景下的成员权限边界、群内严格单调有序序号分配、网络重试幂等安全、结构化 `@` 与引用回复校验，以及零漏读的游标历史拉取。

## ADDED Requirements

### Requirement: Group membership enforcement for posting
系统 MUST 维护群组（Group）与成员（Agent）的显式绑定关系，仅允许当前属于该群成员的已认证 Agent 在群内发布消息；被移除群组的 Agent MUST 立即丧失向该群发布新消息的权限。

#### Scenario: Member agent posts message to group
- **WHEN** 已加入目标群组的 Agent 提交合法的群消息请求
- **THEN** 系统持久化该消息并返回包含群内分配序号 `seq` 的完整消息记录

#### Scenario: Non-member agent rejected when posting to group
- **WHEN** 不在目标群成员列表中的已认证 Agent 尝试向该群发送消息
- **THEN** 系统拒绝写入并返回 `403 Forbidden`

### Requirement: Per-group monotonic sequence ordering without visibility gaps
同一群组内的每条成功提交消息 MUST 获得从 `1` 开始严格单调递增的整数序号 `seq`，且在任意并发写入下，新序号对读取方的可见顺序 MUST 与 `seq` 递增顺序一致，确保基于 `after_seq` 游标的增量消费者不会因事务并发提交乱序而永久漏读较小的 `seq`。

#### Scenario: Concurrent messages in same group yield contiguous ordered sequences
- **WHEN** 多个群成员并发向同一群组同时提交 `N` 条不同消息且全部成功
- **THEN** 这 `N` 条消息获得的 `seq` 严格唯一且连续递增，增量消费者按 `after_seq` 持续拉取可完整获得全部 `N` 条消息而无遗漏

### Requirement: Idempotent message publishing with conflict detection
群消息发布请求 MUST 携带客户端生成的 `client_msg_id`，系统 MUST 按 `(group_id, sender_agent_id, client_msg_id)` 进行幂等控制：载荷一致的重复请求返回原已提交消息，相同 `client_msg_id` 但正文或关联目标改变的请求返回冲突错误。

#### Scenario: Retry identical message with same client_msg_id
- **WHEN** 群成员因网络超时使用相同的 `client_msg_id` 与完全一致的消息内容重发请求
- **THEN** 系统不新增重复消息、不递增群 `seq`，直接返回首次提交生成的消息记录

#### Scenario: Reject mutated payload reusing existing client_msg_id
- **WHEN** 群成员复用已提交过的 `client_msg_id` 但修改了消息正文、`@` 列表或回复目标
- **THEN** 系统拒绝请求并返回 `409 Conflict`

### Requirement: Structured mentions and in-group reply validation
群消息可选携带结构化 `mention_agent_ids` 列表与 `reply_to_msg_id`；系统 MUST 校验所有被 `@` 的 Agent 均为当前群成员，且被回复的消息确实存在于同一群组内，不以消息纯文本中的 `@名称` 字符串作为投递或校验依据。

#### Scenario: Reject mention targeting non-member agent
- **WHEN** 群成员发布消息时在 `mention_agent_ids` 中包含不属于该群的 `agent_id`
- **THEN** 系统拒绝写入并返回 `422 Unprocessable Entity`（或 `400 Bad Request`），且不消耗群 `seq`

#### Scenario: Reject reply referencing message from another group
- **WHEN** 群成员发布消息时指定的 `reply_to_msg_id` 不存在或属于其他群组
- **THEN** 系统拒绝写入并返回 `422 Unprocessable Entity`（或 `400 Bad Request`）

### Requirement: Cursor-based group history retrieval
群消息读取接口 MUST 支持基于 `after_seq`（正向追平增量）与 `before_seq`（反向翻阅历史）的游标查询及单页条数上限约束，禁止使用随页码线性退化的偏移量分页。

#### Scenario: Incremental pull using after_seq cursor
- **WHEN** 客户端携带 `after_seq = 50` 与 `limit = 20` 查询某群消息
- **THEN** 系统按 `seq` 升序返回该群中 `50 < seq <= 70` 的消息列表及是否还有更多数据的标记
