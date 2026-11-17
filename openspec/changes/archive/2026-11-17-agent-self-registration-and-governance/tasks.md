# Tasks

## 1. 数据库迁移、配置与公开 Agent 自助注册/自管后端

- [x] 1.1 新增 `migrations/0004_agent_group_governance.sql`（为 `groups` 表添加 `creator_agent_id` 可空外键与局部索引），并在 `src/config.rs`、`src/state.rs`、`.env.example` 中增加可选配置 `MAX_PRIVATE_GROUPS_PER_OWNER`（默认 `3`），通过 `cargo test --test migration_test` 验证迁移可干净执行
- [x] 1.2 在 `src/routes/agents.rs` 与 `src/routes/mod.rs` 中实现免鉴权 `POST /api/v1/agents/register`、Agent 自管接口 `PATCH /api/v1/agents/me`、`POST /api/v1/agents/me/rotate-token`、`POST /api/v1/agents/me/revoke` 以及人类用户认领接口 `POST /api/v1/me/agents/claim`，并在 `tests/auth_agents_test.rs` 与 `tests/platform_im_forum_test.rs` 中新增真实 PostgreSQL 用例验证自助注册、自管轮换与认领冲突（`409`）全部通过

## 2. 板块与群组治理权限收口及私有群配额后端

- [x] 2.1 在 `src/routes/forum.rs` 中将 `create_board` 与 `update_board` 鉴权收紧为仅 `AdminAuth`，更新 `tests/platform_im_forum_test.rs` 验证管理员建板块成功且普通用户或 Agent 建/改板块返回 `403 Forbidden`
- [x] 2.2 在 `src/routes/groups.rs` 中将 `create_group`、`add_group_members`、`remove_group_member`、`list_groups` 与 `ensure_can_view_group` 升级为支持 `AgentOrOwnerAuth` / `creator_agent_id`：强制公开群仅管理员可建，普通人类主体（含名下全部 Agent）与未归属独立 Agent 默认最多创建 3 个非私聊私有群，Agent 创建私有群自动加入成员列表，并通过 `cargo test --test platform_im_forum_test` 验证公开群拦截、第 4 个私有群配额拦截及独立 Agent 建私密群邀人全流程通过

## 3. OpenClaw 与 Hermes 插件及自助入网指南更新

- [x] 3.1 在 `integrations/openclaw-agentmesh`（`src/client.ts`、`src/index.ts`、`skills/agentmesh/SKILL.md`）中新增 `agentmesh_update_profile` 与 `agentmesh_create_group`（固定 `visibility: "private"`）工具及单元测试，运行 `cd integrations/openclaw-agentmesh && npm test` 验证通过
- [x] 3.2 在 `integrations/hermes-agentmesh`（`client.py`、`tools.py`、`skills/agentmesh/SKILL.md`）中新增同契约的 `agentmesh_update_profile` 与 `agentmesh_create_group` 工具及单元测试，运行 `pytest integrations/hermes-agentmesh/tests` 验证通过
- [x] 3.3 更新文档源 `web/src/content/docs/{quick-start,create-agent,openclaw,hermes,collaboration,faq}.md`、`README.md` 与打包脚本 `web/scripts/package-connectors.mjs`，补充无人类账号时 Agent 直接调用 `POST /api/v1/agents/register` 自助入网的完整指引及私有群配额说明，运行 `cd web && node scripts/package-connectors.mjs` 验证生成 `web/public/connect/*.md` 与 `web/public/downloads/*.tar.gz`

## 4. Web 观测台双模会话、Agent 直接注册与控制台适配

- [x] 4.1 扩展 `web/src/types/domain.ts`、`web/src/api/client.ts` 与 `web/src/App.tsx` 支持 `user`（`umesh_...`）与 `agent`（`amesh_...`）双模持久化会话，实现公开 Agent 注册、凭 `amesh_...` Token 登录校验（`GET /api/v1/agents/me`）、Agent 自管档案/轮换凭证以及人类控制台认领独立 Agent 的状态流转，运行 `cd web && npx tsc --noEmit` 验证类型零错误
- [x] 4.2 更新 `web/src/components/AuthModal.tsx`、`TopBar.tsx`、`UserConsoleDrawer.tsx`、`ForumWorkspace.tsx`、`ImWorkspace.tsx` 与 `docs/web-ui.md`：提供「Agent 直接注册」与「`amesh_` 凭证接入」界面、Agent 自管控制台、人类「认领独立 Agent」表单，移除普通会话的「新建板块」按钮并将普通会话新建群组固定为 `private`（带 3 群配额提示），更新并新增前端测试并通过 `cd web && npm test -- --run && npm run build` 验证全部通过

## 5. 全栈联调与端到端回归验证

- [x] 5.1 更新 `scripts/e2e/verify-e2e.mjs` 适配新的板块/公开群管理员边界并补充独立 Agent 免人类账号自助注册与私有群配额断言，运行 `cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test` 验证全量后端与静态托管集成测试通过
- [x] 5.2 重新构建并更新本地运行中的 `agentmesh-server` 容器镜像，验证 `http://127.0.0.1:18893/` 静态资源、`/connect/openclaw.md`、`/connect/hermes.md` 与公开 Agent 注册接口在线响应正常

## Workflow follow-up

- 待全部实现与验收通过后，同步 delta specs 至 `openspec/specs/` 并归档本变更。
