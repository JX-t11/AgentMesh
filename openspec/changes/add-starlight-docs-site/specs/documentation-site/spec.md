# Spec Delta

## Purpose

为 AgentMesh 提供独立构建、可被搜索并随平台同域发布的接入文档站，明确 `/docs` 下的公开路由、旧地址兼容、静态托管边界与内容单一来源。

## ADDED Requirements

### Requirement: Published documentation routes and navigation

文档站 MUST 以 `/docs/` 为入口，并为 `quick-start`、`create-agent`、`openclaw`、`hermes`、`collaboration`、`faq` 六篇指南提供 `/docs/guides/{slug}/` 的稳定地址。每篇指南 SHALL 包含标题、正文、分组侧栏和前后篇导航，并允许匿名访问、直接刷新和新标签页打开。站点 SHALL 提供全文搜索入口；文档页面的静态资源与搜索索引 MUST 与页面同源可用。

#### Scenario: Open a guide directly and navigate the sidebar

- **WHEN** 匿名访客直接打开或刷新 `/docs/guides/openclaw/`
- **THEN** 服务端返回该指南的完整 HTML，页面显示标题、正文、分组侧栏与前后篇导航，且 `/docs/_astro/*` 样式脚本和 `/docs/pagefind/*` 搜索资源均可加载

#### Scenario: Open the documentation landing page

- **WHEN** 访客访问 `/docs/` 或点击平台中的“文档中心”链接
- **THEN** 页面展示文档首页与六篇指南入口，所有指南链接指向 `/docs/guides/{slug}/`

### Requirement: Documentation hosting and route isolation

服务端 MUST 仅在配置了文档构建产物目录时，将 `/docs` 前缀静态托管给文档站；页面请求 SHALL 返回目录中的 `index.html`，不带尾斜杠的指南地址 SHALL 重定向到带尾斜杠的地址，且重定向后的 `Location` MUST 保留 `/docs` 前缀。文档挂载 MUST NOT 改变 `/api` 的 JSON 404 行为；未配置文档目录时，`/docs` SHALL 继续由既有 SPA 回退处理。

#### Scenario: Serve guides and assets with the prefix preserved

- **WHEN** 文档产物目录已配置，访客请求 `/docs/guides/openclaw/`、`/docs/_astro/{asset}`，随后请求 `/docs/guides/openclaw`
- **THEN** 前两者分别返回 200 的 HTML 与静态资源；无尾斜杠请求返回重定向，`Location` 为 `/docs/guides/openclaw/`

#### Scenario: Keep API errors isolated from documentation hosting

- **WHEN** 文档产物目录已配置，客户端请求不存在的 `/api/v1/*` 地址
- **THEN** 服务端返回 JSON 格式的 404，而不是文档站页面或文档站的纯文本 404

#### Scenario: Fall back to the SPA when documentation is not configured

- **WHEN** 未设置文档产物目录，访客请求 `/docs`
- **THEN** 服务端沿用既有 Web SPA 回退，不挂载文档站

### Requirement: Legacy documentation URLs remain reachable

文档站启用时，旧的 `/docs/{slug}` 地址 MUST 永久重定向到对应的 `/docs/guides/{slug}/`，覆盖六篇既有指南的全部 slug。重定向 MUST 使用可缓存的永久状态码，且不得影响 `/docs/guides/*`、文档静态资源或其他 `/docs/*` 路径。

#### Scenario: Redirect a previously published guide URL

- **WHEN** 访客打开旧地址 `/docs/openclaw` 或 `/docs/faq`
- **THEN** 服务端返回永久重定向，`Location` 分别为 `/docs/guides/openclaw/` 和 `/docs/guides/faq/`，浏览器最终展示对应指南

### Requirement: Single-source guide content and build independence

六篇指南 MUST 以 `docs-site/content-guides/*.md` 为唯一源文件；文档站构建 SHALL 在生成页面时替换 `{{platform_url}}`，且生成目录不得进入版本控制。平台生成 `/connect/{framework}.md` 时 MUST 直接读取同一源文件、移除 frontmatter 并替换 `{{platform_url}}`，不得依赖文档站先前生成的页面目录。全新克隆在未运行文档站构建时，`npm --prefix web run build` MUST 成功完成。

#### Scenario: Build the web bundle without generated documentation pages

- **WHEN** 全新克隆中不存在 `docs-site/src/content/docs/guides/`，维护者直接运行 `npm --prefix web run build`
- **THEN** 构建成功，`web/public/connect/openclaw.md` 以 `# AgentMesh OpenClaw 接入` 开头，正文不包含 YAML frontmatter 或 `{{platform_url}}` 占位符

#### Scenario: Build the documentation site from canonical sources

- **WHEN** 维护者运行 `npm --prefix docs-site run build`
- **THEN** 构建脚本从 `docs-site/content-guides/` 生成六篇页面，页面中的平台地址已替换，生成的指南目录与构建产物均被 Git 忽略
