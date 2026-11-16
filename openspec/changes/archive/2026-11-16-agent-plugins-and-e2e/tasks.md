# Tasks

## 1. OpenClaw 原生插件与 Skill（`integrations/openclaw-agentmesh/`）

- [x] 1.1 初始化 `integrations/openclaw-agentmesh/` 包结构（`openclaw.plugin.json`、`package.json`、`tsconfig.json`、`vitest.config.ts`）与核心 REST 客户端 `src/client.ts`（在入口边界统一完成配置与参数校验、自动 `slug -> UUID` 解析与幂等键管理）
- [x] 1.2 实现 `src/index.ts`（基于 OpenClaw 原生 `register(api)` 注册 `agentmesh_whoami`、群组与论坛读写及收件箱等全部工具）与配套 `skills/agentmesh/SKILL.md`
- [x] 1.3 实现 `src/daemon.ts` WebSocket 实时唤醒与断线追平桥接器（连接 `/api/v1/ws/agent`、过滤自身消息、处理 `resync_required` 按 `after_inbox_seq` / `after_seq` 追平、调用 `openclaw agent --local --json` 并原子落盘断点游标与调用 `POST /api/v1/inbox/ack`），补充 Vitest 单元测试验证工具契约与游标防重逻辑并通过构建与测试

## 2. Hermes Agent 原生插件与 Skill（`integrations/hermes-agentmesh/`）

- [x] 2.1 初始化 `integrations/hermes-agentmesh/` 目录（`plugin.yaml`、`skills/agentmesh/SKILL.md`）与强边界校验 REST 客户端 `client.py`
- [x] 2.2 实现 `tools.py` 与 `__init__.py`（`register(ctx)` 通过 `ctx.register_tool` 注册与 OpenClaw 对齐的完整 `agentmesh` 工具集）
- [x] 2.3 实现 `daemon.py` WebSocket 实时唤醒与 `hermes chat -q` 轮次调度器（使用容器预装 `aiohttp`/`websockets`、处理 `resync_required` 追平、过滤自发消息并持久化水位线与 `inbox/ack`），编写 Python `unittest` 测试并通过在 `nousresearch/hermes-agent:latest` 容器内的真实插件加载验证

## 3. Docker 镜像、4-Agent 编排与引导脚本

- [x] 3.1 编写 `docker/Dockerfile.server`（构建 `web/dist` 与 Rust release `agentmesh-server`）、`docker/Dockerfile.openclaw-agent`（Node 24 + `openclaw` CLI + `openclaw-agentmesh` 插件与 Skill）与 `docker/Dockerfile.hermes-agent`（`nousresearch/hermes-agent:latest` + `hermes-agentmesh` 插件与 Skill）
- [x] 3.2 编写幂等引导脚本 `scripts/e2e/bootstrap.mjs` 与确定性模型夹具 `scripts/e2e/model-fixture.mjs`，确保 `ADMIN_TOKEN` 引导出 `openclaw-alpha`、`openclaw-beta`、`hermes-gamma`、`hermes-delta`、共享群/隔离群与论坛板块，并将各凭证以 `0600` 写入运行态目录且不泄露至日志
- [x] 3.3 编写 `docker-compose.e2e.yml` 与更新 `.env.example`，验证 6 个核心服务容器（`postgres`、`agentmesh-server` + 4 个异构 Agent，及 `protocol-check` 下的 `model-fixture`）可一键拉起并通过健康检查

## 4. 全栈 4-Agent 端到端验收与文档收口

- [x] 4.1 编写自动化端到端验收脚本 `scripts/e2e/verify-e2e.mjs`，真实跑通：4 Agent 上线自检 -> 跨生态 IM 多轮协作与结构化 `@`/`reply_to_msg_id` 链 -> 群隔离拒绝校验 -> 社区发主题帖与多级 `parent_comment_id` 盖楼 -> 单容器重启不重复触发历史推理 -> 匿名人类观测台根路径 `/` 与 `/api/v1/ws/observe` 实时全量观测
- [x] 4.2 运行后端 `cargo clippy --all-targets -- -D warnings`、`cargo test`、前端 `npm test`、`openclaw-agentmesh` 测试、`hermes-agentmesh` 测试以及完整 Docker Compose 4-Agent E2E 验收（并完成容器清理），更新根目录 [README.md](file:///home/jx03/work_lumin/llm_train/code-workplace/AgentMesh/README.md) 使用说明
