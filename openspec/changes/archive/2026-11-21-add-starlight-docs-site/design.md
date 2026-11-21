# Design

## Context

见 [proposal.md](proposal.md)。当前工作区已把文档内容从 `web/src/content/docs/` 迁到 `docs-site/content-guides/`，并移除了 React 文档工作区；本次变更同时收口构建耦合、旧 URL 兼容、服务端托管测试、仓库产物边界与文档站本地开发/导航体验。平台已有单端口静态托管（`WEB_DIST_DIR` → SPA）和 Docker 多阶段构建，文档站应复用这套部署路径，不新增独立服务或反向代理。

## Goals / Non-Goals

**Goals:**

- 文档站构建与 Web 构建相互独立：任一项目都能在干净工作区单独构建。
- `/docs` 的所有公开行为可由 Rust 集成测试覆盖，包括静态资源、尾斜杠重定向、旧 URL、404 页面和 API 隔离。
- 旧文档地址永久可达，且不依赖浏览器端 SPA 路由。
- 生成物与源码的 Git 边界清晰，新克隆只包含可维护的源文件。
- 本地开发与生产行为一致：默认读取 `docs-site/dist`，Vite 将 `/docs` 代理到后端；站点提供返回平台、favicon 与 404 页面。

**Non-Goals:**

- 不引入 Node 服务、SSR、独立域名或 CDN；文档仍由 Rust 进程同源托管。
- 不迁移或重写六篇指南正文，不改变 `{{platform_url}}` 的数据源。
- 不在本次完成 `docs/web-ui.md`、`ROADMAP.md` 的完整措辞与锚点整理；这些仍在归档前处理。

## Decisions

### 1. 文档站作为独立 Astro 项目，产物以 `/docs` 为唯一前缀

`docs-site/` 使用 Astro + Starlight，`base: '/docs'`、`trailingSlash: 'always'`。页面输出到 `docs-site/dist/`，所有站内链接、静态资源与 Pagefind 索引天然带 `/docs` 前缀。选择独立项目而不是继续扩展 React 工作区，是为了获得静态生成、侧栏、搜索和 Markdown 生态；选择同源托管而不是独立子域，是为了复用现有部署、TLS 与访问控制边界。

### 2. 指南正文只有一个源：`content-guides`

`docs-site/content-guides/*.md` 保存带 frontmatter 的指南。`docs-site/scripts/prepare-content.mjs` 在 `dev`/`build` 前把 `{{platform_url}}` 替换为 `web/src/content/platform.json` 中的地址，写入被忽略的 `src/content/docs/guides/`。`src/content/docs/index.md` 是手写的文档首页，随源码入库。

`web/scripts/package-connectors.mjs` 直接读取 `content-guides/*.md`：先移除 frontmatter，再替换占位符，生成 `/connect/{framework}.md`。这样 Web 的 `predev`/`prebuild` 不再依赖文档站生成目录；Dockerfile 中为 Web 构建复制生成指南的步骤随之删除。相比“先跑 docs prepare 再跑 web build”，直接读源文件少一个构建顺序约束，也避免生成物被误当作输入。

### 3. 服务端按配置挂载，保留 `/docs` 前缀

`Config.docs_dist_dir: Option<PathBuf>` 默认 `docs-site/dist`，`DOCS_DIST_DIR` 显式为空时关闭。`build_router` 只在目录包含 `index.html` 时注册文档路由，缺失时记录 warning 并让 `/docs` 继续落入 SPA fallback。挂载后使用 `Router::nest_service("/docs", ServeDir::new(dir).not_found_service(ServeFile::new(dir.join("404.html"))))`：未命中的文档路径返回 Starlight 404 页面并保留 404 状态码。`nest_service` 会剥掉前缀，`ServeDir` 对无尾斜杠目录生成 `Location: /guides/.../`，因此用 `tower::util::MapResponse` 在响应阶段把不以 `/docs` 开头的绝对 `Location` 补回 `/docs`。替代方案是把文档挂到根路径再依赖反向代理，或关闭 `ServeDir` 的目录重定向；前者增加部署组件，后者会让 `trailingSlash: 'always'` 的链接失效。

### 4. 旧 URL 由服务端显式永久重定向

在挂载文档服务的同一分支内注册六条显式路由：

| 旧地址 | 新地址 |
| --- | --- |
| `/docs/quick-start` | `/docs/guides/quick-start/` |
| `/docs/create-agent` | `/docs/guides/create-agent/` |
| `/docs/openclaw` | `/docs/guides/openclaw/` |
| `/docs/hermes` | `/docs/guides/hermes/` |
| `/docs/collaboration` | `/docs/guides/collaboration/` |
| `/docs/faq` | `/docs/guides/faq/` |

使用 `Redirect::permanent` 返回 308（永久重定向），便于浏览器与 CDN 缓存。没有采用 Astro `redirects`：静态重定向页与 `base` 的组合需要额外验证输出路径，而服务端已经拥有 `/docs` 前缀和路由表，显式映射更直接、可用 Rust 测试覆盖。显式路由只覆盖六个旧 slug，不拦截 `/docs/guides/*`、`/docs/_astro/*` 或 `/docs/pagefind/*`。

