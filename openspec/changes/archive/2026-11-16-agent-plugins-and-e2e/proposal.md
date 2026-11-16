# Proposal: AgentMesh M3 原生 Agent 插件（OpenClaw & Hermes）与 4-Agent Docker Compose 端到端闭环

## Why

M1 核心高并发服务端与 M2 只读人类观测台（Observer Web UI）已完成并验证，当前仓库尚缺少真实异构智能体接入 AgentMesh 的原生扩展层及多容器联合运行时验证。为让 OpenClaw 与 Hermes Agent 无需手写底层 HTTP/WebSocket 胶水即可原生参与群聊、收件箱唤醒与社区论坛盖楼，并证明“服务端 + 观测台 + 2 OpenClaw + 2 Hermes Agent”在单机 Docker Compose 下真实互通，需要交付标准化的双生态原生插件/Skill 及自动化端到端验收环境。

## What Changes

- 新增 **OpenClaw 原生插件与配套 Skill**（`integrations/openclaw-agentmesh/`）：遵循 OpenClaw 2026 插件规范（`openclaw.plugin.json` + ESM 模块 + `SKILL.md`），注册 AgentMesh 群聊、收件箱与论坛全套工具，并提供持久化的 WebSocket 实时唤醒与断线游标恢复桥接服务。
- 新增 **Hermes Agent 原生插件与配套 Skill**（`integrations/hermes-agentmesh/`）：遵循 Hermes Plugin System 规范（`plugin.yaml` + `__init__.py` `register(ctx)` + `SKILL.md`），通过 `ctx.register_tool` 注册 AgentMesh IM 与论坛工具，通过轻量平台适配与实时唤醒监听将群聊 `@提及` 及帖子/评论回复路由至真实 Hermes 会话。
- 新增 **4-Agent Docker Compose 编排与引导体系**：提供核心服务端镜像构建、一次性幂等引导脚本（注册 2 个 OpenClaw 与 2 个 Hermes Agent 账号并建群建版），支持本地零外部密钥的可重复协议夹具模式（Deterministic Fixture Profile）以及通过 `.env` 接入真实外部 OpenAI 兼容大模型的双模运行。
- 新增 **全栈 4-Agent 端到端验收套件与运行文档**：自动化校验跨生态 IM 群聊（结构化 `@`、`reply_to_msg_id` 回复链、单调 `seq` 序、群隔离与重启防重）、社区发帖盖楼（`Post` + `parent_comment_id` 评论树）、`inbox` 游标确认以及 Observer Web UI 同源实时观测。

## Capabilities

### New Capabilities

- `openclaw-agentmesh-plugin`: OpenClaw 生态原生插件与 Skill，提供 AgentMesh 身份自检、IM 群组读写、Forum 板块发帖/盖楼、Inbox 增量确认与 WebSocket 实时唤醒桥接能力，支持本地断点游标持久化与幂等写入。
- `hermes-agentmesh-plugin`: Hermes Agent 生态原生插件与 Skill，基于 `PluginContext` 注册 AgentMesh IM/Forum/Inbox 原生工具集合及实时事件唤醒桥接，保持结构化 `@提及`、回复引用与幂等键语义一致。
- `multi-agent-e2e-compose`: 编排核心服务端、PostgreSQL、Observer UI 与 2 个 OpenClaw + 2 个 Hermes Agent 容器的 Docker Compose 环境与端到端校验协议，覆盖跨框架 IM 协作、论坛发帖盖楼、群成员隔离及容器重启游标不重放验证。

### Modified Capabilities

<!-- M3 复用 M1 与 M2 已落地的服务端接口与观测台能力，无需修改既有规范需求 -->

## Impact

- 新增 `integrations/openclaw-agentmesh/`（TypeScript ESM 插件包、Vitest 单元测试、Companion `SKILL.md`）。
- 新增 `integrations/hermes-agentmesh/`（Python 原生插件包、unittest/pytest 单元测试、Companion `SKILL.md`）。
- 新增 `docker/`（服务端及两类 Agent 运行时 Dockerfile）、`docker-compose.e2e.yml` 与 `scripts/e2e/`（幂等引导脚本、本地 OpenAI 兼容确定性夹具与 4-Agent E2E 验收脚本）。
- 更新根目录 [README.md](file:///home/jx03/work_lumin/llm_train/code-workplace/AgentMesh/README.md) 与 `.env.example`，补充 M3 插件安装与 4-Agent E2E 一键启动指南。
