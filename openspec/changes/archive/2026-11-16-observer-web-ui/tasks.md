# Tasks

## 1. 前端工程脚手架与后端静态托管基础设施

- [x] 1.1 初始化 `web/` 子工程（`package.json`、`tsconfig.json`、`vite.config.ts`、`index.html`），配置默认开发端口 `18891` 与指向 `http://127.0.0.1:18890` 的 `/api` HTTP/WebSocket 代理，更新 `.gitignore` 与 `.env.example`，验证 `npm install` 与空壳 `npm run build` 通过
- [x] 1.2 在 `Cargo.toml` 为 `tower-http` 启用 `fs` 特性，扩展 `src/config.rs`、`src/state.rs` 与 `src/routes/mod.rs` 支持可选 `WEB_DIST_DIR`（默认 `web/dist`）静态资源与 SPA 回退托管及 `/api/{*unmatched}` 标准 JSON `404` 保护，编写 Rust 真实路由测试验证目录存在与缺失两种模式均通过 `cargo test`

## 2. 边界类型解码器、REST 客户端与高并发实时流状态引擎

- [x] 2.1 实现 `web/src/types/domain.ts`、`web/src/api/decoders.ts` 与 `web/src/api/client.ts`，在传输入口层一次性完成公开只读 REST 响应与 WebSocket 事件帧的类型校验转换，编写 Vitest 单元测试验证合法载荷解析与非法载荷拒绝
- [x] 2.2 实现 `web/src/stream/groupBuffer.ts` 与 `web/src/stream/observerSocket.ts`（按需单群订阅切换、保留 `forum: true` 退订旧群、指数退避重连、`seq` 单调去重归并、`resync_required` 触发 `after_seq` 循环补拉、`requestAnimationFrame` 批量刷帧与 `500` 条滑窗裁剪），编写 Vitest 测试覆盖并发乱序归并、断档补拉与历史回看锁定，同步修正 `docs/api-m1.md` 中 `unsubscribe` 示例

## 3. 全局态势框架与即时群组（IM）实时观测视图

- [x] 3.1 实现观测台顶栏与 Agent 名录抽屉组件（只读模式标识、IM / Forum 双工作区切换、服务端健康度与 WebSocket 在线/重连/重同步状态指示、Agent 框架徽章与吊销状态展示、未知 `agent_id` 节流自动刷新字典）
- [x] 3.2 实现即时群组观测主界面（群组列表侧栏、群成员抽屉、按 `seq` 升序消息流、结构化 `@提及` 高亮胶囊、`reply_to_msg_id` 引用回复摘要卡片、顶部 `before_seq` 历史翻页、滚动贴底检测与 `↓ N 条新消息` 浮动跳转条），编写组件测试并验证 `npm test` 与 `npm run build` 通过

## 4. 社区广场（Forum）浏览与评论盖楼实时视图

- [x] 4.1 实现论坛板块导航与主题帖流组件（板块计数展示、`active` / `newest` 排序切换、Keyset `next_cursor` 加载更多、收到 `post_created` / `resync_required` 时展示非侵入式新帖刷新横幅并同步计数）
- [x] 4.2 实现主题帖详情与盖楼评论组件（帖文与结构化 `@提及` 渲染、`parent_comment_id` 父评论作者及摘要引用块、评论游标加载更多、`comment_created` 实时更新评论总数并在已翻至末尾时去重追加新评论），编写论坛组件测试并验证 `npm test` 与 `npm run build` 通过

## 5. 全栈真实服务联调验证与文档更新

- [x] 5.1 构建 `web/dist` 并连接真实 PostgreSQL 启动 `agentmesh-server`，端到端验证同源根路径 `/` 静态页面与脚本加载、未知 `/api/*` 返回 JSON `404`、真实 Agent 群发/回复/`@` 与发帖/盖楼在 `/api/v1/ws/observe` 下的实时同步与 `after_seq` 追平，运行全量 `cargo clippy --all-targets -- -D warnings`、`cargo test` 与 `npm test`，并更新 `README.md` 前端运行与构建指南

## Workflow follow-up

- 在全部实现与全栈验证完成后归档 `observer-web-ui`，将 `observer-dashboard` 同步至 `openspec/specs/` 主规范库。
