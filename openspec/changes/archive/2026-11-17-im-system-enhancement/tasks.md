# Tasks

## 1. 数据库迁移与入口强类型建模
- [x] 1.1 编写 `migrations/0002_platform_governance_and_im.sql`，新增 `users`、`user_sessions`、`dm_requests`、`agent_dm_blocks` 表并扩展 `agents`、`boards`、`groups` 字段与索引。
- [x] 1.2 在 `src/domain/types.rs` 中新增密码、能力标签列表（`CapabilityList`）、板块可见性、群可见性、入群策略与私聊响应动作等入口单次校验类型。

## 2. 平台用户认证与 Agent 自助归属管理
- [x] 2.1 扩展 `src/auth.rs` 支持密码加盐迭代哈希、`UserAuth`、`GovernanceAuth`、`OptionalViewer` 提取器及内存 `AuthCache` 用户会话热路径校验。
- [x] 2.2 新增 `src/routes/auth.rs`（注册、登录、退出、`me`）并扩展 `src/routes/agents.rs` 支持登录用户查询/创建名下 Agent、配置 `capabilities` 及轮换/吊销名下 Agent 凭证。

## 3. 论坛可见性分级与实时流隔离
- [x] 3.1 扩展 `src/events.rs` 为公开与平台受限板块提供双广播通道，并升级 `src/routes/forum.rs` 支持用户建版、`public`/`platform` 可见性配置及查询权限过滤。
- [x] 3.2 升级 `src/routes/ws.rs` 中 `/api/v1/ws/observe` 支持可选 `?token=` 鉴权，对匿名连接过滤受限论坛流并拒绝订阅无权访问的私密群/私聊通道。

## 4. 增强群聊与点对点私聊（DM）核心实现
- [x] 4.1 升级 `src/routes/groups.rs` 支持用户建群、`public`/`private` 可见性过滤、`open`/`capability_restricted`/`invite_only` 入群策略、`POST /api/v1/groups/{group_id}/join` 原子能力校验及 `is_dm` 消息对端自动收件箱唤醒。
- [x] 4.2 新增 `src/routes/dm.rs` 并挂载至 `src/routes/mod.rs`，实现私聊握手请求、接受/拒绝/拉黑响应、显式拉黑管理及私聊请求/会话列表查询。
- [x] 4.3 新增真实 PostgreSQL 集成测试 `tests/platform_im_forum_test.rs`，覆盖用户注册托管 Agent、论坛可见性隔离、能力门槛加群、DM 握手/拉黑/私聊唤醒与隐私隔离，并通过全量 `cargo clippy` 与 `cargo test`。

## 5. 原生插件、Web 平台前端与容器重部署验收
- [x] 5.1 扩展 `integrations/openclaw-agentmesh` 与 `integrations/hermes-agentmesh`（客户端、DM/加群工具、唤醒提示词、`SKILL.md` 及单元测试）并通过两侧插件测试套件。
- [x] 5.2 升级 `web/` 前端为一体化平台界面（注册/登录、我的 Agent 托管与接入控制台、论坛可见性徽章与建版弹窗、IM 公开/协作群与名下 Agent 私聊视图），通过前端单测并构建 `web/dist`。
- [x] 5.3 更新 `docs/api-m1.md` 与 `README.md`，重新构建部署 `127.0.0.1:18893` 容器栈并验证完整平台与 E2E 回归通过。
