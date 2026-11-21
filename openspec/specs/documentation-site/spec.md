# documentation-site Specification

## Purpose
为 AgentMesh 提供独立构建、可被搜索并随平台同域发布的接入文档站，明确 `/docs` 下的公开路由、旧地址兼容、静态托管边界与内容单一来源。

## Requirements

### Requirement: Published documentation routes and navigation

文档站 MUST 以 `/docs/` 为入口，并为 `quick-start`、`create-agent`、`openclaw`、`hermes`、`collaboration`、`faq` 六篇指南提供 `/docs/guides/{slug}/` 的稳定地址。每篇指南 SHALL 包含标题、正文、分组侧栏和前后篇导航，并允许匿名访问、直接刷新和新标签页打开。站点 SHALL 提供全文搜索入口；文档页面的静态资源与搜索索引 MUST 与页面同源可用。

#### Scenario: Open a guide directly and navigate the sidebar

- **WHEN** 匿名访客直接打开或刷新 `/docs/guides/openclaw/`
- **THEN** 服务端返回该指南的完整 HTML，页面显示标题、正文、分组侧栏与前后篇导航，且 `/docs/_astro/*` 样式脚本和 `/docs/pagefind/*` 搜索资源均可加载

#### Scenario: Open the documentation landing page

- **WHEN** 访客访问 `/docs/` 或点击平台中的“文档中心”链接
- **THEN** 页面展示文档首页与六篇指南入口，所有指南链接指向 `/docs/guides/{slug}/`

### Requirement: Documentation hosting and route isolation

服务端 MUST 默认使用 `docs-site/dist` 作为文档产物目录；该目录包含 `index.html` 时，将 `/docs` 前缀静态托管给文档站。`DOCS_DIST_DIR` 显式设为空值或默认目录缺失时，`/docs` SHALL 继续由既有 SPA 回退处理。页面请求 SHALL 返回目录中的 `index.html`，不带尾斜杠的指南地址 SHALL 重定向到带尾斜杠的地址，且重定向后的 `Location` MUST 保留 `/docs` 前缀。文档挂载 MUST NOT 改变 `/api` 的 JSON 404 行为；未命中文档路径 MUST 返回状态码 404 的文档站错误页，而不是 SPA 入口。

#### Scenario: Serve guides and assets with the prefix preserved

- **WHEN** 文档产物目录已配置，访客请求 `/docs/guides/openclaw/`、`/docs/_astro/{asset}`，随后请求 `/docs/guides/openclaw`
- **THEN** 前两者分别返回 200 的 HTML 与静态资源；无尾斜杠请求返回重定向，`Location` 为 `/docs/guides/openclaw/`

#### Scenario: Keep API errors isolated from documentation hosting

- **WHEN** 文档产物目录已配置，客户端请求不存在的 `/api/v1/*` 地址
- **THEN** 服务端返回 JSON 格式的 404，而不是文档站页面或文档站的纯文本 404

#### Scenario: Fall back to the SPA when documentation is explicitly disabled

- **WHEN** 设置 `DOCS_DIST_DIR=`，访客请求 `/docs`
- **THEN** 服务端沿用既有 Web SPA 回退，不挂载文档站

#### Scenario: Fall back when the default docs build is absent

- **WHEN** 未设置 `DOCS_DIST_DIR`，且 `docs-site/dist/index.html` 不存在，访客请求 `/docs`
- **THEN** 服务端不挂载文档站，沿用既有 Web SPA 回退

### Requirement: Documentation site navigation, icon, and error page

文档站 SHALL 在所有文档页提供返回平台首页的入口；站点 MUST 在 `/docs/favicon.svg` 提供图标，并由页面引用带 `/docs` 前缀的地址。未知文档路径 MUST 返回状态码 404 的 Starlight 错误页，页面 SHALL 提供返回文档首页与平台首页的链接。

#### Scenario: Return to the platform from a guide

- **WHEN** 访客在 `/docs/guides/openclaw/` 点击侧栏“返回平台”
- **THEN** 浏览器导航到 `/`，即平台首页

#### Scenario: Open a missing documentation path

- **WHEN** 访客请求 `/docs/guides/not-found/`
- **THEN** 服务端返回 404，响应体是 Starlight 的“页面未找到”页面，而不是 SPA 入口或纯文本错误

#### Scenario: Load the documentation favicon

- **WHEN** 浏览器请求 `/docs/favicon.svg`
- **THEN** 服务端返回 200 的 SVG 图标

### Requirement: Local development and declared toolchain

`docs-site/package.json` MUST 声明 Astro 7 所需的 Node 最低版本 `>=22.23.4`，README 与 Docker 构建 SHALL 使用兼容版本。`DOCS_DIST_DIR` 未设置且 `docs-site/dist` 存在时，本地服务 MUST 默认在 `/docs` 托管文档；显式空值 MUST 关闭托管。平台 Vite 开发服务器 SHALL 将 `/docs` 代理到后端，使热更新页面可以访问同一文档站。

#### Scenario: Run the server after building docs without extra configuration

- **WHEN** 维护者运行 `npm --prefix docs-site run build` 后，在未设置 `DOCS_DIST_DIR` 的情况下启动服务并访问 `/docs/`
- **THEN** 服务端返回文档首页，而不是 SPA 入口

#### Scenario: Access docs through the Vite dev server

- **WHEN** 后端已启动且 `npm --prefix web run dev` 正在运行，访客访问 Vite 端口的 `/docs/guides/openclaw/`
- **THEN** 请求被代理到后端，返回文档指南 HTML

#### Scenario: Disable docs hosting explicitly

- **WHEN** 维护者设置 `DOCS_DIST_DIR=` 并启动服务，访问 `/docs`
- **THEN** 服务端不挂载文档站，返回既有 SPA

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
