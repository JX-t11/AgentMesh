# Design

## Context

见 [proposal.md](proposal.md)。当前工作区已把文档内容从 `web/src/content/docs/` 迁到 `docs-site/content-guides/`，并移除了 React 文档工作区；剩余问题集中在构建耦合、旧 URL 兼容、服务端托管测试与仓库产物边界。平台已有单端口静态托管（`WEB_DIST_DIR` → SPA）和 Docker 多阶段构建，文档站应复用这套部署路径，不新增独立服务或反向代理。

## Goals / Non-Goals

**Goals:**

- 文档站构建与 Web 构建相互独立：任一项目都能在干净工作区单独构建。
- `/docs` 的所有公开行为可由 Rust 集成测试覆盖，包括静态资源、尾斜杠重定向、旧 URL 和 API 隔离。
- 旧文档地址永久可达，且不依赖浏览器端 SPA 路由。
- 生成物与源码的 Git 边界清晰，新克隆只包含可维护的源文件。

**Non-Goals:**

- 不引入 Node 服务、SSR、独立域名或 CDN；文档仍由 Rust 进程同源托管。
- 不迁移或重写六篇指南正文，不改变 `{{platform_url}}` 的数据源。
- 不在本次修复 README、`docs/web-ui.md` 的完整措辞、favicon、返回平台入口等体验项；这些列入后续任务。

## Decisions

### 1. 文档站作为独立 Astro 项目，产物以 `/docs` 为唯一前缀

`docs-site/` 使用 Astro + Starlight，`base: '/docs'`、`trailingSlash: 'always'`。页面输出到 `docs-site/dist/`，所有站内链接、静态资源与 Pagefind 索引天然带 `/docs` 前缀。选择独立项目而不是继续扩展 React 工作区，是为了获得静态生成、侧栏、搜索和 Markdown 生态；选择同源托管而不是独立子域，是为了复用现有部署、TLS 与访问控制边界。

### 2. 指南正文只有一个源：`content-guides`

`docs-site/content-guides/*.md` 保存带 frontmatter 的指南。`docs-site/scripts/prepare-content.mjs` 在 `dev`/`build` 前把 `{{platform_url}}` 替换为 `web/src/content/platform.json` 中的地址，写入被忽略的 `src/content/docs/guides/`。`src/content/docs/index.md` 是手写的文档首页，随源码入库。

`web/scripts/package-connectors.mjs` 直接读取 `content-guides/*.md`：先移除 frontmatter，再替换占位符，生成 `/connect/{framework}.md`。这样 Web 的 `predev`/`prebuild` 不再依赖文档站生成目录；Dockerfile 中为 Web 构建复制生成指南的步骤随之删除。相比“先跑 docs prepare 再跑 web build”，直接读源文件少一个构建顺序约束，也避免生成物被误当作输入。

### 3. 服务端按配置挂载，保留 `/docs` 前缀

`Config.docs_dist_dir: Option<PathBuf>` 来自 `DOCS_DIST_DIR`；为空时不注册文档路由，`/docs` 继续落入 SPA fallback。设置后使用 `Router::nest_service("/docs", ServeDir::new(dir))`。`nest_service` 会剥掉前缀，`ServeDir` 对无尾斜杠目录生成 `Location: /guides/.../`，因此用 `tower::util::MapResponse` 在响应阶段把不以 `/docs` 开头的绝对 `Location` 补回 `/docs`。替代方案是把文档挂到根路径再依赖反向代理，或关闭 `ServeDir` 的目录重定向；前者增加部署组件，后者会让 `trailingSlash: 'always'` 的链接失效。

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

`.gitignore` 忽略 `docs-site/.astro/`、`docs-site/dist/`、`docs-site/node_modules/` 和 `docs-site/src/content/docs/guides/`；`.dockerignore` 同样排除生成目录。`docs-site` 的配置、脚本、`content-guides/`、`src/content/docs/index.md` 与锁文件可入库。

## Risks / Trade-offs

- **`MapResponse` 依赖 `tower-http` 的响应体类型** → 已锁定 `tower-http 0.6`，并由集成测试覆盖重定向 Location；升级依赖时测试会暴露类型或行为变化。
- **显式旧路径路由与 `nest_service` 可能冲突** → 在 `build_router` 中先注册显式路由，再用集成测试验证 308 与指南页均可达；若 axum 拒绝重叠路由，改为在文档服务外层做路径映射。
- **文档站构建需要 Node 22.23.4+** → Docker 固定 `node:24`；本地验证使用容器内 Node 24，README 的版本声明在后续任务补齐。
- **旧地址只覆盖六篇已有指南** → 新指南不自动获得旧地址；这是有意的，旧地址映射是兼容层，不是路由别名系统。
- **未配置 `DOCS_DIST_DIR` 时 `/docs` 仍显示 SPA** → 保持既有回退语义，生产与 Compose 均显式配置；本地开发文档站仍通过 Astro dev server 或构建后配置目录访问。

## Migration Plan

1. 先提交文档站源码与忽略规则，确保干净克隆可构建。
2. 部署包含 `docs-builder` 的镜像并设置 `DOCS_DIST_DIR`；旧 `/docs/{slug}` 从 404 变为 308。
3. 回滚时可回退到上一镜像；单独取消 `DOCS_DIST_DIR` 会恢复 SPA 回退，但 React 文档工作区已移除，不能作为完整的文档回滚路径。