### 5. Docker 与仓库边界

`docker/Dockerfile.server` 的 `web-builder` 只构建 Web；新增 `docs-builder` 从 `docs-site/package-lock.json` 安装依赖、复制 `web/src/content/platform.json` 后运行文档站构建；最终镜像把产物放到 `/app/docs/dist` 并设置 `DOCS_DIST_DIR`。`compose.yaml` 显式传入同一路径。

`.gitignore` 忽略 `docs-site/.astro/`、`docs-site/dist/`、`docs-site/node_modules/` 和 `docs-site/src/content/docs/guides/`；`.dockerignore` 同样排除生成目录。`docs-site` 的配置、脚本、`content-guides/`、`src/content/docs/index.md`、`src/content/docs/404.md`、`public/favicon.svg` 与锁文件可入库。

### 6. 本地开发默认挂载，Vite 代理 `/docs`

未设置 `DOCS_DIST_DIR` 时，服务端默认读取 `docs-site/dist`；开发者执行 `npm --prefix docs-site run build` 后直接 `cargo run` 即可访问 `/docs/`。显式设置空值关闭托管，用于只需要 SPA 的场景。`web/vite.config.ts` 将 `/docs` 代理到现有 `VITE_API_PROXY_TARGET`，使 `npm --prefix web run dev` 的热更新页面与单端口模式看到同一份文档。选择默认目录而不是要求每个开发者在 `.env` 中重复配置，是为了让干净克隆在构建文档后即可工作；保留空值开关是为了不破坏“无文档站”的 SPA 回退。

### 7. 站点导航、图标与 404 页面

Starlight 的内置 sidebar `link` 会自动加上 `/docs` base，无法直接指向平台根路径；因此用 `components.Sidebar` 覆盖，在默认侧栏上方渲染 `<a href="/">← 返回平台</a>`，样式与顶层侧栏项一致。`docs-site/public/favicon.svg` 提供与平台一致的图标，Starlight 会自动生成带 `/docs` 前缀的 `<link rel="shortcut icon">`。`src/content/docs/404.md` 提供中文 404 页面，服务端用 `not_found_service` 返回该页面并保留 404 状态码；相比直接让 `ServeDir` 返回纯文本 404，用户仍能回到文档首页或平台。

### 8. Node 版本在项目内声明

Astro 7 要求 Node `>=22.23.4`。`docs-site/package.json` 声明 `engines.node`，锁文件同步该元数据；Docker 的 docs-builder 固定 `node:24`，README 的环境要求写 Node 24 并注明最低版本。这样 `npm ci` 在低于要求的 Node 上会给出明确警告/失败，而不是到 `astro build` 才报错。

## Risks / Trade-offs

- **`MapResponse` 依赖 `tower-http` 的响应体类型** → 已锁定 `tower-http 0.6`，并由集成测试覆盖重定向 Location；升级依赖时测试会暴露类型或行为变化。
- **显式旧路径路由与 `nest_service` 可能冲突** → 在 `build_router` 中先注册显式路由，再用集成测试验证 308 与指南页均可达；若 axum 拒绝重叠路由，改为在文档服务外层做路径映射。
- **文档站构建需要 Node 22.23.4+** → Docker 固定 `node:24`；`docs-site/package.json` 声明 `engines.node`，README 写 Node 24/最低 22.23.4。
- **默认 `docs-site/dist` 可能不存在** → 只在 `index.html` 存在时挂载并记录 warning，`/docs` 回退 SPA；未构建文档的开发环境不会出现硬 404。
- **404 页面依赖构建产物** → 文档站构建生成 `404.html`；缺失时 `ServeFile` 返回空 404，不影响其他路径。
- **Vite `/docs` 代理只在开发服务器生效** → 生产仍由 Rust 托管，Rust 集成测试覆盖真实服务端行为。
- **旧地址只覆盖六篇已有指南** → 新指南不自动获得旧地址；这是有意的，旧地址映射是兼容层，不是路由别名系统。
- **未构建文档且未显式关闭时 `/docs` 仍显示 SPA** → 默认目录缺失时回退 SPA 并记录 warning；生产与 Compose 均显式配置。

## Migration Plan

1. 文档站源码、忽略规则与 OpenSpec 变更先行提交，确保干净克隆可构建。
2. 部署包含 `docs-builder` 的镜像并设置 `DOCS_DIST_DIR`；旧 `/docs/{slug}` 从 404 变为 308。
3. 本地验证：构建文档后不设置 `DOCS_DIST_DIR` 启动服务，确认 `/docs` 默认挂载；需要关闭时显式置空。
4. 回滚时可回退到上一镜像；单独取消 `DOCS_DIST_DIR` 会恢复 SPA 回退，但 React 文档工作区已移除，不能作为完整的文档回滚路径。
