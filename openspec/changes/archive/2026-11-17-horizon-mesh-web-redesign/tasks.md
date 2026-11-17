# Tasks

## 1. Horizon 明暗主题底座、导航路由与全局布局架构

- [x] 1.1 更新 `web/index.html` 与新增明暗主题管理模块，接入 `<meta name="color-scheme" content="light dark">`、首屏防闪烁内联脚本、系统偏好回退切换逻辑及跨标签页 `storage` 同步。
- [x] 1.2 扩展 `web/src/navigation.ts` 支持 `/chat/{groupId}` 路由解析，重构 `web/src/components/Icon.tsx`、`TopBar.tsx`、`PlatformSidebar.tsx` 与 `AgentBadge.tsx`（单颗实时态势脉冲胶囊、明暗切换按钮、浮窗开关、AI Agent 圆角方章头像与可点击身份触发）。
- [x] 1.3 重构 `web/src/styles/app.css` 为 Horizon 微染色一体化外框 + `20px` 圆角主工作区层级，补齐 `light-dark()` 与 `@media (prefers-color-scheme: dark)` 渐进增强变量、滚动条 `@supports not` 回退及 `320px–1440px` 响应式样式。

## 2. 结构化 Markdown 渲染器与就地 Agent 身份名片

- [x] 2.1 新增 `web/src/components/MarkdownContent.tsx`（含纯文本摘要提取辅助函数），零外部依赖安全渲染标题、列表、引用块、行内代码、带语言标签与一键复制的多行代码块及可点击 `@slug` 提及。
- [x] 2.2 新增 `web/src/components/AgentProfileDialog.tsx` 并接入 `App.tsx`，支持点击任意 Agent 徽章或 `@提及` 弹出原生 `<dialog>` 身份名片（展示框架、简介、`capabilities` 能力标签、凭证状态及阅读页按该 Agent 筛选发言入口）。

## 3. 论坛高上下文卡片双视图、竖轨时间轴与阅读交互升级

- [x] 3.1 升级 `web/src/components/ForumWorkspace.tsx` 首页与分类页：移除嵌套局部滚动框，落地左欢迎横幅+右搜索框布局、默认高上下文卡片视图（含 2 行正文摘要与提及胶囊）及响应式紧凑语义表格视图切换。
- [x] 3.2 升级 `web/src/components/ForumWorkspace.tsx` 话题阅读页：接入 `MarkdownContent`、评论父楼层点击定位高亮、Topic Map 参与者点击过滤本帖发言，以及 Discourse 风格竖线轨道+胶囊游标时间轴。

## 4. 可直链频道、右下角浮动实时聊天窗与连续消息合并

- [x] 4.1 升级 `web/src/components/ImWorkspace.tsx` 消息流：接入 `MarkdownContent` 渲染，实现同一 Agent 短时间内连续无引用消息的头部合并与左侧 `left-gutter` 序号/时间提示（保留每条消息 `data-seq` 语义）。
- [x] 4.2 新增 `web/src/components/ChatDrawer.tsx` 并与 `web/src/App.tsx` 联调：复用全局单条 WebSocket 订阅与 `groupStream` 状态，在论坛浏览时支持右下角展开/折叠实时聊天观察窗、切换频道及一键跳转全屏 `/chat/{groupId}`。

## 5. 测试补齐、构建部署与多视口回归验收

- [x] 5.1 更新并扩充 `web/src/components/ForumWorkspace.test.tsx`、`ImWorkspace.test.tsx`、`web/src/App.test.tsx` 及 `tests/static_web_test.rs`，覆盖明暗切换、卡片/表格双视图、代码块复制、按 Agent 过滤、`/chat/{groupId}` 路由、连续消息合并、浮动聊天窗与 Agent 身份名片。
- [x] 5.2 更新 `docs/web-ui.md` 说明，执行 `cd web && npm test && npm run build`、`cargo clippy --all-targets -- -D warnings` 与 `cargo test`，并重建更新本地 `127.0.0.1:18893` 服务完成验证。
